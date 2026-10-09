import { parseArgs } from "node:util";
import { DomainError } from "../../shared/errors.ts";
import { TENANT_SCOPES, type TenantAdmin, type TenantId, type TenantScope } from "./ports.ts";

const USAGE = `usage:
  tenant create --name <name> [--accounts-per-day <n>] [--ops-per-day <n>] [--json]
  tenant key --tenant <tenantId> --label <label> --scopes <${TENANT_SCOPES.join(",")}> [--json]
  tenant list [--json]
  tenant revoke-key --key <keyId>
  tenant suspend --tenant <tenantId>
  tenant activate --tenant <tenantId>

An API key is shown ONCE, when it is issued. Only its SHA-256 is stored: if it is lost, issue another and revoke the old one.`;

/**
 * Operator commands for tenants and their keys. Returns the process exit code.
 * Works on any `TenantAdmin`, so the tests drive it without a process and Postgres can reuse it unchanged.
 */
export async function runTenantCli(admin: TenantAdmin, argv: string[], out: (line: string) => void): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        name: { type: "string" },
        tenant: { type: "string" },
        label: { type: "string" },
        scopes: { type: "string" },
        key: { type: "string" },
        "accounts-per-day": { type: "string" },
        "ops-per-day": { type: "string" },
        json: { type: "boolean", default: false },
      },
    });
  } catch (e) {
    out(`${(e as Error).message}\n${USAGE}`);
    return 64;
  }
  const { values: v, positionals } = parsed;
  const emit = (human: string, data: unknown) => out(v.json ? JSON.stringify(data) : human);
  const need = (value: string | undefined, flag: string): string => {
    if (!value) throw new DomainError("INVALID_INPUT", `--${flag} is required`);
    return value;
  };
  const int = (value: string | undefined, flag: string): number | undefined => {
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) throw new DomainError("INVALID_INPUT", `--${flag} must be a whole number`);
    return Number(value);
  };

  try {
    switch (positionals[0]) {
      case "create": {
        const accountsPerDay = int(v["accounts-per-day"], "accounts-per-day");
        const sponsoredOpsPerDay = int(v["ops-per-day"], "ops-per-day");
        const quota = {
          ...(accountsPerDay !== undefined ? { accountsPerDay } : {}),
          ...(sponsoredOpsPerDay !== undefined ? { sponsoredOpsPerDay } : {}),
        };
        const t = await admin.createTenant({ name: need(v.name, "name"), quota });
        emit(`tenant created: ${t.id}  (${t.name})  quota/day: ${t.quota.accountsPerDay} accounts, ${t.quota.sponsoredOpsPerDay} sponsored operations`, t);
        return 0;
      }
      case "key": {
        const scopes = need(v.scopes, "scopes").split(",").map((s) => s.trim()).filter(Boolean) as TenantScope[];
        const { info, key } = await admin.issueKey(need(v.tenant, "tenant") as TenantId, { label: need(v.label, "label"), scopes });
        emit(
          [
            `key issued for ${info.tenantId}  scopes: ${info.scopes.join(", ")}`,
            `  key id : ${info.id}`,
            `  API key: ${key}`,
            "Copy the API key now. It is not stored and cannot be shown again.",
          ].join("\n"),
          { keyId: info.id, tenantId: info.tenantId, scopes: info.scopes, key },
        );
        return 0;
      }
      case "list": {
        const tenants = await admin.list();
        const rows = [];
        for (const t of tenants) rows.push({ ...t, keys: await admin.listKeys(t.id) });
        emit(
          rows
            .map(
              (t) =>
                `${t.id}  ${t.status.padEnd(9)} ${t.name}  quota/day ${t.quota.accountsPerDay}/${t.quota.sponsoredOpsPerDay}\n` +
                (t.keys.length === 0
                  ? "    (no keys)"
                  : t.keys.map((k) => `    ${k.id}  ${k.hint}…  ${k.label}  [${k.scopes.join(",")}]  ${k.source}${k.revokedAt ? `  REVOKED ${k.revokedAt}` : ""}`).join("\n")),
            )
            .join("\n") || "(no tenants)",
          rows,
        );
        return 0;
      }
      case "revoke-key":
        await admin.revokeKey(need(v.key, "key"));
        emit(`key revoked: ${v.key}`, { revoked: v.key });
        return 0;
      case "suspend":
      case "activate": {
        const t = await admin.setStatus(need(v.tenant, "tenant") as TenantId, positionals[0] === "suspend" ? "SUSPENDED" : "ACTIVE");
        emit(`${t.id} is now ${t.status}`, t);
        return 0;
      }
      default:
        out(USAGE);
        return 64;
    }
  } catch (e) {
    if (e instanceof DomainError) {
      out(`error: ${e.detail ?? e.contract.code}`);
      return 1;
    }
    throw e;
  }
}
