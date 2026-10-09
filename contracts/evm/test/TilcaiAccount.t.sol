// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/IERC4337.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {SignerP256} from "@openzeppelin/contracts/utils/cryptography/signers/SignerP256.sol";
import {TilcaiAccount} from "../src/TilcaiAccount.sol";
import {TilcaiAccountFactory} from "../src/TilcaiAccountFactory.sol";
import {MockUsdcBytes, PasskeyTest} from "./SmartAccountHelpers.sol";

contract TilcaiAccountTest is PasskeyTest {
    bytes4 constant VALID = IERC1271.isValidSignature.selector;
    bytes4 constant INVALID = 0xffffffff;
    bytes32 constant SALT = keccak256("optus:user-1");

    TilcaiAccountFactory factory;
    MockUsdcBytes usdc;
    TilcaiAccount account;
    uint256 ownerKey = 0xA11CE;
    uint256 otherKey = 0xB0B;
    bytes32 qx;
    bytes32 qy;
    address relayer = address(0xBEEF);
    address merchant = address(0xCAFE);

    function setUp() public {
        vm.warp(1_000_000);
        factory = new TilcaiAccountFactory();
        usdc = new MockUsdcBytes();
        (qx, qy) = _publicKey(ownerKey);
        account = TilcaiAccount(payable(factory.createAccount(qx, qy, SALT)));
        usdc.mint(address(account), 5_000_000);
    }

    // ── Factory ────────────────────────────────────────────────────────────────

    function test_address_is_known_before_deploying_and_commits_to_the_owner() public {
        (bytes32 ox, bytes32 oy) = _publicKey(otherKey);
        address predicted = factory.getAddress(ox, oy, SALT);
        assertEq(predicted.code.length, 0);
        assertTrue(predicted != address(account), "another owner, another address");
        assertTrue(factory.getAddress(qx, qy, keccak256("other salt")) != address(account), "another salt, another address");

        vm.prank(relayer);
        address created = factory.createAccount(ox, oy, SALT);
        assertEq(created, predicted);
        (bytes32 sx, bytes32 sy) = TilcaiAccount(payable(created)).signer();
        assertEq(sx, ox);
        assertEq(sy, oy);
    }

    function test_creating_twice_returns_the_same_account_untouched() public {
        vm.recordLogs();
        vm.prank(address(0xBAD));
        assertEq(factory.createAccount(qx, qy, SALT), address(account));
        assertEq(vm.getRecordedLogs().length, 0, "nothing happens the second time");
        (bytes32 sx, bytes32 sy) = account.signer();
        assertEq(sx, qx);
        assertEq(sy, qy);
    }

    function test_nobody_can_initialize_an_account_again_nor_the_implementation() public {
        (bytes32 ox, bytes32 oy) = _publicKey(otherKey);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        account.initialize(ox, oy);

        TilcaiAccount implementation = TilcaiAccount(payable(factory.implementation()));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        implementation.initialize(ox, oy);
    }

    function test_a_key_that_is_not_on_the_curve_creates_nothing() public {
        vm.expectRevert(abi.encodeWithSelector(SignerP256.SignerP256InvalidPublicKey.selector, bytes32(uint256(1)), bytes32(uint256(2))));
        factory.createAccount(bytes32(uint256(1)), bytes32(uint256(2)), SALT);
        assertEq(factory.getAddress(bytes32(uint256(1)), bytes32(uint256(2)), SALT).code.length, 0);
    }

    /// The implementation's own "owner" is a point derived from a label, so nobody knows its key.
    function test_implementation_owner_is_a_point_with_no_known_key() public view {
        TilcaiAccount implementation = TilcaiAccount(payable(factory.implementation()));
        uint256 p = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF;
        uint256 b = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B;
        uint256 x = uint256(sha256("TilcaiAccount implementation: no owner")) % p;
        uint256 rhs = addmod(addmod(mulmod(mulmod(x, x, p), x, p), mulmod(p - 3, x, p), p), b, p);
        uint256 y = _modexp(rhs, (p + 1) / 4, p);
        assertEq(mulmod(y, y, p), rhs, "x is on the curve");
        if (y % 2 == 1) y = p - y;
        assertEq(implementation.NO_OWNER_QX(), bytes32(x));
        assertEq(implementation.NO_OWNER_QY(), bytes32(y));
        (bytes32 sx, bytes32 sy) = implementation.signer();
        assertEq(sx, bytes32(x));
        assertEq(sy, bytes32(y));
        assertTrue(P256.isValidPublicKey(sx, sy));
    }

    function _modexp(uint256 base, uint256 exponent, uint256 modulus) private view returns (uint256 result) {
        (bool ok, bytes memory out) = address(5).staticcall(abi.encode(uint256(32), uint256(32), uint256(32), base, exponent, modulus));
        require(ok, "modexp");
        result = abi.decode(out, (uint256));
    }

    // ── ERC-1271: the owner signs an app's typed data with the passkey ──────────

    function _transferDigest(address from, uint256 value, bytes32 nonce) private view returns (bytes32 contentsHash, bytes32 digest) {
        contentsHash = _authorizationHash(usdc.TRANSFER_TYPEHASH(), from, merchant, value, 0, block.timestamp + 600, nonce);
        digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), contentsHash));
    }

    function test_owner_signature_over_usdc_typed_data_is_valid() public view {
        (bytes32 contentsHash, bytes32 digest) = _transferDigest(address(account), 1_000_000, keccak256("n1"));
        bytes memory signature = _signTypedData(ownerKey, address(account), usdc.DOMAIN_SEPARATOR(), "TransferWithAuthorization", TRANSFER_TYPE, contentsHash);
        assertEq(account.isValidSignature(digest, signature), VALID);
    }

    function test_another_passkey_or_another_message_is_refused() public view {
        (bytes32 contentsHash, bytes32 digest) = _transferDigest(address(account), 1_000_000, keccak256("n1"));
        bytes32 separator = usdc.DOMAIN_SEPARATOR();

        bytes memory stranger = _signTypedData(otherKey, address(account), separator, "TransferWithAuthorization", TRANSFER_TYPE, contentsHash);
        assertEq(account.isValidSignature(digest, stranger), INVALID, "not the owner");

        bytes memory good = _signTypedData(ownerKey, address(account), separator, "TransferWithAuthorization", TRANSFER_TYPE, contentsHash);
        (, bytes32 otherDigest) = _transferDigest(address(account), 2_000_000, keccak256("n1"));
        assertEq(account.isValidSignature(otherDigest, good), INVALID, "signed for another amount");
        assertEq(account.isValidSignature(digest, ""), INVALID);
        assertEq(account.isValidSignature(digest, hex"deadbeef"), INVALID);
    }

    /// The reason for ERC-7739: the same passkey may own several accounts, and a signature made
    /// for one must be worthless for the others.
    function test_signature_for_one_account_is_worthless_on_another_account_of_the_same_owner() public {
        TilcaiAccount sibling = TilcaiAccount(payable(factory.createAccount(qx, qy, keccak256("second account"))));
        (bytes32 contentsHash, bytes32 digest) = _transferDigest(address(account), 1_000_000, keccak256("n1"));
        bytes memory signature = _signTypedData(ownerKey, address(account), usdc.DOMAIN_SEPARATOR(), "TransferWithAuthorization", TRANSFER_TYPE, contentsHash);
        assertEq(account.isValidSignature(digest, signature), VALID);
        assertEq(sibling.isValidSignature(digest, signature), INVALID);
    }

    /// A passkey assertion over the bare digest, without naming the account, is not accepted.
    function test_assertion_over_the_bare_digest_is_refused() public view {
        (bytes32 contentsHash, bytes32 digest) = _transferDigest(address(account), 1_000_000, keccak256("n1"));
        bytes memory bare = _assert(ownerKey, digest);
        assertEq(account.isValidSignature(digest, bare), INVALID);
        bytes memory wrapped = abi.encodePacked(bare, usdc.DOMAIN_SEPARATOR(), contentsHash, TRANSFER_TYPE, uint16(bytes(TRANSFER_TYPE).length));
        assertEq(account.isValidSignature(digest, wrapped), INVALID);
    }

    function test_assertion_must_be_a_user_verified_webauthn_get_with_a_low_s() public view {
        (bytes32 contentsHash, bytes32 digest) = _transferDigest(address(account), 1_000_000, keccak256("n1"));
        bytes32 separator = usdc.DOMAIN_SEPARATOR();
        bytes32 nested = _nestedHash(address(account), separator, "TransferWithAuthorization", TRANSFER_TYPE, contentsHash);
        bytes memory tail = abi.encodePacked(separator, contentsHash, TRANSFER_TYPE, uint16(bytes(TRANSFER_TYPE).length));

        assertEq(account.isValidSignature(digest, abi.encodePacked(_assertWith(ownerKey, nested, UP_UV, "webauthn.get", false), tail)), VALID);
        // Presence without verification (no fingerprint, no PIN).
        assertEq(account.isValidSignature(digest, abi.encodePacked(_assertWith(ownerKey, nested, 0x01, "webauthn.get", false), tail)), INVALID);
        // A registration ceremony reused as a signature.
        assertEq(account.isValidSignature(digest, abi.encodePacked(_assertWith(ownerKey, nested, UP_UV, "webauthn.create", false), tail)), INVALID);
        // The other root of the same signature.
        assertEq(account.isValidSignature(digest, abi.encodePacked(_assertWith(ownerKey, nested, UP_UV, "webauthn.get", true), tail)), INVALID);
    }

    // ── Paying with USDC (EIP-3009, `bytes signature`) ──────────────────────────

    function test_account_pays_with_transferWithAuthorization_and_the_relayer_only_delivers() public {
        bytes32 nonce = keccak256("pay-1");
        uint256 validBefore = block.timestamp + 600;
        bytes32 contentsHash = _authorizationHash(usdc.TRANSFER_TYPEHASH(), address(account), merchant, 1_250_000, 0, validBefore, nonce);
        bytes memory signature = _signTypedData(ownerKey, address(account), usdc.DOMAIN_SEPARATOR(), "TransferWithAuthorization", TRANSFER_TYPE, contentsHash);

        // Somebody tries to deliver it with another recipient or amount: the signature does not cover that.
        vm.startPrank(relayer);
        vm.expectRevert("FiatTokenV2: invalid signature");
        usdc.transferWithAuthorization(address(account), relayer, 1_250_000, 0, validBefore, nonce, signature);
        vm.expectRevert("FiatTokenV2: invalid signature");
        usdc.transferWithAuthorization(address(account), merchant, 5_000_000, 0, validBefore, nonce, signature);

        usdc.transferWithAuthorization(address(account), merchant, 1_250_000, 0, validBefore, nonce, signature);
        assertEq(usdc.balanceOf(merchant), 1_250_000);
        assertEq(usdc.balanceOf(address(account)), 3_750_000);

        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        usdc.transferWithAuthorization(address(account), merchant, 1_250_000, 0, validBefore, nonce, signature);
        vm.stopPrank();
    }

    function testFuzz_only_the_signed_amount_moves(uint256 amount, uint256 tampered) public {
        amount = bound(amount, 1, 5_000_000);
        tampered = bound(tampered, 1, 5_000_000);
        vm.assume(tampered != amount);
        bytes32 nonce = keccak256(abi.encode("fuzz", amount));
        uint256 validBefore = block.timestamp + 600;
        bytes32 contentsHash = _authorizationHash(usdc.TRANSFER_TYPEHASH(), address(account), merchant, amount, 0, validBefore, nonce);
        bytes memory signature = _signTypedData(ownerKey, address(account), usdc.DOMAIN_SEPARATOR(), "TransferWithAuthorization", TRANSFER_TYPE, contentsHash);

        vm.expectRevert("FiatTokenV2: invalid signature");
        usdc.transferWithAuthorization(address(account), merchant, tampered, 0, validBefore, nonce, signature);
        usdc.transferWithAuthorization(address(account), merchant, amount, 0, validBefore, nonce, signature);
        assertEq(usdc.balanceOf(merchant), amount);
    }

    // ── ERC-4337 and the account's own calls ────────────────────────────────────

    function _userOp(bytes memory signature) private view returns (PackedUserOperation memory op) {
        op.sender = address(account);
        op.signature = signature;
    }

    function test_user_operation_is_valid_only_with_the_owner_passkey_and_only_from_the_entry_point() public {
        bytes32 userOpHash = keccak256("user operation");
        address entryPoint = address(account.entryPoint());
        assertEq(entryPoint, 0x433709009B8330FDa32311DF1C2AFA402eD8D009, "EntryPoint v0.9");

        // Built before the prank: hashing calls a precompile, and that call would consume it.
        PackedUserOperation memory fromOwner = _userOp(_assert(ownerKey, userOpHash));
        PackedUserOperation memory fromStranger = _userOp(_assert(otherKey, userOpHash));

        vm.prank(entryPoint);
        assertEq(account.validateUserOp(fromOwner, userOpHash, 0), 0, "owner: valid");
        vm.prank(entryPoint);
        assertEq(account.validateUserOp(fromStranger, userOpHash, 0), 1, "stranger: signature failure");

        vm.prank(relayer);
        vm.expectRevert();
        account.validateUserOp(fromOwner, userOpHash, 0);
    }

    function test_only_the_entry_point_or_the_account_itself_run_batches() public {
        bytes32 mode = bytes32(bytes1(0x01)); // batch, revert on failure
        bytes memory transfer = abi.encodeCall(usdc.transfer, (merchant, 400_000));
        bytes memory batch = abi.encode(_calls(address(usdc), transfer));

        vm.prank(relayer);
        vm.expectRevert();
        account.execute(mode, batch);
        assertEq(usdc.balanceOf(merchant), 0);

        vm.prank(address(account.entryPoint()));
        account.execute(mode, batch);
        assertEq(usdc.balanceOf(merchant), 400_000);
    }

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    function _calls(address target, bytes memory data) private pure returns (Call[] memory calls) {
        calls = new Call[](1);
        calls[0] = Call(target, 0, data);
    }

    function test_owner_can_move_the_account_to_a_new_passkey_and_nobody_else_can() public {
        (bytes32 nx, bytes32 ny) = _publicKey(otherKey);
        vm.prank(relayer);
        vm.expectRevert();
        account.setOwner(nx, ny);

        // The owner asks for it through a call the account makes to itself.
        bytes memory batch = abi.encode(_calls(address(account), abi.encodeCall(account.setOwner, (nx, ny))));
        vm.prank(address(account.entryPoint()));
        account.execute(bytes32(bytes1(0x01)), batch);
        (bytes32 sx, bytes32 sy) = account.signer();
        assertEq(sx, nx);
        assertEq(sy, ny);

        // From now on the old passkey signs nothing; the address did not change.
        (bytes32 contentsHash, bytes32 digest) = _transferDigest(address(account), 1_000_000, keccak256("after"));
        bytes32 separator = usdc.DOMAIN_SEPARATOR();
        assertEq(account.isValidSignature(digest, _signTypedData(ownerKey, address(account), separator, "TransferWithAuthorization", TRANSFER_TYPE, contentsHash)), INVALID);
        assertEq(account.isValidSignature(digest, _signTypedData(otherKey, address(account), separator, "TransferWithAuthorization", TRANSFER_TYPE, contentsHash)), VALID);
    }
}
