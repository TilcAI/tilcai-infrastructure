import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TransactionBuilder,xdr,scValToNative} from '@stellar/stellar-sdk';
const root=new URL('../../../docs/evidence/soroban-ttl-2026-11-02/',import.meta.url);
const read=name=>JSON.parse(readFileSync(new URL(name,root),'utf8'));
const manifest=read('manifest.json'),fixture=read('fixture.json'),archive=read('archive.json'),restart=read('restart.json');
const history=readFileSync(new URL('boundary-results.jsonl',root),'utf8').trim().split('\n').map(JSON.parse);
const all=[read('before-ttl.json'),...archive.transactions,restart.transaction];

test('recorded transactions have consistent hashes and XDR result states',()=>{
 for(const r of all){
  const tx=TransactionBuilder.fromXDR(r.envelopeXdr,manifest.networkPassphrase);
  assert.equal(Buffer.from(tx.hash()).toString('hex'),r.txHash);
  const result=xdr.TransactionResult.fromXDR(r.resultXdr,'base64');
  assert.equal(result.result.type,r.status==='SUCCESS'?'txSuccess':'txFailed');
 }
});
test('Core history records rejection on the exact last-live and first-expired ledgers',()=>{
 for(const [index,label] of ['last-live','after-expiry'].entries()){
  const envelope=read(label+'-envelope.json');
  const record=history.find(h=>h.ledger_seq===manifest.payoutLiveUntil+index);
  const result=record.tx_result_set.results.find(r=>r.transaction_hash===envelope.hash);
  assert.equal(result.result.result.tx_failed[0].op_inner.invoke_host_function,index===0?'trapped':'entry_archived');
  assert.equal(Buffer.from(TransactionBuilder.fromXDR(envelope.envelope,manifest.networkPassphrase).hash()).toString('hex'),envelope.hash);
 }
});
test('archived evidence preserves original recipient and amount through restore',()=>{
 assert.equal(read('initial-payout.json').liveUntilLedgerSeq,manifest.payoutLiveUntil);
 assert.equal(archive.archived.liveUntil,0);
 assert.equal(archive.archived.entryXdr,archive.restored.entryXdr);
 const value=scValToNative(xdr.LedgerEntryData.fromXDR(archive.restored.entryXdr,'base64').contractData.val);
 assert.equal(value.to,fixture.buyer);assert.equal(value.amount,10000000n);
 assert.ok(archive.restored.liveUntil>archive.restored.ledger);
 assert.match(archive.archived.simulationError,/Contract, #3/);
});
test('restored duplicate rejects; fresh IDs pay exactly once before and after node restart',()=>{
 assert.equal(archive.transactions.find(r=>r.label==='same ID after restore').status,'FAILED');
 const control=archive.transactions.find(r=>r.label==='new ID control');assert.equal(control.status,'SUCCESS');
 const call=TransactionBuilder.fromXDR(control.envelopeXdr,manifest.networkPassphrase).operations[0].func.invokeContract;
 assert.equal(call.functionName.toString(),'disburse');
 assert.equal(scValToNative(call.args[1]),fixture.buyer);assert.equal(scValToNative(call.args[2]),10000000n);
 assert.equal(BigInt(archive.balanceAfter)-BigInt(archive.balanceBefore),10000000n);
 assert.equal(restart.balanceBefore,archive.balanceAfter);
 assert.equal(BigInt(restart.balanceAfter)-BigInt(restart.balanceBefore),10000000n);
 assert.match(restart.duplicateSimulationError,/Contract, #3/);
 assert.equal(restart.transaction.status,'SUCCESS');
});
test('explicit renewal extends Payout beyond the restoration minimum',()=>{
 assert.ok(archive.renewed.liveUntil>archive.restored.liveUntil);
 assert.equal(archive.transactions.find(r=>r.label==='renew original payout').status,'SUCCESS');
});
