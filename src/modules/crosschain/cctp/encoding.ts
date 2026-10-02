import { StrKey } from "@stellar/stellar-sdk";
import { bytesToHex, hexToBytes, strip0x, type Hex } from "../../../shared/hex.ts";

/** EVM 20-byte address → CCTP bytes32 (left padded). */
export function evmToBytes32(address: string): Hex {
  const a = strip0x(address).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(a)) throw new TypeError("Invalid EVM address.");
  return `0x${"0".repeat(24)}${a}`;
}

export function bytes32ToEvm(b32: string): Hex {
  const s = strip0x(b32).toLowerCase();
  if (!/^0{24}[0-9a-f]{40}$/.test(s)) throw new TypeError("bytes32 is not a left-padded EVM address.");
  return `0x${s.slice(24)}`;
}

/** Stellar contract strkey (C…) → 32 bytes. G/M accounts are NEVER valid mintRecipients. */
export function stellarContractToBytes32(contract: string): Hex {
  if (!StrKey.isValidContract(contract)) throw new TypeError("Not a Stellar contract strkey.");
  return bytesToHex(StrKey.decodeContract(contract));
}

export function isValidStellarRecipient(r: string): boolean {
  return StrKey.isValidEd25519PublicKey(r) || StrKey.isValidContract(r) || StrKey.isValidMed25519PublicKey(r);
}

/**
 * hookData understood by Circle's Stellar CctpForwarder:
 *   [0..24) zeros · [24..28) u32 BE hook version 0 · [28..32) u32 BE strkey length · [32..) strkey UTF-8
 */
export function encodeForwarderHookData(recipient: string): Hex {
  if (!isValidStellarRecipient(recipient)) throw new TypeError("Invalid Stellar forward recipient.");
  const r = Buffer.from(recipient, "utf8");
  const out = Buffer.alloc(32 + r.length);
  out.writeUInt32BE(0, 24);
  out.writeUInt32BE(r.length, 28);
  r.copy(out, 32);
  return bytesToHex(out);
}

export function decodeForwarderHookData(hook: string): { version: number; recipient: string } {
  const b = hexToBytes(hook);
  if (b.length < 32) throw new TypeError("Forwarder hookData too short.");
  if (!b.subarray(0, 24).every((x) => x === 0)) throw new TypeError("Forwarder hookData prefix is not zero.");
  const version = b.readUInt32BE(24);
  const len = b.readUInt32BE(28);
  if (b.length !== 32 + len) throw new TypeError("Forwarder hookData length mismatch.");
  const recipient = b.subarray(32).toString("utf8");
  if (!isValidStellarRecipient(recipient)) throw new TypeError("Forwarder hookData recipient is invalid.");
  return { version, recipient };
}

export interface MintTarget {
  mintRecipient: Hex;
  destinationCaller: Hex;
  hookData: Hex;
}

/**
 * Burn target for a Stellar G/M/C recipient: mintRecipient AND destinationCaller
 * must be the CctpForwarder, otherwise funds get stuck (cctp-engine §6.5).
 */
export function stellarMintTarget(forwarder: string, recipient: string): MintTarget {
  const fwd = stellarContractToBytes32(forwarder);
  return { mintRecipient: fwd, destinationCaller: fwd, hookData: encodeForwarderHookData(recipient) };
}
