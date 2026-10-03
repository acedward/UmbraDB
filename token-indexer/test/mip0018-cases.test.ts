/**
 * Stagenet case comparison — the gaps (project 00026, sub-plan D2; spec FR-041, SC-002). The other dimensions of the
 * twelve cases are covered where they were built (sub-plan D, "D2 coverage table"): states at the range end
 * (`[[mip0018.metadata.recorded-cases]]`), C06 per step, groups, bytes, classification, colors, activity of colors.
 * This file adds what no test compared yet:
 *
 * - every case replayed only UP TO ITS OWN LAST BLOCK (the cases' expectations describe that moment), with the cases
 *   still to come absent at that point; C09 (a refused call, no transaction) = C01's state, unchanged;
 * - IDX and U1 against the reference's OWN index files (`IDX/expected.json`, `IDX/index-summary.json`,
 *   `U1/index-summary.json`: colors with first/last mints, deploys, the 35 v1-named events with position, bytes and
 *   classification, stats, last block), instead of constants typed into a test;
 * - the ✓/⚠ mark and `standards` tags of EVERY case identity (Q14 (a), A13), derived from the reference expectations
 *   and the reference index's rejections — an oracle independent of UmbraDB's `tokenMark`;
 * - every case contract's metadata transactions = the transactions the reference index lists for it.
 *
 * Expectations are never edited: verbatim copies of `midnight-experiments/mip-0018 @ daec1f1` in
 * `fixtures/mip0018-cases/` (SHA-256 checked against the D1 case index), UmbraDB's own per-key C06 files for the steps
 * after the tombstone (Q16/Q17). Single-member groups are excluded on both sides (Q6).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { type ArchiveTape, startFakeChain } from "../../test/integration/fixtures/stagenet-archive/fake-chain-server.js";
import { loadCaseIndex, loadManifest, loadRangeTape } from "../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import { activityForColor, type ActivityItem, metadataTransactionsForContract } from "../mip0018/activity.ts";
import { tokenColor } from "../mip0018/color.ts";
import { eventCounts, listEvents } from "../mip0018/events.ts";
import { getIdentity, listGroups, listIdentities, tokenMarkOf } from "../mip0018/metadata.ts";
import { Mip0018Scanner } from "../mip0018/scan.ts";
import { COMMON_KEY_HEX, type IdentityState, parseStandards } from "../mip0018/state.ts";
import { listColors, lookupColor } from "../mip0018/tokens.ts";
import { EVENT_NAME } from "../vendor/mip0018/codec/src/index.ts";

const NET = "stagenet";
const CASES_DIR = new URL("./fixtures/mip0018-cases/", import.meta.url);
const V1 = Buffer.from(EVENT_NAME).toString("hex");
const dec = new TextDecoder();

// ── The reference's shapes (expected.json, index-summary.json) ────────────────────────────────────────────────────

interface ExpectedField { key_text?: string; valType: number; value_hex: string; usable?: boolean }
interface ExpectedIdentity { domainSep: string; kind: number; visible: boolean; colored: boolean; common: Record<string, unknown>; fields?: Record<string, ExpectedField> }
interface ExpectedState { identities: ExpectedIdentity[]; groups: Array<{ symbol: string; members: Array<{ domainSep: string; kind: number }> }>; counts?: Record<string, number> }
interface IdxExpected { colors: Array<{ case: string; domainSep: string; kind: number; minted: boolean; identity: ExpectedIdentity }> }
interface MintPoint { height: number; blockHash: string; txHash: string }
interface MintStats { firstMint: MintPoint; lastMint: MintPoint; mints: number; amount: string }
interface RefColor { color: string; contractAddress: string; domainSep: string; shielded?: MintStats; unshielded?: MintStats }
interface RefEvent {
  block: { height: number; hash: string }; txHash: string; txIndex: number; eventIndex: number; phase: string; segment: number;
  entryPoint: string; name: string; payload: string; result: string; reason?: string; domainSep?: string; kind?: number;
}
interface IndexSummary {
  network: { genesisHash: string }; fromHeight: number; nextHeight: number; lastBlock: { height: number; hash: string };
  colors: Record<string, RefColor>; events: Record<string, RefEvent[]>; deploys: Record<string, MintPoint>;
  stats: { blocks: number; transactions: number; contractCalls: number; deploys: number; decodeErrors: number; mints: number; events: number };
  errors: unknown[];
}

const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, CASES_DIR), "utf8")) as T;
const sha = (path: string): string => createHash("sha256").update(readFileSync(new URL(path, CASES_DIR))).digest("hex");
const norm = (h: string): string => h.replace(/^0x/, "").toLowerCase();
const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x !== null && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x);

/** Usable common values in the expected-state shape (no defaults, nothing unusable). */
function commonOf(id: IdentityState): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const [name, keyHex] of Object.entries(COMMON_KEY_HEX)) {
    const f = id.fields.get(keyHex);
    if (f === undefined || f.usable !== true) continue;
    if (name === "decimals") c.decimals = f.integer! <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(f.integer) : f.integer!.toString();
    else if (name === "standards") c.standards = parseStandards(f.value)!.join(" ");
    else c[name] = dec.decode(f.value);
  }
  return c;
}

/** UmbraDB's state of one contract against an expectation ([] when equal): identities, visibility, colored, common
 *  fields, every field's bytes/type/usable flag where the expectation lists them, groups of two or more (Q6), counts. */
async function caseDifferences(sql: UmbraDBSql, schema: string, contract: string, expected: ExpectedState): Promise<string[]> {
  const d: string[] = [];
  const got = new Map((await listIdentities(sql, NET, { contractAddress: contract }, schema)).map((i) => [`${i.domainSep}/${i.kind}`, i]));
  const want = new Map(expected.identities.map((e) => [`${norm(e.domainSep)}/${e.kind}`, e]));
  for (const k of want.keys()) if (!got.has(k)) d.push(`identity ${k} expected, absent`);
  for (const k of got.keys()) if (!want.has(k)) d.push(`identity ${k} present, not expected`);
  for (const [k, e] of want) {
    const g = got.get(k);
    if (g === undefined) continue;
    if (e.visible !== true) d.push(`identity ${k}: expected hidden`);
    if (e.colored !== (g.kind !== 3)) d.push(`identity ${k}: colored`);
    if (canon(commonOf(g)) !== canon(e.common)) d.push(`identity ${k}: common ${canon(commonOf(g))}, expected ${canon(e.common)}`);
    if (e.fields !== undefined) {
      const gf = Object.fromEntries([...g.fields].map(([key, f]) => [key, { valType: f.valType, value_hex: Buffer.from(f.value).toString("hex"), ...(e.fields![key]?.usable === undefined ? {} : { usable: f.usable }) }]));
      const ef = Object.fromEntries(Object.entries(e.fields).map(([key, f]) => [key, { valType: f.valType, value_hex: f.value_hex, ...(f.usable === undefined ? {} : { usable: f.usable }) }]));
      if (canon(gf) !== canon(ef)) d.push(`identity ${k}: fields differ`);
    }
  }
  const multi = (gs: Array<{ symbol: string; members: string[] }>): string =>
    canon(gs.filter((g) => g.members.length >= 2).map((g) => ({ ...g, members: [...g.members].sort() })).sort((a, b) => (a.symbol < b.symbol ? -1 : 1)));
  const gotGroups = (await listGroups(sql, NET, { contractAddress: contract }, schema)).map((g) => ({ symbol: dec.decode(Buffer.from(g.symbol, "hex")), members: g.members.map((m) => `${m.domainSep}/${m.kind}`) }));
  const wantGroups = expected.groups.map((g) => ({ symbol: g.symbol, members: g.members.map((m) => `${norm(m.domainSep)}/${m.kind}`) }));
  if (multi(gotGroups) !== multi(wantGroups)) d.push(`groups ${multi(gotGroups)}, expected ${multi(wantGroups)}`);
  if (expected.counts !== undefined) {
    // The reference's counts have no `unresolved` (a D5 classification): none may exist in the recorded cases.
    const { unresolved, ...c } = await eventCounts(sql, NET, contract, schema);
    if (unresolved !== 0) d.push(`unresolved ${unresolved}`);
    if (canon(c) !== canon(expected.counts)) d.push(`counts ${canon(c)}, expected ${canon(expected.counts)}`);
  }
  return d;
}

describe("Stagenet case comparison — gaps (00026 D2)", () => {
  let container: StartedPostgreSqlContainer;
  const clients: UmbraDBSql[] = [];
  let counter = 0;
  const caseIndex = loadCaseIndex();
  const contractOf = (c: string): string => caseIndex.cases[c]!.contract!;
  const heightsOf = (c: string): number[] => caseIndex.cases[c]!.heights;
  /** Archive schemas of the two recorded ranges (filled once) and a full scan of each. */
  const archives = {} as Record<"idx" | "u1", { sql: UmbraDBSql; archive: string }>;
  const full = {} as Record<"idx" | "u1", { sql: UmbraDBSql; archive: string; mip: string }>;

  async function client(schema: string): Promise<UmbraDBSql> {
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    clients.push(sql);
    return sql;
  }

  async function archiveTape(sql: UmbraDBSql, archive: string, tape: ArchiveTape, from: number, to: number): Promise<void> {
    await bootstrapChainArchiveSchema(sql, archive);
    const f = await startFakeChain(tape);
    try {
      const svc = new ChainArchiveSyncService({
        sql, net: NET, schema: archive, node: { url: f.nodeUrl }, indexer: { url: f.indexerUrl },
        startHeight: from, endHeight: to, concurrency: 4, backoff: { jitter: false, baseDelayMs: 1, maxDelayMs: 5 },
      });
      expect((await svc.syncOnce({ maxBlocks: 1_000 })).reachedEnd).toBe(true);
    } finally {
      await f.close();
    }
  }

  /** A new `mip0018` schema over one of the archived ranges. */
  async function freshMip(range: "idx" | "u1"): Promise<{ sql: UmbraDBSql; archive: string; mip: string }> {
    const mip = `cases_mip_${counter++}`;
    return { sql: await client(mip), archive: archives[range].archive, mip };
  }

  const scanner = (db: { sql: UmbraDBSql; archive: string; mip: string }, toHeight?: number): Mip0018Scanner =>
    new Mip0018Scanner({ sql: db.sql, network: NET, schema: db.mip, archiveSchema: db.archive, ...(toHeight === undefined ? {} : { toHeight }) });

  async function scanTo(db: { sql: UmbraDBSql; archive: string; mip: string }, toHeight?: number): Promise<void> {
    const s = scanner(db, toHeight);
    await s.bootstrap();
    for (;;) {
      const r = await s.scanOnce({ maxBlocks: 1_000 });
      if (r.scannedBlocks === 0 || r.reachedEnd) return;
    }
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    for (const [range, from, to] of [["idx", 714485, 715183], ["u1", 715402, 715433]] as const) {
      const archive = `cases_arch_${range}`;
      const sql = await client(archive);
      await archiveTape(sql, archive, loadRangeTape(range), from, to);
      archives[range] = { sql, archive };
      full[range] = await freshMip(range);
      await scanTo(full[range]);
    }
  }, 300_000);

  afterAll(async () => {
    for (const c of clients) await c.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  it("[[mip0018.cases.stop-heights]] each case replayed only up to its own last block equals its expectation while every later case is still absent; earlier cases stay equal; C09 (refused call, no transaction) leaves C01's state unchanged; U1 at its last block", async () => {
    // The copies used here are the reference's bytes (C06's per-key file is UmbraDB's own, Q16/Q17).
    const recorded = new Map(caseIndex.source.files.map((f) => [f.path, f.sha256]));
    for (const c of ["C01", "C02", "C03", "C04", "C05", "C07", "C08", "C10", "U1"]) expect(sha(`${c}/expected.json`), c).toBe(recorded.get(`deployments/stagenet/cases/${c}/expected.json`));
    const IDX_CASES = ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C10"].sort((a, b) => Math.max(...heightsOf(a)) - Math.max(...heightsOf(b)));
    const expectation = (c: string): ExpectedState => read<ExpectedState>(c === "C06" ? "C06/umbradb-per-key/expected.json" : `${c}/expected.json`);
    const db = await freshMip("idx");
    const checked: string[] = [];
    for (const stop of IDX_CASES) {
      const last = Math.max(...heightsOf(stop));
      await scanTo(db, last);
      expect((await scanner(db).getCursor())?.nextHeight, stop).toBe(last + 1);
      for (const c of IDX_CASES) {
        const [first, end] = [Math.min(...heightsOf(c)), Math.max(...heightsOf(c))];
        if (end <= last) {
          expect(await caseDifferences(db.sql, db.mip, contractOf(c), expectation(c)), `${c} at ${stop}'s last block ${last}`).toEqual([]);
          checked.push(`${c}@${last}`);
        } else {
          expect(first > last, `${c} overlaps ${stop}`).toBe(true); // the recorded cases never interleave
          expect(await listIdentities(db.sql, NET, { contractAddress: contractOf(c) }, db.mip), `${c} before its first block`).toEqual([]);
          expect((await eventCounts(db.sql, NET, contractOf(c), db.mip)).events, `${c} before its first block`).toBe(0);
        }
      }
    }
    expect(checked).toHaveLength(45); // 9 + 8 + … + 1 comparisons
    // Negative controls: the comparison sees a wrong expectation (another case's file; C06's 78ecbb4 reference file,
    // identity-wide tombstones, which the per-key state must NOT match).
    expect(await caseDifferences(db.sql, db.mip, contractOf("C02"), expectation("C03"))).not.toEqual([]);
    expect(await caseDifferences(db.sql, db.mip, contractOf("C06"), read<ExpectedState>("C06/expected.json"))).not.toEqual([]);

    // C09: the non-owner's call was refused while it was built, so no transaction exists; its expectation is
    // byte-identical to C01's, and C01's contract carries exactly C01's one event at the end of the range.
    const c09 = caseIndex.cases.C09!;
    expect(c09.contract).toBe(contractOf("C01"));
    expect(c09.steps.every((s) => s.txHash === undefined && s.height === undefined)).toBe(true);
    expect(recorded.get("deployments/stagenet/cases/C09/expected.json")).toBe(recorded.get("deployments/stagenet/cases/C01/expected.json"));
    expect(await caseDifferences(db.sql, db.mip, contractOf("C09"), read<ExpectedState>("C01/expected.json"))).toEqual([]);
    expect(await eventCounts(db.sql, NET, contractOf("C09"), db.mip)).toEqual({ events: 1, accepted: 1, rejected: 0, ignored: 0, unresolved: 0 });

    // U1 at its last block (715433, the publish after the VerifierKeyInsert).
    const u1 = await freshMip("u1");
    await scanTo(u1, Math.max(...heightsOf("U1")));
    expect(await caseDifferences(u1.sql, u1.mip, contractOf("U1"), read<ExpectedState>("U1/expected.json"))).toEqual([]);
  }, 300_000);

  it("[[mip0018.cases.reference-index]] IDX and U1 equal the reference's own index files: expected.json (5 matrix colors, C04's two kinds on one color, C05 bronze not minted, each identity's metadata), index-summary.json (colors with first and last mint, deploys, the v1-named events with position, entry point, bytes and classification, stats, last block); exactly 6 colors in 714485–715183", async () => {
    const recorded = new Map(caseIndex.source.files.map((f) => [f.path, f.sha256]));
    for (const f of ["IDX/expected.json", "IDX/index-summary.json", "U1/index-summary.json"]) expect(sha(f), f).toBe(recorded.get(`deployments/stagenet/cases/${f}`));
    const genesis = `0x${norm(loadManifest().genesisHash)}`;

    /** UmbraDB's tables in the reference index's shape. */
    async function asIndex(db: { sql: UmbraDBSql; archive: string; mip: string }, from: number, to: number) {
      const { sql } = db;
      const m = sql(db.mip);
      const a = sql(db.archive);
      const blockHash = async (h: number): Promise<string> =>
        (await sql<{ h: Buffer }[]>`SELECT block_hash AS h FROM ${a}.blocks WHERE net = ${NET} AND height = ${h} AND is_canonical`)[0]!.h.toString("hex");
      const mints = await sql<{ color: Buffer; contract: Buffer; ds: Buffer; kind: number; height: string; tx: Buffer; amount: string }[]>`
        SELECT color, contract_address AS contract, domain_sep AS ds, kind, block_height::text AS height, tx_hash AS tx, amount::text AS amount
        FROM ${m}.mip0018_mints WHERE network = ${NET} ORDER BY color, kind, block_height, tx_index, mint_index`;
      const colors: Record<string, RefColor> = {};
      for (const r of mints) {
        const c = r.color.toString("hex");
        const e = (colors[c] ??= { color: c, contractAddress: r.contract.toString("hex"), domainSep: r.ds.toString("hex") });
        const key = r.kind === 1 ? "shielded" : "unshielded";
        const point = { height: Number(r.height), blockHash: await blockHash(Number(r.height)), txHash: r.tx.toString("hex") };
        const s = e[key];
        e[key] = s === undefined ? { firstMint: point, lastMint: point, mints: 1, amount: r.amount }
          : { ...s, lastMint: point, mints: s.mints + 1, amount: (BigInt(s.amount) + BigInt(r.amount)).toString() };
      }
      const deploys: Record<string, MintPoint> = {};
      for (const r of await sql<{ contract: Buffer; height: string; tx: Buffer }[]>`
        SELECT contract_address AS contract, block_height::text AS height, tx_hash AS tx FROM ${m}.mip0018_contract_actions
        WHERE network = ${NET} AND action = 'deploy' ORDER BY block_height, tx_index, segment_id, action_index`)
        deploys[r.contract.toString("hex")] = { height: Number(r.height), blockHash: await blockHash(Number(r.height)), txHash: r.tx.toString("hex") };
      const events: Record<string, RefEvent[]> = {};
      for (const e of (await listEvents(sql, NET, {}, db.mip)).filter((x) => x.name === V1)) {
        // entry_point is bytea (sub-plan C4 H1: arbitrary bytes on the ledger); the reference index writes it as text.
        const calls = await sql<{ entry: Buffer }[]>`
          SELECT entry_point AS entry FROM ${m}.mip0018_contract_actions
          WHERE network = ${NET} AND action = 'call' AND block_height = ${e.height} AND tx_index = ${e.txIndex}
            AND segment_id = ${e.segment} AND contract_address = ${Buffer.from(e.contractAddress, "hex")}`;
        expect(calls, `entry point of ${e.height}/${e.eventIndex}`).toHaveLength(1);
        (events[e.contractAddress] ??= []).push({
          block: { height: e.height, hash: await blockHash(e.height) }, txHash: e.txHash, txIndex: e.txIndex, eventIndex: e.eventIndex,
          phase: e.phase, segment: e.segment, entryPoint: new TextDecoder("utf-8", { fatal: true }).decode(calls[0]!.entry), name: e.name, payload: e.payload, result: e.classification,
          ...(e.reason === undefined ? {} : { reason: e.reason }), ...(e.domainSep === undefined ? {} : { domainSep: e.domainSep }), ...(e.kind === undefined ? {} : { kind: e.kind }),
        });
      }
      const count = async (q: Promise<{ n: number }[]>): Promise<number> => (await q)[0]!.n;
      const stats = {
        blocks: await count(sql`SELECT count(*)::int AS n FROM ${a}.blocks WHERE net = ${NET} AND height BETWEEN ${from} AND ${to}`),
        transactions: await count(sql`SELECT count(*)::int AS n FROM ${a}.transactions WHERE net = ${NET} AND kind = 'regular'`),
        contractCalls: await count(sql`SELECT count(DISTINCT (block_height, tx_index))::int AS n FROM ${m}.mip0018_contract_actions WHERE network = ${NET} AND action = 'call'`),
        deploys: Object.keys(deploys).length,
        decodeErrors: 0, // the scan stops at an undecodable transaction (Q20); it reached the end
        mints: mints.length,
        events: Object.values(events).flat().length,
      };
      const cursor = (await scanner(db).getCursor())!;
      return { network: { genesisHash: genesis }, fromHeight: cursor.fromHeight, nextHeight: cursor.nextHeight, lastBlock: { height: to, hash: await blockHash(to) }, colors, events, deploys, stats, errors: [] };
    }

    for (const [range, file, from, to] of [["idx", "IDX/index-summary.json", 714485, 715183], ["u1", "U1/index-summary.json", 715402, 715433]] as const) {
      const ref = read<IndexSummary>(file);
      const ours = await asIndex(full[range], from, to);
      const pick = (s: IndexSummary | typeof ours) => ({ network: { genesisHash: s.network.genesisHash }, fromHeight: s.fromHeight, nextHeight: s.nextHeight, lastBlock: s.lastBlock, colors: s.colors, events: s.events, deploys: s.deploys, stats: s.stats, errors: s.errors });
      expect(pick(ours), file).toEqual(pick(ref));
    }
    const idxRef = read<IndexSummary>("IDX/index-summary.json");
    expect([idxRef.stats.mints, Object.keys(idxRef.colors).length, idxRef.stats.events]).toEqual([7, 6, 35]);

    // IDX/expected.json: every matrix color (and C05 bronze, never minted) with its identity's metadata.
    const { sql, mip } = full.idx;
    const entries = read<IdxExpected>("IDX/expected.json").colors;
    expect(entries.map((e) => `${e.case}/${e.kind}/${e.minted}`)).toEqual(["C02/1/true", "C03/2/true", "C04/1/true", "C04/2/true", "C05/1/true", "C05/1/true", "C05/1/false"]);
    const matrixColors = new Set<string>();
    for (const e of entries) {
      const contract = contractOf(e.case);
      const color = tokenColor(norm(e.domainSep), contract);
      const found = await lookupColor(sql, NET, color, mip);
      expect(found.found, `${e.case} ${e.domainSep} minted`).toBe(e.minted);
      if (e.minted) {
        matrixColors.add(color);
        expect(e.kind === 1 ? found.entry!.shielded : found.entry!.unshielded, `${e.case} kind ${e.kind} minted`).toBeDefined();
        expect([found.entry!.contractAddress, found.entry!.domainSep]).toEqual([contract, norm(e.domainSep)]);
      }
      const id = await getIdentity(sql, { network: NET, contractAddress: contract, domainSep: norm(e.domainSep), kind: e.kind }, mip);
      expect(id, `${e.case} identity`).toBeDefined();
      expect({ domainSep: `0x${id!.domainSep}`, kind: id!.kind, visible: true, colored: id!.kind !== 3, common: commonOf(id!) }).toEqual(e.identity);
    }
    // Exactly 6 colors: the 5 matrix colors (C04's kinds share one) + the third party's mint at 714802 (no case).
    const colors = await listColors(sql, NET, mip);
    expect(matrixColors.size).toBe(5);
    expect(colors).toHaveLength(6);
    const extra = colors.filter((c) => !matrixColors.has(c.color));
    expect(extra.map((c) => [c.contractAddress, c.shielded?.firstMint.txHash])).toEqual([[
      caseIndex.otherTransactions.find((o) => o.height === 714802)!.calls[0], caseIndex.otherTransactions.find((o) => o.height === 714802)!.txHash,
    ]]);
    expect(Object.values(caseIndex.cases).some((c) => c.contract === extra[0]!.contractAddress)).toBe(false);
  }, 120_000);

  it("[[mip0018.cases.marks]] the ✓/⚠ mark and standards tags of every case identity — at the range end and after each C06 step — equal Q14 (a) applied to the reference expectations and the reference index's rejections (an oracle independent of tokenMark); the third party's minted token has no mark", async () => {
    const idxRef = read<IndexSummary>("IDX/index-summary.json");
    const u1Ref = read<IndexSummary>("U1/index-summary.json");
    const rejections = (contract: string): string[] =>
      [...(idxRef.events[contract] ?? []), ...(u1Ref.events[contract] ?? [])].filter((e) => e.result === "reject").map((e) => e.reason!);
    /** Q14 (a), owner-confirmed: ⚠ incorrect when the contract has a rejected MIP-0018 event; ✓ when name, symbol and
     *  decimals are usable; ⚠ partial otherwise; usable `standards` identifiers as tags. */
    const oracle = (e: ExpectedIdentity, contract: string) => {
      const missing = (["name", "symbol", "decimals"] as const).filter((k) => e.common[k] === undefined);
      const reasons = rejections(contract);
      const tags = typeof e.common.standards === "string" ? [...new Set(e.common.standards.split(" "))] : [];
      return { mark: reasons.length > 0 ? "incorrect" : missing.length === 0 ? "ok" : "partial", reasons, missing, tags };
    };
    const marksOf = async (db: { sql: UmbraDBSql; mip: string }, contract: string, expected: ExpectedState): Promise<Record<string, unknown>> => {
      const got: Record<string, unknown> = {};
      const want: Record<string, unknown> = {};
      for (const e of expected.identities) {
        const ref = { network: NET, contractAddress: contract, domainSep: norm(e.domainSep), kind: e.kind };
        got[`${ref.domainSep}/${ref.kind}`] = await tokenMarkOf(db.sql, ref, db.mip);
        want[`${ref.domainSep}/${ref.kind}`] = oracle(e, contract);
      }
      return { got, want };
    };
    const summary: Record<string, string[]> = {};
    for (const c of ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10", "U1"]) {
      const db = c === "U1" ? full.u1 : full.idx;
      const file = c === "C06" ? "C06/umbradb-per-key/expected.json" : c === "C09" ? "C01/expected.json" : `${c}/expected.json`;
      const { got, want } = await marksOf(db, contractOf(c), read<ExpectedState>(file));
      expect(got, c).toEqual(want);
      summary[c] = Object.values(got as Record<string, { mark: string; tags: string[] }>).map((m) => m.mark + (m.tags.length > 0 ? `+${m.tags.join(",")}` : ""));
    }
    expect(summary).toEqual({
      C01: ["ok"], C02: ["ok"], C03: ["ok"], C04: ["ok", "ok", "ok"], C05: ["ok", "ok", "ok"], C06: ["ok+mip-0004"],
      C07: ["incorrect"], C08: ["incorrect"], C09: ["ok"], C10: ["ok+mip-0004"], U1: ["ok"],
    });
    // Every identity of the cases' contracts was checked (none left out of the expectations).
    for (const c of ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C10"])
      expect((await listIdentities(full.idx.sql, NET, { contractAddress: contractOf(c) }, full.idx.mip)).length, c).toBe(read<ExpectedState>(c === "C06" ? "C06/umbradb-per-key/expected.json" : `${c}/expected.json`).identities.length);

    // C06 step by step: ✓ after publish and rename, ⚠ partial (no name) after the withdraw and the withdraw again,
    // ✓ after the revive — each from the step's expectation through the same oracle.
    const steps = caseIndex.cases.C06!.steps.filter((s) => s.expectedAfter !== undefined);
    const perKey = new Set(["withdraw", "withdraw-again", "revive"]);
    const db = await freshMip("idx");
    const seen: string[] = [];
    for (const s of steps) {
      await scanTo(db, s.height!);
      const { got, want } = await marksOf(db, contractOf("C06"), read<ExpectedState>(perKey.has(s.id) ? `C06/umbradb-per-key/${s.expectedAfter!}` : `C06/${s.expectedAfter!}`));
      expect(got, s.id).toEqual(want);
      seen.push(`${s.id}:${Object.values(got as Record<string, { mark: string; missing: string[] }>).map((m) => m.mark + (m.missing.length > 0 ? `(${m.missing.join(",")})` : "")).join()}`);
    }
    expect(seen).toEqual(["publish:ok", "rename:ok", "withdraw:partial(name)", "withdraw-again:partial(name)", "revive:ok"]);

    // The only minted token outside the cases (contract 7771c9e5…, 714802) never emitted an event: no mark.
    const third = (await listColors(full.idx.sql, NET, full.idx.mip)).find((c) => !Object.values(caseIndex.cases).some((k) => k.contract === c.contractAddress))!;
    expect(await tokenMarkOf(full.idx.sql, { network: NET, contractAddress: third.contractAddress, domainSep: third.domainSep, kind: 1 }, full.idx.mip))
      .toEqual({ mark: "none", reasons: [], missing: [], tags: [] });
  }, 180_000);

  it("[[mip0018.cases.activity]] every case contract's metadata transactions are exactly the transactions the reference index lists for it, with its accepted/rejected counts (C07's other-name steps and C09's refused call add none); C05 bronze, never minted, has no color activity", async () => {
    const all = async (db: { sql: UmbraDBSql; mip: string }, contract: string): Promise<ActivityItem[]> => {
      const out: ActivityItem[] = [];
      let cursor: string | undefined;
      do {
        const p = await metadataTransactionsForContract(db.sql, NET, contract, cursor === undefined ? {} : { cursor }, db.mip);
        out.push(...p.items);
        cursor = p.nextCursor;
      } while (cursor !== undefined);
      return out;
    };
    const rows: Record<string, number> = {};
    for (const c of ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C10", "U1"]) {
      const ref = read<IndexSummary>(c === "U1" ? "U1/index-summary.json" : "IDX/index-summary.json").events[contractOf(c)] ?? [];
      const perTx = new Map<string, { height: number; accepted: number; rejected: number; firstEventIndex: number }>();
      for (const e of ref) {
        const t = perTx.get(e.txHash) ?? { height: e.block.height, accepted: 0, rejected: 0, firstEventIndex: e.eventIndex };
        if (e.result === "accept") t.accepted++;
        else t.rejected++;
        t.firstEventIndex = Math.min(t.firstEventIndex, e.eventIndex);
        perTx.set(e.txHash, t);
      }
      const items = await all(c === "U1" ? full.u1 : full.idx, contractOf(c));
      expect(items.map((i) => [i.txHash, i.height, i.events]), c).toEqual([...perTx].map(([tx, t]) => [tx, t.height, { accepted: t.accepted, rejected: t.rejected, firstEventIndex: t.firstEventIndex }]));
      // …and they are transactions of the case's own steps.
      const stepTx = new Set(caseIndex.cases[c]!.steps.map((s) => s.txHash));
      expect(items.every((i) => stepTx.has(i.txHash)), c).toBe(true);
      rows[c] = items.length;
    }
    expect(rows).toEqual({ C01: 1, C02: 1, C03: 1, C04: 1, C05: 3, C06: 5, C07: 18, C08: 1, C10: 1, U1: 1 });
    // C07: 22 event-emitting steps, the four I-steps (other names) are not metadata transactions (Q19, A16).
    const c07Steps = caseIndex.cases.C07!.steps.filter((s) => (s.observedEventIds ?? []).length > 0).map((s) => s.id);
    expect(c07Steps).toHaveLength(22);
    const c07Tx = new Set((await all(full.idx, contractOf("C07"))).map((i) => i.txHash));
    expect(c07Steps.filter((id) => !c07Tx.has(caseIndex.cases.C07!.steps.find((s) => s.id === id)!.txHash ?? ""))).toEqual(["I1a", "I1b", "I2a", "I2b"]);
    // C09 (C01's contract): only C01's publish.
    expect((await all(full.idx, contractOf("C09"))).map((i) => i.txHash)).toEqual([caseIndex.cases.C01!.steps.find((s) => s.id === "publish")!.txHash]);
    // C05 bronze: described, never minted → no mint row and no activity for its color.
    const bronze = tokenColor(Buffer.concat([Buffer.from("mip-0018:example:family:bronze"), Buffer.alloc(32)]).subarray(0, 32).toString("hex"), contractOf("C05"));
    expect(await activityForColor(full.idx.sql, NET, bronze, {}, full.idx.mip)).toEqual({ items: [] });
  }, 120_000);
});
