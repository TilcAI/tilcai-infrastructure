// Offline acceptance regressions for the races discovered during the issue review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MonitorService } from "../../src/modules/monitor/service.ts";
import { SqliteMonitorRepository } from "../../src/modules/monitor/repository.ts";
import { openDatabase } from "../../src/db/sqlite.ts";
import { SqliteVaultRepository } from "../../src/modules/vault/repository.ts";
import { VaultDisbursementService } from "../../src/modules/vault/service.ts";
import { networks } from "../../src/config/networks.ts";
import { loadEnv } from "../../src/config/env.ts";
import { silentLogger } from "../../src/shared/log.ts";
import { FakeClock } from "../support/fakes.ts";
import { BUYER, FakeVault, FakeVaultSubmitter } from "../support/vault-fakes.ts";
import { disbursementIdBytes32 } from "../../src/modules/vault/disbursement-id.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "vault-audit-"));
  const file = join(dir, "audit.sqlite");
  const dbs = [openDatabase(file), openDatabase(file)];
  const vault = new FakeVault();
  const submitter = new FakeVaultSubmitter(vault);
  const clock = new FakeClock();
  const service = (repo: SqliteVaultRepository) => new VaultDisbursementService({
    repo, vault, submitter, clock, network: networks(loadEnv({})).avalancheFuji,
    log: silentLogger, options: { pollMs: 1, minConfirmations: 1 },
  });
  const repos = dbs.map(db => new SqliteVaultRepository(db));
  return { file, dbs, repos, vault, submitter, clock, service,
    services: repos.map(service), close: () => {
      dbs.forEach(db => db.close()); rmSync(dir, { recursive: true, force: true });
    } };
}
const input = { to: BUYER, amount: "10", idempotencyKey: "audit-request-01" };

test("#35: confirmation invalidates a snapshot taken before capacity was released", async () => {
  const h = setup();
  try {
    h.vault.balance = 10_000_000n;
    const original = h.vault.status.bind(h.vault);
    let captured!: () => void;
    const snapshot = new Promise<void>(r => { captured = r; });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let reads = 0;
    h.vault.status = async () => {
      const s = await original();
      if (++reads === 1) { captured(); await gate; }
      return s;
    };
    const stale = h.services[1]!.create({ ...input, idempotencyKey: "audit-request-02" });
    await snapshot;
    const first = await h.services[0]!.create(input);
    const confirmed = await h.services[0]!.step(first.disbursement);
    assert.equal(confirmed.state, "CONFIRMED");
    assert.equal(h.repos[0]!.pendingAtomic(h.vault.address()), 0n);
    release();
    await assert.rejects(stale, (e: any) => e.contract.code === "SERVICE_UNAVAILABLE");
    assert.equal(h.repos[0]!.getByIdempotencyKey("audit-request-02"), undefined);
    assert.equal(h.vault.balance, 0n);
    assert.equal(h.repos[0]!.pendingAtomic(h.vault.address()), 0n);
    assert.equal(h.submitter.submits.length, 1);
  } finally { h.close(); }
});

test("#35: same-key request replays even when concurrent admission exhausted capacity", async () => {
  const h = setup();
  try {
    h.vault.balance = 10_000_000n;
    h.submitter.autoMine = false;
    const original = h.vault.status.bind(h.vault);
    let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let reads = 0;
    h.vault.status = async () => {
      if (++reads === 1) { entered(); await gate; }
      return original();
    };
    const slow = h.services[1]!.create(input);
    await started;
    const first = await h.services[0]!.create(input);
    release();
    const replay = await slow;
    assert.equal(replay.replayed, true);
    assert.equal(replay.disbursement.id, first.disbursement.id);
    assert.equal(h.submitter.submits.length, 1);
  } finally { h.close(); }
});

for (const evidence of ["missing", "recipient", "amount", "rpc"] as const) {
  test(`#28: ${evidence} evidence survives SQLite close/reopen and later confirms once`, async () => {
    const h = setup();
    try {
      h.submitter.failNextSubmit = "lost";
      const created = await h.services[0]!.create(input);
      const id = created.disbursement.id;
      const paid = h.vault.paid.get(disbursementIdBytes32(id))!;
      const original = h.vault.findDisbursed.bind(h.vault);
      h.vault.findDisbursed = async id32 => {
        if (evidence === "rpc") throw new Error("offline RPC failure");
        if (evidence === "missing") return null;
        return { ...paid, to: evidence === "recipient" ? `0x${"12".repeat(20)}` as typeof BUYER : paid.to,
          amount: evidence === "amount" ? paid.amount + 1n : paid.amount };
      };
      const unresolved = await h.services[0]!.step(h.repos[0]!.get(id)!);
      assert.equal(unresolved.uncertain, true);
      h.dbs[0]!.close();
      h.dbs[0] = openDatabase(h.file);
      const repo = new SqliteVaultRepository(h.dbs[0]);
      const svc = h.service(repo);
      assert.equal(repo.get(id)!.uncertain, true);
      assert.equal(repo.pendingAtomic(h.vault.address()), 10_000_000n);
      await svc.step(repo.get(id)!);
      assert.equal(h.submitter.submits.length, 1);
      h.vault.findDisbursed = original;
      assert.equal((await svc.step(repo.get(id)!)).state, "CONFIRMED");
      await svc.step(repo.get(id)!);
      assert.equal(repo.events(id).filter(e => e.to === "CONFIRMED").length, 1);
      assert.equal(h.submitter.submits.length, 1);
      assert.equal(repo.pendingAtomic(h.vault.address()), 0n);
    } finally { h.close(); }
  });
}

for (const mode of ["conflict", "rpc", "reference", "confirmed"] as const) {
  test(`#35: concurrent idempotency resolves before ${mode} checks`, async () => {
    const h = setup();
    try {
      h.vault.balance = 10_000_000n;
      h.submitter.autoMine = mode === "confirmed";
      const original = h.vault.status.bind(h.vault);
      let entered!: () => void;
      const started = new Promise<void>(r => { entered = r; });
      let release!: () => void;
      const gate = new Promise<void>(r => { release = r; });
      let reads = 0;
      h.vault.status = async () => {
        if (++reads === 1) {
          entered(); await gate;
          if (mode === "rpc") throw new Error("RPC offline after concurrent admission");
        }
        return original();
      };
      const request = { ...input, ...(mode === "reference" ? { reference: "audit-reference" } : {}) };
      const slow = h.services[1]!.create({ ...request, ...(mode === "conflict" ? { amount: "9" } : {}) });
      await started;
      const first = await h.services[0]!.create(request);
      if (mode === "confirmed") await h.services[0]!.step(first.disbursement);
      release();
      if (mode === "conflict") {
        await assert.rejects(slow, (e: any) => e.contract.code === "IDEMPOTENCY_CONFLICT");
      } else {
        const replay = await slow;
        assert.equal(replay.replayed, true);
        assert.equal(replay.disbursement.id, first.disbursement.id);
        if (mode === "confirmed") assert.equal(replay.disbursement.state, "CONFIRMED");
      }
      assert.equal(h.submitter.submits.length, 1);
    } finally { h.close(); }
  });
}

test("#35: terminal capacity revision survives reopening SQLite", async () => {
  const h = setup();
  try {
    const revision = h.repos[0]!.capacityRevision("eip155:43113", h.vault.address());
    const created = await h.services[0]!.create(input);
    assert.equal(h.repos[0]!.capacityRevision("eip155:43113", h.vault.address()), revision);
    await h.services[0]!.step(created.disbursement);
    const released = h.repos[1]!.capacityRevision("eip155:43113", h.vault.address());
    assert.ok(released > revision);
    h.dbs[0]!.close();
    h.dbs[0] = openDatabase(h.file);
    assert.equal(new SqliteVaultRepository(h.dbs[0]).capacityRevision("eip155:43113", h.vault.address()), released);
    assert.equal(h.repos[1]!.capacityRevision("stellarTestnet", h.vault.address()), 0n);
  } finally { h.close(); }
});


test("#35: rejected admission remains in the SQLite monitor after reservation rollback", async () => {
  const h = setup();
  try {
    h.vault.balance = 0n;
    const monitorRepo = new SqliteMonitorRepository(h.dbs[0]!);
    const svc = new VaultDisbursementService({
      repo: h.repos[0]!, vault: h.vault, submitter: h.submitter, clock: h.clock,
      network: networks(loadEnv({})).avalancheFuji, log: silentLogger,
      events: new MonitorService(monitorRepo, h.clock, silentLogger),
      options: { pollMs: 1, minConfirmations: 1 },
    });
    await assert.rejects(svc.create(input), (e: any) => e.contract.code === "BUDGET");
    assert.equal(h.repos[0]!.getByIdempotencyKey(input.idempotencyKey), undefined);
    assert.equal(h.submitter.submits.length, 0);
    h.dbs[0]!.close();
    h.dbs[0] = openDatabase(h.file);
    const records = new SqliteMonitorRepository(h.dbs[0]).list({ type: "vault.disbursement.rejected" });
    assert.equal(records.length, 1);
    assert.equal(records[0]!.data.code, "BUDGET");
  } finally { h.close(); }
});
