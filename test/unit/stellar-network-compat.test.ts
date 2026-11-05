import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseIntent, parseMandate, intentCommitment, ContractValidationError } from "tilcai-core/experimental/authority";
import { loadEnv } from "../../src/config/env.ts";
import { networks } from "../../src/config/networks.ts";
import {
  STELLAR_NETWORK_COMPAT_SCHEMA,
  authorityV1NetworkFromOperational,
  operationalNetworkFromAuthorityV1,
} from "../../src/config/stellar-network-compat.ts";
import { openDatabase } from "../../src/db/sqlite.ts";
import { SqliteCrosschainRepository } from "../../src/modules/crosschain/repository.ts";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/n15-stellar-network-v1.json", import.meta.url), "utf8"));

test("N-15: the versioned fixture maps only the two existing Stellar environments", () => {
  assert.equal(fixture.schema, STELLAR_NETWORK_COMPAT_SCHEMA);
  assert.deepEqual(fixture.mappings, [
    { authorityV1: "stellar:testnet", operational: "stellar:testnet" },
    { authorityV1: "stellar:mainnet", operational: "stellar:pubnet" },
  ]);
  for (const { authorityV1, operational } of fixture.mappings) {
    assert.equal(operationalNetworkFromAuthorityV1(authorityV1), operational);
    assert.equal(authorityV1NetworkFromOperational(operational), authorityV1);
    assert.equal(operationalNetworkFromAuthorityV1(authorityV1NetworkFromOperational(operational)), operational);
  }
  for (const invalid of ["stellar:unknown", "stellar:futurenet", "stellar:MAINNET", "eip155:43114", "", null, 1, {}]) {
    assert.throws(() => operationalNetworkFromAuthorityV1(invalid), TypeError);
    assert.throws(() => authorityV1NetworkFromOperational(invalid), TypeError);
  }
  assert.throws(() => operationalNetworkFromAuthorityV1("stellar:pubnet"), TypeError);
  assert.throws(() => authorityV1NetworkFromOperational("stellar:mainnet"), TypeError);
  const active = networks(loadEnv({})).stellar.id;
  assert.equal(active, "stellar:testnet");
  assert.notEqual(operationalNetworkFromAuthorityV1("stellar:mainnet"), active, "resolving an ID does not enable mainnet");
});

test("N-15: published Core v1 keeps the exact authority network and v1 commitment", () => {
  const original = parseIntent(fixture.v1Intent);
  assert.equal(original.purchase.network, "stellar:mainnet");
  assert.equal(intentCommitment(original), fixture.v1CommitmentGolden);
  assert.equal(operationalNetworkFromAuthorityV1(original.purchase.network), "stellar:pubnet");
  assert.equal(original.purchase.network, "stellar:mainnet");
  assert.equal(intentCommitment(original), fixture.v1CommitmentGolden);
  assert.deepEqual(parseIntent(JSON.parse(JSON.stringify(original))), original);
  const testnet = parseIntent({ ...fixture.v1Intent, purchase: { ...fixture.v1Intent.purchase, network: "stellar:testnet" } });
  assert.equal(operationalNetworkFromAuthorityV1(testnet.purchase.network), "stellar:testnet");
  assert.notEqual(intentCommitment(testnet), fixture.v1CommitmentGolden);
  assert.throws(
    () => parseIntent({ ...fixture.v1Intent, purchase: { ...fixture.v1Intent.purchase, network: "stellar:pubnet" } }),
    ContractValidationError,
  );
});

test("N-15: Core v1 mandates retain mainnet and testnet through JSON roundtrips", () => {
  const raw = {
    schema: "tilcai-mandate-v1", id: "mandate_demo", revision: 1, principalId: "principal_demo", agentId: "agent_demo",
    accountRef: "account:test-buyer", network: "stellar:mainnet", assetId: "asset:test-configured",
    businesses: ["business_demo"], services: ["service_demo"], recipients: ["recipient:test-merchant"],
    limits: { maxPerPurchaseAtomic: "10000000", maxPerPeriodAtomic: "50000000", periodSeconds: 604800, periodAnchor: "2026-09-28T00:00:00.000Z" },
    budgetRef: "budget:test-root", requiresConfirmation: true, policyVersion: 1,
    validFrom: "2026-09-30T00:00:00.000Z", expiresAt: "2026-10-30T00:00:00.000Z", status: "ACTIVE",
  };
  for (const id of ["stellar:testnet", "stellar:mainnet"]) {
    const mandate = parseMandate({ ...raw, network: id });
    assert.equal(mandate.network, id);
    assert.deepEqual(parseMandate(JSON.parse(JSON.stringify(mandate))), mandate);
  }
  assert.throws(() => parseMandate({ ...raw, network: "stellar:pubnet" }), ContractValidationError);
});

test("N-15: a historical SQLite pubnet quote remains byte-for-byte pubnet when read", () => {
  const db = openDatabase(":memory:");
  try {
    db.exec(`INSERT INTO route_quotes (id, source_network, destination_network, source_domain, destination_domain, pay_to, destination_amount_atomic,
      burn_amount_atomic, max_fee_atomic, fee_bps_hundredths, finality, burn_token, mint_recipient, destination_caller, hook_data, preflight_json, created_at, expires_at)
      VALUES ('route_quote_n15','eip155:43114','stellar:pubnet',1,27,'G','1','1','0','0',2000,'0x','0x','0x','0x','{}','2026-10-08T00:00:00Z','2026-10-08T01:00:00Z')`);
    const quote = new SqliteCrosschainRepository(db).getQuote("route_quote_n15" as never);
    assert.equal(quote?.destinationNetwork, "stellar:pubnet");
    assert.equal(networks(loadEnv({})).byId(quote!.destinationNetwork)?.id, "stellar:pubnet");
    assert.equal(authorityV1NetworkFromOperational(quote!.destinationNetwork), "stellar:mainnet");
    assert.equal((db.prepare("SELECT destination_network FROM route_quotes WHERE id = ?").get("route_quote_n15") as { destination_network: string }).destination_network, "stellar:pubnet");
  } finally {
    db.close();
  }
});
