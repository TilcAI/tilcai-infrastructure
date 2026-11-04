import { S,fs,rpc,root,pass,addr,i128,invoke,raw,assert,sleep } from './common.mjs';
const {vault,buyer}=JSON.parse(fs.readFileSync('scratch/ttl/fixture.json'));
const original=S.TransactionBuilder.fromXDR(fs.readFileSync('scratch/ttl/original-envelope.txt','utf8'),pass);
const data=original.toEnvelope().value.tx.ext.sorobanData;
const id=S.nativeToScVal(Buffer.alloc(32,1),{type:'bytes'});
let t=new S.TransactionBuilder(await rpc.getAccount(root.publicKey()),{fee:(data.resourceFee+1000000n).toString(),networkPassphrase:pass}).addOperation(invoke(vault,'disburse',[id,addr(buyer),i128(10000000)])).setSorobanData(data).setTimeout(0).build();
t.sign(root);
const sent=await (await fetch('http://127.0.0.1:18629/tx?blob='+encodeURIComponent(t.toXDR()))).json();
console.log('duplicate before TTL',sent,'hash',Buffer.from(t.hash()).toString('hex'));
fs.writeFileSync('scratch/ttl/before-duplicate.json',JSON.stringify({hash:Buffer.from(t.hash()).toString('hex'),envelope:t.toXDR()}));

for(let i=0;i<90;i++){
 const r=await rpc.getTransaction(Buffer.from(t.hash()).toString('hex'));
 if(r.status==='SUCCESS')throw new Error('Duplicate unexpectedly paid');
 if(r.status==='FAILED'){
  fs.writeFileSync('scratch/ttl/before-result.json',JSON.stringify(await raw('getTransaction',{hash:Buffer.from(t.hash()).toString('hex')}),null,2));
  console.log('Duplicate rejected',r.ledger);break;
 }
 await sleep(1000);if(i===89)throw new Error('Duplicate receipt timeout');
}
