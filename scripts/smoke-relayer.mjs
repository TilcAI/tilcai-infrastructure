// Read-only verification. Run inside the TilcAI API container (its environment supplies the key).
import assert from 'node:assert/strict';
const base = process.env.RELAYER_URL || 'http://relayer:8080';
const headers = { authorization: `Bearer ${process.env.RELAYER_API_KEY}` };
async function get(path, authenticated = true) {
  const r = await fetch(base + path, { headers: authenticated ? headers : {}, signal: AbortSignal.timeout(20000) });
  assert.equal(r.status, 200, `${path}: HTTP ${r.status}`);
  return r;
}
const ready = await (await get('/api/v1/ready', false)).json();
assert.equal(ready.ready, true);
const unauthorized = await fetch(base + '/api/v1/relayers', { signal: AbortSignal.timeout(10000) });
assert.equal(unauthorized.status, 401);
const list = await (await get('/api/v1/relayers')).json();
assert.equal(list.success, true);
const expected = new Map([
  ['avalanche-fuji-relayer', 'avalanche-fuji-testnet'],
  ['monad-testnet-relayer', 'monad-testnet'],
  ['stellar-example', 'testnet'],
]);
const results = [];
for (const [id, network] of expected) {
  const relayer = list.data.find(r => r.id === id);
  assert.ok(relayer, `${id} missing`);
  assert.equal(relayer.network, network);
  assert.equal(relayer.paused, false);
  const status = (await (await get(`/api/v1/relayers/${id}/status`)).json()).data;
  assert.equal(status.system_disabled, false, `${id} disabled`);
  assert.equal(status.paused, false);
  results.push({ id, network, address: relayer.address, balanceAtomic: status.balance, pending: status.pending_transactions_count });
}
const supported = await (await get('/api/v1/plugins/x402/supported')).json();
assert.ok(JSON.stringify(supported).includes('eip155:10143'), 'x402 must advertise Monad testnet');
console.log(JSON.stringify({ ready: true, relayers: results, monadX402: true }, null, 2));
