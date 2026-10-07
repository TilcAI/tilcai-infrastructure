import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  parseAbi,
  toHex,
  type PublicClient,
} from "viem";
import type { EvmNetwork } from "../../../config/networks.ts";
import { sameHex, type Hex } from "../../../shared/hex.ts";
import { viemChain } from "../../crosschain/adapters/evm.ts";
import type { DisbursedEvent, DisbursementInspection, VaultPort, VaultStatus } from "../ports.ts";

export const VAULT_ABI = parseAbi([
  "constructor(address usdc_, address owner_, address operator_, uint256 maxPerDisbursement_, uint256 dailyLimit_)",
  "function disburse(bytes32 disbursementId, address to, uint256 amount)",
  "function disbursedAmount(bytes32 disbursementId) view returns (uint256)",
  "function availableToday() view returns (uint256)",
  "function maxPerDisbursement() view returns (uint256)",
  "function dailyLimit() view returns (uint256)",
  "function operator() view returns (address)",
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function usdc() view returns (address)",
  "function withdraw(address token, address to, uint256 amount)",
  "event Disbursed(bytes32 indexed disbursementId, address indexed to, uint256 amount)",
  "error NotOperator(address caller)",
  "error ZeroAddress()",
  "error ZeroAmount()",
  "error InvalidRecipient(address to)",
  "error AlreadyDisbursed(bytes32 disbursementId)",
  "error AboveDisbursementLimit(uint256 amount, uint256 limit)",
  "error AboveDailyLimit(uint256 amount, uint256 available)",
  "error InsufficientBalance(uint256 amount, uint256 balance)",
  "error EnforcedPause()",
  "error OwnableUnauthorizedAccount(address account)",
]);

/** bytes32 id of a TilcAI disbursement, as the vault records it. */
export const disbursementIdBytes32 = (disbursementId: string): Hex => keccak256(toHex(disbursementId));

/** Public RPCs cap eth_getLogs ranges (2048 blocks on Avalanche's). */
const LOG_WINDOW = 2000n;
const MAX_LOG_WINDOWS = 12;

/** Reads of a deployed TilcaiVault (viem). */
export class ViemVault implements VaultPort {
  private readonly pub: PublicClient;

  constructor(private readonly net: EvmNetwork, private readonly vault: Hex) {
    this.pub = createPublicClient({ chain: viemChain(net), transport: http(net.rpc, { retryCount: 3 }) }) as PublicClient;
  }

  address(): Hex {
    return this.vault;
  }

  blockNumber(): Promise<bigint> {
    return this.pub.getBlockNumber();
  }

  async status(): Promise<VaultStatus> {
    const read = <T>(functionName: "owner" | "operator" | "paused" | "maxPerDisbursement" | "dailyLimit" | "availableToday") =>
      this.pub.readContract({ address: this.vault, abi: VAULT_ABI, functionName }) as Promise<T>;
    const [owner, operator, paused, maxPerDisbursementAtomic, dailyLimitAtomic, availableTodayAtomic, balanceAtomic] = await Promise.all([
      read<Hex>("owner"),
      read<Hex>("operator"),
      read<boolean>("paused"),
      read<bigint>("maxPerDisbursement"),
      read<bigint>("dailyLimit"),
      read<bigint>("availableToday"),
      this.pub.readContract({ address: this.net.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [this.vault] }),
    ]);
    return { address: this.vault, owner, operator, paused, balanceAtomic, maxPerDisbursementAtomic, dailyLimitAtomic, availableTodayAtomic };
  }

  paidAmount(id32: Hex): Promise<bigint> {
    return this.pub.readContract({ address: this.vault, abi: VAULT_ABI, functionName: "disbursedAmount", args: [id32] });
  }

  encodeDisburse(id32: Hex, to: Hex, amount: bigint): Hex {
    return encodeFunctionData({ abi: VAULT_ABI, functionName: "disburse", args: [id32, to, amount] });
  }

  async simulate(sender: Hex, id32: Hex, to: Hex, amount: bigint): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.pub.simulateContract({ address: this.vault, abi: VAULT_ABI, functionName: "disburse", args: [id32, to, amount], account: sender });
      return { ok: true };
    } catch (e) {
      const reverted = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
      if (reverted instanceof ContractFunctionRevertedError) {
        return { ok: false, reason: (reverted.data?.errorName ?? reverted.reason ?? reverted.shortMessage).slice(0, 120) };
      }
      // Not a revert (RPC down, timeout): nothing was proven, let the caller retry.
      throw e;
    }
  }

  async inspect(txHash: Hex): Promise<DisbursementInspection> {
    const rcpt = await this.pub.getTransactionReceipt({ hash: txHash }).catch((e: unknown) => {
      if (String(e).includes("could not be found") || String(e).includes("TransactionReceiptNotFound")) return null;
      throw e;
    });
    if (!rcpt) return { kind: "not_found" };
    if (rcpt.status !== "success") return { kind: "reverted", blockNumber: rcpt.blockNumber };
    const head = await this.pub.getBlockNumber();
    const disbursed: DisbursedEvent[] = [];
    for (const log of rcpt.logs) {
      if (!sameHex(log.address, this.vault)) continue;
      try {
        const ev = decodeEventLog({ abi: VAULT_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === "Disbursed") disbursed.push({ ...ev.args });
      } catch {
        // another event of the vault
      }
    }
    return { kind: "mined", blockNumber: rcpt.blockNumber, confirmations: head - rcpt.blockNumber + 1n, disbursed };
  }

  async findDisbursed(id32: Hex, fromBlock: bigint): Promise<{ txHash: Hex; blockNumber: bigint; to: Hex; amount: bigint } | null> {
    const head = await this.pub.getBlockNumber();
    let from = fromBlock;
    for (let i = 0; i < MAX_LOG_WINDOWS && from <= head; i++) {
      const to = from + LOG_WINDOW - 1n < head ? from + LOG_WINDOW - 1n : head;
      const logs = await this.pub.getContractEvents({
        address: this.vault,
        abi: VAULT_ABI,
        eventName: "Disbursed",
        args: { disbursementId: id32 },
        fromBlock: from,
        toBlock: to,
      });
      const log = logs[0];
      if (log?.args.to && log.args.amount !== undefined) {
        return { txHash: log.transactionHash, blockNumber: log.blockNumber, to: log.args.to, amount: log.args.amount };
      }
      from = to + 1n;
    }
    return null;
  }
}
