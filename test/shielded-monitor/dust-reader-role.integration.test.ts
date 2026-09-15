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
 * `dust_events` and `blocks`, and nothing else anywhere in the cluster.
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
    });

    // ── The operator recipe from docs/shielded-monitor-deployment.md ─────────────────────────
    await admin.unsafe(`DROP ROLE IF EXISTS ${READER}`);
    await admin.unsafe(`CREATE ROLE ${READER} LOGIN PASSWORD '${READER_PASSWORD}'`);
    await admin.unsafe(`REVOKE ALL ON SCHEMA public FROM ${READER}`);
    await admin.unsafe(`GRANT USAGE ON SCHEMA ${DEFAULT_ARCHIVE_SCHEMA} TO ${READER}`);
    await admin.unsafe(
      `GRANT SELECT ON ${DEFAULT_ARCHIVE_SCHEMA}.dust_events, ${DEFAULT_ARCHIVE_SCHEMA}.blocks TO ${READER}`,
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

  describe("the start-up DUST-parameter check (D2.6, question Q-15)", () => {
    it("reports `skipped` under the role spec §5.3 prescribes, because the checkpoint tables are not granted", async () => {
      const probe = await reader.selectLatestCheckpoint(NET);
      expect(probe.status).toBe("unavailable");
      // The CODE, not the driver's sentence: `42501` is insufficient_privilege.
      expect(probe.status === "unavailable" ? probe.reason : "").toBe("42501");

      const lines: string[] = [];
      const module = createDustModule(
        { DUST_DATABASE_URL: readerUri },
        { net: NET, ledger, db: reader, logger: (line) => lines.push(line) },
      )!;
      await module.start();
      await module.whenParametersChecked();
      try {
        expect(module.status().parametersCheck).toBe("skipped");
        expect(lines.join("\n")).toContain("Q-15");
      } finally {
        // `stop()` would close the shared reader connection the rest of this suite uses, so the
        // mirror is stopped without it.
        await module.stop().catch(() => undefined);
      }
    }, 120_000);

    it("compares the parameters for real when the operator grants the two optional tables", async () => {
      await admin.unsafe(
        `GRANT SELECT ON ${DEFAULT_ARCHIVE_SCHEMA}.replay_checkpoints, ${DEFAULT_ARCHIVE_SCHEMA}.chain_blobs TO ${READER}`,
      );
      // A real checkpoint, written through A's own store, carrying a real serialized LedgerState.
      const blank = ledger.LedgerState.blank("local-test");
      const stateBytes: Uint8Array = blank.serialize();
      blank.free();
      const store = new PgChainArchiveStore(admin, DEFAULT_ARCHIVE_SCHEMA);
      const [row] = await admin<{ height: string; block_hash: Uint8Array }[]>`
        SELECT height::text, block_hash FROM ${admin(DEFAULT_ARCHIVE_SCHEMA)}.blocks
        WHERE net = ${NET} ORDER BY height DESC LIMIT 1
      `;
      await store.putReplayCheckpoint({
        net: NET,
        blockHeight: Number(row!.height),
        blockHash: Buffer.from(row!.block_hash).toString("hex"),
        stateBytes,
        ledgerVersion: "ledger-v8@8.1.0-syshash.6",
        // Non-zero: 004 checks `block_timestamp_ms > 0`, because a checkpoint dated 1970 is the
        // shape of a resume that folded its first block against a parent with no time (T1).
        blockTimestampMs: 1_757_900_000_000,
        ledgerNetworkId: "local-test",
      });

      const granted = openDustDb(readerUri);
      try {
        const probe = await granted.selectLatestCheckpoint(NET);
        expect(probe.status).toBe("ok");

        const lines: string[] = [];
        const module = createDustModule(
          { DUST_DATABASE_URL: readerUri },
          { net: NET, ledger, db: granted, logger: (line) => lines.push(line) },
        )!;
        await module.start();
        await module.whenParametersChecked();
        try {
          // A blank `LedgerState` carries the ledger's initial parameters, which is exactly what
          // the mirror constructs itself — so this is the agreement case, and the one an operator
          // will normally see. A real disagreement would be reported as `mismatch`.
          expect(module.status().parametersCheck).toBe("ok");
          expect(lines.join("\n")).toContain("parameter check ok");
        } finally {
          await module.stop().catch(() => undefined);
        }
      } finally {
        await granted.close().catch(() => undefined);
      }
    }, 180_000);
  });
});
