/** Run inside the deployed API container. --real-qr explicitly creates/cancels a Bs 0.10 QR. */
import assert from 'node:assert/strict';
const base = process.env.SMOKE_URL || 'http://127.0.0.1:8787';
const key = (process.env.TILCAI_ENV === 'mainnet' ? process.env.TILCAI_API_KEYS_MAINNET : process.env.TILCAI_API_KEYS)?.split(',')[0]?.trim();
assert.ok(key, 'API key required');
const headers = {authorization: `Bearer ${key}`, 'content-type': 'application/json'};
async function call(path, init = {}) {
  const res = await fetch(base + path, {headers, ...init});
  assert.ok(res.ok, `${path}: HTTP ${res.status}`);
  return res.json();
}
await call('/health');
assert.equal((await fetch(base + '/v1/qr')).status, 401);
const providers = await call('/v1/qr/providers');
assert.equal(providers.mode, 'live');
assert.equal(providers.providers[0].id, 'baneco');
assert.equal(providers.providers[0].role, 'principal');
assert.equal(providers.providers[0].configured, true);
console.log('PASS health, authentication, live Baneco primary');
if (process.argv.includes('--real-qr')) {
  const reference = `smoke-${Date.now()}`;
  const body = JSON.stringify({amount: '0.10', description: 'Validacion despliegue TilcAI', reference});
  const qr = await call('/v1/qr', {method: 'POST', body});
  assert.equal(qr.provider, 'baneco');
  assert.equal(qr.status, 'PENDING');
  const png = Buffer.from(qr.qr_image.replace(/^data:image\/png;base64,/, ''), 'base64');
  assert.equal(png.subarray(0,8).toString('hex'), '89504e470d0a1a0a');
  assert.equal((await call('/v1/qr', {method:'POST',body})).id, qr.id);
  assert.equal((await call(`/v1/qr/${qr.id}`)).status, 'PENDING');
  assert.equal((await call(`/v1/qr/${qr.id}/cancel`, {method:'POST', body:'{}'})).status, 'CANCELLED');
  console.log('PASS real Baneco QR, PNG, idempotency, status and cancel');
}
