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
  type PgliteDatabase,
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
    it("nests fragments, conditional and empty fragments and arrays of fragments, numbering parameters in order", async () => {
      const c = await compiled(a, (sql) => {
        const where = (id?: number) => (id === undefined ? sql`` : sql`AND id = ${id}`);
        const order = sql`ORDER BY ${sql("id")} DESC`;
        return sql`SELECT ${sql("id")} FROM ${sql("pa")}.t WHERE n > ${1} ${where(7)} ${where()} ${[sql`AND true`, sql`AND ok = ${true}`]} ${order} LIMIT ${2}`;
      });
      expect(c.text).toBe('SELECT "id" FROM "pa".t WHERE n > $1 AND id = $2   AND true AND ok = $3 ORDER BY "id" DESC LIMIT $4');
      expect(c.params).toEqual([1, 7, true, 2]);
      expect(c.types).toEqual([0, 0, 16, 0]);
    });

    it("reuses one fragment in several statements and inlines unsafe text used as a fragment", async () => {
      const at = a`id = ${5}`;
      const one = await compiled(a, (sql) => sql`DELETE FROM t WHERE ${at}`);
      const two = await compiled(a, (sql) => sql`SELECT ${sql.unsafe("count(*)")} FROM t WHERE ${at} AND ${at}`);
      expect(one).toEqual({ text: "DELETE FROM t WHERE id = $1", params: [5], types: [0] });
      expect(two).toEqual({ text: "SELECT count(*) FROM t WHERE id = $1 AND id = $2", params: [5, 5], types: [0, 0] });
    });

    it("quotes identifiers, each part of a dotted name, and escapes quotes", () => {
      expect(escapeIdentifier("a.b")).toBe('"a"."b"');
      expect(escapeIdentifier('we"ird')).toBe('"we""ird"');
    });

    it("infers the type oids postgres.js sends: Date 1184, bytes 17, boolean 16, bigint 20, json 3802, arrays by element; others 0", async () => {
      const d = new Date("2026-01-02T03:04:05.000Z");
      const bytes = new Uint8Array([1]);
      const c = await compiled(a, (sql) =>
        sql`SELECT ${d}, ${bytes}, ${false}, ${10n}, ${sql.json({ a: 1 })}, ${sql.array(["x"])}, ${sql.array([bytes, null], 17)},
          ${sql.array([1n])}, ${sql.array([])}, ${(sql.array as unknown as (...values: number[]) => never)(1, 2)}, ${["s"]}, ${[true]}, ${"s"}, ${1.5}, ${null}, ${sql.typed("1", 23)}`);
      expect(c.types).toEqual([1184, 17, 16, 20, 3802, 1009, 1001, 1016, 0, 1009, 0, 16, 0, 0, 0, 23]);
      expect(c.params).toEqual([d, bytes, false, 10n, { a: 1 }, ["x"], [bytes, null], [1n], [], [1, 2], ["s"], [true], "s", 1.5, null, "1"]);
    });

    it("builds insert column lists and value rows from objects, rows and named columns", async () => {
      const row = { id: 1n, note: "x" };
      expect(await compiled(a, (sql) => sql`INSERT INTO t ${sql(row)} ON CONFLICT DO NOTHING`)).toEqual({
        text: 'INSERT INTO t ("id","note")values($1,$2) ON CONFLICT DO NOTHING', params: [1n, "x"], types: [20, 0],
      });
      expect((await compiled(a, (sql) => sql`insert into t ${sql([row, { id: 2n, note: "y" }])}`)).text).toBe('insert into t ("id","note")values($1,$2),($3,$4)');
      expect((await compiled(a, (sql) => sql`insert into t ${sql(row, "id")}`)).text).toBe('insert into t ("id")values($1)');
    });

    it("builds update assignments, values lists, in lists (empty: null), select lists and returning lists", async () => {
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

    it("compiles unsafe text with parameters after the text, and refuses an undefined value", async () => {
      expect(await compiled(a, (sql) => sql.unsafe("select $1::int + $2", [1, 2n]))).toEqual({ text: "select $1::int + $2", params: [1, 2n], types: [0, 20] });
      await expect(a`select ${undefined as never}`).rejects.toMatchObject({ code: "UNDEFINED_VALUE" });
      await expect(a`select ${a.array([1, undefined] as never)}::int[]`).rejects.toMatchObject({ code: "UNDEFINED_VALUE" });
    });

    it("awaiting an identifier or a helper value is refused as a non-tagged call", () => {
      expect(() => (a("t") as unknown as { then(): void }).then()).toThrow(/NOT_TAGGED_CALL/);
      expect(() => (a.json(1) as unknown as { catch(): void }).catch()).toThrow(/NOT_TAGGED_CALL/);
      expect(() => (a({ x: 1 } as never) as unknown as { finally(): void }).finally()).toThrow(/NOT_TAGGED_CALL/);
    });
  });

  describe("parameters and results", () => {
    it("serializes parameters by their described type and returns arrays with count, command and columns", async () => {
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

    it("runs unsafe text with several statements (the last result) and unsafe text with parameters", async () => {
      const r = await a.unsafe("CREATE TEMP TABLE tmp_u (x int); INSERT INTO tmp_u VALUES (1), (2); SELECT count(*)::int AS n FROM tmp_u");
      expect([...r]).toEqual([{ n: 2 }]);
      expect([...(await a.unsafe("SELECT $1::int + 1 AS v", [41]))]).toEqual([{ v: 42 }]);
      expect([...(await a.unsafe("SELECT 7 AS v", { simple: false } as never))]).toEqual([{ v: 7 }]);
    });

    it("passes the parsers option to every statement and the error of PGlite through mapError (normalized by default)", async () => {
      const mapped = createPgliteClient({ pglite: db, schema: "pa", parsers: { 20: (x) => `int8 ${x}` }, mapError: (e) => Object.assign(new Error("mapped"), { cause: e }) });
      expect((await mapped`SELECT 1::int8 AS v, 1.50::numeric AS n`)[0]).toEqual({ v: "int8 1", n: "1.50" });
      expect((await mapped.unsafe("SELECT 2::int8 AS v"))[0]!.v).toBe("int8 2");
      const err = await mapped`SELECT * FROM no_such_table`.catch((e: unknown) => e) as Error & { cause: { code: string; name: string } };
      expect([err.message, err.cause.code, err.cause.name]).toEqual(["mapped", "42P01", "error"]);
      const normalized = await a`SELECT * FROM no_such_table`.catch((e: unknown) => e) as { code: string; name: string };
      expect([normalized.code, normalized.name]).toEqual(["42P01", "PostgresError"]);
      expect(normalized).not.toBeInstanceOf(PgliteSqlError);
    });

    it("cursors, forEach, values, raw, describe, streams, cancel and listen are not supported", () => {
      const q = a`SELECT 1`;
      for (const m of ["cursor", "forEach", "values", "raw", "describe", "readable", "writable", "cancel"] as const)
        expect(() => (q as unknown as Record<string, () => void>)[m]!(), m).toThrow(/NOT_SUPPORTED/);
      for (const m of ["listen", "notify", "file", "subscribe", "largeObject"])
        expect(() => (a as unknown as Record<string, () => void>)[m]!(), m).toThrow(/NOT_SUPPORTED/);
    });
  });

  describe("one shared session", () => {
    it("gives every client its own search_path, also for concurrent statements and transactions", async () => {
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

    it("writes the begin, commit, rollback and savepoint statements postgres.js writes", async () => {
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

    it("rolls a savepoint back to itself when its callback fails, keeping the transaction", async () => {
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

    it("rolls back when the callback throws, and when a statement failed even though the callback caught it", async () => {
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

    it("refuses a statement on a transaction handle after the transaction ended", async () => {
      let leaked: UmbraDBSql | undefined;
      await a.begin(async (tx) => {
        leaked = tx as unknown as UmbraDBSql;
      });
      await expect(leaked!`SELECT 1`).rejects.toMatchObject({ code: "TRANSACTION_ENDED" });
    });

    it("refuses BEGIN as a plain statement (only begin, reserve or a transaction handle start transactions)", async () => {
      await expect(a`BEGIN`).rejects.toMatchObject({ code: "UNSAFE_TRANSACTION" });
      await expect(a.unsafe("start transaction")).rejects.toMatchObject({ code: "UNSAFE_TRANSACTION" });
      expect((await a`SELECT 1 AS one`)[0]).toEqual({ one: 1 });
    });

    it("transaction handles have savepoint and no begin; top-level clients have begin and no savepoint; reserved handles neither", async () => {
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

    it("reserve() holds the session for its own statements until release(); RESET search_path returns to the client's schema", async () => {
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

    it("a statement on the outer client awaited inside a transaction fails with PGLITE_SESSION_DEADLOCK instead of hanging", async () => {
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

    it("a statement waiting behind a transaction that keeps running statements waits as long as needed", async () => {
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

    it("runs waiting statements in arrival order", async () => {
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
    it("a failed array-type load fails the statement and is retried by the next one", async () => {
      let fail = true;
      const fake = {
        closed: false,
        close: async () => undefined,
        exec: async () => [],
        query: async (text: string) => {
          if (fail) {
            fail = false;
            throw new Error("array types unavailable");
          }
          return { rows: text.includes("pg_type") ? [{ oid: 25, typarray: 1009 }, { oid: null, typarray: null }] : [{ v: 1 }], fields: [], rowCount: 1, command: "SELECT" };
        },
      } as unknown as PgliteDatabase;
      const c = createPgliteClient({ pglite: fake, schema: "pa" });
      await expect(c`SELECT 1`).rejects.toThrow("array types unavailable");
      expect([...(await c`SELECT 1`)]).toEqual([{ v: 1 }]);
    });

    it("validates the schema and the deadlock timeout", () => {
      expect(() => createPgliteClient({ pglite: db, schema: "Bad-Name" })).toThrow(/invalid schema name/);
      expect(() => createPgliteClient({ pglite: db, deadlockTimeoutMs: 0 })).toThrow(RangeError);
      expect(createPgliteClient({ pglite: db }).umbradbSchema).toBe("umbradb");
    });

    it("end() waits for the client's pending statements, then refuses new ones; the database stays open unless the client owns it", async () => {
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

    it("openPgliteClient opens an in-memory database that end() closes", async () => {
      const own = await openPgliteClient({ schema: "public" });
      expect((await own`SELECT current_schema() AS s`)[0]).toEqual({ s: "public" });
      await own.end();
      const ownDb = { closed: true, close: () => Promise.reject(new Error("closed twice")) } as unknown as PgliteDatabase;
      await createPgliteClient({ pglite: ownDb, closeOnEnd: true }).end();
    });
  });
});
