import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const API_KEY_PREFIX = "tilc_test_";
/** Longest key we are willing to hash. Anything longer cannot be one of ours. */
export const MAX_API_KEY_LENGTH = 512;

/** 256 bits of randomness. Testnet only, hence the prefix. */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/**
 * SHA-256 is enough because API keys are random 256-bit values (or the 64-hex keys of TILCAI_API_KEYS):
 * there is nothing to guess, so a slow password hash would only cost time on every request.
 */
export const hashApiKey = (key: string): string => createHash("sha256").update(key, "utf8").digest("hex");

/** Constant-time comparison of two hex digests. */
export function sameHash(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** First characters of an issued key, enough to recognise it in a list. */
export const keyHint = (key: string): string => key.slice(0, API_KEY_PREFIX.length + 4);
