import { Account, Address, Contract, Keypair, TransactionBuilder, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "../../config/networks.ts";

/** What a simulated call returns: its value and the authorization it would need. */
export interface SimulatedCall {
  value: unknown;
  /** Credentials of the authorization entries the call recorded, as the node reports them. */
  auth: Array<{ kind: "source_account" } | { kind: "address"; address: string }>;
}

/** What the Stellar adapters read from the network; tests stand in for it. */
export type SorobanView = Pick<SorobanReader, "simulate" | "read" | "contractExists" | "latestLedger" | "getTransaction" | "getEvents">;

/** Read-side access to Soroban contracts: simulation (never submitted) and ledger entries. */
export class SorobanReader {
  readonly rpc: rpc.Server;

  constructor(private readonly net: StellarNetwork, private readonly simulationSource?: string) {
    this.rpc = new rpc.Server(net.rpc);
  }

  /**
   * Simulates `method` of `contract`. `source` only needs to be a well-formed account: it is
   * who the call would run as, which matters when the contract calls `require_auth` on it.
   * Throws `SimulationError` when the contract (or the host) refuses.
   */
  async simulate(contractId: string, method: string, args: xdr.ScVal[], source?: string): Promise<SimulatedCall> {
    const account = new Account(source || this.simulationSource || Keypair.random().publicKey(), "0");
    const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: this.net.passphrase })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.rpc.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new SimulationError(method, sim.error);
    if (!sim.result) throw new SimulationError(method, "no result");
    return {
      value: scValToNative(sim.result.retval),
      auth: sim.result.auth.map((entry) => {
        const c = entry.credentials;
        if (c.type === "sorobanCredentialsSourceAccount") return { kind: "source_account" as const };
        if (c.type === "sorobanCredentialsAddressWithDelegates") return { kind: "address" as const, address: Address.fromScAddress(c.addressWithDelegates.addressCredentials.address).toString() };
        const credentials = c.type === "sorobanCredentialsAddress" ? c.address : c.addressV2;
        return { kind: "address" as const, address: Address.fromScAddress(credentials.address).toString() };
      }),
    };
  }

  async read(contractId: string, method: string, args: xdr.ScVal[] = []): Promise<unknown> {
    return (await this.simulate(contractId, method, args)).value;
  }

  /** True when the contract instance is live on the ledger (deployed and not archived). */
  async contractExists(contractId: string): Promise<boolean> {
    try {
      await this.rpc.getContractData(contractId, xdr.ScVal.scvLedgerKeyContractInstance(), rpc.Durability.Persistent);
      return true;
    } catch (e) {
      // The RPC answers "Contract data not found" (a 404) for an address without an instance.
      if (/not found|404/i.test(e instanceof Error ? e.message : String(e)) || (e as { code?: number }).code === 404) return false;
      throw e;
    }
  }

  async latestLedger(): Promise<number> {
    return (await this.rpc.getLatestLedger()).sequence;
  }

  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    return this.rpc.getTransaction(hash);
  }

  getEvents(request: rpc.Api.GetEventsRequest): Promise<rpc.Api.GetEventsResponse> {
    return this.rpc.getEvents(request);
  }
}

export class SimulationError extends Error {
  constructor(readonly method: string, readonly detail: string) {
    super(`simulate ${method}: ${detail.slice(0, 300)}`);
  }

  /** `N` of `Error(Contract, #N)`: the code the contract panicked with, if it was one of its own. */
  get contractErrorCode(): number | null {
    const m = /Error\(Contract, #(\d+)\)/.exec(this.detail);
    return m ? Number(m[1]) : null;
  }
}
