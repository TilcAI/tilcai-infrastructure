import type { Hex } from "../../../shared/hex.ts";
import { RelayerHttpError, type RelayerClient } from "../../relayer/client.ts";
import { SubmissionRejected, type EvmSubmissionStatus, type EvmTxSubmitter } from "../ports.ts";

/**
 * Submits EVM calls through an OpenZeppelin EVM relayer. The relayer re-prices and may
 * replace a transaction, so its hash is only trusted once the relayer reports `confirmed`.
 */
export class RelayerEvmSubmitter implements EvmTxSubmitter {
  readonly name = "relayer";
  private account: Hex | null = null;
  constructor(private readonly client: RelayerClient, private readonly relayerId: string) {}

  /** The relayer's own address: the `msg.sender` of everything it submits. */
  async sender(): Promise<Hex> {
    if (!this.account) {
      const address = String((await this.client.getRelayer(this.relayerId)).address ?? "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`relayer ${this.relayerId} has no EVM address`);
      this.account = address as Hex;
    }
    return this.account;
  }

  async submit(to: Hex, data: Hex) {
    const tx = await this.client.sendEvmTransaction(this.relayerId, { to, data }).catch((e: unknown) => {
      if (e instanceof RelayerHttpError && e.status >= 400 && e.status < 500) throw new SubmissionRejected(`relayer ${e.status}: ${e.body}`);
      throw e;
    });
    return { submissionId: tx.id };
  }

  async status(submissionId: string): Promise<EvmSubmissionStatus> {
    const tx = await this.client.getTransaction(this.relayerId, submissionId);
    const s = tx.status.toLowerCase();
    if (s === "confirmed" && tx.hash) return { state: "confirmed", txHash: tx.hash as Hex };
    if (s === "failed" || s === "expired" || s === "canceled") return { state: "failed", reason: `${s}:${tx.status_reason ?? ""}`.slice(0, 200) };
    return { state: "pending" };
  }
}
