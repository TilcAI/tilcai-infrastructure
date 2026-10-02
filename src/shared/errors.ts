import { createContractError, type ContractError, type ErrorCode } from "tilcai-core/src/contracts.ts";

/**
 * Domain error carrying a public `tilcai-shared-v1` envelope. `detail` is for
 * internal logs only and is never serialized to clients.
 */
export class DomainError extends Error {
  readonly contract: ContractError;
  readonly httpStatus: number;
  readonly detail: string | undefined;

  constructor(code: ErrorCode, detail?: string, httpStatus?: number) {
    super(code);
    this.contract = createContractError(code);
    this.detail = detail;
    this.httpStatus = httpStatus ?? defaultStatus(code);
  }
}

function defaultStatus(code: ErrorCode): number {
  switch (code) {
    case "INVALID_INPUT":
    case "UNSUPPORTED_VERSION":
      return 400;
    case "UNAUTHENTICATED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "DUPLICATE":
    case "IDEMPOTENCY_CONFLICT":
    case "INVALID_STATE_TRANSITION":
      return 409;
    case "QUOTE_EXPIRED":
      return 410;
    case "SERVICE_UNAVAILABLE":
      return 503;
    case "INTERNAL_ERROR":
      return 500;
    default:
      return 422;
  }
}
