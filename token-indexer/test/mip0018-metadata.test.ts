/**
 * UmbraDB's MIP-0018 metadata state in Postgres (project 00026, sub-plan B3; spec FR-012…FR-015, FR-020; MIP
 * `274a84f` "Applying records", "Common fields", "Symbol grouping"): the scan applies every accepted event to the
 * latest-value rows in its block transaction, a Null record deletes its key's row, an identity with no row is not
 * referenced by any read helper, `removeAbove` recomputes exactly, and the marks and groups come from the pure module.
 *
 * Data: the recorded Stagenet ranges of sub-plan D1 (`loadRangeTape`), archived by the real sync against the fake
 * chain and scanned by the real scanner; synthetic archive blocks for what Stagenet does not show (a whole withdrawal,
 * shared rows, a partial token, a 31-byte integer).
 *
 * Expectations: the reference's case files (midnight-experiments/mip-0018 @ daec1f1, copied verbatim into
 * `fixtures/mip0018-cases/`, SHA-256 checked against `case-index.json`), and — for C06's steps after the tombstone —
 * UmbraDB's own per-key expectations (`fixtures/mip0018-cases/C06/umbradb-per-key/`, Q16/Q17; provenance in that
 * folder's README). Single-member groups are excluded on both sides (Q6).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { type ArchiveTape, startFakeChain } from "../../test/integration/fixtures/stagenet-archive/fake-chain-server.js";
import { loadCaseIndex, loadRangeTape } from "../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import { tokenColor } from "../mip0018/color.ts";
import { eventCounts } from "../mip0018/events.ts";
import { recomputeFields } from "../mip0018/fields.ts";
import {
  chainEvents, contractRejections, displayAmountOf, getIdentity, groupOf, listGroups, listIdentities, listMetadataContracts, tokenMarkOf,
} from "../mip0018/metadata.ts";
import { Mip0018Scanner } from "../mip0018/scan.ts";
import { COMMON_KEY_HEX, type IdentityRef, type IdentityState, parseStandards, type SymbolGroup } from "../mip0018/state.ts";
import { listColors, nativeTokens } from "../mip0018/tokens.ts";
import { EVENT_NAME, encodePayload, type MetadataRecord, record } from "../vendor/mip0018/codec/src/index.ts";
import { decodeSynthetic, putSyntheticBlocks, type SynthLog } from "./helpers/synthetic-archive.ts";

const NET = "stagenet";
const CASES_DIR = new URL("./fixtures/mip0018-cases/", import.meta.url);

// ── Expected-state shape (the reference's `expected.json`) ───────────────────────────────────────────────────────

interface ExpectedField { key_text?: string; valType: number; value_hex: string; usable?: boolean }
interface ExpectedIdentity { domainSep: string; kind: number; visible: boolean; colored: boolean; common: Record<string, unknown>; fields?: Record<string, ExpectedField> }
interface ExpectedState { identities: ExpectedIdentity[]; groups: Array<{ symbol: string; members: Array<{ domainSep: string; kind: number }> }>; counts?: Record<string, number> }

const readCase = (path: string): ExpectedState => JSON.parse(readFileSync(new URL(path, CASES_DIR), "utf8")) as ExpectedState;
const norm = (h: string): string => h.replace(/^0x/, "").toLowerCase();
const dec = new TextDecoder();

/** Usable common values, in the expected-state shape (no defaults, no unusable values). */
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

const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x !== null && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x);

/** Differences between UmbraDB's state of one contract (read helpers) and an expectation; [] when equal. */
async function differences(sql: UmbraDBSql, schema: string, contract: string, expected: ExpectedState): Promise<string[]> {
  const d: string[] = [];
  const ids = await listIdentities(sql, NET, { contractAddress: contract }, schema);
  const got = new Map(ids.map((i) => [`${i.domainSep}/${i.kind}`, i]));
  // A hidden identity with no fields (the reference's whole-identity tombstone) equals an absent one.
  const want = new Map(expected.identities.filter((e) => e.visible || Object.keys(e.common).length > 0 || Object.keys(e.fields ?? {}).length > 0).map((e) => [`${norm(e.domainSep)}/${e.kind}`, e]));
  for (const k of want.keys()) if (!got.has(k)) d.push(`identity ${k} expected, absent`);
  for (const k of got.keys()) if (!want.has(k)) d.push(`identity ${k} present, not expected`);
  for (const [k, e] of want) {
    const g = got.get(k);
    if (g === undefined) continue;
    if (!e.visible) d.push(`identity ${k}: expected hidden with values (not a per-key state)`);
    if (e.colored !== (g.kind !== 3)) d.push(`identity ${k}: colored`);
    if (canon(commonOf(g)) !== canon(e.common)) d.push(`identity ${k}: common ${canon(commonOf(g))}, expected ${canon(e.common)}`);
    if (e.fields !== undefined) {
      const gf = Object.fromEntries([...g.fields].map(([key, f]) => [key, { valType: f.valType, value_hex: Buffer.from(f.value).toString("hex"), ...(f.usable === undefined ? {} : { usable: f.usable }) }]));
      const ef = Object.fromEntries(Object.entries(e.fields).map(([key, f]) => [key, { valType: f.valType, value_hex: f.value_hex, ...(f.usable === undefined ? {} : { usable: f.usable }) }]));
      if (canon(gf) !== canon(ef)) d.push(`identity ${k}: fields ${canon(gf)}, expected ${canon(ef)}`);
    }
  }
  const multi = (gs: Array<{ symbol: string; members: string[] }>) => canon(gs.filter((g) => g.members.length >= 2).map((g) => ({ ...g, members: [...g.members].sort() })).sort((a, b) => (a.symbol < b.symbol ? -1 : 1)));
  const gotGroups = (await listGroups(sql, NET, { contractAddress: contract }, schema)).map((g: SymbolGroup) => ({ symbol: dec.decode(Buffer.from(g.symbol, "hex")), members: g.members.map((m) => `${m.domainSep}/${m.kind}`) }));
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

const hex = (b: Buffer): string => b.toString("hex");
/** Every scan table and the field rows, in key order — what "identical" means for a resumed or recomputed scan. */
async function dumpAll(sql: UmbraDBSql, schema: string): Promise<Record<string, unknown[]>> {
  const s = sql(schema);
  const rows = (rs: readonly Record<string, unknown>[]): unknown[] =>
    rs.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Buffer.isBuffer(v) ? hex(v) : typeof v === "bigint" ? v.toString() : v])));
  return {
    scan: rows(await sql`SELECT * FROM ${s}.mip0018_scan ORDER BY network`),
    mints: rows(await sql`SELECT * FROM ${s}.mip0018_mints ORDER BY network, block_height, tx_index, mint_index`),
    sightings: rows(await sql`SELECT * FROM ${s}.mip0018_color_sightings ORDER BY network, color, evidence`),
    actions: rows(await sql`SELECT * FROM ${s}.mip0018_contract_actions ORDER BY network, block_height, tx_index, segment_id, action_index`),
    events: rows(await sql`SELECT * FROM ${s}.mip0018_events ORDER BY network, block_height, tx_index, event_index`),
    fields: rows(await sql`SELECT * FROM ${s}.mip0018_fields ORDER BY network, contract_address, domain_sep, kind, key`),
    withdrawals: rows(await sql`SELECT * FROM ${s}.mip0018_withdrawals ORDER BY network, contract_address, domain_sep, kind`),
    listed: rows(await sql`SELECT * FROM ${s}.mip0018_listed_events ORDER BY network, block_height, tx_index, event_index`),
  };
}

/** A `Misc` log item `name ‖ payload` for synthetic blocks, with trailing zeros dropped as the ledger does. */
function v1Log(domainSep: string, kind: number, records: MetadataRecord[]): SynthLog {
  const data = Buffer.from([...EVENT_NAME, ...encodePayload({ domainSep: Uint8Array.from(Buffer.from(domainSep, "hex")), kind }, records)]);
  let end = data.length;
  while (end > 0 && data[end - 1] === 0) end--;
  return { data: data.subarray(0, end).toString("hex") };
}
const nullAll = (...keys: string[]): MetadataRecord[] => keys.map((k) => record.tombstone(k));

describe("MIP-0018 metadata state in Postgres (00026 B3)", () => {
  let container: StartedPostgreSqlContainer;
  const clients: UmbraDBSql[] = [];
  let counter = 0;
  const ranges: Record<"idx" | "u1", { sql: UmbraDBSql; mip: string }> = {} as never;
  const caseIndex = loadCaseIndex();
  const contractOf = (c: string): string => caseIndex.cases[c]!.contract!;

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
    try {
      const svc = new ChainArchiveSyncService({
        sql: db.sql, net: NET, schema: db.archive, node: { url: f.nodeUrl }, indexer: { url: f.indexerUrl },
        startHeight: from, endHeight: to, concurrency: 4, backoff: { jitter: false, baseDelayMs: 1, maxDelayMs: 5 },
      });
      expect((await svc.syncOnce({ maxBlocks: 1_000 })).reachedEnd).toBe(true);
    } finally {
      await f.close();
    }
  }

  const scanner = (db: { sql: UmbraDBSql; archive: string; mip: string }, extra: Partial<ConstructorParameters<typeof Mip0018Scanner>[0]> = {}) =>
    new Mip0018Scanner({ sql: db.sql, network: NET, schema: db.mip, archiveSchema: db.archive, ...extra });

  async function scanAll(s: Mip0018Scanner): Promise<number> {
    let blocks = 0;
    for (;;) {
      const r = await s.scanOnce({ maxBlocks: 1_000 });
      blocks += r.scannedBlocks;
      if (r.scannedBlocks === 0 || r.reachedEnd) return blocks;
    }
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    for (const [name, from, to] of [["idx", 714485, 715183], ["u1", 715402, 715433]] as const) {
      const db = await fresh(name);
      await archiveTape(db, loadRangeTape(name), from, to);
      const s = scanner(db);
      await s.bootstrap();
      await scanAll(s);
      ranges[name] = { sql: db.sql, mip: db.mip };
    }
  }, 300_000);

  afterAll(async () => {
    for (const c of clients) await c.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  it("[[mip0018.metadata.recorded-cases]] every recorded case's state equals its expectation (C01–C05, C07, C08, C10, U1 reference files; C06 UmbraDB's per-key final state); the copies are the reference's bytes; a full recompute from the log changes nothing", async () => {
    // The verbatim copies: SHA-256 equal to what the recorded case index holds for the reference paths.
    const recorded = new Map(caseIndex.source.files.map((f) => [f.path, f.sha256]));
    const copies = ["C01", "C02", "C03", "C04", "C05", "C07", "C08", "C10", "U1"].map((c) => `${c}/expected.json`)
      .concat(["expected.json", "expected-after-publish.json", "expected-after-rename.json", "expected-after-withdraw.json", "expected-after-withdraw-again.json", "expected-after-revive.json"].map((f) => `C06/${f}`));
    for (const f of copies)
      expect(createHash("sha256").update(readFileSync(new URL(f, CASES_DIR))).digest("hex"), f).toBe(recorded.get(`deployments/stagenet/cases/${f}`));

    const results: Record<string, string[]> = {};
    for (const c of ["C01", "C02", "C03", "C04", "C05", "C07", "C08", "C10", "U1"]) {
      const range = c === "U1" ? ranges.u1 : ranges.idx;
      results[c] = await differences(range.sql, range.mip, contractOf(c), readCase(`${c}/expected.json`));
    }
    results.C06 = await differences(ranges.idx.sql, ranges.idx.mip, contractOf("C06"), readCase("C06/umbradb-per-key/expected.json"));
    expect(results).toEqual({ C01: [], C02: [], C03: [], C04: [], C05: [], C06: [], C07: [], C08: [], C10: [], U1: [] });
    // The reference's identity-wide C06 expectation does NOT describe the per-key state (why UmbraDB keeps its own).
    expect(await differences(ranges.idx.sql, ranges.idx.mip, contractOf("C06"), readCase("C06/expected.json"))).not.toEqual([]);

    // Incremental apply = replay of the stored log (fields, and the withdrawals and listed events of re-check R2).
    const { sql, mip } = ranges.idx;
    const derived = (d: Record<string, unknown[]>) => ({ fields: d.fields, withdrawals: d.withdrawals, listed: d.listed });
    const before = derived(await dumpAll(sql, mip));
    expect([before.withdrawals!.length, before.listed!.length]).toEqual([0, 35]); // per-key C06 never empties; 25 accepted + 10 rejected
    const r = await sql.begin((tx) => recomputeFields(tx, mip, NET));
    expect(r).toEqual({ identities: 13, replayedEvents: 25 });
    expect(derived(await dumpAll(sql, mip))).toEqual(before);
  }, 120_000);

  it("[[mip0018.metadata.recorded-groups]] symbol groups on the recorded ranges: exactly C04's ACD (kinds 1, 2, 3) and C05's MEDAL (three domainSeps, bronze never minted); no single-member group is reported", async () => {
    const groups = await listGroups(ranges.idx.sql, NET, {}, ranges.idx.mip);
    const C04_DS = "6d69702d303031383a6578616d706c653a6d756c74692d6b696e640000000000";
    const medal = (metal: string) => Buffer.concat([Buffer.from(`mip-0018:example:family:${metal}`), Buffer.alloc(32)]).subarray(0, 32).toString("hex");
    expect(groups.map((g) => [g.contractAddress, dec.decode(Buffer.from(g.symbol, "hex")), g.members.map((m) => `${m.domainSep}/${m.kind}`)])).toEqual([
      [contractOf("C04"), "ACD", [`${C04_DS}/1`, `${C04_DS}/2`, `${C04_DS}/3`]],
      [contractOf("C05"), "MEDAL", [`${medal("bronze")}/1`, `${medal("gold")}/1`, `${medal("silver")}/1`]],
    ]);
    expect(groups.every((g) => g.members.length >= 2)).toBe(true);
    expect(await listGroups(ranges.u1.sql, NET, {}, ranges.u1.mip)).toEqual([]); // U1: one identity → no group
    // groupOf: the identity's own group, or none when it is alone with its symbol.
    const c04: IdentityRef = { network: NET, contractAddress: contractOf("C04"), domainSep: C04_DS, kind: 2 };
    expect((await groupOf(ranges.idx.sql, c04, ranges.idx.mip))?.members).toHaveLength(3);
    const c01 = (await listIdentities(ranges.idx.sql, NET, { contractAddress: contractOf("C01") }, ranges.idx.mip))[0]!;
    expect(await groupOf(ranges.idx.sql, c01, ranges.idx.mip)).toBeUndefined();
  }, 120_000);

  it("[[mip0018.metadata.c06-steps]] C06 replayed step by step (case-index heights): publish and rename equal the reference files; withdraw (Null at name), withdraw again and revive equal UmbraDB's per-key expectations; removing the tombstone block restores the rename state and re-adding it applies the tombstone again", async () => {
    const steps = caseIndex.cases.C06!.steps.filter((s) => s.expectedAfter !== undefined);
    expect(steps.map((s) => [s.id, s.height])).toEqual([["publish", 714796], ["rename", 714804], ["withdraw", 714813], ["withdraw-again", 714827], ["revive", 714835]]);
    const perKey = new Set(["withdraw", "withdraw-again", "revive"]);
    const db = await fresh("c06");
    await archiveTape(db, loadRangeTape("idx"), 714789, 714835);
    await scanner(db).bootstrap();
    const C06 = contractOf("C06");
    const ref: IdentityRef = { network: NET, contractAddress: C06, domainSep: "11".repeat(32), kind: 3 };
    for (const step of steps) {
      await scanAll(scanner(db, { toHeight: step.height! }));
      expect((await scanner(db).getCursor())?.nextHeight).toBe(step.height! + 1);
      const own = perKey.has(step.id);
      const expected = readCase(own ? `C06/umbradb-per-key/${step.expectedAfter!}` : `C06/${step.expectedAfter!}`);
      expect(await differences(db.sql, db.mip, C06, expected), step.id).toEqual([]);
      if (own) expect(await differences(db.sql, db.mip, C06, readCase(`C06/${step.expectedAfter!}`)), `${step.id} (reference, 78ecbb4)`).not.toEqual([]);
    }
    // Row level: the withdraw deleted exactly the `name` row; the revive re-set name and symbol only.
    const keys = async () => [...((await getIdentity(db.sql, ref, db.mip))?.fields.keys() ?? [])].map((k) => Buffer.from(k, "hex").toString());
    expect(await keys()).toEqual(["decimals", "standards", "name", "symbol"]);
    const events = await chainEvents(db.sql, NET, { contractAddress: C06 }, db.mip);
    expect(events.map((e) => [e.height, e.classification, e.identity?.kind])).toEqual([[714796, "accept", 3], [714804, "accept", 3], [714813, "accept", 3], [714827, "accept", 3], [714835, "accept", 3]]);
    expect(events.every((e) => !("name" in e) && !("payload" in e))).toBe(true); // QA2: never the bytes

    // S4 on recorded data: remove the tombstone block (and everything after), then add the blocks again.
    const full = await dumpAll(db.sql, db.mip);
    await scanner(db).removeAbove(714812);
    expect(await differences(db.sql, db.mip, C06, readCase("C06/expected-after-rename.json"))).toEqual([]);
    expect(await keys()).toEqual(["decimals", "standards", "name", "symbol"]); // the rename's name/symbol are current again
    await scanAll(scanner(db, { toHeight: 714813 }));
    expect(await differences(db.sql, db.mip, C06, readCase("C06/umbradb-per-key/expected-after-withdraw.json"))).toEqual([]);
    await scanAll(scanner(db));
    expect(await dumpAll(db.sql, db.mip)).toEqual(full);
  }, 180_000);

  it("[[mip0018.metadata.shared-rows]] two identities of one contract (Q15): withdrawing one removes it from every read helper while the shared entries stay; withdrawing the last removes the shared entries too; mints stay; a later record revives only that field; removeAbove restores both", async () => {
    const db = await fresh("shared");
    const X = "c7".repeat(32);
    const DS = "77".repeat(32);
    const both = (logs: SynthLog[], mints: Array<[string, string]> = []) => [{ result: "success" as const, tx: {
      hash: createHash("sha256").update(JSON.stringify(logs) + mints.length).digest("hex"),
      intents: [{ segment: 1, actions: [{ call: { address: X, entryPoint: "meta", guaranteed: { logs, shieldedMints: mints } } }] }],
    } }];
    const common = [record.utf8("name", "Shared"), record.utf8("symbol", "SHR"), record.uint("decimals", 3), record.utf8("standards", "mip-0011")];
    await putSyntheticBlocks(db.sql, db.archive, NET, 100, [
      both([v1Log(DS, 1, common), v1Log(DS, 3, common)], [[DS, "10"]]), // 100: mint (kind 1) + both identities described
      both([v1Log(DS, 3, nullAll("name", "symbol", "decimals", "standards", "retire"))]), // 101: kind 3 withdrawn (+ a Null without value)
      both([v1Log(DS, 1, nullAll("standards", "decimals", "symbol", "name"))]), // 102: kind 1 withdrawn: the last one
      both([v1Log(DS, 3, [record.utf8("name", "Back")])]), // 103: kind 3 revived with only `name`
    ]);
    const s = scanner(db, { decode: decodeSynthetic });
    await s.bootstrap();
    const k1: IdentityRef = { network: NET, contractAddress: X, domainSep: DS, kind: 1 };
    const k3: IdentityRef = { ...k1, kind: 3 };
    const color = tokenColor(DS, X);
    const view = async () => ({
      ids: (await listIdentities(db.sql, NET, {}, db.mip)).map((i) => i.kind),
      contracts: await listMetadataContracts(db.sql, NET, db.mip),
      groups: (await listGroups(db.sql, NET, {}, db.mip)).map((g) => g.members.map((m) => m.kind)),
      k1: (await getIdentity(db.sql, k1, db.mip)) === undefined ? "absent" : "present",
      k3: (await getIdentity(db.sql, k3, db.mip)) === undefined ? "absent" : "present",
      marks: [(await tokenMarkOf(db.sql, k1, db.mip)).mark, (await tokenMarkOf(db.sql, k3, db.mip)).mark],
      display: [(await displayAmountOf(db.sql, k1, 12345n, db.mip))?.text ?? null, (await displayAmountOf(db.sql, k3, 12345n, db.mip))?.text ?? null],
      events: (await chainEvents(db.sql, NET, {}, db.mip)).map((e) => `${e.height}:${e.identity === undefined ? "-" : e.identity.kind}`),
      rows: Number((await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${db.sql(db.mip)}.mip0018_fields`)[0]!.n),
      colors: (await listColors(db.sql, NET, db.mip)).map((c) => c.color),
      seen: (await nativeTokens(db.sql, NET, db.mip)).map((t) => t.color),
    });

    await s.scanOnce({ maxBlocks: 1 });
    const at100 = await view();
    expect(at100).toEqual({
      ids: [1, 3], contracts: [{ contractAddress: X, identities: 2 }], groups: [[1, 3]], k1: "present", k3: "present", marks: ["ok", "ok"],
      display: ["12.345", "12.345"], events: ["100:1", "100:3"], rows: 8, colors: [color], seen: [color],
    });

    await s.scanOnce({ maxBlocks: 1 });
    expect(await view()).toEqual({
      ids: [1], contracts: [{ contractAddress: X, identities: 1 }], groups: [], k1: "present", k3: "absent", marks: ["ok", "none"],
      display: ["12.345", null], events: ["100:1", "100:-", "101:-"], rows: 4, colors: [color], seen: [color],
    });
    expect(JSON.stringify(await listIdentities(db.sql, NET, { kind: 3 }, db.mip))).toBe("[]");

    await s.scanOnce({ maxBlocks: 1 });
    const at102 = await view();
    expect(at102).toEqual({
      ids: [], contracts: [], groups: [], k1: "absent", k3: "absent", marks: ["none", "none"],
      display: [null, null], events: ["100:-", "100:-", "101:-", "102:-"], rows: 0, colors: [color], seen: [color],
    });

    await s.scanOnce({ maxBlocks: 1 });
    const revived = await getIdentity(db.sql, k3, db.mip);
    expect([...revived!.fields.keys()]).toEqual([COMMON_KEY_HEX.name]); // nothing from before the tombstones returns
    // Re-check R2: the revived identity's history starts at its revival — its earlier events stay unattributed.
    expect((await view()).events).toEqual(["100:-", "100:-", "101:-", "102:-", "103:3"]);
    expect(await tokenMarkOf(db.sql, k3, db.mip)).toEqual({ mark: "partial", reasons: [], missing: ["symbol", "decimals"], tags: [] });
    expect((await view()).contracts).toEqual([{ contractAddress: X, identities: 1 }]);

    // S4 across both withdrawals: back to the state after block 100, then forward again.
    const full = await dumpAll(db.sql, db.mip);
    await s.removeAbove(100);
    expect(await view()).toEqual(at100);
    await scanAll(s);
    expect(await dumpAll(db.sql, db.mip)).toEqual(full);
  }, 120_000);

  it("[[mip0018.metadata.bytes]] C07's keys and values round-trip as exact bytes (a NUL inside a key, a non-UTF-8 key, a 220-byte key, a 219-byte value, empty values, a 16-byte integer); a 31-byte integer is stored losslessly", async () => {
    const { sql, mip } = ranges.idx;
    const [c07] = await listIdentities(sql, NET, { contractAddress: contractOf("C07") }, mip);
    const fields = c07!.fields;
    const keyOf = (text: string) => Buffer.from(text, "latin1").toString("hex");
    expect(fields.get(keyOf("symbol\u0000"))?.valType).toBe(1);
    expect(fields.has(COMMON_KEY_HEX.symbol)).toBe(true); // `symbol` and `symbol\0` are different keys
    expect(Buffer.from(fields.get("ff6b6579")!.value).toString()).toBe("ok"); // a non-UTF-8 key
    expect([...fields.keys()].some((k) => k.length === 440)).toBe(true); // a 220-byte key
    expect([...fields.values()].some((f) => f.value.length === 219)).toBe(true); // a 219-byte value
    const decimals = fields.get(COMMON_KEY_HEX.decimals)!;
    expect([Buffer.from(decimals.value).toString("hex"), decimals.integer, decimals.usable]).toEqual(["06" + "00".repeat(15), 6n, true]);
    const raw = await sql<{ key: Buffer; value: Buffer }[]>`
      SELECT key, value FROM ${sql(mip)}.mip0018_fields WHERE contract_address = ${Buffer.from(contractOf("C07"), "hex")} ORDER BY key`;
    expect(raw.map((r) => [hex(r.key), hex(r.value)])).toEqual(
      Object.entries(readCase("C07/expected.json").identities[0]!.fields!).map(([k, f]) => [k, f.value_hex]).sort(([a], [b]) => Buffer.compare(Buffer.from(a!, "hex"), Buffer.from(b!, "hex"))),
    );

    // A 31-byte unsigned integer (2^248 − 1) through the scan: bytes, numeric column and bigint all exact.
    const db = await fresh("bytes");
    const max = (1n << 248n) - 1n;
    await putSyntheticBlocks(db.sql, db.archive, NET, 10, [[{ result: "success", tx: {
      hash: "b7".repeat(32),
      intents: [{ segment: 1, actions: [{ call: { address: "b8".repeat(32), entryPoint: "m", guaranteed: { logs: [v1Log("99".repeat(32), 3, [record.uint("big", max), record.uint("decimals", max)])] } } }] }],
    } }]]);
    const s = scanner(db, { decode: decodeSynthetic });
    await s.bootstrap();
    await scanAll(s);
    const row = await db.sql<{ value: Buffer; uint_value: string }[]>`SELECT value, uint_value::text FROM ${db.sql(db.mip)}.mip0018_fields WHERE key = ${Buffer.from("big")}`;
    expect([hex(row[0]!.value), row[0]!.uint_value]).toEqual(["ff".repeat(31), max.toString()]);
    const ref: IdentityRef = { network: NET, contractAddress: "b8".repeat(32), domainSep: "99".repeat(32), kind: 3 };
    expect((await getIdentity(db.sql, ref, db.mip))!.fields.get(Buffer.from("big").toString("hex"))!.integer).toBe(max);
    expect(await displayAmountOf(db.sql, ref, 5n, db.mip)).toEqual({ decimals: max, text: `5e-${max}` }); // bounded, exact
  }, 120_000);

  it("[[mip0018.metadata.marks]] marks and tags through Postgres (Q14 (a), A13): C01 ✓; C10 ✓ with tag mip-0004; C07 ⚠ incorrect with its 9 reasons in chain order; C08 ⚠ incorrect; a synthetic partial token ⚠ partial; a minted token without events no mark; a withdrawn identity marked from its contract's rejections only", async () => {
    const { sql, mip } = ranges.idx;
    const only = async (c: string) => (await listIdentities(sql, NET, { contractAddress: contractOf(c) }, mip))[0]!;
    expect(await tokenMarkOf(sql, await only("C01"), mip)).toEqual({ mark: "ok", reasons: [], missing: [], tags: [] });
    expect(await tokenMarkOf(sql, await only("C10"), mip)).toEqual({ mark: "ok", reasons: [], missing: [], tags: ["mip-0004"] });
    const c07Reasons = ["no-records", "vallen-out-of-bounds", "nonzero-padding", "nonzero-padding", "bad-kind", "invalid-utf8", "invalid-uri", "bad-null-length", "reserved-valtype"];
    expect(await tokenMarkOf(sql, await only("C07"), mip)).toEqual({ mark: "incorrect", reasons: c07Reasons, missing: [], tags: [] });
    expect((await contractRejections(sql, NET, contractOf("C07"), mip)).map((r) => r.position.block)).toEqual([714899, 714915, 714931, 714949, 714964, 714980, 714996, 715012, 715026]);
    expect(await tokenMarkOf(sql, await only("C08"), mip)).toMatchObject({ mark: "incorrect", reasons: ["reserved-valtype"], missing: ["symbol", "decimals"] });
    // The minted third-party token of the IDX range (contract 7771c9e5…): no MIP-0018 event → no mark.
    const minted = (await listColors(sql, NET, mip)).find((c) => c.contractAddress.startsWith("7771c9e5"))!;
    expect(await tokenMarkOf(sql, { network: NET, contractAddress: minted.contractAddress, domainSep: minted.domainSep, kind: 1 }, mip)).toEqual({ mark: "none", reasons: [], missing: [], tags: [] });

    // Synthetic: a token publishing only `name` (⚠ partial); a withdrawn identity on a contract without and with a
    // rejected event — marked exactly like one never described (current state only, A13).
    const db = await fresh("marks");
    const P = "d1".repeat(32);
    const W = "d2".repeat(32);
    const D = "dd".repeat(32);
    const call = (address: string, logs: SynthLog[]) => ({ call: { address, entryPoint: "m", guaranteed: { logs } } });
    const bad = v1Log(D, 3, [record.utf8("name", "x")]);
    bad.data = bad.data.slice(0, 64 + 64) + "07"; // kind byte 7 → rejected (bad-kind)
    await putSyntheticBlocks(db.sql, db.archive, NET, 50, [
      [{ result: "success", tx: { hash: "e1".repeat(32), intents: [{ segment: 1, actions: [call(P, [v1Log(D, 3, [record.utf8("name", "Only name")])]), call(W, [v1Log(D, 3, [record.utf8("name", "W"), record.utf8("symbol", "W"), record.uint("decimals", 0)])])] }] } }],
      [{ result: "success", tx: { hash: "e2".repeat(32), intents: [{ segment: 1, actions: [call(W, [v1Log(D, 3, nullAll("name", "symbol", "decimals"))])] }] } }],
      [{ result: "success", tx: { hash: "e3".repeat(32), intents: [{ segment: 1, actions: [call(W, [bad])] }] } }],
    ]);
    const s = scanner(db, { decode: decodeSynthetic });
    await s.bootstrap();
    const ref = (c: string, domainSep = D): IdentityRef => ({ network: NET, contractAddress: c, domainSep, kind: 3 });
    await s.scanOnce({ maxBlocks: 1 });
    expect(await tokenMarkOf(db.sql, ref(P), db.mip)).toEqual({ mark: "partial", reasons: [], missing: ["symbol", "decimals"], tags: [] });
    expect((await tokenMarkOf(db.sql, ref(W), db.mip)).mark).toBe("ok");
    await s.scanOnce({ maxBlocks: 1 });
    const none = { mark: "none", reasons: [], missing: [], tags: [] };
    expect(await tokenMarkOf(db.sql, ref(W), db.mip)).toEqual(none); // withdrawn, no rejection
    expect(await tokenMarkOf(db.sql, ref(W, "ee".repeat(32)), db.mip)).toEqual(none); // never described, same contract
    await s.scanOnce({ maxBlocks: 1 });
    const incorrect = { mark: "incorrect", reasons: ["bad-kind"], missing: [], tags: [] };
    expect(await tokenMarkOf(db.sql, ref(W), db.mip)).toEqual(incorrect); // withdrawn, the contract has a rejection
    expect(await tokenMarkOf(db.sql, ref(W, "ee".repeat(32)), db.mip)).toEqual(incorrect); // identical to never described
  }, 120_000);

  it("[[mip0018.metadata.resume-across-tombstone]] a crash inside the C06 tombstone block rolls back its fields with its events and cursor; batches, restarts and the crash give the same tables (fields included) as one uninterrupted scan", async () => {
    const tape = loadRangeTape("idx");
    const one = await fresh("resume");
    await archiveTape(one, tape, 714789, 714835);
    const s1 = scanner(one);
    await s1.bootstrap();
    await scanAll(s1);
    const expected = await dumpAll(one.sql, one.mip);

    const two = await fresh("resume");
    await archiveTape(two, tape, 714789, 714835);
    await scanner(two).bootstrap();
    expect((await scanner(two).scanOnce({ maxBlocks: 20 })).scannedBlocks).toBe(20); // up to 714808 (after the rename)
    const before = (await dumpAll(two.sql, two.mip)).fields;
    const crashing = scanner(two, { onBlockWritten: (h) => { if (h === 714813) throw new Error("simulated crash in the tombstone block"); } });
    await expect(crashing.scanOnce()).rejects.toThrow(/simulated crash/);
    expect((await scanner(two).getCursor())?.nextHeight).toBe(714813);
    expect((await dumpAll(two.sql, two.mip)).fields).toEqual(before); // the Null at `name` rolled back with the block
    expect(await differences(two.sql, two.mip, contractOf("C06"), readCase("C06/expected-after-rename.json"))).toEqual([]);
    for (let i = 0; i < 3; i++) await scanner(two).scanOnce({ maxBlocks: 3 }); // new processes, small batches
    await scanAll(scanner(two));
    expect(await dumpAll(two.sql, two.mip)).toEqual(expected);
  }, 180_000);
});
