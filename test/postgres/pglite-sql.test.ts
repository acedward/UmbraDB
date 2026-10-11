/**
 * The PGlite client (`src/postgres/pglite-sql.ts`) on an in-memory PGlite database: query compilation (the exact text,
 * parameters and type oids postgres.js produces), the shared single session (lock, per-client `search_path`,
 * transactions, savepoints, reservations, deadlock detection), results, errors and `end()`.
 * `pglite-sql.differential.test.ts` compares the same client against postgres.js on PostgreSQL 17.
 */
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import {
  compileQuery,
  createPgliteClient,
  escapeIdentifier,
  openPgliteClient,
  PgliteQuery,
  PgliteSqlError,
  pgliteBlobQuery,
  type PgliteDatabase,
  type PgliteResult,
} from "../../src/postgres/pglite-sql.js";

interface Logged { text: string; params: unknown[]; types: number[] }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Compiles the query a tagged-template call produces, without running it (the client loads the array types first). */
async function compiled(sql: UmbraDBSql, build: (sql: UmbraDBSql) => unknown): Promise<Logged> {
  await sql`select 1`;
  const q = build(sql);
  if (!(q instanceof PgliteQuery)) throw new Error("not a query");
  return compileQuery(q);
}

/** A database that forwards every method the client uses to `own`, with `overrides` in place of some. */
function forward(own: PGlite, overrides: Partial<PgliteDatabase> = {}): PgliteDatabase {
  return {
    query: (text, params, options) => own.query(text, params, options as never),
    exec: (text, options) => own.exec(text, options as never),
    _runExclusiveTransaction: (fn) => own._runExclusiveTransaction(fn),
    runExclusive: (fn) => own.runExclusive(fn),
    execProtocolStream: (message, options) => own.execProtocolStream(message, options),
    _handleBlob: (blob) => own._handleBlob(blob),
    _cleanupBlob: () => own._cleanupBlob(),
    _getWrittenBlob: () => own._getWrittenBlob(),
    syncToFs: () => own.syncToFs(),
    get parsers() {
      return own.parsers;
    },
    close: () => own.close(),
    get closed() {
      return own.closed;
    },
    isInTransaction: () => own.isInTransaction(),
    ...overrides,
  };
}

describe("PGlite client", () => {
  let db: PGlite;
  let a: UmbraDBSql;
  let b: UmbraDBSql;
  const log: Logged[] = [];

  beforeAll(async () => {
    db = await PGlite.create();
    a = createPgliteClient({ pglite: db, schema: "pa", debug: (_c, text, params, types) => log.push({ text, params: [...params], types: [...types] }) });
    b = createPgliteClient({ pglite: db, schema: "pb", deadlockTimeoutMs: 150 });
    await a`create schema pa`;
    await a`create schema pb`;
    await a`create table t (id int8 primary key, b bytea, j jsonb, tags text[], ops bytea[], at timestamptz, ok bool, n numeric)`;
    await b`create table t (id int8 primary key, note text)`;
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  describe("compilation, as postgres.js compiles", () => {
    it("[[pglite.client.fragments]] nests fragments, conditional and empty fragments and arrays of fragments, numbering parameters in order", async () => {
      const c = await compiled(a, (sql) => {
        const where = (id?: number) => (id === undefined ? sql`` : sql`AND id = ${id}`);
        const order = sql`ORDER BY ${sql("id")} DESC`;
        return sql`SELECT ${sql("id")} FROM ${sql("pa")}.t WHERE n > ${1} ${where(7)} ${where()} ${[sql`AND true`, sql`AND ok = ${true}`]} ${order} LIMIT ${2}`;
      });
      expect(c.text).toBe('SELECT "id" FROM "pa".t WHERE n > $1 AND id = $2   AND true AND ok = $3 ORDER BY "id" DESC LIMIT $4');
      expect(c.params).toEqual([1, 7, true, 2]);
      expect(c.types).toEqual([0, 0, 16, 0]);
    });

    it("[[pglite.client.fragment-reuse]] reuses one fragment in several statements and inlines unsafe text used as a fragment", async () => {
      const at = a`id = ${5}`;
      const one = await compiled(a, (sql) => sql`DELETE FROM t WHERE ${at}`);
      const two = await compiled(a, (sql) => sql`SELECT ${sql.unsafe("count(*)")} FROM t WHERE ${at} AND ${at}`);
      expect(one).toEqual({ text: "DELETE FROM t WHERE id = $1", params: [5], types: [0] });
      expect(two).toEqual({ text: "SELECT count(*) FROM t WHERE id = $1 AND id = $2", params: [5, 5], types: [0, 0] });
    });

    it("[[pglite.client.identifiers]] quotes identifiers, each part of a dotted name, and escapes quotes", () => {
      expect(escapeIdentifier("a.b")).toBe('"a"."b"');
      expect(escapeIdentifier('we"ird')).toBe('"we""ird"');
    });

    it("[[pglite.client.type-oids]] infers the type oids postgres.js sends: Date 1184, bytes 17, boolean 16, bigint 20, json 3802, arrays by element; others 0", async () => {
      const d = new Date("2026-01-02T03:04:05.000Z");
      const bytes = new Uint8Array([1]);
      const c = await compiled(a, (sql) =>
        sql`SELECT ${d}, ${bytes}, ${false}, ${10n}, ${sql.json({ a: 1 })}, ${sql.array(["x"])}, ${sql.array([bytes, null], 17)},
          ${sql.array([1n])}, ${sql.array([])}, ${(sql.array as unknown as (...values: number[]) => never)(1, 2)}, ${["s"]}, ${[true]}, ${"s"}, ${1.5}, ${null}, ${sql.typed("1", 23)}`);
      expect(c.types).toEqual([1184, 17, 16, 20, 3802, 1009, 1001, 1016, 0, 1009, 0, 16, 0, 0, 0, 23]);
      expect(c.params).toEqual([d, bytes, false, 10n, { a: 1 }, ["x"], [bytes, null], [1n], [], [1, 2], ["s"], [true], "s", 1.5, null, "1"]);
    });

    it("[[pglite.client.insert-builders]] builds insert column lists and value rows from objects, rows and named columns", async () => {
      const row = { id: 1n, note: "x" };
      expect(await compiled(a, (sql) => sql`INSERT INTO t ${sql(row)} ON CONFLICT DO NOTHING`)).toEqual({
        text: 'INSERT INTO t ("id","note")values($1,$2) ON CONFLICT DO NOTHING', params: [1n, "x"], types: [20, 0],
      });
      expect((await compiled(a, (sql) => sql`insert into t ${sql([row, { id: 2n, note: "y" }])}`)).text).toBe('insert into t ("id","note")values($1,$2),($3,$4)');
      expect((await compiled(a, (sql) => sql`insert into t ${sql(row, "id")}`)).text).toBe('insert into t ("id")values($1)');
    });

    it("[[pglite.client.other-builders]] builds update assignments, values lists, in lists (empty: null), select lists and returning lists", async () => {
      expect((await compiled(a, (sql) => sql`update t set ${sql({ note: "z", ok: true })} where id = ${1}`)).text).toBe('update t set "note"=$1,"ok"=$2 where id = $3');
      expect((await compiled(a, (sql) => sql`update t set ${sql({ note: "z", ok: true }, ["note"])}`)).text).toBe('update t set "note"=$1');
      expect((await compiled(a, (sql) => sql`select * from (values ${sql([[1, 2], [3, 4]] as never)}) v`)).text).toBe("select * from (values ($1,$2),($3,$4)) v");
      expect((await compiled(a, (sql) => sql`select * from t where id in ${sql([1, 2] as never)}`)).text).toBe("select * from t where id in ($1,$2)");
      expect((await compiled(a, (sql) => sql`select * from t where id in ${sql([] as never)}`)).text).toBe("select * from t where id in (null)");
      expect((await compiled(a, (sql) => sql`select ${sql(["id", "note"])} from t`)).text).toBe('select "id","note" from t');
      expect((await compiled(a, (sql) => sql`select ${sql("id", "note" as never)} from t`)).text).toBe('select "id","note" from t');
      expect((await compiled(a, (sql) => sql`select ${sql({ x: 1, y: sql`now()`, z: sql("id") } as never)} from t`)).text).toBe('select $1 as "x",now() as "y","id" as "z" from t');
      expect((await compiled(a, (sql) => sql`delete from t returning ${sql(["id"])}`)).text).toBe('delete from t returning "id"');
      expect((await compiled(a, (sql) => sql`${sql(["id", "note"])}`)).text).toBe('"id","note"');
    });

    it("[[pglite.client.unsafe-compile]] compiles unsafe text with parameters after the text, and refuses an undefined value", async () => {
      expect(await compiled(a, (sql) => sql.unsafe("select $1::int + $2", [1, 2n]))).toEqual({ text: "select $1::int + $2", params: [1, 2n], types: [0, 20] });
      await expect(a`select ${undefined as never}`).rejects.toMatchObject({ code: "UNDEFINED_VALUE" });
      await expect(a`select ${a.array([1, undefined] as never)}::int[]`).rejects.toMatchObject({ code: "UNDEFINED_VALUE" });
    });

    it("[[pglite.client.non-tagged-call]] awaiting an identifier or a helper value is refused as a non-tagged call", () => {
      expect(() => (a("t") as unknown as { then(): void }).then()).toThrow(/NOT_TAGGED_CALL/);
      expect(() => (a.json(1) as unknown as { catch(): void }).catch()).toThrow(/NOT_TAGGED_CALL/);
      expect(() => (a({ x: 1 } as never) as unknown as { finally(): void }).finally()).toThrow(/NOT_TAGGED_CALL/);
    });
  });

  describe("parameters and results", () => {
    it("[[pglite.client.parameters-results]] serializes parameters by their described type and returns arrays with count, command and columns", async () => {
      const at = new Date("2026-03-04T05:06:07.000Z");
      const ins = await a`INSERT INTO t ${a({ id: 1n, b: new Uint8Array([0xde, 0xad]), j: a.json({ k: [1, "two"] }), tags: a.array(['q"uo\\te', "b,c"]), ops: a.array([new Uint8Array([9]), null], 17), at, ok: false, n: "12.50" })}`;
      expect([ins.count, ins.command, ins.length]).toEqual([1, "INSERT", 0]);
      const rows = await a`SELECT id, b, j, tags, ops, at, ok, n, ${"plain"}::text AS s, ${a.json("str")}::jsonb AS js FROM t WHERE id = ${1n}`;
      expect(rows.count).toBe(1);
      expect(rows.columns.map((c) => c.name)).toEqual(["id", "b", "j", "tags", "ops", "at", "ok", "n", "s", "js"]);
      const r = rows[0]!;
      expect(r.b).toEqual(new Uint8Array([0xde, 0xad]));
      expect(r.j).toEqual({ k: [1, "two"] });
      expect(r.tags).toEqual(['q"uo\\te', "b,c"]);
      expect(r.ops).toEqual([new Uint8Array([9]), null]);
      expect((r.at as Date).toISOString()).toBe(at.toISOString());
      expect([r.ok, r.n, r.s, r.js]).toEqual([false, "12.50", "plain", "str"]);
      // A string bound to a jsonb parameter is a JSON string, a number bound to an int8 parameter its decimal text.
      expect((await a`SELECT ${"{}"}::jsonb AS v, ${"x"}::bytea AS w, ${["a", null]}::text[] AS t2, ${[[1, 2], [3, 4]]}::int[] AS m`)[0]).toEqual({ v: "{}", w: new Uint8Array([0x78]), t2: ["a", null], m: [[1, 2], [3, 4]] });
      expect((await a`SELECT ${"2026-01-01"}::date AS d, ${true}::text AS tt, ${3}::int8 AS i8`)[0]).toMatchObject({ tt: "true", i8: 3n });
      // Bytes from an ArrayBuffer, an array of numbers or text; box[] uses ';' between elements.
      expect((await a`SELECT ${new Uint8Array([1, 2]).buffer as never}::bytea AS x, ${[3, 4]}::bytea AS y, ${12}::bytea AS z, ${["(1,1),(0,0)", "(2,2),(1,1)"]}::box[] AS bx`)[0])
        .toEqual({ x: new Uint8Array([1, 2]), y: new Uint8Array([3, 4]), z: new Uint8Array([0x31, 0x32]), bx: ["(1,1),(0,0)", "(2,2),(1,1)"] });
      expect((await a`SELECT ${a.array([a.typed("5", 23), null], 23)}::int[] AS p`)[0]).toEqual({ p: [5, null] });
      const none = await a.unsafe("");
      expect([none.length, none.count, none.command]).toEqual([0, null, null]);
      const map = Array.from(await a`SELECT 1 AS x UNION ALL SELECT 2`, (x) => x.x);
      expect(map).toEqual([1, 2]);
      expect((await a`SELECT 1 AS x`).map((x) => x.x)).toEqual([1]);
      expect(Object.keys(await a`SELECT 1 AS x`)).toEqual(["0"]); // count/command/columns are not enumerable
      const ddl = await a`CREATE TEMP TABLE tmp_x (a int)`;
      expect([ddl.count, ddl.command]).toEqual([null, "CREATE"]);
      expect((await a`UPDATE t SET ok = ${true} WHERE id = ${2n}`).count).toBe(0);
    });

    it("[[pglite.client.unsafe-run]] runs unsafe text with several statements and unsafe text with parameters", async () => {
      const r = await a.unsafe("CREATE TEMP TABLE tmp_u (x int); INSERT INTO tmp_u VALUES (1), (2); SELECT count(*)::int AS n FROM tmp_u") as unknown as PgliteResult[];
      expect(r.map((x) => [[...x], x.count, x.command])).toEqual([[[], 2, "INSERT"], [[{ n: 2 }], 1, "SELECT"]]);
      expect([...(await a.unsafe("SELECT $1::int + 1 AS v", [41]))]).toEqual([{ v: 42 }]);
      expect([...(await a.unsafe("SELECT 7 AS v", { simple: false } as never))]).toEqual([{ v: 7 }]);
    });

    it("[[pglite.client.unsafe-results]] unsafe text with several statements gives every statement's rows, grouped as postgres.js groups them: a new result at each statement that describes rows after the first", async () => {
      const two = await a.unsafe("SELECT 1 AS a; SELECT 2 AS b") as unknown as PgliteResult[];
      expect(Array.isArray(two[0])).toBe(true);
      expect(two.map((x) => [[...x], x.count, x.command, x.columns.map((c) => c.name)])).toEqual([
        [[{ a: 1 }], 1, "SELECT", ["a"]],
        [[{ b: 2 }], 1, "SELECT", ["b"]],
      ]);
      // Statements that describe no rows join the result before them: its rows and columns, the first count, the last command.
      await a.unsafe("CREATE TEMP TABLE tmp_r (x int)");
      const joined = await a.unsafe("SELECT 1 AS a UNION ALL SELECT 2; INSERT INTO tmp_r VALUES (1), (2), (3); UPDATE tmp_r SET x = 0");
      expect([[...joined], joined.count, joined.command, joined.columns.map((c) => c.name)]).toEqual([[{ a: 1 }, { a: 2 }], 2, "UPDATE", ["a"]]);
      const three = await a.unsafe("INSERT INTO tmp_r VALUES (4) RETURNING x; DELETE FROM tmp_r WHERE x = 0; SELECT count(*)::int AS n FROM tmp_r; SELECT x FROM tmp_r WHERE false") as unknown as PgliteResult[];
      expect(three.map((x) => [[...x], x.count, x.command])).toEqual([
        [[{ x: 4 }], 1, "DELETE"],
        [[{ n: 1 }], 1, "SELECT"],
        [[], 0, "SELECT"],
      ]);
      const single = await a.unsafe("SELECT 5 AS v");
      expect(Array.isArray(single[0])).toBe(false);
      expect([[...single], single.count]).toEqual([[{ v: 5 }], 1]);
    });

    it("[[pglite.client.unsafe-zero-column]] a statement that describes rows of no column starts its own result, with or without rows; a statement that describes none joins the result before it, whatever its command", async () => {
      const shape = (r: PgliteResult | PgliteResult[]) =>
        (Array.isArray(r[0]) ? (r as PgliteResult[]) : [r as PgliteResult]).map((x) => [[...x], x.count, x.command, x.columns.map((c) => c.name)]);
      expect(shape(await a.unsafe("SELECT 1 AS a; SELECT WHERE false"))).toEqual([
        [[{ a: 1 }], 1, "SELECT", ["a"]],
        [[], 0, "SELECT", []],
      ]);
      expect(shape(await a.unsafe("SELECT WHERE false; SELECT 2 AS b"))).toEqual([
        [[], 0, "SELECT", []],
        [[{ b: 2 }], 1, "SELECT", ["b"]],
      ]);
      expect(shape(await a.unsafe("SELECT 1 AS a; SELECT FROM generate_series(1, 2); SELECT WHERE false; SELECT WHERE false"))).toEqual([
        [[{ a: 1 }], 1, "SELECT", ["a"]],
        [[{}, {}], 2, "SELECT", []],
        [[], 0, "SELECT", []],
        [[], 0, "SELECT", []],
      ]);
      // SELECT INTO reports a SELECT command but describes no rows; a table of no column and EXECUTE describe them.
      await a.unsafe("CREATE TEMP TABLE tmp_z ()");
      expect(shape(await a.unsafe("SELECT 1 AS a; SELECT 3 AS c INTO TEMP tmp_into; INSERT INTO tmp_z DEFAULT VALUES"))).toEqual([
        [[{ a: 1 }], 1, "INSERT", ["a"]],
      ]);
      expect(shape(await a.unsafe("SELECT 1 AS a; SELECT * FROM tmp_z WHERE false; DELETE FROM tmp_z"))).toEqual([
        [[{ a: 1 }], 1, "SELECT", ["a"]],
        [[], 0, "DELETE", []],
      ]);
      expect(shape(await a.unsafe("PREPARE z0 AS SELECT WHERE false; EXECUTE z0; DEALLOCATE z0"))).toEqual([
        [[], null, "PREPARE", []],
        [[], 0, "DEALLOCATE", []],
      ]);
      expect(shape(await a.unsafe("SELECT WHERE false"))).toEqual([[[], 0, "SELECT", []]]);
    });

    it("[[pglite.client.parsers-map-error]] passes the parsers option to every statement and the error of PGlite through mapError (normalized by default)", async () => {
      const mapped = createPgliteClient({ pglite: db, schema: "pa", parsers: { 20: (x) => `int8 ${x}` }, mapError: (e) => Object.assign(new Error("mapped"), { cause: e }) });
      expect((await mapped`SELECT 1::int8 AS v, 1.50::numeric AS n`)[0]).toEqual({ v: "int8 1", n: "1.50" });
      expect((await mapped.unsafe("SELECT 2::int8 AS v"))[0]!.v).toBe("int8 2");
      const err = await mapped`SELECT * FROM no_such_table`.catch((e: unknown) => e) as Error & { cause: { code: string; name: string } };
      expect([err.message, err.cause.code, err.cause.name]).toEqual(["mapped", "42P01", "error"]);
      const normalized = await a`SELECT * FROM no_such_table`.catch((e: unknown) => e) as { code: string; name: string };
      expect([normalized.code, normalized.name]).toEqual(["42P01", "PostgresError"]);
      expect(normalized).not.toBeInstanceOf(PgliteSqlError);
    });

    it("[[pglite.client.unsupported]] cursors, forEach, values, raw, describe, streams, cancel and listen are not supported", () => {
      const q = a`SELECT 1`;
      for (const m of ["cursor", "forEach", "values", "raw", "describe", "readable", "writable", "cancel"] as const)
        expect(() => (q as unknown as Record<string, () => void>)[m]!(), m).toThrow(/NOT_SUPPORTED/);
      for (const m of ["listen", "notify", "file", "subscribe", "largeObject"])
        expect(() => (a as unknown as Record<string, () => void>)[m]!(), m).toThrow(/NOT_SUPPORTED/);
    });
  });

  describe("one shared session", () => {
    it("[[pglite.client.search-path]] gives every client its own search_path, also for concurrent statements and transactions", async () => {
      const results = await Promise.all([
        a`SELECT current_schema() AS s`,
        b`SELECT current_schema() AS s`,
        a.begin("isolation level repeatable read read only", (tx) =>
          tx`SELECT current_schema() AS s, current_setting('transaction_isolation') AS iso, current_setting('transaction_read_only') AS ro`),
        b.begin("read only", (tx) => [tx`SELECT current_schema() AS s`, tx`SELECT current_setting('transaction_read_only') AS ro`]),
        b`INSERT INTO t ${b({ id: 7, note: "pb" })}`,
        a`SELECT count(*)::int AS n FROM t`,
      ]);
      expect(results.map((r) => JSON.parse(JSON.stringify(r)))).toEqual([
        [{ s: "pa" }], [{ s: "pb" }], [{ s: "pa", iso: "repeatable read", ro: "on" }], [[{ s: "pb" }], [{ ro: "on" }]], [], [{ n: 1 }],
      ]);
      expect([...(await b`SELECT note FROM t`)]).toEqual([{ note: "pb" }]);
      expect(a.umbradbSchema).toBe("pa");
      expect(Object.keys(a)).not.toContain("umbradbSchema");
    });

    it("[[pglite.client.transaction-statements]] writes the begin, commit, rollback and savepoint statements postgres.js writes", async () => {
      log.length = 0;
      await a.begin(async (tx) => {
        await tx`SELECT 1`;
        await tx.savepoint("named", (sp) => sp`SELECT 2`);
        await tx.savepoint((sp) => sp`SELECT 3`);
      });
      // The mode keeps letters and spaces only, so it cannot carry another statement.
      await expect(a.begin("isolation level repeatable read read only; drop table t", (tx) => tx`SELECT 4`)).rejects.toMatchObject({ code: "42601" });
      expect(log.map((l) => l.text)).toEqual([
        "begin ", "SELECT 1", 'savepoint "s0_named"', "SELECT 2", 'savepoint "s1"', "SELECT 3", "commit",
        "begin isolation level repeatable read read only drop table t",
      ]);
    });

    it("[[pglite.client.savepoint-rollback]] rolls a savepoint back to itself when its callback fails, keeping the transaction", async () => {
      await a`DELETE FROM t`;
      await a.begin(async (tx) => {
        await tx`INSERT INTO t (id) VALUES (10)`;
        await expect(tx.savepoint(async (sp) => {
          await sp`INSERT INTO t (id) VALUES (11)`;
          throw new Error("savepoint body failed");
        })).rejects.toThrow("savepoint body failed");
        await (tx.savepoint as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)`INSERT INTO t (id) VALUES (${12})`;
        await expect(tx.savepoint("bad", (sp) => sp`INSERT INTO t (id) VALUES (10)`)).rejects.toMatchObject({ code: "23505" });
      });
      expect((await a`SELECT id FROM t ORDER BY id`).map((r) => r.id)).toEqual([10n, 12n]);
    });

    it("[[pglite.client.rollback-rules]] rolls back when the callback throws, and when a statement failed even though the callback caught it", async () => {
      await expect(a.begin(async (tx) => {
        await tx`INSERT INTO t (id) VALUES (20)`;
        throw new Error("callback failed");
      })).rejects.toThrow("callback failed");
      await expect(a.begin(async (tx) => {
        await tx`INSERT INTO t (id) VALUES (21)`;
        await tx`INSERT INTO t (id) VALUES (21)`.catch(() => undefined);
        return "swallowed";
      })).rejects.toMatchObject({ code: "23505" });
      // A later statement of the aborted transaction fails with 25P02; the first error is the one reported.
      await expect(a.begin(async (tx) => {
        await tx`INSERT INTO t (id) VALUES (22)`;
        await tx`SELECT 1/0`.catch(() => undefined);
        await tx`SELECT 1`;
      })).rejects.toMatchObject({ code: "22012" });
      await expect(a.begin(() => {
        throw new Error("synchronous throw");
      })).rejects.toThrow("synchronous throw");
      expect((await a`SELECT id FROM t ORDER BY id`).map((r) => r.id)).toEqual([10n, 12n]);
      expect(await a.begin(async () => "no statements")).toBe("no statements");
    });

    it("[[pglite.client.ended-transaction]] refuses a statement on a transaction handle after the transaction ended", async () => {
      let leaked: UmbraDBSql | undefined;
      await a.begin(async (tx) => {
        leaked = tx as unknown as UmbraDBSql;
      });
      await expect(leaked!`SELECT 1`).rejects.toMatchObject({ code: "TRANSACTION_ENDED" });
    });

    it("[[pglite.client.begin-refused]] refuses BEGIN as a plain statement (only begin, reserve or a transaction handle start transactions)", async () => {
      await expect(a`BEGIN`).rejects.toMatchObject({ code: "UNSAFE_TRANSACTION" });
      await expect(a.unsafe("start transaction")).rejects.toMatchObject({ code: "UNSAFE_TRANSACTION" });
      expect((await a`SELECT 1 AS one`)[0]).toEqual({ one: 1 });
    });

    it("[[pglite.client.transaction-guard]] refuses a top-level statement that starts a transaction block before it runs, also behind comments or after other statements; BEGIN in quoted text, identifiers, comments or a DO body is not refused", async () => {
      const refused = [
        "/* caller A */ BEGIN",
        "-- a line comment\nbegin isolation level serializable",
        "/* outer /* nested */ still a comment */ BEGIN",
        "SELECT 1; BEGIN",
        "INSERT INTO t (id) VALUES (40); begin",
        "SELECT 'a;b'; START /* comment */ TRANSACTION READ ONLY",
        "SELECT $q$;$q$ AS s; begin",
      ];
      for (const text of refused) await expect(a.unsafe(text), text).rejects.toMatchObject({ code: "UNSAFE_TRANSACTION" });
      expect(db.isInTransaction()).toBe(false);
      expect((await a`SELECT count(*)::int AS n FROM t WHERE id = 40`)[0]).toEqual({ n: 0 }); // refused before it ran
      expect([...(await a.unsafe("SELECT 'BEGIN' AS s"))]).toEqual([{ s: "BEGIN" }]);
      expect([...(await a.unsafe('SELECT 1 AS "begin"'))]).toEqual([{ begin: 1 }]);
      expect([...(await a.unsafe("/* BEGIN */ SELECT 2 AS v -- ; BEGIN"))]).toEqual([{ v: 2 }]);
      expect([...(await a.unsafe("SELECT E'it\\'s; begin' AS e"))]).toEqual([{ e: "it's; begin" }]);
      await a.unsafe("DO $body$ BEGIN PERFORM 1; END $body$");
      await a.unsafe("DO 'BEGIN PERFORM 1; END'");
      expect(db.isInTransaction()).toBe(false);
    });

    it("[[pglite.client.unsafe-isolation]] a text run with unsafe never runs inside another transaction — one PGlite's transaction() holds, the client's own begin or another client's reservation: it waits for it, the transaction keeps every write, and the text then fails or succeeds on its own; a transaction of PGlite's transaction() started while a statement runs waits until the statement has handed the session on, so it is never taken for one the statement left open", async () => {
      const own = await PGlite.create();
      try {
        const c = createPgliteClient({ pglite: own, schema: "public" });
        const d = createPgliteClient({ pglite: own, schema: "public" });
        await c.unsafe("CREATE TABLE iso (id int)"); // both clients' caches are warm before the transactions below
        await d.unsafe("SELECT 1");
        /** While `hold` keeps a transaction open (it calls `opened` once its first write is in, then awaits `wait`), two
         *  texts from client `d`: one that fails, one that counts the rows. Their answers, once the holder has ended. */
        const textsDuring = async (hold: (opened: () => void, wait: Promise<void>) => Promise<unknown>): Promise<unknown[]> => {
          let letGo!: () => void;
          const wait = new Promise<void>((r) => { letGo = r; });
          let opened!: () => void;
          const isOpen = new Promise<void>((r) => { opened = r; });
          const held = hold(opened, wait);
          await isOpen;
          const texts = [
            d.unsafe("SELECT 1 / 0").then(() => "ran", (e: { code?: string }) => e.code),
            d.unsafe("SELECT count(*)::int AS n FROM iso").then((r) => [...r], (e: { code?: string }) => e.code),
          ];
          await sleep(30);
          letGo();
          await held;
          return Promise.all(texts);
        };

        // PGlite's own transaction(): the texts run after its commit, which keeps both writes.
        expect(await textsDuring((opened, wait) => own.transaction(async (t) => {
          await t.query("INSERT INTO iso VALUES (1)");
          opened();
          await wait;
          await t.query("INSERT INTO iso VALUES (2)");
        }))).toEqual(["22012", [{ n: 2 }]]);
        // The client's own begin.
        expect(await textsDuring((opened, wait) => c.begin(async (tx) => {
          await tx`INSERT INTO iso VALUES (3)`;
          opened();
          await wait;
          await tx`INSERT INTO iso VALUES (4)`;
        }))).toEqual(["22012", [{ n: 4 }]]);
        // Another client's reservation with a manual transaction.
        expect(await textsDuring(async (opened, wait) => {
          const r = await c.reserve();
          await r`BEGIN`;
          await r`INSERT INTO iso VALUES (5)`;
          opened();
          await wait;
          await r`INSERT INTO iso VALUES (6)`;
          await r`COMMIT`;
          r.release();
        })).toEqual(["22012", [{ n: 6 }]]);

        // PGlite's transaction() started while a statement with parameters runs (once its Execute is answered): it begins
        // only after the statement's last message, the statement answers, and the transaction keeps its writes.
        const order: string[] = [];
        let startDuring: (() => void) | undefined;
        const racing = createPgliteClient({
          pglite: forward(own, {
            execProtocolStream: async (message, options) => {
              if (startDuring === undefined && order.length > 0) order.push(String.fromCharCode(message[0]!));
              const r = await own.execProtocolStream(message, options);
              if (message[0] === "E".charCodeAt(0) && startDuring !== undefined) {
                const start = startDuring;
                startDuring = undefined;
                order.push("E");
                start();
              }
              return r;
            },
          }),
          schema: "public",
        });
        await racing`SELECT 1`; // its session's array types and search_path
        let tx: Promise<unknown> | undefined;
        startDuring = () => {
          tx = own.transaction(async (t) => {
            order.push("transaction");
            await t.query("INSERT INTO iso VALUES (7)");
            await sleep(30);
            await t.query("INSERT INTO iso VALUES (8)");
          });
        };
        expect([...(await racing`SELECT ${41}::int + 1 AS v`)]).toEqual([{ v: 42 }]);
        await tx;
        expect(order).toEqual(["E", "S", "transaction"]);
        expect((await own.query<{ id: number }>("SELECT id FROM iso ORDER BY id")).rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(own.isInTransaction()).toBe(false);
      } finally {
        await own.close();
      }
    });

    it("[[pglite.client.pglite-exclusion]] a transaction of PGlite's transaction(), and PGlite's query and exec, never run inside a client's begin or reservation: they wait until the client has handed the session on, never see its uncommitted rows, and a rollback of the client's undoes its own writes only", async () => {
      const own = await PGlite.create();
      try {
        const c = createPgliteClient({ pglite: own, schema: "public" });
        await c.unsafe("CREATE TABLE ex (id int)");
        const ids = async (): Promise<number[]> => (await own.query<{ id: number }>("SELECT id FROM ex ORDER BY id")).rows.map((r) => r.id);
        /** While `hold` keeps the client's transaction open (it calls `opened` once its first write is in, then awaits
         *  `wait`): PGlite's transaction() reads the table and writes 2, `query` writes 3, `exec` writes 4. Which of them
         *  had ended before the holder let go, what the transaction read, and how the holder ended. */
        const rawDuring = async (hold: (opened: () => void, wait: Promise<void>) => Promise<unknown>) => {
          let letGo!: () => void;
          const wait = new Promise<void>((r) => { letGo = r; });
          let opened!: () => void;
          const isOpen = new Promise<void>((r) => { opened = r; });
          const held = hold(opened, wait).then(() => "ended", (e: Error) => e.message);
          await isOpen;
          const ended: string[] = [];
          let seen: number[] | undefined;
          const raw = [
            own.transaction(async (t) => {
              seen = (await t.query<{ id: number }>("SELECT id FROM ex ORDER BY id")).rows.map((r) => r.id);
              await t.query("INSERT INTO ex VALUES (2)");
            }).then(() => ended.push("transaction")),
            own.query("INSERT INTO ex VALUES (3)").then(() => ended.push("query")),
            own.exec("INSERT INTO ex VALUES (4)").then(() => ended.push("exec")),
          ];
          await sleep(50);
          const before = [...ended];
          letGo();
          const outcome = await held;
          await Promise.all(raw);
          return { before, seen, outcome };
        };

        // The client's begin writes 1, then its callback fails: rolled back, and nothing else ran inside it.
        expect(await rawDuring((opened, wait) => c.begin(async (tx) => {
          await tx`INSERT INTO ex VALUES (1)`;
          opened();
          await wait;
          throw new Error("the callback fails");
        }))).toEqual({ before: [], seen: [], outcome: "the callback fails" });
        expect(await ids()).toEqual([2, 3, 4]);
        expect(own.isInTransaction()).toBe(false);

        // A reservation's manual transaction writes 5, then commits: the others run after the commit.
        await c`DELETE FROM ex`;
        expect(await rawDuring(async (opened, wait) => {
          const r = await c.reserve();
          try {
            await r`BEGIN`;
            await r`INSERT INTO ex VALUES (5)`;
            opened();
            await wait;
            await r`COMMIT`;
          } finally {
            r.release();
          }
        })).toEqual({ before: [], seen: [5], outcome: "ended" });
        expect(await ids()).toEqual([2, 3, 4, 5]);

        // A reservation's manual transaction rolled back: its write is gone, the others' are kept.
        await c`DELETE FROM ex`;
        expect(await rawDuring(async (opened, wait) => {
          const r = await c.reserve();
          try {
            await r`BEGIN`;
            await r`INSERT INTO ex VALUES (6)`;
            opened();
            await wait;
            await r`ROLLBACK`;
          } finally {
            r.release();
          }
        })).toEqual({ before: [], seen: [], outcome: "ended" });
        expect(await ids()).toEqual([2, 3, 4]);
        expect(own.isInTransaction()).toBe(false);
      } finally {
        await own.close();
      }
    });

    it("[[pglite.client.blob-copy]] pgliteBlobQuery runs a COPY with a file on a client, a transaction handle or a reserved handle, in the handle's turn; a function that is not a handle of a client, or a handle that has ended, is refused", async () => {
      const own = await PGlite.create();
      try {
        const c = createPgliteClient({ pglite: own, schema: "public" });
        await c`CREATE TABLE cp (id int, note text)`;
        await c`INSERT INTO cp VALUES (1, 'one'), (2, 'two')`;
        const out = await pgliteBlobQuery(c, "COPY cp TO '/dev/blob' WITH (FORMAT binary)");
        expect(out.affectedRows).toBe(2);
        expect(out.blob).toBeInstanceOf(Blob);
        const file = out.blob!;

        // In a transaction: the copy is part of it (rolled back with it).
        await expect(c.begin(async (tx) => {
          expect((await pgliteBlobQuery(tx, "COPY cp FROM '/dev/blob' WITH (FORMAT binary)", file)).affectedRows).toBe(2);
          expect([...(await tx`SELECT count(*)::int AS n FROM cp`)]).toEqual([{ n: 4 }]);
          throw new Error("undo");
        })).rejects.toThrow("undo");
        expect([...(await c`SELECT count(*)::int AS n FROM cp`)]).toEqual([{ n: 2 }]);

        // On a reservation, in its turn; a top-level statement waits for the release.
        const r = await c.reserve();
        let waited = false;
        const later = c`SELECT count(*)::int AS n FROM cp`.then((rows) => { waited = true; return [...rows]; });
        expect((await pgliteBlobQuery(r, "COPY cp FROM '/dev/blob' WITH (FORMAT binary)", file)).affectedRows).toBe(2);
        await sleep(20);
        expect(waited).toBe(false);
        r.release();
        expect(await later).toEqual([{ n: 4 }]);
        // A statement that is no copy, and one that fails: its error, as the client reports errors.
        expect((await pgliteBlobQuery(c, "DELETE FROM cp WHERE id = 2")).affectedRows).toBe(2);
        await expect(pgliteBlobQuery(c, "COPY no_such_table TO '/dev/blob'")).rejects.toMatchObject({ code: "42P01" });

        await expect(pgliteBlobQuery((() => undefined) as unknown as UmbraDBSql, "COPY cp TO '/dev/blob'")).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
        await expect(pgliteBlobQuery(r, "COPY cp TO '/dev/blob'")).rejects.toMatchObject({ code: "TRANSACTION_ENDED" });
        let handle: UmbraDBSql | undefined;
        await c.begin(async (tx) => { handle = tx as unknown as UmbraDBSql; });
        await expect(pgliteBlobQuery(handle!, "COPY cp TO '/dev/blob'")).rejects.toMatchObject({ code: "TRANSACTION_ENDED" });
        expect(own.isInTransaction()).toBe(false);
      } finally {
        await own.close();
      }
    });

    it("[[pglite.client.blob-copy-failure]] a pgliteBlobQuery that fails on a transaction handle fails the transaction even when the callback caught it: begin rejects with its error and nothing of the transaction is kept; on a savepoint handle the savepoint rejects and the transaction goes on; on a client it may not start a transaction block; a COPY TO that fails part-way leaves nothing for the next one", async () => {
      const own = await PGlite.create();
      try {
        const c = createPgliteClient({ pglite: own, schema: "public" });
        await c`CREATE TABLE cf (id int)`;
        const garbage = new Blob(["not a binary COPY file"]);
        const copyIn = "COPY cf FROM '/dev/blob' WITH (FORMAT binary)";
        const ids = async (): Promise<number[]> => [...(await c<{ id: number }[]>`SELECT id FROM cf ORDER BY id`)].map((r) => r.id);

        // The callback catches the failed copy and returns: begin still rejects with the copy's error, the insert is gone.
        let caught: string | undefined;
        await expect(c.begin(async (tx) => {
          await tx`INSERT INTO cf VALUES (1)`;
          await pgliteBlobQuery(tx, copyIn, garbage).catch((e: { code?: string }) => { caught = e.code; });
          return "success";
        })).rejects.toMatchObject({ code: "22P04" });
        expect(caught).toBe("22P04");
        expect(await ids()).toEqual([]);
        expect(own.isInTransaction()).toBe(false);

        // In a savepoint: the savepoint rejects with it and is rolled back; the transaction keeps the rest.
        let savepoint: string | undefined;
        await c.begin(async (tx) => {
          await tx`INSERT INTO cf VALUES (1)`;
          await tx.savepoint(async (sp) => {
            await sp`INSERT INTO cf VALUES (99)`;
            await pgliteBlobQuery(sp, copyIn, garbage).catch(() => undefined);
            return "inner";
          }).catch((e: { code?: string }) => { savepoint = e.code; });
          await tx`INSERT INTO cf VALUES (2)`;
        });
        expect(savepoint).toBe("22P04");
        expect(await ids()).toEqual([1, 2]);

        // On a client: a statement that starts a transaction block is refused, as a top-level statement is.
        await expect(pgliteBlobQuery(c, "BEGIN")).rejects.toMatchObject({ code: "UNSAFE_TRANSACTION" });
        expect(own.isInTransaction()).toBe(false);
        expect(await ids()).toEqual([1, 2]);

        // A COPY … TO that fails part-way (with parameters or as a text) leaves nothing for the next one, which gives
        // its own file only.
        const one = "COPY (SELECT 1) TO '/dev/blob' WITH (FORMAT binary)";
        const size = (await pgliteBlobQuery(c, one)).blob!.size;
        const partWay = "COPY (SELECT 1 / (5000 - g) FROM generate_series(1, 10000) g) TO '/dev/blob' WITH (FORMAT binary)";
        await expect(pgliteBlobQuery(c, partWay)).rejects.toMatchObject({ code: "22012" });
        expect((await pgliteBlobQuery(c, one)).blob!.size).toBe(size);
        await expect(c.unsafe(partWay)).rejects.toMatchObject({ code: "22012" });
        expect((await pgliteBlobQuery(c, one)).blob!.size).toBe(size);
      } finally {
        await own.close();
      }
    });

    it("[[pglite.client.large-results]] a statement with parameters, and a text, whose result holds 150,000 rows answers with every row, for a SELECT and an INSERT … RETURNING alike, and the rows are stored once", async () => {
      const own = await PGlite.create();
      try {
        const c = createPgliteClient({ pglite: own, schema: "public" });
        const N = 150_000;
        await c`CREATE TABLE big (id int)`;
        const check = (rows: ArrayLike<{ id: number }>): void => {
          expect(rows.length).toBe(N);
          expect([rows[0]!.id, rows[N - 1]!.id]).toEqual([1, N]);
        };
        // Parameters (the extended protocol): an INSERT … RETURNING, then a SELECT.
        check(await c.unsafe(`INSERT INTO big SELECT generate_series(1, $1::int) RETURNING id`, [N]) as unknown as Array<{ id: number }>);
        expect([...(await c`SELECT count(*)::int AS n FROM big`)]).toEqual([{ n: N }]);
        check(await c<{ id: number }[]>`SELECT id FROM big WHERE id > ${0} ORDER BY id`);
        // A text (the simple protocol): the same.
        await c`TRUNCATE big`;
        check(await c.unsafe(`INSERT INTO big SELECT generate_series(1, ${N}) RETURNING id`) as unknown as Array<{ id: number }>);
        expect([...(await c`SELECT count(*)::int AS n FROM big`)]).toEqual([{ n: N }]);
        check(await c.unsafe("SELECT id FROM big ORDER BY id") as unknown as Array<{ id: number }>);
      } finally {
        await own.close();
      }
    }, 120_000);

    it("[[pglite.client.transaction-isolation]] the session is never handed on inside a transaction: a statement that leaves one open is rolled back and refused, and a reservation released inside one has it rolled back", async () => {
      // A client's hidden BEGIN, then another client's acknowledged write, then the first client's ROLLBACK.
      await expect(a.unsafe("/* caller A */ BEGIN")).rejects.toMatchObject({ code: "UNSAFE_TRANSACTION" });
      await b`INSERT INTO t (id, note) VALUES (41, 'acknowledged')`;
      await a`ROLLBACK`;
      expect([...(await b`SELECT note FROM t WHERE id = 41`)]).toEqual([{ note: "acknowledged" }]);

      // Whatever its text: here a database that runs BEGIN for a statement the text check cannot recognize.
      const own = await PGlite.create();
      try {
        const disguisedQuery = new TextEncoder().encode("Q\0\0\0\x17SELECT 'disguised'\0");
        const begin = new TextEncoder().encode("Q\0\0\0\x0aBEGIN\0");
        const disguised = forward(own, {
          execProtocolStream: (message, options) =>
            own.execProtocolStream(message.length === disguisedQuery.length && message.every((x, i) => x === disguisedQuery[i]) ? begin : message, options),
        });
        const x = createPgliteClient({ pglite: disguised, schema: "public" });
        const y = createPgliteClient({ pglite: disguised, schema: "public" });
        await y`CREATE TABLE w (id int)`;
        await expect(x.unsafe("SELECT 'disguised'")).rejects.toMatchObject({ code: "UNSAFE_TRANSACTION" });
        expect(own.isInTransaction()).toBe(false);
        await y`INSERT INTO w VALUES (1)`;
        await x`ROLLBACK`;
        // A reservation released with its manual transaction still open: rolled back, the next statement runs outside it.
        const r = await x.reserve();
        await r`BEGIN`;
        await r`INSERT INTO w VALUES (2)`;
        r.release();
        await y`INSERT INTO w VALUES (3)`;
        expect(own.isInTransaction()).toBe(false);
        await x`ROLLBACK`;
        expect([...(await y`SELECT id FROM w ORDER BY id`)]).toEqual([{ id: 1 }, { id: 3 }]);
      } finally {
        await own.close();
      }
    });

    it("[[pglite.client.handle-shapes]] transaction handles have savepoint and no begin; top-level clients have begin and no savepoint; reserved handles neither", async () => {
      expect(typeof (a as unknown as { savepoint?: unknown }).savepoint).toBe("undefined");
      expect(typeof a.begin).toBe("function");
      await a.begin(async (tx) => {
        expect(typeof (tx as unknown as { savepoint?: unknown }).savepoint).toBe("function");
        expect(typeof (tx as unknown as { begin?: unknown }).begin).toBe("undefined");
        expect(() => (tx as unknown as { prepare(): void }).prepare()).toThrow(/NOT_SUPPORTED/);
      });
      const r = await a.reserve();
      expect([typeof (r as unknown as { begin?: unknown }).begin, typeof (r as unknown as { savepoint?: unknown }).savepoint]).toEqual(["undefined", "undefined"]);
      r.release();
    });

    it("[[pglite.client.reserve]] reserve() holds the session for its own statements until release(); RESET search_path returns to the client's schema", async () => {
      const reserved = await a.reserve();
      let other = false;
      const waiting = b`SELECT 1`.then(() => {
        other = true;
      });
      await reserved`BEGIN`;
      await reserved`INSERT INTO t (id) VALUES (30)`;
      await sleep(50);
      expect(other).toBe(false);
      await reserved`COMMIT`;
      await reserved`SET search_path = pb, public`;
      expect((await reserved`SELECT current_schema() AS s`)[0]).toEqual({ s: "pb" });
      await reserved`RESET search_path`;
      expect((await reserved`SHOW search_path`)[0]).toEqual({ search_path: "pa" });
      reserved.release();
      reserved.release();
      await waiting;
      expect(other).toBe(true);
      await expect(reserved`SELECT 1`).rejects.toMatchObject({ code: "RESERVATION_RELEASED" });
      expect((await a`SELECT current_schema() AS s, count(*)::int AS n FROM t WHERE id = 30`)[0]).toEqual({ s: "pa", n: 1 });
      expect((await b`SELECT current_schema() AS s`)[0]).toEqual({ s: "pb" });
    });

    it("[[pglite.client.deadlock]] a statement on the outer client awaited inside a transaction fails with PGLITE_SESSION_DEADLOCK instead of hanging", async () => {
      const started = Date.now();
      await expect(b.begin(async (tx) => {
        await tx`SELECT 1`;
        await b`SELECT 2`;
      })).rejects.toMatchObject({ code: "PGLITE_SESSION_DEADLOCK" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(140);
      await expect(b.begin(async () => b.begin(async (inner) => inner`SELECT 1`))).rejects.toMatchObject({ code: "PGLITE_SESSION_DEADLOCK" });
      const reserved = await b.reserve();
      await expect(b.reserve()).rejects.toMatchObject({ code: "PGLITE_SESSION_DEADLOCK" });
      reserved.release();
      expect((await b`SELECT 3 AS v`)[0]).toEqual({ v: 3 });
    });

    it("[[pglite.client.busy-wait]] a statement waiting behind a transaction that keeps running statements waits as long as needed", async () => {
      const order: string[] = [];
      const tx = b.begin(async (t) => {
        for (let i = 0; i < 4; i++) await t`SELECT pg_sleep(0.1)`;
        order.push("transaction");
      });
      await sleep(10);
      const waiter = b`SELECT 1`.then(() => order.push("waiter"));
      await Promise.all([tx, waiter]);
      expect(order).toEqual(["transaction", "waiter"]);
    });

    it("[[pglite.client.fifo]] runs waiting statements in arrival order", async () => {
      const order: number[] = [];
      const hold = a.begin(async (tx) => {
        await tx`SELECT 1`;
        await sleep(30);
      });
      await sleep(5);
      await Promise.all([1, 2, 3, 4].map((i) => (i % 2 ? a : b)`SELECT ${i}::int AS i`.then((r) => order.push(r[0]!.i as number))));
      await hold;
      expect(order).toEqual([1, 2, 3, 4]);
    });
  });

  describe("options and end()", () => {
    it("[[pglite.client.array-type-retry]] a failed array-type load fails the statement and is retried by the next one", async () => {
      const own = await PGlite.create();
      try {
        let fail = true;
        const pgType = new TextEncoder().encode("pg_type");
        const mentions = (message: Uint8Array, word: Uint8Array): boolean =>
          message.some((_, i) => word.every((x, j) => message[i + j] === x));
        const c = createPgliteClient({
          pglite: forward(own, {
            execProtocolStream: async (message, options) => {
              if (fail && message[0] === "P".charCodeAt(0) && mentions(message, pgType)) {
                fail = false;
                throw new Error("array types unavailable");
              }
              return own.execProtocolStream(message, options);
            },
          }),
          schema: "public",
        });
        await expect(c`SELECT 1 AS v`).rejects.toThrow("array types unavailable");
        expect(fail).toBe(false);
        expect([...(await c`SELECT 1 AS v`)]).toEqual([{ v: 1 }]);
        expect([...(await c`SELECT ${["a", "b"]}::text[] AS v`)]).toEqual([{ v: ["a", "b"] }]);
        expect(own.isInTransaction()).toBe(false);
      } finally {
        await own.close();
      }
    });

    it("[[pglite.client.option-validation]] validates the schema and the deadlock timeout", () => {
      expect(() => createPgliteClient({ pglite: db, schema: "Bad-Name" })).toThrow(/invalid schema name/);
      expect(() => createPgliteClient({ pglite: db, deadlockTimeoutMs: 0 })).toThrow(RangeError);
      expect(createPgliteClient({ pglite: db }).umbradbSchema).toBe("umbradb");
    });

    it("[[pglite.client.end]] end() waits for the client's pending statements, then refuses new ones; the database stays open unless the client owns it", async () => {
      const c = createPgliteClient({ pglite: db, schema: "pa" });
      const slow = c`SELECT pg_sleep(0.05), 1 AS v`.execute(); // handled before end() takes effect, so it still runs
      const ended = c.end();
      expect(c.end()).toBe(ended);
      expect((await slow)[0]!.v).toBe(1);
      await ended;
      await expect(c`SELECT 1`).rejects.toMatchObject({ code: "CONNECTION_ENDED" });
      await expect(c.begin((tx) => tx`SELECT 1`)).rejects.toMatchObject({ code: "CONNECTION_ENDED" });
      await expect(c.reserve()).rejects.toMatchObject({ code: "CONNECTION_ENDED" });
      expect(db.closed).toBe(false);
      const t = createPgliteClient({ pglite: db, schema: "pa" });
      const r = await t.reserve();
      await t.end({ timeout: 0.05 }); // a reservation that is never released does not block end() past its timeout
      r.release();
    });

    it("[[pglite.client.open-memory]] openPgliteClient opens an in-memory database that end() closes", async () => {
      const own = await openPgliteClient({ schema: "public" });
      expect((await own`SELECT current_schema() AS s`)[0]).toEqual({ s: "public" });
      await own.end();
      const ownDb = { closed: true, close: () => Promise.reject(new Error("closed twice")) } as unknown as PgliteDatabase;
      await createPgliteClient({ pglite: ownDb, closeOnEnd: true }).end();
    });
  });
});
