import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DustEventRecord } from "../../src/interfaces/chain-archive-store.js";
import { PgChainArchiveStore } from "../../src/postgres/chain-archive-store.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { DEFAULT_ARCHIVE_SCHEMA } from "../../src/postgres/archive-conventions.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../../src/postgres/migrations/chain_archive/index.js";
import { openDustDb, type DustDb } from "../../shielded-monitor/node/dust/db.js";
import { loadLedger } from "../../shielded-monitor/offers.js";
import { readDustNodeFixtureEvents } from "./dust-fixture.js";
import { dustRowsFromFixture } from "./dust-harness.js";

/**
 * `shielded-monitor/node/dust/db.ts`'s five queries against a REAL PostgreSQL, over rows project
 * A's own ingest path wrote (`spec/00016-dust-wallet-sync.md` §5.7, FR-015, FR-016; plan 00016
 * task 2.3).
 *
 * This is the half `dust-routes.test.ts` cannot prove. There the rows come from a fake, so the
 * route shapes are exercised and the SQL is not. Here the SAME rows are written through
 * `PgChainArchiveStore.putBlockBundle` — the ingest's own write path, contiguity guard and all —
 * and every query is compared against what the harness computed in TypeScript. If the lateral
 * join that merges the latest `dtime` is wrong, or a `numeric` comes back in a shape the route
 * cannot encode, it fails here and nowhere else.
 *
 * The schema name is the one A publishes (`DEFAULT_ARCHIVE_SCHEMA`), which is also what `db.ts`
 * defaults to — the test would otherwise be asserting against a name it chose itself.
 */

const NET = "preprod";
/** A quarter of the fixture: enough that the busiest owner has several rows and the merge has
 *  something to merge, without writing 715 block transactions per run. */
const EVENTS = 1_250;

describe("the DUST module's database queries", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let db: DustDb;
  let rows: Awaited<ReturnType<typeof dustRowsFromFixture>>;

  beforeAll(async () => {
    const ledger = await loadLedger();
    rows = await dustRowsFromFixture(ledger, readDustNodeFixtureEvents().slice(0, EVENTS));

    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema: DEFAULT_ARCHIVE_SCHEMA });
    await runMigrations(sql, { schema: DEFAULT_ARCHIVE_SCHEMA, migrations: chainArchiveMigrations });
    const store = new PgChainArchiveStore(sql, DEFAULT_ARCHIVE_SCHEMA);

    // One bundle per synthetic block, in height order — the shape the contiguity guard demands,
    // so the seed also exercises it rather than bypassing it with raw INSERTs.
    const byHeight = new Map<number, DustEventRecord[]>();
    for (const { record } of rows.records) {
      const list = byHeight.get(record.blockHeight) ?? [];
      list.push(record);
      byHeight.set(record.blockHeight, list);
    }
    const heights = [...byHeight.keys()].sort((a, b) => a - b);
    for (const height of heights) {
      const records = byHeight.get(height)!;
      const blockHash = records[0]!.blockHash;
      const parentHash = height === heights[0] ? "".padStart(64, "0") : (height - 1).toString(16).padStart(64, "0");
      const result = await store.putBlockBundle({
        block: {
          net: NET,
          height,
          blockHash,
          parentHash,
          stateRoot: "11".repeat(32),
          extrinsicsRoot: "22".repeat(32),
          headerBytes: new TextEncoder().encode(`header-${height}`),
          bodyBytes: new TextEncoder().encode(`body-${height}`),
          isCanonical: true,
          status: "canonical",
          finalized: true,
        },
        transactions: [],
        bridgeObservations: [],
        dustEvents: records,
      });
      // If the guard ever reported `gap` the comparisons below would silently compare two empty
      // sets, so the seed asserts it wrote what it was given.
      expect(result.dustCapture, `height ${height}`).toStrictEqual({ outcome: "written", rows: records.length });
    }

    db = openDustDb(container.getConnectionUri());
  }, 600_000);

  afterAll(async () => {
    await db?.close();
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  it("pages the replay stream by id, ascending, with the bytes the ingest stored", async () => {
    const first = await db.selectEventsAfter(NET, 0n, 100);
    expect(first).toHaveLength(100);
    expect(first.map((row) => row.id)).toStrictEqual(rows.records.slice(0, 100).map((r) => r.id));
    expect(first[0]!.id).toBe(1n);
    for (const [index, row] of first.entries()) {
      expect(Buffer.from(row.raw).equals(Buffer.from(rows.records[index]!.record.raw))).toBe(true);
      expect(row.blockHeight).toBe(BigInt(rows.records[index]!.record.blockHeight));
    }
    const next = await db.selectEventsAfter(NET, first.at(-1)!.id, 10);
    expect(next[0]!.id).toBe(first.at(-1)!.id + 1n);
    // Another net shares the table and must not appear.
    expect(await db.selectEventsAfter("devnet", 0n, 10)).toStrictEqual([]);
  });

  it("reports the table's own tip, and nothing for a net it holds no rows for", async () => {
    const tip = await db.selectTableTip(NET);
    expect(tip?.eventId).toBe(rows.records.at(-1)!.id);
    expect(tip?.height).toBe(BigInt(rows.records.at(-1)!.record.blockHeight));
    expect(await db.selectTableTip("devnet")).toBeUndefined();
  });

  it("returns an owner's initial UTxOs with the LATEST dtime, exactly as the TypeScript merge does", async () => {
    const owner = rows.busiestOwner;
    const expected = rows.initialUtxos.filter((row) => String(row.output.owner) === owner);
    expect(expected.length).toBeGreaterThan(1);
    const got = await db.selectInitialUtxosByOwner(NET, owner, 0n, 1_000);
    expect(got.map((row) => row.id)).toStrictEqual(expected.map((row) => row.id));
    for (const [index, row] of got.entries()) {
      expect(row.output).toStrictEqual(expected[index]!.output);
      // The lateral join is the whole reason this suite exists: a scalar subquery here would make
      // "no kind-2 row" and "a kind-2 row with no end time" the same answer.
      expect(row.generation).toStrictEqual(expected[index]!.generation);
      expect(row.generationIndex).toBe(expected[index]!.generationIndex);
      expect(Buffer.from(row.txHash).toString("hex")).toMatch(/^[0-9a-f]{64}$/);
    }
    // At least one entry really was updated later, so the merge is exercised and not vacuous.
    expect(got.some((row) => row.generation.dtime !== null && row.generation.dtime !== undefined)).toBe(true);
  });

  it("pages initial UTxOs by id", async () => {
    const owner = rows.busiestOwner;
    const all = await db.selectInitialUtxosByOwner(NET, owner, 0n, 1_000);
    const firstPage = await db.selectInitialUtxosByOwner(NET, owner, 0n, 2);
    expect(firstPage.map((r) => r.id)).toStrictEqual(all.slice(0, 2).map((r) => r.id));
    const secondPage = await db.selectInitialUtxosByOwner(NET, owner, firstPage.at(-1)!.id, 2);
    expect(secondPage.map((r) => r.id)).toStrictEqual(all.slice(2, 4).map((r) => r.id));
  });

  it("returns an owner's generation entries in index order, with the same merge", async () => {
    const owner = rows.busiestOwner;
    const expected = rows.generation.filter((row) => row.owner === owner);
    const got = await db.selectGenerationByOwner(NET, owner, 0n, 1_000);
    expect(got).toStrictEqual(expected);
    const paged = await db.selectGenerationByOwner(NET, owner, expected[0]!.generationIndex, 1_000);
    expect(paged).toStrictEqual(expected.slice(1));
  });

  it("answers a batch of nullifiers with ONE query, finding exactly the real ones", async () => {
    const real = rows.spends.slice(0, 50).map((row) => row.nullifier);
    const absent = Array.from({ length: 950 }, (_, i) => String(10n ** 70n + BigInt(i)));
    const got = await db.selectSpendsByNullifiers(NET, [...real, ...absent]);
    expect(got).toHaveLength(real.length);
    expect(got.map((row) => row.nullifier).sort()).toStrictEqual([...real].sort());
    const one = got.find((row) => row.nullifier === real[0])!;
    const source = rows.spends.find((row) => row.nullifier === real[0])!;
    // `toStrictEqual` would separate a driver `Buffer` from the harness's `Uint8Array` even when
    // the bytes are identical, so the byte field is compared as bytes and the rest as values.
    expect({ ...one, txHash: Buffer.from(one.txHash).toString("hex") })
      .toStrictEqual({ ...source, txHash: Buffer.from(source.txHash).toString("hex") });
    // `numeric` and `bigint` come back in the shapes the route encoder expects, not as `number`.
    expect(typeof one.vFee).toBe("string");
    expect(typeof one.commitmentIndex).toBe("bigint");
  });

  it("uses the partial indexes rather than scanning the table", async () => {
    // The lookup route's whole budget is one indexed probe (Story 3: < 30 ms for 1 000
    // nullifiers). A sequential scan would still be CORRECT, which is exactly why it needs an
    // assertion rather than a benchmark.
    const plan = await sql.unsafe(
      `EXPLAIN SELECT id FROM ${DEFAULT_ARCHIVE_SCHEMA}.dust_events ` +
        `WHERE net = '${NET}' AND kind = 3 AND nullifier = ANY(ARRAY[1,2,3]::numeric[])`,
    );
    const text = (plan as unknown as { "QUERY PLAN": string }[]).map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).not.toMatch(/Seq Scan/);
  });

  it("answers `undefined` for a net whose DUST parameters were never recorded (question Q-22)", async () => {
    // The honest answer, and the one that makes the mirror report `parametersSource: "unknown"`
    // rather than pretending the ledger's initial values were read off this chain. This replaced
    // the old checkpoint probe, whose `unavailable`/`none`/`ok` triple existed only because the
    // check needed two tables the reader role is not granted (questions Q-15 and Q-22).
    expect(await db.selectDustParametersAtOrBelow("a-net-nobody-ingested")).toBeUndefined();
  });

  it("selects the newest DUST parameters row at or below a height, and finds the indexed plan", async () => {
    const store = new PgChainArchiveStore(sql, DEFAULT_ARCHIVE_SCHEMA);
    const heights = await sql<{ height: string; block_hash: Uint8Array }[]>`
      SELECT height::text, block_hash FROM ${sql(DEFAULT_ARCHIVE_SCHEMA)}.blocks
      WHERE net = ${NET} ORDER BY height ASC
    `;
    expect(heights.length).toBeGreaterThan(2);
    const low = heights[0]!;
    const high = heights[heights.length - 1]!;
    await store.putDustParameters({
      net: NET,
      blockHeight: Number(low.height),
      blockHash: Buffer.from(low.block_hash).toString("hex"),
      nightDustRatio: "5000000000",
      generationDecayRate: "8267",
      dustGracePeriodSeconds: "10800",
      reason: "genesis",
    });
    await store.putDustParameters({
      net: NET,
      blockHeight: Number(high.height),
      blockHash: Buffer.from(high.block_hash).toString("hex"),
      // A DIFFERENT value, so "newest at or below" is testing an ordering rather than agreeing
      // with itself.
      nightDustRatio: "6000000000",
      generationDecayRate: "8267",
      dustGracePeriodSeconds: "10800",
      reason: "change",
    });

    expect((await db.selectDustParametersAtOrBelow(NET))?.nightDustRatio).toBe("6000000000");
    expect((await db.selectDustParametersAtOrBelow(NET, BigInt(high.height)))?.nightDustRatio)
      .toBe("6000000000");
    expect((await db.selectDustParametersAtOrBelow(NET, BigInt(high.height) - 1n))?.nightDustRatio)
      .toBe("5000000000");
    expect(await db.selectDustParametersAtOrBelow(NET, BigInt(low.height) - 1n)).toBeUndefined();

    // The node runs this once per batch on a cold fold of a million events, so it must be an
    // index scan and not a table scan.
    const plan = await sql.unsafe(
      `EXPLAIN SELECT block_height FROM ${DEFAULT_ARCHIVE_SCHEMA}.dust_parameters ` +
        `WHERE net = '${NET}' AND block_height <= 999999999 ORDER BY block_height DESC LIMIT 1`,
    );
    const text = (plan as unknown as { "QUERY PLAN": string }[]).map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).not.toMatch(/Seq Scan/);
  });
});
