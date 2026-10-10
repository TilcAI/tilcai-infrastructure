import { test } from "node:test";
import assert from "node:assert/strict";
import { activeConfig, loadEnv } from "../../src/config/env.ts";
import { networks } from "../../src/config/networks.ts";

const EVM_ROUTER = `0x${"11".repeat(20)}`;
const EVM_ROUTER_V2 = `0x${"22".repeat(20)}`;
const EVM_FACTORY = `0x${"33".repeat(20)}`;
const EVM_VAULT = `0x${"44".repeat(20)}`;
const EVM_ENTRYPOINT = `0x${"55".repeat(20)}`;
const STELLAR_FACTORY = "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL";
const STELLAR_VAULT = "CACMENFFJPJMSDAJQLX4R7K3SFZIW2LJSE3R2UMLGSWHFHS353FVXAZV";
const STELLAR_ACCOUNT = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const mainnetSource = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  TILCAI_ENV: "mainnet",
  TILCAI_API_KEYS: "testnet-api-key",
  TILCAI_API_KEYS_MAINNET: "mainnet-api-key",
  DATABASE_PATH: "./data/testnet.db",
  DATABASE_PATH_MAINNET: "./data/mainnet.db",
  RELAYER_URL: "http://testnet-relayer:8080",
  RELAYER_URL_MAINNET: "http://mainnet-relayer:8080",
  RELAYER_API_KEY: "testnet-relayer-key",
  RELAYER_API_KEY_MAINNET: "mainnet-relayer-key",
  RELAYER_AVALANCHE_MAINNET_ID: "avalanche-mainnet-relayer",
  RELAYER_STELLAR_MAINNET_ID: "stellar-mainnet-relayer",
  RELAYER_X402_PLUGIN_ID_MAINNET: "x402-mainnet",
  RELAYER_WEBHOOK_SIGNING_KEY_MAINNET: "mainnet-webhook-signing-key",
  CCTP_ROUTER_AVALANCHE_MAINNET: EVM_ROUTER,
  CCTP_ROUTER_V2_AVALANCHE_MAINNET: EVM_ROUTER_V2,
  ACCOUNT_FACTORY_AVALANCHE_MAINNET: EVM_FACTORY,
  VAULT_AVALANCHE_MAINNET: EVM_VAULT,
  ERC4337_ENTRYPOINT_AVALANCHE_MAINNET: EVM_ENTRYPOINT,
  ACCOUNT_FACTORY_STELLAR_MAINNET: STELLAR_FACTORY,
  VAULT_STELLAR_MAINNET: STELLAR_VAULT,
  STELLAR_SIMULATION_SOURCE_MAINNET: STELLAR_ACCOUNT,
  RPC_AVALANCHE_MAINNET: "https://api.avax.network/ext/bc/C/rpc",
  RPC_STELLAR_MAINNET: "https://soroban-rpc.mainnet.stellar.gateway.fm",
  HORIZON_STELLAR_MAINNET: "https://horizon.stellar.lobstr.co",
  ...over,
});

test("testnet remains the default active route", () => {
  const env = loadEnv({});
  const nets = networks(env);
  assert.equal(env.TILCAI_ENV, "testnet");
  assert.equal(nets.avalanche.id, "eip155:43113");
  assert.equal(nets.stellar.id, "stellar:testnet");
  assert.equal(activeConfig(env).transactionsEnabled, true);
});

test("mainnet selects only Avalanche C-Chain and Stellar Pubnet", () => {
  const env = loadEnv(mainnetSource());
  const nets = networks(env);
  const active = activeConfig(env);
  assert.equal(nets.avalanche.id, "eip155:43114");
  assert.equal(nets.avalanche.chainId, 43114);
  assert.equal(nets.stellar.id, "stellar:pubnet");
  assert.equal(nets.stellar.passphrase, "Public Global Stellar Network ; September 2015");
  assert.equal(nets.avalanche.usdc.address, "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E");
  assert.equal(nets.stellar.usdc.issuer, "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
  assert.notEqual(nets.avalanche.usdc.address, nets.avalancheFuji.usdc.address, "mainnet never reuses Fuji USDC");
  assert.notEqual(nets.avalanche.cctpV2.tokenMessenger, nets.avalancheFuji.cctpV2.tokenMessenger, "mainnet never reuses the test CCTP messenger");
  assert.notEqual(nets.stellar.usdc.sac, nets.stellarTestnet.usdc.sac, "mainnet never reuses the test Stellar SAC");
  assert.notEqual(nets.stellar.cctpV2.cctpForwarder, nets.stellarTestnet.cctpV2.cctpForwarder, "mainnet never reuses the test forwarder");
  assert.equal(active.irisApiUrl, "https://iris-api.circle.com");
  assert.equal(active.transactionsEnabled, false, "phase 1 is read-only by default");
  assert.notEqual(active.databasePath, env.DATABASE_PATH);
  assert.notEqual(active.relayerApiKey, env.RELAYER_API_KEY);
});

test("mainnet transactions need a second explicit opt-in", () => {
  const env = loadEnv(mainnetSource({ MAINNET_TRANSACTIONS_ENABLED: "true" }));
  assert.equal(activeConfig(env).transactionsEnabled, true);
});

test("incomplete mainnet configuration fails closed", () => {
  assert.throws(() => loadEnv({ TILCAI_ENV: "mainnet" }), /Invalid configuration/);
});

test("mainnet rejects test endpoints, reused credentials and development signers", () => {
  assert.throws(() => loadEnv(mainnetSource({ RPC_AVALANCHE_MAINNET: "https://api.avax-test.network/ext/bc/C/rpc" })), /RPC_AVALANCHE_MAINNET/);
  assert.throws(() => loadEnv(mainnetSource({ RELAYER_AVALANCHE_MAINNET_ID: "avalanche-fuji-relayer" })), /RELAYER_AVALANCHE_MAINNET_ID/);
  assert.throws(() => loadEnv(mainnetSource({ RELAYER_STELLAR_MAINNET_ID: "stellar-example" })), /RELAYER_STELLAR_MAINNET_ID/);
  assert.throws(() => loadEnv(mainnetSource({ RELAYER_STELLAR_MAINNET_ID: "avalanche-mainnet-relayer" })), /RELAYER_STELLAR_MAINNET_ID/);
  assert.throws(() => loadEnv(mainnetSource({ DATABASE_PATH_MAINNET: "./data/testnet.db" })), /DATABASE_PATH_MAINNET/);
  assert.throws(() => loadEnv(mainnetSource({ STELLAR_OPERATOR_SECRET: "local-signing" })), /STELLAR_OPERATOR_SECRET/);
  assert.throws(() => loadEnv(mainnetSource({ TILCAI_API_KEYS_MAINNET: "testnet-api-key" })), /TILCAI_API_KEYS_MAINNET/);
  assert.throws(() => loadEnv(mainnetSource({ RELAYER_WEBHOOK_SIGNING_KEY: "mainnet-webhook-signing-key" })), /RELAYER_WEBHOOK_SIGNING_KEY_MAINNET/);
  assert.throws(() => loadEnv(mainnetSource({ CCTP_ROUTER_FUJI: EVM_ROUTER })), /CCTP_ROUTER_AVALANCHE_MAINNET/);
  assert.throws(() => loadEnv(mainnetSource({ DEV_EVM_PAYER_PRIVATE_KEY: "development-only" })), /DEV_EVM_PAYER_PRIVATE_KEY/);
  assert.throws(() => loadEnv(mainnetSource({ QR_MOCK_ENABLED: "true", QR_MOCK_EMAIL: "mock@example.invalid", QR_MOCK_PASSWORD: "not-a-secret" })), /QR_MOCK_ENABLED/);
});

/** Only what the crosschain route needs: the gasless router and a relayer per chain. */
const minimalMainnet = (over: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const source = mainnetSource(over);
  for (const name of [
    "CCTP_ROUTER_V2_AVALANCHE_MAINNET", "ACCOUNT_FACTORY_AVALANCHE_MAINNET", "VAULT_AVALANCHE_MAINNET", "ERC4337_ENTRYPOINT_AVALANCHE_MAINNET",
    "ACCOUNT_FACTORY_STELLAR_MAINNET", "VAULT_STELLAR_MAINNET", "RELAYER_X402_PLUGIN_ID_MAINNET", "RELAYER_WEBHOOK_SIGNING_KEY_MAINNET",
  ]) if (!(name in over)) delete source[name];
  return source;
};

test("mainnet starts with the router alone: accounts, vaults, x402 and webhooks are features that stay off", () => {
  const env = loadEnv(minimalMainnet({ MAINNET_TRANSACTIONS_ENABLED: "true" }));
  const nets = networks(env);
  assert.equal(nets.avalanche.cctpRouter, EVM_ROUTER);
  assert.equal(nets.avalanche.cctpRouterV2, undefined);
  assert.equal(nets.avalanche.accountFactory, undefined);
  assert.equal(nets.avalanche.vault, undefined);
  assert.equal(nets.stellar.accountFactory, undefined);
  assert.equal(nets.stellar.vault, undefined);
  assert.equal(activeConfig(env).x402PluginId, "");
  assert.equal(activeConfig(env).transactionsEnabled, true);

  assert.throws(() => loadEnv(minimalMainnet({ CCTP_ROUTER_AVALANCHE_MAINNET: "" })), /CCTP_ROUTER_AVALANCHE_MAINNET/, "the router is not optional");
  assert.throws(() => loadEnv(minimalMainnet({ ACCOUNT_FACTORY_AVALANCHE_MAINNET: EVM_FACTORY })), /ERC4337_ENTRYPOINT_AVALANCHE_MAINNET/, "accounts need a verified EntryPoint");
  assert.throws(() => loadEnv(minimalMainnet({ CCTP_ROUTER_V2_AVALANCHE_MAINNET: EVM_ROUTER_V2 })), /ACCOUNT_FACTORY_AVALANCHE_MAINNET/, "router v2 is only for smart accounts");
  assert.throws(() => loadEnv(minimalMainnet({ VAULT_AVALANCHE_MAINNET: EVM_ROUTER })), /CCTP_ROUTER_AVALANCHE_MAINNET/, "two contracts never share an address");
});

test("one relayer may serve both environments: the relayer ids keep them apart", () => {
  const shared = { RELAYER_URL: "http://localhost:8080", RELAYER_URL_MAINNET: "http://localhost:8080", RELAYER_API_KEY: "one-relayer-key", RELAYER_API_KEY_MAINNET: "one-relayer-key" };
  const active = activeConfig(loadEnv(minimalMainnet(shared)));
  assert.equal(active.relayerUrl, "http://localhost:8080");
  assert.deepEqual([active.evmRelayerId, active.stellarRelayerId], ["avalanche-mainnet-relayer", "stellar-mainnet-relayer"]);
  assert.throws(() => loadEnv(minimalMainnet({ ...shared, RELAYER_FUJI_ID: "avalanche-mainnet-relayer" })), /RELAYER_AVALANCHE_MAINNET_ID/);
});
