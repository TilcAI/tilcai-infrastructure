// Phase 2 (local identity) · Phase 4 (ERC-8004 link) · owner: Omar.
// An agent identity is NOT a financial account (report §12.2).
import type { AgentId, PrincipalId } from "tilcai-core/src/contracts.ts";

export interface AgentIdentity {
  id: AgentId;
  operatorPrincipalId: PrincipalId;
  role: "buyer" | "seller";
  /** OAuth client / MCP client that acts for this agent. */
  clientId: string;
  capabilities: readonly string[];
  /** Optional ERC-8004 registration (CAIP-10 registry + agentId), resolved by identity/. */
  erc8004?: { registry: string; agentId: string };
  status: "ACTIVE" | "SUSPENDED";
}

export interface AgentRegistry {
  get(id: AgentId): Promise<AgentIdentity | undefined>;
  byClientId(clientId: string): Promise<AgentIdentity | undefined>;
  register(a: Omit<AgentIdentity, "id" | "status">): Promise<AgentIdentity>;
  suspend(id: AgentId, reason: string): Promise<void>;
}
