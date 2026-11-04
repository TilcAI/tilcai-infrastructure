#!/usr/bin/env node
/**
 * N-07 staging protocol: synthetic writes through the QR Simple mock (moves no money) and a check of
 * what the database kept. See deploy/CLOUD_RUN_SINGLE_WRITER.md. Never point it at production.
 *
 *   node deploy/staging/n07-writer.mjs write  --url https://tilcai-staging… --run e1 --rate 5 --minutes 10 --out e1.jsonl
 *   node deploy/staging/n07-writer.mjs verify --url https://tilcai-staging… --run e1 --acks e1.jsonl
 *
 * write   logs in to the mock and creates QRs with the gloss "N07 <run> #<n>", one line per answer in --out:
 *         {n, at, status, qrId?, error?}. A 401 means the token, stored in the database, is gone: it logs in
 *         again and records it ({relogin: true}), which is itself evidence of a database that changed.
 * verify  reads every `qr.created` event of the run (GET /v1/monitor/events, operator key in TILCAI_API_KEY)
 *         and compares it with the acknowledged writes: acknowledged but missing (lost), and stored but never
 *         acknowledged (the answer was lost). Prints a JSON summary; exits 1 if anything was lost.
 *
 * Environment: QR_MOCK_EMAIL and QR_MOCK_PASSWORD (write), TILCAI_API_KEY (verify).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    run: { type: "string" },
    rate: { type: "string", default: "5" },
    minutes: { type: "string", default: "10" },
    out: { type: "string" },
    acks: { type: "string" },
  },
});
const [mode] = positionals;
const base = (values.url ?? "").replace(/\/$/, "");
const run = values.run ?? "";
if (!base || !/^[a-z0-9-]{1,20}$/i.test(run) || !["write", "verify"].includes(mode ?? "")) {
  console.error("usage: n07-writer.mjs write|verify --url <TilcAI staging> --run <id> [--rate n --minutes m --out f | --acks f]");
  process.exit(64);
}
const gloss = (n) => `N07 ${run} #${n}`;

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

async function login() {
  const r = await call("POST", "/mock/vendis/api/v1/login", { body: { email: process.env.QR_MOCK_EMAIL, password: process.env.QR_MOCK_PASSWORD, token_name: `n07-${run}` } });
  if (r.status !== 200 || !r.json.access_token) throw new Error(`login failed: HTTP ${r.status}`);
  return r.json.access_token;
}

/** The mock's expiration format: Bolivia time (UTC-4), "YYYY-MM-DD HH:mm:ss". */
const vendisDate = (minutesFromNow) => new Date(Date.now() + minutesFromNow * 60_000 - 4 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

async function write() {
  if (!values.out) throw new Error("--out is required");
  const everyMs = 1000 / Math.max(Number(values.rate), 0.1);
  const until = Date.now() + Number(values.minutes) * 60_000;
  const log = (line) => appendFileSync(values.out, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
  let token = await login();
  let n = 0;
  while (Date.now() < until) {
    const started = Date.now();
    n++;
    const body = { device_id: 1, amount: 1, modify_amount: false, is_multi_use: false, qr_expiration: vendisDate(60), description: gloss(n) };
    try {
      let r = await call("POST", "/mock/vendis/api/v1/devices/simple-qr/generate", { token, body });
      if (r.status === 401) {
        log({ n, relogin: true });
        token = await login();
        r = await call("POST", "/mock/vendis/api/v1/devices/simple-qr/generate", { token, body });
      }
      log({ n, status: r.status, ...(r.status === 200 ? { qrId: r.json.data?.qr_id } : { error: String(r.json.message ?? r.json.raw ?? "").slice(0, 120) }) });
    } catch (e) {
      log({ n, status: 0, error: e instanceof Error ? e.message : String(e) });
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(everyMs - (Date.now() - started), 0)));
  }
  console.log(JSON.stringify({ run, written: n, out: values.out }));
}

async function verify() {
  if (!values.acks) throw new Error("--acks is required");
  const key = process.env.TILCAI_API_KEY;
  if (!key) throw new Error("TILCAI_API_KEY (an operator key) is required to read the event log");
  const lines = readFileSync(values.acks, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const acked = new Map(lines.filter((l) => l.status === 200).map((l) => [l.n, l.qrId]));

  const stored = new Map(); // n → qrId, as this database tells it
  for (let after = 0; ; ) {
    const r = await call("GET", `/v1/monitor/events?type=qr.created&after=${after}&limit=500`, { token: key });
    if (r.status !== 200) throw new Error(`events: HTTP ${r.status}`);
    const events = r.json.events ?? [];
    for (const e of events) {
      // The mock prefixes the gloss with the device's serial ("SN0001 N07 e1 #12").
      const m = /(?:^|\s)N07 (\S+) #(\d+)$/.exec(String(e.data?.description ?? ""));
      if (m && m[1] === run) stored.set(Number(m[2]), e.data.qrId);
    }
    if (events.length < 500) break;
    after = events[events.length - 1].seq;
  }

  const lost = [...acked.keys()].filter((n) => !stored.has(n)).sort((a, b) => a - b);
  // Kept although the client never saw it succeed (the answer was lost): harmless, but it shows where the cut was.
  const unacknowledged = [...stored.keys()].filter((n) => !acked.has(n)).sort((a, b) => a - b);
  const summary = {
    run,
    acknowledged: acked.size,
    stored: stored.size,
    lost: lost.length,
    lostRange: lost.length ? [lost[0], lost[lost.length - 1]] : null,
    lastStored: stored.size ? Math.max(...stored.keys()) : null,
    unacknowledged: unacknowledged.length,
    relogins: lines.filter((l) => l.relogin).length,
    failedWrites: lines.filter((l) => l.status !== undefined && l.status !== 200).length,
    examples: { lost: lost.slice(0, 10), unacknowledged: unacknowledged.slice(0, 10) },
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(lost.length ? 1 : 0);
}

await (mode === "write" ? write() : verify()).catch((e) => {
  console.error(`n07-writer: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
