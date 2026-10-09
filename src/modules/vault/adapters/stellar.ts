import { Address, StrKey, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "../../../config/networks.ts";
import { hexToBytes, bytesToHex, type Hex } from "../../../shared/hex.ts";
import { SimulationError, SorobanReader, type SorobanView } from "../../stellar/soroban.ts";
import { bytesArg, i128, type StellarInvoker } from "../../stellar/relayer-submitter.ts";
import type { DisbursedEvent, DisbursementInspection, VaultPort, VaultStatus, VaultSubmissionStatus, VaultSubmitter } from "../ports.ts";

/**
 * `VaultError` of contracts/soroban/vault, by code. The names are the EVM vault's, so the
 * service and the dashboard speak of one set of reasons whatever the network.
 */
const VAULT_ERRORS: Record<number, string> = {
  1: "ZeroAmount",
  2: "InvalidRecipient",
  3: "AlreadyDisbursed",
  4: "AboveDisbursementLimit",
  5: "AboveDailyLimit",
  6: "InsufficientBalance",
  7: "EnforcedPause",
  8: "InvalidLimits",
  9: "NoPendingOwner",
};

/**
 * Errors of the USDC Stellar Asset Contract that a payout can hit. They are raised by the token,
 * not by the vault, and say why a recipient cannot be paid.
 */
const TOKEN_ERRORS: Record<number, string> = {
  10: "TokenBalanceInsufficient",
  11: "RecipientDeauthorized",
  13: "RecipientHasNoTrustline",
};

const addressArg = (a: string) => new Address(a).toScVal();
const i128Arg = (n: bigint) => xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: n >> 64n, lo: n & ((1n << 64n) - 1n) }));
const idArg = (id32: Hex) => xdr.ScVal.scvBytes(hexToBytes(id32));

/** Window of ledgers searched for a Disbursed event (the node keeps about a week). */
const EVENT_LEDGER_WINDOW = 100_000;

/** Reads of a deployed Soroban `tilcai_vault`. Never signs: payouts go out through the submitter. */
export class SorobanVault implements VaultPort {
  private readonly reader: SorobanView;

  constructor(private readonly net: StellarNetwork, private readonly vault: string, simulationSource?: string, reader?: SorobanView) {
    this.reader = reader ?? new SorobanReader(net, simulationSource);
  }

  address(): string {
    return this.vault;
  }

  async blockNumber(): Promise<bigint> {
    return BigInt(await this.reader.latestLedger());
  }

  async status(): Promise<VaultStatus> {
    const read = <T>(method: string) => this.reader.read(this.vault, method) as Promise<T>;
    const [owner, operator, paused, maxPerDisbursementAtomic, dailyLimitAtomic, availableTodayAtomic, balanceAtomic] = await Promise.all([
      read<string>("owner"),
      read<string>("operator"),
      read<boolean>("paused"),
      read<bigint>("max_per_disbursement"),
      read<bigint>("daily_limit"),
      read<bigint>("available_today"),
      this.reader.read(this.net.usdc.sac, "balance", [addressArg(this.vault)]) as Promise<bigint>,
    ]);
    return { address: this.vault, owner, operator, paused, balanceAtomic, maxPerDisbursementAtomic, dailyLimitAtomic, availableTodayAtomic };
  }

  async paidAmount(id32: Hex): Promise<bigint> {
    return (await this.reader.read(this.vault, "disbursed_amount", [idArg(id32)])) as bigint;
  }

  /** The submitter of this network takes the call as JSON. */
  encodeDisburse(id32: Hex, to: string, amount: bigint): string {
    return JSON.stringify({ id: id32, to, amount: amount.toString() });
  }

  /** A G… account or a C… contract. A muxed address (M…) is not an account that can hold a trustline. */
  parseRecipient(to: string): string {
    const ok = StrKey.isValidEd25519PublicKey(to) || StrKey.isValidContract(to);
    if (!ok) throw new TypeError("to must be a Stellar account (G…) or contract (C…) address other than the vault");
    if (to === this.vault) throw new TypeError("to must be a Stellar account (G…) or contract (C…) address other than the vault");
    return to;
  }

  async simulate(sender: string, id32: Hex, to: string, amount: bigint): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const call = await this.reader.simulate(this.vault, "disburse", [idArg(id32), addressArg(to), i128Arg(amount)], sender);
      // The simulation records the authorizations the call needs. The relayer's transaction only
      // satisfies the source account's: anyone else's would be missing, so the call would fail.
      if (call.auth.some((a) => a.kind === "address")) return { ok: false, reason: "NotOperator" };
      return { ok: true };
    } catch (e) {
      if (!(e instanceof SimulationError)) throw e;
      const name = this.vaultErrorName(e);
      if (name) return { ok: false, reason: name };
      const token = e.contractErrorCode === null ? undefined : TOKEN_ERRORS[e.contractErrorCode];
      if (token) return { ok: false, reason: token };
      // A refusal that is not the vault's (a recipient without a trustline, a frozen asset…): it is
      // the host's answer, not a transport failure, so it is reported and the payout is retried later.
      if (/trustline|not authorized|underfunded|Error\((Contract|Auth|Value|Budget)/i.test(e.detail)) return { ok: false, reason: e.detail.split("\n")[0]!.slice(0, 120) };
      throw e; // RPC down, malformed answer: nothing was proven
    }
  }

  /** Code of an error raised by the vault itself, not by a contract it called (the USDC contract has its own codes). */
  private vaultErrorName(e: SimulationError): string | null {
    const code = e.contractErrorCode;
    if (code === null || !(code in VAULT_ERRORS)) return null;
    // The failing frame is the vault's when the diagnostic names it; without the log, trust the code.
    const frames = [...e.detail.matchAll(/contract call failed[^\n]*|contract:([A-Z0-9]{56})/g)];
    const named = frames.map((m) => m[1]).filter(Boolean);
    if (named.length > 0 && !named.includes(this.vault)) return null;
    return VAULT_ERRORS[code]!;
  }

  async inspect(txHash: string): Promise<DisbursementInspection> {
    const got = await this.reader.getTransaction(txHash);
    if (got.status === rpc.Api.GetTransactionStatus.NOT_FOUND) return { kind: "not_found" };
    if (got.status === rpc.Api.GetTransactionStatus.FAILED) return { kind: "reverted", blockNumber: BigInt(got.ledger) };
    const head = BigInt(await this.reader.latestLedger());
    const disbursed: DisbursedEvent[] = [];
    for (const event of got.events.contractEventsXdr.flat()) {
      const parsed = this.parseDisbursed(event);
      if (parsed) disbursed.push(parsed);
    }
    return { kind: "mined", blockNumber: BigInt(got.ledger), confirmations: head - BigInt(got.ledger) + 1n, disbursed };
  }

  async findDisbursed(id32: Hex, fromBlock: bigint): Promise<{ txHash: string | null; blockNumber: bigint | null; to: string; amount: bigint } | null> {
    const payout = (await this.reader.read(this.vault, "payout", [idArg(id32)])) as { to: string; amount: bigint } | null | undefined;
    if (!payout) return null;
    // The vault's record says who was paid and how much. The transaction comes from the event,
    // which the node only keeps for a while: without it the payout is still proven.
    try {
      const head = await this.reader.latestLedger();
      const start = Math.max(Number(fromBlock), head - EVENT_LEDGER_WINDOW);
      const res = await this.reader.getEvents({
        startLedger: start,
        filters: [
          {
            type: "contract",
            contractIds: [this.vault],
            topics: [[xdr.ScVal.scvSymbol("disbursed").toXDR("base64"), idArg(id32).toXDR("base64")]],
          },
        ],
        limit: 5,
      });
      const hit = res.events[0];
      if (hit) return { txHash: hit.txHash, blockNumber: BigInt(hit.ledger), to: payout.to, amount: payout.amount };
    } catch {
      // out of the retained range, or the node does not answer: fall through to the record
    }
    return { txHash: null, blockNumber: null, to: payout.to, amount: payout.amount };
  }

  private parseDisbursed(event: xdr.ContractEvent): DisbursedEvent | null {
    try {
      if (event.contractId === null || event.contractId === undefined) return null;
      if (Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(event.contractId)).toString() !== this.vault) return null;
      const body = event.body.v0;
      const [name, id] = body.topics.map((t) => scValToNative(t));
      if (name !== "disbursed" || !(id instanceof Uint8Array)) return null;
      const data = scValToNative(body.data) as { to: string; amount: bigint };
      return { disbursementId: bytesToHex(id), to: data.to, amount: BigInt(data.amount) };
    } catch {
      return null;
    }
  }
}

/** Sends `disburse` from the relayer's Stellar account, which must be the vault's operator. */
export class StellarVaultSubmitter implements VaultSubmitter {
  readonly name = "relayer";
  constructor(private readonly submitter: StellarInvoker) {}

  sender(): Promise<string> {
    return this.submitter.sender();
  }

  async submit(vault: string, call: string) {
    const { id, to, amount } = JSON.parse(call) as { id: Hex; to: string; amount: string };
    // The vault asks its operator to authorize; the relayer's account is the transaction source.
    return this.submitter.invoke(vault, "disburse", [bytesArg(id), { address: to }, i128(BigInt(amount))], "source_account");
  }

  status(submissionId: string): Promise<VaultSubmissionStatus> {
    return this.submitter.status(submissionId);
  }
}

