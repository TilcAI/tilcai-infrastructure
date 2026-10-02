// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TilcaiCctpRouter, IUsdc3009, ITokenMessengerV2} from "../src/TilcaiCctpRouter.sol";

/// Minimal EIP-3009 token + CCTP messenger mocks: the router logic is what is under test.
contract MockUsdc {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => mapping(bytes32 => bool)) public used;
    bytes32 constant TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public DOMAIN_SEPARATOR = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), keccak256("USDC"), keccak256("2"), block.chainid, address(this)));

    function mint(address to, uint256 v) external { balanceOf[to] += v; }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transferFrom(address f, address t, uint256 v) external returns (bool) {
        allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[t] += v; return true;
    }
    function burn(address from, uint256 v) external { balanceOf[from] -= v; }
    function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        require(to == msg.sender, "caller must be payee");
        require(block.timestamp > validAfter && block.timestamp < validBefore, "auth window");
        require(!used[from][nonce], "used");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(TYPEHASH, from, to, value, validAfter, validBefore, nonce))));
        require(ecrecover(digest, v, r, s) == from, "bad sig");
        used[from][nonce] = true;
        balanceOf[from] -= value; balanceOf[to] += value;
    }
}

contract MockMessenger {
    MockUsdc public usdc;
    uint256 public lastAmount; bytes32 public lastRecipient; bytes32 public lastCaller; bytes32 public lastHookHash; uint32 public lastDomain; uint256 public lastMaxFee; uint32 public lastFinality;
    constructor(MockUsdc u) { usdc = u; }
    function depositForBurnWithHook(uint256 amount, uint32 d, bytes32 r, address, bytes32 c, uint256 mf, uint32 fin, bytes calldata h) external {
        usdc.transferFrom(msg.sender, address(this), amount);
        usdc.burn(address(this), amount);
        lastAmount = amount; lastRecipient = r; lastCaller = c; lastHookHash = keccak256(h); lastDomain = d; lastMaxFee = mf; lastFinality = fin;
    }
}

contract TilcaiCctpRouterTest is Test {
    MockUsdc usdc; MockMessenger messenger; TilcaiCctpRouter router;
    uint256 payerKey = 0xA11CE; address payer; address relayer = address(0xBEEF);
    bytes32 constant FWD = bytes32(uint256(0xF0F0));
    bytes32 constant PID = keccak256("payment-1");

    function setUp() public {
        usdc = new MockUsdc(); messenger = new MockMessenger(usdc);
        router = new TilcaiCctpRouter(IUsdc3009(address(usdc)), ITokenMessengerV2(address(messenger)));
        payer = vm.addr(payerKey); usdc.mint(payer, 5_000_000);
        vm.warp(1_000_000);
    }

    function _route(bytes memory hook) internal pure returns (TilcaiCctpRouter.Route memory) {
        return TilcaiCctpRouter.Route(27, FWD, FWD, 0, 2000, hook);
    }

    function _sign(bytes32 nonce, uint256 amount, uint256 key) internal view returns (TilcaiCctpRouter.Authorization memory a) {
        a.validAfter = block.timestamp - 1; a.validBefore = block.timestamp + 600;
        bytes32 th = keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), keccak256(abi.encode(th, vm.addr(key), address(router), amount, a.validAfter, a.validBefore, nonce))));
        (a.v, a.r, a.s) = vm.sign(key, digest);
    }

    function test_relayer_submits_payer_signature_and_burns() public {
        TilcaiCctpRouter.Route memory r = _route("merchant-hook");
        TilcaiCctpRouter.Authorization memory a = _sign(router.authorizationNonce(PID, 1_000_000, r), 1_000_000, payerKey);
        vm.prank(relayer);
        router.payWithAuthorization(PID, payer, 1_000_000, r, a);
        assertEq(messenger.lastAmount(), 1_000_000);
        assertEq(messenger.lastRecipient(), FWD);
        assertEq(messenger.lastHookHash(), keccak256("merchant-hook"));
        assertEq(usdc.balanceOf(payer), 4_000_000);
        assertEq(usdc.balanceOf(address(router)), 0, "router never keeps funds");
    }

    function test_relayer_cannot_change_hook_recipient_amount_or_fee() public {
        TilcaiCctpRouter.Route memory r = _route("merchant-hook");
        TilcaiCctpRouter.Authorization memory a = _sign(router.authorizationNonce(PID, 1_000_000, r), 1_000_000, payerKey);
        TilcaiCctpRouter.Route memory evil = _route("attacker-hook");
        vm.expectRevert(bytes("bad sig"));
        router.payWithAuthorization(PID, payer, 1_000_000, evil, a);

        evil = _route("merchant-hook"); evil.mintRecipient = bytes32(uint256(0xBAD));
        vm.expectRevert(bytes("bad sig"));
        router.payWithAuthorization(PID, payer, 1_000_000, evil, a);

        evil = _route("merchant-hook"); evil.maxFee = 999_999;
        vm.expectRevert(bytes("bad sig"));
        router.payWithAuthorization(PID, payer, 1_000_000, evil, a);

        vm.expectRevert(bytes("bad sig"));
        router.payWithAuthorization(PID, payer, 2_000_000, r, a);
        vm.expectRevert(bytes("bad sig"));
        router.payWithAuthorization(keccak256("other"), payer, 1_000_000, r, a);
    }

    function test_replay_and_wrong_signer_and_expired() public {
        TilcaiCctpRouter.Route memory r = _route("h");
        TilcaiCctpRouter.Authorization memory a = _sign(router.authorizationNonce(PID, 1_000_000, r), 1_000_000, payerKey);
        router.payWithAuthorization(PID, payer, 1_000_000, r, a);
        vm.expectRevert(bytes("used"));
        router.payWithAuthorization(PID, payer, 1_000_000, r, a);

        bytes32 n2 = router.authorizationNonce(keccak256("p2"), 1_000_000, r);
        TilcaiCctpRouter.Authorization memory forged = _sign(n2, 1_000_000, 0xB0B);
        vm.expectRevert(bytes("bad sig"));
        router.payWithAuthorization(keccak256("p2"), payer, 1_000_000, r, forged);

        TilcaiCctpRouter.Authorization memory ok = _sign(n2, 1_000_000, payerKey);
        vm.warp(block.timestamp + 601);
        vm.expectRevert(bytes("auth window"));
        router.payWithAuthorization(keccak256("p2"), payer, 1_000_000, r, ok);
    }

    function testFuzz_signature_binds_amount(uint96 amount) public {
        amount = uint96(bound(amount, 1, 5_000_000));
        TilcaiCctpRouter.Route memory r = _route("h");
        TilcaiCctpRouter.Authorization memory a = _sign(router.authorizationNonce(PID, amount, r), amount, payerKey);
        router.payWithAuthorization(PID, payer, amount, r, a);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(payer), 5_000_000 - amount);
    }
}
