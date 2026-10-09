// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {TilcaiVault} from "../src/TilcaiVault.sol";

contract TestUsdc is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract TilcaiVaultTest is Test {
    TestUsdc usdc;
    TilcaiVault vault;
    address owner = address(0xA11CE);
    address operator = address(0xBEEF);
    address buyer = address(0xB0B);
    uint256 constant MAX = 100e6;
    uint256 constant DAILY = 250e6;
    bytes32 constant ID = keccak256("vault_disbursement_1");

    event Disbursed(bytes32 indexed disbursementId, address indexed to, uint256 amount);

    function setUp() public {
        usdc = new TestUsdc();
        vault = new TilcaiVault(IERC20(address(usdc)), owner, operator, MAX, DAILY);
        usdc.mint(address(vault), 1_000e6);
        vm.warp(1_760_000_000);
    }

    function _disburse(bytes32 id, address to, uint256 amount) internal {
        vm.prank(operator);
        vault.disburse(id, to, amount);
    }

    function test_operator_pays_the_buyer() public {
        vm.expectEmit(true, true, false, true, address(vault));
        emit Disbursed(ID, buyer, 10e6);
        _disburse(ID, buyer, 10e6);
        assertEq(usdc.balanceOf(buyer), 10e6);
        assertEq(usdc.balanceOf(address(vault)), 990e6);
        assertEq(vault.disbursedAmount(ID), 10e6);
        assertEq(vault.availableToday(), DAILY - 10e6);
    }

    function test_same_id_never_pays_twice() public {
        _disburse(ID, buyer, 10e6);
        vm.expectRevert(abi.encodeWithSelector(TilcaiVault.AlreadyDisbursed.selector, ID));
        _disburse(ID, buyer, 10e6);
        // Not even with another recipient or amount.
        vm.expectRevert(abi.encodeWithSelector(TilcaiVault.AlreadyDisbursed.selector, ID));
        _disburse(ID, address(0xCAFE), 1e6);
        assertEq(usdc.balanceOf(buyer), 10e6);
    }

    function test_only_the_operator_disburses() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TilcaiVault.NotOperator.selector, owner));
        vault.disburse(ID, buyer, 1e6);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(TilcaiVault.NotOperator.selector, buyer));
        vault.disburse(ID, buyer, 1e6);
    }

    function test_rejects_bad_recipient_and_zero_amount() public {
        vm.expectRevert(abi.encodeWithSelector(TilcaiVault.InvalidRecipient.selector, address(0)));
        _disburse(ID, address(0), 1e6);
        vm.expectRevert(abi.encodeWithSelector(TilcaiVault.InvalidRecipient.selector, address(vault)));
        _disburse(ID, address(vault), 1e6);
        vm.expectRevert(TilcaiVault.ZeroAmount.selector);
        _disburse(ID, buyer, 0);
    }

    function test_cap_per_disbursement() public {
        vm.expectRevert(abi.encodeWithSelector(TilcaiVault.AboveDisbursementLimit.selector, MAX + 1, MAX));
        _disburse(ID, buyer, MAX + 1);
        _disburse(ID, buyer, MAX);
        assertEq(usdc.balanceOf(buyer), MAX);
    }

    function test_daily_cap_resets_the_next_day() public {
        _disburse(keccak256("a"), buyer, 100e6);
        _disburse(keccak256("b"), buyer, 100e6);
        vm.expectRevert(abi.encodeWithSelector(TilcaiVault.AboveDailyLimit.selector, 60e6, 50e6));
        _disburse(keccak256("c"), buyer, 60e6);
        _disburse(keccak256("c"), buyer, 50e6);
        assertEq(vault.availableToday(), 0);

        vm.warp(block.timestamp + 1 days);
        assertEq(vault.availableToday(), DAILY);
        _disburse(keccak256("d"), buyer, 60e6);
        assertEq(usdc.balanceOf(buyer), 310e6);
    }

    function test_reverts_when_the_vault_is_short() public {
        vm.prank(owner);
        vault.withdraw(IERC20(address(usdc)), owner, 995e6);
        vm.expectRevert(abi.encodeWithSelector(TilcaiVault.InsufficientBalance.selector, 10e6, 5e6));
        _disburse(ID, buyer, 10e6);
        // Nothing was recorded: the same id pays once the vault is funded again.
        assertEq(vault.disbursedAmount(ID), 0);
        usdc.mint(address(vault), 5e6);
        _disburse(ID, buyer, 10e6);
        assertEq(usdc.balanceOf(buyer), 10e6);
    }

    function test_pause_stops_payouts_but_not_withdrawals() public {
        vm.prank(owner);
        vault.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _disburse(ID, buyer, 1e6);
        vm.prank(owner);
        vault.withdraw(IERC20(address(usdc)), owner, 1_000e6);
        assertEq(usdc.balanceOf(owner), 1_000e6);
        vm.prank(owner);
        vault.unpause();
        usdc.mint(address(vault), 1e6);
        _disburse(ID, buyer, 1e6);
        assertEq(usdc.balanceOf(buyer), 1e6);
    }

    function test_admin_is_owner_only() public {
        bytes memory denied = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator);
        vm.startPrank(operator);
        vm.expectRevert(denied);
        vault.withdraw(IERC20(address(usdc)), operator, 1e6);
        vm.expectRevert(denied);
        vault.setOperator(operator);
        vm.expectRevert(denied);
        vault.setLimits(type(uint256).max, type(uint256).max);
        vm.expectRevert(denied);
        vault.pause();
        vm.stopPrank();
    }

    function test_owner_replaces_operator_and_limits() public {
        address next = address(0x0E0);
        vm.startPrank(owner);
        vault.setOperator(next);
        vault.setLimits(5e6, 8e6);
        vm.expectRevert(TilcaiVault.ZeroAddress.selector);
        vault.setOperator(address(0));
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(TilcaiVault.NotOperator.selector, operator));
        _disburse(ID, buyer, 1e6);
        vm.startPrank(next);
        vm.expectRevert(abi.encodeWithSelector(TilcaiVault.AboveDisbursementLimit.selector, 6e6, 5e6));
        vault.disburse(ID, buyer, 6e6);
        vault.disburse(ID, buyer, 5e6);
        vm.stopPrank();
        assertEq(vault.availableToday(), 3e6);
    }

    function test_ownership_moves_in_two_steps_and_cannot_be_renounced() public {
        address next = address(0x0E1);
        vm.prank(owner);
        vault.transferOwnership(next);
        assertEq(vault.owner(), owner);
        vm.prank(next);
        vault.acceptOwnership();
        assertEq(vault.owner(), next);
        vm.prank(next);
        vm.expectRevert(TilcaiVault.OwnershipCannotBeRenounced.selector);
        vault.renounceOwnership();
    }

    function test_constructor_rejects_zero_addresses() public {
        vm.expectRevert(TilcaiVault.ZeroAddress.selector);
        new TilcaiVault(IERC20(address(0)), owner, operator, MAX, DAILY);
        vm.expectRevert(TilcaiVault.ZeroAddress.selector);
        new TilcaiVault(IERC20(address(usdc)), owner, address(0), MAX, DAILY);
    }

    function testFuzz_disburse(bytes32 id, address to, uint256 amount) public {
        vm.assume(to != address(0) && to != address(vault));
        amount = bound(amount, 1, MAX);
        uint256 before = usdc.balanceOf(to);
        _disburse(id, to, amount);
        assertEq(usdc.balanceOf(to), before + amount);
        assertEq(vault.disbursedAmount(id), amount);
        vm.expectRevert(abi.encodeWithSelector(TilcaiVault.AlreadyDisbursed.selector, id));
        _disburse(id, to, amount);
    }
}
