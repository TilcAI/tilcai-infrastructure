// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title TilcaiVault
/// @notice Holds the USDC that backs purchases paid off-chain (a bank transfer, a QR payment) and
///         pays each one out to the buyer's wallet. The operator, normally the OpenZeppelin
///         Relayer, submits the payouts and pays the gas, so the buyer needs no AVAX.
/// @dev What the operator key can do is bounded on-chain: one payout per disbursement id, a cap
///      per payout and a cap per UTC day. Only the owner can change those limits, replace the
///      operator, pause the payouts or take funds back out. No upgrade path.
contract TilcaiVault is Ownable2Step, Pausable {
    using SafeERC20 for IERC20;

    uint256 private constant DAY = 1 days;

    IERC20 public immutable usdc;
    address public operator;
    uint256 public maxPerDisbursement;
    uint256 public dailyLimit;

    /// @notice Amount paid for a disbursement id. Zero means it has not been paid.
    mapping(bytes32 disbursementId => uint256 amount) public disbursedAmount;
    /// @notice Total paid out in a UTC day (`block.timestamp / DAY`).
    mapping(uint256 day => uint256 amount) public disbursedOn;

    event Disbursed(bytes32 indexed disbursementId, address indexed to, uint256 amount);
    event OperatorChanged(address indexed previousOperator, address indexed newOperator);
    event LimitsChanged(uint256 maxPerDisbursement, uint256 dailyLimit);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error NotOperator(address caller);
    error ZeroAddress();
    error ZeroAmount();
    error InvalidRecipient(address to);
    error AlreadyDisbursed(bytes32 disbursementId);
    error AboveDisbursementLimit(uint256 amount, uint256 limit);
    error AboveDailyLimit(uint256 amount, uint256 available);
    error InsufficientBalance(uint256 amount, uint256 balance);
    error OwnershipCannotBeRenounced();

    constructor(IERC20 usdc_, address owner_, address operator_, uint256 maxPerDisbursement_, uint256 dailyLimit_)
        Ownable(owner_)
    {
        if (address(usdc_) == address(0) || operator_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
        operator = operator_;
        maxPerDisbursement = maxPerDisbursement_;
        dailyLimit = dailyLimit_;
        emit OperatorChanged(address(0), operator_);
        emit LimitsChanged(maxPerDisbursement_, dailyLimit_);
    }

    /// @notice Pays `amount` USDC to `to` for the purchase `disbursementId`.
    /// @dev The id makes the payout idempotent: submitting it again reverts instead of paying twice,
    ///      so a retried or duplicated relayer transaction is harmless.
    function disburse(bytes32 disbursementId, address to, uint256 amount) external whenNotPaused {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        if (to == address(0) || to == address(this)) revert InvalidRecipient(to);
        if (amount == 0) revert ZeroAmount();
        if (disbursedAmount[disbursementId] != 0) revert AlreadyDisbursed(disbursementId);
        if (amount > maxPerDisbursement) revert AboveDisbursementLimit(amount, maxPerDisbursement);
        uint256 available = availableToday();
        if (amount > available) revert AboveDailyLimit(amount, available);
        uint256 balance = usdc.balanceOf(address(this));
        if (amount > balance) revert InsufficientBalance(amount, balance);

        disbursedAmount[disbursementId] = amount;
        disbursedOn[block.timestamp / DAY] += amount;
        usdc.safeTransfer(to, amount);
        emit Disbursed(disbursementId, to, amount);
    }

    /// @notice What can still be paid out today under the daily limit.
    function availableToday() public view returns (uint256) {
        uint256 spent = disbursedOn[block.timestamp / DAY];
        return spent >= dailyLimit ? 0 : dailyLimit - spent;
    }

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        address previous = operator;
        operator = newOperator;
        emit OperatorChanged(previous, newOperator);
    }

    function setLimits(uint256 maxPerDisbursement_, uint256 dailyLimit_) external onlyOwner {
        maxPerDisbursement = maxPerDisbursement_;
        dailyLimit = dailyLimit_;
        emit LimitsChanged(maxPerDisbursement_, dailyLimit_);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Takes funds back out (works while paused). Also recovers any token sent by mistake.
    function withdraw(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit Withdrawn(address(token), to, amount);
    }

    /// @dev Without an owner nobody could withdraw: the funds would be stuck.
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipCannotBeRenounced();
    }
}
