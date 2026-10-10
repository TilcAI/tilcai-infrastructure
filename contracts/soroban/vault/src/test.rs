extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, BytesN, Env,
};

use crate::{Payout, TilcaiVault, TilcaiVaultClient, VaultError};

const MAX: i128 = 100_0000000; // 100 USDC (7 decimals)
const DAILY: i128 = 500_0000000;
const FUNDS: i128 = 1_000_0000000;

struct Fixture<'a> {
    e: Env,
    vault: TilcaiVaultClient<'a>,
    usdc: TokenClient<'a>,
    owner: Address,
    operator: Address,
    buyer: Address,
}

fn fixture<'a>() -> Fixture<'a> {
    let e = Env::default();
    e.mock_all_auths();
    let issuer = Address::generate(&e);
    let usdc_id = e.register_stellar_asset_contract_v2(issuer).address();
    let owner = Address::generate(&e);
    let operator = Address::generate(&e);
    let buyer = Address::generate(&e);
    let id = e.register(TilcaiVault, (usdc_id.clone(), owner.clone(), operator.clone(), MAX, DAILY));
    StellarAssetClient::new(&e, &usdc_id).mint(&id, &FUNDS);
    Fixture {
        vault: TilcaiVaultClient::new(&e, &id),
        usdc: TokenClient::new(&e, &usdc_id),
        e,
        owner,
        operator,
        buyer,
    }
}

fn id(e: &Env, n: u8) -> BytesN<32> {
    BytesN::from_array(e, &[n; 32])
}

fn err(r: Result<Result<(), soroban_sdk::ConversionError>, Result<soroban_sdk::Error, soroban_sdk::InvokeError>>) -> soroban_sdk::Error {
    match r {
        Err(Ok(e)) => e,
        other => panic!("expected a contract error, got {other:?}"),
    }
}

fn code(e: VaultError) -> soroban_sdk::Error {
    soroban_sdk::Error::from_contract_error(e as u32)
}

#[test]
fn pays_the_buyer_and_records_the_payout() {
    let f = fixture();
    f.vault.disburse(&id(&f.e, 1), &f.buyer, &(10_5000000));

    assert_eq!(f.usdc.balance(&f.buyer), 10_5000000);
    assert_eq!(f.usdc.balance(&f.vault.address), FUNDS - 10_5000000);
    assert_eq!(f.vault.disbursed_amount(&id(&f.e, 1)), 10_5000000);
    assert_eq!(
        f.vault.payout(&id(&f.e, 1)),
        Some(Payout { to: f.buyer.clone(), amount: 10_5000000 })
    );
    assert_eq!(f.vault.available_today(), DAILY - 10_5000000);
}

#[test]
fn only_the_operator_can_disburse() {
    let f = fixture();
    f.vault.disburse(&id(&f.e, 1), &f.buyer, &1_0000000);

    let auths = f.e.auths();
    let (who, _) = &auths[auths.len() - 1];
    assert_eq!(who, &f.operator);
}

#[test]
fn an_id_is_paid_once() {
    let f = fixture();
    f.vault.disburse(&id(&f.e, 1), &f.buyer, &1_0000000);

    let again = f.vault.try_disburse(&id(&f.e, 1), &f.buyer, &1_0000000);
    assert_eq!(err(again), code(VaultError::AlreadyDisbursed));
    assert_eq!(f.usdc.balance(&f.buyer), 1_0000000);
}

#[test]
fn refuses_what_the_limits_and_the_balance_do_not_allow() {
    let f = fixture();
    assert_eq!(err(f.vault.try_disburse(&id(&f.e, 1), &f.buyer, &0)), code(VaultError::ZeroAmount));
    assert_eq!(err(f.vault.try_disburse(&id(&f.e, 1), &f.buyer, &(MAX + 1))), code(VaultError::AboveDisbursementLimit));
    assert_eq!(err(f.vault.try_disburse(&id(&f.e, 1), &f.vault.address, &1)), code(VaultError::InvalidRecipient));

    // Five payouts of the cap fill the day; a sixth is above the daily limit.
    for n in 1..=5u8 {
        f.vault.disburse(&id(&f.e, n), &f.buyer, &MAX);
    }
    assert_eq!(f.vault.available_today(), 0);
    assert_eq!(err(f.vault.try_disburse(&id(&f.e, 6), &f.buyer, &1)), code(VaultError::AboveDailyLimit));
}

#[test]
fn the_daily_limit_resets_with_the_utc_day() {
    let f = fixture();
    f.e.ledger().set_timestamp(10 * 86_400 + 100);
    for n in 1..=5u8 {
        f.vault.disburse(&id(&f.e, n), &f.buyer, &MAX);
    }
    assert_eq!(f.vault.available_today(), 0);

    f.e.ledger().set_timestamp(11 * 86_400 + 1);
    assert_eq!(f.vault.available_today(), DAILY);
    f.vault.disburse(&id(&f.e, 9), &f.buyer, &MAX);
}

#[test]
fn refuses_when_the_vault_holds_less_than_the_amount() {
    let f = fixture();
    f.vault.withdraw(&f.usdc.address, &f.owner, &(FUNDS - 5_0000000));

    assert_eq!(err(f.vault.try_disburse(&id(&f.e, 1), &f.buyer, &6_0000000)), code(VaultError::InsufficientBalance));
    f.vault.disburse(&id(&f.e, 1), &f.buyer, &5_0000000);
}

#[test]
fn paused_vault_pays_nothing_but_the_owner_can_still_withdraw() {
    let f = fixture();
    f.vault.pause();
    assert!(f.vault.paused());
    assert_eq!(err(f.vault.try_disburse(&id(&f.e, 1), &f.buyer, &1_0000000)), code(VaultError::Paused));

    f.vault.withdraw(&f.usdc.address, &f.owner, &1_0000000);
    assert_eq!(f.usdc.balance(&f.owner), 1_0000000);

    f.vault.unpause();
    f.vault.disburse(&id(&f.e, 1), &f.buyer, &1_0000000);
}

#[test]
fn the_owner_changes_operator_and_limits() {
    let f = fixture();
    let next = Address::generate(&f.e);
    f.vault.set_operator(&next);
    f.vault.set_limits(&(5_0000000), &(8_0000000));

    assert_eq!(f.vault.operator(), next);
    assert_eq!(f.vault.max_per_disbursement(), 5_0000000);
    assert_eq!(f.vault.daily_limit(), 8_0000000);
    assert_eq!(err(f.vault.try_disburse(&id(&f.e, 1), &f.buyer, &6_0000000)), code(VaultError::AboveDisbursementLimit));
    assert_eq!(err(f.vault.try_set_limits(&-1, &1)), code(VaultError::InvalidLimits));
}

#[test]
fn ownership_changes_in_two_steps() {
    let f = fixture();
    let next = Address::generate(&f.e);
    assert_eq!(err(f.vault.try_accept_ownership()), code(VaultError::NoPendingOwner));

    f.vault.transfer_ownership(&next);
    assert_eq!(f.vault.owner(), f.owner); // still the old one until accepted
    f.vault.accept_ownership();
    assert_eq!(f.vault.owner(), next);
}

#[test]
fn operations_need_the_right_authorization() {
    // No mocked auth: the calls reach `require_auth` and are refused.
    let e = Env::default();
    let issuer = Address::generate(&e);
    let usdc = e.register_stellar_asset_contract_v2(issuer).address();
    let owner = Address::generate(&e);
    let operator = Address::generate(&e);
    let id_ = e.register(TilcaiVault, (usdc, owner, operator, MAX, DAILY));
    let vault = TilcaiVaultClient::new(&e, &id_);
    let buyer = Address::generate(&e);

    assert!(vault.try_disburse(&id(&e, 1), &buyer, &1_0000000).is_err());
    assert!(vault.try_pause().is_err());
    assert!(vault.try_set_operator(&buyer).is_err());
}
