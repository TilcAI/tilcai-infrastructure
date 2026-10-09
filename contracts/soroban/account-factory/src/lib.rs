#![no_std]
//! TilcAI account factory.
//!
//! Deploys `tilcai-account` with the owner's key as its only signer, at an address derived from
//! that key and a salt. Three properties follow, and they are why the factory exists:
//!
//!  - The address is known before the account is deployed, so a holder can receive funds first.
//!  - The address commits to the owner: nobody, TilcAI included, can deploy another
//!    configuration at an address that already received funds.
//!  - Deploying needs no authorization, so TilcAI's relayer can pay for it. The deployer gets no
//!    authority over the account; only the owner's signer is registered.
//!
//! Policies are not installed here: the owner adds agent rules later, signing with its own key.
//! The factory is not upgradeable and has no admin.
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    xdr::ToXdr, Address, Bytes, BytesN, Env, Map, Val, Vec,
};
use stellar_accounts::smart_account::Signer;

#[cfg(test)]
mod test;

/// Domain separation of the final salt, so the same (key, salt) in another contract differs.
const SALT_DOMAIN: &[u8] = b"tilcai-account-v1";
/// Same as the verifiers: the passkey's uncompressed P-256 point, then an optional credential id.
const WEBAUTHN_KEY_LEN: u32 = 65;
const DAY_LEDGERS: u32 = 17_280;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    AccountWasm,
    Ed25519Verifier,
    WebauthnVerifier,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum FactoryError {
    /// A passkey key is shorter than a P-256 point.
    InvalidKey = 1,
}

#[contractevent(topics = ["account_created"])]
pub struct AccountCreated {
    #[topic]
    pub account: Address,
    pub salt: BytesN<32>,
}

#[contract]
pub struct TilcaiAccountFactory;

#[contractimpl]
impl TilcaiAccountFactory {
    /// `account_wasm_hash`: the uploaded `tilcai_account` wasm. The two verifiers are the shared,
    /// stateless contracts every account of this network points its signer at.
    pub fn __constructor(
        e: &Env,
        account_wasm_hash: BytesN<32>,
        ed25519_verifier: Address,
        webauthn_verifier: Address,
    ) {
        let s = e.storage().instance();
        s.set(&DataKey::AccountWasm, &account_wasm_hash);
        s.set(&DataKey::Ed25519Verifier, &ed25519_verifier);
        s.set(&DataKey::WebauthnVerifier, &webauthn_verifier);
    }

    pub fn account_wasm_hash(e: &Env) -> BytesN<32> {
        touch(e);
        e.storage().instance().get(&DataKey::AccountWasm).unwrap()
    }

    pub fn ed25519_verifier(e: &Env) -> Address {
        touch(e);
        e.storage().instance().get(&DataKey::Ed25519Verifier).unwrap()
    }

    pub fn webauthn_verifier(e: &Env) -> Address {
        touch(e);
        e.storage().instance().get(&DataKey::WebauthnVerifier).unwrap()
    }

    /// Address of the account owned by an Ed25519 key, for this `salt`.
    pub fn address_ed25519(e: &Env, key: BytesN<32>, salt: BytesN<32>) -> Address {
        touch(e);
        let signer = ed25519_signer(e, &key);
        e.deployer()
            .with_current_contract(final_salt(e, 0, &signer, &salt))
            .deployed_address()
    }

    /// Address of the account owned by a passkey. `key_data` is the 65-byte uncompressed P-256
    /// point, optionally followed by the credential id (metadata the verifier ignores).
    pub fn address_webauthn(e: &Env, key_data: Bytes, salt: BytesN<32>) -> Address {
        touch(e);
        let signer = webauthn_signer(e, &key_data);
        e.deployer()
            .with_current_contract(final_salt(e, 1, &signer, &salt))
            .deployed_address()
    }

    /// Deploys the account owned by an Ed25519 key. Anyone may call it; it fails if the account
    /// already exists, so a caller that wants idempotency checks the address first.
    pub fn create_ed25519(e: &Env, key: BytesN<32>, salt: BytesN<32>) -> Address {
        touch(e);
        deploy(e, ed25519_signer(e, &key), 0, &salt)
    }

    pub fn create_webauthn(e: &Env, key_data: Bytes, salt: BytesN<32>) -> Address {
        touch(e);
        deploy(e, webauthn_signer(e, &key_data), 1, &salt)
    }
}

fn touch(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(30 * DAY_LEDGERS, 90 * DAY_LEDGERS);
}

fn ed25519_signer(e: &Env, key: &BytesN<32>) -> Signer {
    let verifier: Address = e.storage().instance().get(&DataKey::Ed25519Verifier).unwrap();
    Signer::External(verifier, key.clone().into())
}

fn webauthn_signer(e: &Env, key_data: &Bytes) -> Signer {
    if key_data.len() < WEBAUTHN_KEY_LEN {
        panic_with_error!(e, FactoryError::InvalidKey);
    }
    let verifier: Address = e.storage().instance().get(&DataKey::WebauthnVerifier).unwrap();
    Signer::External(verifier, key_data.clone())
}

/// sha256(domain ‖ kind ‖ signer ‖ salt). The signer carries the verifier and the key, so the
/// address changes with either.
fn final_salt(e: &Env, kind: u8, signer: &Signer, salt: &BytesN<32>) -> BytesN<32> {
    let mut input = Bytes::from_slice(e, SALT_DOMAIN);
    input.push_back(kind);
    input.append(&signer.clone().to_xdr(e));
    input.append(&salt.clone().into());
    e.crypto().sha256(&input).into()
}

fn deploy(e: &Env, signer: Signer, kind: u8, salt: &BytesN<32>) -> Address {
    let wasm: BytesN<32> = e.storage().instance().get(&DataKey::AccountWasm).unwrap();
    let mut signers: Vec<Signer> = Vec::new(e);
    signers.push_back(signer.clone());
    let policies: Map<Address, Val> = Map::new(e);
    let account = e
        .deployer()
        .with_current_contract(final_salt(e, kind, &signer, salt))
        .deploy_v2(wasm, (signers, policies));
    AccountCreated {
        account: account.clone(),
        salt: salt.clone(),
    }
    .publish(e);
    account
}
