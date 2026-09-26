import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapTokenIndexSchema } from "../bootstrap.js";
import { pad32 } from "../color.js";
import { IndexerEventSource, drainPendingLookups } from "../ingest/events.js";
import {
  LEGACY_NAME_HEX, MIP_0018_NAME_HEX, encodeTokenMetadataUc1, splitIntoParts,
} from "../ingest/payload.js";
import { TokenScanner } from "../ingest/scan.js";
import { startFakeEventIndexer, type FakeEvent, type FakeEventIndexer } from "./helpers/fake-event-indexer.js";
import {
  fakeLedgerPerTransaction, fakeRawEvent, metadataPayloadHex, type FakeCallSpec, type FakeLedgerSpecs,
} from "./helpers/fake-ledger.js";
import { seedSyntheticTransaction } from "./helpers/synthetic-archive.js";

/**
 * Project 00024-01 task B2 — every normative vector of [Y] (`compact-multi-part-event` PR #1 @
 * `f2425f2`, `MIP-SPEC-DRAFT.md` "Testing"; spec 00024 US2, FR-005, SC-002) THROUGH THE SCANNER:
 *
 *   synthetic transaction (fake ledger: calls, intents, guaranteed/fallible `log` counts, the
 *   archived result and segment outcomes) → the real `TokenScanner` → the real `IndexerEventSource`
 *   over HTTP to a fake indexer serving each event's typed fields AND its `raw` → the barrier →
 *   `readPackages` → the fold → `token_metadata_events`.
 *
 * Each vector asserts the package groups, part counts, part orders (the parts' event ids), lengths
 * and bytes exactly as [Y] lists them, plus the phase this indexer records. The vectors' bytes are
 * not MIP-0018 declarations (`aa…` is kind 170), so every package is stored REJECTED — which is
 * the point: the transport result is independent of what the adopting protocol makes of it.
 *
 * `A = aa*256`, `B = bb*255 || 00`, `C = cc*256`, `Z = 00*256`; one chain, contract and name;
 * transaction `T1`, physical intent 7, unless a vector says otherwise.
 *
 * Also here: the two barrier regressions of audit F1 (`[[multipart-short-lookup-retry]]`,
 * `[[multipart-undecodable-raw-retry]]`).
 */

const NET = "undeployed";
const CONTRACT = "c0".repeat(32);
const T1 = "71".repeat(32);
const T2 = "72".repeat(32);

const A = Buffer.alloc(256, 0xaa);
const B = (() => { const b = Buffer.alloc(256, 0xbb); b[255] = 0; return b; })();
const C = Buffer.alloc(256, 0xcc);
const Z = Buffer.alloc(256);

/** What a source may deliver: the ledger trims trailing zeros, so a part can arrive short. */
const trimmedHex = (b: Buffer): string => {
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  return b.subarray(0, end).toString("hex");
};

interface EventSpec {
  id: number;
  segment: number;
  payload: Buffer;
  /** Serve the typed payload with its trailing zeros trimmed. */
  trimmed?: boolean;
  nameHex?: string;
  /** Replace `raw` with these hex bytes (an undecodable one, for the barrier tests). */
  rawHex?: string;
  /** Serve this TYPED name instead of the event's real one (`null`: no typed name at all) — the
   *  `raw` keeps the real name (01-D audit F4). */
  typedName?: string | null;
  /** Serve no typed payload (01-D audit F4). */
  omitPayload?: boolean;
  /** Serve no `raw` at all. */
  omitRaw?: boolean;
}

interface TxSpec {
  txHash: string;
  blockHeight: number;
  position?: number;
  result?: "success" | "partial_success" | "failure";
  segments?: { id: number; success: boolean }[];
  calls: FakeCallSpec[];
  /** In DELIVERY order — the fake indexer serves them exactly so. */
  events: EventSpec[];
}

interface PackageRow {
  tx: string;
  segment: number;
  parts: number;
  ids: number[];
  payload: string;
  phase: string;
}

describe("[Y] multi-part vectors and the complete-response barrier, through the scanner", () => {
  let container: StartedPostgreSqlContainer;
  let indexer: FakeEventIndexer;
  const open: UmbraDBSql[] = [];
  let counter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    indexer = await startFakeEventIndexer();
  }, 180_000);

  afterAll(async () => {
    while (open.length > 0) await open.pop()!.end({ timeout: 5 });
    await indexer?.close();
    await container?.stop();
  }, 60_000);

  afterEach(() => {
    indexer.events.clear();
    indexer.requests.length = 0;
    indexer.failNext = 0;
  });

  async function freshDb(): Promise<{ sql: UmbraDBSql; schema: string; archiveSchema: string }> {
    const id = counter++;
    const schema = `token_mpv_${id}`;
    const archiveSchema = `arch_mpv_${id}`;
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    open.push(sql);
    await bootstrapChainArchiveSchema(sql, archiveSchema);
    await bootstrapTokenIndexSchema(sql, { schema, net: NET });
    return { sql, schema, archiveSchema };
  }

  function serve(tx: TxSpec, events: EventSpec[] = tx.events): void {
    indexer.events.set(`${tx.txHash}:${CONTRACT}`, events.map((e): FakeEvent => {
      const nameHex = e.nameHex ?? MIP_0018_NAME_HEX;
      const typedName = e.typedName === undefined ? nameHex : (e.typedName ?? undefined);
      return {
        id: e.id, contractAddress: CONTRACT, txHash: tx.txHash, blockHeight: tx.blockHeight,
        ...(typedName === undefined ? {} : { nameHex: typedName }),
        ...(e.omitPayload === true ? {} : {
          payloadHex: e.trimmed === true ? trimmedHex(e.payload) : e.payload.toString("hex"),
        }),
        ...(e.omitRaw === true ? {} : {
          rawHex: e.rawHex ?? fakeRawEvent({
            txHash: tx.txHash, segment: e.segment, address: CONTRACT, nameHex,
            payloadHex: e.payload.toString("hex"),
          }),
        }),
      };
    }));
  }

  /** A fresh database with the transactions archived, and the scanner that will read them. */
  async function prepare(txs: TxSpec[]) {
    const db = await freshDb();
    const specs: Record<string, FakeLedgerSpecs> = {};
    for (const tx of txs) {
      specs[tx.txHash] = { calls: tx.calls };
      await seedSyntheticTransaction(db.sql, db.archiveSchema, NET, {
        txHash: tx.txHash, blockHeight: tx.blockHeight, position: tx.position ?? 0,
        result: tx.result ?? "success", segments: tx.segments ?? null, marker: tx.txHash,
      });
    }
    const ledger = fakeLedgerPerTransaction(specs);
    const source = new IndexerEventSource({ url: indexer.url, pageSize: 500 });
    const scanner = new TokenScanner({
      sql: db.sql, schema: db.schema, archiveSchema: db.archiveSchema, net: NET, eventSource: source, ledger,
    });
    return { db, scanner, ledger, source };
  }

  async function scan(txs: TxSpec[]) {
    const prepared = await prepare(txs);
    for (const tx of txs) serve(tx);
    const outcome = await prepared.scanner.scanOnce();
    return { ...prepared, outcome };
  }

  /** Makes every pending lookup due now, so the next drain retries it. */
  async function due(db: { sql: UmbraDBSql; schema: string }): Promise<void> {
    await db.sql`UPDATE ${db.sql(db.schema)}.pending_event_lookups SET next_attempt_at = now() - interval '1 second' WHERE net = ${NET}`;
  }

  async function packages(db: { sql: UmbraDBSql; schema: string }): Promise<PackageRow[]> {
    const rows = await db.sql<{
      tx_hash: Buffer; segment: number; parts: number; part_event_ids: string[]; payload: Buffer; phase: string;
    }[]>`
      SELECT tx_hash, segment, parts, part_event_ids::text[] AS part_event_ids, payload, phase
      FROM ${db.sql(db.schema)}.token_metadata_events WHERE net = ${NET}
      ORDER BY block_height, tx_position, event_id
    `;
    return rows.map((r) => ({
      tx: r.tx_hash.toString("hex"), segment: r.segment, parts: r.parts,
      ids: r.part_event_ids.map(Number), payload: r.payload.toString("hex"), phase: r.phase,
    }));
  }

  async function pendingRows(db: { sql: UmbraDBSql; schema: string }) {
    return db.sql<{ got_events: number; expected_events: number; last_error: string | null }[]>`
      SELECT got_events, expected_events, last_error FROM ${db.sql(db.schema)}.pending_event_lookups WHERE net = ${NET}`;
  }

  const hex = (...parts: Buffer[]): string => Buffer.concat(parts).toString("hex");
  const guaranteed = (segment: number, logOps: number): FakeCallSpec =>
    ({ address: CONTRACT, entryPoint: "emitPart", segment, guaranteed: { logOps } });
  const fallible = (segment: number, logOps: number): FakeCallSpec =>
    ({ address: CONTRACT, entryPoint: "emitPart", segment, guaranteed: { logOps: 0 }, fallible: { logOps } });

  // ── the 14 normative vectors ───────────────────────────────────────────────────────────────

  it("[[multipart-vector-empty-input]] empty filtered input: the contract logs only an event of a name that did not opt in → the lookup completes and no package exists", async () => {
    const other = Buffer.from(pad32("example:message[v1]")).toString("hex");
    const { db, outcome } = await scan([{
      txHash: T1, blockHeight: 100, calls: [guaranteed(7, 1)],
      events: [{ id: 10, segment: 7, payload: A, nameHex: other }],
    }]);
    expect(outcome).toMatchObject({ lookups: 1, lookupsShort: 0 });
    expect(await packages(db)).toEqual([]);
    expect(await pendingRows(db)).toEqual([]);
  }, 120_000);

  it("[[multipart-vector-all-zero-part]] all-zero part: Z, served fully trimmed → one part, payload Z, length 256", async () => {
    const { db } = await scan([{
      txHash: T1, blockHeight: 100, calls: [guaranteed(7, 1)],
      events: [{ id: 10, segment: 7, payload: Z, trimmed: true }],
    }]);
    const rows = await packages(db);
    expect(rows).toEqual([{ tx: T1, segment: 7, parts: 1, ids: [10], payload: hex(Z), phase: "guaranteed" }]);
    expect(Buffer.from(rows[0]!.payload, "hex")).toHaveLength(256);
  }, 120_000);

  it("[[multipart-vector-trailing-zero]] trailing zero: B, served trimmed to 255 bytes → one part, payload B, its final zero kept", async () => {
    const { db } = await scan([{
      txHash: T1, blockHeight: 100, calls: [guaranteed(7, 1)],
      events: [{ id: 10, segment: 7, payload: B, trimmed: true }],
    }]);
    const rows = await packages(db);
    expect(rows).toEqual([{ tx: T1, segment: 7, parts: 1, ids: [10], payload: hex(B), phase: "guaranteed" }]);
    expect(Buffer.from(rows[0]!.payload, "hex")[255]).toBe(0);
  }, 120_000);

  it("[[multipart-vector-guaranteed-multipart]] guaranteed multipart: guaranteed A then guaranteed B → one package A || B, length 512", async () => {
    const { db } = await scan([{
      txHash: T1, blockHeight: 100, calls: [guaranteed(7, 2)],
      events: [{ id: 10, segment: 7, payload: A }, { id: 11, segment: 7, payload: B }],
    }]);
    expect(await packages(db)).toEqual([
      { tx: T1, segment: 7, parts: 2, ids: [10, 11], payload: hex(A, B), phase: "guaranteed" },
    ]);
  }, 120_000);

  it("[[multipart-vector-fallible-success]] fallible success: fallible C then fallible B, both applied → one package C || B, fallible", async () => {
    const { db } = await scan([{
      txHash: T1, blockHeight: 100, result: "success", calls: [fallible(7, 2)],
      events: [{ id: 10, segment: 7, payload: C }, { id: 11, segment: 7, payload: B }],
    }]);
    expect(await packages(db)).toEqual([
      { tx: T1, segment: 7, parts: 2, ids: [10, 11], payload: hex(C, B), phase: "fallible" },
    ]);
  }, 120_000);

  it("[[multipart-vector-fallible-failure]] fallible failure: the fallible segment failed, no matching event was applied → no lookup, no package", async () => {
    const { db, outcome } = await scan([{
      txHash: T1, blockHeight: 100, result: "partial_success", segments: [{ id: 7, success: false }],
      calls: [fallible(7, 2)], events: [],
    }]);
    // The failed segment's log ops are not counted (00020 FR-002), so nothing is asked for at all.
    expect(outcome).toMatchObject({ lookups: 0, lookupsShort: 0 });
    expect(indexer.requests).toEqual([]);
    expect(await packages(db)).toEqual([]);
  }, 120_000);

  it("[[multipart-vector-same-group-separate-intentions]] same-group separate intentions: guaranteed A (message 1), then applied fallible B (message 2) → one package A || B, recorded as mixed (the publisher's error), not dropped", async () => {
    const { db } = await scan([{
      txHash: T1, blockHeight: 100, calls: [guaranteed(7, 1), fallible(7, 1)],
      events: [{ id: 10, segment: 7, payload: A }, { id: 11, segment: 7, payload: B }],
    }]);
    expect(await packages(db)).toEqual([
      { tx: T1, segment: 7, parts: 2, ids: [10, 11], payload: hex(A, B), phase: "mixed" },
    ]);
  }, 120_000);

  it("[[multipart-vector-mixed-phase-failure]] mixed-phase failure: guaranteed A applied, fallible B discarded (its segment failed) → one package A; the reader does not infer B", async () => {
    const { db } = await scan([{
      txHash: T1, blockHeight: 100, result: "partial_success", segments: [{ id: 7, success: false }],
      calls: [{ address: CONTRACT, entryPoint: "emitPart", segment: 7, guaranteed: { logOps: 1 }, fallible: { logOps: 1 } }],
      events: [{ id: 10, segment: 7, payload: A }],
    }]);
    expect(await packages(db)).toEqual([
      { tx: T1, segment: 7, parts: 1, ids: [10], payload: hex(A), phase: "guaranteed" },
    ]);
  }, 120_000);

  it("[[multipart-vector-upstream-order]] upstream order: delivered B, A with ledger order 1, 0 → one package A || B", async () => {
    const { db } = await scan([{
      txHash: T1, blockHeight: 100, calls: [guaranteed(7, 2)],
      events: [{ id: 11, segment: 7, payload: B }, { id: 10, segment: 7, payload: A }],
    }]);
    expect(await packages(db)).toEqual([
      { tx: T1, segment: 7, parts: 2, ids: [10, 11], payload: hex(A, B), phase: "guaranteed" },
    ]);
  }, 120_000);

  it("[[multipart-vector-equal-distinct-events]] equal distinct events: A, then A at another position → two parts A || A", async () => {
    const { db } = await scan([{
      txHash: T1, blockHeight: 100, calls: [guaranteed(7, 2)],
      events: [{ id: 10, segment: 7, payload: A }, { id: 11, segment: 7, payload: A }],
    }]);
    expect(await packages(db)).toEqual([
      { tx: T1, segment: 7, parts: 2, ids: [10, 11], payload: hex(A, A), phase: "guaranteed" },
    ]);
  }, 120_000);

  it("[[multipart-vector-multiple-logs-per-call]] multiple logs per call: ONE call emits A then C → two parts A || C", async () => {
    const { db } = await scan([{
      txHash: T1, blockHeight: 100, calls: [guaranteed(7, 2)],
      events: [{ id: 10, segment: 7, payload: A }, { id: 11, segment: 7, payload: C }],
    }]);
    expect(await packages(db)).toEqual([
      { tx: T1, segment: 7, parts: 2, ids: [10, 11], payload: hex(A, C), phase: "guaranteed" },
    ]);
  }, 120_000);

  it("[[multipart-vector-two-intents]] two intents: intent 7 emits A, intent 8 emits B → two packages, never joined", async () => {
    const { db } = await scan([{
      txHash: T1, blockHeight: 100, calls: [guaranteed(7, 1), guaranteed(8, 1)],
      events: [{ id: 10, segment: 7, payload: A }, { id: 11, segment: 8, payload: B }],
    }]);
    expect(await packages(db)).toEqual([
      { tx: T1, segment: 7, parts: 1, ids: [10], payload: hex(A), phase: "guaranteed" },
      { tx: T1, segment: 8, parts: 1, ids: [11], payload: hex(B), phase: "guaranteed" },
    ]);
  }, 120_000);

  it("[[multipart-vector-repeated-publication]] repeated publication: (T1, intent 7) and (T2, intent 7) each emit A → two packages despite equal bytes", async () => {
    const { db } = await scan([
      { txHash: T1, blockHeight: 100, calls: [guaranteed(7, 1)], events: [{ id: 10, segment: 7, payload: A }] },
      { txHash: T2, blockHeight: 101, calls: [guaranteed(7, 1)], events: [{ id: 20, segment: 7, payload: A }] },
    ]);
    expect(await packages(db)).toEqual([
      { tx: T1, segment: 7, parts: 1, ids: [10], payload: hex(A), phase: "guaranteed" },
      { tx: T2, segment: 7, parts: 1, ids: [20], payload: hex(A), phase: "guaranteed" },
    ]);
  }, 120_000);

  it("[[multipart-vector-no-hidden-framing]] no hidden framing: A and C intended as separate messages, from two calls in one intent → one package A || C", async () => {
    const { db } = await scan([{
      txHash: T1, blockHeight: 100, calls: [guaranteed(7, 1), guaranteed(7, 1)],
      events: [{ id: 10, segment: 7, payload: A }, { id: 11, segment: 7, payload: C }],
    }]);
    expect(await packages(db)).toEqual([
      { tx: T1, segment: 7, parts: 2, ids: [10, 11], payload: hex(A, C), phase: "guaranteed" },
    ]);
  }, 120_000);

  // ── the complete-response barrier (audit F1) ───────────────────────────────────────────────

  /** A real MIP-0018 declaration that needs exactly three parts: `metadata`, 700 bytes of JSON. */
  const DOCUMENT = JSON.stringify({ description: "n".repeat(649), website: "https://example.test" });
  const DOMAIN = Buffer.from(pad32("umbra:sneb18"));
  const THREE_PARTS = splitIntoParts(encodeTokenMetadataUc1({
    domainSep: new Uint8Array(DOMAIN), kindByte: 1, key: "metadata", valType: 3, value: DOCUMENT,
  })).map((p) => Buffer.from(p));

  async function declarationState(db: { sql: UmbraDBSql; schema: string }) {
    const [events, kv, tokens] = await Promise.all([
      db.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM ${db.sql(db.schema)}.token_metadata_events WHERE net = ${NET}`,
      db.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM ${db.sql(db.schema)}.token_metadata_kv WHERE net = ${NET}`,
      db.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM ${db.sql(db.schema)}.tokens WHERE net = ${NET} AND status <> 'builtin'`,
    ]);
    return { events: Number(events[0]!.n), kv: Number(kv[0]!.n), tokens: Number(tokens[0]!.n) };
  }

  async function onePackage(db: { sql: UmbraDBSql; schema: string }) {
    const rows = await db.sql<{
      part_event_ids: string[]; parts: number; applied: boolean; reject_reason: string | null;
      val_len: number; phase: string; segment: number;
    }[]>`
      SELECT part_event_ids::text[] AS part_event_ids, parts, applied, reject_reason, val_len, phase, segment
      FROM ${db.sql(db.schema)}.token_metadata_events WHERE net = ${NET}`;
    const token = await db.sql<{ metadata: unknown; status: string }[]>`
      SELECT metadata, status FROM ${db.sql(db.schema)}.tokens WHERE net = ${NET} AND status <> 'builtin'`;
    return { rows, token };
  }

  it("[[multipart-short-lookup-retry]] a first answer with 1 of 3 parts stores NOTHING of the package; the retry with all 3 stores exactly one complete, applied package and no rejection", async () => {
    expect(Buffer.byteLength(DOCUMENT)).toBe(700);
    expect(THREE_PARTS).toHaveLength(3);
    const tx: TxSpec = {
      txHash: T1, blockHeight: 100, calls: [guaranteed(5, 3)],
      events: THREE_PARTS.map((payload, i) => ({ id: 30 + i, segment: 5, payload })),
    };

    // ── the short answer: only the first part exists yet ────────────────────────────────────
    const { db, scanner, ledger, source } = await prepare([tx]);
    serve(tx, tx.events.slice(0, 1));
    const first = await scanner.scanOnce();
    expect(first).toMatchObject({ lookups: 1, lookupsShort: 1, eventsApplied: 0, eventsRejected: 0 });
    // The barrier: no history, no kv, no token — the truncated package was never stored …
    expect(await declarationState(db)).toEqual({ events: 0, kv: 0, tokens: 0 });
    // … and the pair waits in the retry queue.
    expect(await pendingRows(db)).toEqual([{ got_events: 1, expected_events: 3, last_error: null }]);

    // ── the retry: the indexer caught up; the whole answer, the whole package ───────────────
    serve(tx);
    await due(db);
    const drained = await drainPendingLookups(db.sql, db.schema, NET, source, { ledger });
    expect(drained).toMatchObject({ attempted: 1, completed: 1, stillShort: 0, applied: 1 });
    expect(await pendingRows(db)).toEqual([]);
    const after = await onePackage(db);
    expect(after.rows).toEqual([{
      part_event_ids: ["30", "31", "32"], parts: 3, applied: true, reject_reason: null,
      val_len: 700, phase: "guaranteed", segment: 5,
    }]);
    expect(after.token).toEqual([{ metadata: JSON.parse(DOCUMENT), status: "declared" }]);

    // ── a one-shot run over the complete answer ends in exactly the same state ──────────────
    const ref = await scan([tx]);
    expect(ref.outcome).toMatchObject({ lookups: 1, lookupsShort: 0, eventsApplied: 1 });
    expect(await onePackage(ref.db)).toEqual(after);
  }, 180_000);

  it("[[multipart-undecodable-raw-retry]] a later part whose `raw` does not decode stores NOTHING of the package; a valid retry stores exactly one complete package", async () => {
    const tx: TxSpec = {
      txHash: T1, blockHeight: 100, calls: [guaranteed(5, 3)],
      events: THREE_PARTS.map((payload, i) => ({
        id: 40 + i, segment: 5, payload, ...(i === 2 ? { rawHex: "deadbeef" } : {}),
      })),
    };
    const { db, outcome, ledger, source } = await scan([tx]);
    // Complete by count — 3 of 3 — but the third part's intent is unknowable, so nothing is read.
    expect(outcome).toMatchObject({ lookups: 1, lookupsShort: 1, eventsApplied: 0, eventsRejected: 0 });
    expect(await declarationState(db)).toEqual({ events: 0, kv: 0, tokens: 0 });
    const pending = await pendingRows(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ got_events: 3, expected_events: 3 });
    expect(pending[0]!.last_error).toMatch(/indexer event 42: `raw` does not decode/);

    // The same barrier holds for a `raw` that decodes but disagrees with the typed payload.
    serve({
      ...tx,
      events: tx.events.map((e, i) => ({
        ...e,
        rawHex: i !== 1 ? undefined : fakeRawEvent({
          txHash: T1, segment: 5, address: CONTRACT, nameHex: MIP_0018_NAME_HEX, payloadHex: C.toString("hex"),
        }),
      })),
    });
    await due(db);
    expect(await drainPendingLookups(db.sql, db.schema, NET, source, { ledger })).toMatchObject({ attempted: 1, completed: 0, stillShort: 1 });
    expect(await declarationState(db)).toEqual({ events: 0, kv: 0, tokens: 0 });
    expect((await pendingRows(db))[0]!.last_error).toMatch(/indexer event 41: the typed name\/payload disagree with `raw`/);

    // A valid answer: one complete package, applied, and the queue is empty.
    serve({ ...tx, events: tx.events.map((e) => ({ ...e, rawHex: undefined })) });
    await due(db);
    expect(await drainPendingLookups(db.sql, db.schema, NET, source, { ledger })).toMatchObject({ attempted: 1, completed: 1, applied: 1 });
    expect(await pendingRows(db)).toEqual([]);
    const after = await onePackage(db);
    expect(after.rows).toEqual([{
      part_event_ids: ["40", "41", "42"], parts: 3, applied: true, reject_reason: null,
      val_len: 700, phase: "guaranteed", segment: 5,
    }]);
    expect(after.token).toEqual([{ metadata: JSON.parse(DOCUMENT), status: "declared" }]);
  }, 180_000);

  it("[[multipart-lookup-integrity]] an answer that contradicts itself stores NOTHING, not even a draft-name event — a redelivered id counts once, two contents under one id, a part with no typed payload, a part whose typed fields (another name, none, or the draft's) hide an opted-in `raw`, a part that cannot be classified — and the valid retry stores exactly one complete package", async () => {
    const parts = THREE_PARTS.map((payload, i) => ({ id: 30 + i, segment: 5, payload }));
    const tx: TxSpec = { txHash: T1, blockHeight: 100, calls: [guaranteed(5, 3)], events: parts };
    const [p30, p31, p32] = parts as [EventSpec, EventSpec, EventSpec];
    const { db, scanner, ledger, source } = await prepare([tx]);
    const retry = async (events: EventSpec[]) => {
      serve(tx, events);
      await due(db);
      return drainPendingLookups(db.sql, db.schema, NET, source, { ledger });
    };
    const nothingStored = async () => expect(await declarationState(db)).toEqual({ events: 0, kv: 0, tokens: 0 });

    // (1) `[30, 30, 31]`: three deliveries, two events — SHORT, not complete (audit F3).
    serve(tx, [p30, p30, p31]);
    const first = await scanner.scanOnce();
    expect(first).toMatchObject({ lookups: 1, lookupsShort: 1, eventsApplied: 0, eventsRejected: 0 });
    await nothingStored();
    expect(await pendingRows(db)).toEqual([{ got_events: 2, expected_events: 3, last_error: null }]);

    // (2) one id with two contents: complete by distinct id, but conflicting → pending.
    expect(await retry([p30, p31, { ...p31, payload: C }, p32])).toMatchObject({ attempted: 1, completed: 0, stillShort: 1 });
    await nothingStored();
    expect((await pendingRows(db))[0]!.last_error).toMatch(/conflicting_delivery: indexer event 31 was delivered twice/);

    // (3) the third part with no typed payload (audit F4).
    expect(await retry([p30, p31, { ...p32, omitPayload: true }])).toMatchObject({ completed: 0, stillShort: 1 });
    await nothingStored();
    expect((await pendingRows(db))[0]!.last_error).toMatch(/incomplete_event: indexer event 32 is of an opted-in name but has no typed payload/);

    // (4) the third part's typed name says another name; its `raw` is the MIP-0018 part.
    const other = Buffer.from(pad32("example:message[v1]")).toString("hex");
    expect(await retry([p30, p31, { ...p32, typedName: other }])).toMatchObject({ completed: 0, stillShort: 1 });
    await nothingStored();
    expect((await pendingRows(db))[0]!.last_error).toMatch(/hidden_part: indexer event 32's `raw` is an opted-in event/);

    // (5) … or no typed name at all, the `raw` still telling.
    expect(await retry([p30, p31, { ...p32, typedName: null }])).toMatchObject({ completed: 0, stillShort: 1 });
    expect((await pendingRows(db))[0]!.last_error).toMatch(/hidden_part: indexer event 32's `raw`.*name absent/);

    // (6) no typed name and no `raw`: it cannot be classified, so it cannot be skipped.
    expect(await retry([p30, p31, { ...p32, typedName: null, omitRaw: true }])).toMatchObject({ completed: 0, stillShort: 1 });
    await nothingStored();
    expect((await pendingRows(db))[0]!.last_error).toMatch(/incomplete_event: indexer event 32 has no typed name and no decodable `raw`/);

    // (6b) round 2 (N1): the FIRST part served with the DRAFT's typed name — its `raw` is the
    //      MIP-0018 part — must not be folded as a draft declaration under id 30 (the id the
    //      package needs), neither from a short answer nor from a complete one …
    const draftTyped = { ...p30, typedName: LEGACY_NAME_HEX };
    expect(await retry([draftTyped])).toMatchObject({ completed: 0, stillShort: 1 });
    await nothingStored();
    expect((await pendingRows(db))[0]!.last_error).toMatch(/hidden_part: indexer event 30's `raw` is an opted-in event/);
    expect(await retry([draftTyped, p31, p32])).toMatchObject({ completed: 0, stillShort: 1 });
    await nothingStored();
    // … nor when a draft-typed copy of id 30 arrives before the correct one (a conflict).
    expect(await retry([draftTyped, p30, p31, p32])).toMatchObject({ completed: 0, stillShort: 1 });
    await nothingStored();
    expect((await pendingRows(db))[0]!.last_error).toMatch(/conflicting_delivery: indexer event 30 was delivered twice/);

    // (7) an identical redelivery of an id in an otherwise complete answer is harmless: one
    //     complete package, applied, and the queue empties (before the fix `[30,31,32,32]` was
    //     4 > 3 and stopped the scanner).
    expect(await retry([p30, p31, p32, p32])).toMatchObject({ attempted: 1, completed: 1, stillShort: 0, applied: 1 });
    expect(await pendingRows(db)).toEqual([]);
    const after = await onePackage(db);
    expect(after.rows).toEqual([{
      part_event_ids: ["30", "31", "32"], parts: 3, applied: true, reject_reason: null,
      val_len: 700, phase: "guaranteed", segment: 5,
    }]);
    expect(after.token).toEqual([{ metadata: JSON.parse(DOCUMENT), status: "declared" }]);

    // A one-shot scan of the valid answer ends in the same state.
    const ref = await scan([tx]);
    expect(ref.outcome).toMatchObject({ lookups: 1, lookupsShort: 0, eventsApplied: 1 });
    expect(await onePackage(ref.db)).toEqual(after);
  }, 180_000);

  it("[[multipart-hostile-values]] values the transport allows but a column cannot hold never stall the scanner — an 8 KiB incompressible name is stored and projected whole, a 15 000-level JSON `metadata` is kept as a flagged trait (`metadata_too_deep`), a 101-level one still projects, and the draft name's assemblies (130 and 1 509 levels) project unchanged — all in ONE scan batch that goes on to the next transaction", async () => {
    // A deterministic, incompressible, printable-ASCII name of 8 192 bytes (xorshift32): far past a
    // B-tree entry (~2.7 KB), which is what stalled the scanner before the 01-D audit fix F1.
    let x = 0x2545f491;
    const nameText = Array.from({ length: 8192 }, () => {
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      return String.fromCharCode(0x21 + (x % 94));
    }).join("");
    // 01-D audit F2's counterexample: valid JSON, 30 007 bytes, nested 15 001 deep.
    const deep = `{"x":${"[".repeat(15_000)}0${"]".repeat(15_000)}}`;
    expect(Buffer.byteLength(deep)).toBe(30_007);
    const shallow = `{"a":${"[".repeat(100)}0${"]".repeat(100)}}`;
    const declaration = (domain: string, key: string, valType: number, value: string): Buffer[] =>
      splitIntoParts(encodeTokenMetadataUc1({
        domainSep: new Uint8Array(pad32(domain)), kindByte: 1, key, valType, value,
      })).map((p) => Buffer.from(p));
    const tx = (txHash: string, blockHeight: number, parts: Buffer[], firstId: number): TxSpec => ({
      txHash, blockHeight, calls: [guaranteed(5, parts.length)],
      events: parts.map((payload, i) => ({ id: firstId + i, segment: 5, payload })),
    });
    const nameParts = declaration("umbra:hostile", "name", 1, nameText);
    const deepParts = declaration("umbra:hostile", "metadata", 3, deep);
    expect([nameParts.length, deepParts.length]).toEqual([33, 118]);
    // Round 2 (N2): the DRAFT name keeps its rules (FR-006). Its assemblies are bounded at 3 024
    // bytes, so they project at any depth they can reach — the auditors' 130-level document (265 B,
    // 2 parts) and the deepest one 3 024 bytes can hold (1 509 levels, 3 023 B, 16 parts).
    const draftDocument = (depth: number): string => `{"x":${"[".repeat(depth - 1)}0${"]".repeat(depth - 1)}}`;
    const d130 = draftDocument(130);
    const d1509 = draftDocument(1_509);
    expect([Buffer.byteLength(d130), Buffer.byteLength(d1509)]).toEqual([265, 3_023]);
    const draftTx = (txHash: string, blockHeight: number, domain: string, document: string, firstId: number): TxSpec => {
      const chunks = document.match(/[\s\S]{1,189}/g)!;
      return {
        txHash, blockHeight, calls: [guaranteed(5, chunks.length)],
        events: chunks.map((chunk, i) => ({
          id: firstId + i, segment: 5, nameHex: LEGACY_NAME_HEX,
          payload: Buffer.from(metadataPayloadHex({ domainSep: domain, kindByte: 1, key: `metadata/${i}`, value: chunk, valType: 3 }), "hex"),
        })),
      };
    };
    const txs = [
      tx(T1, 100, nameParts, 1_000),
      tx(T2, 101, deepParts, 2_000),
      tx("73".repeat(32), 102, declaration("umbra:hostile", "symbol", 1, "HOST"), 3_000),
      tx("74".repeat(32), 103, declaration("umbra:shallow", "metadata", 3, shallow), 4_000),
      draftTx("75".repeat(32), 104, "umbra:draft130", d130, 5_000),
      draftTx("76".repeat(32), 105, "umbra:draft1509", d1509, 6_000),
    ];
    expect([txs[4]!.events.length, txs[5]!.events.length]).toEqual([2, 16]);

    const { db, outcome } = await scan(txs);
    // One batch, six transactions, 4 packages + 18 draft events applied: nothing threw, nothing
    // rolled back.
    expect(outcome).toMatchObject({
      transactionsScanned: 6, lookups: 6, lookupsShort: 0, eventsApplied: 22, eventsRejected: 0,
      cursor: { height: 105, position: 0 },
    });
    expect(await pendingRows(db)).toEqual([]);

    const rows = await db.sql<{ domain_sep: Buffer; name: string | null; symbol: string | null; metadata: unknown; status: string }[]>`
      SELECT domain_sep, name, symbol, metadata, status
      FROM ${db.sql(db.schema)}.tokens WHERE net = ${NET} AND status <> 'builtin'`;
    const tokens = rows.map((r) => ({ ...r, domain: r.domain_sep.toString("utf8").replace(/\0+$/, "") }));
    expect(tokens.map((t) => t.domain).sort()).toEqual(["umbra:draft130", "umbra:draft1509", "umbra:hostile", "umbra:shallow"]);
    // The draft's deep assemblies project exactly as before the depth rule (FR-006).
    expect(tokens.find((t) => t.domain === "umbra:draft130")!.metadata).toEqual(JSON.parse(d130));
    expect(tokens.find((t) => t.domain === "umbra:draft1509")!.metadata).toEqual(JSON.parse(d1509));
    const hostile = tokens.find((t) => t.domain === "umbra:hostile")!;
    const shallowToken = tokens.find((t) => t.domain === "umbra:shallow")!;
    expect(hostile.name).toBe(nameText); // projected whole
    expect(hostile.symbol).toBe("HOST");
    expect(hostile.metadata).toBeNull(); // too deep to project …
    expect(hostile.status).toBe("declared");
    expect(shallowToken.metadata).toEqual(JSON.parse(shallow)); // … a 101-level document is fine

    const kv = await db.sql<{ key_text: string; val_len: number; projection_error: string | null; value: Buffer }[]>`
      SELECT key_text, val_len, projection_error, value FROM ${db.sql(db.schema)}.token_metadata_kv
      WHERE net = ${NET} AND domain_sep = ${Buffer.from(pad32("umbra:hostile"))} ORDER BY key_text`;
    expect(kv.map(({ key_text, val_len, projection_error }) => ({ key_text, val_len, projection_error }))).toEqual([
      { key_text: "metadata", val_len: 30_007, projection_error: "metadata_too_deep" },
      { key_text: "name", val_len: 8_192, projection_error: null },
      { key_text: "symbol", val_len: 4, projection_error: null },
    ]);
    // … and the deep document is kept byte for byte as the trait it is.
    expect(kv[0]!.value.toString("utf8")).toBe(deep);
  }, 180_000);
});
