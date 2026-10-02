import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadLedgerV9 } from "../../chain-archive-sync/tx-replay-decoder.js";
import { MULTIPART_OPT_INS, readPackages } from "../ingest/packages.js";
import { LEGACY_NAME_HEX, MIP_0018_NAME_HEX } from "../ingest/payload.js";
import { decodeRawMiscEvent } from "../ingest/raw-event.js";
import {
  PUBLIC_INTERFACE_EVENT_NAME, PUBLIC_INTERFACE_NAME_HEX, PublicationPayloadError, decodePublication,
  isPublicInterfaceName,
} from "../interface/event.js";
import { isNewerPublication } from "../interface/store.js";
import { startFakeEventIndexer, type FakeEventIndexer } from "./helpers/fake-event-indexer.js";
import {
  InterfaceChain, NET, currentOf, partsOf, publicationPayload, publications,
} from "./helpers/interface-chain.js";

/**
 * Project 00024-02 task C2 — the public-interface event is recognised, read as a [Y] package,
 * decoded into [B]'s pointer, stored, and the newest publication of each contract is current by
 * derivation P2 (spec US1 scenarios 1–2, FR-010; plan `plans/00024-02-public-interface.md`).
 *
 * The golden is REAL: the one `publishBundle` event of [B]'s live Stagenet example
 * (`fixtures/interfaces/live-stagenet-event.json`, SOURCE.md), decoded with ledger-v9 rc.5.
 */

const LIVE = JSON.parse(readFileSync(new URL("./fixtures/interfaces/live-stagenet-event.json", import.meta.url), "utf8")) as {
  address: string;
  event: { id: number; raw: string; name: string; payload: string; transaction: { hash: string; block: { height: number } } };
};
const LIVE_SHA256 = "84678e4b3adbbb6c90446b208bcbbd0856f3723c04a2ceade498dd97226b3e8f";
/** [B]'s README, "historical Stagenet deployment". */
const LIVE_COMMITMENT = "4814bf93c6c0a6c81c7839f9be72c80365c2a4179d58171e7acd40906be30891";
const LIVE_URL = "https://compact-off-chain-circuits.pages.dev/public-interface/erc20-private/index.json";

const CONTRACT = "c1".repeat(32);
const C1 = Buffer.alloc(32, 0x11);
const C2 = Buffer.alloc(32, 0x22);

describe("public-interface events (C2)", () => {
  let container: StartedPostgreSqlContainer;
  let indexer: FakeEventIndexer;
  let chain: InterfaceChain;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    indexer = await startFakeEventIndexer();
    chain = new InterfaceChain(() => container.getConnectionUri(), () => indexer);
  }, 180_000);

  afterAll(async () => {
    await chain?.closeAll();
    await indexer?.close();
    await container?.stop();
  }, 60_000);

  afterEach(() => {
    indexer.events.clear();
    indexer.requests.length = 0;
  });

  it("[[interface-event-golden]] the name is pinned to the chain's bytes, the real Stagenet publication decodes to [B]'s commitment and URL, and a scanned publication is stored and current", async () => {
    // --- the name: pad(32, "mip-xxxx:public-interface[v1]"), as the live event carries it ---------
    expect(createHash("sha256").update(readFileSync(new URL("./fixtures/interfaces/live-stagenet-event.json", import.meta.url))).digest("hex"))
      .toBe(LIVE_SHA256);
    expect(PUBLIC_INTERFACE_EVENT_NAME).toBe("mip-xxxx:public-interface[v1]");
    expect(PUBLIC_INTERFACE_NAME_HEX).toBe("6d69702d787878783a7075626c69632d696e746572666163655b76315d000000");
    expect(PUBLIC_INTERFACE_NAME_HEX).toBe(LIVE.event.name);
    expect(isPublicInterfaceName(LIVE.event.name.toUpperCase())).toBe(true);
    // Opted into [Y] (UC-2) beside MIP-0018; the superseded draft name stays out (FR-006).
    expect(MULTIPART_OPT_INS).toContain(PUBLIC_INTERFACE_NAME_HEX);
    expect(MULTIPART_OPT_INS).toContain(MIP_0018_NAME_HEX);
    expect(MULTIPART_OPT_INS).not.toContain(LEGACY_NAME_HEX);

    // --- the real event: raw → EventSource + Misc value → one package → [B]'s pointer --------------
    const ledger = await loadLedgerV9();
    const decoded = decodeRawMiscEvent(
      ledger,
      { eventId: LIVE.event.id, rawHex: LIVE.event.raw, nameHex: LIVE.event.name, payloadHex: LIVE.event.payload },
      { txHash: LIVE.event.transaction.hash, address: LIVE.address },
    );
    expect(decoded.nameHex).toBe(PUBLIC_INTERFACE_NAME_HEX);
    expect(decoded.transactionHash).toBe(LIVE.event.transaction.hash);
    const { packages } = readPackages([{
      network: "stagenet", contract: LIVE.address, nameHex: decoded.nameHex, transactionHash: decoded.transactionHash,
      segment: decoded.physicalSegment, position: LIVE.event.id, payload: decoded.payload, phase: "guaranteed",
    }]);
    expect(packages).toHaveLength(1);
    expect(packages[0]!.positions).toEqual([LIVE.event.id]);
    const pointer = decodePublication(packages[0]!.payload);
    expect(Buffer.from(pointer.commitment).toString("hex")).toBe(LIVE_COMMITMENT);
    expect(pointer.url).toBe(LIVE_URL);
    expect(pointer.urlError).toBeUndefined();
    expect(pointer.parts).toBe(1);
    expect(Buffer.from(pointer.urlBytes).toString("utf8")).toBe(LIVE_URL);

    // --- the payload layout: commitment ‖ URL, zero padded; the URL may take several parts --------
    const oneLong = `https://b.example/${"u".repeat(224 - 18)}`; // exactly 224 bytes: still one part
    expect(decodePublication(publicationPayload(C1, oneLong))).toMatchObject({ url: oneLong, parts: 1 });
    const twoPart = `https://b.example/${"v".repeat(290 - 18)}`; // 290 bytes: two parts
    const two = decodePublication(publicationPayload(C1, twoPart));
    expect(two).toMatchObject({ url: twoPart, parts: 2, urlError: undefined });
    expect(Buffer.from(two.commitment).equals(C1)).toBe(true);
    // A URL whose last byte lands exactly at a part boundary keeps every byte.
    const edge = `https://b.example/${"w".repeat(480 - 18)}`; // 32 + 480 = 512
    expect(decodePublication(publicationPayload(C1, edge))).toMatchObject({ url: edge, parts: 2 });
    // Not text: kept as bytes only, with the reason — never a lossy URL.
    expect(decodePublication(publicationPayload(C1, Buffer.alloc(0)))).toMatchObject({ url: undefined, urlError: "url_empty" });
    expect(decodePublication(publicationPayload(C1, Buffer.from([0x68, 0x74, 0xff, 0x70])))).toMatchObject({
      url: undefined, urlError: "url_not_utf8",
    });
    const interiorNul = Buffer.concat([Buffer.from("https://b.example/a"), Buffer.from([0]), Buffer.from("junk")]);
    expect(decodePublication(publicationPayload(C1, interiorNul))).toMatchObject({
      url: undefined, urlError: "url_control_character",
    });
    expect(() => decodePublication(new Uint8Array(255))).toThrow(PublicationPayloadError);
    expect(() => decodePublication(new Uint8Array(0))).toThrow(PublicationPayloadError);

    // --- through the scanner: the live payload, published by a synthetic contract -----------------
    const db = await chain.freshDb("golden");
    const T = "a1".repeat(32);
    const livePayload = Buffer.from(LIVE.event.payload, "hex");
    const outcomes = await chain.scan(db, [{
      txHash: T, blockHeight: 50, position: 2, contract: CONTRACT,
      publications: [{ segment: 9, parts: [{ id: 700, payload: livePayload }], trimmed: true }],
    }]);
    expect(outcomes[0]).toMatchObject({ lookups: 1, lookupsShort: 0, interfacePublications: 1, eventsApplied: 0 });
    expect(await publications(db)).toEqual([{
      eventId: 700, partEventIds: [700], parts: 1, segment: 9, phase: "guaranteed", txHash: T,
      blockHeight: 50, txPosition: 2, commitment: LIVE_COMMITMENT, url: LIVE_URL, urlError: null, status: "pending",
    }]);
    expect(await currentOf(db, CONTRACT)).toEqual({ eventId: 700, publications: 1 });
    const stored = await db.sql<{ payload: Buffer; next_check_at: Date | null; level: number; checks: number }[]>`
      SELECT payload, next_check_at, level, checks FROM ${db.sql(db.schema)}.public_interface_events WHERE net = ${NET}`;
    // Every byte of the package kept (the source served it trimmed), due for its first check.
    expect(stored[0]!.payload.equals(livePayload)).toBe(true);
    expect(stored[0]!.next_check_at).not.toBeNull();
    expect(stored[0]!.level).toBe(0);
    expect(stored[0]!.checks).toBe(0);
    // Nothing of MIP-0018 was touched, and no lookup is pending.
    const other = await db.sql<{ md: string; pending: string }[]>`
      SELECT (SELECT count(*)::text FROM ${db.sql(db.schema)}.token_metadata_events WHERE net = ${NET}) AS md,
             (SELECT count(*)::text FROM ${db.sql(db.schema)}.pending_event_lookups WHERE net = ${NET}) AS pending`;
    expect(other[0]).toEqual({ md: "0", pending: "0" });
  }, 180_000);

  it("P2: the newest publication is current — block, then transaction position, then the FIRST part (not the last, not the segment)", async () => {
    expect(isNewerPublication({ blockHeight: 2, txPosition: 0, eventId: 1 }, { blockHeight: 1, txPosition: 9, eventId: 99 })).toBe(true);
    expect(isNewerPublication({ blockHeight: 1, txPosition: 1, eventId: 1 }, { blockHeight: 1, txPosition: 0, eventId: 99 })).toBe(true);
    expect(isNewerPublication({ blockHeight: 1, txPosition: 0, eventId: 5 }, { blockHeight: 1, txPosition: 0, eventId: 4 })).toBe(true);
    expect(isNewerPublication({ blockHeight: 1, txPosition: 0, eventId: 4 }, { blockHeight: 1, txPosition: 0, eventId: 4 })).toBe(false);

    // One transaction, two intents, interleaved: A (segment 3) = guaranteed id 60 + fallible id 63
    // (mixed), B (segment 5) = guaranteed ids 61, 62. The ledger emits every guaranteed part first.
    // B begins later (61 > 60) → current; a last-part rule would pick A (63).
    const a = partsOf(publicationPayload(C1, `https://a.example/${"a".repeat(300)}`));
    const b = partsOf(publicationPayload(C2, `https://b.example/${"b".repeat(300)}`));
    const db = await chain.freshDb("p2");
    await chain.scan(db, [{
      txHash: "b1".repeat(32), blockHeight: 60, contract: CONTRACT, publications: [
        { segment: 3, parts: [{ id: 60, payload: a[0]! }, { id: 63, payload: a[1]!, phase: "fallible" }] },
        { segment: 5, parts: [{ id: 61, payload: b[0]! }, { id: 62, payload: b[1]! }] },
      ],
    }]);
    const rows = await publications(db);
    expect(rows.map((r) => [r.eventId, r.partEventIds, r.phase, r.segment])).toEqual([
      [60, [60, 63], "mixed", 3], [61, [61, 62], "guaranteed", 5],
    ]);
    expect(await currentOf(db, CONTRACT)).toEqual({ eventId: 61, publications: 2 });

    // The reader meets packages in SEGMENT order; the newer one first must still win: segment 3 is
    // a fallible-only package (id 70, emitted after every guaranteed part), segment 5 guaranteed (65).
    const db2 = await chain.freshDb("p2b");
    await chain.scan(db2, [{
      txHash: "b2".repeat(32), blockHeight: 61, contract: CONTRACT, publications: [
        { segment: 3, parts: [{ id: 70, payload: publicationPayload(C1, "https://late.example/index.json"), phase: "fallible" }] },
        { segment: 5, parts: [{ id: 65, payload: publicationPayload(C2, "https://early.example/index.json") }] },
      ],
    }]);
    expect(await currentOf(db2, CONTRACT)).toEqual({ eventId: 70, publications: 2 });

    // Same block, two transactions: the LATER transaction wins although its event ids are lower;
    // then a later block wins over both.
    const db3 = await chain.freshDb("p2c");
    await chain.scan(db3, [
      { txHash: "c1".repeat(32), blockHeight: 70, position: 0, contract: CONTRACT,
        publications: [{ segment: 1, parts: [{ id: 900, payload: publicationPayload(C1, "https://x.example/1") }] }] },
      { txHash: "c2".repeat(32), blockHeight: 70, position: 1, contract: CONTRACT,
        publications: [{ segment: 1, parts: [{ id: 800, payload: publicationPayload(C2, "https://x.example/2") }] }] },
    ]);
    expect(await currentOf(db3, CONTRACT)).toEqual({ eventId: 800, publications: 2 });
    await chain.scan(db3, [
      { txHash: "c3".repeat(32), blockHeight: 71, position: 0, contract: CONTRACT,
        publications: [{ segment: 1, parts: [{ id: 10, payload: publicationPayload(C1, "https://x.example/3") }] }] },
    ]);
    expect(await currentOf(db3, CONTRACT)).toEqual({ eventId: 10, publications: 3 });
    // The ones it replaced are historical and are no longer scheduled once checked; pending ones
    // keep their one check.
    const due = await db3.sql<{ event_id: string; due: boolean }[]>`
      SELECT event_id::text, next_check_at IS NOT NULL AS due FROM ${db3.sql(db3.schema)}.public_interface_events
      WHERE net = ${NET} ORDER BY event_id`;
    expect(due).toEqual([{ event_id: "10", due: true }, { event_id: "800", due: true }, { event_id: "900", due: true }]);
  }, 240_000);

  it("a publication whose URL is not text is stored and current, and never stalls the scanner", async () => {
    const db = await chain.freshDb("badurl");
    const nul = Buffer.concat([Buffer.from("https://b.example/"), Buffer.from([0, 1, 2]), Buffer.from("x")]);
    const outcomes = await chain.scan(db, [
      { txHash: "d1".repeat(32), blockHeight: 80, contract: CONTRACT,
        publications: [{ segment: 1, parts: [{ id: 1, payload: publicationPayload(C1, nul) }] }] },
      { txHash: "d2".repeat(32), blockHeight: 81, contract: CONTRACT,
        publications: [{ segment: 1, parts: [{ id: 2, payload: publicationPayload(C2, Buffer.from([0xc3, 0x28])) }] }] },
      { txHash: "d3".repeat(32), blockHeight: 82, contract: CONTRACT,
        publications: [{ segment: 1, parts: [{ id: 3, payload: publicationPayload(C1, Buffer.alloc(0)) }] }] },
    ]);
    expect(outcomes.reduce((n, o) => n + o.transactionsScanned, 0)).toBe(3);
    expect((await publications(db)).map((r) => [r.eventId, r.url, r.urlError])).toEqual([
      [1, null, "url_control_character"], [2, null, "url_not_utf8"], [3, null, "url_empty"],
    ]);
    expect(await currentOf(db, CONTRACT)).toEqual({ eventId: 3, publications: 3 });
  }, 180_000);
});
