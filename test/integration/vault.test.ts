// Read-only checks against the deployed TilcaiVault on Fuji. No funds move.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, http } from "viem";
import { loadEnv } from "../../src/config/env.ts";
import { networks } from "../../src/config/networks.ts";
import { RelayerEvmSubmitter } from "../../src/modules/crosschain/adapters/evm-relayer.ts";
import { RelayerClient } from "../../src/modules/relayer/client.ts";
import { disbursementIdBytes32, VAULT_ABI, ViemVault } from "../../src/modules/vault/adapters/evm.ts";

const env = loadEnv();
const net = networks(env).avalancheFuji;
const skip = net.vault ? false : "VAULT_FUJI not set";
const client = createPublicClient({ transport: http(net.rpc) });

test("vault is deployed, holds Fuji USDC and has sane limits", { skip }, async () => {
  const token = await client.readContract({ address: net.vault!, abi: VAULT_ABI, functionName: "usdc" });
  assert.equal(token.toLowerCase(), net.usdc.address.toLowerCase());
  const s = await new ViemVault(net, net.vault!).status();
  assert.ok(s.maxPerDisbursementAtomic > 0n && s.maxPerDisbursementAtomic <= s.dailyLimitAtomic);
  assert.ok(s.availableTodayAtomic <= s.dailyLimitAtomic);
  assert.equal(await new ViemVault(net, net.vault!).paidAmount(disbursementIdBytes32("vault_disbursement_never_created")), 0n);
});

test("the relayer's Fuji account is the vault operator; nobody else can disburse", { skip: skip || (env.RELAYER_API_KEY ? false : "RELAYER_API_KEY not set") }, async () => {
  const vault = new ViemVault(net, net.vault!);
  const relayer = await new RelayerEvmSubmitter(new RelayerClient(env.RELAYER_URL, env.RELAYER_API_KEY), env.RELAYER_FUJI_ID).sender();
  const s = await vault.status();
  assert.equal(s.operator.toLowerCase(), relayer.toLowerCase());
  const id = disbursementIdBytes32("vault_disbursement_simulation");
  const to = "0x00000000000000000000000000000000000000b1";
  assert.deepEqual(await vault.simulate(s.owner, id, to, 1n), { ok: false, reason: "NotOperator" });
  // Above the cap the operator is refused too, whatever the balance.
  assert.deepEqual(await vault.simulate(relayer, id, to, s.maxPerDisbursementAtomic + 1n), { ok: false, reason: "AboveDisbursementLimit" });
});
