# EVM contracts (Foundry)

Design in `documentation/TILCAI_PLAN_ARQUITECTURA_BACKEND_INFRA_2026-10-02.md` §8.

| Contract | Phase | Purpose |
| --- | --- | --- |
| `TilcaiCctpRouter` | 1 ✔ deployed on Avalanche Fuji: `0x297ce6a2787484db4bB18A96a8F28A9881Fc163C` | Gasless source burn: pulls USDC with EIP-3009 `receiveWithAuthorization` (payer signs typed data, no AVAX), then calls `TokenMessengerV2.depositForBurnWithHook` toward the Stellar `CctpForwarder`. Submitted by the OZ Relayer EVM relayer. The signed nonce commits to payment id, amount and the whole CCTP route. No owner, no upgrades, no balance. `forge test` covers redirection, replay, wrong signer, expiry and a fuzzed amount. |
| `TilcaiPaymaster` | 3 | ERC-4337 verifying paymaster (EntryPoint v0.8): sponsors only UserOps whose calls target USDC/TokenMessengerV2/Router, with per-principal limits signed by TilcAI. |
| ERC-8004 registries | 4 | Use an existing deployment if one is canonical on the chosen testnet; otherwise deploy the reference Identity/Reputation/Validation registries unmodified. |

```sh
cd contracts/evm
forge install foundry-rs/forge-std --no-git
forge build && forge test
```
