import { keccak256, toHex } from "viem";
import type { Hex } from "../../shared/hex.ts";

/** bytes32 id of a TilcAI disbursement, as the vault of either network records it. */
export const disbursementIdBytes32 = (disbursementId: string): Hex => keccak256(toHex(disbursementId));
