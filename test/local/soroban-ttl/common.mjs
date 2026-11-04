import * as S from '@stellar/stellar-sdk';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const pass='Standalone Network ; February 2017';
const rpc = new S.rpc.Server('http://127.0.0.1:18004/rpc',{allowHttp:true});
const root=S.Keypair.fromRawEd25519Seed(S.hash(Buffer.from(pass)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function raw(method,params={}) {
 const d=await (await fetch('http://127.0.0.1:18004/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();
 if(d.error)throw new Error(JSON.stringify(d.error));return d.result;
}
async function sync() {
 const expected=(await (await fetch('http://127.0.0.1:18629/info')).json()).info.ledger.num;
 for(let i=0;i<400;i++){if((await raw('getLatestLedger')).sequence>=expected-1)return;await sleep(250);}
 throw new Error('RPC failed to sync to '+expected);
}
async function close(seq) {
 if(seq)throw new Error('use controlled jump helper');
 await sleep(1800);
 await sync();
}

async function tx(op,label) {
 await sync();
 let t=new S.TransactionBuilder(await rpc.getAccount(root.publicKey()),{fee:'10000000',networkPassphrase:pass}).addOperation(op).setTimeout(0).build();
 if(op.body.type !== 'createAccount') {
  const sim=await rpc.simulateTransaction(t);
  if(S.rpc.Api.isSimulationError(sim))throw new Error(label+': '+sim.error);
  t=S.rpc.assembleTransaction(t,sim).build();
 }
 t.sign(root);
 let posted=await (await fetch('http://127.0.0.1:18629/tx?blob='+encodeURIComponent(t.toXDR()))).json();
 for(let i=0;posted.status==='TRY_AGAIN_LATER' && i<20;i++){
  await close();
  posted=await (await fetch('http://127.0.0.1:18629/tx?blob='+encodeURIComponent(t.toXDR()))).json();
 }
 const sent={status:posted.status,hash:Buffer.from(t.hash()).toString('hex')};
 if(sent.status!=='PENDING')throw new Error(label+': '+JSON.stringify(posted));
 for(let i=0;i<30;i++){
  await close();
  const data=await (await fetch('http://127.0.0.1:18004/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getTransaction',params:{hash:sent.hash}})})).json();
  if(data.error)throw new Error(JSON.stringify(data.error));
  const got=data.result;
  if(got.returnValue)got.returnValue=S.xdr.ScVal.fromXDR(got.returnValue,'base64');
  if(got.status==='SUCCESS'){ console.log(label,got.ledger,sent.hash);return rpc.getTransaction(sent.hash); }
  if(got.status==='FAILED')throw new Error(label+': FAILED '+got.resultXdr);
  await sleep(1100);
 }
 throw new Error(label+' timeout');
}
const addr=s=>new S.Address(s).toScVal();
const i128=n=>S.nativeToScVal(BigInt(n),{type:'i128'});
const invoke=(id,method,args=[])=>new S.Contract(id).call(method,...args);

export { S,fs,assert,rpc,root,pass,sleep,raw,sync,close,tx,addr,i128,invoke };
