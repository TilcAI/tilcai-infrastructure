// Core's documented standalone manual-close facility advances ledger sequence;
// Payout is never deleted or rewritten. RPC is rebuilt from a fresh checkpoint.
import {execFileSync} from 'node:child_process';
import {fs,assert,sleep} from './common.mjs';
const name='tilcai-ttl-p26';
const docker=(...args)=>execFileSync('docker',['exec',name,...args],{encoding:'utf8'});
const core='http://127.0.0.1:18629';
const liveUntil=JSON.parse(fs.readFileSync('scratch/ttl/payout.json')).liveUntilLedgerSeq;
docker('supervisorctl','stop','stellar-rpc');
docker('supervisorctl','stop','stellar-core');
docker('sed','-i','/RUN_STANDALONE=/d','/opt/stellar/core/etc/stellar-core.cfg');
docker('sed','-i','1i RUN_STANDALONE=true','/opt/stellar/core/etc/stellar-core.cfg');
// Both settings must be top-level TOML entries.
docker('sed','-i','s/MANUAL_CLOSE=false/MANUAL_CLOSE=true/','/opt/stellar/core/etc/stellar-core.cfg');
docker('supervisorctl','start','stellar-core');
let advanced=false;
for(let i=0;i<100;i++){
 try{
  const text=await(await fetch(`${core}/manualclose?ledgerSeq=${liveUntil-1}&closeTime=${Math.floor(Date.now()/1000)+10}`)).text();
  if(text.includes(`sequence number ${liveUntil-1}`)){advanced=true;break;}
 }catch{}
 await sleep(30);
}
if(!advanced)throw new Error('Controlled jump failed; preserve container state and logs');
docker('supervisorctl','stop','stellar-core');
docker('sed','-i','s/RUN_STANDALONE=true/RUN_STANDALONE=false/','/opt/stellar/core/etc/stellar-core.cfg');
docker('supervisorctl','start','stellar-core');
async function info(){return(await(await fetch(`${core}/info`)).json()).info.ledger;}
async function closeOne(){
 const before=(await info()).num;
 await fetch(`${core}/manualclose`);
 for(let i=0;i<200;i++){if((await info()).num>before)return;await sleep(30);}
 throw new Error('Ledger close timed out');
}
const submissions=[];
for(const [index,label] of ['last-live','after-expiry'].entries()){
 const {hash,envelope}=JSON.parse(fs.readFileSync(`scratch/ttl/${label}.json`));
 const sent=await(await fetch(`${core}/tx?blob=${encodeURIComponent(envelope)}`)).json();
 assert.equal(sent.status,'PENDING');
 await closeOne();
 const ledger=(await info()).num;assert.equal(ledger,liveUntil+index);
 submissions.push({label,hash,ledger,submit:sent});
}
fs.writeFileSync('scratch/ttl/boundary-submissions.json',JSON.stringify(submissions,null,2));
// Publish a complete contiguous checkpoint after the jump, then start RPC afresh.
const checkpoint=(Math.floor((liveUntil+1)/8)+1)*8-1;
while((await info()).num<checkpoint+16){await closeOne();await sleep(700);}
docker('bash','-c','mkdir -p /opt/stellar/ttl-before-boundary; mv /opt/stellar/stellar-rpc/rpc_db.sqlite* /opt/stellar/ttl-before-boundary/; mv /opt/stellar/stellar-rpc/captive-core /opt/stellar/ttl-before-boundary/');
docker('supervisorctl','start','stellar-rpc');
// Auto-close only resumes after the expiry cases were fixed to exact ledgers.
docker('supervisorctl','stop','stellar-core');
docker('sed','-i','s/MANUAL_CLOSE=true/MANUAL_CLOSE=false/','/opt/stellar/core/etc/stellar-core.cfg');
docker('supervisorctl','start','stellar-core');
console.log('Boundary submitted; wait for RPC recovery before archive.mjs');
