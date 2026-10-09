import { encodeAbiParameters, encodeFunctionData, hashDomain, keccak256, parseAbi, toHex } from "viem";
import type { EvmNetwork } from "../../config/networks.ts";
import type { Hex } from "../../shared/hex.ts";
import type { MintTarget } from "./cctp/encoding.ts";
import type { Finality } from "./domain.ts";

/**
 * Gasless source leg. The payer signs an EIP-3009 ReceiveWithAuthorization whose
 * nonce commits to the whole CCTP route (see contracts/evm/src/TilcaiCctpRouter.sol),
 * so the relayer that submits it can neither redirect nor resize the payment.
 */
export const ROUTER_ABI = parseAbi([
  "struct Route { uint32 destinationDomain; bytes32 mintRecipient; bytes32 destinationCaller; uint256 maxFee; uint32 minFinalityThreshold; bytes hookData; }",
  "struct Authorization { uint256 validAfter; uint256 validBefore; uint8 v; bytes32 r; bytes32 s; }",
  "function payWithAuthorization(bytes32 paymentId, address payer, uint256 amount, Route route, Authorization auth)",
  "event CrosschainPayment(bytes32 indexed paymentId, address indexed payer, uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, bytes32 hookDataHash)",
]);

/** TilcaiCctpRouterV2: the same route, with the signature as `bytes` (an EOA's 65 bytes or a contract account's ERC-1271 signature). */
export const ROUTER_V2_ABI = parseAbi([
  "struct Route { uint32 destinationDomain; bytes32 mintRecipient; bytes32 destinationCaller; uint256 maxFee; uint32 minFinalityThreshold; bytes hookData; }",
  "struct Authorization { uint256 validAfter; uint256 validBefore; bytes signature; }",
  "function payWithAuthorization(bytes32 paymentId, address payer, uint256 amount, Route route, Authorization auth)",
  "event CrosschainPayment(bytes32 indexed paymentId, address indexed payer, uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, bytes32 hookDataHash)",
]);

export const USDC_3009_ABI = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);

/** bytes32 id of a TilcAI payment attempt, as seen by the router. */
export const paymentIdBytes32 = (paymentAttemptId: string): Hex => keccak256(toHex(paymentAttemptId));

export interface RouterRoute {
  destinationDomain: number;
  mintRecipient: Hex;
  destinationCaller: Hex;
  maxFee: bigint;
  minFinalityThreshold: Finality;
  hookData: Hex;
}

export const routeOf = (domain: number, target: MintTarget, maxFee: bigint, finality: Finality): RouterRoute => ({
  destinationDomain: domain,
  mintRecipient: target.mintRecipient,
  destinationCaller: target.destinationCaller,
  maxFee,
  minFinalityThreshold: finality,
  hookData: target.hookData,
});

/** Must equal `authorizationNonce` of the router that will pull the funds (abi.encode with a leading string tag per version). */
export function authorizationNonce(paymentId: Hex, amount: bigint, r: RouterRoute, version: 1 | 2 = 1): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32" },
        { type: "bytes32" }, { type: "uint256" }, { type: "uint32" }, { type: "bytes32" },
      ],
      [`tilcai-cctp-router-v${version}`, paymentId, amount, r.destinationDomain, r.mintRecipient, r.destinationCaller, r.maxFee, r.minFinalityThreshold, keccak256(r.hookData)],
    ),
  );
}

export interface SignedAuthorization {
  validAfter: bigint;
  validBefore: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

/** EIP-712 typed data the payer's wallet signs (eth_signTypedData_v4). */
export function authorizationTypedData(net: EvmNetwork, p: { payer: Hex; amount: bigint; nonce: Hex; validAfter: bigint; validBefore: bigint }) {
  return {
    domain: { name: net.usdc.eip712Name, version: net.usdc.eip712Version, chainId: net.chainId, verifyingContract: net.usdc.address },
    types: {
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization" as const,
    message: { from: p.payer, to: net.cctpRouter!, value: p.amount, validAfter: p.validAfter, validBefore: p.validBefore, nonce: p.nonce },
  };
}

export function encodeRouterCall(paymentId: Hex, payer: Hex, amount: bigint, route: RouterRoute, a: SignedAuthorization): Hex {
  return encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "payWithAuthorization",
    args: [paymentId, payer, amount, route, a],
  });
}

export function encodeRouterV2Call(paymentId: Hex, payer: Hex, amount: bigint, route: RouterRoute, a: { validAfter: bigint; validBefore: bigint; signature: Hex }): Hex {
  return encodeFunctionData({ abi: ROUTER_V2_ABI, functionName: "payWithAuthorization", args: [paymentId, payer, amount, route, a] });
}

/** EIP-712 type string of the message above, as ERC-7739 needs it spelled out. */
export const RECEIVE_AUTHORIZATION_TYPE =
  "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";

export { hashDomain };
