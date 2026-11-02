// Domain contracts for a future MCP adapter; this module exposes no handlers.
import {
  type BusinessId, type ServiceId, type QuoteId, type IntentId, type OrderId,
  type PaymentAttemptId, type OperationState, type OperationReferences,
  type DecisionOutcome, type ReceiptReference, type ContractError, type ErrorCode,
} from "./contracts.ts";
import {
  type Intent, type IntentAuthorization, type PurchaseTerms, type ResourceRef,
  type Sha256Digest, type UtcInstant, type IdempotencyKey, type AtomicAmount, type StellarNetwork,
} from "./authority.ts";

export const MCP_DOMAIN_SCHEMA = "tilcai-mcp-v1";
interface Input { readonly schema: typeof MCP_DOMAIN_SCHEMA }
interface Mutation extends Input { readonly idempotencyKey: IdempotencyKey }
interface Page { readonly cursor?: string; readonly pageSize?: number }
interface ServiceInput extends Input { readonly businessId: BusinessId; readonly serviceId: ServiceId }
interface IntentMutation extends Mutation { readonly intentId: IntentId }
interface OrderSnapshot { readonly state: OperationState; readonly paymentAttemptId?: PaymentAttemptId }

/** Projection to agree with the commerce owner, not the signed Quote itself. */
export interface QuoteSummary {
  readonly quoteId: QuoteId;
  readonly businessId: BusinessId;
  readonly serviceId: ServiceId;
  readonly quoteHash: Sha256Digest;
  readonly purchase: PurchaseTerms;
}

export interface ToolInputs {
  list_businesses: Input & Page;
  get_service: ServiceInput;
  get_availability: ServiceInput & { readonly quantity: number };
  request_quote: ServiceInput & Mutation & { readonly quantity: number };
  create_intent: Mutation & {
    readonly quoteId: QuoteId;
    readonly accountRef: ResourceRef;
    readonly delegation?: Extract<IntentAuthorization, { mode: "DELEGATED" }>;
  };
  prepare_purchase: IntentMutation;
  request_approval: IntentMutation;
  request_purchase: IntentMutation;
  get_order_status: Input & { readonly orderId: OrderId };
  request_cancellation: Mutation & { readonly orderId: OrderId };
  get_budget_status: Input & { readonly budgetRef: ResourceRef };
  get_receipts: Input & Page & { readonly orderId: OrderId };
}

export interface ToolOutputs {
  list_businesses: {
    readonly businesses: readonly { readonly businessId: BusinessId; readonly name: string }[];
    readonly nextCursor?: string;
  };
  get_service: {
    readonly businessId: BusinessId; readonly serviceId: ServiceId; readonly summary: string;
    readonly capabilities: readonly ("quote" | "availability" | "purchase" | "cancellation")[];
  };
  get_availability: {
    readonly businessId: BusinessId; readonly serviceId: ServiceId; readonly quantity: number;
    readonly availability: "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN"; readonly checkedAt: UtcInstant;
  };
  request_quote: QuoteSummary;
  create_intent: { readonly intent: Intent; readonly commitment: Sha256Digest };
  prepare_purchase: {
    readonly references: OperationReferences; readonly state: OperationState; readonly decision: DecisionOutcome;
  };
  request_approval: {
    readonly intentId: IntentId; readonly status: "PENDING";
    readonly commitment: Sha256Digest; readonly expiresAt: UtcInstant;
  };
  request_purchase: OrderSnapshot;
  get_order_status: OrderSnapshot;
  request_cancellation: { readonly orderId: OrderId; readonly status: "REQUESTED" | "REJECTED" | "COMPLETED" };
  get_budget_status: {
    readonly budgetRef: ResourceRef; readonly network: StellarNetwork; readonly assetId: ResourceRef;
    readonly limitAtomic: AtomicAmount; readonly heldAtomic: AtomicAmount;
    readonly consumedAtomic: AtomicAmount; readonly availableAtomic: AtomicAmount;
  };
  get_receipts: { readonly receipts: readonly ReceiptReference[]; readonly nextCursor?: string };
}

export type ToolName = keyof ToolInputs;
export type ToolResult<N extends ToolName> =
  | { readonly schema: typeof MCP_DOMAIN_SCHEMA; readonly ok: true; readonly data: ToolOutputs[N] }
  | { readonly schema: typeof MCP_DOMAIN_SCHEMA; readonly ok: false; readonly error: ContractError };

export type ToolScope =
  | "tilcai:catalog:read" | "tilcai:quotes:write" | "tilcai:intents:write"
  | "tilcai:approvals:request" | "tilcai:purchases:request" | "tilcai:orders:read"
  | "tilcai:orders:cancel" | "tilcai:budgets:read" | "tilcai:receipts:read";

interface ToolDefinition<N extends ToolName> {
  readonly name: N;
  readonly scope: ToolScope;
  readonly effect: "READ" | "PREPARE" | "APPROVAL_REQUEST" | "EXECUTION_REQUEST" | "CANCELLATION_REQUEST";
  readonly authority: "NONE" | "TRUSTED_UI" | "EXACT_OR_VERIFIED_DELEGATION" | "COMMERCIAL_AUTHORITY";
  readonly idempotencyRequired: boolean;
  readonly errors: readonly ErrorCode[];
}

const common = ["INVALID_INPUT", "UNSUPPORTED_VERSION", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "INTERNAL_ERROR"] as const;
const mutation = [...common, "IDEMPOTENCY_CONFLICT"] as const;
const policy = ["PAUSED", "EXPIRED", "NETWORK_OR_ASSET", "RESOURCE", "RECIPIENT", "PAYMENT_LIMIT", "BUDGET"] as const;

// Not a tools/list response: input/output JSON schemas are the future adapter's job.
export const MCP_TOOL_CATALOG = {
  list_businesses: {
    name: "list_businesses", scope: "tilcai:catalog:read", effect: "READ", authority: "NONE",
    idempotencyRequired: false, errors: [...common, "SERVICE_UNAVAILABLE"],
  },
  get_service: {
    name: "get_service", scope: "tilcai:catalog:read", effect: "READ", authority: "NONE",
    idempotencyRequired: false, errors: [...common, "SERVICE_UNAVAILABLE"],
  },
  get_availability: {
    name: "get_availability", scope: "tilcai:catalog:read", effect: "READ", authority: "NONE",
    idempotencyRequired: false, errors: [...common, "SERVICE_UNAVAILABLE"],
  },
  request_quote: {
    name: "request_quote", scope: "tilcai:quotes:write", effect: "PREPARE", authority: "NONE",
    idempotencyRequired: true, errors: mutation,
  },
  create_intent: {
    name: "create_intent", scope: "tilcai:intents:write", effect: "PREPARE", authority: "NONE",
    idempotencyRequired: true, errors: [...mutation, "QUOTE_EXPIRED", "QUOTE_INVALID"],
  },
  prepare_purchase: {
    name: "prepare_purchase", scope: "tilcai:intents:write", effect: "PREPARE", authority: "NONE",
    idempotencyRequired: true, errors: [...mutation, ...policy, "QUOTE_EXPIRED", "QUOTE_INVALID", "INVALID_STATE_TRANSITION"],
  },
  request_approval: {
    name: "request_approval", scope: "tilcai:approvals:request", effect: "APPROVAL_REQUEST", authority: "TRUSTED_UI",
    idempotencyRequired: true, errors: [...mutation, "QUOTE_EXPIRED", "QUOTE_INVALID", "INVALID_STATE_TRANSITION"],
  },
  request_purchase: {
    name: "request_purchase", scope: "tilcai:purchases:request", effect: "EXECUTION_REQUEST", authority: "EXACT_OR_VERIFIED_DELEGATION",
    idempotencyRequired: true, errors: [...mutation, ...policy, "QUOTE_EXPIRED", "QUOTE_INVALID", "APPROVAL_REQUIRED",
      "APPROVAL_INVALID", "DUPLICATE", "INVALID_STATE_TRANSITION", "PAYMENT_FAILED", "PAYMENT_UNCERTAIN"],
  },
  get_order_status: {
    name: "get_order_status", scope: "tilcai:orders:read", effect: "READ", authority: "NONE",
    idempotencyRequired: false, errors: [...common, "SERVICE_UNAVAILABLE"],
  },
  request_cancellation: {
    name: "request_cancellation", scope: "tilcai:orders:cancel", effect: "CANCELLATION_REQUEST", authority: "COMMERCIAL_AUTHORITY",
    idempotencyRequired: true, errors: [...mutation, "APPROVAL_REQUIRED", "INVALID_STATE_TRANSITION"],
  },
  get_budget_status: {
    name: "get_budget_status", scope: "tilcai:budgets:read", effect: "READ", authority: "NONE",
    idempotencyRequired: false, errors: [...common, "SERVICE_UNAVAILABLE"],
  },
  get_receipts: {
    name: "get_receipts", scope: "tilcai:receipts:read", effect: "READ", authority: "NONE",
    idempotencyRequired: false, errors: [...common, "SERVICE_UNAVAILABLE"],
  },
} as const satisfies { readonly [N in ToolName]: ToolDefinition<N> };
