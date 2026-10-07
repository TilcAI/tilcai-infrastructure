#![no_std]
//! WebAuthn (passkey, secp256r1) verifier for TilcAI smart accounts.
//!
//! Stateless and immutable: deployed once per network and shared by every account that
//! registers an `External(verifier, key_data)` signer. `key_data` starts with the 65-byte
//! uncompressed public key; `sig_data` is the XDR of `WebAuthnSigData`. Logic is OpenZeppelin
//! `stellar_accounts::verifiers::webauthn`.
use soroban_sdk::{contract, contractimpl, xdr::FromXdr, Bytes, BytesN, Env, Vec};
use stellar_accounts::verifiers::{
    utils::extract_from_bytes,
    webauthn::{self, WebAuthnSigData},
    Verifier,
};

#[contract]
pub struct WebauthnVerifier;

#[contractimpl]
impl Verifier for WebauthnVerifier {
    type KeyData = Bytes;
    type SigData = Bytes;

    fn verify(e: &Env, signature_payload: Bytes, key_data: Bytes, sig_data: Bytes) -> bool {
        let sig_struct =
            WebAuthnSigData::from_xdr(e, &sig_data).expect("WebAuthnSigData with correct format");
        let pub_key: BytesN<65> =
            extract_from_bytes(e, &key_data, 0..65).expect("65-byte public key to be extracted");
        webauthn::verify(e, &signature_payload, &pub_key, &sig_struct)
    }

    fn canonicalize_key(e: &Env, key_data: Bytes) -> Bytes {
        webauthn::canonicalize_key(e, &key_data)
    }

    fn batch_canonicalize_key(e: &Env, keys_data: Vec<Bytes>) -> Vec<Bytes> {
        webauthn::batch_canonicalize_key(e, &keys_data)
    }
}
