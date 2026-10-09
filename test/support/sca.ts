import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "../../src/shared/clock.ts";
import { iso } from "../../src/shared/clock.ts";
import type { Hex } from "../../src/shared/hex.ts";
import { newDelegationId, newSmartAccountId } from "../../src/shared/ids.ts";
import type {
  AccountEvent,
  AccountNetwork,
  DelegationRepository,
  OwnerCredential,
  SmartAccountRepository,
  StoredDelegation,
  StoredSmartAccount,
} from "../../src/modules/accounts/ports.ts";
import type { TenantAdmin, TenantId, TenantRegistry } from "../../src/modules/tenants/ports.ts";

/** A clock the test moves by hand. Starts mid-day so a few hours cannot cross a UTC midnight. */
export class TestClock implements Clock {
  t = Date.parse("2026-10-08T12:00:00.000Z");
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

export const OWNER_P256: OwnerCredential = { kind: "webauthn-p256", publicKey: `0x04${"11".repeat(64)}` as Hex, credentialId: "cred-1", rpId: "optus.example" };
export const OWNER_ED25519: OwnerCredential = { kind: "ed25519", publicKey: `0x${"22".repeat(32)}` as Hex };

let counter = 0;
/** A distinct, well-formed-looking address for the network. */
export function fakeAddress(network: AccountNetwork): string {
  const n = ++counter;
  return network === "eip155:43113" ? `0x${n.toString(16).padStart(40, "0")}` : `C${n.toString().padStart(55, "A")}`;
}

export function newAccount(tenantId: TenantId, clock: Clock, over: Partial<StoredSmartAccount> = {}): StoredSmartAccount {
  const network = over.network ?? "stellar:testnet";
  const now = iso(clock.now());
  const n = ++counter;
  return {
    id: newSmartAccountId(),
    tenantId,
    externalRef: `user-${n}`,
    network,
    address: fakeAddress(network),
    owner: network === "eip155:43113" ? { kind: "secp256k1", address: `0x${"ab".repeat(20)}` as Hex } : OWNER_P256,
    state: "DEPLOYING",
    codeRef: "wasm-hash-v1",
    createdAt: now,
    salt: `0x${n.toString(16).padStart(64, "0")}` as Hex,
    idempotencyKey: `idem-${n}-${"x".repeat(8)}`,
    requestHash: `hash-${n}`,
    attempts: 0,
    nextCheckAt: now,
    updatedAt: now,
    version: 0,
    ...over,
  };
}

export function accountEvent(a: { id: StoredSmartAccount["id"] }, to: AccountEvent["to"], note: string, clock: Clock, from: AccountEvent["from"] = null): AccountEvent {
  return { accountId: a.id, from, to, note, at: iso(clock.now()) };
}

export function newDelegation(accountId: StoredDelegation["accountId"], clock: Clock, over: Partial<StoredDelegation> = {}): StoredDelegation {
  const now = iso(clock.now());
  return {
    id: newDelegationId(),
    accountId,
    rule: {
      agentKey: { kind: "ed25519", publicKey: `0x${"33".repeat(32)}` as Hex },
      assetId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      payTo: ["GDI6QJMZYUW2KFJZ7OJMY2PSPC5Z7ITO2PWM2X5TJ3IQYM37MTSMXE4N"],
      maxPerCallAtomic: 1_000_000n,
      maxPerPeriodAtomic: 12_345_678_901_234_567_890n, // beyond 2^53 on purpose
      periodSeconds: 86_400,
      validUntil: "2026-12-31T00:00:00.000Z",
    },
    state: "AWAITING_OWNER",
    attempts: 0,
    nextCheckAt: now,
    createdAt: now,
    updatedAt: now,
    version: 0,
    ...over,
  };
}

export function delegationEvent(d: StoredDelegation, to: AccountEvent["to"], note: string, clock: Clock, from: AccountEvent["from"] = null): AccountEvent {
  return { accountId: d.accountId, delegationId: d.id, from, to, note, at: iso(clock.now()) };
}

/** What the repository contract needs, whatever engine is behind it (SQLite now, Postgres in phase 2). */
export interface RepoFixture {
  tenants: TenantRegistry & TenantAdmin;
  accounts: SmartAccountRepository;
  delegations: DelegationRepository;
  clock: TestClock;
}

/**
 * A throwaway directory for database files. Windows can hold the -wal/-shm files for a moment after the
 * processes that used them exit, so the removal retries, and leftovers in the temp folder never fail a test.
 */
export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "tilcai-test-"));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        /* a temp folder left behind is harmless */
      }
    },
  };
}
