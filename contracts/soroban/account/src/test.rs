extern crate std;

use soroban_sdk::{testutils::Address as _, vec, Address, Env, Map, String, Val};
use stellar_accounts::smart_account::{ContextRuleType, Signer};

use crate::{TilcaiAccount, TilcaiAccountClient};

fn deploy<'a>(e: &Env, owner: &Signer) -> TilcaiAccountClient<'a> {
    let id = e.register(TilcaiAccount, (vec![e, owner.clone()], Map::<Address, Val>::new(e)));
    TilcaiAccountClient::new(e, &id)
}

#[test]
fn constructor_creates_the_owner_rule() {
    let e = Env::default();
    let owner = Signer::Delegated(Address::generate(&e));
    let account = deploy(&e, &owner);

    assert_eq!(account.get_context_rules_count(), 1);
    let rule = account.get_context_rule(&0);
    assert_eq!(rule.context_type, ContextRuleType::Default);
    assert_eq!(rule.name, String::from_str(&e, "owner"));
    assert_eq!(rule.signers, vec![&e, owner]);
    assert!(rule.policies.is_empty());
    assert_eq!(rule.valid_until, None);
}

#[test]
fn rules_cannot_be_added_without_the_account_authorization() {
    let e = Env::default();
    let account = deploy(&e, &Signer::Delegated(Address::generate(&e)));

    let intruder = vec![&e, Signer::Delegated(Address::generate(&e))];
    let added = account.try_add_context_rule(
        &ContextRuleType::Default,
        &String::from_str(&e, "intruder"),
        &None,
        &intruder,
        &Map::new(&e),
    );

    assert!(added.is_err());
    assert_eq!(account.get_context_rules_count(), 1);
}
