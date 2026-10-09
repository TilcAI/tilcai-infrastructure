// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {ITokenMessengerV2} from "./TilcaiCctpRouter.sol";

interface IUsdc3009Bytes {
    /// @dev The `bytes signature` overload: USDC checks it with ECDSA for an EOA and through
    ///      ERC-1271 (`isValidSignature`) when `from` is a contract.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title TilcaiCctpRouterV2
/// @notice TilcaiCctpRouter for payers that are smart accounts. Same flow and same guarantees:
///         the payer signs an EIP-3009 `ReceiveWithAuthorization`, anyone submits it, the router
///         pulls the USDC and burns it through CCTP V2 toward the Stellar CctpForwarder.
/// @dev The only difference with v1 is the signature, taken as `bytes`: a TilcaiAccount answers
///      for it through ERC-1271 with its owner's passkey. An EOA can pay through it as well.
///      The EIP-3009 nonce still commits to the whole CCTP destination. No owner, no upgrades,
///      no balance.
contract TilcaiCctpRouterV2 {
    IUsdc3009Bytes public immutable usdc;
    ITokenMessengerV2 public immutable tokenMessenger;

    event CrosschainPayment(
        bytes32 indexed paymentId,
        address indexed payer,
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        bytes32 hookDataHash
    );

    error ResidualBalance();

    constructor(IUsdc3009Bytes usdc_, ITokenMessengerV2 tokenMessenger_) {
        usdc = usdc_;
        tokenMessenger = tokenMessenger_;
    }

    struct Route {
        uint32 destinationDomain;
        bytes32 mintRecipient;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
        bytes hookData;
    }

    struct Authorization {
        uint256 validAfter;
        uint256 validBefore;
        bytes signature;
    }

    /// @notice The EIP-3009 nonce the payer must sign for this payment.
    function authorizationNonce(bytes32 paymentId, uint256 amount, Route calldata route) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                "tilcai-cctp-router-v2",
                paymentId,
                amount,
                route.destinationDomain,
                route.mintRecipient,
                route.destinationCaller,
                route.maxFee,
                route.minFinalityThreshold,
                keccak256(route.hookData)
            )
        );
    }

    function payWithAuthorization(
        bytes32 paymentId,
        address payer,
        uint256 amount,
        Route calldata route,
        Authorization calldata auth
    ) external {
        usdc.receiveWithAuthorization(
            payer, address(this), amount, auth.validAfter, auth.validBefore,
            authorizationNonce(paymentId, amount, route), auth.signature
        );
        usdc.approve(address(tokenMessenger), amount);
        tokenMessenger.depositForBurnWithHook(
            amount,
            route.destinationDomain,
            route.mintRecipient,
            address(usdc),
            route.destinationCaller,
            route.maxFee,
            route.minFinalityThreshold,
            route.hookData
        );
        if (usdc.balanceOf(address(this)) != 0) revert ResidualBalance();
        emit CrosschainPayment(paymentId, payer, amount, route.destinationDomain, route.mintRecipient, keccak256(route.hookData));
    }
}
