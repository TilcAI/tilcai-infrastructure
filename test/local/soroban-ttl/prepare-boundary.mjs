import {S,fs,rpc,root,pass,addr,i128,invoke,assert} from './common.mjs';
const {vault,token,buyer}=JSON.parse(fs.readFileSync('scratch/ttl/fixture.json'));
const original=S.TransactionBuilder.fromXDR(fs.readFileSync('scratch/ttl/original-envelope.txt','utf8'),pass);
const data=original.toEnvelope().value.tx.ext.sorobanData;
data.ext=S.xdr.SorobanTransactionDataExt.v0();
const account=await rpc.getAccount(root.publicKey());
const balanceSim=await rpc.simulateTransaction(new S.TransactionBuilder(account,{fee:'100000',networkPassphrase:pass}).addOperation(invoke(token,'balance',[addr(buyer)])).setTimeout(0).build());
const balance=S.scValToNative(balanceSim.result.retval).toString();
const sequence=BigInt((await rpc.getAccount(root.publicKey())).sequenceNumber());
for(const [index,label] of ['last-live','after-expiry'].entries()) {
 const source=new S.Account(root.publicKey(),(sequence+BigInt(index)).toString());
 const t=new S.TransactionBuilder(source,{fee:(data.resourceFee+1000000n).toString(),networkPassphrase:pass}).addOperation(invoke(vault,'disburse',[S.nativeToScVal(Buffer.alloc(32,1),{type:'bytes'}),addr(buyer),i128(10000000)])).setSorobanData(data).setTimeout(0).build();
 t.sign(root);
 fs.writeFileSync(`scratch/ttl/${label}.json`,JSON.stringify({hash:Buffer.from(t.hash()).toString('hex'),envelope:t.toXDR(),sequence:t.sequence}));
}
fs.writeFileSync('scratch/ttl/balance-before-boundary.json',JSON.stringify({balance,sequence:sequence.toString()}));
console.log('balance',balance,'sequence',sequence.toString());
