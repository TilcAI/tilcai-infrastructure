# Soroban contracts

Smart contract accounts on Stellar for the SCA phase. Design in
`documentation/TILCAI_FASE_SCA_EMISION_DE_CUENTAS_2026-10-06.md` and the architecture plan §8.2.
Deployed on Stellar Testnet on 2026-10-09 (`deploy-testnet.sh`); the addresses are in the backend's README. Unaudited: testnet only.

Accounts are built on OpenZeppelin [`stellar-accounts`](https://crates.io/crates/stellar-accounts)
**0.7.2**, pinned with `=`. OpenZeppelin audited the release candidate v0.7.0 in March 2026. The
crates marked *wrapper* expose that library as a contract and add no authorization logic.

| Crate | Wasm | Kind | Purpose |
| --- | --- | --- | --- |
| `account/` | `tilcai_account` | wrapper | The account. `__check_auth` is `smart_account::do_check_auth`. The constructor creates one `Default` rule, `owner`, with the owner's signers and policies. Not upgradeable. |
| `verifier-ed25519/` | `tilcai_ed25519_verifier` | wrapper | Stateless Ed25519 verifier, deployed once per network. |
| `verifier-webauthn/` | `tilcai_webauthn_verifier` | wrapper | Stateless WebAuthn (passkey, secp256r1) verifier, deployed once per network. |
| `policy-spending-limit/` | `tilcai_spending_limit_policy` | wrapper | Rolling-window spending limit, shared by all accounts. State per (account, rule). |
| `account-factory/` | `tilcai_account_factory` | own · M2 | Deploys `tilcai_account` at an address derived from the owner's key (Ed25519 or passkey) and a salt. Needs no authorization, so the relayer pays. No admin, not upgradeable. |
| `vault/` | `tilcai_vault` | own | Holds the USDC behind off-chain purchases and pays each id once, within a cap per payout and per UTC day. Twin of `TilcaiVault.sol`. |
| `tilcai_spend_policy` | — | own · M3 | Agent policy: `transfer` only, allow-listed `payTo`, cap per call. |
| `tilcai_budget` | — | own · optional | Shared root budget for several mandates of one principal. |

## Build and test

```sh
cd contracts/soroban
stellar contract build     # target/wasm32v1-none/release/*.wasm
cargo test                 # native, soroban-sdk testutils
./deploy-testnet.sh --source <identity> --operator G…   # see the script's header
```

`cargo test` needs the built wasm of `tilcai_account` and of both verifiers: the factory tests deploy
the real contracts, so build first.

Needs Rust stable with the `wasm32v1-none` target (`rustup target add wasm32v1-none`) and the
Stellar CLI. Verified with rustc 1.98.1 and stellar 28.1.0. `npm run sca:preflight` checks both.

## Rules that come from the library and its audit

- **Agent signers are `External(verifier, key)`, not `Delegated(address)`.** An external signer
  keeps a payment to one authorization entry. A delegated signer needs a second entry or CAP-71
  delegated credentials, and the x402 facilitator rejects the latter. M0 proves the external path.
- **`spending_limit` goes on a `CallContract(<token>)` rule only.** On a `Default` rule a single
  limit would add up amounts of tokens with different decimals.
- **The factory registers only the owner.** Agent rules, with their `spending_limit`, are added later by the owner signing with its own key (M3). A deployer, TilcAI included, gets no authority.
- **The vault's operator authorizes as the transaction source.** The relayer sends `disburse` with `source_account` auth; any other sender needs an authorization entry nobody signs, so the call fails.
- A rule holds at most 15 signers and 5 policies; its name is at most 20 bytes. `valid_until` is a
  ledger sequence.
- Signers sign `sha256(signature_payload || context_rule_ids.to_xdr())`: the rule ids are bound to
  the signature, so a sponsor cannot move it to a weaker rule.

## Dependency note

`Cargo.lock` is committed. It holds `ed25519-dalek` at 2.2.0, the version in the lock file of
`stellar-contracts` v0.7.2: `soroban-env-host` 26.1.3 accepts any version from 2 up but does not
compile against 3.0.0, which Cargo selects when there is no lock file.
