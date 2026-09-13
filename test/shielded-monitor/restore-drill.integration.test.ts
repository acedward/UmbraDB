import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { MonitorNotFoundError } from "../../shielded-monitor/errors.js";
import {
  applyDeletionList,
  exportDeletionList,
  type DeletionListFile,
} from "../../shielded-monitor/deletion-list.js";
import { PgShieldedMonitorStore } from "../../storage-api/monitor-store-pg.js";
import { bootstrapShieldedMonitorSchema } from "../../storage-api/bootstrap.js";
import { association, registerFixture } from "./helpers.js";

/**
 * The documented backup/restore procedure, **executed** (organizer spec FR-024, US5, and the
 * "restored to an older snapshot" edge case). The operator-facing text is
 * `docs/shielded-monitor-restore.md`; this is the drill that keeps it honest.
 *
 * A real `pg_dump` and a real `psql` restore inside the container, not a simulated one — the
 * whole point of the procedure is that the snapshot genuinely does not contain the delete, and
 * only a real round trip proves that. The deletion list lives in this test process, which is
 * exactly the "outside the snapshot's rollback domain" the requirement asks for.
 *
 * Non-vacuousness is asserted in the middle of the drill: immediately after the restore and
 * BEFORE the list is applied, the deleted monitor is readable again, matches and all. If that
 * step ever stops failing-open, the drill is no longer testing anything and this test says so.
 *
 * Since owner decision Q33 the mechanism protects a DELETE rather than a revoke — a key is given
 * or it is deleted, and there is nothing in between — but the property is the same one FR-024
 * always named: an operator's irreversible decision must not be undone by restoring a backup
 * taken before they made it.
 */

const SCHEMA = "shielded_monitor_restore";
const DUMP_PATH = "/tmp/shielded-monitor-restore-drill.sql";

describe("restore drill: a delete that post-dates the snapshot survives it", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let store: PgShieldedMonitorStore;

  function connect(): void {
    sql = createClient({ connectionString: container.getConnectionUri(), schema: SCHEMA, maxConnections: 4 });
    store = new PgShieldedMonitorStore(sql, SCHEMA);
  }

  /** Runs a command inside the container, failing loudly with its output. */
  async function inContainer(command: string): Promise<string> {
    const result = await container.exec([
      "sh",
      "-c",
      `PGPASSWORD='${container.getPassword()}' ${command}`,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`command failed (exit ${result.exitCode}): ${command}\n${result.output}`);
    }
    return result.output;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    connect();
    await bootstrapShieldedMonitorSchema(sql, SCHEMA);
  }, 240_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  it("[[shielded-monitor.restore.deletion-survives-snapshot-restore]] snapshot -> delete -> restore -> apply list -> monitor gone again", async () => {
    // ── 1. State worth restoring ──────────────────────────────────────────────────────────
    const doomed = await registerFixture(store, 9001);
    const survivor = await registerFixture(store, 9002);
    await store.advance(doomed.id, doomed.epoch, 5n, [association(5n, 0)]);
    await store.advance(survivor.id, survivor.epoch, 7n, [association(7n, 0), association(7n, 1)]);

    // ── 2. The backup, taken BEFORE the delete ────────────────────────────────────────────
    await inContainer(
      `pg_dump -U ${container.getUsername()} -d ${container.getDatabase()} -n ${SCHEMA} -f ${DUMP_PATH}`,
    );
    const dump = await inContainer(`cat ${DUMP_PATH}`);
    expect(dump).toContain(`CREATE TABLE ${SCHEMA}.monitors`);
    // The helper function the associations CHECK calls must be in the dump, and must come
    // BEFORE the table that references it, or the restore below would fail.
    expect(dump).toContain("shielded_monitor_valid_segments");
    expect(dump.indexOf("shielded_monitor_valid_segments"))
      .toBeLessThan(dump.indexOf(`CREATE TABLE ${SCHEMA}.associations`));

    // ── 3. The delete, which the snapshot does not contain ────────────────────────────────
    const deleted = await store.delete(doomed.id, "operator");
    expect(deleted?.state).toBe("deleted");
    await expect(store.get(doomed.id)).rejects.toThrow(MonitorNotFoundError);

    // ── 4. The deletion list, exported and kept OUTSIDE the database ──────────────────────
    const list = await exportDeletionList(store, SCHEMA);
    expect(list.version).toBe(2);
    expect(list.deletions.map((r) => r.monitorId)).toStrictEqual([doomed.id]);
    // The list is safe to store next to the backups: no key material, no fingerprint, no
    // association content.
    const serialized = JSON.stringify(list);
    expect(serialized).not.toMatch(/key|fingerprint|serialized/i);

    // ── 5. The restore ────────────────────────────────────────────────────────────────────
    // Drop the pool first: postgres.js caches prepared statements per connection, and a plan
    // pinned to a dropped relation's OID would fail on the far side of the restore for reasons
    // that have nothing to do with what this drill is testing.
    await sql.end({ timeout: 5 });
    const admin = createClient({ connectionString: container.getConnectionUri(), schema: "public" });
    await admin.unsafe(`DROP SCHEMA ${SCHEMA} CASCADE`);
    await admin.end({ timeout: 5 });

    await inContainer(
      `psql -v ON_ERROR_STOP=1 -U ${container.getUsername()} -d ${container.getDatabase()} -f ${DUMP_PATH}`,
    );
    connect();

    // ── 6. Non-vacuousness: the restore really did lose the delete ────────────────────────
    const resurrected = await store.get(doomed.id);
    expect(resurrected.state).toBe("backfilling");
    expect(resurrected.epoch).toBe(0n);
    expect(resurrected.coverage.scannedThrough).toBe(5n);
    expect(await store.readAssociations(doomed.id, 0n, 10), "and its matches came back too")
      .toHaveLength(1);

    // The survivor came back intact, coverage and associations included.
    const survivorAfter = await store.get(survivor.id);
    expect(survivorAfter.coverage.scannedThrough).toBe(7n);
    expect((await store.readAssociations(survivor.id, 0n, 100)).map((r) => r.seq)).toStrictEqual([1n, 2n]);

    // ── 7. Re-applying the list deletes it again ──────────────────────────────────────────
    const report = await applyDeletionList(store, list, "restore");
    expect(report).toMatchObject({ examined: 1, reapplied: [doomed.id], alreadyDeleted: [], absent: [] });

    await expect(store.get(doomed.id)).rejects.toThrow(MonitorNotFoundError);
    await expect(store.readAssociations(doomed.id, 0n, 10)).rejects.toThrow(MonitorNotFoundError);
    const afterDelete = (await store.getIncludingDeleted(doomed.id))!;
    await expect(store.advance(doomed.id, afterDelete.epoch, 6n, [])).rejects.toThrow(MonitorNotFoundError);
    expect((await store.listActive()).map((m) => m.id)).not.toContain(doomed.id);
    expect((await store.listAll()).map((m) => m.id)).not.toContain(doomed.id);
    // The matches the restore resurrected are destroyed again, which is the point: the consumer
    // asked for them to be gone, and a backup is not a reason to hand them back.
    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM ${sql(SCHEMA)}.associations WHERE monitor_id = ${doomed.id}
    `;
    expect(rows[0]!.count).toBe("0");

    // The lifecycle log says WHY the monitor is gone after a restore.
    const events = await store.listLifecycleEvents(doomed.id);
    expect(events.at(-1)).toMatchObject({ event: "delete", actor: "restore" });

    // ── 8. Scanning carries on from the restored coverage, without duplicates ─────────────
    const resumeResult = await store.advance(survivorAfter.id, survivorAfter.epoch, 8n, [association(8n, 0)]);
    expect(resumeResult.applied).toBe(true);
    const survivorRows = await store.readAssociations(survivor.id, 0n, 100);
    expect(survivorRows.map((r) => [r.blockHeight, r.position])).toStrictEqual([[7n, 0], [7n, 1], [8n, 0]]);
    expect(survivorRows.map((r) => r.seq)).toStrictEqual([1n, 2n, 3n]);

    // ── 9. Idempotent: applying the same list again changes nothing ───────────────────────
    const epochBefore = (await store.getIncludingDeleted(doomed.id))!.epoch;
    const eventsBefore = (await store.listLifecycleEvents(doomed.id)).length;
    const second = await applyDeletionList(store, list, "restore");
    expect(second).toMatchObject({ examined: 1, reapplied: [], alreadyDeleted: [doomed.id], absent: [] });
    expect((await store.getIncludingDeleted(doomed.id))!.epoch).toBe(epochBefore);
    expect((await store.listLifecycleEvents(doomed.id)).length).toBe(eventsBefore);
  }, 300_000);

  it("reports, rather than invents, a monitor the restored database does not know", async () => {
    const orphan: DeletionListFile = {
      version: 2,
      exportedAt: new Date().toISOString(),
      schema: SCHEMA,
      deletions: [
        {
          monitorId: "00000000-0000-4000-8000-000000000000",
          net: "undeployed",
          epoch: "3",
          at: new Date().toISOString(),
        },
      ],
    };
    const report = await applyDeletionList(store, orphan, "restore");
    expect(report).toMatchObject({
      examined: 1, reapplied: [], alreadyDeleted: [], absent: ["00000000-0000-4000-8000-000000000000"],
    });
  });

  it("refuses a deletion list of an unknown version rather than guessing", async () => {
    // Version 1 was the REVOCATION list this replaced (owner decision Q33). A file written by a
    // pre-Q33 build is refused rather than half-understood: its entries mean "refuse reads", and
    // this build has no such state to put a monitor into.
    await expect(
      applyDeletionList(store, { version: 1, exportedAt: "", schema: SCHEMA, deletions: [] } as unknown as DeletionListFile),
    ).rejects.toThrow(/unsupported deletion list version/);
  });

  it("re-applying a deletion destroys the matches the restore brought back, and says so in the audit log", async () => {
    // The irreversible half, stated on its own: the consumer's delete destroyed these rows once,
    // and a restore is not a reason to keep them. Before Q33 this step deliberately stopped at a
    // revoke and left the destruction to a human; with revoke gone there is nothing softer to do,
    // and the report plus the audit row are what make the act visible.
    const target = await registerFixture(store, 9003);
    await store.advance(target.id, target.epoch, 2n, [association(2n, 0)]);
    const list: DeletionListFile = {
      version: 2,
      exportedAt: new Date().toISOString(),
      schema: SCHEMA,
      deletions: [
        { monitorId: target.id, net: "undeployed", epoch: "9", at: new Date().toISOString() },
      ],
    };
    const report = await applyDeletionList(store, list, "restore");
    expect(report.reapplied).toStrictEqual([target.id]);

    const after = (await store.getIncludingDeleted(target.id))!;
    expect(after.state).toBe("deleted");
    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM ${sql(SCHEMA)}.associations WHERE monitor_id = ${target.id}
    `;
    expect(rows[0]!.count).toBe("0");

    // The audit trail records what the list said, so an operator can reconcile it afterwards.
    const audit = await sql<{ action: string; detail: { exportedEpoch?: string } }[]>`
      SELECT action, detail FROM ${sql(SCHEMA)}.audit_events WHERE monitor_id = ${target.id}
    `;
    expect(audit[0]).toMatchObject({ action: "deletion-list-reapplied" });
    expect(audit[0]!.detail.exportedEpoch).toBe("9");
  }, 120_000);
});
