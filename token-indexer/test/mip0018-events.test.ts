/**
 * MIP-0018 events from the archived raw transactions (project 00026, sub-plan B2; spec FR-004, FR-010; Q4 (c), Q15):
 * the scan's event log — order, zero extension, classification — on the recorded Stagenet ranges of sub-plan D1 (IDX
 * 714485–715183, U1 715402–715433) and on synthetic multi-intent transactions, and the test cross-check against the
 * indexer's recorded `contractEvents`.
 *
 * Expected classifications: the reference repository (read-only, midnight-experiments/mip-0018 @ daec1f1):
 * `deployments/stagenet/cases/C07/expect/<step>.json` and `C08/expect/emit-two.json` (result and reason per event),
 * `cases/{C07,C08}/expected.json` (`counts`), `cases/IDX/index/index-state.json` (35 events named
 * `mip-0018:token-metadata[v1]`: position, result, reason, payload — compared position by position on 2026-10-03, all
 * equal; the accepted and rejected positions are listed below). The C10 payload is MIP Appendix A (A1).
 */
import { Event, Transaction } from "@midnightntwrk/ledger-v9";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { type ArchiveTape, startFakeChain } from "../../test/integration/fixtures/stagenet-archive/fake-chain-server.js";
import { loadContractEvents, loadRangeTape } from "../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import { eventCounts, listEvents, type LoggedEvent } from "../mip0018/events.ts";
import { Mip0018Scanner } from "../mip0018/scan.ts";
import { decodePayload, EVENT_NAME, encodePayload, record, toHex } from "../vendor/mip0018/codec/src/index.ts";
import { decodeSynthetic, putSyntheticBlocks, type SynthArchivedTx, type SynthLog } from "./helpers/synthetic-archive.ts";

const NET = "stagenet";

const CONTRACT = {
  C01: "98a90519", C02: "0ee5f319", C03: "a3df5260", C04: "86acf80f", C05: "f2d1b6eb", C06: "9d93b919", C07: "23aa27cb",
  C08: "65553c65", C10: "048ec49a", U1: "11010832", bridgeA: "1df4ce25", bridgeB: "c2d47266",
} as const;

/** C07: one raw-emitter transaction per step (height → [step, result, reason]); `C07/expect/<step>.json`. */
const C07_STEPS: Record<number, [string, "accept" | "reject" | "ignore", string | undefined]> = {
  714891: ["A2a", "accept", undefined], 714899: ["R1", "reject", "no-records"], 714907: ["A2b", "accept", undefined],
  714915: ["R2a", "reject", "vallen-out-of-bounds"], 714923: ["A3a", "accept", undefined], 714931: ["R3a", "reject", "nonzero-padding"],
  714942: ["A3b", "accept", undefined], 714949: ["R3b", "reject", "nonzero-padding"], 714956: ["A3c", "accept", undefined],
  714964: ["R4a", "reject", "bad-kind"], 714972: ["A4b", "accept", undefined], 714980: ["R5a", "reject", "invalid-utf8"],
  714988: ["A5a", "accept", undefined], 714996: ["R5e", "reject", "invalid-uri"], 715004: ["A5b", "accept", undefined],
  715012: ["R5h", "reject", "bad-null-length"], 715019: ["A5c", "accept", undefined], 715026: ["R6b", "reject", "reserved-valtype"],
  715033: ["I1a", "ignore", "other-name"], 715041: ["I1b", "ignore", "other-name"], 715049: ["I2a", "ignore", "other-name"],
  715063: ["I2b", "ignore", "other-name"],
};

/** The reference IDX scan's 35 v1-named events: accepted positions (height/tx/event) and rejected ones with reason. */
const IDX_ACCEPTED = [
  "714501/0/0", "714564/0/0", "714624/0/0", "714663/0/0", "714663/0/1", "714663/0/2", "714696/0/0", "714703/0/0", "714712/0/0",
  "714796/0/0", "714804/0/0", "714813/0/0", "714827/0/0", "714835/0/0", "714891/0/0", "714907/0/0", "714923/0/0", "714942/0/0",
  "714956/0/0", "714972/0/0", "714988/0/0", "715004/0/0", "715019/0/0", "715109/0/0", "715177/0/0",
];
const IDX_REJECTED = [
  "714899/0/0:no-records", "714915/0/0:vallen-out-of-bounds", "714931/0/0:nonzero-padding", "714949/0/0:nonzero-padding",
  "714964/0/0:bad-kind", "714980/0/0:invalid-utf8", "714996/0/0:invalid-uri", "715012/0/0:bad-null-length",
  "715026/0/0:reserved-valtype", "715109/0/1:reserved-valtype",
];

const V1 = toHex(EVENT_NAME);
const pos = (e: LoggedEvent): string => `${e.height}/${e.txIndex}/${e.eventIndex}`;

describe("MIP-0018 events from raw transactions (00026 B2)", () => {
  let container: StartedPostgreSqlContainer;
  const clients: UmbraDBSql[] = [];
  let counter = 0;
  const ranges: Record<string, { sql: UmbraDBSql; mip: string }> = {};

  async function fresh(prefix: string): Promise<{ sql: UmbraDBSql; archive: string; mip: string }> {
    const n = counter++;
    const archive = `${prefix}_arch_${n}`;
    const mip = `${prefix}_mip_${n}`;
    const sql = createClient({ connectionString: container.getConnectionUri(), schema: mip });
    clients.push(sql);
    await bootstrapChainArchiveSchema(sql, archive);
    return { sql, archive, mip };
  }

  /** Archives a whole recorded range with the real sync (fake chain) and scans it. */
  async function archiveAndScan(name: string, tape: ArchiveTape, from: number, to: number): Promise<void> {
    const db = await fresh(name);
    const f = await startFakeChain(tape);
    try {
      const svc = new ChainArchiveSyncService({
        sql: db.sql, net: NET, schema: db.archive, node: { url: f.nodeUrl }, indexer: { url: f.indexerUrl },
        startHeight: from, endHeight: to, concurrency: 4, backoff: { jitter: false, baseDelayMs: 1, maxDelayMs: 5 },
      });
      expect((await svc.syncOnce({ maxBlocks: 1_000 })).reachedEnd).toBe(true);
    } finally {
      await f.close();
    }
    const s = new Mip0018Scanner({ sql: db.sql, network: NET, schema: db.mip, archiveSchema: db.archive });
    await s.bootstrap();
    expect((await s.scanOnce({ maxBlocks: 1_000 })).toHeight).toBe(to);
    ranges[name] = { sql: db.sql, mip: db.mip };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await archiveAndScan("idx", loadRangeTape("idx"), 714485, 715183);
    await archiveAndScan("u1", loadRangeTape("u1"), 715402, 715433);
  }, 300_000);

  afterAll(async () => {
    for (const c of clients) await c.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  const events = (range: "idx" | "u1", filter: Parameters<typeof listEvents>[2] = {}) =>
    listEvents(ranges[range]!.sql, NET, filter, ranges[range]!.mip);
  const fullAddress = async (prefix: string): Promise<string> =>
    [...new Set([...(await events("idx")), ...(await events("u1"))].map((e) => e.contractAddress))].find((a) => a.startsWith(prefix))!;

  it("[[mip0018.events.classification]] every Misc event of the recorded ranges is stored with its classification: C07 9/9/4 step by step, C08 1/1/0, the reference IDX scan's 35 v1 events (25 accepted, 10 rejected) position by position, other names ignored", async () => {
    const idx = await events("idx");
    expect(idx).toHaveLength(49);
    expect(idx.every((e) => e.eventType === "Misc" && e.name.length === 64 && e.payload.length === 512)).toBe(true);
    // 45 events come from guaranteed transcripts; another user's contract logs 4 from fallible transcripts.
    const fallible = idx.filter((e) => e.phase === "fallible");
    expect(fallible).toHaveLength(4);
    expect(fallible.every((e) => e.contractAddress.startsWith(CONTRACT.bridgeB))).toBe(true);
    const v1 = idx.filter((e) => e.name === V1);
    expect(v1.filter((e) => e.classification === "accept").map(pos)).toEqual(IDX_ACCEPTED);
    expect(v1.filter((e) => e.classification === "reject").map((e) => `${pos(e)}:${e.reason}`)).toEqual(IDX_REJECTED);
    expect(v1).toHaveLength(35);
    // Every other name is ignored (14: C07's four I-steps, and another user's bridge contracts' own Misc events).
    expect(idx.filter((e) => e.name !== V1).every((e) => e.classification === "ignore" && e.reason === "other-name")).toBe(true);
    expect(idx.filter((e) => e.name !== V1)).toHaveLength(14);
    // Accepted events carry their identity header; others do not.
    for (const e of idx) expect(e.classification === "accept").toBe(e.domainSep !== undefined && e.kind !== undefined);

    const counts: Record<string, { events: number; accepted: number; rejected: number; ignored: number }> = {};
    for (const [c, prefix] of Object.entries(CONTRACT)) {
      const range = c === "U1" ? "u1" : "idx";
      counts[c] = await eventCounts(ranges[range]!.sql, NET, await fullAddress(prefix), ranges[range]!.mip);
    }
    expect(counts).toEqual({
      C01: { events: 1, accepted: 1, rejected: 0, ignored: 0 }, C02: { events: 1, accepted: 1, rejected: 0, ignored: 0 },
      C03: { events: 1, accepted: 1, rejected: 0, ignored: 0 }, C04: { events: 3, accepted: 3, rejected: 0, ignored: 0 },
      C05: { events: 3, accepted: 3, rejected: 0, ignored: 0 }, C06: { events: 5, accepted: 5, rejected: 0, ignored: 0 },
      C07: { events: 22, accepted: 9, rejected: 9, ignored: 4 }, C08: { events: 2, accepted: 1, rejected: 1, ignored: 0 },
      C10: { events: 1, accepted: 1, rejected: 0, ignored: 0 }, U1: { events: 1, accepted: 1, rejected: 0, ignored: 0 },
      bridgeA: { events: 6, accepted: 0, rejected: 0, ignored: 6 }, bridgeB: { events: 4, accepted: 0, rejected: 0, ignored: 4 },
    });

    const c07 = await events("idx", { contractAddress: await fullAddress(CONTRACT.C07) });
    expect(Object.fromEntries(c07.map((e) => [e.height, [C07_STEPS[e.height]![0], e.classification, e.reason]]))).toEqual(C07_STEPS);
    const c08 = await events("idx", { contractAddress: await fullAddress(CONTRACT.C08) });
    expect(c08.map((e) => [pos(e), e.classification, e.reason ?? null])).toEqual([["715109/0/0", "accept", null], ["715109/0/1", "reject", "reserved-valtype"]]);
    const u1 = await events("u1");
    expect(u1.map((e) => [pos(e), e.classification, e.kind])).toEqual([["715433/0/0", "accept", 1]]);
  }, 120_000);

  it("[[mip0018.events.order]] MIP order within a transaction: recorded C04 (kinds 1, 2, 3 as emitted) and C08 (valid then malformed); synthetic intents and segments: guaranteed parts by ascending segment, then successful fallible segments; failed segments and FAILURE transactions add nothing", async () => {
    const c04 = await events("idx", { contractAddress: await fullAddress(CONTRACT.C04) });
    expect(c04.map((e) => [pos(e), e.kind])).toEqual([["714663/0/0", 1], ["714663/0/1", 2], ["714663/0/2", 3]]);
    expect(new Set(c04.map((e) => e.segment)).size).toBe(1);

    // Synthetic: segment 9 inserted before segment 4; guaranteed and fallible logs; a non-Misc log; another name;
    // `[v2]`; data longer than 288 bytes (undecodable, ignored).
    const A = "a7".repeat(32);
    const DS = new Uint8Array(32).fill(0x22);
    const named = (name: Uint8Array, label: string): SynthLog => {
      const payload = encodePayload({ domainSep: DS, kind: 3 }, [record.utf8("name", label)]);
      const data = Buffer.from([...name, ...payload]);
      let end = data.length;
      while (end > 0 && data[end - 1] === 0) end--; // the ledger drops the item's trailing zero bytes
      return { data: data.subarray(0, end).toString("hex") };
    };
    const pad32 = (text: string): Uint8Array => { const b = new Uint8Array(32); b.set(Buffer.from(text)); return b; };
    const v1 = (label: string) => named(EVENT_NAME, label);
    const tx = (hash: string): SynthArchivedTx["tx"] => ({
      hash,
      intents: [
        { segment: 9, actions: [{ call: { address: A, entryPoint: "e9", guaranteed: { logs: [v1("g9a")] }, fallible: { logs: [v1("f9a")] } } }] },
        { segment: 4, actions: [{ call: { address: A, entryPoint: "e4",
          guaranteed: { logs: [v1("g4a"), named(pad32("someone-else:event[v1]"), "x"), { eventType: 2, data: "01" }, named(pad32("mip-0018:token-metadata[v2]"), "y")] },
          fallible: { logs: [v1("f4a"), { data: "01".repeat(289) }] } } }] },
      ],
    });
    const db = await fresh("order");
    await putSyntheticBlocks(db.sql, db.archive, NET, 500, [
      [{ tx: tx("c1".repeat(32)), result: "partial_success", segments: [{ id: 4, success: true }, { id: 9, success: false }] },
        { tx: tx("c2".repeat(32)), result: "failure" }],
      [{ tx: tx("c3".repeat(32)), result: "success" }],
    ]);
    const s = new Mip0018Scanner({ sql: db.sql, network: NET, schema: db.mip, archiveSchema: db.archive, decode: decodeSynthetic });
    await s.bootstrap();
    expect(await s.scanOnce()).toMatchObject({ scannedBlocks: 2, events: 6 + 7 });
    const label = (e: LoggedEvent): string => {
      if (e.classification !== "accept") return `${e.classification}:${e.reason}`;
      const d = decodePayload(Buffer.from(e.payload, "hex"));
      return d.ok ? Buffer.from(d.records[0]!.value).toString("utf8") : "?";
    };
    const got = await listEvents(db.sql, NET, {}, db.mip);
    expect(got.map((e) => `${e.height}/${e.txIndex}/${e.eventIndex} ${e.phase}/${e.segment} ${label(e)}`)).toEqual([
      "500/0/0 guaranteed/4 g4a", "500/0/1 guaranteed/4 ignore:other-name", "500/0/3 guaranteed/4 ignore:other-name",
      "500/0/4 guaranteed/9 g9a", "500/0/5 fallible/4 f4a", "500/0/6 fallible/4 ignore:undecodable-data: Misc data is 289 bytes (> 288)",
      "501/0/0 guaranteed/4 g4a", "501/0/1 guaranteed/4 ignore:other-name", "501/0/3 guaranteed/4 ignore:other-name",
      "501/0/4 guaranteed/9 g9a", "501/0/5 fallible/4 f4a", "501/0/6 fallible/4 ignore:undecodable-data: Misc data is 289 bytes (> 288)",
      "501/0/7 fallible/9 f9a",
    ]);
    expect(got.every((e) => e.contractAddress === A)).toBe(true);
    const undecodable = got.find((e) => e.reason?.startsWith("undecodable") === true)!;
    expect([undecodable.name, undecodable.payload]).toEqual(["", ""]);
  }, 120_000);

  it("[[mip0018.events.zero-extension]] C10's event, 127 bytes in the raw ledger item, is stored and decoded as MIP Appendix A's full 32 + 256 bytes", async () => {
    // The raw item really is trimmed: the value pushed before the `log` op of the recorded transaction.
    const block = loadRangeTape("idx").blocks.find((b) => b.height === 715177)!;
    const t = Transaction.deserialize("signature", "proof", "binding", Buffer.from(block.indexerBlock.transactions[0]!.raw.replace(/^0x/, ""), "hex")) as unknown as {
      intents: Map<number, { actions: Array<{ guaranteedTranscript?: { program: unknown[] } }> }>;
    };
    // Two intents: segment 1 without actions, segment 44633 with the publishMetadata call.
    expect([...t.intents.entries()].map(([seg, i]) => [seg, i.actions.length])).toEqual([[1, 0], [44633, 1]]);
    const program = t.intents.get(44633)!.actions[0]!.guaranteedTranscript!.program;
    const logAt = program.indexOf("log");
    const pushed = (program[logAt - 1] as { push: { value: { content: Array<{ content: { value: Uint8Array[] } }> } } }).push.value;
    expect(pushed.content[2]!.content.value[0]!.length).toBe(127);

    const [e] = await events("idx", { contractAddress: await fullAddress(CONTRACT.C10) });
    expect(e).toMatchObject({ height: 715177, classification: "accept", kind: 3, domainSep: "11".repeat(32), name: V1 });
    expect(e!.payload).toHaveLength(512);
    const d = decodePayload(Buffer.from(e!.payload, "hex"));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.contentEnd).toBe(95);
    expect(d.records.map((r) => [r.offset, Buffer.from(r.key).toString(), r.valType, r.valType === 2 ? r.integer : Buffer.from(r.value).toString()])).toEqual([
      [33, "name", 1, "Acme Token"], [50, "symbol", 1, "ACME"], [63, "decimals", 2, 6n], [75, "standards", 1, "mip-0004"],
    ]);
    expect(e!.payload.slice(190)).toBe("0".repeat(512 - 190)); // zero padding after offset 95
  }, 120_000);

  it("[[mip0018.events.contract-events-crosscheck]] raw-derived events equal the indexer's recorded contractEvents for every (transaction, called contract) pair: same events, same order, same bytes, same segment", async () => {
    const fixture = loadContractEvents();
    expect(fixture.pairs).toHaveLength(62);
    let compared = 0;
    for (const pair of fixture.pairs) {
      const range = pair.height >= 715402 ? "u1" : "idx";
      const ours = await events(range, { contractAddress: pair.contractAddress, txHash: pair.txHash });
      const theirs = pair.events.filter((x) => x.__typename === "MiscContractEvent");
      expect(theirs.map((x) => x.id), pair.txHash).toEqual([...theirs.map((x) => x.id)].sort((a, b) => a - b)); // indexer id order
      expect(ours.length, `${pair.height} ${pair.txHash} ${pair.contractAddress}`).toBe(theirs.length);
      ours.forEach((e, i) => {
        const x = theirs[i]!;
        expect(e.txIndex).toBe(pair.txPosition);
        // The indexer serves an EMPTY name/payload when the logged item is shorter than 32 bytes (research §4 P2).
        const item = (e.name + e.payload).replace(/(00)+$/, "");
        const view = item.length < 64 ? ["", ""] : [e.name, e.payload];
        expect([x.name?.replace(/^0x/, "").toLowerCase(), x.payload?.replace(/^0x/, "").toLowerCase()], pos(e)).toEqual(view);
        const ev = Event.deserialize(Buffer.from(x.raw.replace(/^0x/, ""), "hex")) as unknown as {
          source: { transactionHash: string; logicalSegment: number; physicalSegment: number };
          content: { tag: string; address?: string };
        };
        expect(ev.source.transactionHash.replace(/^0x/, "").toLowerCase()).toBe(e.txHash);
        expect(ev.source.physicalSegment, pos(e)).toBe(e.segment);
        expect(ev.source.logicalSegment).toBe(0);
        expect(ev.content.address?.replace(/^0x/, "").toLowerCase()).toBe(e.contractAddress);
        compared++;
      });
    }
    expect(compared).toBe(50);
    // Nothing of ours lies outside the recorded pairs (every stored event was compared).
    expect((await events("idx")).length + (await events("u1")).length).toBe(50);
  }, 120_000);
});
