/**
 * End-to-end gasless payment against a running TilcAI, over HTTP, as a third party would do it:
 * the payer's key stays in this process (the wallet) and TilcAI only ever sees the signature.
 * It works against testnet and mainnet alike; the instance says which networks it serves.
 *
 *   E2E_API_URL=http://127.0.0.1:18787 E2E_API_KEY=… E2E_PAYER_PRIVATE_KEY=0x… \
 *     npm run e2e:gasless -- --amount 0.01 --to G…
 *
 *   E2E_API_URL             base URL of the TilcAI API (default http://127.0.0.1:8787)
 *   E2E_API_KEY             bearer key of that instance
 *   E2E_PAYER_PRIVATE_KEY   EVM key that holds the USDC (needs no AVAX: the relayer pays the gas)
 *
 * It MOVES FUNDS of the network the instance runs on. On mainnet that is real USDC.
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex, TypedDataDomain } from "viem";

const { values: a } = parseArgs({
  options: {
    amount: { type: "string" },
    to: { type: "string" },
    timeout: { type: "string", default: "900" },
  },
});
if (!a.amount || !a.to) throw new Error("--amount and --to are required");

const base = (process.env.E2E_API_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const apiKey = process.env.E2E_API_KEY ?? "";
const rawKey = process.env.E2E_PAYER_PRIVATE_KEY ?? "";
if (!rawKey) throw new Error("E2E_PAYER_PRIVATE_KEY is required");
const payer = privateKeyToAccount((rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex);

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as T;
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}
const same = (x: unknown, y: unknown) => String(x).toLowerCase() === String(y).toLowerCase();
const stamp = () => new Date().toISOString().slice(11, 19);

interface Route { source: { network: string; asset: string }; destination: { network: string }; transactionsEnabled: boolean }
const health = await call<{ env: string; transactionsEnabled: boolean; relayer: string }>("GET", "/health");
const { routes } = await call<{ routes: Route[] }>("GET", "/v1/routes");
const route = routes[0];
if (!route) throw new Error("the instance offers no route");
console.log(`instance ${base}: ${health.env}, relayer ${health.relayer}, ${route.source.network} → ${route.destination.network}`);
if (!health.transactionsEnabled) throw new Error("transactions are disabled on this instance (MAINNET_TRANSACTIONS_ENABLED)");

interface Quote { id: string; burn: { amountAtomic: string; amount: string }; destination: { amount: string }; preflight: Record<string, boolean> }
const { quote } = await call<{ quote: Quote }>("POST", "/v1/crosschain/quotes", { sourceNetwork: route.source.network, destinationNetwork: route.destination.network, amount: a.amount, payTo: a.to });
console.log(`quote ${quote.id}: burn ${quote.burn.amount} USDC → ${quote.destination.amount} USDC to ${a.to}; preflight ${JSON.stringify(quote.preflight)}`);

interface TypedData { domain: TypedDataDomain; types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; message: Record<string, unknown> }
interface Created { payment: { id: string; state: string }; authorization?: { router: string; typedData: TypedData } }
const created = await call<Created>("POST", "/v1/crosschain/payments", { quoteId: quote.id, mode: "gasless", payer: payer.address }, { "idempotency-key": randomUUID() });
const auth = created.authorization;
if (!auth) throw new Error("the instance returned no authorization to sign");
console.log(`payment ${created.payment.id} → ${created.payment.state}; payer ${payer.address}`);

// What a wallet checks before signing: the money leaves this account, on this chain's USDC,
// toward the router the instance named, for the quoted amount and nothing else.
const chainId = Number(route.source.network.split(":")[1]);
const { domain, message } = auth.typedData;
const checks: Array<[string, boolean]> = [
  ["primaryType is ReceiveWithAuthorization", auth.typedData.primaryType === "ReceiveWithAuthorization"],
  ["chainId is the source network's", Number(domain.chainId) === chainId],
  ["verifyingContract is the route's USDC", same(domain.verifyingContract, route.source.asset)],
  ["from is the payer", same(message.from, payer.address)],
  ["to is the router", same(message.to, auth.router)],
  ["value is the quoted burn", String(message.value) === quote.burn.amountAtomic],
];
for (const [name, ok] of checks) if (!ok) throw new Error(`refusing to sign: ${name} does not hold`);

const { EIP712Domain: _domainType, ...types } = auth.typedData.types;
const signature = await payer.signTypedData({ domain, types, primaryType: auth.typedData.primaryType, message } as Parameters<typeof payer.signTypedData>[0]);
await call("POST", `/v1/crosschain/payments/${created.payment.id}/authorization`, { signature });

interface View { payment: { state: string; uncertain?: boolean; lastError?: string | null }; links?: unknown; amounts?: unknown; receipt?: unknown }
const deadline = Date.now() + Number(a.timeout) * 1000;
let last = "";
let view: View;
for (;;) {
  view = await call<View>("GET", `/v1/crosschain/payments/${created.payment.id}`);
  const tag = `${view.payment.state}${view.payment.uncertain ? " (uncertain)" : ""}${view.payment.lastError ? ` · ${view.payment.lastError}` : ""}`;
  if (tag !== last) console.log(`[${stamp()}] ${tag}`);
  last = tag;
  if (view.payment.state === "SETTLED" || view.payment.state === "FAILED") break;
  if (Date.now() > deadline) {
    console.log("timeout: the instance keeps reconciling this payment");
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(JSON.stringify({ state: view.payment.state, links: view.links, amounts: view.amounts, receipt: view.receipt }, null, 2));
process.exitCode = view.payment.state === "SETTLED" ? 0 : 1;
