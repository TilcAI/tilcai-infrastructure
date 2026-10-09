import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  http,
  parseAbi,
  type Chain,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { EvmNetwork } from "../../../config/networks.ts";
import { sameHex, type Hex } from "../../../shared/hex.ts";
import type { Finality } from "../domain.ts";
import type { BurnInspection, DepositForBurnEvent, EvmCctpPort, RouterPaymentEvent, UnsignedEvmCall } from "../ports.ts";
import { ROUTER_ABI, USDC_3009_ABI } from "../router.ts";
import type { MintTarget } from "../cctp/encoding.ts";

export const TOKEN_MESSENGER_V2_ABI = parseAbi([
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
]);

export function viemChain(n: EvmNetwork): Chain {
  return defineChain({
    id: n.chainId,
    name: n.name,
    nativeCurrency: { name: n.nativeSymbol, symbol: n.nativeSymbol, decimals: 18 },
    rpcUrls: { default: { http: [n.rpc] } },
    blockExplorers: { default: { name: "explorer", url: n.explorer } },
  });
}

/**
 * CCTP V2 on an EVM source chain. Builds the exact approve + depositForBurnWithHook
 * calls for the payer's wallet; with a testnet dev key it can also send them.
 */
export class ViemEvmCctp implements EvmCctpPort {
  private readonly pub: PublicClient;
  private readonly chain: Chain;
  private readonly dev: PrivateKeyAccount | null;

  constructor(private readonly net: EvmNetwork, devPrivateKey?: string) {
    this.chain = viemChain(net);
    this.pub = createPublicClient({ chain: this.chain, transport: http(net.rpc, { retryCount: 3 }) }) as PublicClient;
    this.dev = devPrivateKey ? privateKeyToAccount((devPrivateKey.startsWith("0x") ? devPrivateKey : `0x${devPrivateKey}`) as Hex) : null;
  }

  routerAddress(): Hex | null {
    return this.net.cctpRouter ?? null;
  }

  routerV2Address(): Hex | null {
    return this.net.cctpRouterV2 ?? null;
  }

  async authorizationUsed(payer: Hex, nonce: Hex): Promise<boolean> {
    return this.pub.readContract({ address: this.net.usdc.address, abi: USDC_3009_ABI, functionName: "authorizationState", args: [payer, nonce] });
  }

  async devSignTypedData(typed: Record<string, unknown>): Promise<Hex> {
    if (!this.dev) throw new Error("dev signer not configured");
    return this.dev.signTypedData(typed as never);
  }

  devSignerAddress(): Hex | null {
    return this.dev?.address ?? null;
  }

  async buildBurnCalls(p: { payer: Hex; amount: bigint; maxFee: bigint; destinationDomain: number; target: MintTarget; finality: Finality }) {
    const { usdc, cctpV2 } = this.net;
    const [usdcBalance, allowance] = await Promise.all([
      this.pub.readContract({ address: usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [p.payer] }),
      this.pub.readContract({ address: usdc.address, abi: erc20Abi, functionName: "allowance", args: [p.payer, cctpV2.tokenMessenger] }),
    ]);
    const calls: UnsignedEvmCall[] = [];
    if (allowance < p.amount) {
      calls.push({
        chainId: this.net.chainId,
        to: usdc.address,
        // Exact amount, never an unlimited approval.
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [cctpV2.tokenMessenger, p.amount] }),
        value: "0",
        description: `USDC.approve(TokenMessengerV2, ${p.amount})`,
      });
    }
    calls.push({
      chainId: this.net.chainId,
      to: cctpV2.tokenMessenger,
      data: encodeFunctionData({
        abi: TOKEN_MESSENGER_V2_ABI,
        functionName: "depositForBurnWithHook",
        args: [p.amount, p.destinationDomain, p.target.mintRecipient, usdc.address, p.target.destinationCaller, p.maxFee, p.finality, p.target.hookData],
      }),
      value: "0",
      description: `TokenMessengerV2.depositForBurnWithHook → domain ${p.destinationDomain}`,
    });
    return { calls, usdcBalance, allowance };
  }

  async sendWithDevSigner(calls: UnsignedEvmCall[], onBurnHash: (hash: Hex) => void): Promise<Hex> {
    if (!this.dev) throw new Error("dev signer not configured");
    const wallet = createWalletClient({ chain: this.chain, account: this.dev, transport: http(this.net.rpc) });
    let burnHash: Hex | null = null;
    for (const c of calls) {
      const hash = await wallet.sendTransaction({ account: this.dev, chain: this.chain, to: c.to, data: c.data, value: 0n });
      const isBurn = sameHex(c.to, this.net.cctpV2.tokenMessenger);
      if (isBurn) {
        burnHash = hash;
        onBurnHash(hash);
      }
      const rcpt = await this.pub.waitForTransactionReceipt({ hash });
      if (rcpt.status !== "success" && !isBurn) throw new Error(`${c.description} reverted: ${hash}`);
    }
    if (!burnHash) throw new Error("no burn call in batch");
    return burnHash;
  }

  async inspectBurn(txHash: Hex): Promise<BurnInspection> {
    const rcpt = await this.pub.getTransactionReceipt({ hash: txHash }).catch((e: unknown) => {
      if (String(e).includes("could not be found") || String(e).includes("TransactionReceiptNotFound")) return null;
      throw e;
    });
    if (!rcpt) return { kind: "not_found" };
    if (rcpt.status !== "success") return { kind: "reverted", blockNumber: rcpt.blockNumber };
    const head = await this.pub.getBlockNumber();
    const burns: DepositForBurnEvent[] = [];
    const routerPayments: RouterPaymentEvent[] = [];
    for (const log of rcpt.logs) {
      // Both router versions emit the same CrosschainPayment event.
      if ([this.net.cctpRouter, this.net.cctpRouterV2].some((router) => router && sameHex(log.address, router))) {
        try {
          const ev = decodeEventLog({ abi: ROUTER_ABI, data: log.data, topics: log.topics });
          if (ev.eventName === "CrosschainPayment") routerPayments.push({ ...ev.args });
        } catch {
          // not a router payment log
        }
        continue;
      }
      if (!sameHex(log.address, this.net.cctpV2.tokenMessenger)) continue;
      try {
        const ev = decodeEventLog({ abi: TOKEN_MESSENGER_V2_ABI, data: log.data, topics: log.topics });
        if (ev.eventName !== "DepositForBurn") continue;
        const a = ev.args;
        burns.push({
          burnToken: a.burnToken,
          amount: a.amount,
          depositor: a.depositor,
          mintRecipient: a.mintRecipient,
          destinationDomain: a.destinationDomain,
          destinationTokenMessenger: a.destinationTokenMessenger,
          destinationCaller: a.destinationCaller,
          maxFee: a.maxFee,
          minFinalityThreshold: a.minFinalityThreshold,
          hookData: a.hookData,
        });
      } catch {
        // not a DepositForBurn log
      }
    }
    return { kind: "mined", blockNumber: rcpt.blockNumber, confirmations: head - rcpt.blockNumber + 1n, to: rcpt.to ?? null, burns, routerPayments };
  }
}
