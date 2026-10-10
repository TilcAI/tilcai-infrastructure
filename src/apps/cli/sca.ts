/**
 * Smart accounts of the SCA phase from the command line (Avalanche Fuji).
 *
 *   npm run sca -- status      # factory, implementation and router v2 on-chain
 *   npm run sca -- deploy      # deploys TilcaiAccountFactory and TilcaiCctpRouterV2
 *   npm run sca -- verify      # issues a throwaway account and makes it pay with a passkey signature
 *
 * `deploy` and `verify` sign with DEV_EVM_PAYER_PRIVATE_KEY and pay their gas in AVAX.
 * `deploy` reads the compiled contracts: run `forge build` in contracts/evm first.
 * `verify` creates a software P-256 key, deploys its account through the factory, funds it with
 * 0.01 USDC from the developer key and moves them back with `transferWithAuthorization` signed
 * by the "passkey" (ERC-1271 + ERC-7739): the same path a tenant's user takes.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, domainSeparator, erc20Abi, hashStruct, hashTypedData, http, parseAbi, toHex, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadEnv } from "../../config/env.ts";
import { networks } from "../../config/networks.ts";
import type { Hex } from "../../shared/hex.ts";
import { challengeBase64Url, encodeWebAuthnSignature, typedDataChallenge, wrapTypedDataSignature } from "../../modules/accounts/evm/passkey.ts";
import { ACCOUNT_ABI, ACCOUNT_FACTORY_ABI } from "../../modules/accounts/evm/provider.ts";
import { viemChain } from "../../modules/crosschain/adapters/evm.ts";

const env = loadEnv();
if (env.TILCAI_ENV === "mainnet") throw new Error("SCA deployment CLI is disabled on mainnet in phase 1");
const net = networks(env).avalancheFuji;
const chain = viemChain(net);
const pub = createPublicClient({ chain, transport: http(net.rpc, { retryCount: 3 }) });
const hasCode = async (address: Hex) => ((await pub.getCode({ address })) ?? "0x") !== "0x";
const link = (kind: "address" | "tx", value: string) => `${net.explorer}/${kind}/${value}`;

const USDC_BYTES_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
]);
const TRANSFER_TYPE = "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";

function signer() {
  const key = env.DEV_EVM_PAYER_PRIVATE_KEY;
  if (!key) throw new Error("DEV_EVM_PAYER_PRIVATE_KEY is not set");
  const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
  return { account, wallet: createWalletClient({ chain, account, transport: http(net.rpc) }) };
}

function artifact(name: string): { abi: Abi; bytecode: { object: Hex } } {
  try {
    return JSON.parse(readFileSync(new URL(`../../../contracts/evm/out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
  } catch {
    throw new Error("Compiled contracts not found: run `forge build` in contracts/evm");
  }
}

async function mined(hash: Hex, what: string) {
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${what} reverted: ${link("tx", hash)}`);
  return receipt;
}

async function status() {
  console.log(`${net.name} (${net.id})`);
  const factory = net.accountFactory;
  if (!factory) console.log("  ACCOUNT_FACTORY_FUJI   not set");
  else if (!(await hasCode(factory))) console.log(`  ACCOUNT_FACTORY_FUJI   ${factory}  NO CODE`);
  else {
    const implementation = await pub.readContract({ address: factory, abi: ACCOUNT_FACTORY_ABI, functionName: "implementation" });
    const entryPoint = await pub.readContract({ address: implementation, abi: ACCOUNT_ABI, functionName: "entryPoint" });
    console.log(`  factory                ${factory}`);
    console.log(`  implementation         ${implementation}`);
    console.log(`  EntryPoint             ${entryPoint}${entryPoint.toLowerCase() === net.erc4337.entryPoint.toLowerCase() ? `  (v${net.erc4337.version})` : "  UNEXPECTED"}`);
  }
  const router = net.cctpRouterV2;
  console.log(`  router v2              ${router ? `${router}${(await hasCode(router)) ? "" : "  NO CODE"}` : "CCTP_ROUTER_V2_FUJI not set"}`);
  console.log(`  P-256 precompile       ${net.p256Precompile}`);
}

const command = process.argv[2];
if (command === "status") {
  await status();
} else if (command === "deploy") {
  const { account, wallet } = signer();
  console.log(`Deploying on ${net.name} from ${account.address}`);
  const factoryArtifact = artifact("TilcaiAccountFactory");
  const factoryTx = await wallet.deployContract({ abi: factoryArtifact.abi, bytecode: factoryArtifact.bytecode.object, args: [] });
  const factory = (await mined(factoryTx, "factory deployment")).contractAddress!;
  console.log(`  TilcaiAccountFactory  ${factory}  ${link("tx", factoryTx)}`);
  const routerArtifact = artifact("TilcaiCctpRouterV2");
  const routerTx = await wallet.deployContract({ abi: routerArtifact.abi, bytecode: routerArtifact.bytecode.object, args: [net.usdc.address, net.cctpV2.tokenMessenger] });
  const router = (await mined(routerTx, "router deployment")).contractAddress!;
  console.log(`  TilcaiCctpRouterV2    ${router}  ${link("tx", routerTx)}`);
  console.log(`\nSet ACCOUNT_FACTORY_FUJI=${factory}\n    CCTP_ROUTER_V2_FUJI=${router}`);
} else if (command === "verify") {
  const factory = net.accountFactory;
  if (!factory) throw new Error("ACCOUNT_FACTORY_FUJI is not set");
  const { account: dev, wallet } = signer();

  // The "passkey": a P-256 key that signs WebAuthn assertions, as an authenticator would.
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const qx = toHex(Buffer.from(jwk.x!, "base64url"), { size: 32 });
  const qy = toHex(Buffer.from(jwk.y!, "base64url"), { size: 32 });
  const assertion = (challenge: Hex) => {
    const authenticatorData = Buffer.concat([createHash("sha256").update("tilcai.test").digest(), Buffer.from([0x05, 0, 0, 0, 1])]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: challengeBase64Url(challenge), origin: "https://tilcai.test", crossOrigin: false }));
    const signature = createSign("sha256").update(Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()])).sign(privateKey);
    return encodeWebAuthnSignature({ authenticatorData, clientDataJSON, signature });
  };

  const salt = toHex(randomBytes(32));
  const address = await pub.readContract({ address: factory, abi: ACCOUNT_FACTORY_ABI, functionName: "getAddress", args: [qx, qy, salt] });
  console.log(`Account ${address} (address known before deploying)`);
  const createTx = await wallet.writeContract({ address: factory, abi: ACCOUNT_FACTORY_ABI, functionName: "createAccount", args: [qx, qy, salt] });
  const created = await mined(createTx, "createAccount");
  if (!(await hasCode(address))) throw new Error("the account has no code at the predicted address");
  console.log(`  deployed   gas ${created.gasUsed}  ${link("tx", createTx)}`);

  const amount = 10_000n; // 0.01 USDC
  await mined(await wallet.writeContract({ address: net.usdc.address, abi: erc20Abi, functionName: "transfer", args: [address, amount] }), "funding");
  console.log("  funded     0.01 USDC");

  const nonce = toHex(randomBytes(32));
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
  const typedData = {
    domain: { name: net.usdc.eip712Name, version: net.usdc.eip712Version, chainId: net.chainId, verifyingContract: net.usdc.address },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization" as const,
    message: { from: address, to: dev.address, value: amount, validAfter: 0n, validBefore, nonce },
  };
  const contents = {
    appDomainSeparator: domainSeparator({ domain: typedData.domain }),
    contentsType: TRANSFER_TYPE,
    contentsHash: hashStruct({ data: typedData.message, primaryType: typedData.primaryType, types: typedData.types }),
  };
  const signature = wrapTypedDataSignature(assertion(typedDataChallenge(address, net.chainId, contents)), contents);
  const digest = hashTypedData(typedData);
  const valid = (sig: Hex, hash: Hex = digest) =>
    pub.readContract({ address, abi: ACCOUNT_ABI, functionName: "isValidSignature", args: [hash, sig] }).then((magic) => magic === "0x1626ba7e", () => false);
  if (!(await valid(signature))) throw new Error("the account refused its owner's signature");
  if (await valid(signature, hashTypedData({ ...typedData, message: { ...typedData.message, value: amount + 1n } }))) throw new Error("the signature covers another amount");
  if (await valid(wrapTypedDataSignature(assertion(digest), contents))) throw new Error("a signature that does not name the account was accepted");
  console.log("  ERC-1271   owner's passkey signature accepted; other amount and bare digest refused");

  const before = await pub.readContract({ address: net.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [address] });
  const payTx = await wallet.writeContract({
    address: net.usdc.address,
    abi: USDC_BYTES_ABI,
    functionName: "transferWithAuthorization",
    args: [address, dev.address, amount, 0n, validBefore, nonce, signature],
  });
  const paid = await mined(payTx, "transferWithAuthorization");
  const after = await pub.readContract({ address: net.usdc.address, abi: erc20Abi, functionName: "balanceOf", args: [address] });
  if (before - after !== amount) throw new Error(`balance moved by ${before - after}, expected ${amount}`);
  console.log(`  paid       0.01 USDC back with the passkey signature  gas ${paid.gasUsed}  ${link("tx", payTx)}`);
  console.log("OK");
} else {
  console.error("usage: npm run sca -- status | deploy | verify");
  process.exit(64);
}
