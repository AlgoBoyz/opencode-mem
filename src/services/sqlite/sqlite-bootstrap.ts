/**
 * SQLite binding bootstrap — works under Bun and Node.
 *
 * Resolution order:
 *   1. Bun runtime → `bun:sqlite` (built-in, fastest, zero-install)
 *   2. Node runtime → `node:sqlite` `DatabaseSync` (built-in, Node 22.5+ experimental,
 *      stable in Node 24+)
 *   3. Fallback → `better-sqlite3` (peer dependency, full native binary)
 *
 * Required because opencode 1.15.x loads plugins under Node, not Bun — `bun:sqlite`
 * is a Bun-only built-in and Node's ESM loader rejects the `bun:` URL scheme.
 *
 * The detection runs once at first call; the resolved Database class is cached.
 */
import { createRequire } from "node:module";

// We don't import types from "bun:sqlite" here because that ambient import
// breaks Node-side type-checking when @types/bun is not installed. Callers
// treat the return value as an opaque sqlite-style Database constructor.
type DatabaseCtor = new (filename?: string, options?: unknown) => unknown;

let Database: DatabaseCtor | undefined;

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

export function getDatabase(): DatabaseCtor {
  if (Database) return Database;

  const req = createRequire(import.meta.url);

  if (isBun) {
    Database = req("bun:sqlite").Database as DatabaseCtor;
    return Database;
  }

  // Node runtime — try built-in `node:sqlite` first. It exposes `DatabaseSync`
  // with the synchronous prepare/all/get/close API surface that matches
  // bun:sqlite. One gap: bun:sqlite (and better-sqlite3) expose `db.run(sql)`
  // for executing a single SQL statement without bindings — used throughout
  // this project for PRAGMA and CREATE INDEX setup. `node:sqlite`'s
  // DatabaseSync uses `db.exec(sql)` for that surface, so we subclass to
  // alias `db.run(sql)` onto `db.exec(sql)` (param-bound `db.run(sql, ...)`
  // is preserved for any future callers, falling back to a prepared statement).
  try {
    interface NodeStatementSync {
      run(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
    }
    interface NodeDatabaseSync {
      exec(sql: string): unknown;
      prepare(sql: string): NodeStatementSync;
      close(): void;
    }
    type NodeDatabaseSyncCtor = new (filename?: string, options?: unknown) => NodeDatabaseSync;
    const DatabaseSync = (req("node:sqlite") as { DatabaseSync: NodeDatabaseSyncCtor })
      .DatabaseSync;
    class DatabaseSyncCompat extends DatabaseSync {
      run(sql: string, ...params: unknown[]): unknown {
        if (params.length === 0) {
          return this.exec(sql);
        }
        return this.prepare(sql).run(...params);
      }
      // bun:sqlite and better-sqlite3 expose `db.transaction(fn)` that returns
      // a callable wrapping `fn` in BEGIN/COMMIT (auto-ROLLBACK on throw).
      // `node:sqlite`'s DatabaseSync has no equivalent. Used by
      // `api-handlers.handleAddMemory` and `services/client.addMemory`, so
      // POST /api/memories and any auto-capture path crash without it.
      //
      // Single-mode semantics only (BEGIN); the `.deferred` / `.immediate` /
      // `.exclusive` variants from better-sqlite3 are not exercised by this
      // codebase.
      transaction<Fn extends (...args: unknown[]) => unknown>(fn: Fn): Fn {
        const self = this;
        const wrapped = function (this: unknown, ...args: Parameters<Fn>): ReturnType<Fn> {
          self.exec("BEGIN");
          try {
            const result = fn.apply(this, args) as ReturnType<Fn>;
            self.exec("COMMIT");
            return result;
          } catch (err) {
            try {
              self.exec("ROLLBACK");
            } catch {
              /* rollback failures after partial state are best-effort */
            }
            throw err;
          }
        };
        return wrapped as unknown as Fn;
      }
    }
    Database = DatabaseSyncCompat as unknown as DatabaseCtor;
    return Database;
  } catch {
    // node:sqlite isn't available (Node < 22.5, or experimental flag not set
    // in some embedded runtimes). Fall back to better-sqlite3 — wire-compatible
    // API, requires a native postinstall but ships prebuilt binaries for
    // common platforms.
    try {
      const betterSqlite = req("better-sqlite3") as DatabaseCtor;
      Database = betterSqlite;
      return Database;
    } catch (error) {
      throw new Error(
        "opencode-mem: no SQLite binding available. Install better-sqlite3, " +
          "or run on Node ≥22.5 with `--experimental-sqlite`, or use Bun. " +
          `Underlying error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
