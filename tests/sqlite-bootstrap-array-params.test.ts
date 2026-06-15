import { describe, it, expect } from "bun:test";
import { getDatabase } from "../src/services/sqlite/sqlite-bootstrap.js";

/**
 * Regression for `Unknown named parameter '0'`.
 *
 * `db.run(sql, [a, b])` — passing a single array of bind values — is valid
 * better-sqlite3 / bun:sqlite usage and is used by
 * services/ai/session/ai-session-manager.ts (e.g. `cleanupExpiredSessions`,
 * `addMessage`, `deleteSession`, `clearMessages`).
 *
 * Under Node, getDatabase() resolves to the `DatabaseSyncCompat` wrapper around
 * node:sqlite. Its `run(sql, ...params)` forwarded `this.prepare(sql).run(...params)`,
 * so a single array argument reached the statement as one object value;
 * node:sqlite then read its indices ("0", "1", …) as named parameters and threw
 * `Unknown named parameter '0'`. opencode 1.15.x loads plugins under Node, so the
 * auto-capture path crashed there while passing under Bun.
 *
 * Note on runtime: under `bun test` getDatabase() returns bun:sqlite, which accepts
 * arrays natively — so this asserts runtime parity. Run under Node (node:sqlite) to
 * reproduce/guard the original regression.
 */
describe("sqlite-bootstrap: db.run with a single array of params", () => {
  function freshDb() {
    const Database = getDatabase() as unknown as new (filename?: string) => {
      exec(sql: string): unknown;
      run(sql: string, ...params: unknown[]): unknown;
      prepare(sql: string): { get(...params: unknown[]): any; all(...params: unknown[]): any[] };
    };
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER, label TEXT)");
    return db;
  }

  it("binds a single-element array positionally", () => {
    const db = freshDb();
    db.run("INSERT INTO t (v) VALUES (?)", [42]);
    const row = db.prepare("SELECT v FROM t").get();
    expect(row.v).toBe(42);
  });

  it("binds a multi-element array positionally", () => {
    const db = freshDb();
    db.run("INSERT INTO t (v, label) VALUES (?, ?)", [7, "seven"]);
    const row = db.prepare("SELECT v, label FROM t").get();
    expect(row.v).toBe(7);
    expect(row.label).toBe("seven");
  });

  it("still supports spread positional params", () => {
    const db = freshDb();
    db.run("INSERT INTO t (v, label) VALUES (?, ?)", 9, "nine");
    const row = db.prepare("SELECT v, label FROM t").get();
    expect(row.v).toBe(9);
    expect(row.label).toBe("nine");
  });

  it("still execs paramless statements", () => {
    const db = freshDb();
    db.run("INSERT INTO t (v) VALUES (1)");
    const row = db.prepare("SELECT COUNT(*) AS n FROM t").get();
    expect(row.n).toBe(1);
  });
});
