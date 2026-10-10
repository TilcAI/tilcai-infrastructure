import { xdr } from "@stellar/stellar-sdk";
import type { StellarNetwork, StellarNetworkId } from "../../../config/networks.ts";
import { hexToBytes, type Hex } from "../../../shared/hex.ts";
import { SorobanReader, type SorobanView } from "../../stellar/soroban.ts";
import { bytesArg, type StellarInvoker, type StellarSubmissionStatus } from "../../stellar/relayer-submitter.ts";
import type { AccountDeployer, Delegation, DelegationRule, OwnerCredential, OwnerSignRequest, SmartAccount } from "../ports.ts";

const NOT_YET = "delegations are not available on Stellar accounts yet (SCA phase M3)";

/** What the factory is asked, by kind of owner key. */
type FactoryCall = { create: "create_ed25519" | "create_webauthn"; address: "address_ed25519" | "address_webauthn"; key: Hex };

/**
 * `tilcai_account` on Stellar, issued through `tilcai_account_factory`. The factory derives the
 * address from the owner's key, so TilcAI can promise an address before deploying and nobody can
 * put another owner there. The relayer pays the deployment; it is never a signer of the account.
 *
 * Owners: an Ed25519 key (a Stellar keypair) or a passkey (P-256 point, checked by the
 * WebAuthn verifier on-chain). Both are registered as `External(verifier, key)` signers.
 */
export class StellarSmartAccountProvider implements AccountDeployer {
  readonly network: StellarNetworkId;
  private readonly reader: SorobanView;
  private wasmHash: string | null = null;

  constructor(
    net: StellarNetwork,
    private readonly factory: string,
    private readonly submitter: StellarInvoker | null,
    simulationSource?: string,
    reader?: SorobanView,
  ) {
    this.network = net.id;
    this.reader = reader ?? new SorobanReader(net, simulationSource);
  }

  private call(owner: OwnerCredential): FactoryCall {
    if (owner.kind === "ed25519") {
      if (!/^0x[0-9a-fA-F]{64}$/.test(owner.publicKey)) throw new TypeError("owner.publicKey must be a 32-byte Ed25519 key");
      return { create: "create_ed25519", address: "address_ed25519", key: owner.publicKey };
    }
    if (owner.kind === "webauthn-p256") {
      // The verifier takes the uncompressed point; the credential id stays in TilcAI's record.
      if (!/^0x04[0-9a-fA-F]{128}$/.test(owner.publicKey)) throw new TypeError("owner.publicKey must be a 65-byte uncompressed P-256 point (0x04…)");
      return { create: "create_webauthn", address: "address_webauthn", key: owner.publicKey };
    }
    throw new TypeError("Stellar accounts are owned by an Ed25519 key or a passkey");
  }

  async codeRef(): Promise<string> {
    this.wasmHash ??= Buffer.from(await this.reader.read(this.factory, "account_wasm_hash") as Uint8Array).toString("hex");
    return this.wasmHash;
  }

  async addressFor(owner: OwnerCredential, salt: Hex): Promise<string> {
    const c = this.call(owner);
    const out = await this.reader.read(this.factory, c.address, [xdr.ScVal.scvBytes(hexToBytes(c.key)), xdr.ScVal.scvBytes(hexToBytes(salt))]);
    return String(out);
  }

  async deploy(owner: OwnerCredential, salt: Hex): Promise<{ address: string; submissionId: string }> {
    if (!this.submitter) throw new Error("no Stellar relayer configured to pay the deployment");
    const c = this.call(owner);
    const address = await this.addressFor(owner, salt);
    const { submissionId } = await this.submitter.invoke(this.factory, c.create, [bytesArg(c.key), bytesArg(salt)]);
    return { address, submissionId };
  }

  async deployStatus(submissionId: string): Promise<StellarSubmissionStatus> {
    if (!this.submitter) throw new Error("no Stellar relayer configured");
    return this.submitter.status(submissionId);
  }

  isDeployed(address: string): Promise<boolean> {
    return this.reader.contractExists(address);
  }

  /** The signers of the account's `owner` rule as the chain holds them (verification of a deployment). */
  async ownerRuleSigners(address: string): Promise<unknown> {
    const rule = (await this.reader.read(address, "get_context_rule", [xdr.ScVal.scvU32(0)])) as { signers: unknown };
    return rule.signers;
  }

  async prepareDelegation(_account: SmartAccount, _rule: DelegationRule): Promise<OwnerSignRequest> {
    throw new Error(NOT_YET);
  }
  async prepareRevocation(_account: SmartAccount, _delegation: Delegation): Promise<OwnerSignRequest> {
    throw new Error(NOT_YET);
  }
  async submitOwnerSigned(_account: SmartAccount, _request: OwnerSignRequest, _signature: string): Promise<{ submissionId: string }> {
    throw new Error(NOT_YET);
  }
}
