import { concatHex, encodeAbiParameters, keccak256, numberToHex, stringToHex, toHex } from "viem";
import type { Hex } from "../../../shared/hex.ts";

/**
 * What a TilcaiAccount (contracts/evm/src/TilcaiAccount.sol) expects from its owner's passkey.
 *
 * The owner never signs an app's hash directly. For typed data (ERC-1271) the passkey signs an
 * ERC-7739 `TypedDataSign` that wraps the app's message and names the account, so a signature
 * made for one account is worthless on another account of the same passkey.
 * Everything here is pure: the same bytes the contract computes, computed off-chain.
 */

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** EIP-712 domain of every TilcaiAccount (the constructor of the contract). */
export const ACCOUNT_DOMAIN = { name: "TilcaiAccount", version: "1" } as const;

export class PasskeyFormatError extends Error {}

const word = (n: bigint): Hex => numberToHex(n, { size: 32 });

/** Splits a 65-byte uncompressed P-256 point and checks it is on the curve. */
export function p256Point(publicKey: string): { qx: Hex; qy: Hex } {
  if (!/^0x04[0-9a-fA-F]{128}$/.test(publicKey)) throw new PasskeyFormatError("owner.publicKey must be a 65-byte uncompressed P-256 point (0x04…)");
  const x = BigInt(`0x${publicKey.slice(4, 68)}`);
  const y = BigInt(`0x${publicKey.slice(68)}`);
  const onCurve = x < P && y < P && (y * y) % P === (((x * x) % P) * x + (P - 3n) * x + B) % P;
  if (!onCurve || (x === 0n && y === 0n)) throw new PasskeyFormatError("owner.publicKey is not a point of the P-256 curve");
  return { qx: word(x), qy: word(y) };
}

/** `r ‖ s` from what an authenticator returns: ASN.1 DER, or the 64 raw bytes. `s` comes back in its low form. */
export function p256Signature(signature: Uint8Array): { r: Hex; s: Hex } {
  let r: bigint;
  let s: bigint;
  if (signature.length === 64) {
    r = BigInt(toHex(signature.subarray(0, 32)));
    s = BigInt(toHex(signature.subarray(32)));
  } else {
    // SEQUENCE { INTEGER r, INTEGER s }, short-form lengths (a P-256 signature never needs more).
    const fail = () => new PasskeyFormatError("signature is not a DER-encoded ECDSA signature");
    if (signature[0] !== 0x30 || signature[1] !== signature.length - 2 || signature.length > 72) throw fail();
    const integer = (at: number): { value: bigint; next: number } => {
      const length = signature[at + 1];
      if (signature[at] !== 0x02 || length === undefined || length === 0 || length > 33 || at + 2 + length > signature.length) throw fail();
      return { value: BigInt(toHex(signature.subarray(at + 2, at + 2 + length))), next: at + 2 + length };
    };
    const first = integer(2);
    const second = integer(first.next);
    if (second.next !== signature.length) throw fail();
    r = first.value;
    s = second.value;
  }
  if (r <= 0n || r >= N || s <= 0n || s >= N) throw new PasskeyFormatError("signature is out of range");
  // Authenticators return either root; the chain only takes the low one.
  if (s > N / 2n) s = N - s;
  return { r: word(r), s: word(s) };
}

export interface WebAuthnAssertion {
  authenticatorData: Uint8Array;
  /** The exact bytes the browser produced: they are hashed, so they cannot be re-serialized. */
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
}

/**
 * The assertion of `navigator.credentials.get()` as the account reads it:
 * `abi.encode(r, s, challengeIndex, typeIndex, authenticatorData, clientDataJSON)`.
 */
export function encodeWebAuthnSignature(a: WebAuthnAssertion): Hex {
  const json = Buffer.from(a.clientDataJSON).toString("utf8");
  if (!Buffer.from(json, "utf8").equals(Buffer.from(a.clientDataJSON))) throw new PasskeyFormatError("clientDataJSON is not UTF-8");
  const typeIndex = json.indexOf('"type":"');
  const challengeIndex = json.indexOf('"challenge":"');
  if (typeIndex < 0 || challengeIndex < 0) throw new PasskeyFormatError("clientDataJSON has no type or challenge");
  if (a.authenticatorData.length < 37) throw new PasskeyFormatError("authenticatorData is too short");
  const { r, s } = p256Signature(a.signature);
  return encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "string" }],
    [r, s, BigInt(challengeIndex), BigInt(typeIndex), toHex(a.authenticatorData), json],
  );
}

/** An app's typed data, as far as the account needs it. */
export interface TypedContents {
  /** Domain separator of the app (for USDC: the token's). */
  appDomainSeparator: Hex;
  /** EIP-712 type string of the message, e.g. `ReceiveWithAuthorization(address from,…)`. */
  contentsType: string;
  /** hashStruct of the message. */
  contentsHash: Hex;
}

/**
 * The 32 bytes the passkey really signs (the WebAuthn challenge) when an app asks `account`
 * for a typed-data signature. Mirrors OpenZeppelin `ERC7739Utils.typedDataSignStructHash`.
 */
export function typedDataChallenge(account: Hex, chainId: number, c: TypedContents): Hex {
  const contentsName = c.contentsType.slice(0, c.contentsType.indexOf("("));
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(contentsName) || !c.contentsType.endsWith(")")) throw new PasskeyFormatError("bad contents type");
  const typehash = keccak256(
    stringToHex(`TypedDataSign(${contentsName} contents,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)${c.contentsType}`),
  );
  const domain = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }],
    [keccak256(stringToHex(ACCOUNT_DOMAIN.name)), keccak256(stringToHex(ACCOUNT_DOMAIN.version)), BigInt(chainId), account, word(0n)],
  );
  const structHash = keccak256(concatHex([typehash, c.contentsHash, domain]));
  return keccak256(concatHex(["0x1901", c.appDomainSeparator, structHash]));
}

/** The ERC-1271 signature of the account: the passkey's signature plus what the account needs to rebuild the challenge. */
export function wrapTypedDataSignature(passkeySignature: Hex, c: TypedContents): Hex {
  const descr = stringToHex(c.contentsType);
  return concatHex([passkeySignature, c.appDomainSeparator, c.contentsHash, descr, numberToHex((descr.length - 2) / 2, { size: 2 })]);
}

/** WebAuthn carries the challenge as unpadded base64url inside clientDataJSON. */
export const challengeBase64Url = (challenge: Hex): string => Buffer.from(challenge.slice(2), "hex").toString("base64url");

export function fromBase64Url(value: string, name: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new PasskeyFormatError(`${name} must be base64url`);
  return new Uint8Array(Buffer.from(value, "base64url"));
}
