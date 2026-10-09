import { createPublicClient, encodeFunctionData, getAddress, http, parseAbi, type PublicClient } from "viem";
import type { EvmNetwork } from "../../../config/networks.ts";
import type { Hex } from "../../../shared/hex.ts";
import { viemChain } from "../../crosschain/adapters/evm.ts";
import type { EvmSubmissionStatus, EvmTxSubmitter } from "../../crosschain/ports.ts";
import type { Delegation, DelegationRule, OwnerCredential, OwnerSignRequest, SmartAccount, SmartAccountProvider } from "../ports.ts";
import { p256Point } from "./passkey.ts";

export const ACCOUNT_FACTORY_ABI = parseAbi([
  "function implementation() view returns (address)",
  "function getAddress(bytes32 qx, bytes32 qy, bytes32 salt) view returns (address)",
  "function createAccount(bytes32 qx, bytes32 qy, bytes32 salt) returns (address)",
  "event AccountCreated(address indexed account, bytes32 indexed salt, bytes32 qx, bytes32 qy)",
]);

export const ACCOUNT_ABI = parseAbi([
  "function signer() view returns (bytes32 qx, bytes32 qy)",
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
  "function entryPoint() view returns (address)",
]);

const ERC1271_MAGIC = "0x1626ba7e";

/** What the account service needs beyond issuing: the fate of a deployment it sent. */
export interface AccountDeployer extends SmartAccountProvider {
  /** Code the accounts run (the factory's implementation). */
  codeRef(): Promise<string>;
  deployStatus(submissionId: string): Promise<EvmSubmissionStatus>;
}

/**
 * TilcaiAccount on an EVM chain. The factory derives the address from the owner's key, so
 * TilcAI can promise an address before deploying and nobody can put another owner there.
 * The relayer pays the deployment; it is never a signer of the account.
 */
export class EvmSmartAccountProvider implements AccountDeployer {
  readonly network = "eip155:43113" as const;
  private readonly pub: PublicClient;
  private implementation: Hex | null = null;

  constructor(
    private readonly net: EvmNetwork,
    private readonly factory: Hex,
    private readonly submitter: EvmTxSubmitter | null,
  ) {
    this.pub = createPublicClient({ chain: viemChain(net), transport: http(net.rpc, { retryCount: 3 }) }) as PublicClient;
  }

  private point(owner: OwnerCredential) {
    if (owner.kind !== "webauthn-p256") throw new TypeError("EVM accounts are owned by a passkey (webauthn-p256)");
    return p256Point(owner.publicKey);
  }

  async codeRef(): Promise<string> {
    this.implementation ??= getAddress(await this.pub.readContract({ address: this.factory, abi: ACCOUNT_FACTORY_ABI, functionName: "implementation" }));
    return this.implementation;
  }

  async addressFor(owner: OwnerCredential, salt: Hex): Promise<string> {
    const { qx, qy } = this.point(owner);
    return getAddress(await this.pub.readContract({ address: this.factory, abi: ACCOUNT_FACTORY_ABI, functionName: "getAddress", args: [qx, qy, salt] }));
  }

  async deploy(owner: OwnerCredential, salt: Hex): Promise<{ address: string; submissionId: string }> {
    if (!this.submitter) throw new Error("no EVM relayer configured to pay the deployment");
    const { qx, qy } = this.point(owner);
    const address = await this.addressFor(owner, salt);
    const data = encodeFunctionData({ abi: ACCOUNT_FACTORY_ABI, functionName: "createAccount", args: [qx, qy, salt] });
    const { submissionId } = await this.submitter.submit(this.factory, data);
    return { address, submissionId };
  }

  async deployStatus(submissionId: string): Promise<EvmSubmissionStatus> {
    if (!this.submitter) throw new Error("no EVM relayer configured");
    return this.submitter.status(submissionId);
  }

  async isDeployed(address: string): Promise<boolean> {
    return ((await this.pub.getCode({ address: address as Hex })) ?? "0x") !== "0x";
  }

  /** ERC-1271 as the chain answers it. An account without code, or one that reverts, signs nothing. */
  async isValidSignature(account: Hex, hash: Hex, signature: Hex): Promise<boolean> {
    try {
      const magic = await this.pub.readContract({ address: account, abi: ACCOUNT_ABI, functionName: "isValidSignature", args: [hash, signature] });
      return magic === ERC1271_MAGIC;
    } catch {
      return false;
    }
  }

  // Delegated agent keys are the next milestone of the SCA phase (M4): the account already takes
  // ERC-4337 operations, but TilcAI does not issue session rules yet.
  async prepareDelegation(_account: SmartAccount, _rule: DelegationRule): Promise<OwnerSignRequest> {
    throw new Error("delegations are not available on EVM accounts yet");
  }
  async prepareRevocation(_account: SmartAccount, _delegation: Delegation): Promise<OwnerSignRequest> {
    throw new Error("delegations are not available on EVM accounts yet");
  }
  async submitOwnerSigned(_account: SmartAccount, _request: OwnerSignRequest, _signature: string): Promise<{ submissionId: string }> {
    throw new Error("delegations are not available on EVM accounts yet");
  }
}
