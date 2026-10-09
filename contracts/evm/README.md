# EVM contracts (Foundry)

Design in `documentation/TILCAI_PLAN_ARQUITECTURA_BACKEND_INFRA_2026-10-02.md` §8 and, for the
accounts, `documentation/TILCAI_FASE_SCA_EMISION_DE_CUENTAS_2026-10-06.md`.

| Contract | Phase | Purpose |
| --- | --- | --- |
| `TilcaiCctpRouter` | 1 ✔ deployed on Avalanche Fuji: `0x297ce6a2787484db4bB18A96a8F28A9881Fc163C` | Gasless source burn: pulls USDC with EIP-3009 `receiveWithAuthorization` (payer signs typed data, no AVAX), then calls `TokenMessengerV2.depositForBurnWithHook` toward the Stellar `CctpForwarder`. Submitted by the OZ Relayer EVM relayer. The signed nonce commits to payment id, amount and the whole CCTP route. No owner, no upgrades, no balance. `forge test` covers redirection, replay, wrong signer, expiry and a fuzzed amount. Takes a `(v, r, s)` signature, so only EOAs can pay through it. |
| `TilcaiVault` | ✔ deployed on Avalanche Fuji: `0x841dD47Db3124839be1D878DD277e1b07D6932b6` | Holds USDC and pays out purchases settled off-chain. The operator (the OZ Relayer's Fuji account) calls `disburse(id, to, amount)`; each id is paid at most once, with a cap per payout and per UTC day. The owner sets the limits, replaces the operator, pauses and withdraws (`Ownable2Step`, ownership cannot be renounced). No upgrades. `forge test` covers replay, roles, both caps and the day rollover, pause, a short vault and a fuzzed payout. Deploy with `npm run vault -- deploy`. |
| `TilcaiCctpRouterV2` | SCA ✔ deployed on Avalanche Fuji: `0x09483803916e6cb2027741c9287361ad55507a66` | Same router with the EIP-3009 `bytes signature` overload, which USDC checks through ERC-1271 for a contract and ECDSA for an EOA. Lets a smart account pay with its owner's passkey. Its nonce tag is `tilcai-cctp-router-v2`, so an authorization for one router is useless on the other. `forge test` covers an account payer, an EOA payer, redirection, replay, a stranger passkey, expiry and a fuzzed amount. |
| `TilcaiAccount`, `TilcaiAccountFactory` | SCA ✔ factory deployed on Avalanche Fuji: `0x55a5b0ed47c5dfb168cfe2b431a56455576d51b8` (implementation `0x8e2BEf4948b0F540548d62f7D69A9e301d3dD773`) | ERC-4337 account on OpenZeppelin Contracts `Account` whose owner is a passkey (`SignerWebAuthn`, P-256). Signs typed data through ERC-1271 with ERC-7739 (the passkey signs a wrapper that names the account, so a signature cannot be replayed on another account of the same key) and runs batches (ERC-7821) only for the EntryPoint or itself. The owner can move to a new passkey with `setOwner`, called by the account itself. The factory makes minimal clones at a CREATE2 address that commits to the owner key and a salt; creating twice is a no-op. The implementation's own owner is a curve point derived from a label, with no known key. No upgrades, no admin: TilcAI is never a signer. **Unaudited: testnet only.** `forge test` covers address determinism, initializer protection, wrong key, wrong message, cross-account replay, a bare-digest assertion, missing user verification, `webauthn.create`, high-s, EIP-3009 payments and owner rotation. Deploy with `npm run sca -- deploy`, check on-chain with `npm run sca -- verify`. |
| `TilcaiSessionPolicy` | SCA · M5 | On-chain limits for an agent key: only `USDC.approve` + `depositForBurnWithHook` toward the forwarder, allow-listed `payTo`, caps per call and per period, expiry. |
| `TilcaiPaymaster` | deferred | Not needed while TilcAI's relayer sends the UserOperations itself with zero fees (plan ADR-12). Returns when third-party bundlers must be supported; OpenZeppelin Contracts ships `PaymasterSigner` as a base. |
| ERC-8004 registries | 4 | Use an existing deployment if one is canonical on the chosen testnet; otherwise deploy the reference Identity/Reputation/Validation registries unmodified. |

## Dependencies

`lib/` is not in git. Install the pinned versions:

```sh
cd contracts/evm
forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts@v5.7.0 --no-git
forge build && forge test
```

`remappings.txt` maps `@openzeppelin/contracts/` and `forge-std/`. OpenZeppelin Contracts 5.7.0
compiles with this project's settings (solc 0.8.28, `cancun`); its `Account` targets
**EntryPoint v0.9** (`0x433709009B8330FDa32311DF1C2AFA402eD8D009`), which is deployed on Fuji.

## Facts verified on Fuji (2026-10-06, `npm run sca:preflight`)

- EntryPoint v0.9 is deployed.
- The secp256r1 precompile at `0x…0100` verifies a valid signature, so `SignerWebAuthn` does not
  need the Solidity fallback.
- The USDC implementation has `receiveWithAuthorization(…, bytes signature)`.
- EIP-7702 is not available on Avalanche (ACP-209 is a proposal), so `SignerEIP7702` is out.
