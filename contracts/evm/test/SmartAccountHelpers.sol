// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// USDC as far as EIP-3009 goes, with the `bytes signature` overloads of FiatToken v2.2: ECDSA for
/// an EOA and ERC-1271 for a contract.
contract MockUsdcBytes {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    bytes32 public constant TRANSFER_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR = keccak256(
        abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("USD Coin"),
            keccak256("2"),
            block.chainid,
            address(this)
        )
    );

    function mint(address to, uint256 v) external { balanceOf[to] += v; }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transfer(address t, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[t] += v; return true; }
    function transferFrom(address f, address t, uint256 v) external returns (bool) {
        allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[t] += v; return true;
    }
    function burn(address from, uint256 v) external { balanceOf[from] -= v; }

    function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature) external {
        _use(TRANSFER_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature);
    }

    function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature) external {
        require(to == msg.sender, "FiatTokenV2: caller must be the payee");
        _use(RECEIVE_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature);
    }

    function _use(bytes32 typehash, address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata signature) private {
        require(block.timestamp > validAfter, "FiatTokenV2: authorization is not yet valid");
        require(block.timestamp < validBefore, "FiatTokenV2: authorization is expired");
        require(!authorizationState[from][nonce], "FiatTokenV2: authorization is used or canceled");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce))));
        require(SignatureChecker.isValidSignatureNow(from, digest, signature), "FiatTokenV2: invalid signature");
        authorizationState[from][nonce] = true;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}

/// What a browser and an authenticator do when a passkey signs, plus the ERC-7739 envelope a
/// TilcaiAccount expects around a typed-data signature.
abstract contract PasskeyTest is Test {
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    string internal constant ORIGIN = "https://optipagos.optus.lat";
    bytes1 internal constant UP_UV = 0x05; // user present + user verified

    string internal constant TRANSFER_TYPE =
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";
    string internal constant RECEIVE_TYPE =
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)";

    function _publicKey(uint256 key) internal pure returns (bytes32 qx, bytes32 qy) {
        (uint256 x, uint256 y) = vm.publicKeyP256(key);
        return (bytes32(x), bytes32(y));
    }

    /// The assertion of `navigator.credentials.get({ challenge })`, encoded as the account reads it.
    function _assert(uint256 key, bytes32 challenge) internal pure returns (bytes memory) {
        return _assertWith(key, challenge, UP_UV, "webauthn.get", false);
    }

    function _assertWith(uint256 key, bytes32 challenge, bytes1 flags, string memory ceremony, bool highS) internal pure returns (bytes memory) {
        bytes memory authenticatorData = abi.encodePacked(sha256("optipagos.optus.lat"), flags, uint32(7));
        string memory clientDataJSON = string.concat(
            '{"type":"', ceremony, '","challenge":"', Base64.encodeURL(abi.encodePacked(challenge)), '","origin":"', ORIGIN, '","crossOrigin":false}'
        );
        (bytes32 r, bytes32 s) = vm.signP256(key, sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJSON)))));
        // Authenticators return either root; the chain only takes the low one.
        bool isHigh = uint256(s) > P256_N / 2;
        if (isHigh != highS) s = bytes32(P256_N - uint256(s));
        uint256 typeIndex = 1; // {"type":…
        uint256 challengeIndex = 11 + bytes(ceremony).length; // {"type":"<ceremony>","challenge":…
        return abi.encode(r, s, challengeIndex, typeIndex, authenticatorData, clientDataJSON);
    }

    /// EIP-712 hash of the account's own domain fields, as ERC-7739 nests them.
    function _accountDomainBytes(address account) internal view returns (bytes memory) {
        return abi.encode(keccak256("TilcaiAccount"), keccak256("1"), block.chainid, account, bytes32(0));
    }

    /// What the passkey really signs when an app asks the account to sign `contents`: the app's
    /// typed data wrapped in a `TypedDataSign` that names this account.
    function _nestedHash(address account, bytes32 appSeparator, string memory contentsName, string memory contentsType, bytes32 contentsHash) internal view returns (bytes32) {
        bytes32 typehash = keccak256(
            abi.encodePacked("TypedDataSign(", contentsName, " contents,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)", contentsType)
        );
        bytes32 structHash = keccak256(abi.encodePacked(typehash, contentsHash, _accountDomainBytes(account)));
        return keccak256(abi.encodePacked("\x19\x01", appSeparator, structHash));
    }

    /// The ERC-1271 signature of the account for an app's typed data, signed by `key`.
    function _signTypedData(uint256 key, address account, bytes32 appSeparator, string memory contentsName, string memory contentsType, bytes32 contentsHash) internal view returns (bytes memory) {
        bytes memory assertion = _assert(key, _nestedHash(account, appSeparator, contentsName, contentsType, contentsHash));
        return abi.encodePacked(assertion, appSeparator, contentsHash, contentsType, uint16(bytes(contentsType).length));
    }

    function _authorizationHash(bytes32 typehash, address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce));
    }
}
