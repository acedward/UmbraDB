/**
 * The PGlite client against postgres.js: the same repository code runs on PostgreSQL 17 (Testcontainers, postgres.js)
 * and on PGlite (in memory, `src/postgres/pglite-sql.ts`), and every statement it sends is compared — text, parameter
 * values and parameter type oids, in order — then the results: every table of both schemas and every API response.
 *
 * The code paths are the real ones: the chain-archive and `mip0018` migrations through `runMigrations` (durability
 * probe, `reserve()` with a manual BEGIN/COMMIT, advisory locks, `unsafe` partition DDL), the archive sync of the
 * recorded Stagenet tapes (`putBlockBundle`, JSON watermarks), the scan (insert builders, `sql.array` with element oid
 * 17, the cursor CAS read through `.count`), the HTTP API (every route, in `begin("isolation level repeatable read read
 * only")`, sequentially and concurrently), the activity listings and metadata reads on a top-level client
 * (`begin("read only")`), the rest of the archive store (blobs by role, verifier keys, canonical flips), the 110
 * MIP-0018 vector requests through the PostgreSQL consumer (a fresh migrated schema per request, `DROP SCHEMA … CASCADE`),
 * `removeAbove` (event replay) and the range digest (`sql(columns)` select lists). Together they run every tagged
 * template of the token indexer's runtime modules.
 *
 * Statements postgres.js sends for itself (its array-type lookup on each new connection) are not compared; the
 * durability probe's lock key carries the backend pid, which differs, and is compared without it.
 *
 * Known differences between the two drivers that the comparison allows for:
 * - PGlite runs with `fsync=off` by default, which the PGlite client accepts in its default `non-durable` mode; this
 *   file starts PGlite without PGlite's `-F` start parameter (`fsync` reads `on`) and uses `durable` clients, so the
 *   durability probe and `/v1/status` behave as on PostgreSQL.
 * - PGlite returns int8 as a number when it fits and bytea as `Uint8Array`; the PGlite database here parses int8 as
 *   `bigint` and bytea as `Buffer`, as postgres.js does in this repository, so the repository's code (which calls
 *   `Buffer` methods) runs unchanged.
 * - postgres.js returns a NULL element of a `bytea[]` as an empty Buffer, PGlite as `null`; rows compare with an
 *   empty `bytea` array element and a NULL element counted equal (the only such column is
 *   `mip0018_contract_actions.maintenance_operations`; the recorded ranges hold no NULL element).
 * - A PGlite error names the violated constraint `constraint`, postgres.js `constraint_name`, which
 *   `translatePostgresError` routes SQLSTATE 23514 by; the PGlite clients here copy `constraint` to `constraint_name`
 *   (their `mapError`), and one case shows the routing of PGlite's own error and of the client's default
 *   normalization.
 */
import { PGlite } from "@electric-sql/pglite";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import {
  DEFAULT_IDLE_IN_TX_TIMEOUT_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  type UmbraDBSql,
} from "../../src/postgres/client.js";
import { PgChainArchiveStore } from "../../src/postgres/chain-archive-store.js";
import { createPgliteClient } from "../../src/postgres/pglite-sql.js";
import { startFakeChain } from "../integration/fixtures/stagenet-archive/fake-chain-server.js";
import { loadManifest, loadRangeTape } from "../integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import { canonical, noNullElements, rangeTables } from "../../token-indexer/dev/range-tables.ts";
import { activityForColor, metadataTransactionsForContract } from "../../token-indexer/mip0018/activity.ts";
import { createMip0018Api, listen } from "../../token-indexer/mip0018/api-node.ts";
import { listEvents, eventCounts } from "../../token-indexer/mip0018/events.ts";
import { recomputeFields } from "../../token-indexer/mip0018/fields.ts";
import {
  chainEvents, contractRejections, describedKinds, displayAmountOf, getIdentity, groupOf, listGroups, listIdentities,
  listMetadataContracts, tokenMarkOf,
} from "../../token-indexer/mip0018/metadata.ts";
import { UMBRADB_VECTORS_DIR, VENDORED_VECTORS_DIR, vectorSets } from "../../token-indexer/mip0018/run-vectors.ts";
import { createPgVectorConsumer } from "../../token-indexer/mip0018/vector-adapter-pg.ts";
import { loadVectors, runVectors, type Json } from "../../token-indexer/vendor/mip0018/vectors/tools/runner-core.ts";
import { Mip0018Scanner } from "../../token-indexer/mip0018/scan.ts";
import { builtinTokens, listColors, nativeTokens } from "../../token-indexer/mip0018/tokens.ts";

const NET = "stagenet";

/** The error field postgres.js names `constraint_name`, from PGlite's `constraint`. */
const constraintName = (e: unknown): unknown => {
  const err = e as { constraint?: unknown; constraint_name?: unknown } | null;
  if (err !== null && typeof err === "object" && typeof err.constraint === "string" && err.constraint_name === undefined)
    err.constraint_name = err.constraint;
  return e;
};
const RECORDED_DIGEST = "af6583d0"; // the first characters of the recorded live-range digest (fixtures/live-range)

interface Statement { text: string; params: unknown; types: number[] }

/** One run of the scenario: a client and the statements it sent. */
interface Backend {
  name: "postgres" | "pglite";
  log: Statement[];
  /** Client of the main scenario (schema `diff_mip`) and of the second range (schema `u1_mip`). */
  sql: UmbraDBSql;
  u1: UmbraDBSql;
}

/** Values as comparable JSON: bytes as hex, 64-bit integers tagged, dates as ISO text. */
function plain(v: unknown): unknown {
  if (v instanceof Uint8Array) return `\\x${Buffer.from(v).toString("hex")}`;
  if (typeof v === "bigint") return `${v}n`;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

const POSTGRES_JS_ARRAY_TYPES = /^\s*select b\.oid, b\.typarray/;
const PROBE_KEY = /^(umbradb:durability-probe:pooler:)\d+$/;

function recorder(log: Statement[]): (connection: number, text: string, params: readonly unknown[], types: readonly number[]) => void {
  return (_connection, text, params, types) => {
    if (POSTGRES_JS_ARRAY_TYPES.test(text)) return;
    log.push({ text, params: plain(params.map((p) => (typeof p === "string" ? p.replace(PROBE_KEY, "$1<pid>") : p))), types: [...types] });
  };
}

/** A postgres.js client configured as `createClient` configures it, plus a statement log. */
function postgresClient(uri: string, schema: string, log: Statement[]): UmbraDBSql {
  const sql = postgres(uri, {
    connection: {
      search_path: schema,
      statement_timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
      lock_timeout: DEFAULT_LOCK_TIMEOUT_MS,
      idle_in_transaction_session_timeout: DEFAULT_IDLE_IN_TX_TIMEOUT_MS,
    },
    types: { bigint: postgres.BigInt },
    debug: recorder(log),
  });
  Object.defineProperty(sql, "umbradbSchema", { value: schema, enumerable: false, writable: false });
  return sql as unknown as UmbraDBSql;
}

/** Fails at the first statement that differs, showing both. */
function expectSameStatements(pg: readonly Statement[], lite: readonly Statement[], phase: string): void {
  const n = Math.min(pg.length, lite.length);
  for (let i = 0; i < n; i++) {
    if (canonical(pg[i]) !== canonical(lite[i]))
      expect.fail(`${phase}: statement ${i} differs\npostgres.js: ${canonical(pg[i]).slice(0, 2000)}\npglite:      ${canonical(lite[i]).slice(0, 2000)}`);
  }
  expect(lite.length, `${phase}: statement count`).toBe(pg.length);
}

/** Every row as comparable JSON; a `bytea[]` NULL element and an empty one compare equal (see the file comment). */
function comparableRows(rows: Map<string, string[]>): Record<string, string[]> {
  return Object.fromEntries([...rows].map(([table, rs]) => [table, rs.map((r) => r.replace(/(?<=\[|,)(null|"")(?=,|\])/g, "<null>"))]));
}

describe("PGlite client = postgres.js on PostgreSQL 17", () => {
  let container: StartedPostgreSqlContainer;
  let pglite: PGlite;
  const pg: Backend = { name: "postgres", log: [], sql: undefined as never, u1: undefined as never };
  const lite: Backend = { name: "pglite", log: [], sql: undefined as never, u1: undefined as never };
  const both = [pg, lite];
  const phase = async (name: string, run: (b: Backend) => Promise<void>): Promise<void> => {
    for (const b of both) {
      b.log.length = 0;
      await run(b);
    }
    expectSameStatements(pg.log, lite.log, name);
    console.log(`[pglite-differential] ${name}: ${lite.log.length} statements (${new Set(lite.log.map((s) => s.text)).size} distinct texts), identical on both`);
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    pg.sql = postgresClient(container.getConnectionUri(), "diff_mip", pg.log);
    pg.u1 = postgresClient(container.getConnectionUri(), "u1_mip", pg.log);
    pglite = await PGlite.create({
      startParams: PGlite.defaultStartParams.filter((p) => p !== "-F"),
      parsers: { 20: (x: string) => BigInt(x), 17: (x: string) => Buffer.from(x.slice(2), "hex") },
    });
    lite.sql = createPgliteClient({ pglite, schema: "diff_mip", debug: recorder(lite.log), mapError: constraintName, durability: "durable" });
    lite.u1 = createPgliteClient({ pglite, schema: "u1_mip", debug: recorder(lite.log), mapError: constraintName, durability: "durable" });
  }, 180_000);

  afterAll(async () => {
    for (const b of both) {
      await b.sql?.end({ timeout: 5 });
      await b.u1?.end({ timeout: 5 });
    }
    await pglite?.close();
    await container?.stop();
  }, 60_000);

  it("[[pglite.differential.migrations]] runs the chain-archive and mip0018 migrations through the migration runner (durability probe, reserve, BEGIN/COMMIT, unsafe DDL) with the same statements", async () => {
    await phase("migrations", async (b) => {
      await bootstrapChainArchiveSchema(b.sql, "diff_archive");
      await new Mip0018Scanner({ sql: b.sql, network: NET, schema: "diff_mip", archiveSchema: "diff_archive" }).bootstrap();
      await bootstrapChainArchiveSchema(b.u1, "u1_archive");
      await new Mip0018Scanner({ sql: b.u1, network: NET, schema: "u1_mip", archiveSchema: "u1_archive" }).bootstrap();
    });
    const texts = lite.log.map((s) => s.text);
    expect(texts).toContain("select current_setting($1) as v");
    expect(texts).toContain("BEGIN");
    expect(texts).toContain("COMMIT");
    expect(texts.filter((t) => /^CREATE TABLE "diff_archive"\.blocks_p\d+ PARTITION OF/.test(t)).length).toBeGreaterThan(0);
    expect(texts.some((t) => t.startsWith('set search_path = "diff_archive", public'))).toBe(true);
    expect(texts).toContain("reset search_path");
    expect(lite.log.length).toBeGreaterThan(100);
  }, 120_000);

  it("[[pglite.differential.sync]] archives the recorded IDX and U1 ranges with the sync service, sending the same statements", async () => {
    const ranges = loadManifest().ranges;
    const idx = ranges.find((r) => r.name === "idx")!;
    const u1 = ranges.find((r) => r.name === "u1")!;
    await phase("sync", async (b) => {
      for (const [sql, schema, name, range] of [[b.sql, "diff_archive", "idx", idx], [b.u1, "u1_archive", "u1", u1]] as const) {
        const f = await startFakeChain(loadRangeTape(name));
        try {
          // Two service instances: the second resumes from the archived cursor (and its last D-parameter).
          const middle = Math.floor((range.from + range.to) / 2);
          for (const endHeight of [middle, range.to]) {
            const svc = new ChainArchiveSyncService({
              sql, net: NET, schema, node: { url: f.nodeUrl }, indexer: { url: f.indexerUrl },
              startHeight: range.from, endHeight, concurrency: 4, backoff: { jitter: false, baseDelayMs: 1, maxDelayMs: 5 },
            });
            expect((await svc.syncOnce({ maxBlocks: 1_000 })).reachedEnd).toBe(true);
          }
        } finally {
          await f.close();
        }
      }
    });
    expect(lite.log.length).toBeGreaterThan(5_000);
    expect(lite.log.some((s) => s.types.includes(3802))).toBe(true); // sql.json watermark and segments
  }, 300_000);

  it("[[pglite.differential.scan-tables]] scans both ranges with the same statements and leaves every archive and mip0018 table equal; the recorded live-range digest holds on PostgreSQL", async () => {
    await phase("scan", async (b) => {
      for (const [sql, schema, archiveSchema] of [[b.sql, "diff_mip", "diff_archive"], [b.u1, "u1_mip", "u1_archive"]] as const) {
        const scanner = new Mip0018Scanner({ sql, network: NET, schema, archiveSchema });
        for (;;) {
          const r = await scanner.scanOnce({ maxBlocks: 100 });
          if (r.scannedBlocks === 0) break;
        }
      }
    });
    const texts = lite.log.map((s) => s.text);
    expect(texts.some((t) => /^INSERT INTO "diff_mip"\.mip0018_mints \("network",.*\)values\(\$1,/.test(t))).toBe(true); // tx(m)
    expect(texts.some((t) => /^INSERT INTO "diff_mip"\.mip0018_events \(/.test(t))).toBe(true); // tx(row)
    expect(texts.some((t) => /^INSERT INTO "diff_mip"\.mip0018_activity \(/.test(t))).toBe(true); // tx(r)
    expect(lite.log.some((s) => s.types.includes(1001))).toBe(true); // tx.array(operations, 17): bytea[]
    expect(lite.log.some((s) => s.types.includes(1009))).toBe(true); // tx.array(strings): text[]

    const tables = await Promise.all(both.map((b) => rangeTables(b.sql, "diff_archive", "diff_mip")));
    const u1Tables = await Promise.all(both.map((b) => rangeTables(b.u1, "u1_archive", "u1_mip")));
    expect(tables[0]!.digest.sha256.startsWith(RECORDED_DIGEST)).toBe(true);
    expect(Object.keys(tables[0]!.digest.tables)).toHaveLength(37);
    expect(comparableRows(tables[1]!.rows)).toEqual(comparableRows(tables[0]!.rows));
    expect(comparableRows(u1Tables[1]!.rows)).toEqual(comparableRows(u1Tables[0]!.rows));
    expect(tables[1]!.rows.get("mip0018.mip0018_events")!.length).toBeGreaterThan(0);
    // The recorded ranges hold no NULL operation element, so every table digest is equal, as is the whole digest.
    const differing = Object.keys(tables[0]!.digest.tables).filter((t) => tables[0]!.digest.tables[t]!.sha256 !== tables[1]!.digest.tables[t]!.sha256);
    expect(differing).toEqual([]);
    expect(tables[1]!.digest.sha256).toBe(tables[0]!.digest.sha256);
    expect(u1Tables[1]!.digest.sha256).toBe(u1Tables[0]!.digest.sha256);
    for (const b of both)
      expect((await b.sql`SELECT count(*)::int AS n FROM diff_mip.mip0018_contract_actions WHERE array_position(maintenance_operations, NULL) IS NOT NULL`)[0]!.n).toBe(0);
    // The NULL elements beside the digests (read by SQL, so postgres.js sees them too): none, on both.
    expect(tables[0]!.nullElements).toEqual(noNullElements(["mip0018.mip0018_contract_actions"]));
    expect(tables[1]!.nullElements).toEqual(tables[0]!.nullElements);
    expect(u1Tables[1]!.nullElements).toEqual(u1Tables[0]!.nullElements);
    console.log(`[pglite-differential] digests: postgres ${tables[0]!.digest.sha256}, pglite ${tables[1]!.digest.sha256}; differing tables: ${differing.join(", ") || "none"}`);
    // Negative control: one changed parameter is reported at its statement.
    const tampered = lite.log.map((s, i) => (i === 10 ? { ...s, params: ["changed"] } : s));
    expect(() => expectSameStatements(pg.log, tampered, "control")).toThrow(/control: statement 10 differs/);
  }, 300_000);

  it("[[pglite.differential.archive-store]] reads and writes through the rest of the archive store (blobs by role, verifier keys, canonical flips, lookups by height and hash) with the same statements and results", async () => {
    const out: unknown[][] = [[], []];
    await phase("store", async (b) => {
      const store = new PgChainArchiveStore(b.u1, "u1_archive");
      const o = out[both.indexOf(b)]!;
      const [block] = await store.getCanonicalChainRange(NET, 715409, 715409);
      const txs = await store.getTransactionsForBlock(NET, block!.blockHash);
      o.push(await store.getBlocksAtHeight(NET, 715409), await store.getCanonicalBlockAtHeight(NET, 715409));
      o.push(await store.getTransactionsByHash(NET, txs[0]!.txHash));
      o.push(await store.putBlobWithRole(new Uint8Array([1, 2, 3]), "proof"));
      await store.putVerifierKeyObservation({ vkBytes: new Uint8Array([7, 7]), net: NET, scope: "protocol", tag: "v1", firstSeenHeight: 715430 });
      await store.putVerifierKeyObservation({ vkBytes: new Uint8Array([7, 7]), net: NET, scope: "protocol", tag: "v1", firstSeenHeight: 715420 });
      o.push([...(await b.u1`SELECT scope, tag, first_seen_height FROM u1_archive.verifier_key_observations ORDER BY first_seen_height`)]);
      await store.setCanonical(NET, 715409, block!.blockHash, { finalized: true });
      // Un-marking the finalized canonical block violates `CHECK (NOT finalized OR is_canonical)` (23514).
      o.push(await store.setCanonical(NET, 715409, "ab".repeat(32)).catch((e: Error) => e.name));
      o.push(await store.getWatermark("sync_cursor:stagenet"));
    });
    expect(plain(out[1])).toEqual(plain(out[0]));
    expect(out[0]![5]).toBe("ChainArchiveCheckViolationError");
    // PGlite's own error (no `constraint_name`) would be routed as a clock regression; the client's default
    // normalization routes it as on PostgreSQL.
    const raw = new PgChainArchiveStore(createPgliteClient({ pglite, schema: "u1_mip", mapError: (e) => e }), "u1_archive");
    expect(await raw.setCanonical(NET, 715409, "ab".repeat(32)).catch((e: Error) => e.name)).toBe("ClockRegressionError");
    const normalized = new PgChainArchiveStore(createPgliteClient({ pglite, schema: "u1_mip" }), "u1_archive");
    expect(await normalized.setCanonical(NET, 715409, "ab".repeat(32)).catch((e: Error) => e.name)).toBe("ChainArchiveCheckViolationError");
  }, 60_000);

  it("[[pglite.differential.bytea-null-elements]] bytea[] NULL elements: postgres.js reads them as an empty Buffer, PGlite as null; unnest gives NULL on both", async () => {
    const out: unknown[] = [];
    await phase("bytea-array-null", async (b) => {
      await b.sql`CREATE TABLE diff_mip.ops (id int PRIMARY KEY, ops bytea[])`;
      await b.sql`INSERT INTO diff_mip.ops VALUES (1, ${b.sql.array([Buffer.from("0102", "hex"), null] as never, 17)})`;
      out.push(plain([...(await b.sql`SELECT ops FROM diff_mip.ops`)]));
      out.push(plain([...(await b.sql`SELECT o.op, o.n FROM diff_mip.ops, unnest(ops) WITH ORDINALITY AS o(op, n) ORDER BY o.n`)]));
      await b.sql`DROP TABLE diff_mip.ops`;
    });
    expect(out).toEqual([
      [{ ops: ["\\x0102", "\\x"] }], [{ op: "\\x0102", n: "1n" }, { op: null, n: "2n" }],
      [{ ops: ["\\x0102", null] }], [{ op: "\\x0102", n: "1n" }, { op: null, n: "2n" }],
    ]);
  }, 60_000);

  it("[[pglite.differential.unsafe-results]] unsafe text with several statements gives the same results in the same shape: one result, or one per statement that describes rows, with the same rows, counts, commands and columns", async () => {
    const shape = (r: unknown): unknown => {
      const one = (x: { count: number | null; command: string | null; columns: Array<{ name: string }> | null } & unknown[]) =>
        ({ rows: plain([...x]), count: x.count, command: x.command, columns: (x.columns ?? []).map((c) => c.name) });
      const all = r as Array<unknown>;
      return all.length > 0 && Array.isArray(all[0]) ? { results: all.map((x) => one(x as never)) } : one(r as never);
    };
    const out: Record<string, unknown[]> = { postgres: [], pglite: [] };
    await phase("unsafe-multi-statement", async (b) => {
      await b.sql.unsafe("CREATE TABLE diff_mip.multi (x int)");
      await b.sql.unsafe("CREATE TABLE diff_mip.nocol ()");
      for (const text of [
        "SELECT 1 AS a; SELECT 2 AS b",
        "INSERT INTO diff_mip.multi VALUES (1), (2); SELECT count(*)::int AS n FROM diff_mip.multi",
        "SELECT 1 AS a UNION ALL SELECT 2; INSERT INTO diff_mip.multi VALUES (3), (4), (5); UPDATE diff_mip.multi SET x = 0",
        "INSERT INTO diff_mip.multi VALUES (6) RETURNING x; DELETE FROM diff_mip.multi WHERE x = 0; SELECT x FROM diff_mip.multi WHERE false",
        "SELECT 7 AS v",
        // Statements that describe rows of no column, and statements that report a row count but describe no rows.
        "SELECT 1 AS a; SELECT WHERE false",
        "SELECT WHERE false; SELECT 2 AS b",
        "SELECT WHERE false",
        "SELECT 1 AS a; SELECT FROM generate_series(1, 2); SELECT WHERE false; SELECT WHERE false",
        "SELECT 1 AS a; SELECT 3 AS c INTO diff_mip.into_t; INSERT INTO diff_mip.nocol DEFAULT VALUES",
        "SELECT 1 AS a; SELECT * FROM diff_mip.nocol WHERE false; DELETE FROM diff_mip.nocol",
        "PREPARE z0 AS SELECT WHERE false; EXECUTE z0; DEALLOCATE z0",
        "SELECT * FROM diff_mip.nocol; UPDATE diff_mip.multi SET x = 1",
      ]) out[b.name]!.push(shape(await b.sql.unsafe(text)));
      await b.sql.unsafe("DROP TABLE diff_mip.multi; DROP TABLE diff_mip.nocol; DROP TABLE diff_mip.into_t");
    });
    expect(out.pglite).toEqual(out.postgres);
    expect(out.postgres![0]).toMatchObject({ results: [{ rows: [{ a: 1 }] }, { rows: [{ b: 2 }] }] });
    expect(out.postgres![5]).toEqual({ results: [{ rows: [{ a: 1 }], count: 1, command: "SELECT", columns: ["a"] }, { rows: [], count: 0, command: "SELECT", columns: [] }] });
  }, 60_000);

  it("[[pglite.differential.api]] answers every API route with the same responses and statements, one request at a time and concurrently", async () => {
    const servers = await Promise.all(both.map(async (b) => {
      const server = createMip0018Api({ sql: b.sql, network: NET, schema: "diff_mip", archiveSchema: "diff_archive", log: () => undefined, maxConcurrentRequests: 64 });
      return { server, port: await listen(server, 0) };
    }));
    try {
      const get = async (i: number, path: string): Promise<{ status: number; body: unknown }> => {
        const res = await fetch(`http://127.0.0.1:${servers[i]!.port}${path}`);
        return { status: res.status, body: await res.json() };
      };
      // The routes, from what the index holds.
      const mints = await pg.sql<{ color: Buffer; contract_address: Buffer }[]>`
        SELECT DISTINCT color, contract_address FROM diff_mip.mip0018_mints ORDER BY color`;
      const identities = await pg.sql<{ contract_address: Buffer; domain_sep: Buffer; kind: number }[]>`
        SELECT DISTINCT contract_address, domain_sep, kind FROM diff_mip.mip0018_fields ORDER BY 1, 2, 3`;
      const eventRefs = await pg.sql<{ contract_address: Buffer; tx_hash: Buffer }[]>`
        SELECT DISTINCT contract_address, tx_hash FROM diff_mip.mip0018_events WHERE tx_hash IS NOT NULL ORDER BY 1, 2`;
      const contracts = await pg.sql<{ contract_address: Buffer }[]>`
        SELECT DISTINCT contract_address FROM diff_mip.mip0018_contract_actions ORDER BY 1`;
      const hex = (b: Buffer): string => b.toString("hex");
      const paths = ["/v1/status", "/v1/tokens?limit=2", "/v1/tokens", "/v1/nope", "/v1/tokens/zz", "/v1/events", `/v1/lookup/${"00".repeat(32)}?held=shielded`];
      for (const m of mints)
        paths.push(`/v1/tokens/${hex(m.color)}`, `/v1/tokens/${hex(m.color)}/activity?limit=2`, `/v1/tokens/${hex(m.color)}/activity?order=desc`,
          `/v1/lookup/${hex(m.color)}?held=shielded`, `/v1/lookup/${hex(m.color)}?held=unshielded`);
      for (const c of contracts) paths.push(`/v1/contracts/${hex(c.contract_address)}/tokens`, `/v1/contracts/${hex(c.contract_address)}/activity?limit=3`);
      for (const id of identities) paths.push(`/v1/identities/${hex(id.contract_address)}/${hex(id.domain_sep)}/${id.kind}?limit=2`);
      for (const e of eventRefs.slice(0, 40)) paths.push(`/v1/events?contract=${hex(e.contract_address)}&limit=2`, `/v1/events?tx=${hex(e.tx_hash)}`);
      expect(paths.length).toBeGreaterThan(50);

      type Answer = { status: number; body: unknown };
      const answers: Answer[][] = [[], []];
      const first: Answer[][] = [[], []];
      for (let i = 0; i < both.length; i++) {
        both[i]!.log.length = 0;
        // Every route once, then its next page when it has one, so the cursor paths run too.
        for (const p of paths) {
          const a = await get(i, p);
          answers[i]!.push(a);
          first[i]!.push(a);
          const next = (a.body as { nextCursor?: string | null }).nextCursor;
          if (typeof next === "string") answers[i]!.push(await get(i, `${p}${p.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(next)}`));
        }
      }
      expectSameStatements(pg.log, lite.log, "api");
      console.log(`[pglite-differential] api: ${lite.log.length} statements (${new Set(lite.log.map((s) => s.text)).size} distinct texts) for ${answers[0]!.length} requests, identical on both`);
      expect(answers[1]).toEqual(answers[0]);
      expect(answers[0]!.filter((a) => a.status === 200).length).toBeGreaterThan(50);
      expect(answers[0]!.length).toBeGreaterThan(paths.length);
      expect(lite.log.filter((s) => s.text === "begin isolation level repeatable read read only").length).toBeGreaterThan(50);

      // Sixteen requests at a time: the same answers (on PGlite the transactions take the one session in turn).
      for (let i = 0; i < both.length; i++) {
        const concurrent: Answer[] = [];
        for (let k = 0; k < paths.length; k += 16) concurrent.push(...(await Promise.all(paths.slice(k, k + 16).map((p) => get(i, p)))));
        expect(concurrent).toEqual(first[i]);
      }
    } finally {
      for (const s of servers) await new Promise((r) => s.server.close(r));
    }
  }, 300_000);

  it("[[pglite.differential.top-level-reads]] reads through top-level clients (activity listings in their own read-only transactions, events, tokens) with the same results and statements", async () => {
    const color = (await pg.sql<{ color: Buffer }[]>`SELECT color FROM diff_mip.mip0018_mints ORDER BY block_height LIMIT 1`)[0]!.color.toString("hex");
    const contract = (await pg.sql<{ contract_address: Buffer }[]>`SELECT contract_address FROM diff_mip.mip0018_events ORDER BY block_height LIMIT 1`)[0]!.contract_address.toString("hex");
    const results: unknown[][] = [[], []];
    await phase("reads", async (b) => {
      const out = results[both.indexOf(b)]!;
      out.push(await activityForColor(b.sql, NET, color, { limit: 3 }, "diff_mip"));
      out.push(await activityForColor(b.sql, NET, color, { order: "desc" }, "diff_mip"));
      out.push(await metadataTransactionsForContract(b.sql, NET, contract, { limit: 2 }, "diff_mip"));
      out.push(await listEvents(b.sql, NET, {}, "diff_mip"));
      out.push(await listEvents(b.sql, NET, { contractAddress: contract }, "diff_mip"));
      out.push(await eventCounts(b.sql, NET, contract, "diff_mip"));
      out.push(await listColors(b.sql, NET, "diff_mip"), await nativeTokens(b.sql, NET, "diff_mip"), await builtinTokens(b.sql, NET, "diff_mip"));
      const ids = await listIdentities(b.sql, NET, {}, "diff_mip");
      const ref = { network: NET, contractAddress: ids[0]!.contractAddress, domainSep: ids[0]!.domainSep, kind: ids[0]!.kind };
      out.push(ids, await listIdentities(b.sql, NET, { contractAddress: ref.contractAddress, domainSep: ref.domainSep, kind: ref.kind }, "diff_mip"));
      out.push(await getIdentity(b.sql, ref, "diff_mip"), await listGroups(b.sql, NET, {}, "diff_mip"), await groupOf(b.sql, ref, "diff_mip"));
      out.push(await displayAmountOf(b.sql, ref, 123456789n, "diff_mip"), await contractRejections(b.sql, NET, contract, "diff_mip"));
      out.push(await tokenMarkOf(b.sql, ref, "diff_mip"), await listMetadataContracts(b.sql, NET, "diff_mip"));
      out.push(await chainEvents(b.sql, NET, {}, "diff_mip"), await chainEvents(b.sql, NET, { contractAddress: contract, includeIgnored: true }, "diff_mip"));
      out.push(await describedKinds(b.sql, NET, ref.contractAddress, ref.domainSep, "diff_mip"));
    });
    expect(plain(results[1])).toEqual(plain(results[0]));
    expect(lite.log.filter((s) => s.text === "begin read only").length).toBe(3);
  }, 120_000);

  it("[[pglite.differential.vectors]] answers the 110 MIP-0018 vector requests through the PostgreSQL write and read path (a fresh migrated schema per request) with the same statements and answers", async () => {
    const sets = vectorSets();
    const vectors = [...loadVectors({ dir: VENDORED_VECTORS_DIR, only: sets.reference.map((v) => v.id) }), ...loadVectors({ dir: UMBRADB_VECTORS_DIR })];
    const answers: Json[][] = [[], []];
    const reports: unknown[] = [];
    await phase("vectors", async (b) => {
      const consumer = createPgVectorConsumer({ sql: b.sql, schemaPrefix: "vec_diff" });
      const out = answers[both.indexOf(b)]!;
      const report = await runVectors(vectors, async (req) => {
        const res = await consumer.handle(req);
        out.push(JSON.parse(JSON.stringify(res)) as Json);
        return res;
      });
      reports.push({ normative: report.normative, informative: report.informative, failed: report.results.filter((r) => !r.ok).map((r) => r.id) });
    });
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[0]).toHaveLength(110);
    expect(reports[1]).toEqual(reports[0]);
    expect(reports[1]).toEqual({ normative: { passed: 67, total: 67 }, informative: { passed: 43, total: 43 }, failed: [] });
  }, 600_000);

  it("[[pglite.differential.remove-above]] removes the scan above a height (event replay) and rescans with the same statements and tables; recomputing the fields changes nothing", async () => {
    await phase("remove-rescan", async (b) => {
      const scanner = new Mip0018Scanner({ sql: b.sql, network: NET, schema: "diff_mip", archiveSchema: "diff_archive" });
      await scanner.removeAbove(714812); // C06 withdraws at 714813
      await b.sql.begin((tx) => recomputeFields(tx, "diff_mip", NET));
      for (;;) if ((await scanner.scanOnce({ maxBlocks: 200 })).scannedBlocks === 0) break;
      await b.sql.begin((tx) => recomputeFields(tx, "diff_mip", NET));
    });
    const tables = await Promise.all(both.map((b) => rangeTables(b.sql, "diff_archive", "diff_mip")));
    expect(tables[0]!.digest.sha256.startsWith(RECORDED_DIGEST)).toBe(true);
    expect(comparableRows(tables[1]!.rows)).toEqual(comparableRows(tables[0]!.rows));
    expect(tables[1]!.digest.sha256).toBe(tables[0]!.digest.sha256);

    // Negative control: one changed field value on PGlite makes exactly that table differ.
    await lite.sql`UPDATE diff_mip.mip0018_fields SET value = value || '\\x00'::bytea
      WHERE ctid = (SELECT ctid FROM diff_mip.mip0018_fields WHERE val_type = 1 LIMIT 1)`;
    const changed = comparableRows((await rangeTables(lite.sql, "diff_archive", "diff_mip")).rows);
    const reference = comparableRows(tables[0]!.rows);
    expect(Object.keys(reference).filter((t) => canonical(reference[t]) !== canonical(changed[t]))).toEqual(["mip0018.mip0018_fields"]);
  }, 300_000);
});
