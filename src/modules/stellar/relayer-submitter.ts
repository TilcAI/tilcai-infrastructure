import type { StellarNetwork } from "../../config/networks.ts";
import { strip0x } from "../../shared/hex.ts";
import { SubmissionRejected } from "../crosschain/ports.ts";
import { RelayerHttpError, type InvokeContractOp, type RelayerClient, type ScValJson } from "../relayer/client.ts";

export type StellarSubmissionStatus = { state: "pending" } | { state: "confirmed"; txHash: string } | { state: "failed"; reason: string };

export const i128 = (n: bigint): ScValJson => ({ i128: { hi: (n >> 64n).toString(), lo: (n & ((1n << 64n) - 1n)).toString() } });
export const bytesArg = (hex: string): ScValJson => ({ bytes: strip0x(hex).toLowerCase() });

/** What the Stellar adapters need from whoever sends their transactions. */
export interface StellarInvoker {
  readonly name: string;
  sender(): Promise<string>;
  invoke(contract: string, fn: string, args: ScValJson[], auth?: "none" | "source_account"): Promise<{ submissionId: string }>;
  status(submissionId: string): Promise<StellarSubmissionStatus>;
}

/**
 * Sends one contract call through the OpenZeppelin Relayer's Stellar account, which is the
 * source of the transaction and pays the fee. Used to deploy accounts and to disburse from the vault.
 */
export class RelayerStellarSubmitter implements StellarInvoker {
  readonly name = "relayer";
  private account: string | null = null;

  constructor(private readonly client: RelayerClient, private readonly relayerId: string, private readonly net: StellarNetwork) {}

  /** The relayer's G… account: the source of every call, and the vault's operator. */
  async sender(): Promise<string> {
    if (!this.account) {
      const address = String((await this.client.getRelayer(this.relayerId)).address ?? "");
      if (!/^G[A-Z2-7]{55}$/.test(address)) throw new Error(`relayer ${this.relayerId} has no Stellar address`);
      this.account = address;
    }
    return this.account;
  }

  /** `auth: "source_account"` when the contract asks the source (the relayer) to authorize. */
  async invoke(contract: string, fn: string, args: ScValJson[], auth: "none" | "source_account" = "none"): Promise<{ submissionId: string }> {
    const op: InvokeContractOp = { type: "invoke_contract", contract_address: contract, function_name: fn, args, auth: { type: auth } };
    const tx = await this.client.sendStellarTransaction(this.relayerId, { network: this.net.id.split(":")[1]!, operations: [op] }).catch((e: unknown) => {
      if (e instanceof RelayerHttpError && e.status >= 400 && e.status < 500) throw new SubmissionRejected(`relayer ${e.status}: ${e.body}`);
      throw e;
    });
    return { submissionId: tx.id };
  }

  async status(submissionId: string): Promise<StellarSubmissionStatus> {
    const tx = await this.client.getTransaction(this.relayerId, submissionId);
    const s = tx.status.toLowerCase();
    if (s === "confirmed" && tx.hash) return { state: "confirmed", txHash: tx.hash };
    if (s === "failed" || s === "expired" || s === "canceled") return { state: "failed", reason: `${s}:${tx.status_reason ?? ""}`.slice(0, 200) };
    return { state: "pending" };
  }
}
