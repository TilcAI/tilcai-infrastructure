import { bytesToHex, hexToBytes, type Hex } from "../../../shared/hex.ts";

/** Decoded CCTP V2 message: 148-byte header + BurnMessageV2 body (cctp-engine §4.3). */
export interface CctpMessageV2 {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  nonce: Hex;
  sender: Hex;
  recipient: Hex;
  destinationCaller: Hex;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  body: {
    version: number;
    burnToken: Hex;
    mintRecipient: Hex;
    amount: bigint;
    messageSender: Hex;
    maxFee: bigint;
    feeExecuted: bigint;
    expirationBlock: bigint;
    hookData: Hex;
  };
}

const HEADER = 148;
const BODY_FIXED = 228;

/** Parses raw bytes independently of Iris' `decodedMessage` (which is not trusted). */
export function decodeMessageV2(message: string): CctpMessageV2 {
  const m = hexToBytes(message);
  if (m.length < HEADER + BODY_FIXED) throw new TypeError("CCTP message too short.");
  const b32 = (buf: Buffer, at: number) => bytesToHex(buf.subarray(at, at + 32));
  const u256 = (buf: Buffer, at: number) => BigInt(b32(buf, at));
  const version = m.readUInt32BE(0);
  if (version !== 1) throw new TypeError(`Unsupported CCTP message version ${version}.`);
  const body = m.subarray(HEADER);
  const bodyVersion = body.readUInt32BE(0);
  if (bodyVersion !== 1) throw new TypeError(`Unsupported burn message version ${bodyVersion}.`);
  return {
    version,
    sourceDomain: m.readUInt32BE(4),
    destinationDomain: m.readUInt32BE(8),
    nonce: b32(m, 12),
    sender: b32(m, 44),
    recipient: b32(m, 76),
    destinationCaller: b32(m, 108),
    minFinalityThreshold: m.readUInt32BE(140),
    finalityThresholdExecuted: m.readUInt32BE(144),
    body: {
      version: bodyVersion,
      burnToken: b32(body, 4),
      mintRecipient: b32(body, 36),
      amount: u256(body, 68),
      messageSender: b32(body, 100),
      maxFee: u256(body, 132),
      feeExecuted: u256(body, 164),
      expirationBlock: u256(body, 196),
      hookData: bytesToHex(body.subarray(BODY_FIXED)),
    },
  };
}
