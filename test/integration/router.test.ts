// Read-only checks against the deployed TilcaiCctpRouter and Fuji USDC. No funds move.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, hashDomain, http, parseAbi } from "viem";
import { loadEnv } from "../../src/config/env.ts";
import { networks } from "../../src/config/networks.ts";
import { stellarMintTarget } from "../../src/modules/crosschain/cctp/encoding.ts";
import { authorizationNonce, authorizationTypedData, paymentIdBytes32, routeOf, USDC_3009_ABI } from "../../src/modules/crosschain/router.ts";
import { Keypair } from "@stellar/stellar-sdk";

const env = loadEnv();
const net = networks(env).avalancheFuji;
const skip = net.cctpRouter ? false : "CCTP_ROUTER_FUJI not set";
const client = createPublicClient({ transport: http(net.rpc) });

test("TS authorization nonce equals TilcaiCctpRouter.authorizationNonce on-chain", { skip }, async () => {
  const target = stellarMintTarget(networks(env).stellarTestnet.cctpV2.cctpForwarder, Keypair.random().publicKey());
  const route = routeOf(27, target, 12_345n, 2000);
  const id = paymentIdBytes32("payment_attempt_test");
  const onchain = await client.readContract({
    address: net.cctpRouter!,
    abi: parseAbi([
      "struct Route { uint32 destinationDomain; bytes32 mintRecipient; bytes32 destinationCaller; uint256 maxFee; uint32 minFinalityThreshold; bytes hookData; }",
      "function authorizationNonce(bytes32 paymentId, uint256 amount, Route route) pure returns (bytes32)",
    ]),
    functionName: "authorizationNonce",
    args: [id, 1_000_000n, route],
  });
  assert.equal(onchain, authorizationNonce(id, 1_000_000n, route));
});

test("EIP-712 domain used for the typed data equals the USDC DOMAIN_SEPARATOR on Fuji", { skip }, async () => {
  const typed = authorizationTypedData(net, { payer: "0x1111111111111111111111111111111111111111", amount: 1n, nonce: `0x${"00".repeat(32)}`, validAfter: 0n, validBefore: 1n });
  const onchain = await client.readContract({ address: net.usdc.address, abi: USDC_3009_ABI, functionName: "DOMAIN_SEPARATOR" });
  assert.equal(hashDomain({ domain: { ...typed.domain, chainId: BigInt(typed.domain.chainId) }, types: { EIP712Domain: [
    { name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
  ] } }), onchain);
});

test("router bytecode is deployed and wired to Fuji USDC and TokenMessengerV2", { skip }, async () => {
  const abi = parseAbi(["function usdc() view returns (address)", "function tokenMessenger() view returns (address)"]);
  assert.equal((await client.readContract({ address: net.cctpRouter!, abi, functionName: "usdc" })).toLowerCase(), net.usdc.address.toLowerCase());
  assert.equal((await client.readContract({ address: net.cctpRouter!, abi, functionName: "tokenMessenger" })).toLowerCase(), net.cctpV2.tokenMessenger.toLowerCase());
});
