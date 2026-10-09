import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../app-context.ts";
import type { StoredSmartAccount } from "../../modules/accounts/ports.ts";
import type { AccountService } from "../../modules/accounts/service.ts";
import type { TenantId } from "../../modules/tenants/ports.ts";
import { DomainError } from "../../shared/errors.ts";
import type { Hex } from "../../shared/hex.ts";

const NETWORKS = ["eip155:43113", "stellar:testnet"] as const;
const AccountBody = z.strictObject({
  network: z.enum(NETWORKS),
  externalRef: z.string().min(1).max(128),
  // The network decides which owners it takes (EVM: a passkey; Stellar: a passkey or an Ed25519 key).
  owner: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("webauthn-p256"),
      /** 65-byte uncompressed P-256 point of the passkey. Public material only. */
      publicKey: z.string().regex(/^0x04[0-9a-fA-F]{128}$/),
      credentialId: z.string().min(1).max(1024),
      rpId: z.string().min(1).max(253),
    }),
    z.strictObject({
      kind: z.literal("ed25519"),
      /** 32-byte Ed25519 public key (the bytes of a Stellar G… address). */
      publicKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    }),
  ]),
});
const ListQuery = z.object({
  network: z.enum(NETWORKS).optional(),
  externalRef: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Smart accounts issued to the calling tenant (fase SCA §7.2):
 *
 *   POST /v1/accounts               issue an account for one of the tenant's holders (Idempotency-Key)
 *   GET  /v1/accounts/:id           the account and its history
 *   GET  /v1/accounts?externalRef=  the tenant's accounts, newest first
 *
 * The owner is a passkey that never leaves the holder's device (on Stellar also an Ed25519 key):
 * TilcAI receives its public key, derives the address from it and pays the deployment. An account of another tenant is "not found".
 */
export function registerAccountRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  h: { tenantOf(req: FastifyRequest): TenantId; idemKey(req: FastifyRequest): string; send(reply: FastifyReply, status: number, body: unknown): FastifyReply },
): void {
  const service = (): AccountService => {
    if (!ctx.accountService) throw new DomainError("SERVICE_UNAVAILABLE", "accounts not configured (ACCOUNT_FACTORY_FUJI or ACCOUNT_FACTORY_STELLAR)");
    return ctx.accountService;
  };
  const explorer = (a: StoredSmartAccount) => ctx.nets.byId(a.network)?.explorer;
  const publicAccount = (a: StoredSmartAccount) => ({
    id: a.id,
    externalRef: a.externalRef,
    network: a.network,
    address: a.address,
    owner: a.owner,
    state: a.state,
    codeRef: a.codeRef,
    deployTxHash: a.deployTxHash ?? null,
    lastError: a.lastError ?? null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  });
  const links = (a: StoredSmartAccount) => ({
    address: `${explorer(a)}/${a.network === "stellar:testnet" ? "contract" : "address"}/${a.address}`,
    deployTx: a.deployTxHash ? `${explorer(a)}/tx/${a.deployTxHash}` : null,
  });

  app.post("/v1/accounts", async (req, reply) => {
    const body = AccountBody.parse(req.body);
    const r = await service().create({
      tenantId: h.tenantOf(req),
      network: body.network,
      externalRef: body.externalRef,
      owner: { ...body.owner, publicKey: body.owner.publicKey as Hex },
      idempotencyKey: h.idemKey(req),
    });
    return h.send(reply, r.replayed ? 200 : 201, {
      account: publicAccount(r.account),
      links: links(r.account),
      next: r.account.state === "ACTIVE" ? "the account is deployed and can sign" : "the address is final and can receive funds now; poll GET /v1/accounts/:id until state is ACTIVE before asking it to sign",
    });
  });

  app.get<{ Params: { id: string } }>("/v1/accounts/:id", async (req, reply) => {
    const v = await service().view(h.tenantOf(req), req.params.id);
    return h.send(reply, 200, { account: publicAccount(v.account), links: links(v.account), events: v.events });
  });

  app.get("/v1/accounts", async (req, reply) => {
    const q = ListQuery.parse(req.query);
    const accounts = await service().list(h.tenantOf(req), { limit: q.limit, ...(q.network ? { network: q.network } : {}), ...(q.externalRef ? { externalRef: q.externalRef } : {}) });
    return h.send(reply, 200, { accounts: accounts.map(publicAccount) });
  });
}
