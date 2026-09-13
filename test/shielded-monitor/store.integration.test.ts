import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "../../src/interfaces/storage-errors.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import {
  MonitorFencedError,
  MonitorNotFoundError,
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
        fingerprint: key.fingerprint,
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
        fingerprint: key.fingerprint,
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
        fingerprint: (await fixtureViewingKey(3, "undeployed")).fingerprint,
        net: "undeployed",
        requestedStartHeight: 0n,
        matchingRuleVersion: TEST_MATCHING_RULE,
        ledgerBuild: TEST_LEDGER_BUILD,
        actor: "test",
      });
      const onPreview = await store.register({
        fingerprint: (await fixtureViewingKey(3, "preview")).fingerprint,
        net: "preview",
        requestedStartHeight: 0n,
        matchingRuleVersion: TEST_MATCHING_RULE,
        ledgerBuild: TEST_LEDGER_BUILD,
        actor: "test",
      });
      expect(onPreview.id).not.toBe(onUndeployed.id);
    });

    it("refuses a fingerprint that is not 32 bytes of SHA-256", async () => {
      // The cross-network check this case used to make — "a key validated for `preview` may not
      // be registered on `undeployed`" — MOVED in 00009-09, and had to: the store is handed a
      // hash now, and a hash carries no network to compare. The check lives where the key still
      // exists, in `parseViewingKey`, which refuses a wrong-HRP key before a fingerprint is ever
      // computed (`viewing-key.test.ts`). What the store can still refuse is a value that is not
      // a fingerprint at all, and it does.
      await expect(
        store.register({
          fingerprint: Uint8Array.from([1, 2, 3]),
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
        fingerprint: (await fixtureViewingKey(5)).fingerprint,
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
        fingerprint: key.fingerprint,
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

    it("re-registering a key after a delete mints a FRESH monitor, as if the first never existed", async () => {
      const key = await fixtureViewingKey(6);
      const input = {
        fingerprint: key.fingerprint,
        net: "undeployed",
        requestedStartHeight: 0n,
        matchingRuleVersion: TEST_MATCHING_RULE,
        ledgerBuild: TEST_LEDGER_BUILD,
        actor: "test",
      };
      // Since owner decision Q33 this is the whole "I changed my mind" path: there is no revoke
      // to undo, so a consumer deletes and registers again — and what they get is a new monitor
      // with no coverage and no matches, which is what US3 scenario 4's "as if the monitor never
      // existed" means when the same key comes back.
      const first = await store.register(input);
      await store.advance(first.id, first.epoch, 5n, [association(5n, 0)]);
      await store.delete(first.id, "test");

      const reborn = await store.register(input);
      expect(reborn.id).not.toBe(first.id);
      expect(reborn.state).toBe("backfilling");
      expect(reborn.epoch).toBe(0n);
      expect(reborn.coverage.scannedThrough, "a fresh monitor has scanned nothing").toBeUndefined();
      expect(await store.readAssociations(reborn.id, 0n, 10)).toStrictEqual([]);
      // And the first monitor is gone for every reader, tombstone or not.
      await expect(store.get(first.id)).rejects.toThrow(MonitorNotFoundError);
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
    it("[[shielded-monitor.fencing.stale-epoch-never-commits]] a stale epoch commits nothing, and a stop mid-batch fences the in-flight worker", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      await store.advance(id, epoch, 5n, [association(5n, 0)]);

      // A worker loads the monitor here…
      const loaded = await store.get(id);
      expect(loaded.epoch).toBe(epoch);

      // …the monitor stops while the worker is mid-batch…
      const stopped = await store.markStaleSource(id, "operator");
      expect(stopped.state).toBe("stale_source");
      expect(stopped.epoch).toBe(epoch + 1n);

      const before = await schemaSnapshot(sql, schema);

      // …and the worker's commit is rejected. The state is no longer scannable AND the epoch
      // moved; the store reports the state, which is the more actionable of the two.
      const fenced = await store.advance(id, loaded.epoch, 6n, [association(6n, 0)]).catch((e: unknown) => e);
      expect(fenced).toBeInstanceOf(MonitorFencedError);
      expect((fenced as MonitorFencedError).rejection).toBe("state");
      expect((fenced as MonitorFencedError).observed.state).toBe("stale_source");

      expect(await schemaSnapshot(sql, schema)).toBe(before);

      // The pure epoch-mismatch branch, on a monitor that IS scannable: a second worker advances
      // it legitimately, and the first worker's original epoch is now stale.
      const fresh = await registerFixture(store, seedCounter + 7000);
      await store.advance(fresh.id, fresh.epoch, 4n, []);
      const moved = await store.goLive(fresh.id, fresh.epoch, "scanner");
      expect(moved.epoch).toBe(fresh.epoch + 1n);

      const beforeStale = await schemaSnapshot(sql, schema);
      const stale = await store.advance(fresh.id, fresh.epoch, 6n, [association(6n, 0)]).catch((e: unknown) => e);
      expect(stale).toBeInstanceOf(MonitorFencedError);
      expect((stale as MonitorFencedError).rejection).toBe("epoch");
      expect((stale as MonitorFencedError).observed.epoch).toBe(fresh.epoch + 1n);
      expect(await schemaSnapshot(sql, schema)).toBe(beforeStale);

      // POSITIVE CONTROL: with the current epoch the very same batch commits, so the rejections
      // above were caused by the fence and not by a malformed batch.
      const ok = await store.advance(fresh.id, moved.epoch, 6n, [association(6n, 0)]);
      expect(ok.applied).toBe(true);
      expect((await store.get(fresh.id)).coverage.scannedThrough).toBe(6n);
      // And it carried on from `scannedThrough` with no duplicate and no skip.
      const rows = await store.readAssociations(fresh.id, 0n, 100);
      expect(rows.map((r) => r.blockHeight)).toStrictEqual([6n]);
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

  // ── Block-centric commits and gaps (00009-09) ──────────────────────────────────────────────

  describe("advanceBatch and fillGap: one block for every monitor, and the holes below coverage", () => {
    let sql: UmbraDBSql;
    let store: PgShieldedMonitorStore;
    const schema = uniqueSchema("sm_batch");
    let seedCounter = 900;
    const NET = "undeployed";

    beforeAll(async () => {
      ({ sql, store } = await freshStore(container, schema));
    }, 120_000);
    afterAll(async () => {
      await sql?.end({ timeout: 5 });
    });

    beforeEach(() => {
      seedCounter += 1;
    });

    /** The block hash `association(height, …)` uses, so a batch and its items agree. */
    const blockHashFor = (height: bigint): Uint8Array => association(height, 0).blockHash;

    it("[[shielded-monitor.store.advance-batch-reports-fenced-items-without-failing-the-block]] advances the healthy monitors of a block and REPORTS the rest, with the reason", async () => {
      // OP-2, as a property rather than a promise: one stopped wallet must not stall a block for
      // every other wallet a node holds. Four monitors, four different answers, one transaction.
      const healthy = await registerFixture(store, seedCounter);
      const stopped = await registerFixture(store, seedCounter + 1000);
      const stale = await registerFixture(store, seedCounter + 2000);
      const ahead = await registerFixture(store, seedCounter + 3000);
      await store.markFailed(stopped.id, "op", { code: "X", message: "stopped for this case" });
      // `ahead` is already past the batch's height, which is the idempotent-replay path.
      await store.advance(ahead.id, ahead.epoch, 9n, []);
      const aheadNow = await store.get(ahead.id);

      const height = 5n;
      const result = await store.advanceBatch(NET, height, blockHashFor(height), [
        { monitorId: healthy.id, expectedEpoch: healthy.epoch, associations: [association(height, 0)] },
        { monitorId: stopped.id, expectedEpoch: stopped.epoch, associations: [association(height, 0)] },
        { monitorId: stale.id, expectedEpoch: stale.epoch + 9n, associations: [] },
        { monitorId: ahead.id, expectedEpoch: aheadNow.epoch, associations: [] },
        { monitorId: randomUUID(), expectedEpoch: 0n, associations: [] },
      ]);

      expect(result.advanced).toStrictEqual([healthy.id]);
      expect(new Map(result.fenced.map((f) => [f.id, f.reason]))).toStrictEqual(new Map([
        // `markFailed` bumps the epoch too, so the state check is what has to fire first for this
        // to read `state` rather than `epoch` — which is the distinction a node acts on.
        [stopped.id, "state"],
        [stale.id, "epoch"],
        [ahead.id, "already-advanced"],
        [result.fenced.find((f) => f.reason === "not-found")!.id, "not-found"],
      ]));

      // The healthy monitor really did land, and the fenced ones really did not.
      expect((await store.get(healthy.id)).coverage.scannedThrough).toBe(height);
      expect((await store.readAssociations(healthy.id, 0n, 10))).toHaveLength(1);
      expect((await store.getIncludingDeleted(stopped.id))!.coverage.scannedThrough).toBeUndefined();
      expect((await store.readAssociations(stale.id, 0n, 10))).toHaveLength(0);
    });

    it("refuses a batch whose items contradict the block it names", async () => {
      // The batch's identity is the only thing tying a node's per-monitor lists together; an
      // association for another block, or another block's hash, would write a match into the
      // wrong row while advancing coverage as if it were right.
      const { id, epoch } = await registerFixture(store, seedCounter);
      await expect(store.advanceBatch(NET, 5n, blockHashFor(5n), [
        { monitorId: id, expectedEpoch: epoch, associations: [association(4n, 0)] },
      ])).rejects.toThrow(/belongs to that block/);
      await expect(store.advanceBatch(NET, 5n, blockHashFor(6n), [
        { monitorId: id, expectedEpoch: epoch, associations: [association(5n, 0)] },
      ])).rejects.toThrow(/different block hash/);
      // A gap is a range BELOW the coverage the batch sets; one at or above it is nonsense.
      await expect(store.advanceBatch(NET, 5n, blockHashFor(5n), [
        { monitorId: id, expectedEpoch: epoch, associations: [], newGaps: [{ from: 5n, to: 6n }] },
      ])).rejects.toThrow(/BELOW the coverage/);
      // And one monitor may appear only once: twice would allocate two overlapping `seq` ranges
      // from one `last_assoc_seq` read.
      await expect(store.advanceBatch(NET, 5n, blockHashFor(5n), [
        { monitorId: id, expectedEpoch: epoch, associations: [] },
        { monitorId: id, expectedEpoch: epoch, associations: [] },
      ])).rejects.toThrow(/twice in one block batch/);
    });

    it("[[shielded-monitor.store.fill-gap-shrinks-splits-and-deletes]] a fill shrinks, splits or deletes the gap rows it covers, and never moves coverage", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      // Coverage jumps to 20 with the range 1..10 recorded as never read — the shape the
      // HAS_SCANNED_ONCE check produces when a key joins the live set behind its own coverage.
      const batch = await store.advanceBatch(NET, 20n, blockHashFor(20n), [
        { monitorId: id, expectedEpoch: epoch, associations: [], newGaps: [{ from: 1n, to: 10n }] },
      ]);
      expect(batch.advanced).toStrictEqual([id]);
      const withGap = await store.get(id);
      expect(withGap.gaps.map((g) => `${g.from}-${g.to}`)).toStrictEqual(["1-10"]);
      const recordedAt = withGap.gaps[0]!.recordedAt;

      // 1. A fill in the MIDDLE splits it in two.
      const split = await store.fillGap(id, {
        expectedEpoch: withGap.epoch, from: 4n, to: 6n, associations: [association(5n, 0)],
      });
      expect(split.written).toBe(1);
      expect(split.gaps.map((g) => `${g.from}-${g.to}`)).toStrictEqual(["1-3", "7-10"]);
      // The remainder keeps the moment the hole was FOUND: a fresh timestamp would make an old
      // unfilled range look newly discovered every time a back-sync nibbled at it.
      expect(split.gaps[0]!.recordedAt.getTime()).toBe(recordedAt.getTime());

      // 2. A fill at the FRONT of a remainder shrinks it from the left.
      const shrunkLeft = await store.fillGap(id, {
        expectedEpoch: withGap.epoch, from: 1n, to: 2n, associations: [],
      });
      expect(shrunkLeft.gaps.map((g) => `${g.from}-${g.to}`)).toStrictEqual(["3-3", "7-10"]);

      // 3. A fill at the END shrinks it from the right.
      const shrunkRight = await store.fillGap(id, {
        expectedEpoch: withGap.epoch, from: 9n, to: 10n, associations: [],
      });
      expect(shrunkRight.gaps.map((g) => `${g.from}-${g.to}`)).toStrictEqual(["3-3", "7-8"]);

      // 4. An EXACT fill deletes the row, and a fill spanning several rows clears them all.
      const cleared = await store.fillGap(id, {
        expectedEpoch: withGap.epoch, from: 3n, to: 8n, associations: [association(7n, 1)],
      });
      expect(cleared.gaps).toStrictEqual([]);
      expect(await store.listGaps(id)).toStrictEqual([]);

      // Coverage never moved — it was already above the range, which is why the gap existed.
      const after = await store.get(id);
      expect(after.coverage.scannedThrough).toBe(20n);
      expect(after.gaps).toStrictEqual([]);
      // The back-filled matches are there, at their real heights, with sequence numbers ABOVE the
      // ones the live pass handed out. `seq` is the consumer's cursor, so a match discovered later
      // must page later even though its height is older.
      const rows = await store.readAssociations(id, 0n, 100);
      expect(rows.map((r) => `${r.blockHeight}@${r.seq}`)).toStrictEqual(["5@1", "7@2"]);
    });

    it("[[shielded-monitor.store.fill-gap-skips-rows-it-already-holds]] a fill over a range that already holds a recorded match writes only what is missing, reports `written` accordingly, and still shrinks the gap", async () => {
      // Organizer question Q32, measured on the live demo: the first `fill-gap` of a back-sync
      // over a range containing an already-recorded match died on `associations_observation_key`
      // (a 500 from the storage API), Queue B dropped the job, and the gap row stayed forever.
      // Every other writer here is protected from a replay by the `scanned_through < height`
      // fence; a back-sync has none, because re-reading covered ground IS its purpose.
      const { id, epoch } = await registerFixture(store, seedCounter);
      // Height 5 was recorded by the live pass. Coverage then jumped to 20 with `[1, 10]` marked
      // never read — the shape a coverage repair, or a moment of double custody, leaves behind.
      await store.advanceBatch(NET, 5n, blockHashFor(5n), [
        { monitorId: id, expectedEpoch: epoch, associations: [association(5n, 0)] },
      ]);
      const at5 = await store.get(id);
      await store.advanceBatch(NET, 20n, blockHashFor(20n), [
        { monitorId: id, expectedEpoch: at5.epoch, associations: [], newGaps: [{ from: 1n, to: 10n }] },
      ]);
      const withGap = await store.get(id);
      expect(withGap.gaps.map((g) => `${g.from}-${g.to}`)).toStrictEqual(["1-10"]);

      // The back-sync re-reads the whole range and finds both matches: the one already stored at
      // height 5, and one at height 7 that nothing has ever recorded.
      const filled = await store.fillGap(id, {
        expectedEpoch: withGap.epoch,
        from: 1n,
        to: 10n,
        associations: [association(5n, 0), association(7n, 1)],
      });
      expect(filled.written, "only the row that was actually missing").toBe(1);
      expect(filled.gaps, "and the gap is cleared all the same").toStrictEqual([]);
      expect(await store.listGaps(id)).toStrictEqual([]);

      // Two rows, one per observation. `seq` is MONOTONIC but not dense (owner decision Q32,
      // option B): the skipped row's number was allocated and not used, so there is a hole at 2.
      // Safe, because `seq` is a cursor and not a count — a page asks for `seq > afterSeq` and a
      // hole is simply a number nobody stops at.
      const rows = await store.readAssociations(id, 0n, 100);
      expect(rows.map((r) => Number(r.blockHeight))).toStrictEqual([5, 7]);
      const seqs = rows.map((r) => r.seq);
      expect(seqs[0]! < seqs[1]!, "monotonic").toBe(true);

      // Idempotent from here on: the same back-sync run twice writes nothing more, which is what
      // makes a retry after a lost response safe.
      const again = await store.fillGap(id, {
        expectedEpoch: withGap.epoch,
        from: 1n,
        to: 10n,
        associations: [association(5n, 0), association(7n, 1)],
      });
      expect(again.written).toBe(0);
      expect(await store.readAssociations(id, 0n, 100)).toHaveLength(2);
      expect((await store.get(id)).coverage.scannedThrough, "a fill never moves coverage").toBe(20n);
    });

    it("a fill is fenced on the epoch, and refuses a range its associations sit outside", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      await store.advanceBatch(NET, 20n, blockHashFor(20n), [
        { monitorId: id, expectedEpoch: epoch, associations: [], newGaps: [{ from: 1n, to: 10n }] },
      ]);
      const current = await store.get(id);
      await expect(store.fillGap(id, {
        expectedEpoch: current.epoch + 5n, from: 1n, to: 2n, associations: [],
      })).rejects.toThrow(MonitorFencedError);
      await expect(store.fillGap(id, {
        expectedEpoch: current.epoch, from: 1n, to: 2n, associations: [association(9n, 0)],
      })).rejects.toThrow(/outside the range/);
      // Nothing was written by either refusal.
      expect(await store.readAssociations(id, 0n, 10)).toHaveLength(0);
      expect((await store.listGaps(id)).map((g) => `${g.from}-${g.to}`)).toStrictEqual(["1-10"]);
    });

    it("[[shielded-monitor.store.register-upserts-by-fingerprint-and-returns-coverage-and-gaps]] re-registering a fingerprint returns the existing monitor with its coverage and its gaps", async () => {
      // This is how a monitor-node resumes: a client re-sends a key after a node died, the
      // fingerprint finds the same row, and what comes back is where to carry on from. A register
      // that returned a bare monitor would make the node rescan history it already has.
      const key = await fixtureViewingKey(seedCounter + 4000);
      const input = {
        fingerprint: key.fingerprint,
        net: NET,
        requestedStartHeight: 0n,
        matchingRuleVersion: TEST_MATCHING_RULE,
        ledgerBuild: TEST_LEDGER_BUILD,
        actor: "test",
      };
      const first = await store.register(input);
      expect(first.coverage.scannedThrough).toBeUndefined();
      expect(first.gaps).toStrictEqual([]);

      await store.advanceBatch(NET, 12n, blockHashFor(12n), [{
        monitorId: first.id,
        expectedEpoch: first.epoch,
        associations: [association(12n, 0)],
        newGaps: [{ from: 3n, to: 5n }],
      }]);

      const again = await store.register(input);
      expect(again.id).toBe(first.id);
      expect(again.coverage.scannedThrough).toBe(12n);
      expect(again.gaps.map((g) => `${g.from}-${g.to}`)).toStrictEqual(["3-5"]);
    });

    it("a delete shreds the gap rows with everything else", async () => {
      // The FK's `ON DELETE CASCADE` never fires for a delete — the monitor row survives as a
      // tombstone (US3 scenario 4) — so the shred has to be explicit, or re-registering the same
      // key would mint a fresh monitor while stale gaps still described the old one.
      const { id, epoch } = await registerFixture(store, seedCounter);
      await store.advanceBatch(NET, 20n, blockHashFor(20n), [
        { monitorId: id, expectedEpoch: epoch, associations: [], newGaps: [{ from: 1n, to: 4n }] },
      ]);
      expect(await store.listGaps(id)).toHaveLength(1);
      await store.delete(id, "op");
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${sql(schema)}.monitor_gaps WHERE monitor_id = ${id}
      `;
      expect(row?.n).toBe(0);
    });
  });

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
      const { id, epoch } = await registerFixture(store, seedCounter);
      const live = await store.goLive(id, epoch, "scanner");
      expect(live.epoch).toBe(1n);

      const again = await store.goLive(id, live.epoch, "scanner");
      expect(again.epoch).toBe(1n); // idempotent re-issue changes nothing

      const failed = await store.markFailed(id, "op", { code: "X", message: "stopped" });
      expect(failed).toMatchObject({ state: "failed", epoch: 2n });

      const events = await store.listLifecycleEvents(id);
      expect(events.map((e) => [e.event, e.stateAfter, e.epochAfter])).toStrictEqual([
        ["register", "backfilling", 0n],
        ["go_live", "live", 1n],
        ["fail", "failed", 2n],
      ]);
      expect(events.map((e) => e.seq)).toStrictEqual([1n, 2n, 3n]);
      expect(events[1]!.actor).toBe("scanner");
    });

    it("go_live is fenced by the loaded epoch", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      await store.markStaleSource(id, "op");
      await expect(store.goLive(id, epoch, "scanner")).rejects.toThrow(MonitorFencedError);
    });

    it("refuses an illegal transition with a typed error", async () => {
      // `failed` is terminal but for a delete: promoting one to `live` is not a thing the table
      // admits, and the store says so with a typed error rather than silently doing nothing.
      const { id } = await registerFixture(store, seedCounter);
      const failed = await store.markFailed(id, "op", { code: "X", message: "stopped" });
      await expect(store.goLive(id, failed.epoch, "scanner"))
        .rejects.toThrow(IllegalLifecycleTransitionError);
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
      const record = await store.getIncludingDeleted(id);
      await expect(store.advance(id, record!.epoch, 1n, [])).rejects.toThrow(MonitorFencedError);
    });

    it("markFailed and markStaleSource are fenceable by the worker's loaded epoch (FR-012)", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      await store.goLive(id, epoch, "scanner"); // the epoch moves under the worker
      await expect(
        store.markFailed(id, "scanner", { code: "X", message: "y" }, epoch),
      ).rejects.toThrow(MonitorFencedError);
      await expect(
        store.markStaleSource(id, "scanner", { code: "X", message: "y" }, epoch),
      ).rejects.toThrow(MonitorFencedError);
      expect((await store.getIncludingDeleted(id))!.state).toBe("live");

      // POSITIVE CONTROL: with the current epoch the same call is admitted.
      const current = (await store.getIncludingDeleted(id))!;
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

    it("a stopped monitor keeps its recorded lastError, and its matches stay readable", async () => {
      // The reason `failed` is not a soft delete: the operator still needs to read what was found
      // before it stopped, and the reason it stopped.
      const { id, epoch } = await registerFixture(store, seedCounter);
      await store.advance(id, epoch, 3n, [association(3n, 0)]);
      const current = await store.get(id);
      await store.markFailed(id, "scanner", { code: "X", message: "y" }, current.epoch);
      expect((await store.getIncludingDeleted(id))!.lastError?.code).toBe("X");
      expect(await store.readAssociations(id, 0n, 10)).toHaveLength(1);
      expect((await store.get(id)).state).toBe("failed");
    });

    it("a stopped monitor drops out of listActive but stays in listAll", async () => {
      const { id } = await registerFixture(store, seedCounter);
      expect((await store.listActive()).map((m) => m.id)).toContain(id);
      await store.markFailed(id, "op", { code: "X", message: "y" });
      expect((await store.listActive()).map((m) => m.id)).not.toContain(id);
      expect((await store.listAll()).map((m) => m.id)).toContain(id);
    });

    it("delete destroys the key's identity, the matches and every scan fact, and keeps the log (US3 scenario 4)", async () => {
      const { id, epoch } = await registerFixture(store, seedCounter);
      await store.advance(id, epoch, 3n, [association(3n, 0), association(3n, 1)]);

      const deleted = await store.delete(id, "op");
      expect(deleted?.state).toBe("deleted");

      // Indistinguishable from a monitor that never existed.
      await expect(store.get(id)).rejects.toThrow(MonitorNotFoundError);
      const unknownError = await store.get(randomUUID()).catch((e: unknown) => e);
      const deletedError = await store.get(id).catch((e: unknown) => e);
      expect((deletedError as Error).constructor).toBe((unknownError as Error).constructor);

      // The identity and every derived row are gone.
      const row = await sql<{ fingerprint: Buffer | null }[]>`
        SELECT fingerprint FROM ${sql(schema)}.monitors WHERE id = ${id}
      `;
      expect(row[0]!.fingerprint).toBeNull();
      const assoc = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM ${sql(schema)}.associations WHERE monitor_id = ${id}
      `;
      expect(assoc[0]!.count).toBe("0");

      // "With all the related data" (owner decision Q33): the tombstone keeps the monitor's id,
      // its network and the fact that it is gone. Everything that described the monitor — its
      // coverage claim, its archive binding, its last error, its requested start — is cleared.
      const shape = await sql<{
        requested_start_height: bigint; scanned_from_height: bigint | null;
        scanned_through_height: bigint | null; source_genesis_hash: string | null;
        last_error: unknown; last_assoc_seq: bigint;
      }[]>`
        SELECT requested_start_height, scanned_from_height, scanned_through_height,
               source_genesis_hash, last_error, last_assoc_seq
          FROM ${sql(schema)}.monitors WHERE id = ${id}
      `;
      expect(shape[0]).toMatchObject({
        requested_start_height: 0n,
        scanned_from_height: null,
        scanned_through_height: null,
        source_genesis_hash: null,
        last_error: null,
        last_assoc_seq: 0n,
      });

      // The lifecycle log survives — it is the record of what was done, and a delete is one of
      // the things that was done. ONE transition since Q33, where it used to travel via revoke.
      const events = await store.listLifecycleEvents(id);
      expect(events.map((e) => e.event)).toStrictEqual(["register", "delete"]);
      expect(events.map((e) => e.epochAfter)).toStrictEqual([0n, 1n]);

      // Idempotent.
      const again = await store.delete(id, "op");
      expect(again?.state).toBe("deleted");
      expect((await store.listLifecycleEvents(id)).length).toBe(2);
    });

    it("deleting an unknown monitor is a no-op, not an error", async () => {
      expect(await store.delete(randomUUID(), "op")).toBeUndefined();
    });

    it("[[shielded-monitor.store.no-key-material-is-ever-written]] never writes key material, for any monitor, in any state (00009-09)", async () => {
      // This case replaces `getKeyMaterial returns the stored key…`, and the inversion is the
      // point of the phase: there is no method that could return a key, and since migration 004
      // (OP-4) there is no COLUMN either — a key cannot reach this table even by mistake.
      const first = await registerFixture(store, seedCounter);
      const second = await registerFixture(store, seedCounter + 1);
      await store.advance(first.id, first.epoch, 3n, [association(3n, 0)]);
      await store.markFailed(second.id, "op", { code: "X", message: "y" });

      const columns = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = ${schema} AND table_name = 'monitors'
      `;
      expect(columns.map((c) => c.column_name), "the key column does not exist")
        .not.toContain("key_serialized");
      const rows = await sql<{ id: string; fingerprint: Buffer | null }[]>`
        SELECT id, fingerprint FROM ${sql(schema)}.monitors
      `;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      // And the identity that replaced it is present, which is what makes re-sending a key find
      // the same monitor.
      const live = rows.find((r) => r.id === first.id)!;
      expect(live.fingerprint).not.toBeNull();
      expect(live.fingerprint!.length).toBe(32);
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
  });

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
        const backfilling = await registerFixture(ownStore, 9002);
        const failed = await registerFixture(ownStore, 9003);
        const stale = await registerFixture(ownStore, 9004);
        const deleted = await registerFixture(ownStore, 9005);

        await ownStore.goLive(live.id, live.epoch, "op");
        await ownStore.markFailed(failed.id, "op", { code: "UNSUPPORTED_PROTOCOL_VERSION", message: "x" });
        await ownStore.markStaleSource(stale.id, "op");
        await ownStore.delete(deleted.id, "op");

        const all = await ownStore.listAll();
        // Order is registration order, which is what an operator's list must be: it does not
        // reshuffle when a monitor changes state under them.
        expect(all.map((m) => m.id)).toStrictEqual([live.id, backfilling.id, failed.id, stale.id]);
        expect(all.map((m) => m.state)).toStrictEqual(["live", "backfilling", "failed", "stale_source"]);

        // `listActive` answers a DIFFERENT question and still does: only the scannable ones.
        expect((await ownStore.listActive()).map((m) => m.id)).toStrictEqual([live.id, backfilling.id]);
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
        expect(await store.listDeletions()).toStrictEqual([]);
        expect(await store.listAll()).toStrictEqual([]);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }, 120_000);
  });
});
