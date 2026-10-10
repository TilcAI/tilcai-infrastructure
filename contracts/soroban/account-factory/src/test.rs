extern crate std;

use soroban_sdk::{vec, Address, Bytes, BytesN, Env, String};
use stellar_accounts::smart_account::{ContextRuleType, Signer};

use crate::{TilcaiAccountFactory, TilcaiAccountFactoryClient};

// Built by `stellar contract build`; the factory deploys the real account.
const ACCOUNT_WASM: &[u8] = include_bytes!("../../target/wasm32v1-none/release/tilcai_account.wasm");
// The account's constructor asks each verifier to canonicalize its key, so they are real too.
const ED25519_VERIFIER_WASM: &[u8] = include_bytes!("../../target/wasm32v1-none/release/tilcai_ed25519_verifier.wasm");
const WEBAUTHN_VERIFIER_WASM: &[u8] = include_bytes!("../../target/wasm32v1-none/release/tilcai_webauthn_verifier.wasm");

struct Fixture<'a> {
    e: Env,
    factory: TilcaiAccountFactoryClient<'a>,
    ed25519_verifier: Address,
    webauthn_verifier: Address,
}

fn fixture<'a>() -> Fixture<'a> {
    let e = Env::default();
    let wasm = e.deployer().upload_contract_wasm(ACCOUNT_WASM);
    let ed25519_verifier = e.register(ED25519_VERIFIER_WASM, ());
    let webauthn_verifier = e.register(WEBAUTHN_VERIFIER_WASM, ());
    let id = e.register(
        TilcaiAccountFactory,
        (wasm, ed25519_verifier.clone(), webauthn_verifier.clone()),
    );
    let factory = TilcaiAccountFactoryClient::new(&e, &id);
    Fixture { e, factory, ed25519_verifier, webauthn_verifier }
}

fn bytes32(e: &Env, fill: u8) -> BytesN<32> {
    BytesN::from_array(e, &[fill; 32])
}

fn passkey(e: &Env, fill: u8, credential: &[u8]) -> Bytes {
    let mut key = Bytes::from_slice(e, &[0x04]);
    key.append(&Bytes::from_array(e, &[fill; 64]));
    key.append(&Bytes::from_slice(e, credential));
    key
}

#[test]
fn the_address_is_known_before_deploying_and_matches() {
    let f = fixture();
    let key = bytes32(&f.e, 7);
    let salt = bytes32(&f.e, 1);

    let predicted = f.factory.address_ed25519(&key, &salt);
    let deployed = f.factory.create_ed25519(&key, &salt);

    assert_eq!(predicted, deployed);
}

#[test]
fn the_account_has_the_owner_as_its_only_signer() {
    let f = fixture();
    let key = bytes32(&f.e, 7);
    let address = f.factory.create_ed25519(&key, &bytes32(&f.e, 1));

    let account = tilcai_account_client(&f.e, &address);
    assert_eq!(account.get_context_rules_count(), 1);
    let rule = account.get_context_rule(&0);
    assert_eq!(rule.context_type, ContextRuleType::Default);
    assert_eq!(rule.name, String::from_str(&f.e, "owner"));
    assert_eq!(
        rule.signers,
        vec![&f.e, Signer::External(f.ed25519_verifier.clone(), key.into())]
    );
    assert!(rule.policies.is_empty());
}

#[test]
fn the_address_commits_to_the_owner_the_salt_and_the_kind() {
    let f = fixture();
    let salt = bytes32(&f.e, 1);
    let a = f.factory.address_ed25519(&bytes32(&f.e, 7), &salt);

    assert_ne!(a, f.factory.address_ed25519(&bytes32(&f.e, 8), &salt));
    assert_ne!(a, f.factory.address_ed25519(&bytes32(&f.e, 7), &bytes32(&f.e, 2)));
    // The same 32 bytes as a passkey key_data is another signer, hence another address.
    let as_passkey = f.factory.address_webauthn(&passkey(&f.e, 7, b""), &salt);
    assert_ne!(a, as_passkey);
}

#[test]
fn a_passkey_account_is_deployed_and_the_credential_id_is_part_of_the_signer() {
    let f = fixture();
    let key_data = passkey(&f.e, 9, b"credential-1");
    let salt = bytes32(&f.e, 3);

    let predicted = f.factory.address_webauthn(&key_data, &salt);
    let deployed = f.factory.create_webauthn(&key_data, &salt);
    assert_eq!(predicted, deployed);

    let rule = tilcai_account_client(&f.e, &deployed).get_context_rule(&0);
    assert_eq!(
        rule.signers,
        vec![&f.e, Signer::External(f.webauthn_verifier.clone(), key_data)]
    );
}

#[test]
fn a_second_deployment_at_the_same_address_fails() {
    let f = fixture();
    let key = bytes32(&f.e, 7);
    let salt = bytes32(&f.e, 1);
    f.factory.create_ed25519(&key, &salt);

    assert!(f.factory.try_create_ed25519(&key, &salt).is_err());
}

#[test]
fn a_passkey_key_shorter_than_a_p256_point_is_refused() {
    let f = fixture();
    let short = Bytes::from_array(&f.e, &[4u8; 40]);

    assert!(f.factory.try_create_webauthn(&short, &bytes32(&f.e, 1)).is_err());
    assert!(f.factory.try_address_webauthn(&short, &bytes32(&f.e, 1)).is_err());
}

#[test]
fn nobody_has_to_authorize_the_deployment() {
    // `Env::default()` mocks no auth: deploying works because the factory asks for none.
    let f = fixture();
    f.factory.create_ed25519(&bytes32(&f.e, 7), &bytes32(&f.e, 1));
}

fn tilcai_account_client<'a>(e: &Env, address: &Address) -> AccountClient<'a> {
    AccountClient::new(e, address)
}

// The deployed wasm's interface, as far as the tests read it.
mod account_iface {
    use soroban_sdk::contractclient;
    use stellar_accounts::smart_account::ContextRule;

    #[allow(dead_code)]
    #[contractclient(name = "AccountClient")]
    pub trait Account {
        fn get_context_rules_count(e: soroban_sdk::Env) -> u32;
        fn get_context_rule(e: soroban_sdk::Env, id: u32) -> ContextRule;
    }
}
use account_iface::AccountClient;
