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
 * - `unsafe(text)` (simple protocol, several statements allowed) and `unsafe(text, parameters)`;
 * - results: arrays carrying `count`, `command` and `columns`;
 * - `end()`.
 * Anything else postgres.js offers (cursors, `forEach`, `values`, `listen`, …) throws `NOT_SUPPORTED`.
 *
 * Parameters are serialized as postgres.js serializes them, by the type the server describes for each parameter
 * (including its quirks, for example a string bound to a `jsonb` parameter becomes a JSON string). Results are parsed
 * by PGlite's parsers; the `parsers` option is passed to every statement, and parsers that must also apply to array
 * elements belong on the PGlite instance itself. Errors raised by PGlite are passed through `mapError` (unchanged by
 * default).
 *
 * PGlite has a single session. All clients created over one PGlite database share one lock on it: a statement holds it
 * while it runs, `begin` for the whole transaction, `reserve` until `release`. Waiting statements run in arrival order.
 * Inside a `begin` callback every statement must go through the transaction handle: a statement on the outer client
 * waits for the session the transaction holds. Such a waiting statement fails with `PGLITE_SESSION_DEADLOCK` once the
 * transaction (or reservation) holding the session has run no statement for `deadlockTimeoutMs`, instead of waiting
 * forever.
 *
 * Each client has a schema and makes it the session's `search_path` before its statement, transaction or reservation
 * whenever the session last ran with another one. `RESET search_path`, `RESET ALL` and `DISCARD ALL` run on a handle
 * return the session to the client's schema, as they return a postgres.js connection to its startup `search_path`.
 */
import type { PGliteOptions } from "@electric-sql/pglite";
import type { UmbraDBSql } from "./client.js";
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

/** The methods of a PGlite database this client uses (`PGlite` from `@electric-sql/pglite` has them). */
export interface PgliteDatabase {
  query(query: string, params?: any[], options?: PgliteQueryOptions): Promise<PgliteResults>;
  exec(query: string, options?: PgliteQueryOptions): Promise<PgliteResults[]>;
  close(): Promise<void>;
  readonly closed: boolean;
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
  /** Result parsers passed to every statement (they take precedence over the database's own parsers). */
  parsers?: Record<number, PgliteParser>;
  /** Maps an error raised by PGlite for a statement to the error the caller receives. Default: unchanged. */
  mapError?: (error: unknown) => unknown;
  /** Called before each statement (see {@link PgliteStatementHook}). */
  debug?: PgliteStatementHook;
  /** How long a statement of this client waits for the session while the transaction or reservation holding it runs
   *  no statement, before it fails with `PGLITE_SESSION_DEADLOCK`. Default {@link DEFAULT_DEADLOCK_TIMEOUT_MS}. */
  deadlockTimeoutMs?: number;
  /** Close the database when this client ends. Default false: the database belongs to whoever created it. */
  closeOnEnd?: boolean;
}

export interface OpenPgliteClientOptions extends Omit<PgliteClientOptions, "pglite" | "closeOnEnd"> {
  /** PGlite data directory (`memory://…`, `opfs-ahp://…`, `idb://…` or a file path); omitted means in memory. */
  dataDir?: string;
  /** Other options for `PGlite.create`. */
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
    const res = await session.db.query(`
      select b.oid, b.typarray
      from pg_catalog.pg_type a
      left join pg_catalog.pg_type b on b.oid = a.typelem
      where a.typcategory = 'A'
      group by b.oid, b.typarray
      order by b.oid
    `);
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
const STARTS_TRANSACTION = /^\s*(begin|start\s+transaction)\b/i;

let nextClientId = 0;

interface ClientState {
  readonly id: number;
  readonly session: Session;
  readonly schema: string;
  readonly parsers: Record<number, PgliteParser> | undefined;
  readonly mapError: (error: unknown) => unknown;
  readonly debug: PgliteStatementHook | undefined;
  readonly deadlockTimeoutMs: number;
  readonly closeOnEnd: boolean;
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

/** Makes the client's schema the session's `search_path` (session-level, so run it outside any transaction). */
async function applySearchPath(state: ClientState): Promise<void> {
  const { session } = state;
  if (session.searchPath === state.schema) return;
  session.searchPath = undefined;
  await session.db.query(`select set_config('search_path', '${state.schema.replace(/'/g, "''")}', false)`);
  session.searchPath = state.schema;
}

/** Runs one statement on the session the holder owns. */
async function runStatement(state: ClientState, holder: Holder, q: PgliteQuery, topLevel: boolean): Promise<PgliteResult> {
  const { session } = state;
  await loadArrayTypes(session);
  const compiled = compileQuery(q);
  state.debug?.(state.id, compiled.text, compiled.params, compiled.types);
  if (topLevel && STARTS_TRANSACTION.test(compiled.text))
    throw new PgliteSqlError("UNSAFE_TRANSACTION", "Only use sql.begin, sql.reserve or a transaction handle to start a transaction");
  let res: PgliteResults | undefined;
  try {
    if (q.simple) {
      const all = await session.db.exec(compiled.text, state.parsers === undefined ? undefined : { parsers: state.parsers });
      res = all[all.length - 1];
    } else {
      res = await session.db.query(compiled.text, compiled.params, {
        paramTypes: compiled.types,
        serializers: session.serializers,
        ...(state.parsers === undefined ? {} : { parsers: state.parsers }),
      });
    }
  } catch (error) {
    throw state.mapError(error);
  } finally {
    if (MENTIONS_SEARCH_PATH.test(compiled.text)) {
      session.searchPath = undefined;
      holder.searchPathTouched = true;
    }
  }
  if (RESETS_SEARCH_PATH.test(compiled.text)) await applySearchPath(state);
  return toResult(res);
}

function releaseHolder(state: ClientState, holder: Holder): void {
  if (holder.searchPathTouched) state.session.searchPath = undefined;
  state.session.lock.release(holder);
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
      const holder = await state.session.lock.acquire("statement", state.deadlockTimeoutMs);
      try {
        return await holder.run(async () => {
          await applySearchPath(state);
          return runStatement(state, holder, q, true);
        });
      } finally {
        releaseHolder(state, holder);
      }
    })();
    track(state, op).then(q.resolve, q.reject);
  };
  const sql = makeSql(state, topLevel);

  sql.begin = (mode: unknown, fn?: (tx: SqlFunction) => unknown): Promise<unknown> => {
    if (fn === undefined) {
      fn = mode as (tx: SqlFunction) => unknown;
      mode = "";
    }
    if (state.ended) return Promise.reject(connectionEnded());
    const body = fn;
    const op = (async () => {
      const holder = await state.session.lock.acquire("transaction", state.deadlockTimeoutMs);
      try {
        await holder.run(() => applySearchPath(state));
        const start = new PgliteQuery([`begin ${String(mode).replace(/[^a-z ]/gi, "")}`], [], () => undefined, true);
        await holder.run(() => runStatement(state, holder, start, false));
        return await transactionScope(state, holder, body, undefined, { savepoints: 0 });
      } finally {
        await holder.drained();
        releaseHolder(state, holder);
      }
    })();
    return track(state, op);
  };

  sql.reserve = async (): Promise<SqlFunction> => {
    if (state.ended) throw connectionEnded();
    const holder = await state.session.lock.acquire("reservation", state.deadlockTimeoutMs);
    try {
      await holder.run(() => applySearchPath(state));
    } catch (error) {
      releaseHolder(state, holder);
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
    reserved.release = (): void => {
      if (released) return;
      released = true;
      void holder.drained().then(() => {
        releaseHolder(state, holder);
        finish();
      });
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
  const state: ClientState = {
    id: nextClientId++,
    session: sessionOf(opts.pglite),
    schema,
    parsers: opts.parsers,
    mapError: opts.mapError ?? ((error) => error),
    debug: opts.debug,
    deadlockTimeoutMs,
    closeOnEnd: opts.closeOnEnd ?? false,
    pending: new Set(),
    ended: false,
    ending: undefined,
  };
  return makeClient(state, opts.pglite);
}

/** Opens a PGlite database (in memory unless `dataDir` is given) and a client that closes it when it ends. */
export async function openPgliteClient(opts: OpenPgliteClientOptions = {}): Promise<UmbraDBSql> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { dataDir, pgliteOptions, ...client } = opts;
  const pglite = await PGlite.create(dataDir, pgliteOptions);
  return createPgliteClient({ ...client, pglite, closeOnEnd: true });
}
