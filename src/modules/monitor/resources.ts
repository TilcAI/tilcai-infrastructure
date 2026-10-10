import { statSync } from "node:fs";
import { cpus, freemem, hostname, loadavg, totalmem } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { atomicToDecimal } from "../../shared/amount.ts";
import type { RelayerClient } from "../relayer/client.ts";
import type { VaultDisbursementService } from "../vault/service.ts";
import type { MonitorAlert, SinkState } from "./domain.ts";

export interface RelayerResource {
  id: string;
  network: string | null;
  networkType: string | null;
  address: string | null;
  paused: boolean | null;
  /** The relayer took itself out of service (RPC or nonce trouble). */
  systemDisabled: boolean | null;
  /** Native balance that pays the gas (AVAX, XLM), as a decimal string. */
  balance: string | null;
  unit: string | null;
  error?: string;
}

export interface VaultView {
  address: string;
  paused: boolean;
  operatorIsRelayer: boolean;
  balance: string;
  pending: string;
  maxPerDisbursement: string;
  dailyLimit: string;
  availableToday: string;
}

/** One network's vault in a snapshot: what it holds, or why it could not be read. */
export interface VaultEntry {
  network: string;
  vault: VaultView | null;
  error?: string;
}

/** The network of the primary vault: its alerts keep the plain codes (`VAULT_EMPTY`). */
export const PRIMARY_VAULT_NETWORK = "eip155:43113";

export interface ResourceSnapshot {
  takenAt: string;
  /** Active Avalanche network; omitted by older snapshots. */
  primaryVaultNetwork?: string;
  process: {
    role: string;
    pid: number;
    node: string;
    uptimeSeconds: number;
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    /** CPU time of this process since the previous snapshot, as a share of one core (0–1+). */
    cpuLoad: number | null;
    eventLoopDelayMs: { mean: number; p99: number; max: number };
  };
  host: { name: string; cpus: number; loadAverage: number[]; totalMemoryBytes: number; freeMemoryBytes: number };
  database: {
    path: string;
    sizeBytes: number | null;
    walBytes: number | null;
    /** Rows per state of each queue: what is in flight and what already settled. */
    crosschainPayments: Record<string, number>;
    vaultDisbursements: Record<string, number>;
    qrCodes: Record<string, number>;
    qrCallbacksPending: number;
    monitorEvents: number;
  };
  relayer: { up: boolean; authenticated: boolean; relayers: RelayerResource[] };
  /** The primary vault (Avalanche Fuji's). Kept as it was so a dashboard that predates `vaults` still works. */
  vault: VaultView | null;
  vaultError?: string;
  /** Every configured vault, the primary first. Absent when no vault is configured. */
  vaults?: VaultEntry[];
  monitor: { head: number; sinks: Array<SinkState & { lag: number }> };
  alerts: Array<Omit<MonitorAlert, "since">>;
}

export interface ResourceDeps {
  role: string;
  db: DatabaseSync;
  databasePath: string;
  relayer: RelayerClient;
  relayerAuthenticated: boolean;
  relayerIds: string[];
  vault: VaultDisbursementService | null;
  usdcDecimals: number;
  primaryVaultNetwork?: string;
  /** Vaults of other networks (Stellar's). Their alerts carry the network as target: `VAULT_EMPTY:stellar:testnet`. */
  otherVaults?: Array<{ network: string; service: VaultDisbursementService; usdcDecimals: number }>;
  monitor: { head(): number; sinks(): SinkState[] };
  now(): Date;
}

/** Gas below this is close to stopping payouts (AVAX) or mints (XLM). */
const LOW_GAS: Record<string, number> = { evm: 0.05, stellar: 5 };
const EXTERNAL_TIMEOUT_MS = 8000;
const LOOP_RESOLUTION_MS = 20;

/** Takes the picture the dashboard shows: this process, its database, the relayer and the vault. */
export class ResourceMonitor {
  private readonly loopDelay: ReturnType<typeof monitorEventLoopDelay>;
  private lastCpu = process.cpuUsage();
  private lastCpuAt = process.hrtime.bigint();

  constructor(private readonly d: ResourceDeps) {
    this.loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    this.loopDelay.enable();
  }

  stop(): void {
    this.loopDelay.disable();
  }

  async snapshot(): Promise<ResourceSnapshot> {
    const [relayer, vault, others] = await Promise.all([this.relayer(), this.vault(), this.otherVaults()]);
    const database = this.database();
    const head = this.d.monitor.head();
    const sinks = this.d.monitor.sinks().map((s) => ({ ...s, lag: Math.max(head - s.lastSeq, 0) }));
    const snapshot: ResourceSnapshot = {
      takenAt: this.d.now().toISOString(),
      primaryVaultNetwork: this.d.primaryVaultNetwork ?? PRIMARY_VAULT_NETWORK,
      process: this.process(),
      host: { name: hostname(), cpus: cpus().length, loadAverage: loadavg().map((n) => round(n, 2)), totalMemoryBytes: totalmem(), freeMemoryBytes: freemem() },
      database,
      relayer,
      vault: vault.status,
      ...(vault.error ? { vaultError: vault.error } : {}),
      ...(this.d.vault || others.length > 0
        ? { vaults: [...(this.d.vault ? [{ network: this.d.primaryVaultNetwork ?? PRIMARY_VAULT_NETWORK, vault: vault.status, ...(vault.error ? { error: vault.error } : {}) }] : []), ...others] }
        : {}),
      monitor: { head, sinks },
      alerts: [],
    };
    snapshot.alerts = alertsOf(snapshot, Boolean(this.d.vault));
    return snapshot;
  }

  private process(): ResourceSnapshot["process"] {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const at = process.hrtime.bigint();
    const elapsedMicros = Number(at - this.lastCpuAt) / 1000;
    const usedMicros = cpu.user - this.lastCpu.user + (cpu.system - this.lastCpu.system);
    const cpuLoad = elapsedMicros > 0 ? round(usedMicros / elapsedMicros, 3) : null;
    this.lastCpu = cpu;
    this.lastCpuAt = at;
    // The histogram holds the time between two timer ticks: what exceeds the timer's own
    // period is the delay.
    const ms = (nanos: number) => round(Math.max((Number.isFinite(nanos) ? nanos : 0) / 1e6 - LOOP_RESOLUTION_MS, 0), 2);
    const delay = { mean: ms(this.loopDelay.mean), p99: ms(this.loopDelay.percentile(99)), max: ms(this.loopDelay.max) };
    this.loopDelay.reset();
    return {
      role: this.d.role,
      pid: process.pid,
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      cpuLoad,
      eventLoopDelayMs: delay,
    };
  }

  private database(): ResourceSnapshot["database"] {
    const size = (path: string) => {
      try {
        return statSync(path).size;
      } catch {
        return null;
      }
    };
    const byState = (table: string, column: string): Record<string, number> => {
      const rows = this.d.db.prepare(`SELECT ${column} AS state, COUNT(*) AS n FROM ${table} GROUP BY ${column}`).all() as Array<{ state: string; n: number }>;
      return Object.fromEntries(rows.map((r) => [r.state, Number(r.n)]));
    };
    const one = (sql: string) => Number((this.d.db.prepare(sql).get() as { n: number }).n);
    const inMemory = this.d.databasePath === ":memory:";
    return {
      path: this.d.databasePath,
      sizeBytes: inMemory ? null : size(this.d.databasePath),
      walBytes: inMemory ? null : size(`${this.d.databasePath}-wal`),
      crosschainPayments: byState("crosschain_payments", "state"),
      vaultDisbursements: byState("vault_disbursements", "state"),
      qrCodes: byState("qr_mock_codes", "status"),
      qrCallbacksPending: one("SELECT COUNT(*) AS n FROM qr_mock_payments WHERE callback_state = 'PENDING'"),
      monitorEvents: one("SELECT COUNT(*) AS n FROM monitor_events"),
    };
  }

  private async relayer(): Promise<ResourceSnapshot["relayer"]> {
    const up = await this.d.relayer.health();
    if (!up || !this.d.relayerAuthenticated) return { up, authenticated: false, relayers: [] };
    const relayers = await Promise.all(
      this.d.relayerIds.map(async (id): Promise<RelayerResource> => {
        try {
          const [info, balance] = await withTimeout(Promise.all([this.d.relayer.getRelayer(id), this.d.relayer.getBalance(id)]));
          const type = typeof info.network_type === "string" ? info.network_type : null;
          return {
            id,
            network: typeof info.network === "string" ? info.network : null,
            networkType: type,
            address: typeof info.address === "string" ? info.address : null,
            paused: typeof info.paused === "boolean" ? info.paused : null,
            systemDisabled: typeof info.system_disabled === "boolean" ? info.system_disabled : null,
            balance: nativeBalance(balance.balance, type),
            unit: nativeUnit(type),
          };
        } catch (e) {
          return { id, network: null, networkType: null, address: null, paused: null, systemDisabled: null, balance: null, unit: null, error: errText(e) };
        }
      }),
    );
    return { up, authenticated: true, relayers };
  }

  private async vault(): Promise<{ status: ResourceSnapshot["vault"]; error?: string }> {
    if (!this.d.vault) return { status: null };
    return readVault(this.d.vault, this.d.usdcDecimals);
  }

  private otherVaults(): Promise<VaultEntry[]> {
    return Promise.all(
      (this.d.otherVaults ?? []).map(async (v) => {
        const r = await readVault(v.service, v.usdcDecimals);
        return { network: v.network, vault: r.status, ...(r.error ? { error: r.error } : {}) };
      }),
    );
  }
}

async function readVault(service: VaultDisbursementService, decimals: number): Promise<{ status: VaultView | null; error?: string }> {
  try {
    const s = await withTimeout(service.status());
    const usdc = (atomic: bigint) => atomicToDecimal(atomic, decimals);
    return {
      status: {
        address: s.address,
        paused: s.paused,
        operatorIsRelayer: s.operatorIsRelayer,
        balance: usdc(s.balanceAtomic),
        pending: usdc(s.pendingAtomic),
        maxPerDisbursement: usdc(s.maxPerDisbursementAtomic),
        dailyLimit: usdc(s.dailyLimitAtomic),
        availableToday: usdc(s.availableTodayAtomic),
      },
    };
  } catch (e) {
    return { status: null, error: errText(e) };
  }
}

/** What is wrong in a snapshot. Codes are stable: the dashboard translates them. */
export function alertsOf(s: ResourceSnapshot, vaultConfigured: boolean): Array<Omit<MonitorAlert, "since">> {
  const alerts: Array<Omit<MonitorAlert, "since">> = [];
  const add = (code: string, severity: "warning" | "error", message: string) => alerts.push({ code, severity, message });

  if (!s.relayer.up) add("RELAYER_DOWN", "error", "El OpenZeppelin Relayer no responde: no se pueden enviar transacciones.");
  else if (!s.relayer.authenticated) add("RELAYER_UNAUTHENTICATED", "warning", "Falta RELAYER_API_KEY: TilcAI no puede usar el relayer.");
  for (const r of s.relayer.relayers) {
    if (r.error) add(`RELAYER_UNREADABLE:${r.id}`, "warning", `No se pudo leer el relayer ${r.id}: ${r.error}`);
    if (r.paused) add(`RELAYER_PAUSED:${r.id}`, "error", `El relayer ${r.id} está en pausa.`);
    if (r.systemDisabled) add(`RELAYER_DISABLED:${r.id}`, "error", `El relayer ${r.id} se deshabilitó a sí mismo.`);
    const low = r.networkType ? LOW_GAS[r.networkType] : undefined;
    if (r.balance !== null && low !== undefined && Number(r.balance) < low) {
      add(`RELAYER_LOW_GAS:${r.id}`, "warning", `Al relayer ${r.id} le quedan ${r.balance} ${r.unit ?? ""} para pagar gas.`);
    }
  }

  if (vaultConfigured && !s.vault) add("VAULT_UNREADABLE", "warning", `No se pudo leer el vault: ${s.vaultError ?? "sin respuesta"}`);
  if (s.vault) vaultAlerts(s.vault, "", "El vault", add);
  // Vaults of other networks: the same alerts, told apart by the network in the code.
  for (const e of s.vaults ?? []) {
    if (e.network === (s.primaryVaultNetwork ?? PRIMARY_VAULT_NETWORK)) continue;
    const suffix = `:${e.network}`;
    const name = `El vault de ${e.network}`;
    if (!e.vault) add(`VAULT_UNREADABLE${suffix}`, "warning", `No se pudo leer el ${name.replace(/^El /, "")}: ${e.error ?? "sin respuesta"}`);
    else vaultAlerts(e.vault, suffix, name, add);
  }

  for (const sink of s.monitor.sinks) {
    if (sink.attempts >= 3) add(`MONITOR_SINK_FAILING:${sink.name}`, "warning", `Los eventos no llegan a «${sink.name}» (${sink.lag} pendientes): ${sink.lastError ?? "sin detalle"}`);
  }
  if (s.database.crosschainPayments.UNCERTAIN) add("PAYMENTS_UNCERTAIN", "warning", `${s.database.crosschainPayments.UNCERTAIN} pago(s) crosschain en estado incierto.`);
  if (s.process.eventLoopDelayMs.p99 > 500) add("EVENT_LOOP_SLOW", "warning", `El proceso responde lento (p99 del event loop: ${s.process.eventLoopDelayMs.p99} ms).`);
  return alerts;
}

function vaultAlerts(v: VaultView, suffix: string, name: string, add: (code: string, severity: "warning" | "error", message: string) => void): void {
  const balance = Number(v.balance);
  const pending = Number(v.pending);
  const noun = name.replace(/^El /, ""); // "vault" · "vault de stellar:testnet"
  if (v.paused) add(`VAULT_PAUSED${suffix}`, "error", `${name} está en pausa: no paga desembolsos.`);
  if (!v.operatorIsRelayer) add(`VAULT_OPERATOR_MISMATCH${suffix}`, "error", `El operador del ${noun} no es la cuenta del relayer: los desembolsos revertirían.`);
  if (balance === 0) add(`VAULT_EMPTY${suffix}`, "error", `${name} ${v.address} no tiene USDC: ningún desembolso puede pagarse.`);
  else if (balance < pending) add(`VAULT_INSUFFICIENT${suffix}`, "error", `${name} tiene ${v.balance} USDC y debe ${v.pending} USDC en desembolsos en curso.`);
  else if (balance < Number(v.maxPerDisbursement)) add(`VAULT_LOW${suffix}`, "warning", `Al ${noun} le quedan ${v.balance} USDC, menos que su tope por desembolso (${v.maxPerDisbursement}).`);
  if (Number(v.availableToday) === 0) add(`VAULT_DAILY_LIMIT_REACHED${suffix}`, "warning", `${name} agotó su límite diario.`);
}

/**
 * The relayer reports the native balance in its smallest unit (wei, stroops) as a JSON number,
 * which loses precision past 2^53: six decimals are all that is worth showing.
 */
function nativeBalance(raw: number | string, networkType: string | null): string | null {
  const units = Number(raw);
  if (!Number.isFinite(units) || units < 0) return null;
  return (units / 10 ** (networkType === "stellar" ? 7 : 18)).toFixed(6).replace(/\.?0+$/, "") || "0";
}
const nativeUnit = (networkType: string | null) => (networkType === "stellar" ? "XLM" : networkType === "evm" ? "AVAX" : null);

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);
const withTimeout = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), EXTERNAL_TIMEOUT_MS).unref())]);
