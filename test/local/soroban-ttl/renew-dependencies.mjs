import { S,fs,rpc,root,pass,tx,addr,i128,invoke,raw,assert,sync,sleep } from './common.mjs';
const {vault,token,buyer}=JSON.parse(fs.readFileSync('scratch/ttl/fixture.json'));
const id=S.nativeToScVal(Buffer.alloc(32,1),{type:'bytes'});
const key=S.xdr.ScVal.scvVec([S.xdr.ScVal.scvSymbol('Payout'),id]);
const payout=await rpc.getContractData(vault,key);
const original=S.TransactionBuilder.fromXDR(fs.readFileSync('scratch/ttl/original-envelope.txt','utf8'),pass);
const data=original.toEnvelope().value.tx.ext.sorobanData;
const fp=data.resources.footprint;
const payoutKey=payout.key.toXDR('base64');
const dependencies=[...fp.readOnly,...fp.readWrite].filter(k=>['contractCode','contractData'].includes(k.type)&&k.toXDR('base64')!==payoutKey);
console.log('dependencies',dependencies.length);
// Leave enough live dependency headroom for checkpoint recovery after Payout expires.
while((await raw('getLatestLedger')).sequence < payout.lastModifiedLedgerSeq + 128) await sleep(1000);
for(const [label,op,side] of [['restore dependencies',S.Operation.restoreFootprint(),'rw'],['extend dependencies',S.Operation.extendFootprintTtl({extendTo:1054079}),'ro']]) {
 await sync();
 const sb=new S.SorobanDataBuilder().setFootprint(side==='ro'?dependencies:[],side==='rw'?dependencies:[]);
 let t=new S.TransactionBuilder(await rpc.getAccount(root.publicKey()),{fee:'10000000',networkPassphrase:pass}).addOperation(op).setSorobanData(sb.build()).setTimeout(0).build();
 const sim=await rpc.simulateTransaction(t);
 console.log(label,'simulation',sim.error??'OK');
 if(S.rpc.Api.isSimulationError(sim))throw new Error(sim.error);
 t=S.rpc.assembleTransaction(t,sim).build();t.sign(root);
 const sent=await rpc.sendTransaction(t);
 console.log(label,sent.status,sent.hash);
 if(!['PENDING','DUPLICATE'].includes(sent.status))throw new Error(JSON.stringify(sent));
 for(let i=0;i<60;i++){
  const got=await rpc.getTransaction(sent.hash);
  if(got.status==='SUCCESS'){console.log(label,'SUCCESS',got.ledger);break;}
  if(got.status==='FAILED')throw new Error('failed '+label);
  await new Promise(r=>setTimeout(r,1000));
  if(i===59)throw new Error('timeout '+label);
 }
}
const after=await rpc.getContractData(vault,key);
assert.equal(after.liveUntilLedgerSeq,payout.liveUntilLedgerSeq);
fs.writeFileSync('scratch/ttl/dependencies.json',JSON.stringify({payoutKey,payoutLiveUntil:payout.liveUntilLedgerSeq,dependencies:dependencies.map(k=>k.toXDR('base64'))},null,2));
console.log('payout TTL unchanged',after.liveUntilLedgerSeq,'current',(await raw('getLatestLedger')).sequence);
