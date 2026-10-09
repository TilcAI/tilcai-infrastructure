// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Account} from "@openzeppelin/contracts/account/Account.sol";
import {ERC7821} from "@openzeppelin/contracts/account/extensions/draft-ERC7821.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ERC7739} from "@openzeppelin/contracts/utils/cryptography/signers/draft-ERC7739.sol";
import {SignerP256} from "@openzeppelin/contracts/utils/cryptography/signers/SignerP256.sol";
import {SignerWebAuthn} from "@openzeppelin/contracts/utils/cryptography/signers/SignerWebAuthn.sol";

/// @title TilcaiAccount
/// @notice Smart account whose only owner is a passkey (WebAuthn, P-256). TilcAI issues it and pays
///         its fees; it is never a signer and has no power over it.
/// @dev OpenZeppelin Contracts 5.7 does the work: `Account` (ERC-4337, EntryPoint v0.9),
///      `SignerWebAuthn` (the assertion is checked on-chain, user verification required),
///      `ERC7739` (ERC-1271 signatures bound to this account, so a signature cannot be replayed
///      on another account of the same owner) and `ERC7821` (batched calls).
///
///      The owner authorizes in two ways:
///       - ERC-1271: it signs typed data of an application. This is how it pays with USDC's
///         EIP-3009 `transferWithAuthorization` / `receiveWithAuthorization(…, bytes)`.
///       - ERC-4337: it signs a UserOperation that the EntryPoint executes.
///
///      Accounts are minimal clones of one implementation, initialized by the factory in the same
///      transaction that creates them. No upgrade path.
contract TilcaiAccount is Initializable, Account, EIP712, ERC7739, SignerWebAuthn, ERC7821, ERC721Holder, ERC1155Holder {
    /// @dev Owner of the implementation contract itself, which nobody may operate: a point of the
    ///      curve with no known private key. x = sha256("TilcaiAccount implementation: no owner")
    ///      mod p, y = its even square root (TilcaiAccount.t.sol recomputes it).
    bytes32 public constant NO_OWNER_QX = 0x33aa13df825b03566dcd9dc3dbdd0587b210e81d4aa4dffee09e19dc9b0628dc;
    bytes32 public constant NO_OWNER_QY = 0x4bbd6ac3c78a81eabbeb9430f5993f4137b22d8162ebdd3549d1456cd3899554;

    event OwnerSet(bytes32 qx, bytes32 qy);

    constructor() EIP712("TilcaiAccount", "1") SignerP256(NO_OWNER_QX, NO_OWNER_QY) {
        _disableInitializers();
    }

    /// @notice Sets the passkey that owns the account. Called once, by the factory, right after cloning.
    function initialize(bytes32 qx, bytes32 qy) external initializer {
        _setOwner(qx, qy);
    }

    /// @notice Replaces the owner's passkey. Only the account itself can ask for it, that is, the
    ///         current owner through a call it signed.
    function setOwner(bytes32 qx, bytes32 qy) external onlyEntryPointOrSelf {
        _setOwner(qx, qy);
    }

    function _setOwner(bytes32 qx, bytes32 qy) private {
        _setSigner(qx, qy);
        emit OwnerSet(qx, qy);
    }

    /// @dev Batches run when the EntryPoint executes a UserOperation the owner signed, or when the
    ///      account calls itself.
    function _erc7821AuthorizedExecutor(
        address caller,
        bytes32 mode,
        bytes calldata executionData
    ) internal view override returns (bool) {
        return caller == address(entryPoint()) || super._erc7821AuthorizedExecutor(caller, mode, executionData);
    }
}
