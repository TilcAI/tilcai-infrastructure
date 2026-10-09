#![no_std]
//! TilcAI smart account.
//!
//! An OpenZeppelin `stellar-accounts` smart account with no authorization logic of its own:
//! `__check_auth` is `smart_account::do_check_auth` (context rules, signers, policies).
//! The deployer gets no authority. Only the signers passed to the constructor can authorize
//! anything, including every later change to rules, signers and policies.
//! Not upgradeable: no code path replaces the contract wasm.
use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contractimpl,
    crypto::Hash,
    Address, Env, Map, String, Symbol, Val, Vec,
};
use stellar_accounts::smart_account::{
    self, AuthPayload, ContextRule, ContextRuleType, ExecutionEntryPoint, Signer, SmartAccount,
    SmartAccountError,
};

#[cfg(test)]
mod test;

/// Name of the rule created at deployment (the library caps names at 20 bytes).
const OWNER_RULE: &str = "owner";

#[contract]
pub struct TilcaiAccount;

#[contractimpl]
impl TilcaiAccount {
    /// Creates the owner rule: a `Default` context rule (it matches any context) holding the
    /// owner's signers and policies. Narrower rules, such as an agent limited to USDC
    /// transfers, are added later by the owner through `add_context_rule`.
    pub fn __constructor(e: &Env, signers: Vec<Signer>, policies: Map<Address, Val>) {
        smart_account::add_context_rule(
            e,
            &ContextRuleType::Default,
            &String::from_str(e, OWNER_RULE),
            None,
            &signers,
            &policies,
        );
    }
}

#[contractimpl]
impl CustomAccountInterface for TilcaiAccount {
    type Error = SmartAccountError;
    type Signature = AuthPayload;

    fn __check_auth(
        e: Env,
        signature_payload: Hash<32>,
        signatures: AuthPayload,
        auth_contexts: Vec<Context>,
    ) -> Result<(), Self::Error> {
        smart_account::do_check_auth(&e, &signature_payload, &signatures, &auth_contexts)
    }
}

#[contractimpl(contracttrait)]
impl SmartAccount for TilcaiAccount {}

#[contractimpl(contracttrait)]
impl ExecutionEntryPoint for TilcaiAccount {}
