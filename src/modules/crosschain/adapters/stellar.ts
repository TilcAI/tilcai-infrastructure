import {
  Account,
  Contract,
  Horizon,
  Keypair,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { StellarNetwork } from "../../../config/networks.ts";
import { hexToBytes, strip0x, type Hex } from "../../../shared/hex.ts";
import { RelayerHttpError, type RelayerClient } from "../../relayer/client.ts";
import { SubmissionRejected, type MintSubmitter, type StellarAccountStatus, type StellarCctpPort, type SubmissionStatus } from "../ports.ts";

/** Read-side of CCTP on Stellar: trustlines (Horizon), nonce usage and tx status (Soroban RPC). */
export class SorobanStellarCctp implements StellarCctpPort {
  private readonly rpc: rpc.Server;
  private readonly horizon: Horizon.Server;

  constructor(private readonly net: StellarNetwork, private readonly simulationSource?: string) {
    this.rpc = new rpc.Server(net.rpc);
    this.horizon = new Horizon.Server(net.horizon);
  }

  async accountStatus(account: string): Promise<StellarAccountStatus> {
    if (account.startsWith("C")) {
      // Contract accounts hold SAC balances without trustlines.
      return { exists: true, trustline: true, authorized: true, usdcBalanceAtomic: 0n };
    }
    try {
      const acc = await this.horizon.loadAccount(account);
      const line = acc.balances.find(
        (b: any) => b.asset_code === this.net.usdc.code && b.asset_issuer === this.net.usdc.issuer,
      ) as any;
      return {
        exists: true,
        trustline: Boolean(line),
        authorized: line ? line.is_authorized !== false : false,
        usdcBalanceAtomic: line ? BigInt(String(line.balance).replace(".", "")) : 0n,
      };
    } catch (e: any) {
      if (e?.response?.status === 404 || e?.name === "NotFoundError") {
        return { exists: false, trustline: false, authorized: false, usdcBalanceAtomic: 0n };
      }
      throw e;
    }
  }

  async isNonceUsed(nonce: Hex): Promise<boolean> {
    const out = await this.simulateRead(this.net.cctpV2.messageTransmitter, "is_nonce_used", [xdr.ScVal.scvBytes(hexToBytes(nonce))]);
    return out === true;
  }

  async transactionStatus(hash: string): Promise<"SUCCESS" | "FAILED" | "NOT_FOUND"> {
    const got = await this.rpc.getTransaction(strip0x(hash));
    if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) return "SUCCESS";
    if (got.status === rpc.Api.GetTransactionStatus.FAILED) return "FAILED";
    return "NOT_FOUND";
  }

  private async simulateRead(contractId: string, method: string, args: xdr.ScVal[]): Promise<unknown> {
    // Read-only calls are simulated, never submitted; the source only needs to be well formed.
    const source = new Account(this.simulationSource || Keypair.random().publicKey(), "0");
    const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: this.net.passphrase })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.rpc.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`simulate ${method}: ${sim.error.slice(0, 200)}`);
    if (!sim.result) throw new Error(`simulate ${method}: no result`);
    return scValToNative(sim.result.retval);
  }
}

/**
 * Submits `CctpForwarder.mint_and_forward(message, attestation)` through the
 * OpenZeppelin Relayer: the Relayer account is the tx source and pays XLM fees.
 * mint_and_forward requires no auth (the forwarder is the destinationCaller).
 */
export class RelayerMintSubmitter implements MintSubmitter {
  readonly name = "relayer";
  constructor(
    private readonly client: RelayerClient,
    private readonly relayerId: string,
    private readonly net: StellarNetwork,
  ) {}

  async submit(message: Hex, attestation: Hex) {
    const tx = await this.client.sendStellarTransaction(this.relayerId, {
      network: this.net.id.split(":")[1]!,
      operations: [
        {
          type: "invoke_contract",
          contract_address: this.net.cctpV2.cctpForwarder,
          function_name: "mint_and_forward",
          args: [{ bytes: strip0x(message) }, { bytes: strip0x(attestation) }],
          auth: { type: "none" },
        },
      ],
    }).catch((e: unknown) => {
      if (e instanceof RelayerHttpError && e.status >= 400 && e.status < 500) throw new SubmissionRejected(`relayer ${e.status}: ${e.body}`);
      throw e;
    });
    return { submissionId: tx.id, ...(tx.hash ? { txHash: tx.hash } : {}) };
  }

  async status(submissionId: string): Promise<SubmissionStatus> {
    const tx = await this.client.getTransaction(this.relayerId, submissionId);
    const s = tx.status.toLowerCase();
    if (s === "confirmed" && tx.hash) return { state: "confirmed", txHash: tx.hash };
    if (s === "failed" || s === "expired" || s === "canceled") {
      return { state: "failed", ...(tx.hash ? { txHash: tx.hash } : {}), reason: `${s}:${tx.status_reason ?? ""}`.slice(0, 200) };
    }
    return { state: "pending" };
  }
}

/** Fallback: an operator G… account signs and pays XLM fees itself (no relayer). */
export class LocalKeyMintSubmitter implements MintSubmitter {
  readonly name = "local";
  private readonly rpc: rpc.Server;
  private readonly kp: Keypair;

  constructor(private readonly net: StellarNetwork, secret: string) {
    this.rpc = new rpc.Server(net.rpc);
    this.kp = Keypair.fromSecret(secret);
  }

  async submit(message: Hex, attestation: Hex) {
    const account = await this.rpc.getAccount(this.kp.publicKey());
    const tx = new TransactionBuilder(account, { fee: "10000000", networkPassphrase: this.net.passphrase })
      .addOperation(
        new Contract(this.net.cctpV2.cctpForwarder).call(
          "mint_and_forward",
          xdr.ScVal.scvBytes(hexToBytes(message)),
          xdr.ScVal.scvBytes(hexToBytes(attestation)),
        ),
      )
      .setTimeout(120)
      .build();
    const sim = await this.rpc.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new SubmissionRejected(`simulate mint_and_forward: ${sim.error.slice(0, 200)}`);
    const prepared = rpc.assembleTransaction(tx, sim).build();
    prepared.sign(this.kp);
    const sent = await this.rpc.sendTransaction(prepared);
    if (sent.status === "ERROR") throw new SubmissionRejected("sendTransaction mint_and_forward rejected");
    return { submissionId: sent.hash, txHash: sent.hash };
  }

  async status(hash: string): Promise<SubmissionStatus> {
    const got = await this.rpc.getTransaction(hash);
    if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) return { state: "confirmed", txHash: hash };
    if (got.status === rpc.Api.GetTransactionStatus.FAILED) return { state: "failed", txHash: hash, reason: "tx failed on-chain" };
    return { state: "pending" };
  }
}
