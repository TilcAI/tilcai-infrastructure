import { Keypair } from "@stellar/stellar-sdk";
import { decodeFunctionData, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadEnv } from "../../src/config/env.ts";
import { networks } from "../../src/config/networks.ts";
import { openDatabase } from "../../src/db/sqlite.ts";
import { silentLogger } from "../../src/shared/log.ts";
import { bytesToHex, hexToBytes, type Hex } from "../../src/shared/hex.ts";
import { evmToBytes32, type MintTarget } from "../../src/modules/crosschain/cctp/encoding.ts";
import type { IrisLookup, IrisPort } from "../../src/modules/crosschain/cctp/iris.ts";
import type { Finality } from "../../src/modules/crosschain/domain.ts";
import type {
  BurnInspection,
  DepositForBurnEvent,
  EvmCctpPort,
  EvmSubmissionStatus,
  EvmTxSubmitter,
  MintSubmitter,
  StellarAccountStatus,
  StellarCctpPort,
  SubmissionStatus,
  UnsignedEvmCall,
} from "../../src/modules/crosschain/ports.ts";
import { SubmissionRejected } from "../../src/modules/crosschain/ports.ts";
import { ROUTER_ABI, ROUTER_V2_ABI } from "../../src/modules/crosschain/router.ts";
import { SqliteCrosschainRepository } from "../../src/modules/crosschain/repository.ts";
import { CrosschainPaymentService } from "../../src/modules/crosschain/service.ts";
import type { NewMonitorEvent } from "../../src/modules/monitor/domain.ts";

export const nets = networks(loadEnv({}));
export const PAYER: Hex = "0x1111111111111111111111111111111111111111";
export const ROUTER: Hex = "0x297ce6a2787484db4bB18A96a8F28A9881Fc163C";
export const ROUTER_V2: Hex = "0x2222222222222222222222222222222222222222";
export const SIGNER = privateKeyToAccount(`0x${"ab".repeat(32)}`);
export const OTHER_SIGNER = privateKeyToAccount(`0x${"cd".repeat(32)}`);
export const MERCHANT = Keypair.random().publicKey();

export class FakeClock {
  t = Date.parse("2026-10-02T12:00:00.000Z");
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

/** Builds a CCTP V2 message byte-for-byte (header 148 + BurnMessageV2). */
export function encodeMessageV2(f: {
  sourceDomain: number;
  destinationDomain: number;
  nonce: Hex;
  destinationCaller: Hex;
  burnToken: Hex;
  mintRecipient: Hex;
  amount: bigint;
  messageSender: Hex;
  maxFee: bigint;
  feeExecuted: bigint;
  hookData: Hex;
}): Hex {
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const u256 = (n: bigint) => hexToBytes(n.toString(16).padStart(64, "0"));
  const tm = hexToBytes(evmToBytes32(nets.avalancheFuji.cctpV2.tokenMessenger));
  return bytesToHex(
    Buffer.concat([
      u32(1), u32(f.sourceDomain), u32(f.destinationDomain), hexToBytes(f.nonce), tm, tm, hexToBytes(f.destinationCaller),
      u32(2000), u32(2000),
      u32(1), hexToBytes(evmToBytes32(f.burnToken)), hexToBytes(f.mintRecipient), u256(f.amount), hexToBytes(evmToBytes32(f.messageSender)),
      u256(f.maxFee), u256(f.feeExecuted), u256(123n), hexToBytes(f.hookData),
    ]),
  );
}

export class FakeEvm implements EvmCctpPort {
  dev: Hex | null = PAYER;
  balance = 10_000_000n;
  burns = new Map<string, BurnInspection>();
  routerAddr: Hex | null = ROUTER;
  routerV2Addr: Hex | null = null;
  routerV2Address() {
    return this.routerV2Addr;
  }
  authUsed = new Set<string>();
  signer = SIGNER;
  routerAddress() {
    return this.routerAddr;
  }
  async authorizationUsed(_payer: Hex, nonce: Hex) {
    return this.authUsed.has(nonce.toLowerCase());
  }
  async devSignTypedData(typed: Record<string, unknown>) {
    return this.signer.signTypedData(typed as never);
  }
  lastBurn: { amount: bigint; maxFee: bigint; target: MintTarget; finality: Finality } | null = null;
  counter = 0;

  devSignerAddress() {
    return this.dev;
  }
  async buildBurnCalls(p: { payer: Hex; amount: bigint; maxFee: bigint; destinationDomain: number; target: MintTarget; finality: Finality }) {
    this.lastBurn = p;
    const calls: UnsignedEvmCall[] = [
      { chainId: 43113, to: nets.avalancheFuji.usdc.address, data: "0x01", value: "0", description: "approve" },
      { chainId: 43113, to: nets.avalancheFuji.cctpV2.tokenMessenger, data: "0x02", value: "0", description: "burn" },
    ];
    return { calls, usdcBalance: this.balance, allowance: 0n };
  }
  async sendWithDevSigner(_calls: UnsignedEvmCall[], onBurnHash: (h: Hex) => void) {
    const hash = `0x${(++this.counter).toString(16).padStart(64, "a")}` as Hex;
    onBurnHash(hash);
    this.burns.set(hash, this.minedBurn(this.depositEvent()));
    return hash;
  }
  depositEvent(over: Partial<DepositForBurnEvent> = {}): DepositForBurnEvent {
    const b = this.lastBurn!;
    return {
      burnToken: nets.avalancheFuji.usdc.address,
      amount: b.amount,
      depositor: PAYER,
      mintRecipient: b.target.mintRecipient,
      destinationDomain: 27,
      destinationTokenMessenger: `0x${"00".repeat(32)}`,
      destinationCaller: b.target.destinationCaller,
      maxFee: b.maxFee,
      minFinalityThreshold: b.finality,
      hookData: b.target.hookData,
      ...over,
    };
  }
  minedBurn(ev: DepositForBurnEvent): BurnInspection {
    return { kind: "mined", blockNumber: 100n, confirmations: 3n, to: nets.avalancheFuji.cctpV2.tokenMessenger, burns: [ev], routerPayments: [] };
  }
  async inspectBurn(h: Hex): Promise<BurnInspection> {
    return this.burns.get(h.toLowerCase()) ?? this.burns.get(h) ?? { kind: "not_found" };
  }
}

/** Relayer EVM: decodes payWithAuthorization and "mines" the matching router burn. */
export class FakeEvmSubmitter implements EvmTxSubmitter {
  readonly name = "relayer";
  submits: Array<{ to: Hex; data: Hex }> = [];
  statuses = new Map<string, EvmSubmissionStatus>();
  failNextSubmit: false | "ambiguous" | "rejected" = false;
  autoConfirm = true;
  constructor(private readonly evm: FakeEvm) {}
  async submit(to: Hex, data: Hex) {
    if (this.failNextSubmit) {
      const k = this.failNextSubmit;
      this.failNextSubmit = false;
      throw k === "rejected" ? new SubmissionRejected("relayer 400") : new Error("relayer timeout");
    }
    this.submits.push({ to, data });
    const id = `evm-${this.submits.length}`;
    if (this.autoConfirm) this.land(id, data);
    else this.statuses.set(id, { state: "pending" });
    return { submissionId: id };
  }
  /** Mines the call: registers the burn inspection under a fresh hash. */
  land(id: string, data: Hex, over: { payer?: Hex } = {}) {
    const to = this.submits.at(-1)?.to ?? ROUTER;
    const router = to.toLowerCase() === ROUTER_V2.toLowerCase() ? ROUTER_V2 : ROUTER;
    const { args } = decodeFunctionData({ abi: router === ROUTER_V2 ? ROUTER_V2_ABI : ROUTER_ABI, data });
    const [paymentId, payer, amount, route] = args as unknown as [Hex, Hex, bigint, any, any];
    const hash = `0x${(0x1000 + this.submits.length).toString(16).padStart(64, "f")}` as Hex;
    this.evm.burns.set(hash, {
      kind: "mined",
      blockNumber: 200n,
      confirmations: 3n,
      to: router,
      burns: [
        {
          burnToken: nets.avalancheFuji.usdc.address,
          amount,
          depositor: router,
          mintRecipient: route.mintRecipient,
          destinationDomain: route.destinationDomain,
          destinationTokenMessenger: `0x${"00".repeat(32)}`,
          destinationCaller: route.destinationCaller,
          maxFee: route.maxFee,
          minFinalityThreshold: route.minFinalityThreshold,
          hookData: route.hookData,
        },
      ],
      routerPayments: [
        { paymentId, payer: over.payer ?? payer, amount, destinationDomain: route.destinationDomain, mintRecipient: route.mintRecipient, hookDataHash: keccak256(route.hookData) },
      ],
    });
    this.statuses.set(id, { state: "confirmed", txHash: hash });
    return hash;
  }
  async status(id: string) {
    return this.statuses.get(id) ?? { state: "pending" as const };
  }
}

export class FakeIris implements IrisPort {
  messages = new Map<string, IrisLookup>();
  async lookup(_d: number, tx: string): Promise<IrisLookup> {
    return this.messages.get(tx.toLowerCase()) ?? { kind: "pending", status: "pending_confirmations" };
  }
  async feeBpsHundredths() {
    return 0n;
  }
}

export class FakeStellar implements StellarCctpPort {
  accounts = new Map<string, StellarAccountStatus>();
  usedNonces = new Set<string>();
  txs = new Map<string, "SUCCESS" | "FAILED">();
  async accountStatus(a: string) {
    return this.accounts.get(a) ?? { exists: true, trustline: true, authorized: true, usdcBalanceAtomic: 0n };
  }
  async isNonceUsed(n: Hex) {
    return this.usedNonces.has(n.toLowerCase());
  }
  async transactionStatus(h: string) {
    return this.txs.get(h) ?? "NOT_FOUND";
  }
}

export class FakeSubmitter implements MintSubmitter {
  readonly name = "relayer";
  submits: Array<{ message: Hex; attestation: Hex }> = [];
  failNextSubmit: false | "ambiguous" | "rejected" = false;
  statuses = new Map<string, SubmissionStatus>();
  /** When true, a submit lands immediately on "chain". */
  autoConfirm = true;
  constructor(private readonly stellar: FakeStellar, private readonly nonceOf: (m: Hex) => Hex) {}
  async submit(message: Hex, attestation: Hex) {
    if (this.failNextSubmit) {
      const kind = this.failNextSubmit;
      this.failNextSubmit = false;
      throw kind === "rejected" ? new SubmissionRejected("relayer 400") : new Error("relayer timeout");
    }
    this.submits.push({ message, attestation });
    const id = `tx-${this.submits.length}`;
    if (this.autoConfirm) {
      const hash = `${"b".repeat(63)}${this.submits.length}`;
      this.stellar.txs.set(hash, "SUCCESS");
      this.stellar.usedNonces.add(this.nonceOf(message).toLowerCase());
      this.statuses.set(id, { state: "confirmed", txHash: hash });
    } else {
      this.statuses.set(id, { state: "pending" });
    }
    return { submissionId: id };
  }
  async status(id: string) {
    return this.statuses.get(id) ?? { state: "pending" as const };
  }
}

export function harness() {
  const clock = new FakeClock();
  const db = openDatabase(":memory:");
  const repo = new SqliteCrosschainRepository(db);
  const evm = new FakeEvm();
  const iris = new FakeIris();
  const stellar = new FakeStellar();
  const submitter = new FakeSubmitter(stellar, (m) => bytesToHex(hexToBytes(m).subarray(12, 44)));
  const evmSubmitter = new FakeEvmSubmitter(evm);
  /** Smart accounts as the payment rail sees them: who is an active account of whom, and which signatures the "chain" accepts. */
  const accountPayers = { active: new Map<string, string>(), valid: new Set<string>(), checked: [] as Array<{ account: Hex; hash: Hex; signature: Hex }> };
  /** What the service announced for the dashboard, in order. */
  const events: NewMonitorEvent[] = [];
  const svc = new CrosschainPaymentService({
    repo,
    evm,
    evmSubmitter,
    accounts: {
      isActiveAccount: async (tenantId, address) => accountPayers.active.get(address.toLowerCase()) === tenantId,
      isValidSignature: async (account, hash, signature) => {
        accountPayers.checked.push({ account, hash, signature });
        return accountPayers.valid.has(signature.toLowerCase());
      },
    },
    stellar,
    iris,
    submitters: { relayer: submitter },
    activeSubmitter: "relayer",
    source: { ...nets.avalancheFuji, cctpRouter: ROUTER },
    destination: nets.stellarTestnet,
    clock,
    log: silentLogger,
    events: { emit: (e) => void events.push(e) },
    options: { quoteTtlSeconds: 600, pollMs: 1000, minConfirmations: 1 },
  });
  /** Makes Iris return a correct attestation for a burn tx. */
  const attest = (txHash: string, nonce: Hex, over: Partial<Parameters<typeof encodeMessageV2>[0]> = {}, gasless: boolean | "v2" = false) => {
    const b = evm.lastBurn!;
    const message = encodeMessageV2({
      sourceDomain: 1,
      destinationDomain: 27,
      nonce,
      destinationCaller: b.target.destinationCaller,
      burnToken: nets.avalancheFuji.usdc.address,
      mintRecipient: b.target.mintRecipient,
      amount: b.amount,
      messageSender: gasless === "v2" ? ROUTER_V2 : gasless ? ROUTER : PAYER,
      maxFee: b.maxFee,
      feeExecuted: 0n,
      hookData: b.target.hookData,
      ...over,
    });
    iris.messages.set(txHash.toLowerCase(), {
      kind: "complete",
      message: { message, attestation: `0x${"cd".repeat(65)}`, eventNonce: nonce, cctpVersion: 2, status: "complete" },
    });
    return message;
  };
  /** Drives the worker until the payment stops moving (bounded). */
  const drive = async (id: string, steps = 12) => {
    for (let i = 0; i < steps; i++) {
      const p = svc.mustGet(id);
      if (p.state === "SETTLED" || p.state === "FAILED") return p;
      clock.advance(Math.max(0, Date.parse(p.nextCheckAt) - clock.t) + 1);
      await svc.step(svc.mustGet(id));
    }
    return svc.mustGet(id);
  };
  return { clock, db, repo, evm, evmSubmitter, accountPayers, iris, stellar, submitter, svc, attest, drive, events };
}
