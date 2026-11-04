import {S,fs,rpc,root,pass,addr,i128,invoke,raw,assert,sleep} from './common.mjs';
const {vault,token,buyer}=JSON.parse(fs.readFileSync('scratch/ttl/fixture.json'));
for(let i=0;i<90;i++){
 try{await rpc.getAccount(root.publicKey());break;}catch{if(i===89)throw new Error('RPC did not recover');await sleep(1000);}
}
async function sim(method,args){return rpc.simulateTransaction(new S.TransactionBuilder(await rpc.getAccount(root.publicKey()),{fee:'10000000',networkPassphrase:pass}).addOperation(invoke(method==='balance'?token:vault,method,args)).setTimeout(0).build());}
const duplicate=await sim('disburse',[S.nativeToScVal(Buffer.alloc(32,1),{type:'bytes'}),addr(buyer),i128(10000000)]);
assert.match(duplicate.error,/Contract, #3/);
const before=S.scValToNative((await sim('balance',[addr(buyer)])).result.retval);
assert.equal(before,1020000000n);
let control=new S.TransactionBuilder(await rpc.getAccount(root.publicKey()),{fee:'10000000',networkPassphrase:pass}).addOperation(invoke(vault,'disburse',[S.nativeToScVal(Buffer.alloc(32,3),{type:'bytes'}),addr(buyer),i128(10000000)])).setTimeout(0).build();
const simulated=await rpc.simulateTransaction(control);if(simulated.error)throw new Error(simulated.error);
control=S.rpc.assembleTransaction(control,simulated).build();control.sign(root);
const sent=await rpc.sendTransaction(control);assert.equal(sent.status,'PENDING');
for(let i=0;i<120;i++){
 const r=await rpc.getTransaction(sent.hash);
 if(r.status==='FAILED')throw new Error('new ID after restart failed');
 if(r.status==='SUCCESS'){
  const after=S.scValToNative((await sim('balance',[addr(buyer)])).result.retval);
  assert.equal(after,before+10000000n);
  const data={duplicateSimulationError:duplicate.error,ledger:r.ledger,balanceBefore:before.toString(),balanceAfter:after.toString(),transaction:await raw('getTransaction',{hash:sent.hash})};
  fs.writeFileSync('scratch/ttl/restart-evidence.json',JSON.stringify(data,null,2));
  console.log('RESTART ASSERTIONS PASSED',r.ledger,sent.hash,'balance',after.toString());break;
 }
 await sleep(1000);if(i===119)throw new Error('timeout');
}
