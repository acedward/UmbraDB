import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgChainArchiveStore } from "../../src/postgres/chain-archive-store.js";
import { DEFAULT_ARCHIVE_SCHEMA } from "../../src/postgres/archive-conventions.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../../src/postgres/migrations/chain_archive/index.js";
import { bootstrapShieldedMonitorSchema } from "../../storage-api/bootstrap.js";
import { createDustModule } from "../../shielded-monitor/node/dust/index.js";
import { openDustDb, type DustDb } from "../../shielded-monitor/node/dust/db.js";
import { loadLedger } from "../../shielded-monitor/offers.js";
import { readDustNodeFixtureEvents } from "./dust-fixture.js";
import { dustRowsFromFixture } from "./dust-harness.js";

/**
 * **The part of Rule B that survives the 00016 waiver, proved at runtime**
 * (`spec/00016-dust-wallet-sync.md` §1, §5.3, FR-010, SC-006; plan 00016 D2.5(c)).
 *
 * The waiver lets one directory of project B open a database connection. It does NOT let it hold
 * a credential that can do anything: the role is `USAGE` on the archive schema plus `SELECT` on
 * `dust_events`, `dust_parameters` and `blocks`, and nothing else anywhere in the cluster.
 *
 * `replay_checkpoints` and `chain_blobs` are the two the role must NOT have, and they have their
 * own assertion below. They used to be an OPTIONAL stanza in the deployment doc, for a start-up
 * check that deserialized a whole `LedgerState`; on a real archive that blob is 31 MB and the node
 * stopped answering for minutes (question Q-22). Option C replaced the check with one small table,
 * and the stanza is gone — so an operator following the recipe cannot re-create the outage.
 *
 * As with `schema-isolation.integration.test.ts`, the proof is a **privilege boundary, not a code
 * review**: every query in `db.ts` runs as that exact role, so a query that ever read another
 * table would fail here with `permission denied` rather than needing someone to notice it. And
 * the positive controls are what keep it from being vacuous — the same role's `INSERT` into
 * `dust_events`, its `SELECT` on `chain_archive.transactions` and its `SELECT` on
 * `shielded_monitor.monitors` must each be REFUSED, so "nothing failed" cannot mean "the role
 * happened to have every privilege it needed".
 *
 * The GRANT script below is the one `docs/shielded-monitor-deployment.md` gives an operator. It is
 * copied here on purpose: a recipe nobody executes is a recipe nobody has checked.
 */

const NET = "preprod";
const MONITOR_SCHEMA = "shielded_monitor";
const READER = "dust_reader_test";
/** Generated per run: a committed constant that reads as a credential is what this repository's
 *  `gitleaks` gate exists to refuse, and the role lives and dies with the container. */
const READER_PASSWORD = randomUUID();

describe("the DUST reader role can read the two tables it is granted and nothing else", () => {
  let container: StartedPostgreSqlContainer;
  let admin: UmbraDBSql;
  let reader: DustDb;
  let readerUri: string;
  let owner: string;
  let nullifier: string;
  let parametersHeight: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ledger: any;

  beforeAll(async () => {
    ledger = await loadLedger();
    // A small seed in ONE block: this suite is about PRIVILEGES, not volume. 300 events rather
    // than 40 because preprod's stream opens with genesis initial-UTxO and dtime events — the
    // first `dustSpendProcessed`, which the lookup query needs, arrives later.
    const rows = await dustRowsFromFixture(ledger, readDustNodeFixtureEvents().slice(0, 300), 300);
    owner = rows.busiestOwner;
    nullifier = rows.spends[0]!.nullifier;

    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    admin = createClient({ connectionString: container.getConnectionUri(), schema: DEFAULT_ARCHIVE_SCHEMA });
    await runMigrations(admin, { schema: DEFAULT_ARCHIVE_SCHEMA, migrations: chainArchiveMigrations });
    await bootstrapShieldedMonitorSchema(admin, MONITOR_SCHEMA);

    const store = new PgChainArchiveStore(admin, DEFAULT_ARCHIVE_SCHEMA);
    const records = rows.records.map(({ record }) => record);
    const height = records[0]!.blockHeight;
    await store.putBlockBundle({
      block: {
        net: NET,
        height,
        blockHash: records[0]!.blockHash,
        parentHash: "".padStart(64, "0"),
        stateRoot: "11".repeat(32),
        extrinsicsRoot: "22".repeat(32),
        headerBytes: new TextEncoder().encode("header"),
        bodyBytes: new TextEncoder().encode("body"),
        isCanonical: true,
        status: "canonical",
        finalized: true,
      },
      transactions: [],
      bridgeObservations: [],
      dustEvents: records,
      // Question Q-22 option C: the ingest writes this row for the block it is committing, so the
      // node can read the chain's DUST parameters without deserializing anything.
      dustParameters: {
        net: NET,
        blockHeight: height,
        blockHash: records[0]!.blockHash,
        nightDustRatio: "5000000000",
        generationDecayRate: "8267",
        dustGracePeriodSeconds: "10800",
        reason: "genesis",
      },
    });
    parametersHeight = height;

    // ── The operator recipe from docs/shielded-monitor-deployment.md ─────────────────────────
    await admin.unsafe(`DROP ROLE IF EXISTS ${READER}`);
    await admin.unsafe(`CREATE ROLE ${READER} LOGIN PASSWORD '${READER_PASSWORD}'`);
    await admin.unsafe(`REVOKE ALL ON SCHEMA public FROM ${READER}`);
    await admin.unsafe(`GRANT USAGE ON SCHEMA ${DEFAULT_ARCHIVE_SCHEMA} TO ${READER}`);
    await admin.unsafe(
      `GRANT SELECT ON ${DEFAULT_ARCHIVE_SCHEMA}.dust_events, ` +
        `${DEFAULT_ARCHIVE_SCHEMA}.dust_parameters, ${DEFAULT_ARCHIVE_SCHEMA}.blocks TO ${READER}`,
    );

    const uri = new URL(container.getConnectionUri());
    uri.username = READER;
    uri.password = READER_PASSWORD;
    readerUri = uri.toString();
    reader = openDustDb(readerUri);
  }, 600_000);

  afterAll(async () => {
    await reader?.close();
    await admin?.end({ timeout: 5 });
    await container?.stop();
  });

  /** A raw connection as the reader, for the refusal cases — `db.ts` has no way to express them,
   *  which is the point. */
  async function asReader<T>(body: (sql: UmbraDBSql) => Promise<T>): Promise<T> {
    const sql = createClient({ connectionString: readerUri, schema: DEFAULT_ARCHIVE_SCHEMA, maxConnections: 2 });
    try {
      return await body(sql);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  it("runs every query in db.ts", async () => {
    const events = await reader.selectEventsAfter(NET, 0n, 10);
    expect(events.length).toBeGreaterThan(0);
    expect((await reader.selectTableTip(NET))?.eventId).toBeGreaterThan(0n);
    expect((await reader.selectInitialUtxosByOwner(NET, owner, 0n, 10)).length).toBeGreaterThan(0);
    expect((await reader.selectGenerationByOwner(NET, owner, 0n, 10)).length).toBeGreaterThan(0);
    expect(await reader.selectSpendsByNullifiers(NET, [nullifier])).toHaveLength(1);
    // Question Q-22 option C: the sixth query, and the one that replaced the checkpoint probe.
    const parameters = await reader.selectDustParametersAtOrBelow(NET);
    expect(parameters?.nightDustRatio).toBe("5000000000");
    expect(parameters?.blockHeight).toBe(BigInt(parametersHeight));
  });

  it("POSITIVE CONTROL: cannot write to dust_events", async () => {
    await asReader(async (sql) => {
      for (const statement of [
        `INSERT INTO ${DEFAULT_ARCHIVE_SCHEMA}.dust_events (net, id, block_height, block_hash, tx_position, event_index, tx_hash, kind, commitment, commitment_index, nullifier, v_fee, declared_time, block_time, payload, raw) VALUES ('${NET}', 999999, 1, '\\x${"00".repeat(32)}'::bytea, 0, 0, '\\x${"00".repeat(32)}'::bytea, 3, 1, 1, 1, 1, 1, 1, '{}'::jsonb, '\\x00'::bytea)`,
        `UPDATE ${DEFAULT_ARCHIVE_SCHEMA}.dust_events SET kind = 1`,
        `DELETE FROM ${DEFAULT_ARCHIVE_SCHEMA}.dust_events`,
      ]) {
        await expect(sql.unsafe(statement), statement.slice(0, 20)).rejects.toThrow(/permission denied/i);
      }
    });
  });

  it("POSITIVE CONTROL: cannot read any other archive table, or the monitor schema", async () => {
    await asReader(async (sql) => {
      // `transactions` is the control D2.5(c) names: it is in the SAME schema the role has USAGE
      // on, so a refusal here proves the grant is per-table and not per-schema.
      await expect(sql.unsafe(`SELECT 1 FROM ${DEFAULT_ARCHIVE_SCHEMA}.transactions LIMIT 1`))
        .rejects.toThrow(/permission denied/i);
      await expect(sql.unsafe(`SELECT 1 FROM ${DEFAULT_ARCHIVE_SCHEMA}.chain_blobs LIMIT 1`))
        .rejects.toThrow(/permission denied/i);
      await expect(sql.unsafe(`SELECT 1 FROM ${DEFAULT_ARCHIVE_SCHEMA}.replay_checkpoints LIMIT 1`))
        .rejects.toThrow(/permission denied/i);
      // And nothing of project B's own storage — the schema the waiver says nothing about.
      await expect(sql.unsafe(`SELECT 1 FROM ${MONITOR_SCHEMA}.monitors LIMIT 1`))
        .rejects.toThrow(/permission denied/i);
    });
  });

  it("can read `blocks`, which the role IS granted", async () => {
    // The other half of "per-table": the second granted table really is readable, so the refusals
    // above are about the grant list and not about the schema being unreachable.
    await asReader(async (sql) => {
      const rows = await sql.unsafe(`SELECT count(*)::text AS n FROM ${DEFAULT_ARCHIVE_SCHEMA}.blocks`);
      expect(Number((rows as unknown as { n: string }[])[0]!.n)).toBeGreaterThan(0);
    });
  });

  describe("the DUST parameters the node serves (question Q-22 option C)", () => {
    it("reads chain_archive.dust_parameters under the prescribed role, while the two checkpoint tables stay denied", async () => {
      // The whole point of option C in one assertion pair: the table the node now needs is
      // readable, and the two it used to need are not. The `permission denied` half is asserted
      // in the positive-control case above; here is the readable half, through `db.ts` itself.
      const row = await reader.selectDustParametersAtOrBelow(NET, BigInt(parametersHeight));
      expect(row).toStrictEqual({
        blockHeight: BigInt(parametersHeight),
        nightDustRatio: "5000000000",
        generationDecayRate: "8267",
        dustGracePeriodSeconds: "10800",
        reason: "genesis",
      });
      // A height BELOW the row's: "in force at or below" must not return a row from the future.
      expect(await reader.selectDustParametersAtOrBelow(NET, BigInt(parametersHeight) - 1n))
        .toBeUndefined();
    });

    it("builds the mirror from the row and reports parametersSource: chain", async () => {
      const lines: string[] = [];
      const module = createDustModule(
        { DUST_DATABASE_URL: readerUri },
        { net: NET, ledger, db: reader, logger: (line) => lines.push(line) },
      )!;
      await module.start();
      try {
        const status = module.status();
        expect(status.parametersSource).toBe("chain");
        expect(status.parametersHeight).toBe(String(parametersHeight));
        expect(status.parameters).toStrictEqual({
          nightDustRatio: "5000000000",
          generationDecayRate: "8267",
          dustGracePeriodSeconds: "10800",
        });
        expect(lines.join("\n")).toContain("DUST parameters from the archive at height");
      } finally {
        // `stop()` would close the shared reader connection the rest of this suite uses, so the
        // module is stopped in a way that tolerates that.
        await module.stop().catch(() => undefined);
      }
    }, 120_000);

    it("falls back to the ledger's initial parameters, and SAYS so, for a net with no row", async () => {
      // A different net rather than a second container: the query is per-net, so this is exactly
      // the shape of an archive ingested before migration 010 existed.
      const module = createDustModule(
        { DUST_DATABASE_URL: readerUri },
        { net: "a-net-with-no-parameters-row", ledger, db: reader },
      )!;
      await module.start();
      try {
        const status = module.status();
        expect(status.parametersSource).toBe("unknown");
        expect(status.parametersHeight).toBeNull();
        // The values are still the right ones -- they have been the same on every Midnight network
        // so far -- which is exactly why "probably right" must not read the same as "read off the
        // chain".
        expect(status.parameters.nightDustRatio).toBe("5000000000");
      } finally {
        await module.stop().catch(() => undefined);
      }
    }, 120_000);
  });
});
