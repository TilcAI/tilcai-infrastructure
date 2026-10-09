import { timingSafeEqual } from "node:crypto";

export const isLoopback = (ip: string): boolean => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";

/** Constant-time comparison of a presented secret against the accepted ones. */
export function matchesAny(presented: string | undefined, accepted: readonly string[]): boolean {
  if (!presented) return false;
  const given = Buffer.from(presented);
  return accepted.some((k) => {
    const key = Buffer.from(k);
    return key.length === given.length && timingSafeEqual(key, given);
  });
}

export const bearerOf = (authorization: string | undefined): string | undefined => /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
