import type { DatabaseSync } from "node:sqlite";
import type { Correlate } from "./relayer-webhook.ts";

/** Finds the TilcAI operation a relayer transaction belongs to, by the id the relayer gave it. */
export function sqliteCorrelate(db: DatabaseSync): Correlate {
  return (relayerTxId) => {
    const payout = db.prepare("SELECT id FROM vault_disbursements WHERE submission_id = ?").get(relayerTxId) as { id: string } | undefined;
    if (payout) return { kind: "vault_disbursement", id: payout.id };
    const payment = db
      .prepare("SELECT id, burn_submission_id FROM crosschain_payments WHERE burn_submission_id = ? OR mint_submission_id = ?")
      .get(relayerTxId, relayerTxId) as { id: string; burn_submission_id: string | null } | undefined;
    if (payment) return { kind: payment.burn_submission_id === relayerTxId ? "crosschain_burn" : "crosschain_mint", id: payment.id };
    return null;
  };
}
