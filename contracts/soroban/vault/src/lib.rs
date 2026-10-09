#![no_std]
//! TilcAI vault on Stellar.
//!
//! Holds the USDC that backs purchases paid off-chain (a bank transfer, a QR payment) and pays
//! each one out to the buyer's account. It is the Soroban twin of `TilcaiVault.sol`: same rules,
//! same names, so the backend treats both the same way.
//!
//! The operator, normally the OpenZeppelin Relayer's Stellar account, submits the payouts and
//! pays the fees, so the buyer needs no XLM. What the operator key can do is bounded on-chain:
//! one payout per disbursement id, a cap per payout and a cap per UTC day. Only the owner can
//! change those limits, replace the operator, pause the payouts or take funds back out.
//! Not upgradeable: no code path replaces the contract wasm.
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token,
    Address, BytesN, Env,
};

#[cfg(test)]
mod test;

const DAY_SECONDS: u64 = 86_400;
const DAY_LEDGERS: u32 = 17_280;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Usdc,
    Owner,
    PendingOwner,
    Operator,
    MaxPerDisbursement,
    DailyLimit,
    Paused,
    /// What was paid for a disbursement id.
    Payout(BytesN<32>),
    /// Total paid out in a UTC day (`ledger timestamp / 86400`).
    PaidOn(u64),
}

/// What a disbursement id was paid as. Absent means it has not been paid.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Payout {
    pub to: Address,
    pub amount: i128,
}

/// Error codes are part of the contract's interface: the backend maps them to the names of the
/// EVM vault's errors (`AlreadyDisbursed`, `AboveDailyLimit`, …).
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VaultError {
    ZeroAmount = 1,
    InvalidRecipient = 2,
    AlreadyDisbursed = 3,
    AboveDisbursementLimit = 4,
    AboveDailyLimit = 5,
    InsufficientBalance = 6,
    Paused = 7,
    InvalidLimits = 8,
    NoPendingOwner = 9,
}

#[contractevent(topics = ["disbursed"])]
pub struct Disbursed {
    #[topic]
    pub disbursement_id: BytesN<32>,
    pub to: Address,
    pub amount: i128,
}

#[contractevent(topics = ["operator_changed"])]
pub struct OperatorChanged {
    #[topic]
    pub operator: Address,
}

#[contractevent(topics = ["limits_changed"])]
pub struct LimitsChanged {
    pub max_per_disbursement: i128,
    pub daily_limit: i128,
}

#[contractevent(topics = ["paused"])]
pub struct PausedChanged {
    pub paused: bool,
}

#[contractevent(topics = ["withdrawn"])]
pub struct Withdrawn {
    #[topic]
    pub token: Address,
    pub to: Address,
    pub amount: i128,
}

#[contractevent(topics = ["ownership_transfer_started"])]
pub struct OwnershipTransferStarted {
    #[topic]
    pub new_owner: Address,
}

#[contractevent(topics = ["ownership_transferred"])]
pub struct OwnershipTransferred {
    #[topic]
    pub new_owner: Address,
}

#[contract]
pub struct TilcaiVault;

#[contractimpl]
impl TilcaiVault {
    /// `usdc`: the Stellar Asset Contract of USDC. `owner` should be a multisig or a smart
    /// account: it can empty the vault. `operator`: the relayer's account.
    pub fn __constructor(
        e: &Env,
        usdc: Address,
        owner: Address,
        operator: Address,
        max_per_disbursement: i128,
        daily_limit: i128,
    ) {
        check_limits(e, max_per_disbursement, daily_limit);
        let s = e.storage().instance();
        s.set(&DataKey::Usdc, &usdc);
        s.set(&DataKey::Owner, &owner);
        s.set(&DataKey::Operator, &operator);
        s.set(&DataKey::MaxPerDisbursement, &max_per_disbursement);
        s.set(&DataKey::DailyLimit, &daily_limit);
        s.set(&DataKey::Paused, &false);
        OperatorChanged { operator }.publish(e);
        LimitsChanged { max_per_disbursement, daily_limit }.publish(e);
    }

    /// Pays `amount` USDC to `to` for the purchase `disbursement_id`.
    ///
    /// The id makes the payout idempotent: submitting it again fails instead of paying twice,
    /// so a retried or duplicated relayer transaction is harmless.
    pub fn disburse(e: &Env, disbursement_id: BytesN<32>, to: Address, amount: i128) {
        touch(e);
        let operator: Address = get(e, &DataKey::Operator);
        operator.require_auth();

        if get::<bool>(e, &DataKey::Paused) {
            panic_with_error!(e, VaultError::Paused);
        }
        if to == e.current_contract_address() {
            panic_with_error!(e, VaultError::InvalidRecipient);
        }
        if amount <= 0 {
            panic_with_error!(e, VaultError::ZeroAmount);
        }
        let key = DataKey::Payout(disbursement_id.clone());
        if e.storage().persistent().has(&key) {
            panic_with_error!(e, VaultError::AlreadyDisbursed);
        }
        if amount > get::<i128>(e, &DataKey::MaxPerDisbursement) {
            panic_with_error!(e, VaultError::AboveDisbursementLimit);
        }
        if amount > available_today(e) {
            panic_with_error!(e, VaultError::AboveDailyLimit);
        }
        let usdc: Address = get(e, &DataKey::Usdc);
        let token = token::Client::new(e, &usdc);
        let this = e.current_contract_address();
        if amount > token.balance(&this) {
            panic_with_error!(e, VaultError::InsufficientBalance);
        }

        // State first, transfer after: the id is recorded even if a later step were to fail.
        let day = DataKey::PaidOn(today(e));
        let spent: i128 = e.storage().persistent().get(&day).unwrap_or(0);
        e.storage().persistent().set(&day, &(spent + amount));
        e.storage()
            .persistent()
            .set(&key, &Payout { to: to.clone(), amount });
        let max = e.storage().max_ttl();
        e.storage().persistent().extend_ttl(&key, max / 2, max);
        e.storage().persistent().extend_ttl(&day, max / 2, max);

        token.transfer(&this, &to, &amount);
        Disbursed { disbursement_id, to, amount }.publish(e);
    }

    // ── Reads ────────────────────────────────────────────────────────────────

    /// What was paid for a disbursement id, if it was paid.
    pub fn payout(e: &Env, disbursement_id: BytesN<32>) -> Option<Payout> {
        touch(e);
        e.storage().persistent().get(&DataKey::Payout(disbursement_id))
    }

    /// Amount paid for a disbursement id; zero means it has not been paid.
    pub fn disbursed_amount(e: &Env, disbursement_id: BytesN<32>) -> i128 {
        Self::payout(e, disbursement_id).map(|p| p.amount).unwrap_or(0)
    }

    /// What can still be paid out today under the daily limit.
    pub fn available_today(e: &Env) -> i128 {
        touch(e);
        available_today(e)
    }

    pub fn usdc(e: &Env) -> Address {
        touch(e);
        get(e, &DataKey::Usdc)
    }

    pub fn owner(e: &Env) -> Address {
        touch(e);
        get(e, &DataKey::Owner)
    }

    pub fn operator(e: &Env) -> Address {
        touch(e);
        get(e, &DataKey::Operator)
    }

    pub fn paused(e: &Env) -> bool {
        touch(e);
        get(e, &DataKey::Paused)
    }

    pub fn max_per_disbursement(e: &Env) -> i128 {
        touch(e);
        get(e, &DataKey::MaxPerDisbursement)
    }

    pub fn daily_limit(e: &Env) -> i128 {
        touch(e);
        get(e, &DataKey::DailyLimit)
    }

    // ── Owner ────────────────────────────────────────────────────────────────

    pub fn set_operator(e: &Env, new_operator: Address) {
        touch(e);
        owner_auth(e);
        e.storage().instance().set(&DataKey::Operator, &new_operator);
        OperatorChanged { operator: new_operator }.publish(e);
    }

    pub fn set_limits(e: &Env, max_per_disbursement: i128, daily_limit: i128) {
        touch(e);
        owner_auth(e);
        check_limits(e, max_per_disbursement, daily_limit);
        let s = e.storage().instance();
        s.set(&DataKey::MaxPerDisbursement, &max_per_disbursement);
        s.set(&DataKey::DailyLimit, &daily_limit);
        LimitsChanged { max_per_disbursement, daily_limit }.publish(e);
    }

    pub fn pause(e: &Env) {
        touch(e);
        owner_auth(e);
        e.storage().instance().set(&DataKey::Paused, &true);
        PausedChanged { paused: true }.publish(e);
    }

    pub fn unpause(e: &Env) {
        touch(e);
        owner_auth(e);
        e.storage().instance().set(&DataKey::Paused, &false);
        PausedChanged { paused: false }.publish(e);
    }

    /// Takes funds back out (works while paused). Also recovers any token sent by mistake.
    pub fn withdraw(e: &Env, token: Address, to: Address, amount: i128) {
        touch(e);
        owner_auth(e);
        token::Client::new(e, &token).transfer(&e.current_contract_address(), &to, &amount);
        Withdrawn { token, to, amount }.publish(e);
    }

    /// First step of a change of owner: the new owner has to accept. A mistyped address
    /// cannot take the vault. There is no way to renounce: without an owner nobody could
    /// withdraw and the funds would be stuck.
    pub fn transfer_ownership(e: &Env, new_owner: Address) {
        touch(e);
        owner_auth(e);
        e.storage().instance().set(&DataKey::PendingOwner, &new_owner);
        OwnershipTransferStarted { new_owner }.publish(e);
    }

    pub fn accept_ownership(e: &Env) {
        touch(e);
        let pending: Address = match e.storage().instance().get(&DataKey::PendingOwner) {
            Some(p) => p,
            None => panic_with_error!(e, VaultError::NoPendingOwner),
        };
        pending.require_auth();
        let s = e.storage().instance();
        s.set(&DataKey::Owner, &pending);
        s.remove(&DataKey::PendingOwner);
        OwnershipTransferred { new_owner: pending }.publish(e);
    }
}

fn get<T: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(e: &Env, key: &DataKey) -> T {
    e.storage().instance().get(key).unwrap()
}

fn owner_auth(e: &Env) {
    get::<Address>(e, &DataKey::Owner).require_auth();
}

fn today(e: &Env) -> u64 {
    e.ledger().timestamp() / DAY_SECONDS
}

fn available_today(e: &Env) -> i128 {
    let spent: i128 = e
        .storage()
        .persistent()
        .get(&DataKey::PaidOn(today(e)))
        .unwrap_or(0);
    let limit: i128 = get(e, &DataKey::DailyLimit);
    if spent >= limit {
        0
    } else {
        limit - spent
    }
}

fn check_limits(e: &Env, max_per_disbursement: i128, daily_limit: i128) {
    if max_per_disbursement < 0 || daily_limit < 0 {
        panic_with_error!(e, VaultError::InvalidLimits);
    }
}

fn touch(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(30 * DAY_LEDGERS, 90 * DAY_LEDGERS);
}
