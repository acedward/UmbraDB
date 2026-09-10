import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../../src/postgres/migrations/chain_archive/index.js";
import { bootstrapShieldedMonitorSchema } from "../../shielded-monitor/bootstrap.js";
import { PgShieldedMonitorStore } from "../../shielded-monitor/store.js";
import { TEST_LEDGER_BUILD, TEST_MATCHING_RULE, association, fixtureViewingKey } from "./helpers.js";

/**
 * **Owner Rule B, proved at runtime** (organizer spec US5 scenario 4, FR-025): project B writes
 * only to its own schema and never to an archive table.
 *
 * The proof is a privilege boundary, not a log scrape. Both lineages are installed in one
 * database; the entire B flow then runs as a PostgreSQL role that holds `USAGE` and `SELECT` on
 * `chain_archive` and nothing else there. If any statement in `shielded-monitor/store.ts` ever
 * wrote to an archive table, the flow would abort with `permission denied` — the test would fail
 * loudly rather than requiring someone to read a statement log correctly.
 *
 * Two things keep it from being vacuous:
 *   1. a **positive control** — the same role's direct `INSERT` into `chain_archive` IS rejected,
 *      so the boundary is real and not an artefact of the role happening to have no privileges
 *      it needed;
 *   2. the archive is **seeded with real rows first**, so "the archive is unchanged" compares
 *      non-empty content, not two empty tables.
 */

const ARCHIVE_SCHEMA = "chain_archive";
const MONITOR_SCHEMA = "shielded_monitor";
const B_ROLE = "umbradb_b_writer";
/** Generated per run rather than written as a literal: a committed string that reads as a
 *  credential is exactly what the repository's `gitleaks` gate exists to refuse, and there is no
 *  reason for this one to be a constant — the role lives and dies with the container. */
const B_PASSWORD = randomUUID();

describe("project B writes only its own schema (owner Rule B)", () => {
  let container: StartedPostgreSqlContainer;
  let admin: UmbraDBSql;
  let asB: UmbraDBSql;
  let store: PgShieldedMonitorStore;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    admin = createClient({ connectionString: container.getConnectionUri(), schema: ARCHIVE_SCHEMA });

    await runMigrations(admin, { schema: ARCHIVE_SCHEMA, migrations: chainArchiveMigrations });
    await bootstrapShieldedMonitorSchema(admin, MONITOR_SCHEMA);

    // Seed the archive with real content, so the "unchanged" assertions below compare something.
    const data = Buffer.from("a pretend block header", "utf8");
    const hash = createHash("sha256").update(data).digest();
    await admin`INSERT INTO ${admin(ARCHIVE_SCHEMA)}.chain_blobs (hash, data) VALUES (${hash}, ${data})`;
    await admin`
      INSERT INTO ${admin(ARCHIVE_SCHEMA)}.chain_blob_roles (blob_hash, role)
      VALUES (${hash}, 'block_header')
    `;

    // The B role: read-only on the archive, full rights on its own schema. This is NOT the
    // deferred least-privilege production role script (US4) — it is the test's instrument for
    // making Rule B falsifiable.
    await admin.unsafe(`DROP ROLE IF EXISTS ${B_ROLE}`);
    await admin.unsafe(`CREATE ROLE ${B_ROLE} LOGIN PASSWORD '${B_PASSWORD}'`);
    await admin.unsafe(`REVOKE ALL ON SCHEMA ${ARCHIVE_SCHEMA} FROM ${B_ROLE}`);
    await admin.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA ${ARCHIVE_SCHEMA} FROM ${B_ROLE}`);
    await admin.unsafe(`GRANT USAGE ON SCHEMA ${ARCHIVE_SCHEMA} TO ${B_ROLE}`);
    await admin.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA ${ARCHIVE_SCHEMA} TO ${B_ROLE}`);
    await admin.unsafe(`GRANT USAGE ON SCHEMA ${MONITOR_SCHEMA} TO ${B_ROLE}`);
    await admin.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA ${MONITOR_SCHEMA} TO ${B_ROLE}`);
    await admin.unsafe(`GRANT ALL ON ALL SEQUENCES IN SCHEMA ${MONITOR_SCHEMA} TO ${B_ROLE}`);
    await admin.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${MONITOR_SCHEMA} TO ${B_ROLE}`);

    const uri = new URL(container.getConnectionUri());
    uri.username = B_ROLE;
    uri.password = B_PASSWORD;
    asB = createClient({ connectionString: uri.toString(), schema: MONITOR_SCHEMA, maxConnections: 4 });
    store = new PgShieldedMonitorStore(asB, MONITOR_SCHEMA);
  }, 240_000);

  afterAll(async () => {
    await asB?.end({ timeout: 5 });
    await admin?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  /** A content snapshot of every archive table: row counts plus the full text of every row. */
  async function archiveSnapshot(): Promise<string> {
    const tables = await admin<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = ${ARCHIVE_SCHEMA} AND table_type = 'BASE TABLE'
       ORDER BY table_name
    `;
    const parts: string[] = [];
    for (const { table_name: table } of tables) {
      const rows = await admin<{ line: string }[]>`
        SELECT t::text AS line FROM ${admin(ARCHIVE_SCHEMA)}.${admin(table)} t ORDER BY t::text
      `;
      parts.push(`${table}(${rows.length})\n${rows.map((r) => r.line).join("\n")}`);
    }
    return parts.join("\n");
  }

  it("POSITIVE CONTROL: the B role cannot write to the archive at all", async () => {
    const data = Buffer.from("an injected blob", "utf8");
    const hash = createHash("sha256").update(data).digest();
    await expect(
      asB`INSERT INTO ${asB(ARCHIVE_SCHEMA)}.chain_blobs (hash, data) VALUES (${hash}, ${data})`,
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asB`UPDATE ${asB(ARCHIVE_SCHEMA)}.chain_blobs SET data = ${data}`,
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asB`DELETE FROM ${asB(ARCHIVE_SCHEMA)}.chain_blobs`,
    ).rejects.toThrow(/permission denied/i);
  });

  it("the B role CAN read the archive — so a failure below means a write, not a missing grant", async () => {
    const rows = await asB<{ count: string }[]>`
      SELECT count(*)::text AS count FROM ${asB(ARCHIVE_SCHEMA)}.chain_blobs
    `;
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it("[[shielded-monitor.isolation.b-writes-only-its-own-schema]] the whole B flow runs under read-only archive privileges and leaves the archive byte-identical", async () => {
    const before = await archiveSnapshot();
    expect(before).toContain("chain_blobs(1)"); // the snapshot has real content in it

    // register -> advance -> go live -> advance -> pause -> resume -> revoke -> delete
    const key = await fixtureViewingKey(7_001);
    const monitor = await store.register({
      key,
      net: "undeployed",
      requestedStartHeight: 0n,
      matchingRuleVersion: TEST_MATCHING_RULE,
      ledgerBuild: TEST_LEDGER_BUILD,
      sourceGenesisHash: "opaque-genesis",
      sourceInstanceId: "opaque-instance",
      actor: "rule-b-test",
    });

    const first = await store.advance(monitor.id, monitor.epoch, 3n, [association(3n, 0)]);
    expect(first.applied).toBe(true);

    const live = await store.goLive(monitor.id, monitor.epoch, "rule-b-test");
    expect(live.state).toBe("live");

    const second = await store.advance(live.id, live.epoch, 4n, [association(4n, 0), association(4n, 1)]);
    expect(second.applied).toBe(true);

    const paused = await store.pause(monitor.id, "rule-b-test");
    const resumed = await store.resume(monitor.id, "rule-b-test");
    expect(resumed.epoch).toBe(paused.epoch + 1n);

    expect((await store.readAssociations(monitor.id, 0n, 100)).length).toBe(3);
    await store.recordAudit("rule-b-test", "flow-complete", monitor.id, { associations: 3 });

    await store.revoke(monitor.id, "rule-b-test");
    const deleted = await store.delete(monitor.id, "rule-b-test");
    expect(deleted?.state).toBe("deleted");

    // Every one of those statements ran as a role that cannot write to the archive, and the
    // archive's content is identical.
    expect(await archiveSnapshot()).toBe(before);
  }, 120_000);

  it("no table is written by both: the two schemas share only the per-schema `_migrations` name", async () => {
    const shared = await admin<{ table_name: string }[]>`
      SELECT a.table_name FROM information_schema.tables a
        JOIN information_schema.tables b USING (table_name)
       WHERE a.table_schema = ${ARCHIVE_SCHEMA} AND b.table_schema = ${MONITOR_SCHEMA}
       ORDER BY a.table_name
    `;
    expect(shared.map((r) => r.table_name)).toStrictEqual(["_migrations"]);

    // …and those two are physically distinct relations with distinct OIDs.
    const oids = await admin<{ oid: number }[]>`
      SELECT c.oid::int AS oid
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = '_migrations' AND n.nspname IN (${ARCHIVE_SCHEMA}, ${MONITOR_SCHEMA})
    `;
    expect(new Set(oids.map((r) => r.oid)).size).toBe(2);
  });

  it("project B's source contains no reference to the archive schema at all", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const moduleDir = fileURLToPath(new URL("../../shielded-monitor", import.meta.url));
    const files = (readdirSync(moduleDir, { recursive: true }) as string[])
      .filter((p) => p.endsWith(".ts"))
      .map((p) => path.join(moduleDir, p));
    expect(files.length).toBeGreaterThan(0); // the walk is not vacuous

    const offenders = files.filter((file) => {
      const source = readFileSync(file, "utf8");
      // Strip comments: the design rationale legitimately NAMES the archive schema in prose.
      const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      return /chain_archive/.test(withoutComments);
    });
    expect(offenders).toStrictEqual([]);
  });
});
