// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {TilcaiAccount} from "./TilcaiAccount.sol";

/// @title TilcaiAccountFactory
/// @notice Creates TilcaiAccount clones at an address derived from the owner's passkey and a salt.
/// @dev The address commits to the owner: nobody, TilcAI included, can put another owner at an
///      address that may already hold funds. Anyone may call `createAccount`; whoever does it,
///      the result is the same account with the same owner, so a front-run changes nothing.
contract TilcaiAccountFactory {
    using Clones for address;

    /// @notice The code every account runs.
    address public immutable implementation;

    event AccountCreated(address indexed account, bytes32 indexed salt, bytes32 qx, bytes32 qy);

    constructor() {
        implementation = address(new TilcaiAccount());
    }

    /// @notice Address of the account of `(qx, qy)` for `salt`, deployed or not.
    function getAddress(bytes32 qx, bytes32 qy, bytes32 salt) public view returns (address) {
        return implementation.predictDeterministicAddress(_salt(qx, qy, salt), address(this));
    }

    /// @notice Deploys the account if it does not exist yet and returns its address.
    function createAccount(bytes32 qx, bytes32 qy, bytes32 salt) external returns (address account) {
        bytes32 cloneSalt = _salt(qx, qy, salt);
        account = implementation.predictDeterministicAddress(cloneSalt, address(this));
        if (account.code.length == 0) {
            implementation.cloneDeterministic(cloneSalt);
            // Same transaction as the clone: there is never an account without its owner.
            TilcaiAccount(payable(account)).initialize(qx, qy);
            emit AccountCreated(account, salt, qx, qy);
        }
    }

    function _salt(bytes32 qx, bytes32 qy, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(qx, qy, salt));
    }
}
