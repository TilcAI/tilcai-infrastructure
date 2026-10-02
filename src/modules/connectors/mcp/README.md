# MCP connector (phase 2 · owner: Omar)

Exposes the twelve tools specified in `tilcai-core/docs/mcp-intent-mandate.md`
(`tilcai-mcp-v1`) over Streamable HTTP, authenticated per the MCP authorization
spec (OAuth 2.1, audience-bound tokens, no token passthrough).

Handlers call the same services as the HTTP API (`../../crosschain`, commerce,
authorization…); they never take amounts, recipients or approvals from the model.
Crosschain payment is reached through `request_purchase` when the selected
payment source is `eip155:43113` (CCTP), never through a free "send money" tool.
