/**
 * QR collection gateway from the terminal (uses the configured providers, no HTTP server).
 *
 *   npm run qr -- providers                         order, configuration and mode
 *   npm run qr -- generate [--provider ID] [--amount 0.10] [--description TEXT] [--out DIR]
 *                                                    without --provider: principal first, then the fallbacks
 *   npm run qr -- probe [--amount 0.10] [--out DIR]  one QR per configured provider, each forced
 *   npm run qr -- status <id>
 *   npm run qr -- cancel <id>
 *
 * State goes to DATABASE_PATH: point it at a scratch database to leave the instance's alone
 * (DATABASE_PATH=/tmp/qr.db npm run qr -- probe). With QR_MOCK_ENABLED=true everything goes to the mock.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAppContext } from "../../app-context.ts";
import { LEGACY_TENANT_ID } from "../../modules/tenants/ports.ts";
import { CollectionError, type Collection, type ProviderId } from "../../modules/qrcollect/domain.ts";
import { centsToAmount } from "../../modules/qrsimple/domain.ts";

const [cmd = "providers", ...rest] = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i]!;
  if (a.startsWith("--")) flags.set(a.slice(2), rest[++i] ?? "");
  else positional.push(a);
}

const ctx = createAppContext("qr-cli");
const svc = ctx.qrCollect;
if (!svc) {
  console.error("No QR provider is configured: set BANECO_*/ATC_* credentials or QR_MOCK_ENABLED=true.");
  process.exit(2);
}
const out = flags.get("out");
if (out) mkdirSync(out, { recursive: true });

const show = (c: Collection) => {
  console.log(`  id=${c.id} provider=${c.provider} ref=${c.providerRef} status=${c.status} amount=Bs ${centsToAmount(c.amountCents)} expires=${c.expiresAt}`);
  for (const a of c.attempts) console.log(`    · ${a.provider}: ${a.ok ? "ok" : a.skipped ?? `${a.kind}: ${a.error}`} (${a.ms} ms)`);
  if (out) {
    const file = join(out, `${c.provider}-${c.id}.png`);
    writeFileSync(file, Buffer.from(c.imageBase64, "base64"));
    console.log(`    imagen: ${file}`);
  }
};

async function issue(provider?: ProviderId): Promise<boolean> {
  try {
    const c = await svc!.create({
      tenantId: LEGACY_TENANT_ID,
      amount: flags.get("amount") ?? "0.10",
      description: flags.get("description") ?? "Prueba TilcAI",
      ...(provider ? { provider } : {}),
    });
    console.log(`PASS  generate${provider ? ` (${provider})` : ""}`);
    show(c);
    return true;
  } catch (e) {
    console.log(`FAIL  generate${provider ? ` (${provider})` : ""}: ${e instanceof Error ? e.message : e}`);
    if (e instanceof CollectionError) for (const a of e.attempts) console.log(`    · ${a.provider}: ${a.skipped ?? `${a.kind}: ${a.error}`} (${a.ms} ms)`);
    return false;
  }
}

let ok = true;
switch (cmd) {
  case "providers":
    console.log(`mode: ${svc.mode}`);
    for (const p of svc.providers()) console.log(`  ${p.role.padEnd(9)} ${p.id.padEnd(10)} ${p.configured ? "configured" : "NOT configured"}  ${p.label}`);
    break;
  case "generate":
    ok = await issue(flags.get("provider") as ProviderId | undefined);
    break;
  case "probe":
    for (const p of svc.providers()) {
      if (!p.configured) {
        console.log(`SKIP  ${p.id}: not configured`);
        continue;
      }
      ok = (await issue(p.id)) && ok;
    }
    break;
  case "status": {
    const id = positional[0];
    if (!id) {
      console.error("usage: qr status <id>");
      process.exit(2);
    }
    const c = await svc.get(LEGACY_TENANT_ID, id);
    show(c);
    if (c.status === "PAID") console.log(`  pagado Bs ${centsToAmount(c.paidAmountCents ?? c.amountCents)} por ${c.payerName ?? "?"} (${c.payerBank ?? "?"})`);
    break;
  }
  case "cancel": {
    const id = positional[0];
    if (!id) {
      console.error("usage: qr cancel <id>");
      process.exit(2);
    }
    try {
      show(await svc.cancel(LEGACY_TENANT_ID, id));
    } catch (e) {
      console.log(`FAIL  cancel: ${e instanceof Error ? e.message : e}`);
      ok = false;
    }
    break;
  }
  default:
    console.error(`unknown command ${cmd}`);
    ok = false;
}
process.exit(ok ? 0 : 1);
