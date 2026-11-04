/**
 * Readiness: whether this process can do what its mode promises, which is more than being alive.
 * Liveness stays in `/health`, which answers while the process runs whatever its dependencies do,
 * so a relayer outage never restarts the container.
 *
 *  - read-only (mainnet before MAINNET_TRANSACTIONS_ENABLED): only the database is required; the
 *    relayer is reported, not required.
 *  - transactional: the relayer answers and takes our key; every relayer this process sends
 *    through exists on the expected network, unpaused, with a signer; the Stellar mint submitter
 *    is configured; and the worker, when it runs in this process, keeps reconciling.
 *
 * Read calls only: nothing here signs or sends. Details name ids and networks, never secrets.
 * Not checked: on-chain roles (that a relayer account is a vault's operator). The relayer API does
 * not expose them, so that stays with `npm run mainnet:preflight` and the deployment runbook.
 */
import type { DatabaseSync } from "node:sqlite";
import { RelayerHttpError, type RelayerClient } from "../relayer/client.ts";

export type ReadinessMode = "read-only" | "transactional";
export const READINESS_MODES: readonly ReadinessMode[] = ["read-only", "transactional"];

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  /** A failed required check makes the process not ready; the others only inform. */
  required: boolean;
  detail?: string;
}

export interface Readiness {
  ready: boolean;
  mode: ReadinessMode;
  checks: ReadinessCheck[];
}

/** A relayer this process sends through, and what it has to look like. */
export interface ExpectedRelayer {
  /** The TilcAI network it serves (CAIP-2). */
  for: string;
  /** Empty when the environment configures none. */
  id: string;
  network: string;
  networkType: "evm" | "stellar";
}

export interface WorkerState {
  running: boolean;
  /** When the last reconciliation round ended (its start, before the first one), in ms since the epoch. */
  lastRoundAt: number;
}

export interface ReadinessDeps {
  db: DatabaseSync;
  relayer: Pick<RelayerClient, "health" | "listRelayers" | "getRelayer">;
  relayerApiKeySet: boolean;
  relayers: readonly ExpectedRelayer[];
  mintSubmitter: { kind: "relayer" | "local"; localKeySet: boolean };
  /** The worker of this process. Absent when it runs in another one (the `api` role). */
  worker?: () => WorkerState;
  /** A worker silent for longer than this is stuck. */
  workerMaxSilenceMs: number;
  now?: () => number;
  /** Per relayer call: a probe answers in seconds even when the relayer does not. */
  timeoutMs?: number;
}

export async function checkReadiness(deps: ReadinessDeps, mode: ReadinessMode): Promise<Readiness> {
  const now = deps.now ?? Date.now;
  const within = <T>(p: Promise<T>) => withTimeout(p, deps.timeoutMs ?? 5000);
  const transactional = mode === "transactional";
  const checks: ReadinessCheck[] = [];
  const add = (name: string, required: boolean, ok: boolean, detail?: string) => checks.push({ name, ok, required, ...(detail ? { detail } : {}) });

  try {
    deps.db.prepare("SELECT 1").get();
    add("database", true, true);
  } catch {
    add("database", true, false, "query failed");
  }

  const up = await within(deps.relayer.health()).catch(() => false);
  add("relayer.reachable", transactional, up, up ? undefined : "GET /api/v1/health did not answer");

  if (transactional) {
    let listed: Awaited<ReturnType<RelayerClient["listRelayers"]>> | null = null;
    if (!deps.relayerApiKeySet) add("relayer.auth", true, false, "no relayer API key configured");
    else if (!up) add("relayer.auth", true, false, "not checked: the relayer is unreachable");
    else {
      try {
        listed = await within(deps.relayer.listRelayers());
        add("relayer.auth", true, true);
      } catch (e) {
        add("relayer.auth", true, false, e instanceof RelayerHttpError && e.status === 401 ? "key rejected (401)" : `could not list relayers (${failure(e)})`);
      }
    }

    for (const want of deps.relayers) {
      const name = `relayer.${want.for}`;
      if (!want.id) {
        add(name, true, false, "no relayer id configured");
        continue;
      }
      if (!listed) {
        add(name, true, false, `${want.id}: not checked, the relayer list is unavailable`);
        continue;
      }
      const found = listed.find((r) => r.id === want.id);
      if (!found) {
        add(name, true, false, `${want.id}: not found on this relayer`);
        continue;
      }
      const problems: string[] = [];
      if (found.network_type !== want.networkType) problems.push(`type ${found.network_type}, expected ${want.networkType}`);
      if (found.network !== want.network) problems.push(`network ${found.network}, expected ${want.network}`);
      if (found.paused) problems.push("paused");
      const address = found.address || (await within(deps.relayer.getRelayer(want.id)).then((r) => (typeof r.address === "string" ? r.address : ""), () => ""));
      if (!address) problems.push("no signer address");
      add(name, true, problems.length === 0, `${want.id}: ${problems.length ? problems.join("; ") : `${found.network}, signer ${address.slice(0, 6)}…${address.slice(-4)}`}`);
    }

    const m = deps.mintSubmitter;
    if (m.kind === "relayer") add("stellar.mintSubmitter", true, true, "relayer");
    else add("stellar.mintSubmitter", true, m.localKeySet, m.localKeySet ? "local key" : "STELLAR_MINT_SUBMITTER=local without STELLAR_OPERATOR_SECRET");
  }

  if (deps.worker) {
    const w = deps.worker();
    const silentS = Math.round((now() - w.lastRoundAt) / 1000);
    const ok = w.running && now() - w.lastRoundAt <= deps.workerMaxSilenceMs;
    add("worker", transactional, ok, !w.running ? "stopped" : ok ? `last round ${silentS} s ago` : `no round for ${silentS} s`);
  }

  return { ready: checks.every((c) => c.ok || !c.required), mode, checks };
}

const failure = (e: unknown) => (e instanceof RelayerHttpError ? `HTTP ${e.status}` : e instanceof Error && e.message === "timed out" ? "timed out" : "request failed");

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
