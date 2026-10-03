import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./fixtures/stagenet-archive/archive-digest.js";
import { callPairsOf, CONTRACT_EVENTS_QUERY, STAGENET_GENESIS } from "./fixtures/stagenet-archive/record-tape.js";
import {
  fixturePath, loadCaseIndex, loadContractEvents, loadManifest, loadRangeTape, loadTapeByName,
} from "./fixtures/stagenet-archive/stagenet-fixtures.js";
import { BLOCK_BY_HEIGHT_QUERY } from "../../chain-archive-sync/indexer-client.js";

/**
 * Project 00026, sub-plan D1 (spec FR-041/FR-042, Q11): the recorded Stagenet fixtures are what
 * their manifest says they are -- every file's SHA-256 and size, the two contiguous ranges (the
 * reference IDX scan 714485–715183 and U1's 715402–715433) with internally consistent node and
 * indexer answers, a `contractEvents` capture for every (transaction, called contract) pair, and a
 * case index whose every transaction is found in the tapes. No network, no database.
 */

const noPrefix = (h: string): string => (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();

describe("recorded Stagenet fixtures (00026 D1)", () => {
  it("[[stagenet.fixtures.manifest]] every fixture file matches the manifest's SHA-256 and size; provenance and size recorded", () => {
    const m = loadManifest();
    expect(m.format).toBe("umbradb-stagenet-fixtures/1");
    expect(m.network).toBe("stagenet");
    expect(m.genesisHash).toBe(STAGENET_GENESIS);
    expect(m.nodeUrl).toBe("https://rpc.stagenet.shielded.tools");
    expect(m.indexerUrl).toBe("https://indexer.stagenet.shielded.tools/api/v4/graphql");
    expect(m.queries.indexerBlockSha256).toBe(sha256Hex(BLOCK_BY_HEIGHT_QUERY)); // the sync still asks what was recorded
    expect(m.queries.contractEventsSha256).toBe(sha256Hex(CONTRACT_EVENTS_QUERY));
    expect(m.ranges.map((r) => [r.name, r.from, r.to])).toEqual([["idx", 714485, 715183], ["u1", 715402, 715433]]);

    for (const f of m.files) {
      const data = readFileSync(fixturePath(f.path));
      expect(data.length, f.path).toBe(f.bytes);
      expect(sha256Hex(data), f.path).toBe(f.sha256);
    }
    expect(m.totalBytes).toBe(m.files.reduce((n, f) => n + f.bytes, 0));
    expect(m.totalBytes).toBeLessThan(m.sizeTargetBytes); // D1's "< 1 MB" target, kept from growing

    // Exactly the listed data files (plus the manifest and the TypeScript helpers) live in the folder.
    const listed = new Set([...m.files.map((f) => f.path), "manifest.json"]);
    const present = readdirSync(fixturePath(".")).filter((name) => !name.endsWith(".ts"));
    expect(present.sort()).toEqual([...listed].sort());
    expect(new Set(m.files.map((f) => f.path))).toEqual(new Set([
      ...m.ranges.map((r) => r.file), m.contractEvents.file, m.caseIndex.file,
    ]));
  }, 60_000);

  it("[[stagenet.fixtures.tapes-consistent]] each range is contiguous and self-consistent, and every called contract of every transaction has its contractEvents capture", () => {
    const m = loadManifest();
    const tapes = m.ranges.map((r) => ({ range: r, tape: loadRangeTape(r.name) }));
    for (const { range, tape } of tapes) {
      expect(tape.genesisHash).toBe(STAGENET_GENESIS);
      expect(tape.heights).toEqual(Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from + i));
      expect(tape.blocks).toHaveLength(range.blocks);
      const results: Record<string, number> = {};
      let previous: string | undefined;
      for (const b of tape.blocks) {
        const header = b.nodeBlock.block.header;
        expect(parseInt(header.number, 16), String(b.height)).toBe(b.height);
        if (previous !== undefined) expect(noPrefix(header.parentHash), String(b.height)).toBe(previous); // one chain
        previous = noPrefix(b.blockHash);
        expect(noPrefix(b.indexerBlock.hash), String(b.height)).toBe(noPrefix(b.blockHash));
        expect(b.indexerBlock.height).toBe(b.height);
        const extrinsics = b.nodeBlock.block.extrinsics.map(noPrefix);
        for (const t of b.indexerBlock.transactions) {
          expect(t.__typename).toBe("RegularTransaction");
          expect(extrinsics.some((e) => e.includes(noPrefix(t.raw))), t.hash).toBe(true);
          const status = t.transactionResult?.status ?? "none";
          results[status] = (results[status] ?? 0) + 1;
        }
      }
      expect(results).toEqual(range.results);
      expect(tape.blocks.reduce((n, b) => n + b.indexerBlock.transactions.length, 0)).toBe(range.transactions);
    }
    expect(m.ranges.map((r) => r.transactions)).toEqual([69, 4]); // the reference IDX / U1 scans' counts

    const events = loadContractEvents();
    expect(events.query).toBe(CONTRACT_EVENTS_QUERY);
    expect(events.querySha256).toBe(m.queries.contractEventsSha256);
    const expectedPairs = tapes.flatMap(({ tape }) => callPairsOf(tape));
    expect(events.pairs.map(({ pages: _p, events: _e, ...pair }) => pair)).toEqual(expectedPairs);
    expect(events.pairs).toHaveLength(m.contractEvents.pairs);
    const byType: Record<string, number> = {};
    for (const p of events.pairs) {
      expect(p.pages).toBe(Math.ceil(p.events.length / events.pageSize) + 1); // paged until an empty page
      let lastId = -1;
      for (const e of p.events) {
        expect(e.id).toBeGreaterThan(lastId); // the indexer's order
        lastId = e.id;
        expect(noPrefix(e.transaction.hash)).toBe(p.txHash);
        expect(noPrefix(e.contractAddress)).toBe(p.contractAddress);
        expect(e.transaction.block).toEqual({ height: p.height, hash: expect.stringMatching(new RegExp(`^(0x)?${p.blockHash}$`, "i")) });
        byType[e.__typename] = (byType[e.__typename] ?? 0) + 1;
      }
    }
    expect(byType).toEqual(m.contractEvents.byType);
    expect(Object.values(byType).reduce((a, b) => a + b, 0)).toBe(m.contractEvents.events);

    // The former A2 tapes are slices of the ranges.
    expect(loadTapeByName("c04-714637-714663.tape.json").blocks.map((b) => b.height))
      .toEqual(Array.from({ length: 27 }, (_, i) => 714637 + i));
    expect(loadTapeByName("cases-sparse.tape.json").blocks.reduce((n, b) => n + b.indexerBlock.transactions.length, 0)).toBe(15);
  }, 60_000);

  it("[[stagenet.fixtures.case-index]] every reference case transaction is recorded at its height, and its observed indexer events are in the contractEvents capture", () => {
    const m = loadManifest();
    const index = loadCaseIndex();
    expect(index.source.repository).toBe("https://github.com/midnight-experiments/mip-0018");
    expect(index.source.commit).toBe("daec1f19747b09f4e245885ab0dd9ecc789a82ce");
    expect(Object.keys(index.cases).sort()).toEqual(["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10", "IDX", "U1"]);

    const tapes = new Map(m.ranges.map((r) => [r.name, loadRangeTape(r.name)]));
    const pairs = loadContractEvents().pairs;
    const included = (id: string): number => index.cases[id]!.steps.filter((s) => s.height !== undefined).length;
    expect(Object.fromEntries(Object.keys(index.cases).map((id) => [id, included(id)]))).toEqual({
      C01: 2, C02: 3, C03: 3, C04: 5, C05: 6, C06: 6, C07: 23, C08: 2, C09: 0, C10: 3, IDX: 0, U1: 4,
    });
    expect(index.cases.IDX!.scanRange).toEqual({ from: 714485, to: 715183, range: "idx" });
    expect(index.cases.U1!.scanRange).toEqual({ from: 715402, to: 715433, range: "u1" });
    expect(index.cases.C06!.steps.filter((s) => s.expectedAfter !== undefined).map((s) => [s.id, s.expectedAfter])).toEqual([
      ["publish", "expected-after-publish.json"], ["rename", "expected-after-rename.json"],
      ["withdraw", "expected-after-withdraw.json"], ["withdraw-again", "expected-after-withdraw-again.json"],
      ["revive", "expected-after-revive.json"],
    ]);

    let caseTransactions = 0;
    for (const [id, c] of Object.entries(index.cases)) {
      for (const s of c.steps) {
        if (s.height === undefined) continue;
        caseTransactions++;
        const block = tapes.get(s.range!)!.blocks.find((b) => b.height === s.height);
        expect(block, `${id}/${s.id}`).toBeDefined();
        expect(noPrefix(block!.blockHash)).toBe(s.blockHash);
        expect(noPrefix(block!.indexerBlock.transactions[s.txPosition!]!.hash)).toBe(s.txHash);
        expect(s.status).toBe("SUCCESS");
        if (s.observedEventIds !== undefined) {
          const captured = pairs.filter((p) => p.txHash === s.txHash && p.contractAddress === c.contract).flatMap((p) => p.events.map((e) => e.id));
          for (const eventId of s.observedEventIds) expect(captured, `${id}/${s.id}`).toContain(eventId);
        }
      }
      expect(c.heights).toEqual([...new Set(c.steps.flatMap((s) => (s.height === undefined ? [] : [s.height])))].sort((a, b) => a - b));
    }
    // Every recorded transaction is either a case transaction or listed as another user's.
    expect(caseTransactions + index.otherTransactions.length).toBe(m.ranges.reduce((n, r) => n + r.transactions, 0));
  }, 60_000);
});
