/**
 * A postgres.js-compatible client over one PGlite database: the part of the postgres.js API this repository uses, so
 * the same modules run on PostgreSQL (postgres.js) and on PGlite (in Node or in a browser worker).
 *
 * Covered:
 * - tagged templates, compiled exactly as postgres.js 3.4 compiles them: `$n` placeholders, nested, conditional and
 *   empty fragments, arrays of fragments, `unsafe` text used as a fragment;
 * - `sql(identifier)` (a dotted name quotes each part) and the builders `sql(object)`, `sql(object, ...columns)`,
 *   `sql(rows)` and `sql(names)`, chosen by the keyword before them (`insert`, `update`, `values`, `in`, `select`, …);
 * - `sql.array(values, elementOid?)` and `sql.json(value)`;
 * - `begin(callback)` and `begin(mode, callback)`: `begin <mode>`, then `commit`, or `rollback` when the callback fails
 *   or any statement of the transaction failed; `savepoint` on transaction handles;
 * - `reserve()`: an exclusive handle on the session until `release()`; a manual `BEGIN`/`COMMIT` works on it;
 * - `unsafe(text)` (simple protocol, several statements allowed) and `unsafe(text, parameters)`; the results of several
 *   statements are grouped as postgres.js groups them (see {@link simpleResult});
 * - results: arrays carrying `count`, `command` (the first word of the statement's command tag, as PGlite reports it)
 *   and `columns`;
 * - `end()`.
 * Anything else postgres.js offers (cursors, `forEach`, `values`, `listen`, …) throws `NOT_SUPPORTED`.
 *
 * Parameters are serialized as postgres.js serializes them, by the type the server describes for each parameter
 * (including its quirks, for example a string bound to a `jsonb` parameter becomes a JSON string). Results are parsed
 * by PGlite's parsers with {@link PGLITE_PARSERS} over them, so values have the types the PostgreSQL client gives
 * (`int8` always a `bigint`, `numeric` a string); `bytea` is a `Uint8Array` (postgres.js gives a `Buffer`, a subclass of
 * it). The `parsers` option is merged over them and passed to every statement. Errors the database reports come back
 * as postgres.js reports them ({@link normalizePgliteError}, the default `mapError`); a statement on a closed PGlite
 * database fails with `CONNECTION_CLOSED`.
 *
 * PGlite has a single session. All clients created over one PGlite database share one lock on it: a statement holds it
 * while it runs, `begin` for the whole transaction, `reserve` until `release`. Waiting statements run in arrival order.
 * Only `begin` and a reserved handle open transactions. A top-level statement that starts a transaction block is refused
 * with `UNSAFE_TRANSACTION` before it runs, also when the `BEGIN` or `START TRANSACTION` follows comments or other
 * statements of the same text; and the session is never handed on inside a transaction: when a top-level statement
 * leaves one open (whatever its text), it is rolled back and the statement refused, and a transaction still open when a
 * reservation is released (or a `begin` ends) is rolled back.
 *
 * What holds the session — a statement, a `begin` transaction, a reservation — also holds PGlite's transaction lock (the
 * lock PGlite's `transaction()` holds for its whole callback and its `query` and `exec` take while they run) from when it
 * gets the session until it hands it on, and runs its own statements through PGlite's protocol under PGlite's statement
 * lock only, as PGlite's `transaction()` runs the statements of its callback. So a transaction of PGlite's
 * `transaction()`, or a `query` or `exec` on the same database outside these clients, waits until the holder has handed
 * the session on (and a holder waits for them): neither runs inside the other's transaction, sees its uncommitted rows
 * or commits them. The same rule makes it wrong to call PGlite's `query`, `exec` or `transaction()` while the session is
 * held by the caller's own transaction or reservation, or to await a statement of these clients inside a callback of
 * PGlite's `transaction()`: each waits for the other.
 * {@link pgliteBlobQuery} runs a `COPY` with a file (PGlite's `blob` option) on a client, a transaction handle or a
 * reserved handle instead.
 * Inside a `begin` callback every statement must go through the transaction handle: a statement on the outer client
 * waits for the session the transaction holds. Such a waiting statement fails with `PGLITE_SESSION_DEADLOCK` once the
 * transaction (or reservation) holding the session has run no statement for `deadlockTimeoutMs`, instead of waiting
 * forever.
 *
 * Each client has a schema and makes it the session's `search_path` before its statement, transaction or reservation
 * whenever the session last ran with another one. `RESET search_path`, `RESET ALL` and `DISCARD ALL` run on a handle
 * return the session to the client's schema, as they return a postgres.js connection to its startup `search_path`.
 *
 * Each client also has a durability mode (`durability`, default `non-durable`), carried as `umbradbDurability` and read
 * by the durability probe (`durabilityModeOf`): PGlite runs with `fsync=off` by default, which a `non-durable` client
 * accepts by configuration; a `durable` client keeps the PostgreSQL rule, so `fsync` must be on.
 */
import type { PGliteOptions } from "@electric-sql/pglite";
import type { ISql } from "postgres";
import type { UmbraDBSql } from "./client.js";
import type { DurabilityMode } from "./durability-probe.js";
import { DEFAULT_SCHEMA, assertValidSchemaName } from "./schema-name.js";

// ── PGlite surface ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A result as PGlite returns it. */
export interface PgliteResults {
  rows: any[];
  fields: Array<{ name: string; dataTypeID: number }>;
  command?: string;
  rowCount?: number;
  affectedRows?: number;
}

/** Text-format parser for one type oid, as PGlite calls it. */
export type PgliteParser = (value: string, typeId: number) => unknown;

/** Per-statement options of PGlite's `query` and `exec`. */
export interface PgliteQueryOptions {
  paramTypes?: number[];
  serializers?: Record<number, (value: any) => string>;
  parsers?: Record<number, PgliteParser>;
}

/** A message of the backend as PGlite's protocol parser gives it: the fields this client reads. */
export interface PgliteBackendMessage {
  readonly name: string;
  /** `rowDescription`: the columns (`name`, `dataTypeID`); `dataRow`: the values as text, `null` for NULL. */
  readonly fields?: readonly unknown[];
  /** `commandComplete`: the command tag. */
  readonly text?: string;
}

/** The methods of a PGlite database this client uses (`PGlite` from `@electric-sql/pglite` has them). */
export interface PgliteDatabase {
  query(query: string, params?: any[], options?: PgliteQueryOptions): Promise<PgliteResults>;
  exec(query: string, options?: PgliteQueryOptions): Promise<PgliteResults[]>;
  /** Runs `fn` holding the lock PGlite's `transaction()` holds for its whole callback and `query` and `exec` hold while
   *  they run (PGlite's `_runExclusiveTransaction`, declared on its database classes): no transaction of PGlite's
   *  `transaction()`, and no `query` or `exec`, runs while `fn` runs. Each holder of the session holds it for its whole
   *  life. */
  _runExclusiveTransaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Runs `fn` with no other statement of the database running beside it (PGlite's `runExclusive`: the lock each
   *  statement holds; it does not take the lock of {@link _runExclusiveTransaction}). Each statement of the client runs
   *  in it. */
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** Sends one frontend protocol message and gives the backend's messages; an error the backend sends is thrown
   *  (PGlite's `execProtocolStream`). Called inside {@link runExclusive} only. */
  execProtocolStream(message: Uint8Array, options?: { syncToFs?: boolean }): Promise<readonly PgliteBackendMessage[]>;
  /** Sets the file a `COPY … FROM '/dev/blob'` reads (none: `undefined`) (PGlite's `_handleBlob`). */
  _handleBlob(blob?: Blob): Promise<void>;
  /** Forgets the file of {@link _handleBlob} (PGlite's `_cleanupBlob`). */
  _cleanupBlob(): Promise<void>;
  /** The file the last `COPY … TO '/dev/blob'` wrote, if any (PGlite's `_getWrittenBlob`). */
  _getWrittenBlob(): Promise<Blob | undefined>;
  /** Writes the database's changes to its file system (PGlite's `syncToFs`). */
  syncToFs(): Promise<void>;
  /** The database's own result parsers by type oid, array types included (PGlite's `parsers`). */
  readonly parsers: Readonly<Record<number, PgliteParser>>;
  close(): Promise<void>;
  readonly closed: boolean;
  /** Whether the session is inside a transaction block (PGlite's `isInTransaction`). Without it, a transaction left
   *  open by a statement whose text does not show it cannot be detected. */
  isInTransaction?(): boolean;
}

// ── Options ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Called before each statement a caller runs, with the text, parameters and parameter type oids (0 = unspecified)
 *  as sent; the same arguments postgres.js passes to its `debug` option. */
export type PgliteStatementHook = (client: number, query: string, parameters: readonly unknown[], types: readonly number[]) => void;

export interface PgliteClientOptions {
  /** The database. Every client created over the same database shares its session. */
  pglite: PgliteDatabase;
  /** The client's schema and `search_path`. Default {@link DEFAULT_SCHEMA}. */
  schema?: string;
  /** Result parsers merged over {@link PGLITE_PARSERS} (an oid given here wins) and passed to every statement; they
   *  take precedence over the database's own parsers. */
  parsers?: Record<number, PgliteParser>;
  /** Maps an error raised by PGlite for a statement to the error the caller receives. Default
   *  {@link normalizePgliteError}. */
  mapError?: (error: unknown) => unknown;
  /** Called before each statement (see {@link PgliteStatementHook}). */
  debug?: PgliteStatementHook;
  /** How long a statement of this client waits for the session while the transaction or reservation holding it runs
   *  no statement, before it fails with `PGLITE_SESSION_DEADLOCK`. Default {@link DEFAULT_DEADLOCK_TIMEOUT_MS}. */
  deadlockTimeoutMs?: number;
  /** Close the database when this client ends. Default false: the database belongs to whoever created it. */
  closeOnEnd?: boolean;
  /** The durability mode: `non-durable` (default) accepts PGlite's `fsync=off` by configuration; `durable` keeps the
   *  PostgreSQL rule that refuses it. Read by the durability probe and reported by the API's `/v1/status`. */
  durability?: DurabilityMode;
}

export interface OpenPgliteClientOptions extends Omit<PgliteClientOptions, "pglite" | "closeOnEnd"> {
  /** PGlite data directory (`memory://…`, `opfs-ahp://…`, `idb://…` or a file path); omitted means in memory. */
  dataDir?: string;
  /** Other options for `PGlite.create`. Without `startParams`, a `durable` client starts PGlite without its `-F` start
   *  parameter, so `fsync` is on; a `non-durable` one with PGlite's defaults (`fsync` off). */
  pgliteOptions?: PGliteOptions;
}

export const DEFAULT_DEADLOCK_TIMEOUT_MS = 2_000;

// ── Errors ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** An error raised by this client itself (not by the database); `code` names it, as postgres.js does for its own. */
export class PgliteSqlError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "PgliteSqlError";
  }
}

const notSupported = (what: string): PgliteSqlError =>
  new PgliteSqlError("NOT_SUPPORTED", `${what} is not supported by the PGlite client`);

const connectionClosed = (): PgliteSqlError => new PgliteSqlError("CONNECTION_CLOSED", "the PGlite database is closed");

/** PGlite's error field → postgres.js's name for it (postgres.js 3.4 `connection.js` `errorFields`, including its
 *  `data type_name` spelling). PGlite reports the severity once; postgres.js has the localized and the plain one. */
const POSTGRES_ERROR_FIELDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["severity", ["severity_local", "severity"]],
  ["code", ["code"]],
  ["message", ["message"]],
  ["detail", ["detail"]],
  ["hint", ["hint"]],
  ["position", ["position"]],
  ["internalPosition", ["internal_position"]],
  ["internalQuery", ["internal_query"]],
  ["where", ["where"]],
  ["schema", ["schema_name"]],
  ["table", ["table_name"]],
  ["column", ["column_name"]],
  ["dataType", ["data type_name"]],
  ["constraint", ["constraint_name"]],
  ["file", ["file"]],
  ["line", ["line"]],
  ["routine", ["routine"]],
];

/**
 * An error the database reported, shaped as postgres.js's `PostgresError`: `name` `"PostgresError"`, the SQLSTATE in
 * `code`, and postgres.js's field names (`constraint_name`, `schema_name`, `table_name`, `column_name`, `detail`,
 * `hint`, …) for the fields the database sent. The statement text and its parameters are the non-enumerable `query`
 * and `parameters`, as on a postgres.js error.
 */
export class PglitePostgresError extends Error {
  declare readonly code: string;
  declare readonly severity: string;
  declare readonly query: string | undefined;
  declare readonly parameters: readonly unknown[] | undefined;
  [field: string]: unknown;

  constructor(fields: Readonly<Record<string, string>>, query?: string, parameters?: readonly unknown[]) {
    super(fields.message ?? "");
    this.name = "PostgresError";
    Object.assign(this, fields);
    Object.defineProperties(this, {
      query: { value: query, enumerable: false },
      parameters: { value: parameters, enumerable: false },
    });
  }
}

/** Whether `error` is an error the database reported (PGlite's own error class): a SQLSTATE and a severity. */
function isServerError(error: unknown): error is Error & { code: string; severity: string } {
  if (!(error instanceof Error)) return false;
  const e = error as { code?: unknown; severity?: unknown };
  return typeof e.severity === "string" && typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code);
}

/**
 * Returns an error the database reported (PGlite's error class) as a {@link PglitePostgresError}, so code written for
 * postgres.js reads the same fields (`translatePostgresError` routes SQLSTATE 23514 by `constraint_name`, the API
 * recognizes a database error by its name). Any other value is returned unchanged.
 */
export function normalizePgliteError(error: unknown): unknown {
  if (!isServerError(error) || error instanceof PglitePostgresError) return error;
  const source = error as unknown as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const [from, to] of POSTGRES_ERROR_FIELDS) {
    const value = from === "message" ? error.message : source[from];
    if (typeof value === "string") for (const name of to) fields[name] = value;
  }
  const query = typeof source.query === "string" ? source.query : undefined;
  const parameters = Array.isArray(source.params) ? (source.params as unknown[]) : undefined;
  return new PglitePostgresError(fields, query, parameters);
}

// ── Result types ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** `int8[]` text (`{1,-2,NULL}`, nested braces for more dimensions) → arrays of `bigint` (NULL → `null`). */
function parseInt8Array(text: string): unknown[] {
  let i = 0;
  if (text[0] === "[") i = text.indexOf("=") + 1; // explicit bounds, `[0:1]={…}`
  const parse = (): unknown[] => {
    const out: unknown[] = [];
    i++; // "{"
    if (text[i] === "}") {
      i++;
      return out;
    }
    for (;;) {
      if (text[i] === "{") out.push(parse());
      else {
        let j = i;
        while (j < text.length && text[j] !== "," && text[j] !== "}") j++;
        const token = text.slice(i, j);
        out.push(token === "NULL" ? null : BigInt(token));
        i = j;
      }
      if (text[i++] !== ",") return out;
    }
  };
  return parse();
}

/**
 * The result parsers every client applies by default, so values have the types the PostgreSQL client
 * (`createClient`) gives: `int8` is always a `bigint` (PGlite gives a `number` when it fits), `int8[]` elements too,
 * and `numeric` is the decimal text. `bytea` stays PGlite's `Uint8Array`.
 */
export const PGLITE_PARSERS: Readonly<Record<number, PgliteParser>> = Object.freeze({
  20: (value: string) => BigInt(value),
  1016: (value: string) => parseInt8Array(value),
  1700: (value: string) => value,
});

// ── Values: identifiers, typed parameters, builders ──────────────────────────────────────────────────────────────────

/** A value that is not a query; awaiting it is a mistake (postgres.js: `NOT_TAGGED_CALL`). */
class NotTagged {
  then(): never { throw notTagged(); }
  catch(): never { throw notTagged(); }
  finally(): never { throw notTagged(); }
}

function notTagged(): PgliteSqlError {
  return new PgliteSqlError("NOT_TAGGED_CALL", "Query not called as a tagged template literal");
}

class Identifier extends NotTagged {
  readonly value: string;
  constructor(value: string) {
    super();
    this.value = escapeIdentifier(value);
  }
}

class Parameter extends NotTagged {
  constructor(
    public value: unknown,
    readonly type: number,
    readonly array?: Record<number, number>,
  ) {
    super();
  }
}

type BuildContext = { params: unknown[]; types: number[] };
type BuilderFn = (first: any, rest: unknown[], ctx: BuildContext) => string;

class Builder extends NotTagged {
  constructor(readonly first: any, readonly rest: unknown[]) {
    super();
  }

  build(before: string, ctx: BuildContext): string {
    const keyword = BUILDERS.map(([re, fn]) => ({ fn, i: before.search(re) })).sort((a, b) => a.i - b.i).pop()!;
    return keyword.i === -1 ? escapeIdentifiers(this.first) : keyword.fn(this.first, this.rest, ctx);
  }
}

// ── Queries ──────────────────────────────────────────────────────────────────────────────────────────────────────────

type QueryHandler = (query: PgliteQuery) => void;

/**
 * A statement that runs when it is first awaited (or `.then`/`.catch`/`.finally` is called), and a fragment when it is
 * interpolated into another query instead.
 */
export class PgliteQuery extends Promise<any> {
  readonly strings: readonly string[];
  readonly args: readonly unknown[];
  readonly tagged: boolean;
  readonly simple: boolean;
  resolve!: (value: unknown) => void;
  reject!: (reason: unknown) => void;
  private readonly handler: QueryHandler;
  private executed = false;

  constructor(strings: readonly string[], args: readonly unknown[], handler: QueryHandler, simple = false) {
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    super((a, b) => {
      resolve = a;
      reject = b;
    });
    this.resolve = resolve;
    this.reject = reject;
    this.strings = strings;
    this.args = args;
    this.handler = handler;
    this.tagged = Array.isArray((strings as { raw?: unknown }).raw);
    this.simple = simple;
  }

  static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  private handle(): void {
    if (this.executed) return;
    this.executed = true;
    void Promise.resolve().then(() => {
      try {
        this.handler(this);
      } catch (error) {
        this.reject(error);
      }
    });
  }

  execute(): this {
    this.handle();
    return this;
  }

  override then<T1 = any, T2 = never>(
    onfulfilled?: ((value: any) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    this.handle();
    return super.then(onfulfilled, onrejected);
  }

  override catch<T = never>(onrejected?: ((reason: any) => T | PromiseLike<T>) | null): Promise<any> {
    this.handle();
    return super.catch(onrejected);
  }

  override finally(onfinally?: (() => void) | null): Promise<any> {
    this.handle();
    return super.finally(onfinally);
  }

  cursor(): never { throw notSupported("cursor()"); }
  forEach(): never { throw notSupported("forEach()"); }
  values(): never { throw notSupported("values()"); }
  raw(): never { throw notSupported("raw()"); }
  describe(): never { throw notSupported("describe()"); }
  readable(): never { throw notSupported("readable()"); }
  writable(): never { throw notSupported("writable()"); }
  cancel(): never { throw notSupported("cancel()"); }
}

/** A query result: the rows, with the statement's row `count` (null when its command reports none), its `command`
 *  and its `columns`. */
export class PgliteResult extends Array<any> {
  declare count: number | null;
  declare command: string | null;
  declare columns: Array<{ name: string; type: number }>;

  static override get [Symbol.species](): ArrayConstructor {
    return Array;
  }
}

function toResult(res: PgliteResults | undefined): PgliteResult {
  const out = new PgliteResult();
  const rows = res?.rows ?? [];
  for (let i = 0; i < rows.length; i++) out.push(rows[i]);
  Object.defineProperties(out, {
    count: { value: res?.rowCount ?? null, writable: true },
    command: { value: res?.command ?? null, writable: true },
    columns: { value: (res?.fields ?? []).map((f) => ({ name: f.name, type: f.dataTypeID })), writable: true },
  });
  return out;
}

/** One statement of a text run with the simple protocol: its result, and whether it describes rows (the backend sent a
 *  row description for it, also one of no column). */
interface SimpleStatement {
  readonly res: PgliteResults;
  readonly describesRows: boolean;
}

/** PGlite's frontend message serializer (`protocol.serialize`) and result reader (`parse`), loaded with PGlite's module
 *  when first needed. */
interface PgliteWire {
  query(text: string): Uint8Array;
  sync(): Uint8Array;
  parse(statement: { text: string; types?: number[] }): Uint8Array;
  describe(target: { type: "S" | "P" }): Uint8Array;
  bind(values: { values: unknown[] }): Uint8Array;
  execute(): Uint8Array;
  parseResults(messages: readonly PgliteBackendMessage[], parsers: Readonly<Record<number, PgliteParser>>, options: PgliteQueryOptions, blob: Blob | undefined): PgliteResults[];
  parameterTypes(messages: readonly PgliteBackendMessage[]): number[];
}
let wire: Promise<PgliteWire> | undefined;
const pgliteWire = (): Promise<PgliteWire> =>
  (wire ??= import("@electric-sql/pglite").then(({ protocol: { serialize }, parse }) => ({
    query: (text) => serialize.query(text),
    sync: () => serialize.sync(),
    parse: (statement) => serialize.parse(statement),
    describe: (target) => serialize.describe(target),
    bind: (values) => serialize.bind(values as Parameters<typeof serialize.bind>[0]),
    execute: () => serialize.execute({}),
    parseResults: (messages, parsers, options, blob) =>
      parse.parseResults(messages as Parameters<typeof parse.parseResults>[0], parsers as never, options as never, blob) as PgliteResults[],
    parameterTypes: (messages) => parse.parseDescribeStatementResults(messages as Parameters<typeof parse.parseDescribeStatementResults>[0]),
  })));

/** Forgets the file a statement read (`COPY … FROM '/dev/blob'`) and drops any a statement wrote (`COPY … TO`), also
 *  part of one, so that none is handed to a later statement. */
async function dropBlobs(db: PgliteDatabase): Promise<void> {
  await db._cleanupBlob();
  await db._getWrittenBlob();
}

/** A server error of `text` carries the statement and its parameters, as PGlite's `query` and `exec` give them. */
function withStatement(error: unknown, text: string, params: readonly unknown[] | undefined, options?: PgliteQueryOptions): unknown {
  if (isServerError(error)) Object.assign(error, { query: text, params, queryOptions: options });
  return error;
}

/**
 * Runs `text` with the simple protocol as PGlite's `exec` runs it — the same `Query` message (PGlite's serializer), under
 * PGlite's statement lock (the holder running it holds PGlite's transaction lock), then a `Sync`, then (when it
 * succeeded) the file system written and any file a `COPY … TO '/dev/blob'` wrote dropped — and reads the backend's
 * messages itself, so that each statement keeps whether it describes rows. Values are parsed by `parsers`, then the
 * database's own parsers, as `exec` parses them. A database error carries the statement text (`query`), as `exec` gives
 * it, and is thrown from inside the run (a session monitor counts it).
 */
async function execSimple(db: PgliteDatabase, text: string, parsers: Readonly<Record<number, PgliteParser>>): Promise<SimpleStatement[]> {
  const w = await pgliteWire();
  return db.runExclusive(async (): Promise<SimpleStatement[]> => {
    if (db.closed) throw connectionClosed();
    await db._handleBlob(undefined);
    let messages: readonly PgliteBackendMessage[];
    try {
      messages = await db.execProtocolStream(w.query(text), { syncToFs: false });
    } catch (error) {
      throw withStatement(error, text, undefined);
    } finally {
      await db.execProtocolStream(w.sync(), { syncToFs: false });
      await dropBlobs(db).catch(() => undefined);
    }
    await db.syncToFs();
    const out: SimpleStatement[] = [];
    let fields: Array<{ name: string; dataTypeID: number }> = [];
    let rows: Array<Record<string, unknown>> = [];
    let describesRows = false;
    const parse = (value: unknown, type: number): unknown => {
      if (value === null) return null;
      const parser = parsers[type] ?? db.parsers[type];
      return parser === undefined ? value : parser(value as string, type);
    };
    for (const m of messages) {
      if (m.name === "rowDescription") {
        fields = (m.fields as ReadonlyArray<{ name: string; dataTypeID: number }>).map((f) => ({ name: f.name, dataTypeID: f.dataTypeID }));
        describesRows = true;
      } else if (m.name === "dataRow") {
        rows.push(Object.fromEntries((m.fields ?? []).map((v, i) => [fields[i]!.name, parse(v, fields[i]!.dataTypeID)])));
      } else if (m.name === "commandComplete") {
        const words = (m.text ?? "").split(" ");
        const rowCount = Number.parseInt(words[words.length - 1]!, 10);
        out.push({ res: { rows, fields, command: words[0], ...(Number.isNaN(rowCount) ? {} : { rowCount }) }, describesRows });
        fields = [];
        rows = [];
        describesRows = false;
      }
    }
    return out;
  });
}

/** The options of a statement with parameters: as PGlite's `query` takes them, and a file for `COPY … '/dev/blob'`. */
interface ExtendedOptions extends PgliteQueryOptions {
  blob?: Blob;
}

/**
 * Runs `text` with the extended protocol exactly as PGlite's `query` runs it — `Parse`, `Describe` (the parameters'
 * types), `Bind` with each value serialized for its type (`options.serializers`, else its text), `Describe`, `Execute`,
 * then `Sync`; the file system written; the result read by PGlite's own reader (`parse.parseResults`) — under PGlite's
 * statement lock only: the holder running it holds PGlite's transaction lock. `options.blob` is what a `COPY … FROM
 * '/dev/blob'` reads; the result's `blob` is what a `COPY … TO '/dev/blob'` wrote.
 */
async function execExtended(db: PgliteDatabase, text: string, params: readonly unknown[], options: ExtendedOptions): Promise<PgliteResults & { blob?: Blob }> {
  const w = await pgliteWire();
  return db.runExclusive(async () => {
    if (db.closed) throw connectionClosed();
    await db._handleBlob(options.blob);
    const messages: PgliteBackendMessage[] = [];
    // The answers read as the result, as PGlite's `query` reads them (all but the statement's description), kept one
    // by one: an answer (Execute's rows) can hold more messages than a function call takes arguments.
    const send = async (message: Uint8Array, keep = true): Promise<readonly PgliteBackendMessage[]> => {
      const answer = await db.execProtocolStream(message, { syncToFs: false });
      if (keep) for (const m of answer) messages.push(m);
      return answer;
    };
    try {
      await send(w.parse({ text, ...(options.paramTypes === undefined ? {} : { types: options.paramTypes }) }));
      const types = w.parameterTypes(await send(w.describe({ type: "S" }), false));
      const values = params.map((v, i) => {
        if (v === null || v === undefined) return null;
        const serialize = options.serializers?.[types[i]!];
        return serialize !== undefined ? serialize(v) : String(v);
      });
      await send(w.bind({ values }));
      await send(w.describe({ type: "P" }));
      await send(w.execute());
    } catch (error) {
      // What a failed `COPY … TO '/dev/blob'` wrote is dropped, so that the next one gives its own file only.
      await dropBlobs(db).catch(() => undefined);
      throw withStatement(error, text, params as unknown[], options);
    } finally {
      await send(w.sync());
    }
    await db._cleanupBlob();
    await db.syncToFs();
    const blob = await db._getWrittenBlob();
    return w.parseResults(messages, db.parsers, options, blob)[0]!;
  });
}

/**
 * The result of a text run with the simple protocol, shaped as postgres.js 3.4 shapes it. The statements' results are
 * grouped: a statement that describes rows (the backend sent a row description for it, even one of no column) starts a
 * new group unless it is the first; any other statement joins the group before it, whatever its command (`SELECT … INTO`
 * reports `SELECT` and describes no rows). A group holds the rows and columns of its first statement, the first row
 * count reported in it and the command of its last statement. One group gives that result; several give an array of
 * them; a text of no statement gives one empty result.
 */
function simpleResult(all: readonly SimpleStatement[]): PgliteResult | PgliteResult[] {
  const groups: PgliteResult[] = [];
  for (const { res, describesRows } of all) {
    const current = groups[groups.length - 1];
    if (current === undefined || describesRows) {
      groups.push(toResult(res));
      continue;
    }
    if (current.count === null) current.count = res.rowCount ?? null;
    current.command = res.command ?? null;
  }
  if (groups.length === 0) return toResult(undefined);
  return groups.length === 1 ? groups[0]! : groups;
}

// ── Compilation (a port of postgres.js 3.4 `src/types.js`) ───────────────────────────────────────────────────────────

/** Statement text, parameter values and their type oids, as postgres.js would send them. */
export interface CompiledStatement {
  text: string;
  params: unknown[];
  types: number[];
}

export function escapeIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""').replace(/\./g, '"."')}"`;
}

function escapeIdentifiers(names: readonly string[]): string {
  return names.map(escapeIdentifier).join(",");
}

function inferType(x: unknown): number {
  return x instanceof Parameter
    ? x.type
    : x instanceof Date
      ? 1184
      : x instanceof Uint8Array
        ? 17
        : x === true || x === false
          ? 16
          : typeof x === "bigint"
            ? 20
            : Array.isArray(x)
              ? inferType(x[0])
              : 0;
}

function firstIsString(x: unknown): number {
  if (Array.isArray(x)) return firstIsString(x[0]);
  return typeof x === "string" ? 1009 : 0;
}

function handleValue(x: unknown, ctx: BuildContext): string {
  const value = x instanceof Parameter ? x.value : x;
  if (value === undefined) throw new PgliteSqlError("UNDEFINED_VALUE", "Undefined values are not allowed");
  let type: number;
  if (x instanceof Parameter) {
    ctx.params.push(x.value);
    type = x.array ? x.array[x.type || inferType(x.value)] || x.type || firstIsString(x.value) : x.type;
  } else {
    ctx.params.push(x);
    type = inferType(x);
  }
  return `$${ctx.types.push(type)}`;
}

function stringify(q: PgliteQuery, text: string, value: unknown, ctx: BuildContext): string {
  for (let i = 1; i < q.strings.length; i++) {
    text += stringifyValue(text, value, ctx) + q.strings[i];
    value = q.args[i];
  }
  return text;
}

function stringifyValue(before: string, value: unknown, ctx: BuildContext): string {
  if (value instanceof Builder) return value.build(before, ctx);
  if (value instanceof PgliteQuery) return fragment(value, ctx);
  if (value instanceof Identifier) return value.value;
  if (value && (value as unknown[])[0] instanceof PgliteQuery)
    return (value as PgliteQuery[]).reduce((acc, x) => `${acc} ${fragment(x, ctx)}`, "");
  return handleValue(value, ctx);
}

function fragment(q: PgliteQuery, ctx: BuildContext): string {
  return stringify(q, q.strings[0]!, q.args[0], ctx);
}

function valuesBuilder(rows: any[], ctx: BuildContext, columns: string[]): string {
  return rows.map((row) => `(${columns.map((column) => stringifyValue("values", row[column], ctx)).join(",")})`).join(",");
}

function values(first: any, rest: unknown[], ctx: BuildContext): string {
  const multi = Array.isArray(first[0]);
  const columns = rest.length ? (rest.flat() as string[]) : Object.keys(multi ? first[0] : first);
  return valuesBuilder(multi ? first : [first], ctx, columns);
}

function select(first: any, rest: unknown[], ctx: BuildContext): string {
  if (typeof first === "string") first = [first].concat(rest as string[]);
  if (Array.isArray(first)) return escapeIdentifiers(first as string[]);
  const columns = rest.length ? (rest.flat() as string[]) : Object.keys(first);
  return columns
    .map((x) => {
      const value = first[x];
      const sql = value instanceof PgliteQuery ? fragment(value, ctx) : value instanceof Identifier ? value.value : handleValue(value, ctx);
      return `${sql} as ${escapeIdentifier(x)}`;
    })
    .join(",");
}

const BUILDERS: Array<[RegExp, BuilderFn]> = (
  [
    ["values", values],
    [
      "in",
      (first, rest, ctx) => {
        const x = values(first, rest, ctx);
        return x === "()" ? "(null)" : x;
      },
    ],
    ["select", select],
    ["as", select],
    ["returning", select],
    ["\\(", select],
    [
      "update",
      (first, rest, ctx) =>
        (rest.length ? (rest.flat() as string[]) : Object.keys(first))
          .map((x) => `${escapeIdentifier(x)}=${stringifyValue("values", first[x], ctx)}`)
          .join(","),
    ],
    [
      "insert",
      (first, rest, ctx) => {
        const columns = rest.length ? (rest.flat() as string[]) : Object.keys(Array.isArray(first) ? first[0] : first);
        return `(${escapeIdentifiers(columns)})values${valuesBuilder(Array.isArray(first) ? first : [first], ctx, columns)}`;
      },
    ],
  ] as Array<[string, BuilderFn]>
).map(([keyword, fn]) => [new RegExp(`((?:^|[\\s(])${keyword}(?:$|[\\s(]))(?![\\s\\S]*\\1)`, "i"), fn]);

/** Compiles a query the way postgres.js does: text with `$n` placeholders, the parameter values and the type oid
 *  postgres.js sends for each (0 lets the server infer it). */
export function compileQuery(q: PgliteQuery): CompiledStatement {
  const ctx: BuildContext = { params: [], types: [] };
  const text = stringify(q, q.strings[0]!, q.args[0], ctx);
  if (!q.tagged) for (const x of q.args) handleValue(x, ctx);
  return { text, params: ctx.params, types: ctx.types };
}

// ── Serialization (postgres.js 3.4 serializers, by the described parameter type) ────────────────────────────────────

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function bytesOf(x: unknown): Uint8Array {
  if (x instanceof Uint8Array) return x;
  if (typeof x === "string") return new TextEncoder().encode(x);
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (Array.isArray(x)) return Uint8Array.from(x as number[]);
  return new TextEncoder().encode(String(x));
}

function byteaText(x: unknown): string {
  const bytes = bytesOf(x);
  let out = "\\x";
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]!];
  return out;
}

type Serializer = (x: any) => string;

const toText: Serializer = (x) => `${x}`;

/** postgres.js's built-in serializers plus the `bigint` type `createClient` registers. */
const BASE_SERIALIZERS: Record<number, Serializer> = {
  0: toText,
  21: toText,
  23: toText,
  25: toText,
  26: toText,
  700: toText,
  701: toText,
  114: (x) => JSON.stringify(x),
  3802: (x) => JSON.stringify(x),
  16: (x) => (x === true ? "t" : "f"),
  1082: (x) => (x instanceof Date ? x : new Date(x)).toISOString(),
  1114: (x) => (x instanceof Date ? x : new Date(x)).toISOString(),
  1184: (x) => (x instanceof Date ? x : new Date(x)).toISOString(),
  17: byteaText,
  20: (x) => x.toString(),
};

function arrayLiteral(xs: unknown, element: Serializer | undefined, typarray: number): string {
  if (!Array.isArray(xs)) return xs as string;
  if (!xs.length) return "{}";
  const delimiter = typarray === 1020 ? ";" : ",";
  const first = xs[0];
  if (Array.isArray(first) && !(first as { type?: unknown }).type)
    return `{${xs.map((x) => arrayLiteral(x, element, typarray)).join(delimiter)}}`;
  return `{${xs
    .map((x) => {
      if (x === undefined) throw new PgliteSqlError("UNDEFINED_VALUE", "Undefined values are not allowed");
      if (x === null) return "null";
      const v = x instanceof Parameter ? x.value : x;
      const text = element ? element(v) : `${v}`;
      return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    })
    .join(delimiter)}}`;
}

// ── The session and its lock ─────────────────────────────────────────────────────────────────────────────────────────

type HolderKind = "statement" | "transaction" | "reservation";

/** What holds the session: one statement, a transaction or a reservation. Its statements run one at a time, in order. */
class Holder {
  inFlight = 0;
  done = false;
  /** A statement may have left the session's `search_path` other than the client's schema. */
  searchPathTouched = false;
  /** Lets go of PGlite's transaction lock, which the holder holds for its whole life ({@link acquireHolder}). */
  releasePglite: (() => void) | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(readonly kind: HolderKind, private readonly lock: SessionLock) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      this.lock.busy(this);
      try {
        return await task();
      } finally {
        this.lock.idle(this);
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Resolves once every statement queued so far has finished. */
  drained(): Promise<unknown> {
    return this.tail;
  }
}

interface Waiter {
  kind: HolderKind;
  timeoutMs: number;
  resolve: (holder: Holder) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

class SessionLock {
  private holder: Holder | undefined;
  private readonly waiters: Waiter[] = [];

  acquire(kind: HolderKind, timeoutMs: number): Promise<Holder> {
    if (this.holder === undefined) {
      this.holder = new Holder(kind, this);
      return Promise.resolve(this.holder);
    }
    return new Promise<Holder>((resolve, reject) => {
      const waiter: Waiter = { kind, timeoutMs, resolve, reject };
      this.waiters.push(waiter);
      if (this.holderIdle()) this.arm(waiter);
    });
  }

  release(holder: Holder): void {
    if (this.holder !== holder) return;
    holder.done = true;
    for (const w of this.waiters) this.disarm(w);
    const next = this.waiters.shift();
    if (next === undefined) {
      this.holder = undefined;
      return;
    }
    this.holder = new Holder(next.kind, this);
    next.resolve(this.holder);
    if (this.holderIdle()) for (const w of this.waiters) this.arm(w);
  }

  busy(holder: Holder): void {
    holder.inFlight++;
    if (holder === this.holder) for (const w of this.waiters) this.disarm(w);
  }

  idle(holder: Holder): void {
    holder.inFlight--;
    if (holder === this.holder && this.holderIdle()) for (const w of this.waiters) this.arm(w);
  }

  private holderIdle(): boolean {
    return this.holder !== undefined && this.holder.kind !== "statement" && this.holder.inFlight === 0;
  }

  private arm(waiter: Waiter): void {
    if (waiter.timer !== undefined) return;
    const holderKind = this.holder?.kind ?? "statement";
    waiter.timer = setTimeout(() => {
      waiter.timer = undefined;
      const i = this.waiters.indexOf(waiter);
      if (i < 0) return;
      this.waiters.splice(i, 1);
      waiter.reject(
        new PgliteSqlError(
          "PGLITE_SESSION_DEADLOCK",
          `waited ${waiter.timeoutMs} ms for the PGlite session while the ${holderKind} holding it ran no statement; ` +
            "PGlite has one session, so a statement on the outer client awaited inside a begin() callback, or while a " +
            "reserve() handle is held, can never run: use the transaction or reserved handle",
        ),
      );
    }, waiter.timeoutMs);
  }

  private disarm(waiter: Waiter): void {
    if (waiter.timer === undefined) return;
    clearTimeout(waiter.timer);
    waiter.timer = undefined;
  }
}

interface Session {
  readonly db: PgliteDatabase;
  readonly lock: SessionLock;
  /** The `search_path` the session runs with, when this module set it last; undefined when unknown. */
  searchPath: string | undefined;
  /** Element oid → array oid (postgres.js `typeArrayMap`), filled once per session. */
  readonly arrayOf: Record<number, number>;
  readonly elementOf: Map<number, number>;
  arrayTypes: Promise<void> | undefined;
  readonly serializers: Record<number, Serializer>;
}

const SESSIONS = new WeakMap<PgliteDatabase, Session>();

function sessionOf(db: PgliteDatabase): Session {
  let session = SESSIONS.get(db);
  if (session === undefined) {
    const elementOf = new Map<number, number>();
    const cache = new Map<number, Serializer>();
    const serializerFor = (oid: number): Serializer => {
      let s = cache.get(oid);
      if (s === undefined) {
        const base = BASE_SERIALIZERS[oid];
        const element = elementOf.get(oid);
        s = base ?? (element !== undefined ? (xs: unknown) => arrayLiteral(xs, serializerFor(element), oid) : toText);
        cache.set(oid, s);
      }
      return s;
    };
    session = {
      db,
      lock: new SessionLock(),
      searchPath: undefined,
      arrayOf: {},
      elementOf,
      arrayTypes: undefined,
      serializers: new Proxy({} as Record<number, Serializer>, {
        get: (_target, key) => (typeof key === "string" && /^\d+$/.test(key) ? serializerFor(Number(key)) : undefined),
      }),
    };
    SESSIONS.set(db, session);
  }
  return session;
}

/** Loads the array types once per session (postgres.js does it once per connection). Runs inside the lock. */
async function loadArrayTypes(session: Session): Promise<void> {
  session.arrayTypes ??= (async () => {
    const res = await execExtended(session.db, `
      select b.oid, b.typarray
      from pg_catalog.pg_type a
      left join pg_catalog.pg_type b on b.oid = a.typelem
      where a.typcategory = 'A'
      group by b.oid, b.typarray
      order by b.oid
    `, [], {});
    for (const row of res.rows as Array<{ oid: number | null; typarray: number | null }>) {
      if (row.oid === null || row.typarray === null) continue;
      session.arrayOf[row.oid] = row.typarray;
      session.elementOf.set(row.typarray, row.oid);
    }
  })().catch((error: unknown) => {
    session.arrayTypes = undefined;
    throw error;
  });
  await session.arrayTypes;
}

// ── Clients ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const RESETS_SEARCH_PATH = /^\s*(reset\s+(search_path|all)|discard\s+all)\s*;?\s*$/i;
const MENTIONS_SEARCH_PATH = /search_path|\breset\b|\bdiscard\b/i;

const IDENTIFIER_CHAR = /[\p{L}\p{N}_$\u0080-\uffff]/u;
const DOLLAR_QUOTE = /\$(?:[\p{L}_\u0080-\uffff][\p{L}\p{N}_\u0080-\uffff]*)?\$/uy;

/** The index after the whitespace and comments (`--` to the end of the line, `/* … *\/`, nested) starting at `i`. */
function skipSpace(text: string, i: number): number {
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text.startsWith("--", i)) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end + 1;
    } else if (text.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (text.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
    } else return i;
  }
}

/** The word (letters, digits, `_`) starting at `i`, lower-cased; empty when none starts there. */
function wordAt(text: string, i: number): string {
  const m = /[A-Za-z_][A-Za-z0-9_]*/y;
  m.lastIndex = i;
  return m.exec(text)?.[0].toLowerCase() ?? "";
}

/**
 * Whether a statement of `text` (one, or several separated by `;`) starts a transaction block: `BEGIN` or `START
 * TRANSACTION`, after any comments. Quoted text (`'…'`, `E'…'` with backslash escapes, `"…"`) and dollar-quoted bodies
 * (`$$…$$`, `$tag$…$tag$`) are skipped, so a `BEGIN` or `;` inside them, in an identifier or in a comment does not count.
 */
export function startsTransactionBlock(text: string): boolean {
  let i = 0;
  let atStatementStart = true;
  while (i < text.length) {
    i = skipSpace(text, i);
    if (i >= text.length) break;
    if (atStatementStart) {
      atStatementStart = false;
      const first = wordAt(text, i);
      if (first === "begin") return true;
      if (first === "start" && wordAt(text, skipSpace(text, i + first.length)) === "transaction") return true;
    }
    const c = text[i]!;
    if (c === ";") {
      atStatementStart = true;
      i++;
    } else if (c === "'") {
      const escapes = i > 0 && /[eE]/.test(text[i - 1]!) && (i < 2 || !IDENTIFIER_CHAR.test(text[i - 2]!));
      i++;
      while (i < text.length) {
        if (escapes && text[i] === "\\") i += 2;
        else if (text[i] === "'" && text[i + 1] === "'") i += 2;
        else if (text[i] === "'") break;
        else i++;
      }
      i++;
    } else if (c === '"') {
      i++;
      while (i < text.length && !(text[i] === '"' && text[i + 1] !== '"')) i += text[i] === '"' ? 2 : 1;
      i++;
    } else if (c === "$" && (i === 0 || !IDENTIFIER_CHAR.test(text[i - 1]!))) {
      DOLLAR_QUOTE.lastIndex = i;
      const tag = DOLLAR_QUOTE.exec(text)?.[0];
      if (tag === undefined) i++;
      else {
        const end = text.indexOf(tag, i + tag.length);
        i = end < 0 ? text.length : end + tag.length;
      }
    } else if (IDENTIFIER_CHAR.test(c)) {
      while (i < text.length && IDENTIFIER_CHAR.test(text[i]!)) i++;
    } else i++;
  }
  return false;
}

let nextClientId = 0;

interface ClientState {
  readonly id: number;
  readonly session: Session;
  readonly schema: string;
  readonly parsers: Record<number, PgliteParser>;
  readonly mapError: (error: unknown) => unknown;
  readonly debug: PgliteStatementHook | undefined;
  readonly deadlockTimeoutMs: number;
  readonly closeOnEnd: boolean;
  readonly durability: DurabilityMode;
  readonly pending: Set<Promise<unknown>>;
  /** Set one tick after `end()` is called (as postgres.js does): statements handled before then still run. */
  ended: boolean;
  ending: Promise<void> | undefined;
}

function connectionEnded(): PgliteSqlError {
  return new PgliteSqlError("CONNECTION_ENDED", "the client has ended");
}

function track<T>(state: ClientState, p: Promise<T>): Promise<T> {
  state.pending.add(p);
  const forget = (): void => {
    state.pending.delete(p);
  };
  p.then(forget, forget);
  return p;
}

/** The error a caller receives for an error PGlite raised: `CONNECTION_CLOSED` once the database is closed (unless the
 *  database itself reported the error), otherwise the client's `mapError` of it. */
function databaseError(state: ClientState, error: unknown): unknown {
  return state.session.db.closed && !isServerError(error) ? connectionClosed() : state.mapError(error);
}

/** Makes the client's schema the session's `search_path` (session-level, so run it outside any transaction). */
async function applySearchPath(state: ClientState): Promise<void> {
  const { session } = state;
  if (session.searchPath === state.schema) return;
  session.searchPath = undefined;
  try {
    await execExtended(session.db, `select set_config('search_path', '${state.schema.replace(/'/g, "''")}', false)`, [], {});
  } catch (error) {
    throw databaseError(state, error);
  }
  session.searchPath = state.schema;
}

/** Runs one statement on the session the holder owns. */
async function runStatement(state: ClientState, holder: Holder, q: PgliteQuery, topLevel: boolean): Promise<PgliteResult | PgliteResult[]> {
  const { session } = state;
  if (session.db.closed) throw connectionClosed();
  try {
    await loadArrayTypes(session);
  } catch (error) {
    throw databaseError(state, error);
  }
  const compiled = compileQuery(q);
  state.debug?.(state.id, compiled.text, compiled.params, compiled.types);
  if (topLevel && startsTransactionBlock(compiled.text)) throw unsafeTransaction();
  let res: PgliteResults | undefined;
  let all: SimpleStatement[] | undefined;
  try {
    if (q.simple) all = await execSimple(session.db, compiled.text, state.parsers);
    else res = await execExtended(session.db, compiled.text, compiled.params, { paramTypes: compiled.types, serializers: session.serializers, parsers: state.parsers });
  } catch (error) {
    throw databaseError(state, error);
  } finally {
    if (MENTIONS_SEARCH_PATH.test(compiled.text)) {
      session.searchPath = undefined;
      holder.searchPathTouched = true;
    }
  }
  if (RESETS_SEARCH_PATH.test(compiled.text)) await applySearchPath(state);
  return all !== undefined ? simpleResult(all) : toResult(res);
}

function unsafeTransaction(): PgliteSqlError {
  return new PgliteSqlError("UNSAFE_TRANSACTION", "Only use sql.begin, sql.reserve or a transaction handle to start a transaction");
}

/**
 * Rolls back a transaction left open on the session, if any; whether there was one. Runs inside the holder's turn: the
 * holder holds PGlite's transaction lock, so an open transaction can only be the holder's own.
 */
async function rollBackOpenTransaction(state: ClientState, holder: Holder): Promise<boolean> {
  const { db } = state.session;
  if (db.closed || db.isInTransaction?.() !== true) return false;
  holder.searchPathTouched = true;
  try {
    await execSimple(db, "rollback", state.parsers);
  } catch (error) {
    throw databaseError(state, error);
  }
  return true;
}

/**
 * The session for one statement, a transaction or a reservation: the clients' lock, then PGlite's transaction lock,
 * held until {@link releaseHolder}, so no transaction of PGlite's `transaction()` and no `query` or `exec` on the
 * database runs inside the holder's work, nor the holder's statements inside theirs.
 */
async function acquireHolder(state: ClientState, kind: HolderKind): Promise<Holder> {
  const holder = await state.session.lock.acquire(kind, state.deadlockTimeoutMs);
  try {
    await holder.run(() => new Promise<void>((held, failed) => {
      state.session.db._runExclusiveTransaction(() => new Promise<void>((release) => {
        holder.releasePglite = release;
        held();
      })).catch(failed);
    }));
  } catch (error) {
    state.session.lock.release(holder);
    throw databaseError(state, error);
  }
  return holder;
}

/** Hands the session on: first rolls back any transaction its holder left open, so no other statement runs inside it;
 *  then lets go of PGlite's transaction lock and of the clients' lock. */
async function releaseHolder(state: ClientState, holder: Holder): Promise<void> {
  try {
    await holder.run(() => rollBackOpenTransaction(state, holder));
  } catch {
    // The database failed or closed: there is no session left to hand on inside a transaction.
  } finally {
    if (holder.searchPathTouched) state.session.searchPath = undefined;
    holder.releasePglite?.();
    holder.releasePglite = undefined;
    state.session.lock.release(holder);
  }
}

/** What {@link pgliteBlobQuery} needs of a handle: its client, its holder (a client's own has none), whether it has
 *  ended, and (a transaction handle) how its scope records a failed statement. */
interface HandleOf {
  state: ClientState;
  holder: Holder | undefined;
  ended: () => boolean;
  failed?: (error: unknown) => void;
}
const HANDLES = new WeakMap<object, HandleOf>();

/**
 * Runs `text` (a `COPY … FROM '/dev/blob'` or `COPY … TO '/dev/blob'`) on the session of `sql` — a client (a statement
 * of its own), a transaction handle or a reserved handle (in its turn) — as PGlite's `query` with its `blob` option:
 * `blob` is the file a `COPY … FROM` reads; the result's `blob` is the file a `COPY … TO` wrote. postgres.js has no such
 * call; it is how a store's rows travel as files (the browser engine's snapshots). It is a statement of the handle like
 * any other: on a transaction handle its failure fails the transaction (its `begin` or `savepoint` rejects with it, also
 * when the callback caught it); on a client it may not start a transaction block (`UNSAFE_TRANSACTION`).
 */
export async function pgliteBlobQuery(sql: ISql<{ bigint: bigint }>, text: string, blob?: Blob): Promise<{ affectedRows: number; blob: Blob | undefined }> {
  const handle = HANDLES.get(sql);
  if (handle === undefined) throw new PgliteSqlError("NOT_SUPPORTED", "pgliteBlobQuery needs a handle of the PGlite client");
  const { state } = handle;
  if (handle.ended()) throw new PgliteSqlError("TRANSACTION_ENDED", "the handle has ended; it cannot run statements");
  const exec = async (): Promise<{ affectedRows: number; blob: Blob | undefined }> => {
    if (state.session.db.closed) throw connectionClosed();
    state.debug?.(state.id, text, [], []);
    try {
      const res = await execExtended(state.session.db, text, [], { parsers: state.parsers, ...(blob === undefined ? {} : { blob }) });
      return { affectedRows: res.affectedRows ?? 0, blob: res.blob };
    } catch (error) {
      throw databaseError(state, error);
    }
  };
  if (handle.holder !== undefined) {
    const done = handle.holder.run(exec);
    if (handle.failed !== undefined) done.catch(handle.failed);
    return done;
  }
  if (state.ended) throw connectionEnded();
  return track(state, (async () => {
    const holder = await acquireHolder(state, "statement");
    try {
      return await holder.run(async () => {
        await applySearchPath(state);
        if (startsTransactionBlock(text)) throw unsafeTransaction();
        let result: { affectedRows: number; blob: Blob | undefined } | undefined;
        let failure: { error: unknown } | undefined;
        try {
          result = await exec();
        } catch (error) {
          failure = { error };
        }
        if (await rollBackOpenTransaction(state, holder)) throw unsafeTransaction();
        if (failure !== undefined) throw failure.error;
        return result!;
      });
    } finally {
      await releaseHolder(state, holder);
    }
  })());
}

type SqlFunction = ((...args: any[]) => any) & Record<string, unknown>;

/** The callable `sql` with the helpers every postgres.js handle has. */
function makeSql(state: ClientState, handler: QueryHandler): SqlFunction {
  const sql = function sql(strings: unknown, ...args: unknown[]): unknown {
    if (strings !== null && typeof strings === "object" && Array.isArray((strings as { raw?: unknown }).raw))
      return new PgliteQuery(strings as readonly string[], args, handler);
    if (typeof strings === "string" && args.length === 0) return new Identifier(strings);
    return new Builder(strings, args);
  } as SqlFunction;
  sql.unsafe = (text: string, ...rest: unknown[]): PgliteQuery => {
    let args = (rest[0] ?? []) as unknown[];
    let options = (rest[1] ?? {}) as { simple?: boolean };
    if (rest.length === 1 && !Array.isArray(rest[0])) {
      options = rest[0] as { simple?: boolean };
      args = [];
    }
    return new PgliteQuery([text], args, handler, "simple" in options ? options.simple === true : args.length === 0);
  };
  sql.array = function array(x: unknown, type?: number): Parameter {
    if (!Array.isArray(x)) return array(Array.from(arguments));
    return new Parameter(x, type || (x.length ? inferType(x) || 25 : 0), state.session.arrayOf);
  };
  sql.json = (x: unknown): Parameter => new Parameter(x, 3802);
  sql.typed = (x: unknown, type: number): Parameter => new Parameter(x, type);
  for (const name of ["listen", "notify", "file", "subscribe", "largeObject"])
    sql[name] = () => {
      throw notSupported(`sql.${name}()`);
    };
  return sql;
}

/** A transaction scope: postgres.js `begin`'s `scope` (savepoints open nested scopes). */
async function transactionScope(
  state: ClientState, holder: Holder, fn: (tx: SqlFunction) => unknown, name: string | undefined, counter: { savepoints: number },
): Promise<unknown> {
  let uncaught: unknown;
  const handler: QueryHandler = (q) => {
    q.catch((error: unknown) => {
      uncaught ??= error;
    });
    if (holder.done) {
      q.reject(new PgliteSqlError("TRANSACTION_ENDED", "the transaction has ended; this handle cannot run statements"));
      return;
    }
    holder.run(() => runStatement(state, holder, q, false)).then(q.resolve, q.reject);
  };
  const tx = makeSql(state, handler);
  HANDLES.set(tx, { state, holder, ended: () => holder.done, failed: (error) => { uncaught ??= error; } });
  tx.savepoint = function savepoint(this: unknown, label: unknown, body?: (tx: SqlFunction) => unknown): Promise<unknown> {
    if (label !== null && typeof label === "object" && Array.isArray((label as { raw?: unknown }).raw)) {
      const args = arguments;
      return (tx.savepoint as (l: unknown, b: unknown) => Promise<unknown>)(null, (inner: SqlFunction) => inner(...Array.from(args)));
    }
    if (arguments.length === 1) {
      body = label as (tx: SqlFunction) => unknown;
      label = null;
    }
    return transactionScope(state, holder, body!, `s${counter.savepoints++}${label ? `_${String(label)}` : ""}`, counter);
  };
  tx.prepare = () => {
    throw notSupported("prepare()");
  };

  if (name !== undefined) await tx`savepoint ${tx(name)}`;
  let result: unknown;
  try {
    result = await new Promise((resolve, reject) => {
      const x = fn(tx);
      Promise.resolve(Array.isArray(x) ? Promise.all(x) : x).then(resolve, reject);
    });
    if (uncaught) throw uncaught;
  } catch (error) {
    await (name !== undefined ? tx`rollback to ${tx(name)}` : tx`rollback`);
    throw ((error as { code?: unknown } | null)?.code === "25P02" && uncaught) || error;
  }
  if (name === undefined) await tx`commit`;
  return result;
}

function makeClient(state: ClientState, db: PgliteDatabase): UmbraDBSql {
  const topLevel: QueryHandler = (q) => {
    if (state.ended) {
      q.reject(connectionEnded());
      return;
    }
    const op = (async () => {
      const holder = await acquireHolder(state, "statement");
      try {
        return await holder.run(async () => {
          await applySearchPath(state);
          let result: PgliteResult | PgliteResult[] | undefined;
          let failure: { error: unknown } | undefined;
          try {
            result = await runStatement(state, holder, q, true);
          } catch (error) {
            failure = { error };
          }
          if (await rollBackOpenTransaction(state, holder)) throw unsafeTransaction();
          if (failure !== undefined) throw failure.error;
          return result;
        });
      } finally {
        await releaseHolder(state, holder);
      }
    })();
    track(state, op).then(q.resolve, q.reject);
  };
  const sql = makeSql(state, topLevel);
  HANDLES.set(sql, { state, holder: undefined, ended: () => state.ended });

  sql.begin = (mode: unknown, fn?: (tx: SqlFunction) => unknown): Promise<unknown> => {
    if (fn === undefined) {
      fn = mode as (tx: SqlFunction) => unknown;
      mode = "";
    }
    if (state.ended) return Promise.reject(connectionEnded());
    const body = fn;
    const op = (async () => {
      const holder = await acquireHolder(state, "transaction");
      try {
        await holder.run(() => applySearchPath(state));
        const start = new PgliteQuery([`begin ${String(mode).replace(/[^a-z ]/gi, "")}`], [], () => undefined, true);
        await holder.run(() => runStatement(state, holder, start, false));
        return await transactionScope(state, holder, body, undefined, { savepoints: 0 });
      } finally {
        await holder.drained();
        await releaseHolder(state, holder);
      }
    })();
    return track(state, op);
  };

  sql.reserve = async (): Promise<SqlFunction> => {
    if (state.ended) throw connectionEnded();
    const holder = await acquireHolder(state, "reservation");
    try {
      await holder.run(() => applySearchPath(state));
    } catch (error) {
      await releaseHolder(state, holder);
      throw error;
    }
    let released = false;
    let finish!: () => void;
    track(state, new Promise<void>((resolve) => (finish = resolve)));
    const reserved = makeSql(state, (q) => {
      if (released) {
        q.reject(new PgliteSqlError("RESERVATION_RELEASED", "the reserved handle was released"));
        return;
      }
      holder.run(() => runStatement(state, holder, q, false)).then(q.resolve, q.reject);
    });
    HANDLES.set(reserved, { state, holder, ended: () => released });
    reserved.release = (): void => {
      if (released) return;
      released = true;
      void holder.drained().then(() => releaseHolder(state, holder)).then(finish, finish);
    };
    return reserved;
  };

  sql.end = (opts: { timeout?: number | null } = {}): Promise<void> => {
    state.ending ??= (async () => {
      await 1;
      state.ended = true;
      const all = Promise.all([...state.pending].map((p) => p.catch(() => undefined)));
      const timeout = opts.timeout ?? null;
      if (timeout === null) await all;
      else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([all, new Promise((r) => (timer = setTimeout(r, timeout * 1000)))]);
        clearTimeout(timer);
      }
      if (state.closeOnEnd && !db.closed) await db.close();
    })();
    return state.ending;
  };
  sql.close = sql.end;
  sql.CLOSE = {};
  sql.END = sql.CLOSE;

  Object.defineProperty(sql, "umbradbSchema", { value: state.schema, enumerable: false, writable: false });
  Object.defineProperty(sql, "umbradbDurability", { value: state.durability, enumerable: false, writable: false });
  return sql as unknown as UmbraDBSql;
}

/**
 * A postgres.js-compatible client over a PGlite database, typed as the PostgreSQL client {@link UmbraDBSql}. Several
 * clients (for example one per schema) may share one database; they share its single session.
 */
export function createPgliteClient(opts: PgliteClientOptions): UmbraDBSql {
  const schema = opts.schema ?? DEFAULT_SCHEMA;
  assertValidSchemaName(schema);
  const deadlockTimeoutMs = opts.deadlockTimeoutMs ?? DEFAULT_DEADLOCK_TIMEOUT_MS;
  if (!Number.isSafeInteger(deadlockTimeoutMs) || deadlockTimeoutMs <= 0)
    throw new RangeError(`deadlockTimeoutMs must be a positive integer number of milliseconds, got ${deadlockTimeoutMs}`);
  const durability = opts.durability ?? "non-durable";
  if (durability !== "durable" && durability !== "non-durable")
    throw new RangeError(`durability must be "durable" or "non-durable", got ${String(durability)}`);
  const state: ClientState = {
    id: nextClientId++,
    session: sessionOf(opts.pglite),
    schema,
    parsers: { ...PGLITE_PARSERS, ...opts.parsers },
    mapError: opts.mapError ?? normalizePgliteError,
    debug: opts.debug,
    deadlockTimeoutMs,
    closeOnEnd: opts.closeOnEnd ?? false,
    durability,
    pending: new Set(),
    ended: false,
    ending: undefined,
  };
  return makeClient(state, opts.pglite);
}

/** Opens a PGlite database (in memory unless `dataDir` is given) and a client that closes it when it ends. A `durable`
 *  client's database starts with `fsync` on (unless `pgliteOptions.startParams` says otherwise). */
export async function openPgliteClient(opts: OpenPgliteClientOptions = {}): Promise<UmbraDBSql> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { dataDir, pgliteOptions, ...client } = opts;
  const options: PGliteOptions = { ...pgliteOptions };
  if (client.durability === "durable" && options.startParams === undefined)
    options.startParams = PGlite.defaultStartParams.filter((p) => p !== "-F");
  const pglite = await PGlite.create(dataDir, options);
  try {
    return createPgliteClient({ ...client, pglite, closeOnEnd: true });
  } catch (error) {
    await pglite.close();
    throw error;
  }
}
