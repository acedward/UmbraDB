/**
 * The worker's view of its PGlite session: a {@link PgliteDatabase} over the real one that
 *
 * - **shares the worker's time** with incoming messages: PGlite runs every statement synchronously inside the worker, so
 *   a sync batch or a scan step that runs statement after statement would keep API requests, `stop` and timers waiting
 *   until it ends. Before a statement, once `sliceMs` have passed since the last turn, it yields one task to the event
 *   loop. The clients' session lock (`src/postgres/pglite-sql.ts`) then serves the requests that arrived in that turn
 *   in arrival order, between whole transactions: an API read waits for at most the block transaction holding the
 *   session, never for the rest of the step;
 * - **counts failed statements** (errors the database reports), for the reopen rule: PGlite 0.5.8 fails every statement
 *   with "stack depth limit exceeded" (SQLSTATE 54001) once a database has failed about 1,700–1,870 statements
 *   (`exec` and `query` respectively, measured), until it is reopened;
 * - **tracks the statement in flight** (since when), for the system snapshot and the logs.
 */
import type { PgliteDatabase, PgliteQueryOptions, PgliteResults } from "../../src/postgres/pglite-sql.js";
import { yieldToEventLoop } from "./scheduler.ts";

/** Default time between two turns given to the event loop while statements run back to back. */
export const DEFAULT_SLICE_MS = 10;

/** SQLSTATE of "stack depth limit exceeded", how the accumulated-failure defect shows itself. */
export const STACK_DEPTH_EXCEEDED = "54001";

export interface SessionMonitorOptions {
  /** Time between two turns given to the event loop (default {@link DEFAULT_SLICE_MS}); 0 yields before every statement. */
  sliceMs?: number;
  /** Monotonic milliseconds (default `performance.now`). */
  now?: () => number;
  /** Gives the event loop one turn (default {@link yieldToEventLoop}). */
  yieldNow?: () => Promise<void>;
  /** A statement failed on the database, with its SQLSTATE. */
  onFailedStatement?: (code: string) => void;
}

export interface MonitoredSession extends PgliteDatabase {
  /** Statements run, failed (reported by the database) and turns given to the event loop since the session opened. */
  readonly counts: { statements: number; failed: number; turns: number };
  /** When the statement in flight started (monotonic milliseconds), or `null`. */
  readonly statementSince: number | null;
}

/** Whether `e` is an error the database reported (a SQLSTATE `code` with a `severity`), as opposed to the client's. */
export function databaseErrorCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const { code, severity } = e as { code?: unknown; severity?: unknown };
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && typeof severity === "string" ? code : undefined;
}

/** `db` with the behaviour described in the module documentation. */
export function monitorSession(db: PgliteDatabase, opts: SessionMonitorOptions = {}): MonitoredSession {
  const sliceMs = opts.sliceMs ?? DEFAULT_SLICE_MS;
  if (!Number.isFinite(sliceMs) || sliceMs < 0) throw new RangeError(`sliceMs must be a non-negative number, got ${sliceMs}`);
  const now = opts.now ?? (() => performance.now());
  const yieldNow = opts.yieldNow ?? yieldToEventLoop;
  const counts = { statements: 0, failed: 0, turns: 0 };
  let lastTurn = now();
  let since: number | null = null;

  async function run<T>(statement: () => Promise<T>): Promise<T> {
    if (now() - lastTurn >= sliceMs) {
      counts.turns++;
      await yieldNow();
      lastTurn = now();
    }
    counts.statements++;
    since = now();
    try {
      return await statement();
    } catch (e) {
      const code = databaseErrorCode(e);
      if (code !== undefined) {
        counts.failed++;
        opts.onFailedStatement?.(code);
      }
      throw e;
    } finally {
      since = null;
    }
  }

  return {
    counts,
    get statementSince() {
      return since;
    },
    query: (query: string, params?: unknown[], options?: PgliteQueryOptions): Promise<PgliteResults> => run(() => db.query(query, params, options)),
    exec: (query: string, options?: PgliteQueryOptions): Promise<PgliteResults[]> => run(() => db.exec(query, options)),
    close: () => db.close(),
    get closed() {
      return db.closed;
    },
  };
}
