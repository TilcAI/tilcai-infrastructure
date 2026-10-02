// Live checks against the OpenZeppelin Relayer. Skipped without RELAYER_API_KEY.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEnv } from "../../src/config/env.ts";
import { RelayerClient } from "../../src/modules/relayer/client.ts";

const env = loadEnv();
const skip = env.RELAYER_API_KEY ? false : "RELAYER_API_KEY not set";

test("relayer is up and authenticated; x402 advertises stellar:testnet", { skip }, async () => {
  const r = new RelayerClient(env.RELAYER_URL, env.RELAYER_API_KEY);
  assert.equal(await r.health(), true);
  const sup = await r.x402(env.RELAYER_X402_PLUGIN_ID, "/supported");
  assert.equal(sup.status, 200);
  assert.ok(sup.body.kinds.some((k: any) => k.network === "stellar:testnet" && k.scheme === "exact"));
  const relayers = await r.listRelayers();
  assert.ok(relayers.some((x) => x.id === env.RELAYER_STELLAR_ID), `relayer ${env.RELAYER_STELLAR_ID} configured`);
});
