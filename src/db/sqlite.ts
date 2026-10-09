import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations.ts";

/**
 * Durable store for phase 1 (single host, single writer process group).
 * WAL + busy timeout allow the API and the worker to share the file.
 * The repositories are behind interfaces so Postgres can replace this (plan §6).
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // busy_timeout FIRST: with the pragma order reversed, a process opening the file while another one is
  // starting up (WAL recovery, a migration) failed at once with "database is locked" instead of waiting.
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

/**
 * Applies the pending migrations, each in its own transaction. `upTo` stops after that migration id
 * (tests use it to build a database as an older release left it).
 */
export function migrate(db: DatabaseSync, upTo: number = Number.POSITIVE_INFINITY): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: number }>).map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (done.has(m.id) || m.id > upTo) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      // Another process may have applied it between the list above and the lock we now hold.
      if (db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(m.id)) {
        db.exec("COMMIT");
        continue;
      }
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(m.id, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

/** Runs `fn` inside an IMMEDIATE transaction (serializes writers). */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
