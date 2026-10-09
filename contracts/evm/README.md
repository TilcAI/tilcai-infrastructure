# EVM contracts (Foundry)

Design in `documentation/TILCAI_PLAN_ARQUITECTURA_BACKEND_INFRA_2026-10-02.md` §8 and, for the
accounts, `documentation/TILCAI_FASE_SCA_EMISION_DE_CUENTAS_2026-10-06.md`.

| Contract | Phase | Purpose |
| --- | --- | --- |
| `TilcaiCctpRouter` | 1 ✔ deployed on Avalanche Fuji: `0x297ce6a2787484db4bB18A96a8F28A9881Fc163C` | Gasless source burn: pulls USDC with EIP-3009 `receiveWithAuthorization` (payer signs typed data, no AVAX), then calls `TokenMessengerV2.depositForBurnWithHook` toward the Stellar `CctpForwarder`. Submitted by the OZ Relayer EVM relayer. The signed nonce commits to payment id, amount and the whole CCTP route. No owner, no upgrades, no balance. `forge test` covers redirection, replay, wrong signer, expiry and a fuzzed amount. Takes a `(v, r, s)` signature, so only EOAs can pay through it. |
| `TilcaiVault` | ✔ deployed on Avalanche Fuji: `0x841dD47Db3124839be1D878DD277e1b07D6932b6` | Holds USDC and pays out purchases settled off-chain. The operator (the OZ Relayer's Fuji account) calls `disburse(id, to, amount)`; each id is paid at most once, with a cap per payout and per UTC day. The owner sets the limits, replaces the operator, pauses and withdraws (`Ownable2Step`, ownership cannot be renounced). No upgrades. `forge test` covers replay, roles, both caps and the day rollover, pause, a short vault and a fuzzed payout. Deploy with `npm run vault -- deploy`. |
| `TilcaiCctpRouterV2` | SCA · M4 | Same router with the EIP-3009 `bytes signature` overload, which USDC checks through ERC-1271. Lets a smart account pay with its owner's passkey. |
| `TilcaiAccount`, `TilcaiAccountFactory` | SCA · M4 | ERC-4337 account on OpenZeppelin Contracts `Account` with a WebAuthn (P-256) or ECDSA owner. The factory derives the address from the owner key and a salt. |
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
