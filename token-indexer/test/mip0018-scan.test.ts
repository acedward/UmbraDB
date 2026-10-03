/**
 * The MIP-0018 scan over the chain archive (project 00026, sub-plan A3): mints → colors (MIP "Lookup"), seen tokens,
 * NIGHT/DUST rows, contract deploys/calls/maintenance; one atomic checkpoint per block; resume and recompute.
 *
 * Data: the recorded Stagenet tapes of sub-plan A2 (`test/integration/fixtures/stagenet-archive/`), archived by the
 * real `chain-archive-sync` against `fake-chain-server.ts` (no network), and synthetic archive blocks for what
 * Stagenet cannot show (a mint in a failed fallible segment, a color seen before its mint, broken archive rows).
 * Expected colors: the reference index states (midnight-experiments/mip-0018 @ daec1f1,
 * `deployments/stagenet/cases/{IDX,U1}/index/index-state.json`) and the wallet's balances (`cases/<case>/wallet-status.json`).
 * One Postgres 17 container for the file; one archive schema + one `mip0018` schema per scenario.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import type { IndexerBlock } from "../../chain-archive-sync/indexer-client.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { type ArchiveTape, type FakeChain, loadTape, startFakeChain } from "../../test/integration/fixtures/stagenet-archive/fake-chain-server.js";
import { loadRangeTape } from "../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import { tokenColor } from "../mip0018/color.ts";
import { main as scanCli } from "../mip0018/scan-cli.ts";
import { Mip0018Scanner, ScanError, ScanRangeError } from "../mip0018/scan.ts";
import { builtinTokens, listColors, lookupColor, nativeTokens } from "../mip0018/tokens.ts";
import { blockHashOf, decodeSynthetic, putSyntheticBlocks, type SynthArchivedTx } from "./helpers/synthetic-archive.ts";

const NET = "stagenet";
const C04 = loadTape("c04-714637-714663.tape.json");

const C04_CONTRACT = "86acf80ff386abb610aadbea0406039e7fe39893f440794c3c2bad86dd48570f";
const C04_DS = "6d69702d303031383a6578616d706c653a6d756c74692d6b696e640000000000";
const C04_COLOR = "042399246139df031a4780c684df8eaecd48b7e03a195bfe986cf22766bcbc16";
const C05_CONTRACT = "f2d1b6ebfea446cf2624cd498fc585eeb86dddf94e33229ce47107038d2251d6";
const C05_BRONZE_DS = "6d69702d303031383a6578616d706c653a66616d696c793a62726f6e7a650000";

/** height → [kind, color, contract, domainSep, amount] of the single mint at that height (reference index states). */
const CASE_MINTS: Record<number, [1 | 2, string, string, string, string]> = {
  714557: [1, "be34ef4b78717b031040bf625e04ee033106efae4c766915d3cac2b7fda8f11b", "0ee5f31961f9df197055c49dda8f87275af50c3554ba701ffa1837537735e532", "6d69702d303031383a6578616d706c653a736869656c64656400000000000000", "1000000"],
  714617: [2, "8e01e39293a9e21ee2685da06ce487fffafbc1a982d53fcb1a72520f18518484", "a3df52605d8b7210aa3e5cdc82de4bb2911975bc42c1a68be77044723b705f21", "6d69702d303031383a6578616d706c653a756e736869656c6465640000000000", "1000000"],
  714683: [1, "81db4eef83089c5403c6af29d926d57ee6b6359ff7dc291dd19cb4c3e9cf7aa1", C05_CONTRACT, "6d69702d303031383a6578616d706c653a66616d696c793a676f6c6400000000", "3"],
  714689: [1, "8c74ec4a937d296f8234a2373812c2df3d962dba06dfe98cda390f9dea38491d", C05_CONTRACT, "6d69702d303031383a6578616d706c653a66616d696c793a73696c7665720000", "5"],
  714802: [1, "e5afe273bcb1252cfbc81ad6ca1caaafe22312c8c29f9b104a2fe3ead980bb2d", "7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637", "953ecfdd939bcb9df7bb4ddb9deeb4ebfa2447563c08f7973576c7ac492f9600", "1040000"],
  715409: [1, "89a5559202e2d7c111150d84bbcae4c4beb56733373e1935ac74ce565f17ffb0", "11010832a39954d9ccce48f6b5fce25fc789abb1d700ee45b26b69af3e5dd63b", "6d69702d303031383a6578616d706c653a757067726164650000000000000000", "1000"],
};

const hex = (b: Buffer): string => b.toString("hex");

/** Every scan table, in key order, bytes as hex — what "identical" means for a resumed or recomputed scan. */
async function dumpScan(sql: UmbraDBSql, schema: string): Promise<Record<string, unknown[]>> {
  const s = sql(schema);
  const norm = (rows: readonly Record<string, unknown>[]): unknown[] =>
    rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Buffer.isBuffer(v) ? hex(v) : typeof v === "bigint" ? v.toString() : v])));
  return {
    scan: norm(await sql`SELECT * FROM ${s}.mip0018_scan ORDER BY network`),
    mints: norm(await sql`SELECT * FROM ${s}.mip0018_mints ORDER BY network, block_height, tx_index, mint_index`),
    sightings: norm(await sql`SELECT * FROM ${s}.mip0018_color_sightings ORDER BY network, color, evidence`),
    actions: norm(await sql`SELECT * FROM ${s}.mip0018_contract_actions ORDER BY network, block_height, tx_index, segment_id, action_index`),
    events: norm(await sql`SELECT * FROM ${s}.mip0018_events ORDER BY network, block_height, tx_index, event_index`),
    fields: norm(await sql`SELECT * FROM ${s}.mip0018_fields ORDER BY network, contract_address, domain_sep, kind, key`), // B3
    builtins: norm(await sql`SELECT * FROM ${s}.mip0018_builtin_tokens ORDER BY network, symbol`),
  };
}

describe("MIP-0018 scan over the chain archive (00026 A3)", () => {
  let container: StartedPostgreSqlContainer;
  const clients: UmbraDBSql[] = [];
  const fakes: FakeChain[] = [];
  let counter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 180_000);

  afterEach(async () => {
    for (const f of fakes.splice(0)) await f.close();
  });

  afterAll(async () => {
    for (const c of clients) await c.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  /** A fresh archive schema and `mip0018` schema in the shared database. */
  async function fresh(prefix: string): Promise<{ sql: UmbraDBSql; archive: string; mip: string }> {
    const n = counter++;
    const archive = `${prefix}_arch_${n}`;
    const mip = `${prefix}_mip_${n}`;
    const sql = createClient({ connectionString: container.getConnectionUri(), schema: mip });
    clients.push(sql);
    await bootstrapChainArchiveSchema(sql, archive);
    return { sql, archive, mip };
  }

  /** Archives `[from, to]` of a recorded tape with the real sync service, served by the fake chain. */
  async function archiveTape(sql: UmbraDBSql, schema: string, tape: ArchiveTape, from: number, to: number, overrides?: Map<number, IndexerBlock>): Promise<void> {
    const f = await startFakeChain(tape, overrides === undefined ? {} : { indexerOverrides: overrides });
    fakes.push(f);
    const svc = new ChainArchiveSyncService({
      sql, net: NET, schema, node: { url: f.nodeUrl }, indexer: { url: f.indexerUrl },
      startHeight: from, endHeight: to, concurrency: 4, backoff: { jitter: false, baseDelayMs: 1, maxDelayMs: 5 },
    });
    expect((await svc.syncOnce({ maxBlocks: 1_000 })).reachedEnd).toBe(true);
  }

  function scanner(db: { sql: UmbraDBSql; archive: string; mip: string }, extra: Partial<ConstructorParameters<typeof Mip0018Scanner>[0]> = {}): Mip0018Scanner {
    return new Mip0018Scanner({ sql: db.sql, network: NET, schema: db.mip, archiveSchema: db.archive, ...extra });
  }

  async function scanAll(s: Mip0018Scanner, maxBlocks = 1_000): Promise<number> {
    let blocks = 0;
    for (;;) {
      const r = await s.scanOnce({ maxBlocks });
      blocks += r.scannedBlocks;
      if (r.scannedBlocks === 0 || r.reachedEnd) return blocks;
    }
  }

  it("[[mip0018.scan.c04-colors]] C04 (714637–714663): one color for the shielded and the unshielded mint, the ledger mint has none; deploy and calls recorded; NIGHT/DUST rows", async () => {
    const db = await fresh("c04");
    await archiveTape(db.sql, db.archive, C04, 714637, 714663);
    const s = scanner(db);
    await s.bootstrap();
    await s.bootstrap(); // idempotent
    expect(await scanAll(s)).toBe(27);
    expect(await s.getCursor()).toEqual({ fromHeight: 714637, nextHeight: 714664, lastBlockHash: C04.blocks.at(-1)!.blockHash.replace(/^0x/, "") });

    const colors = await listColors(db.sql, NET, db.mip);
    expect(colors).toHaveLength(1);
    expect(colors[0]).toMatchObject({
      color: C04_COLOR, contractAddress: C04_CONTRACT, domainSep: C04_DS,
      shielded: { firstMint: { height: 714643, txIndex: 0 }, mints: 1, amount: "100000" },
      unshielded: { firstMint: { height: 714649, txIndex: 0 }, mints: 1, amount: "100000" },
    });
    expect(tokenColor(C04_DS, C04_CONTRACT)).toBe(C04_COLOR);
    expect((await lookupColor(db.sql, NET, `0x${C04_COLOR.toUpperCase()}`, db.mip)).entry?.contractAddress).toBe(C04_CONTRACT);

    const actions = await db.sql<{ block_height: bigint; action: string; entry_point: string | null; applied_phases: string[] | null; contract_address: Buffer }[]>`
      SELECT block_height, action, entry_point, applied_phases, contract_address FROM ${db.sql(db.mip)}.mip0018_contract_actions ORDER BY block_height`;
    expect(actions.map((a) => `${a.block_height}:${a.action}:${a.entry_point ?? "-"}:${(a.applied_phases ?? []).join("+")}`)).toEqual([
      "714637:deploy:-:", "714643:call:mintShielded:guaranteed", "714649:call:mintUnshielded:guaranteed",
      "714655:call:mintLedger:guaranteed", "714663:call:publishMetadata:guaranteed",
    ]);
    expect(actions.every((a) => hex(a.contract_address) === C04_CONTRACT)).toBe(true);

    const tokens = await nativeTokens(db.sql, NET, db.mip);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ color: C04_COLOR, firstSeen: { height: 714643 }, evidence: ["contract-unshielded", "shielded-offer", "unshielded-utxo"], minted: { contractAddress: C04_CONTRACT } });
    expect(await builtinTokens(db.sql, NET, db.mip)).toEqual([
      { symbol: "NIGHT", name: "NIGHT", decimals: 6, color: "00".repeat(32), note: expect.stringContaining("outside MIP-0018") },
      { symbol: "DUST", name: "DUST", decimals: 15, color: undefined, note: expect.stringContaining("outside MIP-0018") },
    ]);
  }, 180_000);

  it("[[mip0018.scan.idx-u1-ranges]] the recorded IDX range 714485–715183 gives exactly the reference's 6 colors (C05 bronze not minted) and U1's range its color; deploys, maintenance updates and the 58-vs-60 call count are explained by the rows", async () => {
    // IDX: every block of the reference's scan range (D1 recording), archived and scanned.
    const idx = await fresh("idx");
    const tape = loadRangeTape("idx");
    await archiveTape(idx.sql, idx.archive, tape, 714485, 715183);
    const s = scanner(idx);
    await s.bootstrap();
    expect(await scanAll(s, 250)).toBe(699);
    const colors = await listColors(idx.sql, NET, idx.mip);
    const got: Record<number, Array<[number, string, string, string, string]>> = {};
    for (const c of colors) for (const [kind, k] of [[1, c.shielded], [2, c.unshielded]] as const)
      if (k !== undefined) (got[k.firstMint.height] ??= []).push([kind, c.color, c.contractAddress, c.domainSep, k.amount]);
    expect(colors).toHaveLength(6);
    expect(Object.fromEntries(Object.entries(got).map(([h, v]) => [h, v[0]]))).toEqual(
      Object.fromEntries(Object.entries(CASE_MINTS).filter(([h]) => Number(h) <= 715183).concat([
        ["714643", [1, C04_COLOR, C04_CONTRACT, C04_DS, "100000"]], ["714649", [2, C04_COLOR, C04_CONTRACT, C04_DS, "100000"]],
      ])),
    );
    for (const c of colors) expect(c.shielded === undefined || c.shielded.mints === 1).toBe(true);
    expect((await lookupColor(idx.sql, NET, tokenColor(C05_BRONZE_DS, C05_CONTRACT), idx.mip)).found).toBe(false); // published, never minted
    // Seen tokens of the range: exactly the six minted colors (public data shows no other color; NIGHT is a built-in).
    const seen = await nativeTokens(idx.sql, NET, idx.mip);
    expect(seen.map((t) => t.color).sort()).toEqual(colors.map((c) => c.color).sort());
    expect(seen.every((t) => t.minted !== undefined)).toBe(true);

    // Contract actions: 9 deploys, 1 maintenance update (C10's VerifierKeyRemove at 715183), 60 call actions in
    // 58 transactions — the reference IDX summary's `contractCalls: 58` counts transactions with a call; A2's live
    // count (60) was call actions. Two transactions carry two calls each (another user's bridge contracts).
    const actions = await idx.sql<{ action: string; n: number; txs: number }[]>`
      SELECT action, count(*)::int AS n, count(DISTINCT (block_height, tx_index))::int AS txs
      FROM ${idx.sql(idx.mip)}.mip0018_contract_actions GROUP BY action ORDER BY action`;
    expect(actions).toEqual([{ action: "call", n: 60, txs: 58 }, { action: "deploy", n: 9, txs: 9 }, { action: "maintenance", n: 1, txs: 1 }]);
    const multi = await idx.sql<{ h: string; entry: string[] }[]>`
      SELECT block_height::text AS h, array_agg(entry_point ORDER BY segment_id, action_index) AS entry
      FROM ${idx.sql(idx.mip)}.mip0018_contract_actions WHERE action = 'call'
      GROUP BY block_height, tx_index HAVING count(*) > 1 ORDER BY 1`;
    expect(multi.map((m) => m.h)).toEqual(["714584", "714813"]);
    expect(multi.find((m) => m.h === "714813")!.entry).toEqual(["startWithdraw", "signBidirectional"]);
    const maint = await idx.sql<{ h: string; updates: string[] }[]>`
      SELECT block_height::text AS h, maintenance_updates AS updates FROM ${idx.sql(idx.mip)}.mip0018_contract_actions WHERE action = 'maintenance'`;
    expect(maint).toEqual([{ h: "715183", updates: ["VerifierKeyRemove(publishMetadata, v4)"] }]);
    const txs = await idx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${idx.sql(idx.archive)}.transactions WHERE net = ${NET} AND kind = 'regular'`;
    expect(txs[0]!.n).toBe(69); // 58 with calls + 9 deploys + 1 maintenance + 1 without contract action (714807)

    // U1: the mint at 715409 precedes the VerifierKeyInsert at 715428; the color resolves to U1's contract.
    const u1 = await fresh("u1");
    await archiveTape(u1.sql, u1.archive, loadRangeTape("u1"), 715402, 715433);
    const su = scanner(u1);
    await su.bootstrap();
    expect(await scanAll(su)).toBe(32);
    const u1Colors = await listColors(u1.sql, NET, u1.mip);
    expect(u1Colors.map((c) => [1, c.color, c.contractAddress, c.domainSep, c.shielded?.amount])).toEqual([CASE_MINTS[715409]]);
    expect(u1Colors[0]!.shielded!.firstMint.height).toBe(715409);
    const u1Actions = await u1.sql<{ h: string; action: string; updates: string[] | null }[]>`
      SELECT block_height::text AS h, action, maintenance_updates AS updates FROM ${u1.sql(u1.mip)}.mip0018_contract_actions ORDER BY block_height`;
    expect(u1Actions.map((a) => `${a.h}:${a.action}`)).toEqual(["715403:deploy", "715409:call", "715428:maintenance", "715433:call"]);
    expect(u1Actions.find((a) => a.action === "maintenance")!.updates![0]).toMatch(/^VerifierKeyInsert\(publishMetadata, v[34]\)$/);
  }, 600_000);

  it("[[mip0018.scan.failed-parts-excluded]] a FAILURE transaction and a failed fallible segment add no mint, color, sighting or action; the guaranteed part of a partial success does", async () => {
    // Real bytes: C04's two mint transactions reported as FAILURE.
    const failure = (h: number): IndexerBlock => {
      const b = structuredClone(C04.blocks.find((x) => x.height === h)!.indexerBlock);
      b.transactions[0]!.transactionResult = { status: "FAILURE", segments: null };
      return b;
    };
    const real = await fresh("failed");
    await archiveTape(real.sql, real.archive, C04, 714637, 714663, new Map([[714643, failure(714643)], [714649, failure(714649)]]));
    const s = scanner(real);
    await s.bootstrap();
    expect(await scanAll(s)).toBe(27);
    expect(await listColors(real.sql, NET, real.mip)).toEqual([]);
    expect(await nativeTokens(real.sql, NET, real.mip)).toEqual([]);
    const heights = await real.sql<{ h: string }[]>`SELECT block_height::text AS h FROM ${real.sql(real.mip)}.mip0018_contract_actions ORDER BY 1`;
    expect(heights.map((x) => Number(x.h))).toEqual([714637, 714655, 714663]);

    // Synthetic: segment 5 failed — its fallible mint, delta and UTXO do not apply; the guaranteed mint does.
    const syn = await fresh("failedsyn");
    const A = "c1".repeat(32);
    const DS_G = "01".repeat(32);
    const DS_F = "02".repeat(32);
    const tx = (hash: string, result: SynthArchivedTx["result"], segments: SynthArchivedTx["segments"]): SynthArchivedTx => ({
      result, segments,
      tx: {
        hash,
        fallibleDeltas: { 5: ["f5".repeat(32)] },
        intents: [{
          segment: 5, fallibleUtxos: ["f6".repeat(32)],
          actions: [{ call: { address: A, entryPoint: "mintBoth", guaranteed: { shieldedMints: [[DS_G, "10"]] }, fallible: { unshieldedMints: [[DS_F, "20"]] } } }, { deploy: { address: "d0".repeat(32) } }],
        }],
      },
    });
    await putSyntheticBlocks(syn.sql, syn.archive, NET, 100, [
      [tx("a1".repeat(32), "partial_success", [{ id: 5, success: false }])],
      [tx("a2".repeat(32), "failure", null)],
    ]);
    const s2 = scanner(syn, { decode: decodeSynthetic });
    await s2.bootstrap();
    expect(await scanAll(s2)).toBe(2);
    const colors = await listColors(syn.sql, NET, syn.mip);
    expect(colors.map((c) => [c.color, c.domainSep, c.shielded?.firstMint.height, c.unshielded])).toEqual([[tokenColor(DS_G, A), DS_G, 100, undefined]]);
    expect((await lookupColor(syn.sql, NET, tokenColor(DS_F, A), syn.mip)).found).toBe(false);
    expect((await nativeTokens(syn.sql, NET, syn.mip)).map((t) => t.color)).toEqual([tokenColor(DS_G, A)]);
    const actions = await syn.sql<{ action: string; applied_phases: string[] | null }[]>`SELECT action, applied_phases FROM ${syn.sql(syn.mip)}.mip0018_contract_actions`;
    expect(actions).toEqual([{ action: "call", applied_phases: ["guaranteed"] }]); // no deploy: its segment failed; nothing from the FAILURE
  }, 180_000);

  it("[[mip0018.scan.seen-then-minted]] a color seen in public data before any mint is listed as seen, then completed in place by its mint", async () => {
    const db = await fresh("seen");
    const A = "c2".repeat(32);
    const DS = "33".repeat(32);
    const X = tokenColor(DS, A);
    await putSyntheticBlocks(db.sql, db.archive, NET, 200, [
      [{ result: "success", tx: { hash: "b1".repeat(32), intents: [{ segment: 1, guaranteedUtxos: [X, "00".repeat(32)] }] } }],
      [],
      [{ result: "success", tx: { hash: "b3".repeat(32), guaranteedDeltas: [X], intents: [{ segment: 2, actions: [{ call: { address: A, entryPoint: "mint", guaranteed: { shieldedMints: [[DS, "5"]] } } }] }] } }],
    ]);
    const s = scanner(db, { decode: decodeSynthetic });
    await s.bootstrap();
    expect((await s.scanOnce({ maxBlocks: 2 })).scannedBlocks).toBe(2);
    const seen = await nativeTokens(db.sql, NET, db.mip);
    expect(seen).toEqual([{ color: X, firstSeen: { height: 200, txIndex: 0, txHash: "b1".repeat(32) }, evidence: ["unshielded-utxo"] }]);
    expect((await lookupColor(db.sql, NET, X, db.mip)).found).toBe(false);

    expect((await s.scanOnce()).scannedBlocks).toBe(1);
    const completed = await nativeTokens(db.sql, NET, db.mip);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ color: X, firstSeen: { height: 200, txHash: "b1".repeat(32) }, evidence: ["shielded-offer", "unshielded-utxo"], minted: { contractAddress: A, domainSep: DS, shielded: { firstMint: { height: 202 } } } });
    expect(completed[0]!.minted!.unshielded).toBeUndefined();
    expect((await lookupColor(db.sql, NET, X, db.mip)).found).toBe(true);
  }, 120_000);

  it("[[mip0018.scan.resume-identical]] batches, restarts and a crash inside a block give the same tables as one uninterrupted scan; a moved cursor is refused", async () => {
    const one = await fresh("resume");
    await archiveTape(one.sql, one.archive, C04, 714637, 714663);
    const uninterrupted = scanner(one);
    await uninterrupted.bootstrap();
    await scanAll(uninterrupted);
    const expected = await dumpScan(one.sql, one.mip);

    const two = await fresh("resume");
    await archiveTape(two.sql, two.archive, C04, 714637, 714663);
    await scanner(two).bootstrap();
    for (let i = 0; i < 3; i++) expect((await scanner(two).scanOnce({ maxBlocks: 4 })).scannedBlocks).toBe(4); // a new process each time
    const crashing = scanner(two, { onBlockWritten: (h) => { if (h === 714649) throw new Error("simulated crash before the checkpoint"); } });
    await expect(crashing.scanOnce()).rejects.toThrow(/simulated crash/);
    expect((await scanner(two).getCursor())?.nextHeight).toBe(714649);
    const at = await two.sql`SELECT 1 FROM ${two.sql(two.mip)}.mip0018_mints WHERE block_height = 714649`;
    expect(at).toHaveLength(0); // the block's rows rolled back with its cursor
    // Another writer moves the cursor while a block is being written: the compare-and-set refuses to interleave.
    const raced = scanner(two, { onBlockWritten: async () => { await two.sql`UPDATE ${two.sql(two.mip)}.mip0018_scan SET next_height = next_height + 1, last_block_hash = ${Buffer.alloc(32, 7)}`; } });
    await expect(raced.scanOnce({ maxBlocks: 1 })).rejects.toThrow(ScanError);
    await two.sql`UPDATE ${two.sql(two.mip)}.mip0018_scan SET next_height = 714649, last_block_hash = ${Buffer.from(C04.blocks.find((b) => b.height === 714648)!.blockHash.replace(/^0x/, ""), "hex")}`;
    await scanAll(scanner(two));
    expect(await dumpScan(two.sql, two.mip)).toEqual(expected);
  }, 180_000);

  it("[[mip0018.scan.remove-above]] removing everything above a height and scanning again gives the same tables", async () => {
    const db = await fresh("cut");
    await archiveTape(db.sql, db.archive, C04, 714637, 714663);
    const s = scanner(db);
    await s.bootstrap();
    await scanAll(s);
    const full = await dumpScan(db.sql, db.mip);
    await s.removeAbove(714645);
    expect(await s.getCursor()).toEqual({ fromHeight: 714637, nextHeight: 714646, lastBlockHash: C04.blocks.find((b) => b.height === 714645)!.blockHash.replace(/^0x/, "") });
    expect((await listColors(db.sql, NET, db.mip))[0]!.unshielded).toBeUndefined();
    await s.removeAbove(714700); // above the cursor: nothing to do
    await scanAll(s);
    expect(await dumpScan(db.sql, db.mip)).toEqual(full);
    await s.removeAbove(714636); // everything
    expect(await s.getCursor()).toEqual({ fromHeight: 714637, nextHeight: 714637, lastBlockHash: undefined });
    expect(await listColors(db.sql, NET, db.mip)).toEqual([]);
    await expect(s.removeAbove(714635)).rejects.toBeInstanceOf(ScanRangeError);
    await scanAll(s);
    expect(await dumpScan(db.sql, db.mip)).toEqual(full);
  }, 180_000);

  it("[[mip0018.scan.range-guards]] --from/--to, the archive's end, and inconsistent archive rows (gap, parent, result, partial success without segment outcomes, hash, undecodable) stop the scan with an error", async () => {
    const db = await fresh("range");
    await archiveTape(db.sql, db.archive, C04, 714637, 714650);
    await scanner(db).bootstrap();
    expect(await scanner(db, { network: "othernet" }).scanOnce()).toMatchObject({ scannedBlocks: 0, archiveHeight: undefined }); // nothing archived for it
    const bounded = scanner(db, { toHeight: 714645 });
    expect(await bounded.scanOnce()).toMatchObject({ scannedBlocks: 9, fromHeight: 714637, toHeight: 714645, reachedEnd: true, archiveHeight: 714650 });
    expect(await bounded.scanOnce()).toMatchObject({ scannedBlocks: 0, reachedEnd: true });
    expect(await scanner(db).scanOnce()).toMatchObject({ scannedBlocks: 5, toHeight: 714650, reachedEnd: false }); // stops at the archive's end
    await expect(scanner(db, { fromHeight: 714640 }).scanOnce()).rejects.toBeInstanceOf(ScanRangeError);
    expect(() => scanner(db, { fromHeight: 10, toHeight: 9 })).toThrow(ScanRangeError);
    expect(() => scanner(db, { fromHeight: -1 })).toThrow(ScanRangeError);
    await expect(scanner(db).scanOnce({ maxBlocks: 0 })).rejects.toBeInstanceOf(ScanRangeError);
    const below = await fresh("range");
    await archiveTape(below.sql, below.archive, C04, 714637, 714640);
    await scanner(below).bootstrap();
    await expect(scanner(below, { fromHeight: 714600 }).scanOnce()).rejects.toThrow(/below the archive's first height/);
    expect(await scanner(below, { fromHeight: 714639 }).scanOnce()).toMatchObject({ scannedBlocks: 2, fromHeight: 714639 });

    const ok: SynthArchivedTx = { result: "success", tx: { hash: "e0".repeat(32) } };
    const cases: Array<[string, SynthArchivedTx[][], RegExp, ((h: number) => string)?]> = [
      ["noresult", [[{ tx: { hash: "e1".repeat(32) } }]], /no stored result/],
      ["hash", [[{ result: "success", tx: { hash: "e2".repeat(32) }, archivedHash: "e3".repeat(32) }]], /differs from the archived/],
      ["parent", [[ok], [ok]], /parent/, (h) => (h === 301 ? "ff".repeat(32) : blockHashOf(NET, h - 1))],
      ["undecodable", [[{ result: "success", tx: { hash: "e4".repeat(32), intents: [{ segment: 1, actions: [{}] }] } }]], /e4e4.*at 300: .*unknown contract action/],
      // Mid-project audit F1: a partial success must give the outcome of every segment holding fallible content.
      ...([
        ["partialnull", null, /partial success without the outcome of any segment/],
        ["partialempty", [], /partial success without the outcome of any segment/],
        ["partialmissing", [{ id: 4, success: true }], /partial success without the outcome of segment\(s\) 5/],
      ] as const).map(([name, segments, error]): [string, SynthArchivedTx[][], RegExp] => [name, [[{
        result: "partial_success", segments: segments === null ? null : [...segments],
        tx: {
          hash: "e5".repeat(32),
          intents: [
            { segment: 4, actions: [{ call: { address: "c5".repeat(32), entryPoint: "g", guaranteed: { shieldedMints: [["04".repeat(32), "1"]] } } }] },
            { segment: 5, actions: [{ call: { address: "c5".repeat(32), entryPoint: "f", fallible: { unshieldedMints: [["05".repeat(32), "1"]] } } }] },
          ],
        },
      }]], error]),
    ];
    for (const [name, blocks, error, parentOf] of cases) {
      const bad = await fresh(`bad${name}`);
      await putSyntheticBlocks(bad.sql, bad.archive, NET, 300, blocks, parentOf === undefined ? {} : { parentOf });
      const s = scanner(bad, { decode: decodeSynthetic });
      await s.bootstrap();
      await expect(s.scanOnce(), name).rejects.toThrow(error);
      expect((await s.getCursor())?.nextHeight, name).toBe(name === "parent" ? 301 : 300);
    }
    // A gap in the archive (a block missing under its cursor) is never skipped.
    const gap = await fresh("gap");
    await putSyntheticBlocks(gap.sql, gap.archive, NET, 400, [[ok], [], []]);
    await gap.sql`DELETE FROM ${gap.sql(gap.archive)}.blocks WHERE height = 401`;
    const g = scanner(gap, { decode: decodeSynthetic });
    await g.bootstrap();
    await expect(g.scanOnce()).rejects.toThrow(/no canonical block 401/);
  }, 240_000);

  it("[[mip0018.scan.cli]] the scan CLI scans an archived range to --to and resumes at its cursor", async () => {
    const db = await fresh("cli");
    await archiveTape(db.sql, db.archive, C04, 714637, 714663);
    const lines: string[] = [];
    const env = { PG_URL: container.getConnectionUri() };
    const args = ["--network", NET, "--schema", db.mip, "--archive-schema", db.archive, "--from", "714637", "--to", "714650", "--max-blocks", "5"];
    expect(await scanCli(args, env, (l) => lines.push(l))).toBe(0);
    const done = JSON.parse(lines.at(-1)!) as { cursor: { nextHeight: number } };
    expect(done.cursor.nextHeight).toBe(714651);
    expect(lines.filter((l) => l.includes('"batch"'))).toHaveLength(3);
    expect(await scanCli(["--network", NET, "--schema", db.mip, "--archive-schema", db.archive], env, (l) => lines.push(l))).toBe(0);
    expect((JSON.parse(lines.at(-1)!) as { cursor: { nextHeight: number } }).cursor.nextHeight).toBe(714664);
    await expect(scanCli(["--network", NET], {}, () => {})).rejects.toThrow(/usage/);
    await expect(scanCli(["--network", NET, "--to", "x"], env, () => {})).rejects.toThrow(/non-negative integer/);
  }, 120_000);
});
