import { sameHex, type Hex } from "../../shared/hex.ts";
import { decodeForwarderHookData, evmToBytes32 } from "./cctp/encoding.ts";
import type { CctpMessageV2 } from "./cctp/message.ts";
import type { RouteQuote } from "./domain.ts";
import type { DepositForBurnEvent, RouterPaymentEvent } from "./ports.ts";

/**
 * Pure checks that bind on-chain evidence to the quote. A mismatch list is
 * returned instead of throwing so the reason is recorded verbatim.
 */
/** `depositor`: the payer for direct burns, the router for gasless ones. */
export function checkDepositForBurn(ev: DepositForBurnEvent, q: RouteQuote, depositor: Hex | null): string[] {
  const out: string[] = [];
  if (!sameHex(ev.burnToken, q.burnToken)) out.push("burnToken");
  if (ev.amount !== q.burnAmountAtomic) out.push("amount");
  if (ev.destinationDomain !== q.destinationDomain) out.push("destinationDomain");
  if (!sameHex(ev.mintRecipient, q.target.mintRecipient)) out.push("mintRecipient");
  if (!sameHex(ev.destinationCaller, q.target.destinationCaller)) out.push("destinationCaller");
  if (ev.maxFee > q.maxFeeAtomic) out.push("maxFee");
  if (ev.minFinalityThreshold !== q.finality) out.push("minFinalityThreshold");
  if (!sameHex(ev.hookData, q.target.hookData)) out.push("hookData");
  if (depositor && !sameHex(ev.depositor, depositor)) out.push("depositor");
  return out;
}

export function checkAttestedMessage(m: CctpMessageV2, q: RouteQuote, sender: Hex | null): string[] {
  const out: string[] = [];
  if (m.sourceDomain !== q.sourceDomain) out.push("sourceDomain");
  if (m.destinationDomain !== q.destinationDomain) out.push("destinationDomain");
  if (!sameHex(m.destinationCaller, q.target.destinationCaller)) out.push("destinationCaller");
  if (!sameHex(m.body.burnToken, evmToBytes32(q.burnToken))) out.push("burnToken");
  if (!sameHex(m.body.mintRecipient, q.target.mintRecipient)) out.push("mintRecipient");
  if (m.body.amount !== q.burnAmountAtomic) out.push("amount");
  if (m.body.feeExecuted > m.body.maxFee || m.body.maxFee > q.maxFeeAtomic) out.push("fee");
  if (sender && !sameHex(m.body.messageSender, evmToBytes32(sender))) out.push("messageSender");
  try {
    const hook = decodeForwarderHookData(m.body.hookData);
    if (hook.version !== 0 || hook.recipient !== q.payTo) out.push("forwardRecipient");
  } catch {
    out.push("hookData");
  }
  // Merchant must receive at least the quoted amount after Circle's fee (6 → 7 decimals).
  const minted7 = (m.body.amount - m.body.feeExecuted) * 10n;
  if (minted7 < q.destinationAmountAtomic) out.push("destinationAmount");
  return out;
}

/** The router event ties the burn to a TilcAI payment and to the payer who signed the authorization. */
export function checkRouterPayment(ev: RouterPaymentEvent | undefined, q: RouteQuote, paymentId32: Hex, payer: Hex | null): string[] {
  if (!ev) return ["routerEvent"];
  const out: string[] = [];
  if (!sameHex(ev.paymentId, paymentId32)) out.push("paymentId");
  if (payer && !sameHex(ev.payer, payer)) out.push("payer");
  if (ev.amount !== q.burnAmountAtomic) out.push("routerAmount");
  if (ev.destinationDomain !== q.destinationDomain) out.push("routerDomain");
  if (!sameHex(ev.mintRecipient, q.target.mintRecipient)) out.push("routerRecipient");
  return out;
}
