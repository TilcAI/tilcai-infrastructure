# Soroban contracts

Planned in the architecture plan §8.2. Nothing here is deployed yet.

| Contract | Phase | Purpose |
| --- | --- | --- |
| Smart account (reuse) | 3 | OpenZeppelin `stellar-contracts` smart account (context rules + signers + policies). Not forked: pinned version + audit scope recorded. |
| `tilcai_spend_policy` | 3 | Policy plugged into the smart account: exact SAC, allow-listed `payTo`, per-call and per-period limits, expiry. Rejects admin calls and nested invocations outside scope. |
| `tilcai_budget` | 3–5 | Optional shared root budget for several mandates/accounts of one principal (atomic hold/consume on-chain). |

Build with `stellar contract build` (Rust, `wasm32v1-none`).
