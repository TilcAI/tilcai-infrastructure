// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

interface IUsdc3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface ITokenMessengerV2 {
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}

/// @title TilcaiCctpRouter
/// @notice Gasless source leg of a TilcAI crosschain payment. The payer signs an EIP-3009
///         `ReceiveWithAuthorization` (no gas, no allowance); anyone, normally the OpenZeppelin
///         Relayer, submits it. The router pulls the USDC and burns it through CCTP V2 toward
///         the Stellar CctpForwarder.
/// @dev The EIP-3009 nonce commits to the whole CCTP destination, so a relayer cannot redirect
///      the funds: it can only submit exactly what the payer signed. The router has no owner, no
///      upgrade path and never keeps a balance.
contract TilcaiCctpRouter {
    IUsdc3009 public immutable usdc;
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

    constructor(IUsdc3009 usdc_, ITokenMessengerV2 tokenMessenger_) {
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
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @notice The EIP-3009 nonce the payer must sign for this payment.
    function authorizationNonce(bytes32 paymentId, uint256 amount, Route calldata route) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                "tilcai-cctp-router-v1",
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
            authorizationNonce(paymentId, amount, route), auth.v, auth.r, auth.s
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
