import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DustConfig } from "../../shielded-monitor/node/dust/config.js";
import { DustStateMirror } from "../../shielded-monitor/node/dust/mirror.js";
import { LEDGER_BUILD_ID, loadLedger } from "../../shielded-monitor/offers.js";
import { readDustNodeFixtureEvents, readDustNodeFixtureMeta } from "./dust-fixture.js";
import { fakeDustDb } from "./dust-harness.js";

/**
 * `DustStateMirror` over the committed 5 000-event preprod fixture — no database, no network
 * (`spec/00016-dust-wallet-sync.md` Story 2, FR-011, FR-012, FR-014; plan 00016 task 2.4, D2.5b).
 *
 * ── The assertion that actually matters is the CUT, not the roots ───────────────────────────
 * A mirror built with the stock `replayRawEvents` reaches byte-identical roots to one built with
 * `replayRawEventsRetainingAll` (the fixture records that it was checked), so no root comparison
 * anywhere in this project can tell the two apart. What tells them apart is whether an arbitrary
 * range can be cut out of the result: measured on this very data, a stock mirror serves the gaps
 * around a uniformly random leaf in 0 of 200 draws, a retained one in 200 of 200 (question Q-12).
 *
 * So the load-bearing case below cuts single-leaf and gap ranges at random positions and applies
 * them to a blank state. The stock mirror is built alongside as a NEGATIVE control, so the test
 * fails if the ledger ever stops distinguishing the two and this suite quietly becomes vacuous.
 */

const meta = readDustNodeFixtureMeta();
const NET = "preprod";

function config(dir: string, overrides: Partial<DustConfig> = {}): DustConfig {
  return {
    databaseUrl: "postgres://unused@localhost/unused",
    snapshotDir: dir,
    pollMs: 10,
    snapshotEvery: 20_000,
    replayBatch: 1_000,
    ...overrides,
  };
}

/** Drives the mirror to the end of the fixture without a timer. */
async function pumpToTip(mirror: DustStateMirror): Promise<number> {
  let turns = 0;
  for (let i = 0; i < 100; i += 1) {
    const applied = await mirror.pumpOnce();
    turns += 1;
    if (applied === 0) break;
  }
  return turns;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ledger: any;
let events: Uint8Array[];
let root: string;

beforeAll(async () => {
  ledger = await loadLedger();
  events = readDustNodeFixtureEvents();
  root = await mkdtemp(path.join(tmpdir(), "umbra-00016-dust-"));
}, 120_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("DustStateMirror folds the table into two trees", () => {
  it("reaches the fixture's recorded roots in batches of 1 000, one query per batch", async () => {
    const dir = path.join(root, "roots");
    const db = fakeDustDb(events);
    const mirror = new DustStateMirror({ db, net: NET, config: config(dir), ledger });
    await mirror.start({ loops: false });
    try {
      await pumpToTip(mirror);
      const lease = mirror.acquire()!;
      try {
        expect(String(lease.state.commitmentTreeRoot())).toBe(
          meta.rootsAfterEveryFiveHundredDustEvents.at(-1)!.commitmentRoot,
        );
        expect(String(lease.state.generatingTreeRoot())).toBe(
          meta.rootsAfterEveryFiveHundredDustEvents.at(-1)!.generatingRoot,
        );
        expect(String(lease.state.commitmentTreeFirstFree)).toBe(meta.finalCommitmentFirstFree);
        expect(String(lease.state.generatingTreeFirstFree)).toBe(meta.finalGenerationFirstFree);
        expect(lease.applied.eventId).toBe(BigInt(meta.events));
      } finally {
        lease.release();
      }
      // 5 batches of 1 000 plus the turn that finds nothing left.
      expect(db.calls).toBe(6);
      expect(mirror.ready).toBe(true);
      expect(mirror.producer).toBe("ingest");
      expect(mirror.status().lastError).toBeNull();
    } finally {
      await mirror.stop();
    }
  }, 180_000);

  it("reaches the same roots at a different batch size — the boundaries are not load-bearing", async () => {
    const dir = path.join(root, "batches");
    const mirror = new DustStateMirror({
      db: fakeDustDb(events),
      net: NET,
      config: config(dir, { replayBatch: 333 }),
      ledger,
    });
    await mirror.start({ loops: false });
    try {
      await pumpToTip(mirror);
      const lease = mirror.acquire()!;
      try {
        expect(String(lease.state.commitmentTreeRoot())).toBe(
          meta.rootsAfterEveryFiveHundredDustEvents.at(-1)!.commitmentRoot,
        );
      } finally {
        lease.release();
      }
    } finally {
      await mirror.stop();
    }
  }, 180_000);

  it("[[shielded-monitor.dust.mirror-is-cuttable]] serves the segments around a random leaf, where a stock mirror cannot", async () => {
    // THE test of this phase. See the file header: roots cannot tell the two replays apart.
    const dir = path.join(root, "cuttable");
    const mirror = new DustStateMirror({ db: fakeDustDb(events), net: NET, config: config(dir), ledger });
    await mirror.start({ loops: false });

    // The negative control: the same events, the stock replay. If this ever becomes cuttable the
    // assertion below stops proving anything, and the test says so instead of passing quietly.
    const key = ledger.sampleDustSecretKey();
    const stockBlank = new ledger.DustLocalState(ledger.LedgerParameters.initialParameters().dust);
    const stockWithChanges = stockBlank.replayRawEvents(key, new Uint8Array(Buffer.concat(events.map((e) => Buffer.from(e)))));
    const stock = stockWithChanges.state;
    stockBlank.free();
    stockWithChanges.free();

    try {
      await pumpToTip(mirror);
      const lease = mirror.acquire()!;
      try {
        const firstFree = BigInt(lease.state.commitmentTreeFirstFree);
        expect(firstFree).toBeGreaterThan(100n);
        expect(String(stock.commitmentTreeRoot())).toBe(String(lease.state.commitmentTreeRoot()));

        let stockServable = 0;
        // Fixed draws rather than a seeded RNG: a flaky "random" failure in a Merkle-tree test is
        // an afternoon of bisecting, and these positions are chosen to be nothing special —
        // deliberately NOT powers of two, which are the only indices a collapsed tree can serve.
        const own = [17n, 1_234n, 2_001n, 3_333n, firstFree - 2n];
        for (const leaf of own) {
          // Exactly what spec §5.5 step 6 asks the node for: the two gaps around one own leaf.
          const cuts: { start: bigint; end: bigint }[] = [];
          if (leaf > 0n) cuts.push({ start: 0n, end: leaf - 1n });
          if (leaf + 1n < firstFree) cuts.push({ start: leaf + 1n, end: firstFree - 1n });

          const rebuilt = new ledger.DustLocalState(ledger.LedgerParameters.initialParameters().dust);
          let current = rebuilt;
          try {
            for (const cut of cuts) {
              const update = lease.state.collapsedCommitmentUpdate(cut.start, cut.end);
              // Through the wire encoding, as a wallet receives it: serialize + deserialize.
              const wire = Buffer.from(update.serialize() as Uint8Array).toString("hex");
              update.free();
              const decoded = ledger.DustStateMerkleTreeCollapsedUpdate.deserialize(
                new Uint8Array(Buffer.from(wire, "hex")),
              );
              const next = current.applyCommitmentCollapsedUpdate(decoded);
              decoded.free();
              current.free();
              current = next;
            }
            // The own leaf itself is never part of a segment; a wallet inserts it from its own
            // data. Here the mirror's own single-leaf cut stands in for it, which is the strictest
            // form of the property: every index is individually cuttable.
            const single = lease.state.collapsedCommitmentUpdate(leaf, leaf);
            const afterOwn = current.applyCommitmentCollapsedUpdate(single);
            single.free();
            current.free();
            current = afterOwn;
            expect(String(current.commitmentTreeRoot())).toBe(String(lease.state.commitmentTreeRoot()));
          } finally {
            current.free();
          }

          try {
            stock.collapsedCommitmentUpdate(leaf, leaf);
            stockServable += 1;
          } catch {
            /* expected: the stock mirror collapsed this leaf away */
          }
        }
        expect(stockServable).toBe(0);

        // The generating tree twin, once — same mechanism, smaller tree.
        const genFirstFree = BigInt(lease.state.generatingTreeFirstFree);
        const genLeaf = genFirstFree / 3n;
        const genBlank = new ledger.DustLocalState(ledger.LedgerParameters.initialParameters().dust);
        let genCurrent = genBlank;
        try {
          for (const cut of [
            { start: 0n, end: genLeaf - 1n },
            { start: genLeaf, end: genLeaf },
            { start: genLeaf + 1n, end: genFirstFree - 1n },
          ]) {
            const update = lease.state.collapsedGenerationUpdate(cut.start, cut.end);
            const next = genCurrent.applyGenerationCollapsedUpdate(update);
            update.free();
            genCurrent.free();
            genCurrent = next;
          }
          expect(String(genCurrent.generatingTreeRoot())).toBe(String(lease.state.generatingTreeRoot()));
        } finally {
          genCurrent.free();
        }
      } finally {
        lease.release();
      }
    } finally {
      stock.free();
      key.clear();
      key.free();
      await mirror.stop();
    }
  }, 300_000);

  it("keeps a leased state alive across a swap and frees it when the last reader lets go", async () => {
    const dir = path.join(root, "lease");
    const mirror = new DustStateMirror({
      db: fakeDustDb(events),
      net: NET,
      config: config(dir, { replayBatch: 500 }),
      ledger,
    });
    await mirror.start({ loops: false });
    try {
      await mirror.pumpOnce();
      const lease = mirror.acquire()!;
      const rootBefore = String(lease.state.commitmentTreeRoot());
      // Two more batches land while the lease is held. Without the lease count the mirror would
      // have freed this handle and the next line would throw `null pointer passed to rust`.
      await mirror.pumpOnce();
      await mirror.pumpOnce();
      expect(String(lease.state.commitmentTreeRoot())).toBe(rootBefore);
      expect(lease.applied.eventId).toBe(500n);
      const current = mirror.acquire()!;
      expect(current.applied.eventId).toBe(1_500n);
      expect(String(current.state.commitmentTreeRoot())).not.toBe(rootBefore);
      current.release();
      lease.release();
      // The retired handle is gone now; a second release must not free anything twice.
      expect(() => {
        lease.release();
      }).not.toThrow();
    } finally {
      await mirror.stop();
    }
  }, 180_000);
});

describe("DustStateMirror snapshots (FR-012)", () => {
  it("writes one every DUST_STATE_SNAPSHOT_EVERY events and resumes from it", async () => {
    const dir = path.join(root, "snapshot");
    const first = new DustStateMirror({
      db: fakeDustDb(events),
      net: NET,
      config: config(dir, { replayBatch: 1_000, snapshotEvery: 2_000 }),
      ledger,
    });
    await first.start({ loops: false });
    await first.pumpOnce();
    await first.pumpOnce();
    expect(first.status().snapshotEventId).toBe("2000");
    await first.stop();

    const snapshot = await readFile(path.join(dir, `${NET}.dust-state`));
    expect(snapshot.subarray(0, 10).toString("utf8")).toBe("UMBRADUST1");

    const db = fakeDustDb(events);
    const second = new DustStateMirror({ db, net: NET, config: config(dir), ledger });
    await second.start({ loops: false });
    try {
      const resumed = second.acquire()!;
      // `stop()` wrote a final snapshot at the last applied event, which is where the restart
      // picks up — not at zero, and not at the periodic snapshot.
      expect(resumed.applied.eventId).toBe(2_000n);
      resumed.release();
      await pumpToTip(second);
      const lease = second.acquire()!;
      try {
        expect(String(lease.state.commitmentTreeRoot())).toBe(
          meta.rootsAfterEveryFiveHundredDustEvents.at(-1)!.commitmentRoot,
        );
      } finally {
        lease.release();
      }
      // The resumed mirror read only the events after the snapshot.
      expect(db.calls).toBeLessThanOrEqual(5);
    } finally {
      await second.stop();
    }
  }, 300_000);

  it("refuses a snapshot from another net, another ledger build, or a corrupt file — and replays from zero", async () => {
    const cases: { name: string; write: (file: string) => Promise<void> }[] = [
      {
        name: "wrong-net",
        write: async (file) => {
          await writeSnapshot(file, { net: "devnet", ledgerVersion: LEDGER_BUILD_ID, eventId: "9", height: "9" });
        },
      },
      {
        name: "wrong-build",
        write: async (file) => {
          await writeSnapshot(file, { net: NET, ledgerVersion: "ledger-v8@8.1.0-syshash.1", eventId: "9", height: "9" });
        },
      },
      {
        name: "not-a-snapshot",
        write: async (file) => {
          await writeFile(file, Buffer.from("this is not a dust snapshot at all", "utf8"));
        },
      },
      {
        name: "truncated",
        write: async (file) => {
          await writeFile(file, Buffer.from("UMBRADUST1", "utf8"));
        },
      },
    ];

    for (const testCase of cases) {
      const dir = path.join(root, `refuse-${testCase.name}`);
      await rm(dir, { recursive: true, force: true });
      const { mkdir } = await import("node:fs/promises");
      await mkdir(dir, { recursive: true });
      await testCase.write(path.join(dir, `${NET}.dust-state`));

      const lines: string[] = [];
      const mirror = new DustStateMirror({
        db: fakeDustDb(events.slice(0, 200)),
        net: NET,
        config: config(dir, { replayBatch: 200 }),
        ledger,
        logger: (line) => lines.push(line),
      });
      await mirror.start({ loops: false });
      try {
        const lease = mirror.acquire()!;
        expect(lease.applied.eventId, testCase.name).toBe(0n);
        lease.release();
        // A refusal is LOUD: "the node took 40 minutes to start" must not be the only symptom.
        expect(lines.join("\n"), testCase.name).toContain("replaying from zero");
        await mirror.pumpOnce();
        expect(mirror.acquire()!.applied.eventId, testCase.name).toBe(200n);
      } finally {
        await mirror.stop();
      }
    }
  }, 300_000);

  async function writeSnapshot(file: string, header: Record<string, string>): Promise<void> {
    const blank = new ledger.DustLocalState(ledger.LedgerParameters.initialParameters().dust);
    const body = Buffer.from(blank.serialize() as Uint8Array);
    blank.free();
    const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(headerBytes.byteLength, 0);
    await writeFile(file, Buffer.concat([Buffer.from("UMBRADUST1", "utf8"), length, headerBytes, body]));
  }
});

describe("DustStateMirror reports what it cannot do", () => {
  it("says producer=none for a net the table holds nothing for", async () => {
    const dir = path.join(root, "no-producer");
    const mirror = new DustStateMirror({ db: fakeDustDb([]), net: NET, config: config(dir), ledger });
    await mirror.start({ loops: false });
    try {
      await mirror.pumpOnce();
      expect(mirror.producer).toBe("none");
      expect(mirror.ready).toBe(false);
      expect(mirror.status().applied).toStrictEqual({ eventId: "0", height: "0" });
    } finally {
      await mirror.stop();
    }
  }, 60_000);

  it("records a database fault as lastError and keeps the trees it already has", async () => {
    const dir = path.join(root, "db-down");
    const mirror = new DustStateMirror({
      db: fakeDustDb(events.slice(0, 600), { failAfter: 1 }),
      net: NET,
      config: config(dir, { replayBatch: 300 }),
      ledger,
    });
    await mirror.start({ loops: false });
    try {
      expect(await mirror.pumpOnce()).toBe(300);
      expect(await mirror.pumpOnce()).toBe(0);
      expect(mirror.status().lastError).toContain("connection terminated");
      const lease = mirror.acquire()!;
      // The trees survive the fault: a lookup route may be down while segments still answer.
      expect(lease.applied.eventId).toBe(300n);
      expect(String(lease.state.commitmentTreeFirstFree)).not.toBe("0");
      lease.release();
    } finally {
      await mirror.stop();
    }
  }, 120_000);
});

describe("the retained mirror's memory (SC-004, question Q-14)", () => {
  /**
   * The state's own serialized size, which is EXACT and needs no instrument.
   *
   * Phase 2F-bis fitted 97.7 B per leaf with R² = 0.9998 for a retained state, against a flat
   * ≈ 3.5 KiB for a collapsed one — so this number is also a second, independent witness that the
   * mirror retained its trees, and unlike the heap measurement it cannot be perturbed by a
   * garbage collection. It is what FR-012's snapshot costs on disk.
   */
  it("serializes to about 98 B per leaf, the retained-tree figure", async () => {
    const dir = path.join(root, "serialized");
    const mirror = new DustStateMirror({ db: fakeDustDb(events), net: NET, config: config(dir), ledger });
    await mirror.start({ loops: false });
    try {
      await pumpToTip(mirror);
      const lease = mirror.acquire()!;
      const leaves =
        Number(BigInt(lease.state.commitmentTreeFirstFree)) + Number(BigInt(lease.state.generatingTreeFirstFree));
      const bytes = (lease.state.serialize() as Uint8Array).byteLength;
      lease.release();
      const perLeaf = bytes / leaves;
      // eslint-disable-next-line no-console
      console.log(`[dust-mirror] serialized ${bytes} B over ${leaves} leaves = ${perLeaf.toFixed(1)} B/leaf`);
      expect(leaves).toBe(Number(meta.finalCommitmentFirstFree) + Number(meta.finalGenerationFirstFree));
      // A COLLAPSED state is flat ~3.5 KiB here, i.e. ~0.65 B/leaf. The lower bound is what makes
      // this a retain-all witness rather than a size cap.
      expect(perLeaf).toBeGreaterThan(50);
      expect(perLeaf).toBeLessThan(200);
    } finally {
      await mirror.stop();
    }
  }, 300_000);

  /**
   * The WebAssembly heap, measured the way Phase 2F-bis measured it — `process.memoryUsage()`
   * `external` — but in a CHILD PROCESS with `--expose-gc`.
   *
   * Not fussiness: taken in this process the number is meaningless and comes out NEGATIVE. Two
   * effects swamp the signal. The loader reads the 19 MB `.wasm` into a Buffer that `external`
   * counts and then discards — and V8 updates that accounting lazily, so even an explicit
   * `gc()` does not settle it until the next allocation-heavy moment, which here is the first
   * replay. And other cases in this file have already grown the same linear memory, which never
   * shrinks.
   *
   * So the measurement is a SLOPE taken inside a fresh process, between two points that are both
   * after the first batch: external and leaves after batch 1, external and leaves at the tip.
   * Everything the module load cost is on both sides of the subtraction and cancels; what is
   * left is what the retained trees cost per leaf. (Measured this way it lands within 15 % of
   * Phase 2F-bis's independently fitted 2 032 B/leaf, which is the cross-check.)
   *
   * RSS is reported alongside and deliberately NOT asserted: at 5 370 leaves it is dominated by
   * the module itself.
   */
  it("costs no more WASM heap per leaf than twice the figure Phase 2F-bis measured", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const repoRoot = new URL("../../", import.meta.url);
    const loader = new URL("vendor/ledger-v8-syshash/midnight_ledger_wasm_fs.js", repoRoot).href;
    const fixture = new URL("test/shielded-monitor/fixtures/dust-events-preprod-5000.bin", repoRoot).pathname;
    const script = `
      import { readFileSync } from "node:fs";
      const ledger = await import(${JSON.stringify(loader)});
      const blob = readFileSync(${JSON.stringify(fixture)});
      const events = [];
      for (let offset = 0; offset < blob.length; ) {
        const length = blob.readUInt32BE(offset);
        offset += 4;
        events.push(blob.subarray(offset, offset + length));
        offset += length;
      }
      const key = ledger.sampleDustSecretKey();
      let state = new ledger.DustLocalState(ledger.LedgerParameters.initialParameters().dust);
      const leavesOf = (s) => Number(s.commitmentTreeFirstFree) + Number(s.generatingTreeFirstFree);
      const replay = (from, to) => {
        const batch = Buffer.concat(events.slice(from, to));
        const withChanges = state.replayRawEventsRetainingAll(key, new Uint8Array(batch));
        const next = withChanges.state;
        state.free();
        withChanges.free();
        state = next;
      };
      // Three collections, not one: the first releases the ArrayBuffers, the second is what
      // actually settles V8's EXTERNAL accounting (measured -- one gc() leaves it 20 MB high),
      // and the third costs nothing and makes the point insensitive to that ordering.
      const settle = () => { globalThis.gc(); globalThis.gc(); globalThis.gc(); };
      replay(0, 1000);
      settle();
      const before = process.memoryUsage();
      const leavesBefore = leavesOf(state);
      for (let i = 1000; i < events.length; i += 1000) replay(i, i + 1000);
      settle();
      const after = process.memoryUsage();
      const leaves = leavesOf(state);
      const grown = leaves - leavesBefore;
      process.stdout.write(JSON.stringify({
        leaves,
        leavesMeasuredOver: grown,
        externalPerLeaf: (after.external - before.external) / grown,
        rssPerLeaf: (after.rss - before.rss) / grown,
      }));
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--expose-gc", "--input-type=module", "-e", script],
      { maxBuffer: 1024 * 1024 },
    );
    const measured = JSON.parse(stdout) as {
      leaves: number;
      leavesMeasuredOver: number;
      externalPerLeaf: number;
      rssPerLeaf: number;
    };
    // eslint-disable-next-line no-console
    console.log(
      `[dust-mirror] slope over ${measured.leavesMeasuredOver} of ${measured.leaves} leaves: ` +
        `external ${measured.externalPerLeaf.toFixed(0)} B/leaf, rss ${measured.rssPerLeaf.toFixed(0)} B/leaf ` +
        "(child process, --expose-gc)",
    );
    expect(measured.leaves).toBe(Number(meta.finalCommitmentFirstFree) + Number(meta.finalGenerationFirstFree));
    expect(measured.leavesMeasuredOver).toBeGreaterThan(3_000);
    // A retained tree costs real memory; a collapsed one costs almost none. The lower bound is
    // therefore a second retain-all witness, and the upper bound is Q-14's budget.
    expect(measured.externalPerLeaf).toBeGreaterThan(500);
    expect(measured.externalPerLeaf).toBeLessThan(2 * 2_032);
  }, 300_000);
});
