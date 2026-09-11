import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { PgArchiveReadContract } from "../../src/postgres/archive-read-contract.js";
import { PgChainArchiveStore } from "../../src/postgres/chain-archive-store.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../../src/postgres/migrations/chain_archive/index.js";
import { bootstrapShieldedMonitorSchema } from "../../shielded-monitor/bootstrap.js";
import { LEDGER_BUILD_ID, MATCHING_RULE_VERSION } from "../../shielded-monitor/offers.js";
import { ShieldedMonitorScanner } from "../../shielded-monitor/scanner.js";
import { PgShieldedMonitorStore } from "../../shielded-monitor/store.js";
import { encodeViewingKey, parseViewingKey } from "../../shielded-monitor/viewing-key.js";
import { buildCorpus, type BuiltCorpus } from "../fixtures/shielded-monitor/build-corpus.js";
import { uniqueSchema } from "./helpers.js";

/**
 * The scanner's laws over randomly interleaved ARCHIVE GROWTH and SCANNER BATCHES
 * (organizer sub-plan 00009-03's "property: for random interleavings … the association set
 * equals the oracle and coverage is monotonic").
 *
 * Two laws, checked after EVERY operation rather than only at the end:
 *
 *  - **L1 — coverage is monotonic.** `scannedThrough` never decreases and never exceeds the
 *    archive tip. A scanner that could go backwards would re-scan history and duplicate matches;
 *    one that could run ahead would claim coverage over blocks it never read.
 *  - **L2 — the association set equals the oracle, restricted to covered heights.** The oracle
 *    is built from the FIXTURE MANIFEST's declared expectations (which transaction id is
 *    relevant to which key), not from the scanner — a property test whose oracle is the
 *    implementation proves only that the implementation equals itself.
 *
 * Real PostgreSQL and real ledger bytes, because both laws are about what a transaction commits
 * and which bytes decrypt. `numRuns` is deliberately small: each run writes a whole archive and
 * scans it, and the value here is covering interleavings a hand-written test would not think
 * of, not statistical volume.
 */

const NET = "prop_scan";

type Op =
  /** Append `blocks` new heights to the archive, each with a shape drawn from the corpus. */
  | { readonly kind: "append"; readonly blocks: number; readonly shapeSeed: number }
  /** Run one scanner batch of `batchBlocks` whole blocks. */
  | { readonly kind: "scan"; readonly batchBlocks: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({
    kind: fc.constant("append" as const),
    blocks: fc.integer({ min: 1, max: 3 }),
    shapeSeed: fc.integer({ min: 0, max: 1_000_000 }),
  }) },
  { weight: 5, arbitrary: fc.record({
    kind: fc.constant("scan" as const),
    batchBlocks: fc.integer({ min: 1, max: 4 }),
  }) },
);

/** The corpus transactions a generated height may carry, with the manifest's own expectation
 *  for key `K` attached. Chosen so the shapes include zero-match heights, multi-match heights,
 *  system transactions and empty blocks. */
interface ShapeChoice { id: string; matchesK: boolean; system: boolean }

describe("scanner laws over interleaved archive growth and scanning", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let corpus: BuiltCorpus;
  let choices: ShapeChoice[];
  const archiveSchema = uniqueSchema("prop_arc");
  const monitorSchema = uniqueSchema("prop_mon");
  let runCounter = 0;

  beforeAll(async () => {
    corpus = await buildCorpus();
    choices = corpus.manifest.transactions.map((t) => ({
      id: t.id,
      matchesK: (t.expected.K ?? []).length > 0,
      system: t.kind === "system",
    }));
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema: monitorSchema, maxConnections: 6 });
    await runMigrations(sql, { schema: archiveSchema, migrations: chainArchiveMigrations });
    await bootstrapShieldedMonitorSchema(sql, monitorSchema);
  }, 300_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  it("L1 coverage is monotonic and never exceeds the tip; L2 associations equal the manifest oracle over covered heights", async () => {
    // Non-vacuity counters. A property that generated only empty archives, or only heights the
    // scanner never reached, would pass L1 and L2 without testing anything; these are asserted
    // after the property and fail the test if the generator drifted into that shape.
    let totalAssociationsObserved = 0;
    let runsWithCoveredMatches = 0;
    let runsWithCoveredEmptyHeights = 0;

    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 4, maxLength: 14 }), async (ops) => {
        // Each run gets its own `net` row-scope, so runs never see each other's blocks and the
        // shared container is not re-migrated per run.
        const net = `${NET}_${runCounter++}`;
        const archiveStore = new PgChainArchiveStore(sql, archiveSchema);
        const archive = new PgArchiveReadContract(sql, archiveSchema);
        const store = new PgShieldedMonitorStore(sql, monitorSchema);
        await archiveStore.ensureArchiveInstanceId(net);

        const key = await parseViewingKey(encodeViewingKey(corpus.keyBytes.get("K")!, net), net);
        const monitor = await store.register({
          key, net, requestedStartHeight: 0n,
          matchingRuleVersion: MATCHING_RULE_VERSION, ledgerBuild: LEDGER_BUILD_ID, actor: "prop",
        });

        /** The oracle: every (height, position) the MANIFEST says is relevant to K. */
        const oracle: { height: number; position: number }[] = [];
        let tip = -1;
        let previousCoverage = -1n;
        const rawById = new Map(corpus.transactions.map((t) => [t.spec.id, t.rawBytes]));

        for (const op of ops) {
          if (op.kind === "append") {
            for (let i = 0; i < op.blocks; i++) {
              const height = tip + 1;
              // A tiny deterministic PRNG per height, so a failing counterexample replays.
              let state = (op.shapeSeed + height * 7919) >>> 0;
              const next = (): number => {
                state = (state * 1_664_525 + 1_013_904_223) >>> 0;
                return state / 0x1_0000_0000;
              };
              const txCount = Math.floor(next() * 4); // 0..3, so empty blocks occur
              const picked = Array.from({ length: txCount }, () => choices[Math.floor(next() * choices.length)]!);
              const blockHash = heightHash(net, height);
              await archiveStore.putBlockBundle({
                block: {
                  net, blockHash, height,
                  parentHash: height === 0 ? "0".repeat(64) : heightHash(net, height - 1),
                  stateRoot: heightHash(`${net}/state`, height),
                  extrinsicsRoot: heightHash(`${net}/ext`, height),
                  headerBytes: new TextEncoder().encode(`h/${net}/${height}`),
                  isCanonical: true, status: "canonical", finalized: true,
                  timestampMs: 1_754_395_200_000 + height * 6_000,
                },
                transactions: picked.map((choice, position) => ({
                  net, txHash: heightHash(`${net}/tx/${position}`, height), blockHeight: height,
                  blockHash, position,
                  kind: choice.system ? ("system" as const) : ("regular" as const),
                  protocolVersion: corpus.manifest.protocolVersion,
                  rawBytes: rawById.get(choice.id)!,
                })),
                bridgeObservations: [],
                watermark: { key: `sync_cursor:${net}`, value: { height } },
              });
              for (const [position, choice] of picked.entries()) {
                if (choice.matchesK) oracle.push({ height, position });
              }
              tip = height;
            }
          } else {
            const scanner = new ShieldedMonitorScanner(archive, store, {
              net, batchBlocks: op.batchBlocks,
            });
            const loaded = await store.get(monitor.id);
            const result = await scanner.scanBatch(loaded);
            expect(["advanced", "at-tip", "already-advanced"]).toContain(result.kind);
          }

          // ── The laws, after EVERY operation ───────────────────────────────────────────────
          const current = await store.get(monitor.id);
          const coverage = current.coverage.scannedThrough ?? -1n;
          expect(coverage, "L1: coverage must never go backwards").toBeGreaterThanOrEqual(previousCoverage);
          expect(coverage, "L1: coverage must never exceed the archive tip").toBeLessThanOrEqual(BigInt(tip));
          previousCoverage = coverage;

          const associations = await store.readAssociations(monitor.id, 0n, 1000);
          const expectedCovered = oracle.filter((o) => BigInt(o.height) <= coverage);
          expect(
            associations.map((a) => `${a.blockHeight}/${a.position}`),
            `L2: association set must equal the manifest oracle over heights <= ${coverage}`,
          ).toEqual(expectedCovered.map((o) => `${o.height}/${o.position}`));
        }

        const finalCoverage = (await store.get(monitor.id)).coverage.scannedThrough ?? -1n;
        const covered = oracle.filter((o) => BigInt(o.height) <= finalCoverage);
        totalAssociationsObserved += covered.length;
        if (covered.length > 0) runsWithCoveredMatches++;
        // A covered height that produced no match at all: "scanned and empty" really happened.
        const coveredHeights = new Set<number>();
        for (let h = 0; h <= Number(finalCoverage); h++) coveredHeights.add(h);
        for (const o of covered) coveredHeights.delete(o.height);
        if (coveredHeights.size > 0) runsWithCoveredEmptyHeights++;
      }),
      { numRuns: 8, endOnFailure: true },
    );

    expect(totalAssociationsObserved, "the property generated no matched transaction at all").toBeGreaterThan(0);
    expect(runsWithCoveredMatches, "no run ever scanned a height carrying a match").toBeGreaterThan(0);
    expect(runsWithCoveredEmptyHeights, "no run ever scanned a height with no match").toBeGreaterThan(0);
  }, 900_000);
});

/** A deterministic 32-byte hex hash for a (scope, height) pair. */
function heightHash(scope: string, height: number): string {
  let a = 0x811c_9dc5;
  for (const ch of `${scope}#${height}`) {
    a ^= ch.charCodeAt(0);
    a = Math.imul(a, 0x0100_0193) >>> 0;
  }
  return a.toString(16).padStart(8, "0").repeat(8);
}
