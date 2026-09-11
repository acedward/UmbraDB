import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { MonitorFencedError, MonitorRevokedError } from "../../shielded-monitor/errors.js";
import {
  applyRevocationList,
  exportRevocationList,
  type RevocationListFile,
} from "../../shielded-monitor/revocation-list.js";
import { PgShieldedMonitorStore } from "../../shielded-monitor/store.js";
import { bootstrapShieldedMonitorSchema } from "../../shielded-monitor/bootstrap.js";
import { association, registerFixture } from "./helpers.js";

/**
 * The documented backup/restore procedure, **executed** (organizer spec FR-024, US5, and the
 * "restored to an older snapshot" edge case). The operator-facing text is
 * `docs/shielded-monitor-restore.md`; this is the drill that keeps it honest.
 *
 * A real `pg_dump` and a real `psql` restore inside the container, not a simulated one — the
 * whole point of the procedure is that the snapshot genuinely does not contain the revoke, and
 * only a real round trip proves that. The revocation list lives in this test process, which is
 * exactly the "outside the snapshot's rollback domain" the requirement asks for.
 *
 * Non-vacuousness is asserted in the middle of the drill: immediately after the restore and
 * BEFORE the list is applied, the revoked monitor is readable again. If that step ever stops
 * failing-open, the drill is no longer testing anything and this test says so.
 */

const SCHEMA = "shielded_monitor_restore";
const DUMP_PATH = "/tmp/shielded-monitor-restore-drill.sql";

describe("restore drill: a revoke that post-dates the snapshot survives it", () => {
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

  it("[[shielded-monitor.restore.revocation-survives-snapshot-restore]] snapshot -> revoke -> restore -> apply list -> monitor still refused", async () => {
    // ── 1. State worth restoring ──────────────────────────────────────────────────────────
    const doomed = await registerFixture(store, 9001);
    const survivor = await registerFixture(store, 9002);
    await store.advance(doomed.id, doomed.epoch, 5n, [association(5n, 0)]);
    await store.advance(survivor.id, survivor.epoch, 7n, [association(7n, 0), association(7n, 1)]);

    // ── 2. The backup, taken BEFORE the revoke ────────────────────────────────────────────
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

    // ── 3. The revoke, which the snapshot does not contain ────────────────────────────────
    const revoked = await store.revoke(doomed.id, "operator");
    expect(revoked.state).toBe("revoked");
    await expect(store.get(doomed.id)).rejects.toThrow(MonitorRevokedError);

    // ── 4. The revocation list, exported and kept OUTSIDE the database ────────────────────
    const list = await exportRevocationList(store, SCHEMA);
    expect(list.version).toBe(1);
    expect(list.revocations.map((r) => r.monitorId)).toStrictEqual([doomed.id]);
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

    // ── 6. Non-vacuousness: the restore really did lose the revoke ────────────────────────
    const resurrected = await store.get(doomed.id);
    expect(resurrected.state).toBe("backfilling");
    expect(resurrected.epoch).toBe(0n);
    expect(resurrected.coverage.scannedThrough).toBe(5n);

    // The survivor came back intact, coverage and associations included.
    const survivorAfter = await store.get(survivor.id);
    expect(survivorAfter.coverage.scannedThrough).toBe(7n);
    expect((await store.readAssociations(survivor.id, 0n, 100)).map((r) => r.seq)).toStrictEqual([1n, 2n]);

    // ── 7. Re-applying the list restores the refusal ──────────────────────────────────────
    const report = await applyRevocationList(store, list, "restore");
    expect(report).toMatchObject({ examined: 1, reapplied: [doomed.id], alreadyRefused: [], absent: [] });

    await expect(store.get(doomed.id)).rejects.toThrow(MonitorRevokedError);
    await expect(store.readAssociations(doomed.id, 0n, 10)).rejects.toThrow(MonitorRevokedError);
    const afterRevoke = (await store.getIncludingRevoked(doomed.id))!;
    await expect(store.advance(doomed.id, afterRevoke.epoch, 6n, [])).rejects.toThrow(MonitorFencedError);
    expect((await store.listActive()).map((m) => m.id)).not.toContain(doomed.id);

    // The lifecycle log says WHY the monitor is revoked after a restore.
    const events = await store.listLifecycleEvents(doomed.id);
    expect(events.at(-1)).toMatchObject({ event: "revoke", actor: "restore" });

    // ── 8. Scanning resumes from the restored coverage, without duplicates ────────────────
    const resumeResult = await store.advance(survivorAfter.id, survivorAfter.epoch, 8n, [association(8n, 0)]);
    expect(resumeResult.applied).toBe(true);
    const rows = await store.readAssociations(survivor.id, 0n, 100);
    expect(rows.map((r) => [r.blockHeight, r.position])).toStrictEqual([[7n, 0], [7n, 1], [8n, 0]]);
    expect(rows.map((r) => r.seq)).toStrictEqual([1n, 2n, 3n]);

    // ── 9. Idempotent: applying the same list again changes nothing ───────────────────────
    const epochBefore = (await store.getIncludingRevoked(doomed.id))!.epoch;
    const eventsBefore = (await store.listLifecycleEvents(doomed.id)).length;
    const second = await applyRevocationList(store, list, "restore");
    expect(second).toMatchObject({ examined: 1, reapplied: [], alreadyRefused: [doomed.id], absent: [] });
    expect((await store.getIncludingRevoked(doomed.id))!.epoch).toBe(epochBefore);
    expect((await store.listLifecycleEvents(doomed.id)).length).toBe(eventsBefore);
  }, 300_000);

  it("reports, rather than invents, a monitor the restored database does not know", async () => {
    const orphan: RevocationListFile = {
      version: 1,
      exportedAt: new Date().toISOString(),
      schema: SCHEMA,
      revocations: [
        {
          monitorId: "00000000-0000-4000-8000-000000000000",
          net: "undeployed",
          state: "revoked",
          epoch: "3",
          at: new Date().toISOString(),
        },
      ],
    };
    const report = await applyRevocationList(store, orphan, "restore");
    expect(report).toMatchObject({
      examined: 1, reapplied: [], alreadyRefused: [], absent: ["00000000-0000-4000-8000-000000000000"],
    });
  });

  it("refuses a revocation list of an unknown version rather than guessing", async () => {
    await expect(
      applyRevocationList(store, { version: 2, exportedAt: "", schema: SCHEMA, revocations: [] } as unknown as RevocationListFile),
    ).rejects.toThrow(/unsupported revocation list version/);
  });

  /**
   * A monitor exported as `deleted` is re-applied as a REVOKE, not a delete. The restored
   * database may hold associations the original delete destroyed, and destroying them again
   * unattended during a boot is an irreversible act; revoking stops all processing and access —
   * the safety property the restore has to preserve — and leaves the delete to the operator.
   */
  it("re-applies a `deleted` export as a revoke, keeping the irreversible step in human hands", async () => {
    const target = await registerFixture(store, 9003);
    await store.advance(target.id, target.epoch, 2n, [association(2n, 0)]);
    const list: RevocationListFile = {
      version: 1,
      exportedAt: new Date().toISOString(),
      schema: SCHEMA,
      revocations: [
        { monitorId: target.id, net: "undeployed", state: "deleted", epoch: "9", at: new Date().toISOString() },
      ],
    };
    const report = await applyRevocationList(store, list, "restore");
    expect(report.reapplied).toStrictEqual([target.id]);

    const after = (await store.getIncludingRevoked(target.id))!;
    expect(after.state).toBe("revoked");
    // The associations are still there — the operator decides whether to destroy them.
    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM ${sql(SCHEMA)}.associations WHERE monitor_id = ${target.id}
    `;
    expect(rows[0]!.count).toBe("1");

    // The audit trail records what the list said, so an operator can act on it.
    const audit = await sql<{ action: string; detail: { exportedState?: string } }[]>`
      SELECT action, detail FROM ${sql(SCHEMA)}.audit_events WHERE monitor_id = ${target.id}
    `;
    expect(audit[0]).toMatchObject({ action: "revocation-list-reapplied" });
    expect(audit[0]!.detail.exportedState).toBe("deleted");
  }, 120_000);
});
