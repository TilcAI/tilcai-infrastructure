# Jobs

- `apps/worker` (phase 1): crosschain reconciliation loop (`CrosschainPaymentService.processDue`).
- Phase 2: x402 attempt reconciliation, budget hold expiry (KEEP_HELD rules), webhook dedupe.
- Phase 5: scheduler for mandate-bound recurring purchases (idempotent occurrences, re-evaluated each run).
