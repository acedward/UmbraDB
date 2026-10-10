/**
 * A tap for the crash tests, evaluated in the engine's dedicated worker right before the worker's first script runs
 * (`cdp-browser.ts` `workerScript`). It changes nothing the engine does; it only watches and, when armed, stops the
 * worker's thread at a chosen point so the test can kill the worker there.
 *
 * - **Statements:** PGlite writes every statement's text into its wire-protocol buffer with
 *   `TextEncoder.prototype.encodeInto`; the tap wraps it and sees each statement before PGlite runs it. From them it
 *   follows the session's transactions: `BEGIN` opens one, its first statement that names a schema gives its kind
 *   (`archive`: the chain archive's tables, the sync's block transaction; `scan`: a `mip0018` write, the scan's block
 *   transaction; `read`: a read-only transaction), `COMMIT`/`ROLLBACK` ends it once the next statement starts.
 * - **File writes:** PGlite's OPFS file system writes through `FileSystemSyncAccessHandle.prototype.write`; the tap
 *   counts the writes of the statement running now (a write is always inside a statement: the database writing its
 *   WAL or a page).
 * - **Park:** when the armed point is reached, the tap records where it is (`self.__crashTap.parked`), reports it as a
 *   console message (`CRASH_TAP_PARKED <json>`, delivered to DevTools at once) and then keeps the thread busy, as a
 *   statement that does not return would: nothing in the worker runs after that point. The test then terminates the
 *   worker or kills the tab's renderer process.
 *
 * Points (`Trigger.point`): `archive-statement` / `scan-statement` (the `statement`-th statement after `BEGIN` of the
 * `tx`-th block transaction of that kind, or its `COMMIT` when it has fewer), `archive-commit` / `scan-commit` (the
 * `write`-th file write while that transaction's `COMMIT` runs), `between` (the `BEGIN` of the `tx`-th transaction of any
 * kind, before it runs: no transaction open), `write` (the `write`-th file write after arming, wherever it falls),
 * `boot` (the `write`-th file write since the worker started: creating the store, or the migrations) and `file-close`
 * (the `write`-th `close()` of an OPFS writable stream after arming, before it runs: the file it writes, such as a
 * snapshot import's journal, is then not replaced).
 */

export type TriggerPoint = "archive-statement" | "scan-statement" | "archive-commit" | "scan-commit" | "between" | "write" | "boot" | "file-close";

export interface Trigger {
  point: TriggerPoint;
  /** The ordinal (from 1) of the transaction, among those of the point's kind (any kind for `between`) after arming. */
  tx?: number;
  /** The ordinal (from 1) of the statement after `BEGIN`. */
  statement?: number;
  /** The ordinal (from 1) of the file write (of the writable stream's close for `file-close`). */
  write?: number;
}

/** Where the worker stopped, as the tap saw it. */
export interface ParkedAt {
  point: TriggerPoint;
  /** The transaction open then: its kind, its statements so far, and whether its `COMMIT`/`ROLLBACK` had started. */
  tx: { kind: "archive" | "scan" | "read" | "other" | "unknown"; statements: number; ending: "commit" | "rollback" | null } | null;
  /** The statement running (or about to run, for a statement point), its first 160 characters. */
  statement: string | null;
  /** File writes during that statement so far. */
  writesInStatement: number;
  /** Statements and file writes since the worker started. */
  statements: number;
  writes: number;
  /** Block transactions seen since the worker started, by kind. */
  txCount: { archive: number; scan: number; read: number; other: number };
}

export const PARKED_MARKER = "CRASH_TAP_PARKED";

/** The tap's source, armed from the start with `trigger` (a boot point) or later through `self.__crashTap.arm(t)`. */
export function crashTapScript(trigger?: Trigger): string {
  return `(() => {
  if (self.__crashTap) return;
  const SQL = /^\\s*(BEGIN|START\\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|INSERT|UPDATE|DELETE|SELECT|WITH|CREATE|ALTER|DROP|SET|SHOW|CHECKPOINT|LOCK|DO|COPY|TRUNCATE|VALUES|ANALYZE|VACUUM)\\b/i;
  const tap = self.__crashTap = {
    statements: 0, writes: 0, writesInStatement: 0, statement: null, tx: null, writesBeforeFirstStatement: null,
    txCount: { archive: 0, scan: 0, read: 0, other: 0 },
    armed: null, base: null, parked: null,
    arm(t) { tap.armed = t; tap.base = { writes: tap.writes, closes: tap.closes, txCount: { ...tap.txCount }, anyTx: tap.anyTx }; return true; },
    anyTx: 0, closes: 0,
    /** File writes of each finished COMMIT, by transaction kind: { archive: { "1": n, … }, … }. */
    commitWrites: {},
  };
  const kindOf = (sql) => {
    if (/"chain_archive"|\\bchain_archive\\./.test(sql)) return /^\\s*(INSERT|UPDATE|DELETE)/i.test(sql) ? "archive" : "read";
    if (/"mip0018"|\\bmip0018\\./.test(sql)) return /^\\s*(INSERT|UPDATE|DELETE)/i.test(sql) ? "scan" : "read";
    return null;
  };
  const where = (point) => ({
    point,
    tx: tap.tx === null ? null : { kind: tap.tx.kind, statements: tap.tx.statements, ending: tap.tx.ending },
    statement: tap.statement === null ? null : tap.statement.slice(0, 160),
    writesInStatement: tap.writesInStatement, statements: tap.statements, writes: tap.writes, txCount: { ...tap.txCount },
  });
  const park = (point) => {
    const at = where(point);
    tap.parked = at;
    tap.armed = null;
    console.debug(${JSON.stringify(PARKED_MARKER)} + " " + JSON.stringify(at));
    const end = Date.now() + 600000;
    while (Date.now() < end) {}
  };
  const since = (kind) => tap.txCount[kind] - tap.base.txCount[kind];
  const onStatement = (sql) => {
    // A transaction whose COMMIT/ROLLBACK ran ends when the next statement starts.
    if (tap.tx !== null && tap.tx.ending !== null) {
      if (tap.tx.ending === "commit") {
        const k = (tap.commitWrites[tap.tx.kind] ??= {});
        k[tap.writesInStatement] = (k[tap.writesInStatement] ?? 0) + 1;
      }
      tap.tx = null;
    }
    tap.statements++;
    if (tap.statements === 1) tap.writesBeforeFirstStatement = tap.writes;
    tap.writesInStatement = 0;
    tap.statement = sql;
    const a = tap.armed;
    if (/^\\s*(BEGIN|START\\s+TRANSACTION)\\b/i.test(sql)) {
      if (a !== null && a.point === "between" && tap.anyTx + 1 - tap.base.anyTx >= (a.tx ?? 1)) park("between");
      tap.anyTx++;
      tap.tx = { kind: /READ\\s+ONLY/i.test(sql) ? "read" : "unknown", statements: 0, ending: null };
      return;
    }
    if (tap.tx === null) return;
    if (/^\\s*(COMMIT|END|ROLLBACK)\\b/i.test(sql)) {
      tap.tx.ending = /^\\s*ROLLBACK/i.test(sql) ? "rollback" : "commit";
      if (a !== null && (a.point === "archive-statement" || a.point === "scan-statement") && tap.tx.kind === a.point.split("-")[0] && since(tap.tx.kind) >= (a.tx ?? 1)) park(a.point);
      return;
    }
    tap.tx.statements++;
    if (tap.tx.kind === "unknown") {
      const k = kindOf(sql);
      if (k !== null) {
        tap.tx.kind = k;
        tap.txCount[k]++;
      }
    } else if (tap.tx.kind === "read") {
      const k = kindOf(sql);
      if (k === "archive" || k === "scan") { tap.txCount.read--; tap.tx.kind = k; tap.txCount[k]++; }
    }
    if (a !== null && (a.point === "archive-statement" || a.point === "scan-statement") && tap.tx.kind === a.point.split("-")[0]
      && since(tap.tx.kind) >= (a.tx ?? 1) && tap.tx.statements >= (a.statement ?? 1)) park(a.point);
  };
  const encodeInto = TextEncoder.prototype.encodeInto;
  TextEncoder.prototype.encodeInto = function (s, dest) {
    if (typeof s === "string" && SQL.test(s)) onStatement(s);
    return encodeInto.call(this, s, dest);
  };
  const write = FileSystemSyncAccessHandle.prototype.write;
  FileSystemSyncAccessHandle.prototype.write = function (buffer, options) {
    tap.writes++;
    tap.writesInStatement++;
    const a = tap.armed;
    if (a !== null) {
      if (a.point === "boot" && tap.writes >= (a.write ?? 1)) park("boot");
      else if (a.point === "write" && tap.writes - tap.base.writes >= (a.write ?? 1)) park("write");
      else if ((a.point === "archive-commit" || a.point === "scan-commit") && tap.tx !== null && tap.tx.ending === "commit"
        && tap.tx.kind === a.point.split("-")[0] && since(tap.tx.kind) >= (a.tx ?? 1) && tap.writesInStatement >= (a.write ?? 1)) park(a.point);
    }
    return write.call(this, buffer, options);
  };
  const close = FileSystemWritableFileStream.prototype.close;
  FileSystemWritableFileStream.prototype.close = function () {
    tap.closes++;
    const a = tap.armed;
    if (a !== null && a.point === "file-close" && tap.closes - tap.base.closes >= (a.write ?? 1)) park("file-close");
    return close.call(this);
  };
  ${trigger === undefined ? "" : `tap.arm(${JSON.stringify(trigger)});`}
})();`;
}
