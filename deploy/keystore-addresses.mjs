#!/usr/bin/env node
// Prints the addresses a relayer keystore controls, BEFORE the relayer is started, so both
// accounts can be funded first (the Stellar relayer stays disabled until its account exists).
//
//   KEYSTORE_PASSPHRASE='…' node deploy/keystore-addresses.mjs path/to/local-signer.json
//
// The relayer uses the same 32 bytes as a secp256k1 key (EVM) and as an ed25519 seed (Stellar).
// Needs `npm ci` at the repository root (viem, @stellar/stellar-sdk). Prints no secret.
import { readFileSync } from "node:fs";
import { createDecipheriv, scryptSync } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { keccak256 } from "viem";
import { privateKeyToAddress } from "viem/accounts";

const [path] = process.argv.slice(2);
const passphrase = process.env.KEYSTORE_PASSPHRASE;
if (!path || !passphrase) {
  console.error("usage: KEYSTORE_PASSPHRASE='…' node deploy/keystore-addresses.mjs <keystore.json>");
  process.exit(64);
}

const ks = JSON.parse(readFileSync(path, "utf8"));
if (ks.version !== 3 || ks.crypto?.kdf !== "scrypt" || ks.crypto?.cipher !== "aes-128-ctr") {
  console.error("unsupported keystore: expected a V3 keystore (scrypt + aes-128-ctr)");
  process.exit(65);
}
const { salt, dklen, n, r, p } = ks.crypto.kdfparams;
const derived = scryptSync(passphrase, Buffer.from(salt, "hex"), dklen, { N: n, r, p, maxmem: 512 * 1024 * 1024 });
const ciphertext = Buffer.from(ks.crypto.ciphertext, "hex");
if (keccak256(Buffer.concat([derived.subarray(16, 32), ciphertext])).slice(2) !== ks.crypto.mac) {
  console.error("wrong passphrase or corrupt keystore (MAC mismatch)");
  process.exit(66);
}
const decipher = createDecipheriv("aes-128-ctr", derived.subarray(0, 16), Buffer.from(ks.crypto.cipherparams.iv, "hex"));
const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
if (key.length !== 32) {
  console.error(`unexpected key length ${key.length}`);
  process.exit(65);
}

console.log(`EVM (Avalanche Fuji, needs AVAX): ${privateKeyToAddress(`0x${key.toString("hex")}`)}`);
console.log(`Stellar (testnet, needs XLM)    : ${Keypair.fromRawEd25519Seed(key).publicKey()}`);
