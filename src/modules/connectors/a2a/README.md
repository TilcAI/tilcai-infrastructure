# A2A connector (phase 4 · owner: Omar + Jhamil)

Publishes an Agent Card per business seller agent and maps A2A tasks to the
same commerce operations (quote → order → status). A2A messages reference
`quoteId` / `orderId` / `taskId`; they never carry payment authority.
The card links the agent's ERC-8004 registration when one exists.
