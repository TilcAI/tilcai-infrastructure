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
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: number }>).map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
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
