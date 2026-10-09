// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ITokenMessengerV2} from "../src/TilcaiCctpRouter.sol";
import {TilcaiAccount} from "../src/TilcaiAccount.sol";
import {TilcaiAccountFactory} from "../src/TilcaiAccountFactory.sol";
import {TilcaiCctpRouterV2, IUsdc3009Bytes} from "../src/TilcaiCctpRouterV2.sol";
import {MockUsdcBytes, PasskeyTest} from "./SmartAccountHelpers.sol";

contract MockMessengerV2 {
    MockUsdcBytes public usdc;
    uint256 public lastAmount; bytes32 public lastRecipient; bytes32 public lastCaller; bytes32 public lastHookHash; uint32 public lastDomain; uint256 public lastMaxFee; uint32 public lastFinality;
    constructor(MockUsdcBytes u) { usdc = u; }
    function depositForBurnWithHook(uint256 amount, uint32 d, bytes32 r, address, bytes32 c, uint256 mf, uint32 fin, bytes calldata h) external {
        usdc.transferFrom(msg.sender, address(this), amount);
        usdc.burn(address(this), amount);
        lastAmount = amount; lastRecipient = r; lastCaller = c; lastHookHash = keccak256(h); lastDomain = d; lastMaxFee = mf; lastFinality = fin;
    }
}

contract TilcaiCctpRouterV2Test is PasskeyTest {
    MockUsdcBytes usdc; MockMessengerV2 messenger; TilcaiCctpRouterV2 router; TilcaiAccount account;
    uint256 ownerKey = 0xA11CE; uint256 eoaKey = 0xE0A; address relayer = address(0xBEEF);
    bytes32 constant FWD = bytes32(uint256(0xF0F0));
    bytes32 constant PID = keccak256("payment-1");

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new MockUsdcBytes(); messenger = new MockMessengerV2(usdc);
        router = new TilcaiCctpRouterV2(IUsdc3009Bytes(address(usdc)), ITokenMessengerV2(address(messenger)));
        (bytes32 qx, bytes32 qy) = _publicKey(ownerKey);
        account = TilcaiAccount(payable(new TilcaiAccountFactory().createAccount(qx, qy, keccak256("payer"))));
        usdc.mint(address(account), 5_000_000);
        usdc.mint(vm.addr(eoaKey), 5_000_000);
    }

    function _route(bytes memory hook) internal pure returns (TilcaiCctpRouterV2.Route memory) {
        return TilcaiCctpRouterV2.Route(27, FWD, FWD, 0, 2000, hook);
    }

    /// The account's owner signs the pull toward the router with the passkey.
    function _signAccount(bytes32 nonce, uint256 amount, uint256 key) internal view returns (TilcaiCctpRouterV2.Authorization memory a) {
        a.validAfter = block.timestamp - 1; a.validBefore = block.timestamp + 600;
        bytes32 contentsHash = _authorizationHash(usdc.RECEIVE_TYPEHASH(), address(account), address(router), amount, a.validAfter, a.validBefore, nonce);
        a.signature = _signTypedData(key, address(account), usdc.DOMAIN_SEPARATOR(), "ReceiveWithAuthorization", RECEIVE_TYPE, contentsHash);
    }

    function test_relayer_submits_the_account_signature_and_burns() public {
        TilcaiCctpRouterV2.Route memory r = _route("merchant-hook");
        TilcaiCctpRouterV2.Authorization memory a = _signAccount(router.authorizationNonce(PID, 1_000_000, r), 1_000_000, ownerKey);
        vm.prank(relayer);
        router.payWithAuthorization(PID, address(account), 1_000_000, r, a);
        assertEq(messenger.lastAmount(), 1_000_000);
        assertEq(messenger.lastRecipient(), FWD);
        assertEq(messenger.lastCaller(), FWD);
        assertEq(messenger.lastDomain(), 27);
        assertEq(messenger.lastHookHash(), keccak256("merchant-hook"));
        assertEq(usdc.balanceOf(address(account)), 4_000_000);
        assertEq(usdc.balanceOf(address(router)), 0, "router never keeps funds");
    }

    function test_relayer_cannot_redirect_or_resize_what_the_owner_signed() public {
        TilcaiCctpRouterV2.Route memory signed = _route("merchant-hook");
        TilcaiCctpRouterV2.Authorization memory a = _signAccount(router.authorizationNonce(PID, 1_000_000, signed), 1_000_000, ownerKey);
        vm.startPrank(relayer);
        // Another final recipient (hook), another forwarder, another amount, another payment id.
        vm.expectRevert("FiatTokenV2: invalid signature");
        router.payWithAuthorization(PID, address(account), 1_000_000, _route("attacker-hook"), a);
        TilcaiCctpRouterV2.Route memory other = _route("merchant-hook");
        other.mintRecipient = bytes32(uint256(0xBAD));
        vm.expectRevert("FiatTokenV2: invalid signature");
        router.payWithAuthorization(PID, address(account), 1_000_000, other, a);
        vm.expectRevert("FiatTokenV2: invalid signature");
        router.payWithAuthorization(PID, address(account), 2_000_000, signed, a);
        vm.expectRevert("FiatTokenV2: invalid signature");
        router.payWithAuthorization(keccak256("payment-2"), address(account), 1_000_000, signed, a);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(account)), 5_000_000);
    }

    function test_same_authorization_pays_once_and_a_stranger_passkey_never() public {
        TilcaiCctpRouterV2.Route memory r = _route("merchant-hook");
        bytes32 nonce = router.authorizationNonce(PID, 1_000_000, r);
        TilcaiCctpRouterV2.Authorization memory stranger = _signAccount(nonce, 1_000_000, 0xB0B);
        vm.expectRevert("FiatTokenV2: invalid signature");
        router.payWithAuthorization(PID, address(account), 1_000_000, r, stranger);

        TilcaiCctpRouterV2.Authorization memory a = _signAccount(nonce, 1_000_000, ownerKey);
        router.payWithAuthorization(PID, address(account), 1_000_000, r, a);
        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        router.payWithAuthorization(PID, address(account), 1_000_000, r, a);
    }

    function test_expired_authorization_is_refused() public {
        TilcaiCctpRouterV2.Route memory r = _route("merchant-hook");
        TilcaiCctpRouterV2.Authorization memory a = _signAccount(router.authorizationNonce(PID, 1_000_000, r), 1_000_000, ownerKey);
        vm.warp(block.timestamp + 601);
        vm.expectRevert("FiatTokenV2: authorization is expired");
        router.payWithAuthorization(PID, address(account), 1_000_000, r, a);
    }

    /// The `bytes` overload also takes the 65-byte signature of an EOA: v2 serves both kinds of payer.
    function test_an_eoa_can_pay_through_v2_as_well() public {
        TilcaiCctpRouterV2.Route memory r = _route("merchant-hook");
        TilcaiCctpRouterV2.Authorization memory a;
        a.validAfter = block.timestamp - 1; a.validBefore = block.timestamp + 600;
        address payer = vm.addr(eoaKey);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(),
            _authorizationHash(usdc.RECEIVE_TYPEHASH(), payer, address(router), 750_000, a.validAfter, a.validBefore, router.authorizationNonce(PID, 750_000, r))));
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(eoaKey, digest);
        a.signature = abi.encodePacked(rr, ss, v);
        vm.prank(relayer);
        router.payWithAuthorization(PID, payer, 750_000, r, a);
        assertEq(messenger.lastAmount(), 750_000);
        assertEq(usdc.balanceOf(payer), 4_250_000);
    }

    function testFuzz_amount_is_burned_exactly(uint256 amount) public {
        amount = bound(amount, 1, 5_000_000);
        TilcaiCctpRouterV2.Route memory r = _route("merchant-hook");
        TilcaiCctpRouterV2.Authorization memory a = _signAccount(router.authorizationNonce(PID, amount, r), amount, ownerKey);
        router.payWithAuthorization(PID, address(account), amount, r, a);
        assertEq(messenger.lastAmount(), amount);
        assertEq(usdc.balanceOf(address(account)), 5_000_000 - amount);
        assertEq(usdc.balanceOf(address(router)), 0);
    }
}
