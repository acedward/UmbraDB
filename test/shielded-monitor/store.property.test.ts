import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { MonitorFencedError, MonitorNotFoundError } from "../../shielded-monitor/errors.js";
import { isScannable, type MonitorState } from "../../shielded-monitor/lifecycle.js";
import type { PgShieldedMonitorStore } from "../../storage-api/monitor-store-pg.js";
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
 * The store's laws over randomly interleaved lifecycle events and coverage advances
 * (organizer sub-plan 00009-02's "property tests: fencing, idempotent register").
 *
 * These need a real database — the laws are about what a transaction commits, and an in-memory
 * double would be asserting the double. `numRuns` is deliberately modest: each run performs
 * real SQL, and the value of the property here is covering interleavings a hand-written test
 * would not think of, not statistical volume.
 *
 * The oracle is a tiny in-test model of the same rules, kept separate from
 * `shielded-monitor/lifecycle.ts` on purpose — a property test whose oracle IS the
 * implementation proves only that the implementation equals itself.
 */

type Op =
  | { readonly kind: "advance"; readonly heightStep: number; readonly matches: number; readonly useStaleEpoch: boolean }
  | { readonly kind: "goLive" }
  | { readonly kind: "fail" }
  | { readonly kind: "delete" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: fc.record({
    kind: fc.constant("advance" as const),
    heightStep: fc.integer({ min: 1, max: 5 }),
    matches: fc.integer({ min: 0, max: 3 }),
    useStaleEpoch: fc.boolean(),
  }) },
  { weight: 2, arbitrary: fc.constant({ kind: "goLive" as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: "fail" as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: "delete" as const }) },
);

describe("PgShieldedMonitorStore laws", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let store: PgShieldedMonitorStore;
  const schema = uniqueSchema("sm_props");
  let seed = 1000;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    ({ sql, store } = await freshStore(container, schema));
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  /**
   * Law F (fencing): across any interleaving, coverage is monotone, the association sequence is
   * gapless and strictly increasing, every association's height is at or below the coverage that
   * admitted it, and a stale-epoch advance changes nothing at all.
   */
  it("coverage is monotone, sequences are gapless, and a stale epoch never changes a row", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 4, maxLength: 14 }), async (ops) => {
        seed += 1;
        const { id } = await registerFixture(store, seed);

        // The oracle: what the rules say should be true, tracked independently.
        let expectedState: MonitorState = "backfilling";
        let expectedEpoch = 0n;
        let expectedThrough: bigint | undefined;
        let expectedSeq = 0n;
        let height = 0n;
        // A deliberately stale view, captured at registration and never refreshed.
        const staleEpoch = 0n;

        for (const op of ops) {
          const current = (await store.getIncludingDeleted(id))!;
          expect(current.state).toBe(expectedState);
          expect(current.epoch).toBe(expectedEpoch);

          if (op.kind === "advance") {
            height += BigInt(op.heightStep);
            const matches = Array.from({ length: op.matches }, (_, i) => association(height, i));
            const usedEpoch = op.useStaleEpoch ? staleEpoch : expectedEpoch;
            const before = await schemaSnapshot(sql, schema);
            const outcome = await store
              .advance(id, usedEpoch, height, matches)
              .then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));

            const admissible = isScannable(expectedState) && usedEpoch === expectedEpoch;
            if (admissible) {
              expect(outcome.ok).toBe(true);
              expectedThrough = height;
              expectedSeq += BigInt(op.matches);
            } else {
              expect(outcome.ok).toBe(false);
              if (outcome.ok) throw new Error("unreachable");
              // A deleted monitor answers NOT FOUND — a caller must not be able to tell it from
              // one that never existed (US3 scenario 4) — and everything else that is refused is
              // fenced.
              expect(outcome.e).toBeInstanceOf(
                expectedState === "deleted" ? MonitorNotFoundError : MonitorFencedError,
              );
              // Nothing at all changed — not the coverage, not a lifecycle row, not the counter.
              expect(await schemaSnapshot(sql, schema)).toBe(before);
            }
          } else if (op.kind === "delete") {
            await store.delete(id, "prop");
            if (expectedState !== "deleted") {
              expectedState = "deleted";
              expectedEpoch += 1n;
              // A delete takes the matches and every scan fact with it, which the oracle has to
              // track or the final reconciliation below is comparing against a history that no
              // longer exists.
              expectedThrough = undefined;
              expectedSeq = 0n;
            }
          } else {
            const event = op.kind === "fail" ? "fail" : "goLive";
            const legal =
              (event === "fail" && (expectedState === "backfilling" || expectedState === "live")) ||
              (event === "goLive" && expectedState === "backfilling");
            const idempotent =
              (event === "fail" && expectedState === "failed") ||
              (event === "goLive" && expectedState === "live");

            const call = event === "fail"
              ? store.markFailed(id, "prop", { code: "X", message: "y" })
              : store.goLive(id, expectedEpoch, "prop");
            const outcome = await call.then(() => true, () => false);

            if (legal) {
              expect(outcome).toBe(true);
              expectedState = event === "fail" ? "failed" : "live";
              expectedEpoch += 1n;
            } else if (idempotent) {
              expect(outcome).toBe(true);
            } else {
              expect(outcome).toBe(false);
            }
          }
        }

        // Final reconciliation against the database.
        const final = (await store.getIncludingDeleted(id))!;
        expect(final.state).toBe(expectedState);
        expect(final.epoch).toBe(expectedEpoch);
        expect(final.coverage.scannedThrough).toBe(expectedThrough);

        const rows = await sql<{ seq: bigint; block_height: bigint }[]>`
          SELECT seq, block_height FROM ${sql(schema)}.associations
           WHERE monitor_id = ${id} ORDER BY seq
        `;
        expect(rows.length).toBe(Number(expectedSeq));
        rows.forEach((row, index) => {
          expect(row.seq).toBe(BigInt(index + 1)); // gapless, strictly increasing, starting at 1
          if (expectedThrough !== undefined) expect(row.block_height <= expectedThrough).toBe(true);
        });
      }),
      { numRuns: 12 },
    );
  }, 300_000);

  /**
   * Law R (idempotent registration): registering the same key any number of times yields exactly
   * one monitor, and registering distinct keys yields distinct monitors.
   */
  it("registration is idempotent per (net, key) and injective across keys", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 2, maxLength: 8 }),
        async (keyIndexes) => {
          seed += 100;
          const localSchema = uniqueSchema("sm_reg");
          const { sql: localSql, store: localStore } = await freshStore(container, localSchema);
          try {
            const idsByKey = new Map<number, string>();
            for (const index of keyIndexes) {
              const key = await fixtureViewingKey(seed + index);
              const monitor = await localStore.register({
                fingerprint: key.fingerprint,
                net: "undeployed",
                requestedStartHeight: 0n,
                matchingRuleVersion: TEST_MATCHING_RULE,
                ledgerBuild: TEST_LEDGER_BUILD,
                actor: "prop",
              });
              const existing = idsByKey.get(index);
              if (existing === undefined) idsByKey.set(index, monitor.id);
              else expect(monitor.id).toBe(existing); // idempotent
            }

            // Injective: as many monitors as distinct keys, no more.
            const rows = await localSql<{ count: string }[]>`
              SELECT count(*)::text AS count FROM ${localSql(localSchema)}.monitors
            `;
            expect(Number(rows[0]!.count)).toBe(idsByKey.size);
            expect(new Set(idsByKey.values()).size).toBe(idsByKey.size);
          } finally {
            await localSql.end({ timeout: 5 });
          }
        },
      ),
      { numRuns: 6 },
    );
  }, 300_000);

  /**
   * Law A (absorbing deletion): once deleted, no sequence of operations makes the monitor
   * readable, scannable or advanceable again. Since owner decision Q33 this is the ONLY absorbing
   * state a consumer can produce, and it is the one that matters — a consumer who deletes a
   * monitor is asking for it to be gone, and "gone" has to survive whatever is issued next.
   */
  it("a deleted monitor is never readable or advanceable again, whatever follows", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 8 }), async (ops) => {
        seed += 1;
        const { id } = await registerFixture(store, seed);
        const deleted = (await store.delete(id, "prop"))!;

        for (const op of ops) {
          if (op.kind === "advance") {
            await expect(store.advance(id, deleted.epoch, 1n, [])).rejects.toThrow(MonitorNotFoundError);
          } else if (op.kind === "delete") {
            await store.delete(id, "prop"); // idempotent no-op
          } else {
            // Every other lifecycle event is illegal from `deleted`.
            const call = op.kind === "fail"
              ? store.markFailed(id, "prop", { code: "X", message: "y" })
              : store.goLive(id, deleted.epoch, "prop");
            await expect(call).rejects.toThrow();
          }
          await expect(store.get(id)).rejects.toThrow(MonitorNotFoundError);
          await expect(store.readAssociations(id, 0n, 10)).rejects.toThrow(MonitorNotFoundError);
          expect((await store.listActive(1000)).map((m) => m.id)).not.toContain(id);
          expect((await store.listAll(1000)).map((m) => m.id)).not.toContain(id);
        }

        const final = (await store.getIncludingDeleted(id))!;
        expect(final.state).toBe("deleted");
        expect(final.epoch).toBe(deleted.epoch);
      }),
      { numRuns: 8 },
    );
  }, 300_000);
});
