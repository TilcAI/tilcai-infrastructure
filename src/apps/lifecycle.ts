import type { AppContext } from "../app-context.ts";

/** Leaves in the event log that this process came up, and with what switched on. */
export function announceStart(ctx: AppContext): void {
  ctx.monitor.emit({
    type: "system.started",
    subject: ctx.role,
    summary: `TilcAI (${ctx.role}) en marcha`,
    data: {
      role: ctx.role,
      pid: process.pid,
      node: process.version,
      env: ctx.env.TILCAI_ENV,
      networks: [ctx.nets.avalanche.id, ctx.nets.stellar.id],
      vault: ctx.nets.avalanche.vault ?? null,
      vaultStellar: ctx.nets.stellar.vault ?? null,
      accountFactoryStellar: ctx.nets.stellar.accountFactory ?? null,
      cctpRouter: ctx.nets.avalanche.cctpRouter ?? null,
      qrMock: Boolean(ctx.qrMock),
      monitorPush: Boolean(ctx.forwarder),
      relayerWebhookSigned: Boolean(ctx.runtime.relayerWebhookSigningKey),
    },
  });
}

export function announceStop(ctx: AppContext, signal: string): void {
  ctx.monitor.emit({ type: "system.stopping", subject: ctx.role, summary: `TilcAI (${ctx.role}) se detiene (${signal})`, data: { role: ctx.role, pid: process.pid, signal } });
}
