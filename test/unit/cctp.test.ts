import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";
import {
  bytes32ToEvm,
  decodeForwarderHookData,
  encodeForwarderHookData,
  evmToBytes32,
  stellarContractToBytes32,
  stellarMintTarget,
} from "../../src/modules/crosschain/cctp/encoding.ts";
import { decodeMessageV2 } from "../../src/modules/crosschain/cctp/message.ts";
import { nets } from "../support/fakes.ts";

// Real CCTP V2 message (Base Sepolia → Arc, Fast + Forwarding), fixture from tilcai-cctp-engine.
const REAL_V2 =
  "0x00000001000000060000001a0c05a332babcb0ce30885c69536bdc00aabf8f230f59491e17525168c64774280000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa0000000000000000000000000000000000000000000000000000000000000000000003e8000003e800000001000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e0000000000000000000000005caca04d787f5f28e49ad0085275a5056dd542c400000000000000000000000000000000000000000000000000000000001e8480000000000000000000000000c5567a5e3370d4dbfb0540025078e283e36a363d0000000000000000000000000000000000000000000000000000000000004ecb0000000000000000000000000000000000000000000000000000000000004ecb0000000000000000000000000000000000000000000000000000000003e393bd636374702d666f72776172640000000000000000000000000000000000000000";

test("decodes a real CCTP V2 message", () => {
  const m = decodeMessageV2(REAL_V2);
  assert.equal(m.sourceDomain, 6);
  assert.equal(m.destinationDomain, 26);
  assert.equal(m.nonce, "0x0c05a332babcb0ce30885c69536bdc00aabf8f230f59491e17525168c6477428");
  assert.equal(m.minFinalityThreshold, 1000);
  assert.equal(bytes32ToEvm(m.body.burnToken), "0x036cbd53842c5426634e7929541ec2318f3dcf7e");
  assert.equal(m.body.amount, 2_000_000n);
  assert.equal(m.body.maxFee, 20171n);
  assert.equal(m.body.feeExecuted, 20171n);
  assert.equal(m.body.expirationBlock, 65246141n);
  assert.equal(Buffer.from(m.body.hookData.slice(2, 26), "hex").toString(), "cctp-forward");
});

test("rejects truncated or V1 messages", () => {
  assert.throws(() => decodeMessageV2("0x0000"));
  assert.throws(() => decodeMessageV2(`0x00000000${REAL_V2.slice(10)}`));
});

test("Stellar target: forwarder is mintRecipient AND destinationCaller; hookData round-trips", () => {
  const g = Keypair.random().publicKey();
  const t = stellarMintTarget(nets.stellarTestnet.cctpV2.cctpForwarder, g);
  const fwd = stellarContractToBytes32(nets.stellarTestnet.cctpV2.cctpForwarder);
  assert.equal(t.mintRecipient, fwd);
  assert.equal(t.destinationCaller, fwd);
  assert.deepEqual(decodeForwarderHookData(t.hookData), { version: 0, recipient: g });
  const raw = Buffer.from(t.hookData.slice(2), "hex");
  assert.equal(raw.readUInt32BE(28), 56);
});

test("hookData and addresses reject malformed input", () => {
  assert.throws(() => encodeForwarderHookData("not-a-strkey"));
  assert.throws(() => stellarContractToBytes32(Keypair.random().publicKey()), "G… is never a valid mintRecipient");
  const g = Keypair.random().publicKey();
  const tampered = encodeForwarderHookData(g).slice(0, -2) + "00";
  assert.throws(() => decodeForwarderHookData(tampered));
  assert.equal(evmToBytes32("0x5CACa04d787f5F28e49ad0085275a5056dd542c4"), "0x0000000000000000000000005caca04d787f5f28e49ad0085275a5056dd542c4");
  assert.throws(() => evmToBytes32("0x1234"));
});
