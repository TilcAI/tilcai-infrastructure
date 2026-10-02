// Phase 2 · owner: Omar. Root of authority: person or organization (report §5, §16.1).
import type { PrincipalId } from "tilcai-core/src/contracts.ts";

export interface Principal {
  id: PrincipalId;
  kind: "person" | "organization";
  displayName: string;
  /** Authentication subject from the identity provider (OAuth/OIDC), never a wallet signature alone. */
  authSubject: string;
  createdAt: string;
}

export interface PrincipalRepository {
  get(id: PrincipalId): Promise<Principal | undefined>;
  byAuthSubject(subject: string): Promise<Principal | undefined>;
  create(p: Omit<Principal, "id" | "createdAt">): Promise<Principal>;
}
