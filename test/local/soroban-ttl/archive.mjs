import {S,fs,rpc,root,pass,addr,i128,invoke,raw,assert,sleep,tx} from './common.mjs';
const {vault,token,buyer}=JSON.parse(fs.readFileSync('scratch/ttl/fixture.json'));
const config=JSON.parse(fs.readFileSync('scratch/ttl/dependencies.json'));
const payoutKey=S.xdr.LedgerKey.fromXDR(config.payoutKey,'base64');
const archived=await rpc.getLedgerEntries(payoutKey);
console.log('archived ledger',archived.latestLedger,'ttl',archived.entries[0]?.liveUntilLedgerSeq);
assert.equal(archived.entries[0].liveUntilLedgerSeq,0);
const native=S.scValToNative(archived.entries[0].val.contractData.val);
assert.equal(native.to,buyer);assert.equal(native.amount,10000000n);
const evidence={archived:{ledger:archived.latestLedger,liveUntil:0,amount:native.amount.toString(),to:native.to,entryXdr:archived.entries[0].val.toXDR('base64')},transactions:[]};
async function simulate(method,args){return rpc.simulateTransaction(new S.TransactionBuilder(await rpc.getAccount(root.publicKey()),{fee:'10000000',networkPassphrase:pass}).addOperation(invoke(method==='balance'?token:vault,method,args)).setTimeout(0).build());}
async function balance(){const s=await simulate('balance',[addr(buyer)]);if(s.error)throw new Error(s.error);return S.scValToNative(s.result.retval);}
const before=await balance();assert.equal(before.toString(),JSON.parse(fs.readFileSync('scratch/ttl/balance-before-boundary.json')).balance);
const args=[S.nativeToScVal(Buffer.alloc(32,1),{type:'bytes'}),addr(buyer),i128(10000000)];
const archivedSim=await simulate('disburse',args);assert.match(archivedSim.error,/Contract, #3/);
evidence.archived.simulationError=archivedSim.error;
async function send(t,label,expected='SUCCESS'){
 t.sign(root);const sent=await rpc.sendTransaction(t);assert.equal(sent.status,'PENDING');
 for(let i=0;i<120;i++){
  const r=await rpc.getTransaction(sent.hash);
  if(['SUCCESS','FAILED'].includes(r.status)){
   console.log(label,r.status,r.ledger,sent.hash);assert.equal(r.status,expected);
   evidence.transactions.push({label,...await raw('getTransaction',{hash:sent.hash})});return r;
  }
  await sleep(1000);
 }
 throw new Error('timeout '+label);
}
const data=new S.SorobanDataBuilder().setFootprint([],[payoutKey]).build();
let restore=new S.TransactionBuilder(await rpc.getAccount(root.publicKey()),{fee:'10000000',networkPassphrase:pass}).addOperation(S.Operation.restoreFootprint()).setSorobanData(data).setTimeout(0).build();
const restoreSim=await rpc.simulateTransaction(restore);if(restoreSim.error)throw new Error(restoreSim.error);
restore=S.rpc.assembleTransaction(restore,restoreSim).build();await send(restore,'explicit restore');
const restored=await rpc.getLedgerEntries(payoutKey);assert.ok(restored.entries[0].liveUntilLedgerSeq>restored.latestLedger);
assert.deepEqual(S.scValToNative(restored.entries[0].val.contractData.val),native);
evidence.restored={ledger:restored.latestLedger,liveUntil:restored.entries[0].liveUntilLedgerSeq,entryXdr:restored.entries[0].val.toXDR('base64')};
assert.equal(await balance(),before);
// New RPC client: no cached payout state is carried across clients.
const fresh=new S.rpc.Server('http://127.0.0.1:18004/rpc',{allowHttp:true});
const duplicate=new S.TransactionBuilder(await fresh.getAccount(root.publicKey()),{fee:'10000000',networkPassphrase:pass}).addOperation(invoke(vault,'disburse',args)).setTimeout(0).build();
const sim=await fresh.simulateTransaction(duplicate);assert.match(sim.error,/Contract, #3/);
const original=S.TransactionBuilder.fromXDR(fs.readFileSync('scratch/ttl/original-envelope.txt','utf8'),pass);
const originalData=original.toEnvelope().value.tx.ext.sorobanData;originalData.ext=S.xdr.SorobanTransactionDataExt.v0();
let repeated=new S.TransactionBuilder(await fresh.getAccount(root.publicKey()),{fee:(originalData.resourceFee+1000000n).toString(),networkPassphrase:pass}).addOperation(invoke(vault,'disburse',args)).setSorobanData(originalData).setTimeout(0).build();
await send(repeated,'same ID after restore','FAILED');assert.equal(await balance(),before);
const newOp=invoke(vault,'disburse',[S.nativeToScVal(Buffer.alloc(32,2),{type:'bytes'}),addr(buyer),i128(10000000)]);
let control=new S.TransactionBuilder(await rpc.getAccount(root.publicKey()),{fee:'10000000',networkPassphrase:pass}).addOperation(newOp).setTimeout(0).build();
const cs=await rpc.simulateTransaction(control);if(cs.error)throw new Error(cs.error);control=S.rpc.assembleTransaction(control,cs).build();await send(control,'new ID control');
assert.equal(await balance(),before+10000000n);
let extend=new S.TransactionBuilder(await rpc.getAccount(root.publicKey()),{fee:'10000000',networkPassphrase:pass}).addOperation(S.Operation.extendFootprintTtl({extendTo:1054079})).setSorobanData(new S.SorobanDataBuilder().setFootprint([payoutKey],[]).build()).setTimeout(0).build();
const es=await rpc.simulateTransaction(extend);if(es.error)throw new Error(es.error);extend=S.rpc.assembleTransaction(extend,es).build();await send(extend,'renew original payout');
const renewed=await rpc.getLedgerEntries(payoutKey);assert.ok(renewed.entries[0].liveUntilLedgerSeq>restored.entries[0].liveUntilLedgerSeq);
evidence.renewed={ledger:renewed.latestLedger,liveUntil:renewed.entries[0].liveUntilLedgerSeq};
evidence.balanceBefore=before.toString();evidence.balanceAfter=(await balance()).toString();
fs.writeFileSync('scratch/ttl/archive-evidence.json',JSON.stringify(evidence,null,2));
console.log('ALL ARCHIVE ASSERTIONS PASSED',evidence.balanceBefore,evidence.balanceAfter);
