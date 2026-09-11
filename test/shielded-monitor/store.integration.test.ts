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
import type { MatchDetails } from "../../shielded-monitor/match-details.js";
import { MAX_ASSOCIATION_DETAILS_BYTES, MAX_ASSOCIATION_PAGE } from "../../shielded-monitor/store.js";
import { PgShieldedMonitorStore } from "../../storage-api/monitor-store-pg.js";
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

    /**
     * Two registrations of the same key racing each other. The `SELECT … FOR UPDATE` in
     * `register` cannot lock a row that does not exist yet, so without the `ON CONFLICT …
     * DO NOTHING` + re-read path one of the two would fail on the unique index and idempotency
     * (FR-004) would hold only when nobody registers twice at the same moment.
     */
    it("is idempotent even when two registrations race", async () => {
      const key = await fixtureViewingKey(7);
      const input = {
        key,
        net: "undeployed",
        requestedStartHeight: 0n,
        matchingRuleVersion: TEST_MATCHING_RULE,
        ledgerBuild: TEST_LEDGER_BUILD,
        actor: "test",
      };
      const results = await Promise.all([
        store.register(input), store.register(input), store.register(input), store.register(input),
      ]);
      expect(new Set(results.map((m) => m.id)).size).toBe(1);

      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ${sql(schema)}.monitors WHERE id = ${results[0]!.id}
      `;
      expect(rows[0]!.count).toBe("1");
      // Exactly one `register` lifecycle event, not one per racing caller.
      expect((await store.listLifecycleEvents(results[0]!.id)).map((e) => e.event)).toStrictEqual(["register"]);
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

    /**
     * `seq` is the Phase-4 cursor, and organizer spec FR-019 requires matches in
     * `(blockHeight, position)` order. The store sorts the batch before allocating sequence
     * numbers so the two orders cannot diverge — if it trusted the caller's array order instead,
     * an unsorted batch would produce a cursor whose page boundaries skip or repeat a match.
     */
    it("assigns sequence numbers in (blockHeight, position) order whatever order the caller passes", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      await store.advance(id, epoch, 9n, [
        association(9n, 2),
        association(7n, 5),
        association(9n, 0),
        association(7n, 1),
        association(8n, 0),
      ]);
      const rows = await store.readAssociations(id, 0n, 100);
      expect(rows.map((r) => [r.seq, r.blockHeight, r.position])).toStrictEqual([
        [1n, 7n, 1],
        [2n, 7n, 5],
        [3n, 8n, 0],
        [4n, 9n, 0],
        [5n, 9n, 2],
      ]);
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

    it("markFailed and markStaleSource are fenceable by the worker's loaded epoch (FR-012)", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      await store.pause(id, "consumer"); // the epoch moves under the worker
      await expect(
        store.markFailed(id, "scanner", { code: "X", message: "y" }, epoch),
      ).rejects.toThrow(MonitorFencedError);
      await expect(
        store.markStaleSource(id, "scanner", { code: "X", message: "y" }, epoch),
      ).rejects.toThrow(MonitorFencedError);
      expect((await store.getIncludingRevoked(id))!.state).toBe("paused");

      // POSITIVE CONTROL: with the current epoch the same call is admitted.
      const current = (await store.getIncludingRevoked(id))!;
      expect((await store.markFailed(id, "scanner", { code: "X", message: "y" }, current.epoch)).state)
        .toBe("failed");
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

  // ── Match details and the backfill write path (00009-07) ─────────────────────────────────

  describe("association details (00009-07)", () => {
    let sql: UmbraDBSql;
    let store: PgShieldedMonitorStore;
    const schema = uniqueSchema("sm_details");
    let seedCounter = 7000;

    beforeAll(async () => {
      ({ sql, store } = await freshStore(container, schema));
    }, 120_000);
    afterAll(async () => {
      await sql?.end({ timeout: 5 });
    });
    beforeEach(() => {
      seedCounter += 1;
    });

    /** A minimal, well-shaped details document. Its exact content does not matter here — the
     *  extractor has its own suite; what matters is that jsonb round-trips it unchanged. */
    const detailsFor = (commitment: string): MatchDetails => ({
      version: "shielded-monitor/match-details/v1",
      ledgerBuild: TEST_LEDGER_BUILD,
      segments: [{
        segment: 0,
        matched: true,
        outputs: [{ index: 0, commitment, mine: true }],
        inputs: [],
        transients: [],
        counts: { outputs: 1, inputs: 0, transients: 0 },
      }],
      totals: { outputs: 1, inputs: 0, transients: 0, mine: 1, unattributed: 0 },
    });

    it("commits details and the block time in the SAME advance as the coverage move, and reads them back", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      await store.advance(id, epoch, 10n, [
        association(9n, 0, { details: detailsFor("aa11"), blockTimestampMs: 1_754_395_200_000n }),
        association(10n, 1),
      ]);
      const rows = await store.readAssociations(id, 0n, 100);
      expect(rows[0]!.details).toStrictEqual(detailsFor("aa11"));
      expect(rows[0]!.blockTimestampMs).toBe(1_754_395_200_000n);
      // The second association was written WITHOUT them: absent, not null, not an empty object.
      expect(rows[1]!.details).toBeUndefined();
      expect(rows[1]!.blockTimestampMs).toBeUndefined();
      expect((await store.get(id)).coverage.scannedThrough).toBe(10n);
    });

    it("refuses a details document larger than the store's own bound", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      const huge = { blob: "x".repeat(MAX_ASSOCIATION_DETAILS_BYTES + 1) } as unknown as MatchDetails;
      await expect(
        store.advance(id, epoch, 1n, [association(1n, 0, { details: huge })]),
      ).rejects.toThrow(ValidationError);
      // And the whole batch is refused before anything is written: a bad detail must not be able
      // to commit half a height.
      expect(await store.readAssociations(id, 0n, 10)).toStrictEqual([]);
      expect((await store.get(id)).coverage.scannedThrough).toBeUndefined();
    });

    it("[[shielded-monitor.backfill.fills-null-rows-once-and-is-idempotent]] fills only NULL rows, exactly once, and a second run changes nothing", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      // Three pre-00009-07 rows plus one already carrying details.
      await store.advance(id, epoch, 4n, [
        association(1n, 0),
        association(2n, 0),
        association(3n, 0),
        association(4n, 0, { details: detailsFor("already"), blockTimestampMs: 1n }),
      ]);

      const missing = await store.readAssociationsMissingDetails(id, 0n, 100);
      expect(missing.map((r) => r.seq)).toStrictEqual([1n, 2n, 3n]);

      const first = await store.updateAssociationDetails(id, epoch, missing.map((r) => ({
        seq: r.seq,
        details: detailsFor(`filled-${r.seq}`),
        blockTimestampMs: 1_000n + r.seq,
      })));
      expect(first.applied).toBe(3);

      const afterFill = await store.readAssociations(id, 0n, 100);
      expect(afterFill.map((r) => r.details?.segments[0]?.outputs[0]?.commitment)).toStrictEqual([
        "filled-1", "filled-2", "filled-3", "already",
      ]);
      expect(afterFill.map((r) => r.blockTimestampMs)).toStrictEqual([1001n, 1002n, 1003n, 1n]);
      expect(await store.readAssociationsMissingDetails(id, 0n, 100)).toStrictEqual([]);

      // Idempotent BY PREDICATE: re-running the same updates fills nothing, and — the assertion
      // that matters — cannot overwrite what is already there.
      const second = await store.updateAssociationDetails(id, epoch, [
        ...missing.map((r) => ({ seq: r.seq, details: detailsFor("second-run") })),
        { seq: 4n, details: detailsFor("second-run") },
      ]);
      expect(second.applied).toBe(0);
      const afterRerun = await store.readAssociations(id, 0n, 100);
      expect(afterRerun.map((r) => r.details?.segments[0]?.outputs[0]?.commitment)).toStrictEqual([
        "filled-1", "filled-2", "filled-3", "already",
      ]);
      expect(afterRerun.map((r) => r.blockTimestampMs)).toStrictEqual([1001n, 1002n, 1003n, 1n]);
    });

    it("pages the missing-details work list forward by seq, so an unfillable row cannot stall it", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      await store.advance(id, epoch, 3n, [association(1n, 0), association(2n, 0), association(3n, 0)]);
      const page1 = await store.readAssociationsMissingDetails(id, 0n, 2);
      expect(page1.map((r) => r.seq)).toStrictEqual([1n, 2n]);
      // Nothing is filled, yet the next page moves on — the property a backfill needs when it
      // legitimately cannot derive a row.
      const page2 = await store.readAssociationsMissingDetails(id, page1[1]!.seq, 2);
      expect(page2.map((r) => r.seq)).toStrictEqual([3n]);
    });

    it("rejects a stale epoch, and writes nothing when it does (FR-012)", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      await store.advance(id, epoch, 1n, [association(1n, 0)]);
      // A lifecycle transition lands under the backfill.
      await store.pause(id, "op");
      await expect(
        store.updateAssociationDetails(id, epoch, [{ seq: 1n, details: detailsFor("x") }]),
      ).rejects.toThrow(MonitorFencedError);
      expect((await store.readAssociations(id, 0n, 10))[0]!.details).toBeUndefined();

      // With the CURRENT epoch it goes through — and a paused monitor is deliberately fillable:
      // its matches are still readable, so leaving them detail-less would make the dashboard's
      // "run the backfill" placeholder a lie.
      const paused = await store.get(id);
      const applied = await store.updateAssociationDetails(id, paused.epoch, [
        { seq: 1n, details: detailsFor("x") },
      ]);
      expect(applied.applied).toBe(1);
    });

    it("refuses a revoked monitor and reports a deleted one as not found", async () => {
      const revoked = await registerFixture(store, seedCounter);
      await store.advance(revoked.id, revoked.epoch, 1n, [association(1n, 0)]);
      const revokedNow = await store.revoke(revoked.id, "op");
      await expect(store.readAssociationsMissingDetails(revoked.id, 0n, 10)).rejects.toThrow(MonitorRevokedError);
      await expect(
        store.updateAssociationDetails(revoked.id, revokedNow.epoch, [{ seq: 1n, details: detailsFor("x") }]),
      ).rejects.toThrow(MonitorRevokedError);

      const deletedNow = await store.delete(revoked.id, "op");
      await expect(store.readAssociationsMissingDetails(revoked.id, 0n, 10)).rejects.toThrow(MonitorNotFoundError);
      // The epoch is irrelevant here on purpose: a deleted monitor is "not found" BEFORE the
      // fence is consulted, so no epoch can talk its way past US3 scenario 4.
      await expect(
        store.updateAssociationDetails(
          revoked.id, deletedNow?.epoch ?? revokedNow.epoch, [{ seq: 1n, details: detailsFor("x") }],
        ),
      ).rejects.toThrow(MonitorNotFoundError);
    });

    it("an empty update list is a no-op that does not even open a transaction's worth of work", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      expect(await store.updateAssociationDetails(id, epoch, [])).toStrictEqual({ applied: 0 });
    });
  });

  // ── listAll: the operator read (00009-06) ─────────────────────────────────────────────────

  describe("listAll", () => {
    /** Its own schema, so the ordering and membership assertions below are about exactly the
     *  monitors this block registers and nothing another block left behind. */
    async function ownSchema() {
      const schemaName = uniqueSchema("sm_listall");
      const { sql: ownSql, store: ownStore } = await freshStore(container, schemaName);
      return { sql: ownSql, store: ownStore };
    }

    it("returns every non-deleted monitor, in creation order, whatever its state", async () => {
      const { sql: ownSql, store: ownStore } = await ownSchema();
      try {
        const live = await registerFixture(ownStore, 9001);
        const paused = await registerFixture(ownStore, 9002);
        const failed = await registerFixture(ownStore, 9003);
        const revoked = await registerFixture(ownStore, 9004);
        const deleted = await registerFixture(ownStore, 9005);

        await ownStore.goLive(live.id, live.epoch, "op");
        await ownStore.pause(paused.id, "op");
        await ownStore.markFailed(failed.id, "op", { code: "UNSUPPORTED_PROTOCOL_VERSION", message: "x" });
        await ownStore.revoke(revoked.id, "op");
        await ownStore.delete(deleted.id, "op");

        const all = await ownStore.listAll();
        // Order is registration order, which is what an operator's list must be: it does not
        // reshuffle when a monitor changes state under them.
        expect(all.map((m) => m.id)).toStrictEqual([live.id, paused.id, failed.id, revoked.id]);
        expect(all.map((m) => m.state)).toStrictEqual(["live", "paused", "failed", "revoked"]);

        // `listActive` answers a DIFFERENT question and still does: only the scannable two.
        expect((await ownStore.listActive()).map((m) => m.id)).toStrictEqual([live.id]);
      } finally {
        await ownSql.end({ timeout: 5 });
      }
    }, 120_000);

    it("excludes a deleted monitor, which is the one exclusion that is not negotiable", async () => {
      const { sql: ownSql, store: ownStore } = await ownSchema();
      try {
        const { id } = await registerFixture(ownStore, 9010);
        expect((await ownStore.listAll()).map((m) => m.id)).toStrictEqual([id]);
        await ownStore.delete(id, "op");
        // US3 scenario 4: a deleted monitor must be indistinguishable from one that never was.
        expect(await ownStore.listAll()).toStrictEqual([]);
      } finally {
        await ownSql.end({ timeout: 5 });
      }
    }, 120_000);

    it("carries no key and no fingerprint, exactly as every other record read does", async () => {
      const { sql: ownSql, store: ownStore } = await ownSchema();
      try {
        await registerFixture(ownStore, 9020);
        const [record] = await ownStore.listAll();
        expect(record).toBeDefined();
        const serialized = JSON.stringify(record, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
        expect(serialized.toLowerCase()).not.toContain("fingerprint");
        expect(serialized.toLowerCase()).not.toContain("key_serialized");
      } finally {
        await ownSql.end({ timeout: 5 });
      }
    }, 120_000);

    it("bounds the result and refuses an unusable limit", async () => {
      const { sql: ownSql, store: ownStore } = await ownSchema();
      try {
        for (const seed of [9030, 9031, 9032]) await registerFixture(ownStore, seed);
        expect(await ownStore.listAll(2)).toHaveLength(2);
        expect(await ownStore.listAll(100)).toHaveLength(3);
        await expect(ownStore.listAll(0)).rejects.toThrow(ValidationError);
        await expect(ownStore.listAll(-1)).rejects.toThrow(ValidationError);
        await expect(ownStore.listAll(10_001)).rejects.toThrow(ValidationError);
        await expect(ownStore.listAll(1.5)).rejects.toThrow(ValidationError);
      } finally {
        await ownSql.end({ timeout: 5 });
      }
    }, 120_000);
  });

  // ── Idle behaviour (US6) ──────────────────────────────────────────────────────────────────

  describe("an empty schema is a healthy idle state (US6 scenario 2)", () => {
    it("listActive on a freshly bootstrapped schema returns an empty list", async () => {
      const { sql, store } = await freshStore(container, uniqueSchema("sm_idle"));
      try {
        expect(await store.listActive()).toStrictEqual([]);
        expect(await store.listRevocations()).toStrictEqual([]);
        expect(await store.listAll()).toStrictEqual([]);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }, 120_000);
  });
});
