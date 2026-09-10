import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../../src/postgres/migrations/chain_archive/index.js";
import { shieldedMonitorMigrations } from "../../src/postgres/migrations/shielded_monitor/index.js";
import { bootstrapShieldedMonitorSchema } from "../../shielded-monitor/bootstrap.js";

/**
 * The `shielded_monitor` lineage against real PostgreSQL 17 — every constraint asserted by
 * making it fire, not by reading the DDL back.
 *
 * Deliberately one container and a small number of long tests rather than many short ones:
 * these facts are about one migrated schema written to over time, which is also how it will be
 * used, and re-paying migration cost per assertion would buy nothing.
 */
describe("shieldedMonitorMigrations (project B, organizer spec FR-025)", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
  }, 60_000);

  async function freshSchema(name: string): Promise<UmbraDBSql> {
    const sql = createClient({ connectionString: container.getConnectionUri(), schema: name, maxConnections: 4 });
    await bootstrapShieldedMonitorSchema(sql, name);
    return sql;
  }

  it("applies cleanly, is idempotent, and creates exactly the four tables", async () => {
    const schema = "shielded_monitor_apply";
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    try {
      await bootstrapShieldedMonitorSchema(sql, schema);
      const first = await sql<{ name: string }[]>`
        SELECT name FROM ${sql(schema)}._migrations ORDER BY name
      `;
      expect(first.map((r) => r.name)).toStrictEqual(["000_schema", "001_core"]);

      // Idempotent: the second bootstrap applies nothing.
      await bootstrapShieldedMonitorSchema(sql, schema);
      const second = await sql<{ name: string }[]>`
        SELECT name FROM ${sql(schema)}._migrations ORDER BY name
      `;
      expect(second).toStrictEqual(first);

      const tables = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
         WHERE table_schema = ${schema} ORDER BY table_name
      `;
      expect(tables.map((r) => r.table_name)).toStrictEqual([
        "_migrations", "associations", "audit_events", "lifecycle_events", "monitors",
      ]);

      // The lineage is selectable exactly like the Tier-1.5 one; `shieldedMonitorMigrations`
      // is the same array the bootstrap uses, and running it directly is equivalent.
      expect(shieldedMonitorMigrations.map((m) => m.name)).toStrictEqual(["000_schema", "001_core"]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);

  it("installs alongside the chain-archive lineage without touching a single archive object", async () => {
    const archiveSchema = "coexist_chain_archive";
    const monitorSchema = "coexist_shielded_monitor";
    const sql = createClient({ connectionString: container.getConnectionUri(), schema: archiveSchema });
    try {
      await runMigrations(sql, { schema: archiveSchema, migrations: chainArchiveMigrations });

      const snapshot = async (): Promise<string> => {
        const rows = await sql<{ signature: string }[]>`
          SELECT table_name || ':' || column_name || ':' || data_type AS signature
            FROM information_schema.columns
           WHERE table_schema = ${archiveSchema}
           ORDER BY table_name, column_name
        `;
        return rows.map((r) => r.signature).join("\n");
      };

      const before = await snapshot();
      expect(before.length).toBeGreaterThan(0); // the snapshot is not vacuously empty

      await bootstrapShieldedMonitorSchema(sql, monitorSchema);

      expect(await snapshot()).toBe(before);

      // No table name is shared between the two schemas' *writable* surfaces. `_migrations` is
      // the one shared NAME, and it is two physically distinct, schema-qualified tables — the
      // point owner Rule B makes about no table being written by both.
      const shared = await sql<{ table_name: string }[]>`
        SELECT a.table_name FROM information_schema.tables a
          JOIN information_schema.tables b USING (table_name)
         WHERE a.table_schema = ${archiveSchema} AND b.table_schema = ${monitorSchema}
         ORDER BY a.table_name
      `;
      expect(shared.map((r) => r.table_name)).toStrictEqual(["_migrations"]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 180_000);

  describe("every CHECK constraint actually fires", () => {
    let sql: UmbraDBSql;
    const schema = "shielded_monitor_checks";
    const fingerprint = Buffer.alloc(32, 1);

    beforeAll(async () => {
      sql = await freshSchema(schema);
    }, 120_000);

    afterAll(async () => {
      await sql?.end({ timeout: 5 });
    });

    /** Inserts a valid monitor row, returning its id. Every negative case below starts from a
     *  row that IS accepted, so a rejection proves the specific constraint rather than a typo. */
    async function insertMonitor(overrides: Record<string, unknown> = {}): Promise<string> {
      const id = randomUUID();
      const row = {
        id,
        net: "undeployed",
        fingerprint: Buffer.concat([fingerprint.subarray(0, 31), Buffer.of(Math.floor(Math.random() * 256))]),
        key_serialized: Buffer.alloc(32, 9),
        state: "backfilling",
        epoch: 0n,
        requested_start_height: 0n,
        matching_rule_version: "v1",
        ledger_build: "ledger-v8@8.1.0-syshash.4",
        ...overrides,
      };
      await sql`INSERT INTO ${sql(schema)}.monitors ${sql(row as never)}`;
      return id;
    }

    it("accepts a well-formed monitor (the positive control for every case below)", async () => {
      await expect(insertMonitor()).resolves.toBeTypeOf("string");
    });

    it("rejects an unknown state", async () => {
      await expect(insertMonitor({ state: "sleeping" })).rejects.toThrow(/monitors_state_check|violates check/i);
    });

    it("rejects a negative requested start height", async () => {
      await expect(insertMonitor({ requested_start_height: -1n })).rejects.toThrow(/violates check/i);
    });

    it("rejects a network id outside the allowed charset", async () => {
      await expect(insertMonitor({ net: "bad net" })).rejects.toThrow(/violates check/i);
    });

    it("rejects a fingerprint that is not 32 bytes", async () => {
      await expect(insertMonitor({ fingerprint: Buffer.alloc(16, 3) })).rejects.toThrow(/violates check/i);
    });

    it("rejects a through-height below the from-height", async () => {
      await expect(
        insertMonitor({ scanned_from_height: 10n, scanned_through_height: 5n }),
      ).rejects.toThrow(/monitors_coverage_shape|violates check/i);
    });

    it("rejects a through-height with no from-height", async () => {
      await expect(insertMonitor({ scanned_through_height: 5n })).rejects.toThrow(
        /monitors_coverage_shape|violates check/i,
      );
    });

    it("rejects a live monitor with no key (only a deleted one may be shredded)", async () => {
      await expect(insertMonitor({ key_serialized: null })).rejects.toThrow(
        /monitors_deleted_is_shredded|violates check/i,
      );
    });

    it("rejects a deleted monitor that still holds its key", async () => {
      await expect(insertMonitor({ state: "deleted" })).rejects.toThrow(
        /monitors_deleted_is_shredded|violates check/i,
      );
    });

    it("accepts a deleted monitor with neither key nor fingerprint", async () => {
      await expect(
        insertMonitor({ state: "deleted", key_serialized: null, fingerprint: null }),
      ).resolves.toBeTypeOf("string");
    });

    it("enforces one monitor per (net, fingerprint) but allows many deleted tombstones", async () => {
      const shared = Buffer.alloc(32, 42);
      await insertMonitor({ fingerprint: shared });
      await expect(insertMonitor({ fingerprint: shared })).rejects.toThrow(/duplicate key|unique/i);
      // Tombstones carry a NULL fingerprint and therefore never collide.
      await insertMonitor({ state: "deleted", key_serialized: null, fingerprint: null });
      await expect(
        insertMonitor({ state: "deleted", key_serialized: null, fingerprint: null }),
      ).resolves.toBeTypeOf("string");
    });

    describe("associations", () => {
      let monitorId: string;

      beforeAll(async () => {
        monitorId = await insertMonitor();
      });

      async function insertAssociation(overrides: Record<string, unknown> = {}): Promise<void> {
        const row = {
          monitor_id: monitorId,
          seq: BigInt(Math.floor(Math.random() * 1_000_000) + 1),
          net: "undeployed",
          block_height: 7n,
          block_hash: Buffer.alloc(32, 2),
          position: 0,
          tx_hash: Buffer.alloc(32, 3),
          protocol_version: 1n,
          matching_rule_version: "v1",
          ledger_build: "ledger-v8@8.1.0-syshash.4",
          ...overrides,
        };
        await sql`
          INSERT INTO ${sql(schema)}.associations ${sql(row as never)}
        `;
      }

      it("accepts a well-formed association with a segment list", async () => {
        await sql`
          INSERT INTO ${sql(schema)}.associations
            (monitor_id, seq, net, block_height, block_hash, position, tx_hash,
             protocol_version, matched_segments, matching_rule_version, ledger_build)
          VALUES (${monitorId}, ${1n}, 'undeployed', ${1n}, ${Buffer.alloc(32, 2)}, 0,
                  ${Buffer.alloc(32, 3)}, ${1n}, '{0,2}'::smallint[], 'v1', 'ledger-v8@8.1.0-syshash.4')
        `;
        const rows = await sql<{ matched_segments: number[]; applied_outcome: string }[]>`
          SELECT matched_segments, applied_outcome FROM ${sql(schema)}.associations
           WHERE monitor_id = ${monitorId} AND seq = 1
        `;
        expect(rows[0]!.matched_segments).toStrictEqual([0, 2]);
        expect(rows[0]!.applied_outcome).toBe("unknown");
      });

      it("rejects an applied outcome other than 'unknown' — the alpha never claims one", async () => {
        await expect(
          insertAssociation({ matched_segments: sql`'{0}'::smallint[]`, applied_outcome: "success" }),
        ).rejects.toThrow(/violates check/i);
      });

      it("rejects an empty segment list", async () => {
        await expect(
          insertAssociation({ matched_segments: sql`'{}'::smallint[]` }),
        ).rejects.toThrow(/violates check/i);
      });

      it("rejects a NULL inside the segment list", async () => {
        await expect(
          insertAssociation({ matched_segments: sql`'{0,NULL}'::smallint[]` }),
        ).rejects.toThrow(/violates check/i);
      });

      it("rejects a negative segment id", async () => {
        await expect(
          insertAssociation({ matched_segments: sql`'{-1}'::smallint[]` }),
        ).rejects.toThrow(/violates check/i);
      });

      it("rejects a duplicate (monitor, height, block hash, position) observation", async () => {
        await expect(
          insertAssociation({ matched_segments: sql`'{0}'::smallint[]`, block_height: 1n, position: 0 }),
        ).rejects.toThrow(/associations_observation_key|duplicate key|unique/i);
      });

      it("allows the same transaction hash at two positions (position-keyed identity)", async () => {
        await insertAssociation({
          matched_segments: sql`'{1}'::smallint[]`, block_height: 99n, position: 0, tx_hash: Buffer.alloc(32, 8),
        });
        await expect(
          insertAssociation({
            matched_segments: sql`'{1}'::smallint[]`, block_height: 99n, position: 1, tx_hash: Buffer.alloc(32, 8),
          }),
        ).resolves.toBeUndefined();
      });

      it("rejects an association for a monitor that does not exist", async () => {
        await expect(
          insertAssociation({ monitor_id: randomUUID(), matched_segments: sql`'{0}'::smallint[]` }),
        ).rejects.toThrow(/foreign key|violates/i);
      });
    });
  });
});
