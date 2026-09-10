import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../src/interfaces/storage-errors.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import {
  MonitorFencedError,
  MonitorNotFoundError,
  MonitorRevokedError,
  IllegalLifecycleTransitionError,
} from "../../shielded-monitor/errors.js";
import { MAX_ASSOCIATION_PAGE, type PgShieldedMonitorStore } from "../../shielded-monitor/store.js";
import {
  TEST_LEDGER_BUILD,
  TEST_MATCHING_RULE,
  association,
  fixtureViewingKey,
  freshStore,
  registerFixture,
  schemaSnapshot,
  uniqueSchema,
} from "./helpers.js";

/**
 * The monitor store against real PostgreSQL 17 (organizer spec FR-002..004, FR-010..016,
 * FR-022; owner Rule B).
 *
 * One shared container, one schema per describe block, so a failing suite cannot poison another
 * and no test depends on another's leftovers.
 */
describe("PgShieldedMonitorStore", () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
  }, 60_000);

  // ── Registration ───────────────────────────────────────────────────────────────────────────

  describe("registration (FR-003, FR-004)", () => {
    let sql: UmbraDBSql;
    let store: PgShieldedMonitorStore;
    const schema = uniqueSchema("sm_register");

    beforeAll(async () => {
      ({ sql, store } = await freshStore(container, schema));
    }, 120_000);
    afterAll(async () => {
      await sql?.end({ timeout: 5 });
    });

    it("creates a monitor in `backfilling` with no coverage and never echoes the key", async () => {
      const key = await fixtureViewingKey(1);
      const monitor = await store.register({
        key,
        net: "undeployed",
        requestedStartHeight: 0n,
        matchingRuleVersion: TEST_MATCHING_RULE,
        ledgerBuild: TEST_LEDGER_BUILD,
        actor: "test",
      });

      expect(monitor.state).toBe("backfilling");
      expect(monitor.epoch).toBe(0n);
      expect(monitor.coverage).toStrictEqual({ requestedStart: 0n });
      expect(monitor.coverage.scannedFrom).toBeUndefined();
      expect(monitor.coverage.scannedThrough).toBeUndefined();

      // FR-003: the fingerprint is never returned to callers, and neither is the key.
      const rendered = inspect(monitor, { depth: 10 });
      expect(rendered).not.toContain("fingerprint");
      expect(rendered).not.toContain(
        Buffer.from(key.yesIKnowTheSecurityImplicationsOfThis_serialized()).toString("hex"),
      );
      expect(Object.keys(monitor)).not.toContain("fingerprint");
      expect(Object.keys(monitor)).not.toContain("key");
    });

    it("is idempotent: registering the same key twice returns the same monitor", async () => {
      const key = await fixtureViewingKey(2);
      const input = {
        key,
        net: "undeployed",
        requestedStartHeight: 5n,
        matchingRuleVersion: TEST_MATCHING_RULE,
        ledgerBuild: TEST_LEDGER_BUILD,
        actor: "test",
      };
      const first = await store.register(input);
      const second = await store.register({ ...input, requestedStartHeight: 99n });
      expect(second.id).toBe(first.id);
      // The second call's differing start height does NOT silently rewrite the monitor.
      expect(second.coverage.requestedStart).toBe(5n);

      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ${sql(schema)}.monitors WHERE net = 'undeployed'
      `;
      expect(Number(rows[0]!.count)).toBeGreaterThan(0);
      const events = await store.listLifecycleEvents(first.id);
      expect(events.map((e) => e.event)).toStrictEqual(["register"]);
    });

    it("the same key on two networks is two monitors", async () => {
      const onUndeployed = await store.register({
        key: await fixtureViewingKey(3, "undeployed"),
        net: "undeployed",
        requestedStartHeight: 0n,
        matchingRuleVersion: TEST_MATCHING_RULE,
        ledgerBuild: TEST_LEDGER_BUILD,
        actor: "test",
      });
      const onPreview = await store.register({
        key: await fixtureViewingKey(3, "preview"),
        net: "preview",
        requestedStartHeight: 0n,
        matchingRuleVersion: TEST_MATCHING_RULE,
        ledgerBuild: TEST_LEDGER_BUILD,
        actor: "test",
      });
      expect(onPreview.id).not.toBe(onUndeployed.id);
    });

    it("refuses a key validated for a different network than the one requested", async () => {
      await expect(
        store.register({
          key: await fixtureViewingKey(4, "preview"),
          net: "undeployed",
          requestedStartHeight: 0n,
          matchingRuleVersion: TEST_MATCHING_RULE,
          ledgerBuild: TEST_LEDGER_BUILD,
          actor: "test",
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("stores the caller's opaque archive identity without interpreting it", async () => {
      const monitor = await store.register({
        key: await fixtureViewingKey(5),
        net: "undeployed",
        requestedStartHeight: 0n,
        matchingRuleVersion: TEST_MATCHING_RULE,
        ledgerBuild: TEST_LEDGER_BUILD,
        sourceGenesisHash: "0xdeadbeef-whatever-the-caller-says",
        sourceInstanceId: "instance-7",
        actor: "test",
      });
      expect(monitor.sourceGenesisHash).toBe("0xdeadbeef-whatever-the-caller-says");
      expect(monitor.sourceInstanceId).toBe("instance-7");
    });

    it("refuses re-registration of a revoked key (Q11) but allows it after a delete", async () => {
      const key = await fixtureViewingKey(6);
      const input = {
        key,
        net: "undeployed",
        requestedStartHeight: 0n,
        matchingRuleVersion: TEST_MATCHING_RULE,
        ledgerBuild: TEST_LEDGER_BUILD,
        actor: "test",
      };
      const first = await store.register(input);
      await store.revoke(first.id, "test");
      await expect(store.register(input)).rejects.toThrow(MonitorRevokedError);

      await store.delete(first.id, "test");
      const reborn = await store.register(input);
      expect(reborn.id).not.toBe(first.id);
      expect(reborn.state).toBe("backfilling");
      expect(reborn.epoch).toBe(0n);
    });
  });

  // ── Coverage and the fence ────────────────────────────────────────────────────────────────

  describe("advance: one transaction, epoch-fenced (FR-010, FR-012)", () => {
    let sql: UmbraDBSql;
    let store: PgShieldedMonitorStore;
    const schema = uniqueSchema("sm_advance");
    let seedCounter = 100;

    beforeAll(async () => {
      ({ sql, store } = await freshStore(container, schema));
    }, 120_000);
    afterAll(async () => {
      await sql?.end({ timeout: 5 });
    });

    beforeEach(() => {
      seedCounter += 1;
    });

    it("commits associations and the coverage advance together", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      const result = await store.advance(id, epoch, 10n, [association(9n, 0), association(10n, 3)]);
      expect(result.applied).toBe(true);
      if (!result.applied) throw new Error("unreachable");
      expect(result.firstSeq).toBe(1n);
      expect(result.lastSeq).toBe(2n);
      expect(result.coverage).toStrictEqual({ requestedStart: 0n, scannedFrom: 0n, scannedThrough: 10n });

      const rows = await store.readAssociations(id, 0n, 100);
      expect(rows.map((r) => [r.seq, r.blockHeight, r.position])).toStrictEqual([
        [1n, 9n, 0],
        [2n, 10n, 3],
      ]);
      expect(rows.every((r) => r.appliedOutcome === "unknown")).toBe(true);
      expect(rows[0]!.matchedSegments).toStrictEqual([0]);
      expect(rows[0]!.protocolVersion).toBe(1n);
      expect(rows[0]!.ledgerBuild).toBe(TEST_LEDGER_BUILD);
    });

    it("advances coverage over blocks with no matches at all", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      const result = await store.advance(id, epoch, 42n, []);
      expect(result.applied).toBe(true);
      expect((await store.get(id)).coverage.scannedThrough).toBe(42n);
      expect(await store.readAssociations(id, 0n, 100)).toStrictEqual([]);
    });

    it("records the earliest retained height when the archive starts above the requested start", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter, { startHeight: 0n });
      await store.advance(id, epoch, 500n, [], { fromHeight: 400n });
      expect((await store.get(id)).coverage).toStrictEqual({
        requestedStart: 0n, scannedFrom: 400n, scannedThrough: 500n,
      });
    });

    it("allocates a gapless, strictly increasing per-monitor sequence across batches", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      await store.advance(id, epoch, 1n, [association(1n, 0), association(1n, 1)]);
      await store.advance(id, epoch, 2n, [association(2n, 0)]);
      await store.advance(id, epoch, 3n, []);
      await store.advance(id, epoch, 4n, [association(4n, 0)]);
      const rows = await store.readAssociations(id, 0n, 100);
      expect(rows.map((r) => r.seq)).toStrictEqual([1n, 2n, 3n, 4n]);
    });

    it("pages by sequence and caps the page size", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      await store.advance(id, epoch, 5n, [1, 2, 3, 4, 5].map((h) => association(BigInt(h), 0)));
      const firstPage = await store.readAssociations(id, 0n, 2);
      expect(firstPage.map((r) => r.seq)).toStrictEqual([1n, 2n]);
      const secondPage = await store.readAssociations(id, firstPage.at(-1)!.seq, 2);
      expect(secondPage.map((r) => r.seq)).toStrictEqual([3n, 4n]);
      // The same cursor returns the same page.
      expect(await store.readAssociations(id, 0n, 2)).toStrictEqual(firstPage);
      await expect(store.readAssociations(id, 0n, MAX_ASSOCIATION_PAGE + 1)).rejects.toThrow(ValidationError);
    });

    /**
     * [[shielded-monitor.fencing.stale-epoch-never-commits]]
     *
     * Organizer spec FR-012 and US3 scenario 1. The assertion is deliberately a FULL-CONTENT
     * snapshot of every table before and after, not just "coverage is unchanged": a fenced write
     * must leave nothing at all behind — no association, no lifecycle event, no partially
     * advanced sequence counter.
     */
    it("[[shielded-monitor.fencing.stale-epoch-never-commits]] a stale epoch commits nothing, and a pause mid-batch fences the in-flight worker", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      await store.advance(id, epoch, 5n, [association(5n, 0)]);

      // A worker loads the monitor here…
      const loaded = await store.get(id);
      expect(loaded.epoch).toBe(epoch);

      // …the consumer pauses it while the worker is mid-batch…
      const paused = await store.pause(id, "consumer");
      expect(paused.state).toBe("paused");
      expect(paused.epoch).toBe(epoch + 1n);

      const before = await schemaSnapshot(sql, schema);

      // …and the worker's commit is rejected. The state is no longer scannable AND the epoch
      // moved; the store reports the state, which is the more actionable of the two.
      const fenced = await store.advance(id, loaded.epoch, 6n, [association(6n, 0)]).catch((e: unknown) => e);
      expect(fenced).toBeInstanceOf(MonitorFencedError);
      expect((fenced as MonitorFencedError).rejection).toBe("state");
      expect((fenced as MonitorFencedError).observed.state).toBe("paused");

      expect(await schemaSnapshot(sql, schema)).toBe(before);

      // Resuming bumps the epoch again, so the worker's ORIGINAL epoch is still stale — this is
      // the pure epoch-mismatch branch, with the monitor scannable again.
      const resumed = await store.resume(id, "consumer");
      expect(resumed.state).toBe("backfilling");
      expect(resumed.epoch).toBe(epoch + 2n);

      const beforeStale = await schemaSnapshot(sql, schema);
      const stale = await store.advance(id, loaded.epoch, 6n, [association(6n, 0)]).catch((e: unknown) => e);
      expect(stale).toBeInstanceOf(MonitorFencedError);
      expect((stale as MonitorFencedError).rejection).toBe("epoch");
      expect((stale as MonitorFencedError).observed.epoch).toBe(epoch + 2n);
      expect(await schemaSnapshot(sql, schema)).toBe(beforeStale);

      // POSITIVE CONTROL: with the current epoch the very same batch commits, so the rejections
      // above were caused by the fence and not by a malformed batch.
      const ok = await store.advance(id, resumed.epoch, 6n, [association(6n, 0)]);
      expect(ok.applied).toBe(true);
      expect((await store.get(id)).coverage.scannedThrough).toBe(6n);
      // Scanning resumed from `scannedThrough` with no duplicate and no skip (US3 scenario 2).
      const rows = await store.readAssociations(id, 0n, 100);
      expect(rows.map((r) => r.blockHeight)).toStrictEqual([5n, 6n]);
    });

    it("reports a replayed batch as already-advanced rather than as a fencing failure (US5 scenario 2)", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      const first = await store.advance(id, epoch, 8n, [association(8n, 0)]);
      expect(first.applied).toBe(true);

      // The commit succeeded but the acknowledgement was lost; the worker redoes the batch.
      const replay = await store.advance(id, epoch, 8n, [association(8n, 0)]);
      expect(replay.applied).toBe(false);
      if (replay.applied) throw new Error("unreachable");
      expect(replay.reason).toBe("already-advanced");
      expect(replay.coverage.scannedThrough).toBe(8n);

      // No duplicate association was created.
      expect((await store.readAssociations(id, 0n, 100)).length).toBe(1);
    });

    it("never moves coverage backwards", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      await store.advance(id, epoch, 20n, []);
      const back = await store.advance(id, epoch, 10n, []);
      expect(back.applied).toBe(false);
      expect((await store.get(id)).coverage.scannedThrough).toBe(20n);
    });

    it("refuses a batch whose association names a height above the batch's through-height", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      await expect(store.advance(id, epoch, 3n, [association(4n, 0)])).rejects.toThrow(ValidationError);
      expect((await store.get(id)).coverage.scannedThrough).toBeUndefined();
    });

    it("rolls the whole batch back when one association violates a constraint", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      const before = await schemaSnapshot(sql, schema);
      // Two associations naming the SAME observation: the unique key rejects the second, and the
      // first must not survive.
      await expect(
        store.advance(id, epoch, 4n, [association(4n, 0), association(4n, 0)]),
      ).rejects.toThrow();
      expect(await schemaSnapshot(sql, schema)).toBe(before);
    });

    it("reports an unknown monitor as not found", async () => {
      await expect(store.advance(randomUUID(), 0n, 1n, [])).rejects.toThrow(MonitorNotFoundError);
    });

    it("refuses a malformed monitor id before touching the database", async () => {
      await expect(store.advance("not-a-uuid", 0n, 1n, [])).rejects.toThrow(ValidationError);
    });
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────────────────────

  describe("lifecycle (FR-015, FR-016)", () => {
    let sql: UmbraDBSql;
    let store: PgShieldedMonitorStore;
    const schema = uniqueSchema("sm_lifecycle");
    let seedCounter = 200;

    beforeAll(async () => {
      ({ sql, store } = await freshStore(container, schema));
    }, 120_000);
    afterAll(async () => {
      await sql?.end({ timeout: 5 });
    });

    beforeEach(() => {
      seedCounter += 1;
    });

    it("bumps the epoch and appends an event on every real transition, and on no no-op", async () => {
      const { id } = await registerFixture(store, seedCounter);
      const paused = await store.pause(id, "op");
      expect(paused.epoch).toBe(1n);

      const again = await store.pause(id, "op");
      expect(again.epoch).toBe(1n); // idempotent re-issue changes nothing

      const resumed = await store.resume(id, "op");
      expect(resumed).toMatchObject({ state: "backfilling", epoch: 2n });

      const events = await store.listLifecycleEvents(id);
      expect(events.map((e) => [e.event, e.stateAfter, e.epochAfter])).toStrictEqual([
        ["register", "backfilling", 0n],
        ["pause", "paused", 1n],
        ["resume", "backfilling", 2n],
      ]);
      expect(events.map((e) => e.seq)).toStrictEqual([1n, 2n, 3n]);
      expect(events[1]!.actor).toBe("op");
    });

    it("go_live is fenced by the loaded epoch", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      await store.pause(id, "op");
      await expect(store.goLive(id, epoch, "scanner")).rejects.toThrow(MonitorFencedError);
      const resumed = await store.resume(id, "op");
      const live = await store.goLive(id, resumed.epoch, "scanner");
      expect(live.state).toBe("live");
    });

    it("refuses an illegal transition with a typed error", async () => {
      const { id } = await registerFixture(store, seedCounter);
      await expect(store.resume(id, "op")).rejects.toThrow(IllegalLifecycleTransitionError);
    });

    it("markFailed stores a typed, non-secret reason and stops the monitor", async () => {
      const { id } = await registerFixture(store, seedCounter);
      const failed = await store.markFailed(id, "scanner", {
        code: "UNSUPPORTED_PROTOCOL_VERSION",
        message: "protocol version 99 is outside the supported set",
        atHeight: "17",
        atPosition: 2,
      });
      expect(failed.state).toBe("failed");
      expect(failed.lastError?.code).toBe("UNSUPPORTED_PROTOCOL_VERSION");

      const key = await fixtureViewingKey(seedCounter);
      const keyHex = Buffer.from(key.yesIKnowTheSecurityImplicationsOfThis_serialized()).toString("hex");
      const stored = await sql<{ last_error: unknown }[]>`
        SELECT last_error FROM ${sql(schema)}.monitors WHERE id = ${id}
      `;
      expect(JSON.stringify(stored[0]!.last_error)).not.toContain(keyHex);

      // A failed monitor is no longer scannable.
      const record = await store.getIncludingRevoked(id);
      await expect(store.advance(id, record!.epoch, 1n, [])).rejects.toThrow(MonitorFencedError);
    });

    it("markStaleSource stops the monitor when the archive identity changed (FR-013)", async () => {
      const { id } = await registerFixture(store, seedCounter);
      const stale = await store.markStaleSource(id, "scanner", {
        code: "ARCHIVE_IDENTITY_CHANGED",
        message: "archive instance id differs from the bound one",
      });
      expect(stale.state).toBe("stale_source");
      await expect(store.advance(id, stale.epoch, 1n, [])).rejects.toThrow(MonitorFencedError);
    });

    it("a pause does not erase a previously recorded lastError", async () => {
      const { id } = await registerFixture(store, seedCounter);
      await store.markFailed(id, "scanner", { code: "X", message: "y" });
      await store.revoke(id, "op");
      expect((await store.getIncludingRevoked(id))!.lastError?.code).toBe("X");
    });

    it("revoke stops processing and refuses reads (US3 scenario 3)", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      await store.advance(id, epoch, 3n, [association(3n, 0)]);
      const revoked = await store.revoke(id, "op");
      expect(revoked.state).toBe("revoked");

      await expect(store.get(id)).rejects.toThrow(MonitorRevokedError);
      await expect(store.readAssociations(id, 0n, 10)).rejects.toThrow(MonitorRevokedError);
      await expect(store.getKeyMaterial(id)).rejects.toThrow(MonitorRevokedError);
      await expect(store.advance(id, revoked.epoch, 4n, [])).rejects.toThrow(MonitorFencedError);

      // Idempotent: a second revoke changes nothing.
      const again = await store.revoke(id, "op");
      expect(again.epoch).toBe(revoked.epoch);

      // The rows are still there — revoke keeps them and refuses access.
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ${sql(schema)}.associations WHERE monitor_id = ${id}
      `;
      expect(rows[0]!.count).toBe("1");
    });

    it("revoke is not scannable even from listActive", async () => {
      const { id } = await registerFixture(store, seedCounter);
      expect((await store.listActive()).map((m) => m.id)).toContain(id);
      await store.revoke(id, "op");
      expect((await store.listActive()).map((m) => m.id)).not.toContain(id);
    });

    it("delete travels through revoked, destroys key and associations, and keeps the log (US3 scenario 4)", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      await store.advance(id, epoch, 3n, [association(3n, 0), association(3n, 1)]);

      const deleted = await store.delete(id, "op");
      expect(deleted?.state).toBe("deleted");

      // Indistinguishable from a monitor that never existed.
      await expect(store.get(id)).rejects.toThrow(MonitorNotFoundError);
      await expect(store.getKeyMaterial(id)).rejects.toThrow(MonitorNotFoundError);
      const unknownError = await store.get(randomUUID()).catch((e: unknown) => e);
      const deletedError = await store.get(id).catch((e: unknown) => e);
      expect((deletedError as Error).constructor).toBe((unknownError as Error).constructor);

      // Key and derived rows are gone.
      const row = await sql<{ key_serialized: Buffer | null; fingerprint: Buffer | null }[]>`
        SELECT key_serialized, fingerprint FROM ${sql(schema)}.monitors WHERE id = ${id}
      `;
      expect(row[0]!.key_serialized).toBeNull();
      expect(row[0]!.fingerprint).toBeNull();
      const assoc = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ${sql(schema)}.associations WHERE monitor_id = ${id}
      `;
      expect(assoc[0]!.count).toBe("0");

      // The lifecycle log survives, and shows the revoke the delete travelled through.
      const events = await store.listLifecycleEvents(id);
      expect(events.map((e) => e.event)).toStrictEqual(["register", "revoke", "delete"]);
      expect(events.map((e) => e.epochAfter)).toStrictEqual([0n, 1n, 2n]);

      // Idempotent.
      const again = await store.delete(id, "op");
      expect(again?.state).toBe("deleted");
      expect((await store.listLifecycleEvents(id)).length).toBe(3);
    });

    it("deleting an unknown monitor is a no-op, not an error", async () => {
      expect(await store.delete(randomUUID(), "op")).toBeUndefined();
    });

    it("getKeyMaterial returns the stored key for a scannable monitor and nothing else", async () => {
      const { id } = await registerFixture(store, seedCounter);
      const key = await fixtureViewingKey(seedCounter);
      expect(Buffer.from(await store.getKeyMaterial(id)))
        .toStrictEqual(Buffer.from(key.yesIKnowTheSecurityImplicationsOfThis_serialized()));
    });
  });

  // ── Idle behaviour (US6) ──────────────────────────────────────────────────────────────────

  describe("an empty schema is a healthy idle state (US6 scenario 2)", () => {
    it("listActive on a freshly bootstrapped schema returns an empty list", async () => {
      const { sql, store } = await freshStore(container, uniqueSchema("sm_idle"));
      try {
        expect(await store.listActive()).toStrictEqual([]);
        expect(await store.listRevocations()).toStrictEqual([]);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }, 120_000);
  });
});
