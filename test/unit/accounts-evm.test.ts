import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { decodeFunctionData, hashTypedData, keccak256, stringToHex } from "viem";
import { createAppContext } from "../../src/app-context.ts";
import { buildServer } from "../../src/apps/api/server.ts";
import { loadEnv } from "../../src/config/env.ts";
import { openDatabase } from "../../src/db/sqlite.ts";
import {
  challengeBase64Url,
  encodeWebAuthnSignature,
  p256Point,
  p256Signature,
  PasskeyFormatError,
  typedDataChallenge,
  wrapTypedDataSignature,
} from "../../src/modules/accounts/evm/passkey.ts";
import type { AccountDeployer } from "../../src/modules/accounts/evm/provider.ts";
import type { OwnerCredential } from "../../src/modules/accounts/ports.ts";
import { SqliteSmartAccountRepository } from "../../src/modules/accounts/repository.ts";
import { AccountService, accountSalt } from "../../src/modules/accounts/service.ts";
import { SubmissionRejected, type EvmSubmissionStatus } from "../../src/modules/crosschain/ports.ts";
import { authorizationNonce, paymentIdBytes32, RECEIVE_AUTHORIZATION_TYPE, routeOf, ROUTER_V2_ABI } from "../../src/modules/crosschain/router.ts";
import type { NewMonitorEvent } from "../../src/modules/monitor/domain.ts";
import { LEGACY_TENANT_ID, type TenantId } from "../../src/modules/tenants/ports.ts";
import { SqliteTenantRegistry } from "../../src/modules/tenants/registry.ts";
import { DomainError } from "../../src/shared/errors.ts";
import type { Hex } from "../../src/shared/hex.ts";
import { silentLogger } from "../../src/shared/log.ts";
import { harness, MERCHANT, ROUTER_V2 } from "../support/fakes.ts";
import { TestClock } from "../support/sca.ts";

async function rejects(p: Promise<unknown>, code: string, status?: number) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.contract.code === code && (status === undefined || e.httpStatus === status));
}

/** A passkey as an authenticator holds it: a P-256 key that signs WebAuthn assertions. */
function passkey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = `0x04${Buffer.from(jwk.x!, "base64url").toString("hex")}${Buffer.from(jwk.y!, "base64url").toString("hex")}` as Hex;
  const owner: OwnerCredential = { kind: "webauthn-p256", publicKey: point, credentialId: "cred-1", rpId: "optipagos.optus.lat" };
  const assert_ = (challenge: Hex) => {
    const authenticatorData = Buffer.concat([createHash("sha256").update("optipagos.optus.lat").digest(), Buffer.from([0x05, 0, 0, 0, 7])]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: challengeBase64Url(challenge), origin: "https://optipagos.optus.lat", crossOrigin: false }));
    const signature = createSign("sha256").update(Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()])).sign(privateKey);
    return { authenticatorData, clientDataJSON, signature };
  };
  return { owner, point, assert: assert_ };
}

// ── What the passkey signs: the same bytes as the contract (vectors from contracts/evm/test/SmartAccountHelpers.sol) ──

const VECTOR = {
  account: "0x1111111111111111111111111111111111111111" as Hex,
  contents: { appDomainSeparator: keccak256(stringToHex("sep")), contentsType: RECEIVE_AUTHORIZATION_TYPE, contentsHash: keccak256(stringToHex("contents")) },
  challenge: "0x2f176d1ca1e4aa8dda99fe607a2796fd4048f47cad65d0afdba05db13e0419da" as Hex,
  r: "0b11b4e3248bcd675633e18ee58aeaba88465a62e2afc1ee8b6b3a23942ae045",
  s: "46735a4099ff848a5fb3aae5c496cb3dfd8d74a83384473d93f3d0f1a3f7bdfe",
  authenticatorData: "c0f690e6fb8f805d8f6b8d72d666f8f03e396174557c57da146ebd8a1d066a320500000007",
  clientDataJSON: '{"type":"webauthn.get","challenge":"LxdtHKHkqo3amf5geieW_UBI9HytZdCv26BdsT4EGdo","origin":"https://optipagos.optus.lat","crossOrigin":false}',
  encoded:
    "0x0b11b4e3248bcd675633e18ee58aeaba88465a62e2afc1ee8b6b3a23942ae04546735a4099ff848a5fb3aae5c496cb3dfd8d74a83384473d93f3d0f1a3f7bdfe0000000000000000000000000000000000000000000000000000000000000017000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000025c0f690e6fb8f805d8f6b8d72d666f8f03e396174557c57da146ebd8a1d066a320500000007000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008c7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a224c786474484b486b716f33616d663567656965575f554249394879745a644376323642647354344547646f222c226f726967696e223a2268747470733a2f2f6f7074697061676f732e6f707475732e6c6174222c2263726f73734f726967696e223a66616c73657d0000000000000000000000000000000000000000",
};

test("passkey: the challenge and the encoded assertion are byte-for-byte what the contract computes", () => {
  assert.equal(typedDataChallenge(VECTOR.account, 43113, VECTOR.contents), VECTOR.challenge);
  assert.equal(challengeBase64Url(VECTOR.challenge), "LxdtHKHkqo3amf5geieW_UBI9HytZdCv26BdsT4EGdo");
  const encoded = encodeWebAuthnSignature({
    authenticatorData: Buffer.from(VECTOR.authenticatorData, "hex"),
    clientDataJSON: Buffer.from(VECTOR.clientDataJSON),
    signature: Buffer.from(VECTOR.r + VECTOR.s, "hex"),
  });
  assert.equal(encoded, VECTOR.encoded);
  // Another account or another chain is another challenge: a signature cannot travel.
  assert.notEqual(typedDataChallenge("0x2222222222222222222222222222222222222222", 43113, VECTOR.contents), VECTOR.challenge);
  assert.notEqual(typedDataChallenge(VECTOR.account, 43114, VECTOR.contents), VECTOR.challenge);

  const wrapped = wrapTypedDataSignature(encoded, VECTOR.contents);
  const tail = Buffer.from(wrapped.slice(encoded.length), "hex");
  assert.equal(tail.length, 32 + 32 + RECEIVE_AUTHORIZATION_TYPE.length + 2);
  assert.equal(tail.subarray(64, -2).toString(), RECEIVE_AUTHORIZATION_TYPE);
  assert.equal(tail.readUInt16BE(tail.length - 2), RECEIVE_AUTHORIZATION_TYPE.length);
});

test("passkey: DER signatures are read, the high root is folded down, and malformed input is refused", () => {
  const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const k = passkey();
  for (let i = 0; i < 20; i++) {
    const { signature } = k.assert(keccak256(stringToHex(`m${i}`)));
    const { r, s } = p256Signature(signature);
    assert.match(r, /^0x[0-9a-f]{64}$/);
    assert.ok(BigInt(s) <= N / 2n, "low s");
  }
  const high = Buffer.from(VECTOR.r + (N - BigInt(`0x${VECTOR.s}`)).toString(16).padStart(64, "0"), "hex");
  assert.equal(p256Signature(high).s, `0x${VECTOR.s}`);
  assert.throws(() => p256Signature(Buffer.alloc(64)), PasskeyFormatError);
  assert.throws(() => p256Signature(Buffer.from("3006020101020101ff", "hex")), PasskeyFormatError);
  assert.throws(() => p256Signature(Buffer.from("not a signature")), PasskeyFormatError);
  assert.throws(() => encodeWebAuthnSignature({ authenticatorData: Buffer.alloc(37), clientDataJSON: Buffer.from("{}"), signature: high }), PasskeyFormatError);

  assert.deepEqual(p256Point(k.point), { qx: `0x${k.point.slice(4, 68)}`, qy: `0x${k.point.slice(68)}` });
  assert.throws(() => p256Point(`0x04${"11".repeat(64)}`), PasskeyFormatError, "not on the curve");
  assert.throws(() => p256Point(`0x02${"11".repeat(32)}`), PasskeyFormatError, "compressed");
});

// ── Issuing accounts ────────────────────────────────────────────────────────────────────────────────

class FakeDeployer implements AccountDeployer {
  readonly network = "eip155:43113" as const;
  code = new Set<string>();
  deploys: Array<{ owner: OwnerCredential; salt: Hex }> = [];
  statuses = new Map<string, EvmSubmissionStatus>();
  failNext: false | "rejected" | "timeout" = false;
  /** A submission lands on "chain" at once unless told otherwise. */
  autoConfirm = true;
  async codeRef() {
    return "0x00000000000000000000000000000000000c0de1";
  }
  async addressFor(owner: OwnerCredential, salt: Hex) {
    if (owner.kind !== "webauthn-p256") throw new TypeError("EVM accounts are owned by a passkey (webauthn-p256)");
    p256Point(owner.publicKey);
    return `0x${keccak256(`${owner.publicKey}${salt.slice(2)}` as Hex).slice(-40)}`;
  }
  async deploy(owner: OwnerCredential, salt: Hex) {
    if (this.failNext) {
      const kind = this.failNext;
      this.failNext = false;
      throw kind === "rejected" ? new SubmissionRejected("relayer 400: insufficient funds") : new Error("relayer timeout");
    }
    this.deploys.push({ owner, salt });
    const submissionId = `deploy-${this.deploys.length}`;
    const address = await this.addressFor(owner, salt);
    if (this.autoConfirm) {
      this.code.add(address);
      this.statuses.set(submissionId, { state: "confirmed", txHash: `0x${"d".repeat(63)}${this.deploys.length}` });
    } else this.statuses.set(submissionId, { state: "pending" });
    return { address, submissionId };
  }
  async deployStatus(id: string) {
    return this.statuses.get(id) ?? { state: "pending" as const };
  }
  async isDeployed(address: string) {
    return this.code.has(address);
  }
  async prepareDelegation(): Promise<never> {
    throw new Error("not in this phase");
  }
  async prepareRevocation(): Promise<never> {
    throw new Error("not in this phase");
  }
  async submitOwnerSigned(): Promise<never> {
    throw new Error("not in this phase");
  }
}

async function issuing(quota?: { accountsPerDay: number }) {
  const clock = new TestClock();
  const db = openDatabase(":memory:");
  const tenants = new SqliteTenantRegistry(db, clock);
  const repo = new SqliteSmartAccountRepository(db, clock);
  const deployer = new FakeDeployer();
  const events: NewMonitorEvent[] = [];
  const svc = new AccountService({ repo, providers: { "eip155:43113": deployer }, clock, log: silentLogger, events: { emit: (e) => void events.push(e) }, options: { pollMs: 1000 } });
  const optus = await tenants.createTenant({ name: "Optus", ...(quota ? { quota } : {}) });
  const other = await tenants.createTenant({ name: "Other" });
  const create = (over: Partial<Parameters<AccountService["create"]>[0]> = {}) =>
    svc.create({ tenantId: optus.id, network: "eip155:43113", externalRef: "user-1", owner: KEY.owner, idempotencyKey: "idem-0001", ...over });
  /** Runs the worker until the account stops being due (bounded). */
  const drive = async (id: string, rounds = 12) => {
    for (let i = 0; i < rounds; i++) {
      const a = (await repo.get(id as never))!;
      if (a.state !== "DEPLOYING") return a;
      clock.advance(Math.max(0, Date.parse(a.nextCheckAt) - clock.t) + 1);
      await svc.processDue();
    }
    return (await repo.get(id as never))!;
  };
  return { clock, db, tenants, repo, deployer, events, svc, optus, other, create, drive };
}
const KEY = passkey();

test("account: the address is final at once, the relayer deploys, and the account becomes ACTIVE with its history", async () => {
  const t = await issuing();
  const { account, replayed } = await t.create();
  assert.equal(replayed, false);
  assert.match(account.address, /^0x[0-9a-f]{40}$/);
  assert.equal(account.address, await t.deployer.addressFor(KEY.owner, accountSalt(t.optus.id, "user-1")));
  assert.equal(account.state, "DEPLOYING", "ACTIVE only with code on-chain as evidence");
  assert.equal(account.deploySubmissionId, "deploy-1");
  assert.deepEqual(t.deployer.deploys, [{ owner: { ...KEY.owner, publicKey: KEY.point.toLowerCase() }, salt: accountSalt(t.optus.id, "user-1") }]);

  const active = await t.drive(account.id);
  assert.equal(active.state, "ACTIVE");
  assert.match(active.deployTxHash!, /^0xd+1$/);
  assert.deepEqual((await t.svc.view(t.optus.id, account.id)).events.map((e) => [e.from, e.to]), [[null, "DEPLOYING"], ["DEPLOYING", "ACTIVE"]]);
  assert.deepEqual(t.events.map((e) => [e.type, e.data!.from, e.data!.to]), [["account.transition", null, "DEPLOYING"], ["account.transition", "DEPLOYING", "ACTIVE"]]);
  assert.equal(t.deployer.deploys.length, 1, "nothing is deployed twice");
  assert.equal((await t.svc.activeByAddress(t.optus.id, "eip155:43113", account.address.toUpperCase().replace("0X", "0x")))?.id, account.id);
});

test("account: asking again returns the same account; another owner for the same holder is refused", async () => {
  const t = await issuing();
  const first = await t.create();
  const sameKey = await t.create();
  assert.deepEqual([sameKey.replayed, sameKey.account.id], [true, first.account.id]);
  const sameHolder = await t.create({ idempotencyKey: "idem-0002" });
  assert.deepEqual([sameHolder.replayed, sameHolder.account.id], [true, first.account.id], "one account per holder and network");
  assert.equal(t.deployer.deploys.length, 1);
  assert.equal((await t.tenants.usage(t.optus.id)).accounts, 1, "a replay does not count against the quota");

  const stranger = passkey();
  await rejects(t.create({ owner: stranger.owner }), "IDEMPOTENCY_CONFLICT");
  await rejects(t.create({ owner: stranger.owner, idempotencyKey: "idem-0003" }), "DUPLICATE");
  await rejects(t.create({ externalRef: "user-2" }), "IDEMPOTENCY_CONFLICT");

  // The same passkey for another holder, or for another tenant, is a different account.
  const second = await t.create({ externalRef: "user-2", idempotencyKey: "idem-0004" });
  const elsewhere = await t.create({ tenantId: t.other.id, idempotencyKey: "idem-0001" });
  assert.equal(new Set([first.account.address, second.account.address, elsewhere.account.address]).size, 3);
});

test("account: a tenant only sees its own accounts", async () => {
  const t = await issuing();
  const { account } = await t.create();
  await t.drive(account.id);
  await rejects(t.svc.get(t.other.id, account.id), "NOT_FOUND");
  assert.deepEqual(await t.svc.list(t.other.id, {}), []);
  assert.equal((await t.svc.list(t.optus.id, { externalRef: "user-1" })).length, 1);
  assert.equal(await t.svc.activeByAddress(t.other.id, "eip155:43113", account.address), undefined, "another tenant cannot pay with it");
});

test("account: bad requests, unknown networks and an exhausted quota store nothing", async () => {
  const t = await issuing({ accountsPerDay: 1 });
  await rejects(t.create({ network: "eip155:43114" }), "NETWORK_OR_ASSET");
  await rejects(t.create({ owner: { ...KEY.owner, publicKey: `0x04${"11".repeat(64)}` } as OwnerCredential }), "INVALID_INPUT");
  await rejects(t.create({ owner: { kind: "secp256k1", address: `0x${"ab".repeat(20)}` } }), "INVALID_INPUT");
  await rejects(t.create({ externalRef: "con espacios" }), "INVALID_INPUT");
  await rejects(t.create({ idempotencyKey: "short" }), "INVALID_INPUT");
  assert.deepEqual(await t.svc.list(t.optus.id, {}), []);

  await t.create();
  await rejects(t.create({ externalRef: "user-2", idempotencyKey: "idem-0002" }), "BUDGET", 429);
  assert.equal((await t.svc.list(t.optus.id, {})).length, 1);
  assert.equal(t.deployer.deploys.length, 1, "no deployment is paid beyond the quota");
});

test("account: a refused or lost deployment is retried, announced once, and never given up on", async () => {
  const t = await issuing();
  t.deployer.failNext = "rejected";
  const { account } = await t.create();
  assert.equal(account.state, "DEPLOYING", "the caller still gets its address");
  assert.match(account.lastError!, /^DEPLOY_REJECTED:/);
  assert.equal(account.deploySubmissionId, undefined);

  // The relayer accepts it, then reports the transaction as failed; then it times out.
  t.deployer.autoConfirm = false;
  t.clock.advance(60_000);
  await t.svc.processDue();
  let a = (await t.repo.get(account.id))!;
  assert.equal(a.deploySubmissionId, "deploy-1");
  t.deployer.statuses.set("deploy-1", { state: "failed", reason: "failed:out of gas" });
  t.deployer.failNext = "timeout";
  t.clock.advance(60_000);
  await t.svc.processDue();
  a = (await t.repo.get(account.id))!;
  assert.deepEqual([a.state, a.attempts, a.deploySubmissionId], ["DEPLOYING", 3, undefined]);
  assert.match(a.lastError!, /^DEPLOY_PENDING:relayer timeout/);
  const delayed = t.events.filter((e) => e.type === "account.deploy_delayed");
  assert.deepEqual(delayed.map((e) => [e.severity, e.data!.attempts]), [["warning", 3]]);

  // Someone else deploys it (the factory is permissionless): the chain is what counts.
  t.deployer.code.add(account.address);
  assert.equal((await t.drive(account.id)).state, "ACTIVE");
  assert.equal(t.deployer.deploys.length, 1);
});

// ── Paying with an account (CCTP, router v2) ────────────────────────────────────────────────────────

const quoteInput = { sourceNetwork: "eip155:43113", destinationNetwork: "stellar:testnet", amount: "1.25", payTo: MERCHANT };
const ACCOUNT: Hex = "0x00000000000000000000000000000000000acc01";
const NONCE = `0x${"7e".repeat(32)}` as Hex;

async function payingSetup() {
  const h = harness();
  h.evm.routerV2Addr = ROUTER_V2;
  h.accountPayers.active.set(ACCOUNT.toLowerCase(), LEGACY_TENANT_ID);
  const q = await h.svc.quote(quoteInput);
  h.evm.lastBurn = { amount: q.burnAmountAtomic, maxFee: q.maxFeeAtomic, target: q.target, finality: q.finality };
  const r = await h.svc.createPayment({ quoteId: q.id, mode: "account", payer: ACCOUNT, idempotencyKey: "key-account-1" });
  return { h, q, r };
}

test("account payment: the owner signs a challenge that names the account; the relayer submits it through router v2 and it settles", async () => {
  const { h, q, r } = await payingSetup();
  const auth = r.authorization!;
  assert.deepEqual([r.payment.state, r.calls.length, auth.router], ["AWAITING_BURN", 0, ROUTER_V2]);
  assert.equal(auth.typedData.message.to, ROUTER_V2, "the funds can only be pulled by router v2");
  assert.equal(auth.nonce, authorizationNonce(paymentIdBytes32(r.payment.id), q.burnAmountAtomic, routeOf(27, q.target, q.maxFeeAtomic, q.finality), 2));
  assert.notEqual(auth.nonce, authorizationNonce(paymentIdBytes32(r.payment.id), q.burnAmountAtomic, routeOf(27, q.target, q.maxFeeAtomic, q.finality), 1));
  assert.equal(auth.account!.challenge, typedDataChallenge(ACCOUNT, 43113, auth.account!.contents));
  assert.equal(auth.account!.contents.contentsType, RECEIVE_AUTHORIZATION_TYPE);

  const passkeySignature = encodeWebAuthnSignature(KEY.assert(auth.account!.challenge));
  const expected = wrapTypedDataSignature(passkeySignature, auth.account!.contents);

  // The chain says no (another passkey, say): nothing reaches the relayer.
  await rejects(h.svc.submitAccountAuthorization(r.payment.id, { passkeySignature }), "APPROVAL_INVALID");
  assert.equal(h.evmSubmitter.submits.length, 0);
  assert.deepEqual(h.accountPayers.checked.at(-1), { account: ACCOUNT, hash: hashTypedData(auth.typedData), signature: expected });

  h.accountPayers.valid.add(expected.toLowerCase());
  let p = await h.svc.submitAccountAuthorization(r.payment.id, { passkeySignature });
  assert.ok(p.burnSubmissionId);
  assert.equal((await h.svc.submitAccountAuthorization(r.payment.id, { signature: expected })).burnSubmissionId, p.burnSubmissionId, "same signature is idempotent");
  await rejects(h.svc.submitAccountAuthorization(r.payment.id, { signature: `${expected}00` as Hex }), "INVALID_STATE_TRANSITION");
  await rejects(h.svc.submitAuthorization(r.payment.id, { v: 27, r: NONCE, s: NONCE }), "INVALID_STATE_TRANSITION");

  assert.equal(h.evmSubmitter.submits.length, 1);
  const sent = h.evmSubmitter.submits[0]!;
  assert.equal(sent.to, ROUTER_V2);
  const call = decodeFunctionData({ abi: ROUTER_V2_ABI, data: sent.data });
  const [paymentId, payer, amount, , authorization] = call.args as unknown as [Hex, Hex, bigint, unknown, { validAfter: bigint; validBefore: bigint; signature: Hex }];
  assert.deepEqual([paymentId, payer.toLowerCase(), amount], [paymentIdBytes32(r.payment.id), ACCOUNT.toLowerCase(), q.burnAmountAtomic]);
  assert.deepEqual([authorization.validAfter, authorization.validBefore, authorization.signature], [0n, auth.validBefore, expected]);

  p = await h.svc.step(h.svc.mustGet(p.id));
  assert.equal(p.state, "BURN_SUBMITTED");
  h.attest(p.burnTxHash!, NONCE, {}, "v2");
  p = await h.drive(p.id);
  assert.equal(p.state, "SETTLED");
  assert.equal(h.evm.counter, 0, "the backend never signed or broadcast for the account");
});

test("account payment: only a deployed account of the calling tenant can pay, and only with router v2 configured", async () => {
  const h = harness();
  h.evm.routerV2Addr = ROUTER_V2;
  const q = await h.svc.quote(quoteInput);
  await rejects(h.svc.createPayment({ quoteId: q.id, mode: "account", payer: ACCOUNT, idempotencyKey: "key-account-2" }), "NOT_FOUND");
  h.accountPayers.active.set(ACCOUNT.toLowerCase(), "tenant_other");
  await rejects(h.svc.createPayment({ quoteId: q.id, mode: "account", payer: ACCOUNT, idempotencyKey: "key-account-3" }), "NOT_FOUND");
  await rejects(h.svc.createPayment({ quoteId: q.id, mode: "account", idempotencyKey: "key-account-4" }), "INVALID_INPUT");
  h.evm.routerV2Addr = null;
  await rejects(h.svc.createPayment({ quoteId: q.id, mode: "account", payer: ACCOUNT, idempotencyKey: "key-account-5" }), "SERVICE_UNAVAILABLE");
  assert.equal(h.evmSubmitter.submits.length, 0);
});

test("account payment: an authorization that was never used expires and the payment fails without moving funds", async () => {
  const { h, r } = await payingSetup();
  const signature = wrapTypedDataSignature(encodeWebAuthnSignature(KEY.assert(r.authorization!.account!.challenge)), r.authorization!.account!.contents);
  h.accountPayers.valid.add(signature.toLowerCase());
  h.clock.advance(601_000);
  await rejects(h.svc.submitAccountAuthorization(r.payment.id, { signature }), "EXPIRED");
  assert.equal(h.evmSubmitter.submits.length, 0);
});

// ── HTTP: tenants, scopes and the accounts API ──────────────────────────────────────────────────────

const OPERATOR_KEY = "clave-del-operador-de-prueba";
const OUTSIDE = "203.0.113.7";

async function api() {
  const ctx = createAppContext("api", loadEnv({ DATABASE_PATH: ":memory:", LOG_LEVEL: "fatal", TILCAI_API_KEYS: OPERATOR_KEY }));
  const deployer = new FakeDeployer();
  /** Lets a test move the worker's clock past the next check. */
  const ahead = { ms: 0 };
  ctx.accountService = new AccountService({ repo: ctx.accounts, providers: { "eip155:43113": deployer }, clock: { now: () => new Date(Date.now() + ahead.ms) }, log: silentLogger, events: ctx.monitor, options: { pollMs: 1000 } });
  const app = buildServer(ctx);
  const tenant = async (name: string, scopes: Array<"payments" | "accounts:read" | "accounts:write">) => {
    const t = await ctx.tenants.createTenant({ name });
    const { key } = await ctx.tenants.issueKey(t.id, { label: "backend", scopes });
    return { id: t.id as TenantId, auth: { authorization: `Bearer ${key}` } };
  };
  const close = async () => {
    await app.close();
    ctx.resources.stop();
    ctx.db.close();
  };
  return { ctx, app, deployer, ahead, tenant, close, operator: { authorization: `Bearer ${OPERATOR_KEY}` } };
}
const accountBody = (over: Record<string, unknown> = {}) => ({ network: "eip155:43113", externalRef: "user-1", owner: KEY.owner, ...over });

test("API: every key is a tenant with scopes; the operator's routes stay with the operator", async () => {
  const t = await api();
  const optus = await t.tenant("Optus", ["payments", "accounts:read", "accounts:write"]);
  const reader = await t.tenant("Reader", ["accounts:read"]);
  const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ url, headers, remoteAddress: OUTSIDE });

  assert.equal((await get("/v1/accounts")).statusCode, 401);
  assert.equal((await get("/v1/accounts", { authorization: "Bearer no-existe" })).statusCode, 401);
  // The operator's keys keep the `payments` scope only (Optipagos and optus-agentBE as they were).
  assert.equal((await get("/v1/routes", t.operator)).statusCode, 200);
  assert.equal((await get("/v1/monitor/events", t.operator)).statusCode, 200);
  assert.equal((await get("/v1/accounts", t.operator)).statusCode, 403);
  // A tenant pays and holds accounts, and never reaches the vault, the event log or the relayer.
  assert.equal((await get("/v1/routes", optus.auth)).statusCode, 200);
  assert.equal((await get("/v1/accounts", optus.auth)).statusCode, 200);
  for (const url of ["/v1/vault", "/v1/monitor/events", "/v1/monitor/resources", "/v1/relayer/status"]) {
    assert.equal((await get(url, optus.auth)).statusCode, 403, url);
  }
  assert.equal((await get("/v1/routes", reader.auth)).statusCode, 403);
  const refused = await t.app.inject({ method: "POST", url: "/v1/accounts", headers: { ...reader.auth, "idempotency-key": "idem-0001" }, payload: accountBody(), remoteAddress: OUTSIDE });
  assert.equal(refused.statusCode, 403, "reading is not issuing");

  await t.ctx.tenants.setStatus(optus.id, "SUSPENDED");
  assert.equal((await get("/v1/accounts", optus.auth)).statusCode, 401, "a suspended tenant is nobody");
  await t.close();
});

test("API: POST /v1/accounts issues once, GET shows it to its tenant only", async () => {
  const t = await api();
  const optus = await t.tenant("Optus", ["accounts:read", "accounts:write"]);
  const other = await t.tenant("Other", ["accounts:read", "accounts:write"]);
  const post = (headers: Record<string, string>, payload: unknown) => t.app.inject({ method: "POST", url: "/v1/accounts", headers, payload: payload as never, remoteAddress: OUTSIDE });

  assert.equal((await post(optus.auth, accountBody())).statusCode, 400, "Idempotency-Key is required");
  assert.equal((await post({ ...optus.auth, "idempotency-key": "idem-0001" }, accountBody({ network: "eip155:1" }))).statusCode, 400);
  assert.equal((await post({ ...optus.auth, "idempotency-key": "idem-0001" }, accountBody({ owner: { ...KEY.owner, privateKey: "0x01" } }))).statusCode, 400, "unknown fields are refused");
  assert.equal((await post({ ...optus.auth, "idempotency-key": "idem-0001" }, accountBody({ owner: { ...KEY.owner, publicKey: `0x04${"11".repeat(64)}` } }))).statusCode, 400);

  const created = await post({ ...optus.auth, "idempotency-key": "idem-0001" }, accountBody());
  assert.equal(created.statusCode, 201);
  const { account, links } = created.json() as { account: Record<string, string>; links: Record<string, string> };
  assert.deepEqual([account.state, account.network, account.externalRef], ["DEPLOYING", "eip155:43113", "user-1"]);
  assert.equal(links.address, `https://testnet.snowtrace.io/address/${account.address}`);
  assert.ok(!("salt" in account) && !("idempotencyKey" in account) && !("tenantId" in account));
  const again = await post({ ...optus.auth, "idempotency-key": "idem-0001" }, accountBody());
  assert.deepEqual([again.statusCode, (again.json() as { account: { id: string } }).account.id], [200, account.id]);

  t.ahead.ms = 5000;
  await t.ctx.accountService!.processDue();
  const seen = await t.app.inject({ url: `/v1/accounts/${account.id}`, headers: optus.auth, remoteAddress: OUTSIDE });
  const body = seen.json() as { account: { state: string; deployTxHash: string }; events: unknown[]; links: { deployTx: string } };
  assert.deepEqual([seen.statusCode, body.account.state, body.events.length], [200, "ACTIVE", 2]);
  assert.equal(body.links.deployTx, `https://testnet.snowtrace.io/tx/${body.account.deployTxHash}`);
  const listed = await t.app.inject({ url: "/v1/accounts?externalRef=user-1&network=eip155:43113", headers: optus.auth, remoteAddress: OUTSIDE });
  assert.equal((listed.json() as { accounts: unknown[] }).accounts.length, 1);

  assert.equal((await t.app.inject({ url: `/v1/accounts/${account.id}`, headers: other.auth, remoteAddress: OUTSIDE })).statusCode, 404);
  assert.deepEqual(((await t.app.inject({ url: "/v1/accounts", headers: other.auth, remoteAddress: OUTSIDE })).json() as { accounts: unknown[] }).accounts, []);

  t.ctx.accountService = null;
  assert.equal((await t.app.inject({ url: "/v1/accounts", headers: optus.auth, remoteAddress: OUTSIDE })).statusCode, 503);
  await t.close();
});
