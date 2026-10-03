/**
 * Token activity (project 00026, sub-plan C2; owner Q3; spec FR-021, US5): the activity rows the MIP-0018 scan writes
 * per applied transaction, and the keyset-paginated reads the API serves.
 *
 * Data: the recorded Stagenet ranges of sub-plan D1 (`loadRangeTape("idx" | "u1")`, `case-index.json` — which
 * transaction belongs to which reference case step), archived by the real `chain-archive-sync` against the fake chain
 * server, and synthetic transactions (`helpers/synthetic-activity.ts`) for what Stagenet's recorded ranges do not show
 * (unshielded spends, contract inputs/outputs, fallible parts, failed segments, NIGHT UTXOs, DUST-tagged effects).
 * One Postgres 17 container for the file; one archive schema + one `mip0018` schema per scenario.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { type ArchiveTape, type FakeChain, startFakeChain } from "../../test/integration/fixtures/stagenet-archive/fake-chain-server.js";
import { loadCaseIndex, loadRangeTape } from "../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import {
  ACTIVITY_PAGE_MAX, type ActivityItem, ActivityDecodeError, activityForColor, ActivityQueryError, metadataTransactionsForContract,
  transactionActivity,
} from "../mip0018/activity.ts";
import { NIGHT_COLOR } from "../mip0018/applied-parts.ts";
import { walletAddress } from "../mip0018/bech32m.ts";
import { tokenColor } from "../mip0018/color.ts";
import { Mip0018Scanner } from "../mip0018/scan.ts";
import { EVENT_NAME, encodePayload, record } from "../vendor/mip0018/codec/src/index.ts";
import { putSyntheticBlocks, type SynthArchivedTx } from "./helpers/synthetic-archive.ts";
import {
  acceptedEvent, rejectedEvent, synthIntentHash, syntheticActivityTx, syntheticSeams, type SynthTxA, walletOf,
} from "./helpers/synthetic-activity.ts";

const NET = "stagenet";
const IDX = loadRangeTape("idx");
const CASES = loadCaseIndex();
const WALLET_1 = "mn_addr_stagenet1vw57646su9y5z6myarm93m6kcn62j97z0yma94lfkhmta6pz5h5q6utr3k";
const WALLET_1_HEX = "63a9ed5750e149416b64e8f658ef56c4f4a917c27937d2d7e9b5f6bee822a5e8";

const C03_CONTRACT = "a3df52605d8b7210aa3e5cdc82de4bb2911975bc42c1a68be77044723b705f21";
const C03_DS = "6d69702d303031383a6578616d706c653a756e736869656c6465640000000000";
const C03_COLOR = "8e01e39293a9e21ee2685da06ce487fffafbc1a982d53fcb1a72520f18518484";
/** `intentHash(0)` of the C03 mint's intent (segment 8801): the UTXO its guaranteed output became. */
const C03_UTXO_INTENT = "0c038f285af17a648225eafc62da19b51bbf11b317c63d64a376f85985e09260";
const C04_COLOR = "042399246139df031a4780c684df8eaecd48b7e03a195bfe986cf22766bcbc16";

/** Each IDX/U1 color → the reference case steps whose transactions make up its activity (mints + its contract's metadata). */
const COLOR_STEPS: Record<string, { color: string; steps: string[] }> = {
  C02: { color: "be34ef4b78717b031040bf625e04ee033106efae4c766915d3cac2b7fda8f11b", steps: ["mint", "publish"] },
  C03: { color: C03_COLOR, steps: ["mint", "publish"] },
  C04: { color: C04_COLOR, steps: ["mint-shielded", "mint-unshielded", "publish"] },
  "C05 gold": { color: "81db4eef83089c5403c6af29d926d57ee6b6359ff7dc291dd19cb4c3e9cf7aa1", steps: ["mint-gold", "publish-gold", "publish-silver", "publish-bronze"] },
  "C05 silver": { color: "8c74ec4a937d296f8234a2373812c2df3d962dba06dfe98cda390f9dea38491d", steps: ["mint-silver", "publish-gold", "publish-silver", "publish-bronze"] },
  U1: { color: "89a5559202e2d7c111150d84bbcae4c4beb56733373e1935ac74ce565f17ffb0", steps: ["mint", "upgrade:call"] },
};
const THIRD_PARTY_COLOR = "e5afe273bcb1252cfbc81ad6ca1caaafe22312c8c29f9b104a2fe3ead980bb2d";

const stepOf = (caseId: string, stepId: string) => {
  const s = CASES.cases[caseId]!.steps.find((x) => x.id === stepId);
  if (s?.txHash === undefined || s.height === undefined) throw new Error(`${caseId}/${stepId} has no recorded transaction`);
  return { txHash: s.txHash, height: s.height, txIndex: s.txPosition! };
};

const hex = (b: Buffer): string => b.toString("hex");

async function dump(sql: UmbraDBSql, schema: string): Promise<Record<string, unknown[]>> {
  const s = sql(schema);
  const norm = (rows: readonly Record<string, unknown>[]): unknown[] =>
    rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Buffer.isBuffer(v) ? hex(v) : typeof v === "bigint" ? v.toString() : v])));
  return {
    activity: norm(await sql`SELECT * FROM ${s}.mip0018_activity ORDER BY network, block_height, tx_index, item_index`),
    scan: norm(await sql`SELECT * FROM ${s}.mip0018_scan ORDER BY network`),
    mints: norm(await sql`SELECT * FROM ${s}.mip0018_mints ORDER BY network, block_height, tx_index, mint_index`),
    events: norm(await sql`SELECT * FROM ${s}.mip0018_events ORDER BY network, block_height, tx_index, event_index`),
    fields: norm(await sql`SELECT * FROM ${s}.mip0018_fields ORDER BY network, contract_address, domain_sep, kind, key`),
    withdrawals: norm(await sql`SELECT * FROM ${s}.mip0018_withdrawals ORDER BY network, contract_address, domain_sep, kind`),
    listed: norm(await sql`SELECT * FROM ${s}.mip0018_listed_events ORDER BY network, block_height, tx_index, event_index`),
  };
}

/** Every page of a listing (limit 500). */
async function all(read: (cursor?: string) => Promise<{ items: ActivityItem[]; nextCursor?: string }>): Promise<ActivityItem[]> {
  const out: ActivityItem[] = [];
  let cursor: string | undefined;
  do {
    const p = await read(cursor);
    out.push(...p.items);
    cursor = p.nextCursor;
  } while (cursor !== undefined);
  return out;
}

const txOrder = (items: ActivityItem[]): string[] => [...new Map(items.map((i) => [`${i.height}:${i.txIndex}`, i.txHash])).values()];

describe("MIP-0018 token activity (00026 C2)", () => {
  let container: StartedPostgreSqlContainer;
  const clients: UmbraDBSql[] = [];
  const fakes: FakeChain[] = [];
  const children: ChildProcess[] = [];
  let counter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 180_000);

  afterEach(async () => {
    for (const f of fakes.splice(0)) await f.close();
    for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  }, 60_000);

  afterAll(async () => {
    for (const c of clients) await c.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  async function fresh(prefix: string): Promise<{ sql: UmbraDBSql; archive: string; mip: string }> {
    const n = counter++;
    const archive = `${prefix}_arch_${n}`;
    const mip = `${prefix}_mip_${n}`;
    const sql = createClient({ connectionString: container.getConnectionUri(), schema: mip });
    clients.push(sql);
    await bootstrapChainArchiveSchema(sql, archive);
    return { sql, archive, mip };
  }

  async function archiveTape(db: { sql: UmbraDBSql; archive: string }, tape: ArchiveTape, from: number, to: number): Promise<void> {
    const f = await startFakeChain(tape);
    fakes.push(f);
    const svc = new ChainArchiveSyncService({
      sql: db.sql, net: NET, schema: db.archive, node: { url: f.nodeUrl }, indexer: { url: f.indexerUrl },
      startHeight: from, endHeight: to, concurrency: 4, backoff: { jitter: false, baseDelayMs: 1, maxDelayMs: 5 },
    });
    expect((await svc.syncOnce({ maxBlocks: 1_000 })).reachedEnd).toBe(true);
  }

  function scanner(db: { sql: UmbraDBSql; archive: string; mip: string }, extra: Partial<ConstructorParameters<typeof Mip0018Scanner>[0]> = {}): Mip0018Scanner {
    return new Mip0018Scanner({ sql: db.sql, network: NET, schema: db.mip, archiveSchema: db.archive, ...extra });
  }

  async function scanAll(s: Mip0018Scanner): Promise<void> {
    await s.bootstrap();
    for (;;) {
      const r = await s.scanOnce({ maxBlocks: 250 });
      if (r.scannedBlocks === 0 || r.reachedEnd) return;
    }
  }

  it("[[mip0018.activity.c03-mint]] C03's mint row shows wallet 1's Bech32m address; the UTXO it created and the metadata transaction follow in chain order", async () => {
    const db = await fresh("c03");
    await archiveTape(db, IDX, 714611, 714624);
    await scanAll(scanner(db));
    const mint = stepOf("C03", "mint");
    const publish = stepOf("C03", "publish");
    const page = await activityForColor(db.sql, NET, C03_COLOR, {}, db.mip);
    const at = { phase: "guaranteed", segment: 8801, color: C03_COLOR, amount: "1000000", direction: "in" } as const;
    expect(page).toEqual({
      contract: C03_CONTRACT,
      items: [
        { height: 714617, txIndex: mint.txIndex, itemIndex: 0, txHash: mint.txHash, role: "utxo-created", ...at, wallet: WALLET_1, utxo: { intentHash: C03_UTXO_INTENT, outputIndex: 0 } },
        { height: 714617, txIndex: mint.txIndex, itemIndex: 1, txHash: mint.txHash, role: "mint", ...at, contract: C03_CONTRACT, actionIndex: 0, entryPoint: { hex: "6d696e74", text: "mint" }, domainSep: C03_DS, kind: 2, wallet: WALLET_1 },
        { height: 714624, txIndex: publish.txIndex, itemIndex: 0, txHash: publish.txHash, role: "metadata-event", contract: C03_CONTRACT, events: { accepted: 1, rejected: 0, firstEventIndex: 0 } },
      ],
    });
    expect(mint.height).toBe(714617);
    expect(publish.height).toBe(714624);
    expect(tokenColor(C03_DS, C03_CONTRACT)).toBe(C03_COLOR);
    expect(walletAddress(NET, WALLET_1_HEX)).toBe(WALLET_1);
    // Wallets travel as Bech32m only; contracts, colors and hashes as hex.
    expect(JSON.stringify(page).includes(WALLET_1_HEX)).toBe(false);
    // The deploy (714611) moved no token and carries no metadata event.
    expect(page.items.some((i) => i.txHash === stepOf("C03", "deploy").txHash)).toBe(false);
  }, 180_000);

  it("[[mip0018.activity.c06-metadata]] C06's metadata transactions at their heights (tombstones included, no values); keyset pages in both orders; bad requests refused", async () => {
    const db = await fresh("c06");
    await archiveTape(db, IDX, 714789, 714835);
    await scanAll(scanner(db));
    const contract = CASES.cases.C06!.contract!;
    const expected = ["publish", "rename", "withdraw", "withdraw-again", "revive"].map((id) => {
      const s = stepOf("C06", id);
      return { height: s.height, txIndex: s.txIndex, itemIndex: 0, txHash: s.txHash, role: "metadata-event", contract, events: { accepted: 1, rejected: 0, firstEventIndex: 0 } };
    });
    expect(expected.map((e) => e.height)).toEqual([714796, 714804, 714813, 714827, 714835]);
    expect((await metadataTransactionsForContract(db.sql, NET, contract, {}, db.mip)).items).toEqual(expected);
    // Only C06 has accepted/rejected events in this range (the bridge contracts' events are other names: ignored).
    const contracts = await db.sql<{ c: Buffer }[]>`SELECT DISTINCT contract_address AS c FROM ${db.sql(db.mip)}.mip0018_activity WHERE role = 'metadata-event'`;
    expect(contracts.map((r) => hex(r.c))).toEqual([contract]);

    // Keyset pages: 2 + 2 + 1, ascending and descending, each cursor bound to its listing and order.
    const pages: ActivityItem[][] = [];
    let cursor: string | undefined;
    do {
      const p = await metadataTransactionsForContract(db.sql, NET, `0x${contract.toUpperCase()}`, { limit: 2, ...(cursor === undefined ? {} : { cursor }) }, db.mip);
      pages.push(p.items);
      cursor = p.nextCursor;
    } while (cursor !== undefined);
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(pages.flat()).toEqual(expected);
    expect(await all((c) => metadataTransactionsForContract(db.sql, NET, contract, { limit: 3, order: "desc", ...(c === undefined ? {} : { cursor: c }) }, db.mip))).toEqual([...expected].reverse());
    const first = await metadataTransactionsForContract(db.sql, NET, contract, { limit: 1 }, db.mip);
    await expect(metadataTransactionsForContract(db.sql, NET, contract, { cursor: first.nextCursor!, order: "desc" }, db.mip)).rejects.toThrow(/another listing or order/);
    await expect(activityForColor(db.sql, NET, contract, { cursor: first.nextCursor! }, db.mip)).rejects.toThrow(/another listing or order/);
    // Final-audit N5: a cursor is accepted only in the canonical form the API issues (decode/encode round trip).
    const issued = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")) as { v: number; s: string; o: string; p: number[] };
    const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64url");
    expect(b64(JSON.stringify({ v: 1, s: issued.s, o: issued.o, p: issued.p }))).toBe(first.nextCursor); // the issued form is canonical
    expect((await metadataTransactionsForContract(db.sql, NET, contract, { cursor: b64(JSON.stringify({ v: 1, s: issued.s, o: "asc", p: issued.p })) }, db.mip)).items).toEqual(expected.slice(1));
    const nonCanonical: string[] = [
      b64(JSON.stringify({ s: issued.s, v: 1, o: issued.o, p: issued.p })), // keys reordered
      b64(JSON.stringify({ ...issued, x: 1 })), // an extra key
      b64(JSON.stringify(issued, null, 1)), // whitespace
      b64(JSON.stringify(issued).replace(`"p":[${issued.p[0]}`, `"p":[${issued.p[0]}.0`)), // another number spelling
    ];
    // Another base64url spelling of the same bytes: a set unused low bit in the last character.
    const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const spareBits = ({ 2: 4, 3: 2 } as Record<number, number>)[first.nextCursor!.length % 4];
    if (spareBits !== undefined) {
      const variant = first.nextCursor!.slice(0, -1) + B64[B64.indexOf(first.nextCursor!.at(-1)!) | 1];
      expect(Buffer.from(variant, "base64url").equals(Buffer.from(first.nextCursor!, "base64url"))).toBe(true);
      nonCanonical.push(variant);
    }
    for (const cursor of nonCanonical)
      await expect(metadataTransactionsForContract(db.sql, NET, contract, { cursor }, db.mip), cursor).rejects.toBeInstanceOf(ActivityQueryError);
    for (const bad of [{ limit: 0 }, { limit: ACTIVITY_PAGE_MAX + 1 }, { limit: 1.5 }, { cursor: "not a cursor!" }, { cursor: Buffer.from('{"v":1}').toString("base64url") }, { order: "up" as "asc" }])
      await expect(metadataTransactionsForContract(db.sql, NET, contract, bad, db.mip), JSON.stringify(bad)).rejects.toBeInstanceOf(ActivityQueryError);
    await expect(activityForColor(db.sql, NET, "00", {}, db.mip)).rejects.toThrow(/32 bytes of hex/);
    expect((await metadataTransactionsForContract(db.sql, NET, contract, { limit: ACTIVITY_PAGE_MAX }, db.mip)).items).toHaveLength(5);
    // A metadata row is a chain event: position, counts and the event-log reference — never names or values.
    for (const i of (await metadataTransactionsForContract(db.sql, NET, contract, {}, db.mip)).items)
      expect(Object.keys(i).sort()).toEqual(["contract", "events", "height", "itemIndex", "role", "txHash", "txIndex"]);
  }, 180_000);

  it("[[mip0018.activity.idx-cases]] on the recorded IDX and U1 ranges every color's activity is exactly its case's transactions; mint rows equal the mint table; metadata rows equal the event log", async () => {
    const idx = await fresh("idx");
    await archiveTape(idx, IDX, 714485, 715183);
    await scanAll(scanner(idx));
    const u1 = await fresh("u1");
    await archiveTape(u1, loadRangeTape("u1"), 715402, 715433);
    await scanAll(scanner(u1));

    for (const [label, { color, steps }] of Object.entries(COLOR_STEPS)) {
      const db = label === "U1" ? u1 : idx;
      const caseId = label.slice(0, 3).trim();
      const items = await all((c) => activityForColor(db.sql, NET, color, c === undefined ? {} : { cursor: c }, db.mip));
      const expected = steps.map((s) => stepOf(caseId, s)).sort((a, b) => a.height - b.height || a.txIndex - b.txIndex).map((s) => s.txHash);
      expect(txOrder(items), label).toEqual(expected);
      expect(items.filter((i) => i.role !== "metadata-event").every((i) => i.color === color), label).toBe(true);
    }
    const third = await all((c) => activityForColor(idx.sql, NET, THIRD_PARTY_COLOR, c === undefined ? {} : { cursor: c }, idx.mip));
    expect(txOrder(third)).toEqual(CASES.otherTransactions.filter((o) => o.height === 714802).map((o) => o.txHash));

    // Role counts over the range: 7 mints, 5 shielded mints' offer deltas, 2 UTXOs created (C03, C04 kind 2).
    const roles = await idx.sql<{ role: string; n: number }[]>`SELECT role, count(*)::int AS n FROM ${idx.sql(idx.mip)}.mip0018_activity GROUP BY role ORDER BY role`;
    const metadataRows = roles.find((r) => r.role === "metadata-event")!.n;
    expect(roles).toEqual([
      { role: "metadata-event", n: metadataRows }, { role: "mint", n: 7 }, { role: "shielded-offer", n: 5 }, { role: "utxo-created", n: 2 },
    ]);
    const wallets = await idx.sql<{ w: Buffer }[]>`SELECT DISTINCT wallet_address AS w FROM ${idx.sql(idx.mip)}.mip0018_activity WHERE wallet_address IS NOT NULL`;
    expect(wallets.map((r) => hex(r.w))).toEqual([WALLET_1_HEX]);

    // Mint rows = the mint table (A3), row for row.
    const mintRows = await idx.sql<{ k: string }[]>`
      SELECT concat_ws(':', block_height, tx_index, encode(contract_address, 'hex'), encode(domain_sep, 'hex'), kind, amount, encode(color, 'hex')) AS k
      FROM ${idx.sql(idx.mip)}.mip0018_activity WHERE role = 'mint' ORDER BY 1`;
    const minted = await idx.sql<{ k: string }[]>`
      SELECT concat_ws(':', block_height, tx_index, encode(contract_address, 'hex'), encode(domain_sep, 'hex'), kind, amount, encode(color, 'hex')) AS k
      FROM ${idx.sql(idx.mip)}.mip0018_mints ORDER BY 1`;
    expect(mintRows).toEqual(minted);

    // Metadata rows = the event log's accepted/rejected events grouped by (transaction, contract); ignored events add none.
    const fromRows = await idx.sql<{ k: string }[]>`
      SELECT concat_ws(':', block_height, tx_index, encode(contract_address, 'hex'), events_accepted, events_rejected, first_event_index) AS k
      FROM ${idx.sql(idx.mip)}.mip0018_activity WHERE role = 'metadata-event' ORDER BY 1`;
    const fromEvents = await idx.sql<{ k: string }[]>`
      SELECT concat_ws(':', block_height, tx_index, encode(contract_address, 'hex'),
                       count(*) FILTER (WHERE classification = 'accept'), count(*) FILTER (WHERE classification = 'reject'), min(event_index)) AS k
      FROM ${idx.sql(idx.mip)}.mip0018_events WHERE classification IN ('accept', 'reject')
      GROUP BY block_height, tx_index, contract_address ORDER BY 1`;
    expect(fromRows).toEqual(fromEvents);
    expect(fromRows.length).toBe(metadataRows);
    const totals = await idx.sql<{ a: number; r: number }[]>`
      SELECT sum(events_accepted)::int AS a, sum(events_rejected)::int AS r FROM ${idx.sql(idx.mip)}.mip0018_activity WHERE role = 'metadata-event'`;
    expect(totals[0]).toEqual({ a: 25, r: 10 }); // B2: 35 v1-named events of the range = 25 accepted + 10 rejected
    const c07 = await all((c) => metadataTransactionsForContract(idx.sql, NET, CASES.cases.C07!.contract!, c === undefined ? {} : { cursor: c }, idx.mip));
    expect([c07.length, c07.filter((i) => i.events!.accepted === 1).length, c07.filter((i) => i.events!.rejected === 1).length]).toEqual([18, 9, 9]); // 4 ignored steps: no row
    const c08 = await metadataTransactionsForContract(idx.sql, NET, CASES.cases.C08!.contract!, {}, idx.mip);
    expect(c08.items.map((i) => [i.txHash, i.events])).toEqual([[stepOf("C08", "emit-two").txHash, { accepted: 1, rejected: 1, firstEventIndex: 0 }]]);
    // NIGHT: no NIGHT UTXO in the recorded ranges; DUST has no color, so no listing exists for it.
    expect((await activityForColor(idx.sql, NET, NIGHT_COLOR, {}, idx.mip))).toEqual({ items: [] });
  }, 600_000);

  it("[[mip0018.activity.withdrawn-history]] final-audit F3 and re-check R2: a color's and a contract's activity list metadata transactions only for rejected events and accepted events of an identity's current description — a withdrawn native token's publish and withdrawal transactions disappear from its color and its contract (its mints stay), a sibling's stay until it is withdrawn too, rejected events stay; a revived identity's history starts at its revival (its transactions from before the withdrawal and a Null-only event while it had no field stay hidden), and an event that deletes every field and sets one again is the new start; the last withdrawal of each identity is recorded; removeAbove restores the earlier listings exactly; C06's per-key steps never empty its identity, so its rows stay at every step", async () => {
    const Y = "c3".repeat(32);
    const DS1 = "d1".repeat(32);
    const DS2 = "d2".repeat(32);
    const T = tokenColor(DS1, Y);
    const item = (ds: string, kind: 1 | 3, records: Parameters<typeof encodePayload>[1]): string =>
      Buffer.concat([EVENT_NAME, encodePayload({ domainSep: Buffer.from(ds, "hex"), kind }, records)]).toString("hex");
    const withdraw = (ds: string, kind: 1 | 3) => item(ds, kind, ["name", "symbol", "decimals"].map((k) => record.tombstone(k)));
    let n = 0;
    const tx = (calls: NonNullable<SynthTxA["intents"]>[number]["calls"]): SynthArchivedTx => ({
      result: "success", tx: { hash: (++n).toString(16).padStart(2, "0").repeat(32), intents: [{ segment: 1, calls }] } as unknown as SynthArchivedTx["tx"],
    });
    const call = (t: { logs?: string[]; shieldedMints?: Array<[string, string]> }) => [{ address: Y, entryPoint: "meta", guaranteed: t }];
    const db = await fresh("wd");
    await putSyntheticBlocks(db.sql, db.archive, NET, 300, [
      [tx(call({ shieldedMints: [[DS1, "100"]], logs: [acceptedEvent(DS1, 1, "Token")] }))], // 300 mint + publish kind 1
      [tx(call({ logs: [acceptedEvent(DS2, 3, "Sibling")] }))], // 301 sibling kind 3
      [tx(call({ logs: [rejectedEvent()] }))], // 302 rejected
      [tx(call({ logs: [withdraw(DS1, 1)] }))], // 303 kind 1 withdrawn (all three keys; the last at record 2)
      [tx(call({ shieldedMints: [[DS1, "5"]] }))], // 304 another mint of T, no event
      [tx(call({ logs: [withdraw(DS2, 3)] }))], // 305 sibling withdrawn
      [tx(call({ logs: [item(DS1, 1, [record.tombstone("name")])] }))], // 306 a Null-only event while kind 1 has no field
      [tx(call({ logs: [item(DS1, 1, [record.utf8("name", "Again")])] }))], // 307 kind 1 revived (name only)
      [tx(call({ logs: [item(DS1, 1, [record.utf8("symbol", "AG")])] }))], // 308 kind 1 described further
      // 309 one event deletes every field (the last at record 1) and sets one again: a withdrawal and a revival at once
      [tx(call({ logs: [item(DS1, 1, [record.tombstone("name"), record.tombstone("symbol"), record.utf8("name", "Reset")])] }))],
    ]);
    const s = scanner(db, syntheticSeams);
    const until = async (to: number): Promise<void> => {
      const sc = scanner(db, { ...syntheticSeams, toHeight: to });
      await sc.bootstrap();
      for (;;) {
        const r = await sc.scanOnce({ maxBlocks: 50 });
        if (r.scannedBlocks === 0 || r.reachedEnd) return;
      }
    };
    const colorRows = async () => (await all((c) => activityForColor(db.sql, NET, T, c === undefined ? {} : { cursor: c }, db.mip)))
      .map((i) => (i.role === "metadata-event" ? `${i.height}:meta:${i.events!.accepted}/${i.events!.rejected}` : `${i.height}:${i.role}`));
    const contractRows = async () => (await all((c) => metadataTransactionsForContract(db.sql, NET, Y, c === undefined ? {} : { cursor: c }, db.mip)))
      .map((i) => `${i.height}:${i.events!.accepted}/${i.events!.rejected}`);
    const withdrawals = async () => (await db.sql<{ k: number; h: string; r: number }[]>`
      SELECT kind AS k, block_height::text AS h, record_index AS r FROM ${db.sql(db.mip)}.mip0018_withdrawals ORDER BY kind`).map((w) => `${w.k}@${w.h}.${w.r}`);

    await until(302); // before any withdrawal: everything listed
    expect(await colorRows()).toEqual(["300:mint", "300:meta:1/0", "301:meta:1/0", "302:meta:0/1"]);
    expect(await contractRows()).toEqual(["300:1/0", "301:1/0", "302:0/1"]);
    expect(await withdrawals()).toEqual([]);
    await until(304); // kind 1 withdrawn: its publish (300) and withdrawal (303) are not referenced; its mints stay
    expect(await colorRows()).toEqual(["300:mint", "301:meta:1/0", "302:meta:0/1", "304:mint"]);
    expect(await contractRows()).toEqual(["301:1/0", "302:0/1"]);
    expect(await withdrawals()).toEqual(["1@303.2"]);
    // The stored rows are unchanged (the chain events stay in the log): only the listing hides them.
    const stored = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${db.sql(db.mip)}.mip0018_activity WHERE role = 'metadata-event'`;
    expect(stored[0]!.n).toBe(4);
    await until(305); // the sibling withdrawn too: only the rejected event's transaction is left
    expect(await colorRows()).toEqual(["300:mint", "302:meta:0/1", "304:mint"]);
    expect(await contractRows()).toEqual(["302:0/1"]);
    expect(await withdrawals()).toEqual(["1@303.2", "3@305.2"]);
    await until(306); // a Null-only event of the withdrawn kind 1: it describes nothing, so it is not listed
    expect(await contractRows()).toEqual(["302:0/1"]);
    await until(307); // kind 1 revived: its history starts here — 300, 303 and 306 stay hidden (re-check R2, Q34)
    expect(await contractRows()).toEqual(["302:0/1", "307:1/0"]);
    expect(await colorRows()).toEqual(["300:mint", "302:meta:0/1", "304:mint", "307:meta:1/0"]);
    await until(308);
    expect(await contractRows()).toEqual(["302:0/1", "307:1/0", "308:1/0"]);
    await until(309); // the reset event withdraws kind 1 (at its record 1) and describes it again: it is the new start
    expect(await contractRows()).toEqual(["302:0/1", "309:1/0"]);
    expect(await withdrawals()).toEqual(["1@309.1", "3@305.2"]);
    // firstEventIndex counts only listed events; keyset pages and the descending order agree.
    expect((await all((c) => metadataTransactionsForContract(db.sql, NET, Y, { limit: 1, order: "desc", ...(c === undefined ? {} : { cursor: c }) }, db.mip))).map((i) => i.height)).toEqual([309, 302]);
    expect((await all((c) => activityForColor(db.sql, NET, T, { limit: 1, order: "desc", ...(c === undefined ? {} : { cursor: c }) }, db.mip))).map((i) => `${i.height}:${i.role}`))
      .toEqual(["309:metadata-event", "304:mint", "302:metadata-event", "300:mint"]);

    // removeAbove restores the earlier listings and withdrawal rows exactly; a rescan gives the same tables.
    const full = await dump(db.sql, db.mip);
    await s.removeAbove(308); // the reset is gone: 307 and 308 are listed again, the withdrawal is 303's
    expect(await contractRows()).toEqual(["302:0/1", "307:1/0", "308:1/0"]);
    expect(await withdrawals()).toEqual(["1@303.2", "3@305.2"]);
    await s.removeAbove(302); // both withdrawals gone: everything listed again
    expect(await contractRows()).toEqual(["300:1/0", "301:1/0", "302:0/1"]);
    expect(await withdrawals()).toEqual([]);
    await until(309);
    expect(await dump(db.sql, db.mip)).toEqual(full);

    // C06 (recorded, per-key): its withdraw steps delete one key at a time, so the identity always exists and every
    // metadata transaction stays listed after each step.
    const c06 = await fresh("wd_c06");
    await archiveTape(c06, IDX, 714485, 714835);
    const steps = ["publish", "rename", "withdraw", "withdraw-again", "revive"].map((id) => stepOf("C06", id));
    const contract = CASES.cases.C06!.contract!;
    for (const [k, step] of steps.entries()) {
      const s = scanner(c06, { toHeight: step.height });
      await s.bootstrap();
      for (;;) {
        const r = await s.scanOnce({ maxBlocks: 400 });
        if (r.scannedBlocks === 0 || r.reachedEnd) break;
      }
      const rows = await all((c) => metadataTransactionsForContract(c06.sql, NET, contract, c === undefined ? {} : { cursor: c }, c06.mip));
      expect(rows.map((i) => i.height), `C06 after ${["publish", "rename", "withdraw", "withdraw-again", "revive"][k]}`).toEqual(steps.slice(0, k + 1).map((x) => x.height));
    }
  }, 300_000);

  it("[[mip0018.activity.failed-parts]] nothing of a failed segment or a FAILURE transaction; all public flows of a successful one (spends, outputs, NIGHT, contract in/out with recipients, deltas); edge rules", async () => {
    const A = "a1".repeat(32);
    const B = "b2".repeat(32);
    const DS = "0d".repeat(32);
    const Y = "e7".repeat(32);
    const X = "f8".repeat(32);
    const minted = tokenColor(DS, A);
    const tx = (hash: string): SynthTxA => ({
      hash,
      guaranteedDeltas: [[X, "-10"], [NIGHT_COLOR, "-3"]],
      fallibleDeltas: { 5: [[X, "4"]] },
      intents: [{
        segment: 5,
        guaranteedSpends: [[NIGHT_COLOR, "100", 1, "11".repeat(32), 0]],
        guaranteedOutputs: [[NIGHT_COLOR, "60", walletOf(2)], [NIGHT_COLOR, "40", walletOf(1)]],
        fallibleSpends: [[Y, "7", 3, "22".repeat(32), 4]],
        fallibleOutputs: [[Y, "7", walletOf(2)]],
        calls: [{
          address: A, entryPoint: "flow",
          guaranteed: { logs: [acceptedEvent(DS, 2, "Gee")], unshieldedMints: [[DS, "50"]], claimed: [[minted, "user", walletOf(2), "50"]], unshieldedInputs: [["unshielded", Y, "5"], ["dust", "", "9"]] },
          fallible: { logs: [rejectedEvent()], unshieldedOutputs: [["unshielded", Y, "3"]], claimed: [[Y, "contract", B, "3"]] },
        }],
      }],
    });
    const db = await fresh("failed");
    const archived = (t: SynthTxA, result: SynthArchivedTx["result"], segments: SynthArchivedTx["segments"]): SynthArchivedTx =>
      ({ tx: t as unknown as SynthArchivedTx["tx"], result, segments });
    await putSyntheticBlocks(db.sql, db.archive, NET, 100, [
      [archived(tx("c1".repeat(32)), "success", null)],
      [archived(tx("c2".repeat(32)), "partial_success", [{ id: 5, success: false }])],
      [archived(tx("c3".repeat(32)), "failure", null)],
    ]);
    await scanAll(scanner(db, syntheticSeams));
    const rows = await db.sql<{ h: string; role: string; phase: string | null; color: Buffer | null; amount: string | null; direction: string | null; w: Buffer | null; rc: Buffer | null; ih: Buffer | null; oi: number | null; ea: number | null; er: number | null }[]>`
      SELECT block_height::text AS h, role, phase, color, amount::text AS amount, direction, wallet_address AS w, recipient_contract AS rc,
             intent_hash AS ih, output_index AS oi, events_accepted AS ea, events_rejected AS er
      FROM ${db.sql(db.mip)}.mip0018_activity ORDER BY block_height, tx_index, item_index`;
    const show = (r: (typeof rows)[number]): string => [
      r.h, r.role, r.phase ?? "-", r.color === null ? "-" : hex(r.color).slice(0, 4), r.amount ?? "-", r.direction ?? "-",
      r.w === null ? "-" : `w${[1, 2, 3].find((n) => walletOf(n) === hex(r.w!))}`, r.rc === null ? "-" : hex(r.rc).slice(0, 4),
      r.ih === null ? "-" : hex(r.ih) === synthIntentHash("c1".repeat(32), 5, 0) || hex(r.ih) === synthIntentHash("c2".repeat(32), 5, 0) ? "ih0" : hex(r.ih) === synthIntentHash("c1".repeat(32), 5, 5) ? "ih5" : hex(r.ih).slice(0, 4),
      r.oi ?? "-", r.ea === null ? "" : `${r.ea}/${r.er}`,
    ].join(" ");
    const success = [
      "100 shielded-offer guaranteed f8f8 10 in - - - - ",
      "100 utxo-spent guaranteed 0000 100 out w1 - 1111 0 ",
      "100 utxo-created guaranteed 0000 60 in w2 - ih0 0 ",
      "100 utxo-created guaranteed 0000 40 in w1 - ih0 1 ",
      `100 mint guaranteed ${minted.slice(0, 4)} 50 in w2 - - - `,
      "100 contract-in guaranteed e7e7 5 in - - - - ",
      "100 shielded-offer fallible f8f8 4 out - - - - ",
      "100 utxo-spent fallible e7e7 7 out w3 - 2222 4 ",
      "100 utxo-created fallible e7e7 7 in w2 - ih5 2 ",
      "100 contract-out fallible e7e7 3 out - b2b2 - - ",
      "100 metadata-event - - - - - - - - 1/1",
    ];
    const partial = success.filter((l) => l.includes("guaranteed")).map((l) => l.replace(/^100/, "101"));
    expect(rows.map(show)).toEqual([...success, ...partial, "101 metadata-event - - - - - - - - 1/0"]);
    expect(rows.some((r) => r.h === "102")).toBe(false); // FAILURE: nothing
    // The minting contract's metadata rows join the color's activity; the NIGHT listing shows its UTXOs.
    const mintedItems = await activityForColor(db.sql, NET, minted, {}, db.mip);
    expect(mintedItems.items.map((i) => `${i.height}:${i.role}`)).toEqual(["100:mint", "100:metadata-event", "101:mint", "101:metadata-event"]);
    expect(mintedItems.items[0]!.wallet).toBe(walletAddress(NET, walletOf(2)));
    const night = await activityForColor(db.sql, NET, NIGHT_COLOR, {}, db.mip);
    expect(night.items.map((i) => `${i.height}:${i.role}:${i.amount}`)).toEqual(["100:utxo-spent:100", "100:utxo-created:60", "100:utxo-created:40", "101:utxo-spent:100", "101:utxo-created:60", "101:utxo-created:40"]);
    expect(night.contract).toBeUndefined();

    // Pure edge rules of the recipient attribution and the token-type shapes.
    const pure = (t: SynthTxA) => transactionActivity({ network: NET, height: 1, txIndex: 0, txHash: t.hash, tx: syntheticActivityTx(t), outcome: { result: "success" }, events: [] });
    const call = (g: NonNullable<NonNullable<SynthTxA["intents"]>[number]["calls"]>[number]["guaranteed"]): SynthTxA =>
      ({ hash: "d0".repeat(32), intents: [{ segment: 1, calls: [{ address: A, entryPoint: "e", guaranteed: g }] }] });
    const recipientOf = (t: SynthTxA): Array<string | null> => pure(t).map((r) => (r.wallet_address ?? r.recipient_contract)?.toString("hex") ?? null);
    expect(recipientOf(call({ unshieldedMints: [[DS, "50"]], claimed: [[minted, "user", walletOf(1), "25"], [minted, "user", walletOf(2), "25"]] }))).toEqual([null]); // two recipients
    expect(recipientOf(call({ unshieldedMints: [[DS, "50"]], claimed: [[minted, "user", walletOf(1), "49"]] }))).toEqual([null]); // amount differs
    expect(recipientOf(call({ unshieldedMints: [[DS, "50"]], unshieldedOutputs: [["unshielded", minted, "50"]], claimed: [[minted, "user", walletOf(1), "50"]] }))).toEqual([null, null]); // two funders
    expect(recipientOf(call({ shieldedMints: [[DS, "50"]], claimed: [[minted, "user", walletOf(1), "50"]] }))).toEqual([null]); // a shielded mint has no public recipient
    expect(recipientOf(call({ unshieldedMints: [[DS, "50"]], claimed: [[minted, "contract", B, "50"]] }))).toEqual([B]);
    expect(() => pure(call({ unshieldedInputs: [["weird", Y, "1"]] }))).toThrow(ActivityDecodeError);
    expect(pure({ hash: "d1".repeat(32), guaranteedDeltas: [[NIGHT_COLOR, "-5"]] })).toEqual([]); // shielded native token: not NIGHT
  }, 180_000);

  it("[[mip0018.activity.remove-above]] removeAbove deletes the activity above a height and a rescan restores it exactly", async () => {
    const db = await fresh("cut");
    await archiveTape(db, IDX, 714637, 714663);
    const s = scanner(db);
    await scanAll(s);
    const full = await dump(db.sql, db.mip);
    expect(full.activity!.length).toBeGreaterThan(0);
    await s.removeAbove(714645);
    const left = await db.sql<{ h: string }[]>`SELECT DISTINCT block_height::text AS h FROM ${db.sql(db.mip)}.mip0018_activity ORDER BY 1`;
    expect(left.map((r) => r.h)).toEqual(["714643"]);
    expect(txOrder((await activityForColor(db.sql, NET, C04_COLOR, {}, db.mip)).items)).toEqual([stepOf("C04", "mint-shielded").txHash]);
    await scanAll(s);
    expect(await dump(db.sql, db.mip)).toEqual(full);
    await s.removeAbove(714636);
    expect(await db.sql`SELECT 1 FROM ${db.sql(db.mip)}.mip0018_activity`).toHaveLength(0);
    await scanAll(s);
    expect(await dump(db.sql, db.mip)).toEqual(full);
  }, 180_000);

  it("[[mip0018.activity.kill-resume]] the scan CLI SIGKILLed inside a block's transaction leaves no row of that block; a restart gives the same rows as an uninterrupted scan", async () => {
    const clean = await fresh("clean");
    await archiveTape(clean, IDX, 714637, 714663);
    await scanAll(scanner(clean));
    const expected = await dump(clean.sql, clean.mip);

    const db = await fresh("killed");
    await archiveTape(db, IDX, 714637, 714663);
    const s = scanner(db);
    await s.bootstrap();
    expect((await s.scanOnce({ maxBlocks: 12 })).toHeight).toBe(714648); // next block 714649: C04's unshielded mint
    const cli = (): ChildProcess => {
      const child = spawn(process.execPath, [
        "--import", "tsx", "token-indexer/mip0018/scan-cli.ts", "--network", NET, "--schema", db.mip, "--archive-schema", db.archive,
        "--to", "714663", "--max-blocks", "1",
      ], { cwd: process.cwd(), env: { ...process.env, PG_URL: container.getConnectionUri() }, stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      return child;
    };
    const exitOf = (child: ChildProcess): Promise<number | null> => new Promise((resolve) => child.once("exit", (code) => resolve(code)));

    // Hold the cursor row: the CLI writes block 714649's rows, then blocks on the cursor update inside its transaction.
    const holder = await db.sql.reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT 1 FROM ${holder(db.mip)}.mip0018_scan WHERE network = ${NET} FOR UPDATE`;
      const child = cli();
      const exited = exitOf(child);
      const deadline = Date.now() + 90_000;
      let blocked: number[] = [];
      for (;;) {
        const waiting = await db.sql<{ pid: number }[]>`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%UPDATE%mip0018_scan%SET next_height%'`;
        blocked = waiting.map((w) => w.pid);
        if (blocked.length > 0) break;
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`the CLI never blocked on the cursor (exit ${child.exitCode})`);
        await new Promise((r) => setTimeout(r, 100));
      }
      child.kill("SIGKILL");
      await exited;
      expect(child.signalCode).toBe("SIGKILL");
      // The killed CLI's own backend would wait for the lock before noticing its client is gone: end it now.
      for (const pid of blocked) await db.sql`SELECT pg_terminate_backend(${pid})`;
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
    expect((await s.getCursor())?.nextHeight).toBe(714649);
    expect(await db.sql`SELECT 1 FROM ${db.sql(db.mip)}.mip0018_activity WHERE block_height >= 714649`).toHaveLength(0);
    expect(await db.sql`SELECT 1 FROM ${db.sql(db.mip)}.mip0018_mints WHERE block_height >= 714649`).toHaveLength(0);

    const again = cli();
    expect(await exitOf(again)).toBe(0);
    expect(await dump(db.sql, db.mip)).toEqual(expected);
  }, 240_000);
});
