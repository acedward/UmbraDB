/**
 * The MIP-0018 read-only JSON API (contract `token-indexer/API.md`; MIP `274a84f` "Lookup", "Applying records",
 * "Common fields", "Symbol grouping", "Consuming").
 *
 * Data: the recorded Stagenet IDX range (`loadRangeTape("idx")`) archived by the real sync against the fake chain and
 * scanned by the real scanner; C06's lifecycle replayed step by step (case-index heights); synthetic archive blocks for
 * what Stagenet does not show (a whole identity withdrawn, a minted identity withdrawn, a partial token, a color seen
 * without a mint, hostile text). Every request goes two ways — over HTTP to the `node:http` server bound to 127.0.0.1 on
 * a free port, and directly through the same handler's `handle()` — and the two answers must be identical
 * (`helpers/api-both-ways.ts`); assertions read the HTTP answer. `serve()` answers over HTTP only: its scan loop
 * commits blocks between any two requests.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onPostgresql } from "../../test/helpers/postgresql-only.ts";
import { openTestDatabase, type TestDatabase } from "../../test/helpers/test-database.ts";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { type ArchiveTape, startFakeChain } from "../../test/integration/fixtures/stagenet-archive/fake-chain-server.js";
import { loadCaseIndex, loadManifest, loadRangeTape } from "../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import { createMip0018Handler, DEFAULT_MAX_CONCURRENT_REQUESTS, type Mip0018Handler, type Mip0018HandlerOptions, toAsciiJson } from "../mip0018/api.ts";
import { createMip0018Api } from "../mip0018/api-node.ts";
import { KNOWN_GENESIS, MIP_COMMIT, VENDORED_REFERENCE } from "../mip0018/api-views.ts";
import { contractUnresolvedSummary } from "../mip0018/metadata.ts";
import { decodeWalletAddress } from "../mip0018/bech32m.ts";
import { tokenColor } from "../mip0018/color.ts";
import { Mip0018Scanner } from "../mip0018/scan.ts";
import { main as serveMain, serve } from "../mip0018/serve-cli.ts";
import { EVENT_NAME, encodePayload, type MetadataRecord, record } from "../vendor/mip0018/codec/src/index.ts";
import { type BothWays, httpRequest, requestBothWays, type Resp, serveBothWays } from "./helpers/api-both-ways.ts";
import { decodeSynthetic, putSyntheticBlocks, type SynthArchivedTx, type SynthLog, type SynthOp, type SynthTranscript } from "./helpers/synthetic-archive.ts";
import { type SynthTxA, syntheticSeams } from "./helpers/synthetic-activity.ts";

const NET = "stagenet";
const REPO = new URL("../../", import.meta.url);
const CASES_DIR = new URL("./fixtures/mip0018-cases/", import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** The APIs this file starts, by base URL: each is also reached directly through its handler. */
const bothWays = new Map<string, BothWays>();

/** One request: both ways (identical answers required) for an API this file started, over HTTP only for `serve()`. */
async function get(base: string, path: string, init?: RequestInit): Promise<Resp> {
  const w = bothWays.get(base);
  return w === undefined ? httpRequest(base, path, init) : requestBothWays(w, path, init);
}

async function ok(base: string, path: string): Promise<Json> {
  const r = await get(base, path);
  expect(r.status, `${path}: ${r.text}`).toBe(200);
  return r.json;
}

/** Every item of a paginated list endpoint (`items` + `nextCursor`), walking pages of `limit`. */
async function walk(base: string, path: string, limit: number): Promise<{ items: Json[]; pages: number }> {
  const items: Json[] = [];
  let cursor: string | null = null;
  let pages = 0;
  const sep = path.includes("?") ? "&" : "?";
  do {
    const page: Json = await ok(base, `${path}${sep}limit=${limit}${cursor === null ? "" : `&cursor=${cursor}`}`);
    expect(page.items.length).toBeLessThanOrEqual(limit);
    items.push(...page.items);
    cursor = page.nextCursor;
    pages++;
  } while (cursor !== null);
  return { items, pages };
}

const keysOf = (o: object): string[] => Object.keys(o).sort();
const SUMMARY_KEYS = ["color", "contractAddress", "decimals", "described", "domainSep", "evidence", "firstSeen", "id", "kind", "kindName", "mark", "minted", "name", "note", "source", "symbol"];
const DETAIL_KEYS = ["color", "common", "commonFields", "contractAddress", "described", "domainSep", "fieldCount", "fields", "fieldsNextCursor", "group", "kind", "kindName", "mark", "minted", "network"];
const MARK_KEYS = ["mark", "missing", "reasonCount", "reasons", "tags", "unresolved"];
const FIELD_KEYS = ["key", "updatedAt", "usable", "valType", "valTypeName", "value"];
const EVENT_KEYS = ["classification", "contractAddress", "eventIndex", "height", "phase", "reason", "segment", "txHash", "txIndex"];
const hexText = (s: string): string => Buffer.from(s, "utf8").toString("hex");
/** A mark's `unresolved` when the contract has no unresolved log. */
const NO_UNRESOLVED = { count: 0, positions: [] };

/**
 * Visits every endpoint a client can reach from the token list (and the given contracts / paths): status, every page
 * of the list, each color's detail, activity and both lookups, each identity, each contract's tokens, activity and
 * events, each event transaction. Returns path → response.
 */
async function crawl(base: string, contracts: readonly string[] = [], paths: readonly string[] = []): Promise<Map<string, Resp>> {
  const out = new Map<string, Resp>();
  const visit = async (p: string): Promise<Resp> => {
    if (!out.has(p)) out.set(p, await get(base, p));
    return out.get(p)!;
  };
  await visit("/v1/status");
  const items: Json[] = [];
  let cursor: string | null = null;
  do {
    const r = await visit(`/v1/tokens?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`);
    expect(r.status).toBe(200);
    items.push(...r.json.items);
    cursor = r.json.nextCursor;
  } while (cursor !== null);
  const cs = new Set(contracts);
  for (const it of items) {
    if (it.color !== null) {
      await visit(`/v1/tokens/${it.color}`);
      await visit(`/v1/tokens/${it.color}/activity?limit=500`);
      for (const held of ["shielded", "unshielded"]) await visit(`/v1/lookup/${it.color}?held=${held}`);
    }
    if (it.source === "identity") {
      await visit(`/v1/identities/${it.contractAddress}/${it.domainSep}/${it.kind}`);
      cs.add(it.contractAddress);
    }
  }
  const txs = new Set<string>();
  for (const c of cs) {
    await visit(`/v1/contracts/${c}/tokens`);
    await visit(`/v1/contracts/${c}/activity?limit=500`);
    const ev = await visit(`/v1/events?contract=${c}&limit=500`);
    for (const e of ev.json?.items ?? []) txs.add(e.txHash);
  }
  for (const t of txs) await visit(`/v1/events?tx=${t}`);
  for (const p of paths) await visit(p);
  return out;
}

/** The paths of a crawl whose body contains `needle` as text or as the hex of its UTF-8 bytes. */
function mentions(c: Map<string, Resp>, needle: string): string[] {
  const hex = hexText(needle);
  return [...c].filter(([, r]) => r.text.includes(needle) || r.text.toLowerCase().includes(hex)).map(([p]) => p);
}

/** A `Misc` log item `name ‖ payload` for synthetic blocks, with trailing zeros dropped as the ledger does. */
function v1Log(domainSep: string, kind: number, records: MetadataRecord[]): SynthLog {
  const data = Buffer.from([...EVENT_NAME, ...encodePayload({ domainSep: Uint8Array.from(Buffer.from(domainSep, "hex")), kind }, records)]);
  let end = data.length;
  while (end > 0 && data[end - 1] === 0) end--;
  return { data: data.subarray(0, end).toString("hex") };
}
let nonce = 0;
function call(address: string, logs: SynthLog[], extra: { shieldedMints?: Array<[string, string]>; unshieldedOutputs?: string[] } = {}): SynthArchivedTx {
  const n = nonce++;
  return {
    result: "success",
    tx: {
      hash: createHash("sha256").update(`c1-api:${n}`).digest("hex"),
      intents: [{ segment: 1, actions: [{ call: { address, entryPoint: "meta", guaranteed: { logs, ...extra } } }] }],
    },
  };
}
const nullAll = (...keys: string[]): MetadataRecord[] => keys.map((k) => record.tombstone(k));

describe("MIP-0018 read-only API", () => {
  let database: TestDatabase;
  const clients: UmbraDBSql[] = [];
  const servers: Server[] = [];
  let counter = 0;
  const caseIndex = loadCaseIndex();
  const contractOf = (c: string): string => caseIndex.cases[c]!.contract!;
  let idx: { sql: UmbraDBSql; archive: string; mip: string; base: string };

  async function fresh(prefix: string): Promise<{ sql: UmbraDBSql; archive: string; mip: string }> {
    const n = counter++;
    const archive = `${prefix}_arch_${n}`;
    const mip = `${prefix}_mip_${n}`;
    const sql = database.client(mip);
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

  async function scanAll(s: Mip0018Scanner): Promise<void> {
    for (;;) {
      const r = await s.scanOnce({ maxBlocks: 1_000 });
      if (r.scannedBlocks === 0 || r.reachedEnd) return;
    }
  }

  /** Serves `api` over HTTP and keeps it reachable directly; returns the base URL that `get` sends both ways. */
  async function serveApi(api: Mip0018Handler): Promise<string> {
    const w = await serveBothWays(api);
    servers.push(w.server);
    bothWays.set(w.base, w);
    return w.base;
  }

  const startApi = (db: { sql: UmbraDBSql; archive: string; mip: string }, extra: Partial<Mip0018HandlerOptions> = {}): Promise<string> =>
    serveApi(createMip0018Handler({ sql: db.sql, network: NET, schema: db.mip, archiveSchema: db.archive, ...extra }));

  beforeAll(async () => {
    database = await openTestDatabase();
    const db = await fresh("idx");
    await archiveTape(db, loadRangeTape("idx"), 714485, 715183);
    const s = scanner(db);
    await s.bootstrap();
    await scanAll(s);
    idx = { ...db, base: await startApi(db) };
  }, 300_000);

  afterAll(async () => {
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
    for (const c of clients) await c.end({ timeout: 5 });
    await database?.stop();
  }, 60_000);

  it("[[mip0018.api.status]] status: network, genesis (= the recorded fixture's), start/indexed/archive heights, MIP pin and vendored commit (= SOURCE.md and the own vectors' manifest), scanner off, durability durable", async () => {
    const r = await get(idx.base, "/v1/status");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      network: NET, genesisHash: loadManifest().genesisHash, startHeight: 714485, indexedHeight: 715183, archiveHeight: 715183,
      mip: { id: "MIP-0018", commit: MIP_COMMIT }, vendored: { ...VENDORED_REFERENCE }, scanner: "off", unresolvedEvents: 0,
      durability: "durable",
    });
    expect(KNOWN_GENESIS.stagenet).toBe(loadManifest().genesisHash);
    const source = readFileSync(new URL("token-indexer/vendor/mip0018/SOURCE.md", REPO), "utf8");
    expect(source).toContain(`| Pinned at | **\`${VENDORED_REFERENCE.commit}\`**`);
    const own = JSON.parse(readFileSync(new URL("token-indexer/mip0018/vectors-umbradb/manifest.json", REPO), "utf8")) as { mip: { commit: string } };
    expect(own.mip.commit).toBe(MIP_COMMIT);
    // Headers of every JSON answer.
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    // A fresh database (nothing scanned, no archive): heights null, still 200.
    const empty = await fresh("empty");
    const base = await startApi(empty, { archiveSchema: "no_such_archive" });
    expect((await ok(base, "/v1/status"))).toMatchObject({ startHeight: null, indexedHeight: null, archiveHeight: null });
  }, 120_000);

  it("[[mip0018.api.tokens-list]] /v1/tokens: NIGHT, DUST, then every minted or described identity in (contract, domainSep, kind) byte order with usable name/symbol/decimals, mark and tags; keyset pages of any size walk to the same list; bad limits and foreign cursors are 400", async () => {
    const all = await ok(idx.base, "/v1/tokens?limit=500");
    expect(all.nextCursor).toBeNull();
    const items: Json[] = all.items;
    for (const it of items) expect(keysOf(it)).toEqual(SUMMARY_KEYS);
    expect(items.slice(0, 2).map((t) => [t.source, t.symbol, t.decimals, t.color, t.mark, t.kind])).toEqual([
      ["builtin", "NIGHT", "6", "00".repeat(32), null, null],
      ["builtin", "DUST", "15", null, null, null],
    ]);
    const ids = items.slice(2);
    expect(ids.every((t) => t.source === "identity")).toBe(true);
    const order = ids.map((t) => `${t.contractAddress}/${t.domainSep}/${t.kind}`);
    expect([...order].sort()).toEqual(order);
    expect(new Set(order).size).toBe(order.length);
    // 13 described identities (recorded cases) + 1 minted, never described (the third party's kind-1 token) = 14.
    expect(ids).toHaveLength(14);
    expect(ids.filter((t) => t.described).length).toBe(13);
    const thirdParty = ids.filter((t) => !t.described);
    expect(thirdParty.map((t) => [t.kind, t.name, t.symbol, t.mark.mark, t.minted?.amount, t.color?.slice(0, 8)])).toEqual([[1, null, null, "none", "1040000", "e5afe273"]]);
    // Rows of the recorded cases.
    const row = (c: string, kind: number): Json[] => ids.filter((t) => t.contractAddress === contractOf(c) && t.kind === kind);
    expect(row("C01", 3).map((t) => [t.name, t.symbol, t.decimals, t.color, t.kindName, t.mark.mark, t.minted])).toEqual([["Acme Gold", "AGLD", "6", null, "ledger", "ok", null]]);
    const c04 = [1, 2, 3].map((k) => row("C04", k)[0]);
    expect(c04.map((t) => [t.kind, t.name, t.color?.slice(0, 8) ?? null, t.minted?.amount ?? null, t.minted?.amountDisplay ?? null])).toEqual([
      [1, "Acme Dollar", "04239924", "100000", "1000.00"], [2, "Acme Dollar", "04239924", "100000", "1000.00"], [3, "Acme Dollar", null, null, null],
    ]);
    expect(c04[0].minted.firstMint.height).toBe(714643);
    expect(c04[1].minted.firstMint.height).toBe(714649);
    const medal = (metal: string) => Buffer.concat([Buffer.from(`mip-0018:example:family:${metal}`), Buffer.alloc(32)]).subarray(0, 32).toString("hex");
    const bronze = ids.find((t) => t.domainSep === medal("bronze"))!;
    expect([bronze.kind, bronze.described, bronze.color, bronze.minted, bronze.name]).toEqual([1, true, null, null, "Acme Medals"]); // described, never minted
    expect(row("C10", 3)[0].mark.tags).toEqual(["mip-0004"]);
    expect(row("C07", 3)[0].mark.mark).toBe("incorrect");

    // Keyset pages: limits 1, 3 and 7 all walk to the same list.
    for (const limit of [1, 3, 7]) {
      const w = await walk(idx.base, "/v1/tokens", limit);
      expect(w.items).toEqual(items);
      expect(w.pages).toBe(Math.ceil(items.length / limit));
    }
    const first = await ok(idx.base, "/v1/tokens?limit=2");
    expect(first.items.map((t: Json) => t.symbol)).toEqual(["NIGHT", "DUST"]);
    expect(typeof first.nextCursor).toBe("string");
    expect((await ok(idx.base, "/v1/tokens")).items).toHaveLength(16); // default limit 100

    for (const q of ["limit=0", "limit=501", "limit=abc", "limit=1.5", "limit=-1", "limit=", "cursor=%%%", "cursor=eyJ4IjoxfQ", `cursor=${first.nextCursor}=`, "limit=1&limit=2", "foo=1"]) {
      const r = await get(idx.base, `/v1/tokens?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.json.error.code).toBe("BAD_REQUEST");
    }
    // A cursor of another endpoint is refused.
    const ev = await ok(idx.base, `/v1/events?contract=${contractOf("C07")}&limit=1`);
    expect((await get(idx.base, `/v1/tokens?cursor=${ev.nextCursor}`)).status).toBe(400);
    expect((await get(idx.base, `/v1/events?contract=${contractOf("C07")}&cursor=${first.nextCursor}`)).status).toBe(400);
  }, 120_000);

  it("[[mip0018.api.token-detail]] /v1/tokens/{color}, /v1/identities/… and /v1/contracts/{address}/tokens: identities with fields (hex + text/integer views, usable), group (two or more), mark; C07's exact bytes (NUL and non-UTF-8 keys); single-member groups absent; 404s", async () => {
    const C04 = contractOf("C04");
    const c04Color = "04239924";
    const list = (await ok(idx.base, "/v1/tokens?limit=500")).items as Json[];
    const color = list.find((t) => t.contractAddress === C04 && t.kind === 1).color as string;
    expect(color.startsWith(c04Color)).toBe(true);
    const d = await ok(idx.base, `/v1/tokens/${color}`);
    expect(keysOf(d)).toEqual(["builtin", "color", "contractAddress", "domainSep", "evidence", "firstSeen", "identities", "related"]);
    expect([d.builtin, d.contractAddress, d.identities.map((i: Json) => i.kind), d.related.map((r: Json) => r.kind)]).toEqual([null, C04, [1, 2], [3]]);
    expect(d.firstSeen.height).toBe(714643);
    for (const i of d.identities) {
      expect(keysOf(i)).toEqual(DETAIL_KEYS);
      expect(keysOf(i.mark)).toEqual(MARK_KEYS);
      expect(i.common).toEqual({ name: "Acme Dollar", symbol: "ACD", decimals: "2", standards: null });
      expect(i.group.symbol).toEqual({ hex: hexText("ACD"), utf8: "ACD" });
      expect(i.group.members.map((m: Json) => m.kind)).toEqual([1, 2, 3]);
      expect(i.group.memberCount).toBe(3);
      // Fields are one keyset page in key byte order, counted; the common keys' raw rows are served too.
      expect([i.fieldCount, i.fieldsNextCursor, i.fields.map((f: Json) => f.key.utf8)]).toEqual([3, null, ["decimals", "name", "symbol"]]);
      expect(i.commonFields.map((f: Json) => f.key.utf8).sort()).toEqual(["decimals", "name", "symbol"]);
      expect(i.mark).toEqual({ mark: "ok", reasons: [], reasonCount: 0, unresolved: NO_UNRESOLVED, missing: [], tags: [] });
      for (const f of i.fields) expect(keysOf(f)).toEqual(FIELD_KEYS);
      const byKey = Object.fromEntries(i.fields.map((f: Json) => [f.key.utf8, f]));
      expect(byKey.name.value).toEqual({ hex: hexText("Acme Dollar"), text: "Acme Dollar" });
      expect([byKey.name.valType, byKey.name.valTypeName, byKey.name.usable]).toEqual([1, "utf8", true]);
      expect(byKey.decimals.value).toEqual({ hex: "02", integer: "2" });
      expect(byKey.decimals.updatedAt).toEqual({ height: 714663, txIndex: expect.any(Number), eventIndex: expect.any(Number), record: expect.any(Number) });
    }
    // The same identity through /v1/identities.
    const k1 = d.identities[0];
    expect(await ok(idx.base, `/v1/identities/${C04}/${k1.domainSep}/1`)).toEqual(k1);
    expect(await ok(idx.base, `/v1/identities/0x${C04.toUpperCase()}/${k1.domainSep}/1`)).toEqual(k1); // 0x and upper case normalised
    // NIGHT (zero color) and a color only of the third party.
    const night = await ok(idx.base, `/v1/tokens/${"00".repeat(32)}`);
    expect([night.builtin?.symbol, night.builtin?.decimals, night.identities]).toEqual(["NIGHT", "6", []]);
    const third = list.find((t) => t.source === "identity" && !t.described);
    const td = await ok(idx.base, `/v1/tokens/${third.color}`);
    expect(td.identities.map((i: Json) => [i.kind, i.described, i.fields, i.group, i.common.name, i.mark.mark])).toEqual([[1, false, [], null, null, "none"]]);
    expect((await get(idx.base, `/v1/tokens/${"ab".repeat(32)}`)).status).toBe(404);
    expect((await get(idx.base, `/v1/identities/${contractOf("C01")}/${"ab".repeat(32)}/3`)).status).toBe(404);
    const c01 = list.find((t) => t.contractAddress === contractOf("C01"));
    expect((await get(idx.base, `/v1/identities/${contractOf("C01")}/${c01.domainSep}/1`)).status).toBe(404); // C01 describes kind 3 only
    expect((await ok(idx.base, `/v1/identities/${contractOf("C01")}/${c01.domainSep}/3`)).group).toBeNull(); // alone with AGLD: no group

    // C07's fields byte for byte (keys with a NUL inside and non-UTF-8 keys, 220-byte key, 219-byte value).
    type ExpectedField = { valType: number; value_hex: string; usable?: boolean };
    const c07exp = JSON.parse(readFileSync(new URL("C07/expected.json", CASES_DIR), "utf8")) as { identities: Array<{ domainSep: string; kind: number; fields: Record<string, ExpectedField> }> };
    const e07 = c07exp.identities[0]!;
    const g07 = await ok(idx.base, `/v1/identities/${contractOf("C07")}/${e07.domainSep.replace(/^0x/, "")}/${e07.kind}`);
    const got = Object.fromEntries(g07.fields.map((f: Json) => [f.key.hex, { valType: f.valType, value_hex: f.value.hex, ...(f.usable === null ? {} : { usable: f.usable }) }]));
    const want = Object.fromEntries(Object.entries(e07.fields).map(([k, f]) => [k, { valType: f.valType, value_hex: f.value_hex, ...(f.usable === undefined ? {} : { usable: f.usable }) }]));
    expect(got).toEqual(want);
    for (const f of g07.fields as Json[]) {
      const keyBytes = Buffer.from(f.key.hex, "hex");
      let valid = true;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(keyBytes);
      } catch {
        valid = false;
      }
      expect(f.key.utf8 === null, f.key.hex).toBe(!valid);
      if (valid) expect(Buffer.from(f.key.utf8, "utf8").toString("hex")).toBe(f.key.hex); // NUL bytes kept exactly
      if (f.valType === 0) expect(keysOf(f.value)).toEqual(["hex"]); // bytes: never re-interpreted as text
    }
    expect(g07.fields.some((f: Json) => f.key.utf8 === null)).toBe(true);
    expect(g07.fields.some((f: Json) => typeof f.key.utf8 === "string" && f.key.utf8.includes("\u0000"))).toBe(true);

    // Contract tokens: identities and groups of two or more; pages bound to the contract.
    const ct = await ok(idx.base, `/v1/contracts/${C04}/tokens`);
    expect(keysOf(ct)).toEqual(["contractAddress", "groups", "items", "nextCursor"]);
    expect([ct.items.map((t: Json) => t.kind), ct.groups.map((g: Json) => [g.symbol.utf8, g.members.length]), ct.nextCursor]).toEqual([[1, 2, 3], [["ACD", 3]], null]);
    expect((await ok(idx.base, `/v1/contracts/${contractOf("C05")}/tokens`)).groups.map((g: Json) => [g.symbol.utf8, g.members.length])).toEqual([["MEDAL", 3]]);
    expect((await ok(idx.base, `/v1/contracts/${contractOf("C01")}/tokens`)).groups).toEqual([]);
    const w = await walk(idx.base, `/v1/contracts/${C04}/tokens`, 1);
    expect([w.items, w.pages]).toEqual([ct.items, 3]);
    const p1 = await ok(idx.base, `/v1/contracts/${C04}/tokens?limit=1`);
    expect((await get(idx.base, `/v1/contracts/${contractOf("C05")}/tokens?cursor=${p1.nextCursor}`)).status).toBe(400);
    expect((await get(idx.base, `/v1/contracts/${"ab".repeat(32)}/tokens`)).status).toBe(404);
    // A contract the scan saw (calls) but with no token: 200, empty.
    const bridge = caseIndex.otherTransactions.flatMap((t) => t.calls).find((c) => !list.some((t) => t.contractAddress === c))!;
    expect(await ok(idx.base, `/v1/contracts/${bridge}/tokens`)).toEqual({ contractAddress: bridge, groups: [], items: [], nextCursor: null });
  }, 120_000);

  it("[[mip0018.api.tokens-stable-order]] a reader paging /v1/tokens never loses a token that existed when paging began — a color seen in public data before its first mint keeps its seen row (same key) after the mint is indexed, while its identity row appears among the identities; a color first seen in its own mint transaction is never a seen row", async () => {
    const Z = "11".repeat(32); // the minting contract sorts before Y, so its identity row lands BEHIND a cursor past Y
    const Y = "fe".repeat(32);
    const DS = "5a".repeat(32);
    const T = tokenColor(DS, Z);
    const DS2 = "5b".repeat(32);
    const T2 = tokenColor(DS2, Z);
    const db = await fresh("stable");
    const archived = (t: SynthTxA): SynthArchivedTx => ({ tx: t as unknown as SynthArchivedTx["tx"], result: "success", segments: null });
    await putSyntheticBlocks(db.sql, db.archive, NET, 400, [
      // 400: Y describes a kind-3 token; T is seen in an unshielded output before any mint of it.
      [archived({ hash: "a0".repeat(32), intents: [{ segment: 1, guaranteedOutputs: [[T, "1", "77".repeat(32)]],
        calls: [{ address: Y, entryPoint: "meta", guaranteed: { logs: [v1Log("5c".repeat(32), 3, [record.utf8("name", "Ledger")]).data] } }] }] })],
      // 401: Z mints T (now indexed) and T2, which shows its color only in this same transaction.
      [archived({ hash: "a1".repeat(32), intents: [{ segment: 1, guaranteedOutputs: [[T2, "1", "77".repeat(32)]],
        calls: [{ address: Z, entryPoint: "mint", guaranteed: { unshieldedMints: [[DS, "5"], [DS2, "5"]] } }] }] })],
    ]);
    const until = async (to: number): Promise<void> => {
      const s = scanner(db, { ...syntheticSeams, toHeight: to });
      await s.bootstrap();
      await scanAll(s);
    };
    await until(400);
    const base = await startApi(db);
    const first = await ok(base, "/v1/tokens?limit=3");
    expect(first.items.map((t: Json) => t.id)).toEqual(["builtin/NIGHT", "builtin/DUST", `identity/${Y}/${"5c".repeat(32)}/3`]);
    expect((await ok(base, `/v1/tokens?limit=3&cursor=${first.nextCursor}`)).items.map((t: Json) => t.id)).toEqual([`color/${T}`]);
    await until(401); // T's mint is indexed while the reader holds a cursor past Y's identity
    const rest = await ok(base, `/v1/tokens?limit=10&cursor=${first.nextCursor}`);
    expect(rest.items.map((t: Json) => [t.id, t.contractAddress, t.domainSep])).toEqual([[`color/${T}`, Z, DS]]); // not lost
    expect(rest.items[0].note).toMatch(/before its first indexed mint/);
    // A fresh walk sees both rows of T (the identity and the seen color), and T2 only as an identity.
    const all = (await walk(base, "/v1/tokens", 2)).items.map((t: Json) => t.id);
    expect(all).toEqual(["builtin/NIGHT", "builtin/DUST", `identity/${Z}/${DS}/2`, `identity/${Z}/${DS2}/2`, `identity/${Y}/${"5c".repeat(32)}/3`, `color/${T}`]);
    expect(all).not.toContain(`color/${T2}`);
  }, 120_000);

  it("[[mip0018.api.bounded-cost]] chain-controlled cardinalities do not grow answers — an identity with 50 000 keys, 50 000 rejected events and 50 000 ignored events of its contract, a 2 001-member symbol group and a 100 000-byte entry point: list rows and marks read only the common keys and the first 100 reasons (reasonCount = all), the identity's fields come in keyset pages with fieldCount, groups list their first 100 members with memberCount, events page over the served rows only, activity serves an entry point's first 128 bytes with its length; every answer is small and within a generous latency budget", async () => {
    const X = "c0".repeat(32);
    const DA = "da".repeat(32);
    const C = "cc".repeat(32);
    const N = 50_000;
    const db = await fresh("bounded");
    const archived = (t: SynthTxA): SynthArchivedTx => ({ tx: t as unknown as SynthArchivedTx["tx"], result: "success", segments: null });
    const LONG = "ab".repeat(100_000); // a 100 000-byte entry point (not UTF-8)
    await putSyntheticBlocks(db.sql, db.archive, NET, 900, [
      [archived({ hash: "b0".repeat(32), intents: [{ segment: 1, calls: [{ address: X, entryPoint: "unused", entryPointHex: LONG, guaranteed: { unshieldedInputs: [["unshielded", C, "7"]] } }] }] })],
    ]);
    const sc = scanner(db, syntheticSeams);
    await sc.bootstrap();
    await scanAll(sc);
    const s = db.sql(db.mip);
    const x = Buffer.from(X, "hex");
    const da = Buffer.from(DA, "hex");
    const utf8 = (t: string) => Buffer.from(t, "utf8");
    // The hostile cardinalities, written straight into the tables the API reads.
    await db.sql`
      INSERT INTO ${s}.mip0018_fields (network, contract_address, domain_sep, kind, key, val_type, value, uint_value, usable,
                                       updated_block, updated_tx, updated_event, updated_record)
      SELECT ${NET}, ${x}, ${da}, 3, convert_to('k' || lpad(i::text, 6, '0'), 'UTF8'), 1, decode('76', 'hex'), NULL, NULL, 1000 + i / 50, 0, 0, i % 50
      FROM generate_series(1, ${N}) AS i`;
    for (const [key, valType, value, uint] of [["name", 1, utf8("Big"), null], ["symbol", 1, utf8("SPAM"), null], ["decimals", 2, Buffer.from([6]), "6"]] as const)
      await db.sql`INSERT INTO ${s}.mip0018_fields VALUES (${NET}, ${x}, ${da}, 3, ${utf8(key)}, ${valType}, ${value}, ${uint}, true, 999, 0, 0, 0)`;
    await db.sql`
      INSERT INTO ${s}.mip0018_fields (network, contract_address, domain_sep, kind, key, val_type, value, uint_value, usable,
                                       updated_block, updated_tx, updated_event, updated_record)
      SELECT ${NET}, ${x}, decode('ee' || lpad(to_hex(i), 62, '0'), 'hex'), 3, ${utf8("symbol")}, 1, ${utf8("SPAM")}, NULL, true, 999, 0, 1, i
      FROM generate_series(1, 2000) AS i`;
    await db.sql`
      INSERT INTO ${s}.mip0018_events (network, block_height, tx_index, event_index, tx_hash, segment_id, phase, contract_address,
                                       event_type, name, payload, classification, reason, domain_sep, kind)
      SELECT ${NET}, 500, i, 0, NULL, 1, 'guaranteed', ${x}, 'Misc', decode('', 'hex'), decode('', 'hex'), 'ignore', 'other-name', NULL, NULL
      FROM generate_series(0, ${N - 1}) AS i`;
    await db.sql`
      INSERT INTO ${s}.mip0018_events (network, block_height, tx_index, event_index, tx_hash, segment_id, phase, contract_address,
                                       event_type, name, payload, classification, reason, domain_sep, kind)
      SELECT ${NET}, 2000 + i, 0, 0, NULL, 1, 'guaranteed', ${x}, 'Misc', decode('', 'hex'), decode('', 'hex'), 'reject', 'no-records', NULL, NULL
      FROM generate_series(1, ${N}) AS i`;
    await db.sql`ANALYZE ${s}.mip0018_fields`;
    await db.sql`ANALYZE ${s}.mip0018_events`;
    const base = await startApi(db);
    const BUDGET_MS = 5_000; // generous: a loaded shared host; the bound that matters is the size
    const timed = async (path: string, maxBytes: number): Promise<Json> => {
      const t0 = performance.now();
      const r = await get(base, path);
      const ms = performance.now() - t0;
      expect(r.status, `${path}: ${r.text.slice(0, 200)}`).toBe(200);
      expect(r.text.length, path).toBeLessThan(maxBytes);
      expect(ms, path).toBeLessThan(BUDGET_MS);
      return r.json;
    };

    // The token list: the big identity's row reads only its common fields; its mark lists 100 reasons of 50 000.
    const list = await timed("/v1/tokens?limit=4", 16_000);
    const big = list.items.find((t: Json) => t.domainSep === DA)!;
    expect([big.name, big.symbol, big.decimals, big.described]).toEqual(["Big", "SPAM", "6", true]);
    expect([big.mark.mark, big.mark.reasons.length, big.mark.reasonCount]).toEqual(["incorrect", 100, N]);
    // The identity: one page of fields (key byte order), all counted; the common fields; a bounded group.
    const id = await timed(`/v1/identities/${X}/${DA}/3`, 96_000);
    expect([id.fields.length, id.fieldCount, typeof id.fieldsNextCursor]).toEqual([100, N + 3, "string"]);
    expect(id.commonFields.map((f: Json) => f.key.utf8).sort()).toEqual(["decimals", "name", "symbol"]);
    expect(id.common).toEqual({ name: "Big", symbol: "SPAM", decimals: "6", standards: null });
    expect([id.group.memberCount, id.group.members.length, id.mark.reasonCount, id.mark.reasons.length]).toEqual([2001, 100, N, 100]);
    // Keyset pages of 500 continue in key order, bound to the identity.
    let cursor = id.fieldsNextCursor as string;
    let lastKey = id.fields.at(-1).key.hex as string;
    for (let page = 0; page < 3; page++) {
      const p = await timed(`/v1/identities/${X}/${DA}/3?limit=500&cursor=${cursor}`, 160_000);
      expect(p.fields.length).toBe(500);
      expect(p.fields[0].key.hex > lastKey).toBe(true);
      expect(p.fields.every((f: Json, i: number) => i === 0 || f.key.hex > p.fields[i - 1].key.hex)).toBe(true);
      lastKey = p.fields.at(-1).key.hex;
      cursor = p.fieldsNextCursor;
    }
    expect((await get(base, `/v1/identities/${X}/${"db".repeat(32)}/3?cursor=${cursor}`)).status).toBe(400); // bound to its identity
    // The contract's tokens: the groups of the page's identities, each with its first 100 members.
    const ct = await timed(`/v1/contracts/${X}/tokens?limit=10`, 48_000);
    expect(ct.groups.map((g: Json) => [g.symbol.utf8, g.memberCount, g.members.length])).toEqual([["SPAM", 2001, 100]]);
    // Events of the contract: the served rows only, a page at a time.
    const ev = await timed(`/v1/events?contract=${X}&limit=20`, 16_000);
    expect([ev.items.length, ev.items.every((e: Json) => e.classification === "reject"), typeof ev.nextCursor]).toEqual([20, true, "string"]);
    // Activity: the 100 000-byte entry point is served as its first 128 bytes and its length.
    const act = await timed(`/v1/tokens/${C}/activity`, 8_000);
    expect(act.items.map((i: Json) => [i.role, i.entryPoint])).toEqual([["contract-in", { hex: "ab".repeat(128), length: 100_000, truncated: true }]]);
    await timed("/v1/status", 4_000);
  }, 300_000);

  it("[[mip0018.api.concurrency-cap]] at most maxConcurrentRequests API requests run at once (default 8), one count for the HTTP server and the direct handler together; the next is answered at once with 503 BUSY and Retry-After (HEAD: headers only), never queued; capacity returns when a request finishes; a cap below 1 is refused", async () => {
    let release!: () => void;
    let gate!: Promise<void>;
    const close = (): void => {
      gate = new Promise<void>((r) => { release = r; });
    };
    close();
    let started = 0;
    const stub = { begin: async () => { started++; await gate; return { held: true }; } } as unknown as UmbraDBSql;
    const startedReaches = async (n: number): Promise<void> => {
      for (let i = 0; i < 200 && started < n; i++) await new Promise((r) => setTimeout(r, 10));
      expect(started).toBe(n);
    };
    const BUSY = { error: { code: "BUSY", message: "too many requests in progress; retry shortly" } };
    const api = createMip0018Handler({ sql: stub, network: NET, maxConcurrentRequests: 2 });
    const base = await serveApi(api);
    const held = [get(base, "/v1/status"), get(base, "/v1/status")];
    await startedReaches(2);
    const busy = await get(base, "/v1/tokens");
    expect([busy.status, busy.json, busy.headers.get("retry-after")]).toEqual([503, BUSY, "1"]);
    expect(started).toBe(2); // refused before any database work
    release();
    expect((await Promise.all(held)).map((r) => [r.status, r.json])).toEqual([[200, { held: true }], [200, { held: true }]]);
    expect((await get(base, "/v1/status")).status).toBe(200);

    // One count for both ways: a request held over HTTP and one held through handle() fill the cap; the next is
    // refused at once either way, a HEAD with the same headers and no body.
    close();
    const before = started;
    const overHttp = httpRequest(base, "/v1/status");
    const direct = api.handle("GET", "/v1/status");
    await startedReaches(before + 2);
    const refused = await api.handle("GET", "/v1/tokens");
    expect([refused.status, JSON.parse(refused.body), refused.headers["retry-after"]]).toEqual([503, BUSY, "1"]);
    const refusedHead = await api.handle("HEAD", "/v1/tokens");
    expect([refusedHead.status, refusedHead.headers, refusedHead.body]).toEqual([503, refused.headers, ""]);
    expect((await get(base, "/v1/status")).json).toEqual(BUSY);
    expect(started).toBe(before + 2);
    release();
    expect([(await overHttp).status, (await direct).status]).toEqual([200, 200]);

    // The default cap: 8 admitted, the 9th refused.
    expect(DEFAULT_MAX_CONCURRENT_REQUESTS).toBe(8);
    close();
    const byDefault = createMip0018Handler({ sql: stub, network: NET });
    const from = started;
    const eight = Array.from({ length: 8 }, () => byDefault.handle("GET", "/v1/status"));
    await startedReaches(from + 8);
    expect((await byDefault.handle("GET", "/v1/status")).status).toBe(503);
    release();
    expect((await Promise.all(eight)).map((r) => r.status)).toEqual(Array(8).fill(200));

    expect(() => createMip0018Api({ sql: stub, network: NET, maxConcurrentRequests: 0 })).toThrow(/maxConcurrentRequests/);
    expect(() => createMip0018Handler({ sql: stub, network: NET, maxConcurrentRequests: 0 })).toThrow(/maxConcurrentRequests/);
  }, 60_000);

  it("[[mip0018.api.lookup]] /v1/lookup/{color}?held=: C04's color → kind 1 held shielded, kind 2 held unshielded (one color); C05 bronze → not minted in the indexed range; NIGHT's zero color → built-in; the kind comes from the holding, not the color", async () => {
    const C04 = contractOf("C04");
    const list = (await ok(idx.base, "/v1/tokens?limit=500")).items as Json[];
    const color = list.find((t) => t.contractAddress === C04 && t.kind === 1).color as string;
    const sh = await ok(idx.base, `/v1/lookup/${color}?held=shielded`);
    const un = await ok(idx.base, `/v1/lookup/${color}?held=unshielded`);
    expect(keysOf(sh)).toEqual(["builtin", "color", "found", "held", "identity", "indexedRange", "result", "seen"]);
    expect([sh.found, sh.result, sh.identity.contractAddress, sh.identity.kind, sh.identity.color, sh.identity.common.name, sh.indexedRange]).toEqual([true, "identity", C04, 1, color, "Acme Dollar", { from: 714485, to: 715183 }]);
    expect([un.found, un.result, un.identity.contractAddress, un.identity.kind, un.identity.color, un.identity.common.name]).toEqual([true, "identity", C04, 2, color, "Acme Dollar"]);
    expect(sh.identity.domainSep).toBe(un.identity.domainSep);
    // C02 minted shielded only: an unshielded holding of its color still resolves to (contract, domainSep) with kind 2.
    const c02 = list.find((t) => t.contractAddress === contractOf("C02") && t.kind === 1);
    const c02u = await ok(idx.base, `/v1/lookup/${c02.color}?held=unshielded`);
    expect([c02u.result, c02u.identity.kind, c02u.identity.described, c02u.identity.minted, c02u.identity.color, c02u.identity.mark.mark]).toEqual(["identity", 2, false, null, c02.color, "none"]);
    // C05 bronze: published (kind 1) but never minted.
    const bronzeDs = Buffer.concat([Buffer.from("mip-0018:example:family:bronze"), Buffer.alloc(32)]).subarray(0, 32).toString("hex");
    const bronze = tokenColor(bronzeDs, contractOf("C05"));
    for (const held of ["shielded", "unshielded"]) {
      const r = await ok(idx.base, `/v1/lookup/${bronze}?held=${held}`);
      expect(r).toEqual({ color: bronze, held, found: false, result: "not-minted-in-indexed-range", builtin: null, identity: null, seen: null, indexedRange: { from: 714485, to: 715183 } });
    }
    expect((await get(idx.base, `/v1/tokens/${bronze}`)).status).toBe(404);
    // NIGHT: the built-in row; DUST has no color (list only).
    const night = await ok(idx.base, `/v1/lookup/${"00".repeat(32)}?held=unshielded`);
    expect([night.found, night.result, night.builtin.symbol, night.builtin.color, night.identity]).toEqual([true, "builtin", "NIGHT", "00".repeat(32), null]);
    // The zero color held SHIELDED is the ledger's default shielded token type, not NIGHT.
    expect(await ok(idx.base, `/v1/lookup/${"00".repeat(32)}?held=shielded`)).toEqual({
      color: "00".repeat(32), held: "shielded", found: false, result: "shielded-zero-color", builtin: null, identity: null, seen: null,
      indexedRange: { from: 714485, to: 715183 },
    });
    expect(list.find((t) => t.symbol === "DUST")).toMatchObject({ source: "builtin", color: null, decimals: "15", mark: null });
    // `held` is required and strict.
    for (const q of ["", "?held=", "?held=both", "?held=Shielded", "?held=shielded&held=unshielded", "?held=shielded&x=1"])
      expect((await get(idx.base, `/v1/lookup/${color}${q}`)).status, q).toBe(400);
  }, 120_000);

  it("[[mip0018.api.events]] /v1/events: MIP-0018-named events (accept/reject) of a contract or a transaction in chain order with position, contract, classification and reason only — never name, payload, domainSep, kind or values; ignored events not served; pages; filters required", async () => {
    const C07 = contractOf("C07");
    const all = await ok(idx.base, `/v1/events?contract=${C07}&limit=500`);
    expect(all.items.map((e: Json) => e.classification).sort()).toEqual([...Array(9).fill("accept"), ...Array(9).fill("reject")]); // 4 ignored not served
    for (const e of all.items) {
      expect(keysOf(e)).toEqual(EVENT_KEYS);
      expect(e.contractAddress).toBe(C07);
      expect(e.reason === null).toBe(e.classification === "accept");
    }
    const pos = all.items.map((e: Json) => [e.height, e.txIndex, e.eventIndex]);
    expect([...pos].sort((a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!)).toEqual(pos);
    // The mark's reasons are exactly the contract's rejections, in chain order.
    const c07 = ((await ok(idx.base, "/v1/tokens?limit=500")).items as Json[]).find((t) => t.contractAddress === C07);
    expect(c07.mark.reasons).toEqual(all.items.filter((e: Json) => e.classification === "reject").map((e: Json) => e.reason));
    expect(c07.mark.reasonCount).toBe(9);
    // Pages of 4 walk to the same list.
    expect((await walk(idx.base, `/v1/events?contract=${C07}`, 4)).items).toEqual(all.items);
    // C08's emitTwo transaction: the valid event accepted, then the malformed one rejected.
    const tx = caseIndex.cases.C08!.steps.find((s) => s.id === "emit-two")!.txHash!;
    const c08 = await ok(idx.base, `/v1/events?tx=${tx}`);
    expect(c08.items.map((e: Json) => [e.classification, e.reason, e.height])).toEqual([["accept", null, 715109], ["reject", "reserved-valtype", 715109]]);
    expect((await ok(idx.base, `/v1/events?tx=${tx}&contract=${contractOf("C08")}`)).items).toEqual(c08.items);
    expect((await ok(idx.base, `/v1/events?tx=${tx}&contract=${C07}`)).items).toEqual([]);
    // A bridge contract with only other-named Misc events: nothing served.
    const bridge = "1df4ce25";
    const bridgeContract = caseIndex.otherTransactions.flatMap((t) => t.calls).find((c) => c.startsWith(bridge));
    if (bridgeContract !== undefined) expect((await ok(idx.base, `/v1/events?contract=${bridgeContract}`)).items).toEqual([]);
    // No event of any endpoint carries the stored bytes or the header.
    const body = (await get(idx.base, `/v1/events?contract=${C07}&limit=500`)).text;
    for (const word of ['"name"', '"payload"', '"domainSep"', '"kind"', '"identity"', '"value"']) expect(body).not.toContain(word);
    for (const q of ["", "?limit=5", `?contract=${C07.slice(2)}`, "?tx=xyz", `?contract=${C07}&contract=${C07}`]) expect((await get(idx.base, `/v1/events${q}`)).status, q).toBe(400);
    const p = await ok(idx.base, `/v1/events?contract=${C07}&limit=2`);
    expect((await get(idx.base, `/v1/events?contract=${contractOf("C08")}&cursor=${p.nextCursor}`)).status).toBe(400); // cursor bound to its filter
  }, 120_000);

  it("[[mip0018.api.activity]] /v1/tokens/{color}/activity and /v1/contracts/{address}/activity: C03's mint row and UTXO show wallet 1 in Bech32m (never its hex); C06's five metadata transactions at their heights; keyset pages and both orders; 400 for bad limit/order/cursor, 404 for unknown colors and contracts", async () => {
    const WALLET1 = "mn_addr_stagenet1vw57646su9y5z6myarm93m6kcn62j97z0yma94lfkhmta6pz5h5q6utr3k";
    const list = (await ok(idx.base, "/v1/tokens?limit=500")).items as Json[];
    const C03 = contractOf("C03");
    const c03 = list.find((t) => t.contractAddress === C03 && t.kind === 2);
    const r = await get(idx.base, `/v1/tokens/${c03.color}/activity`);
    expect(r.status).toBe(200);
    expect(keysOf(r.json)).toEqual(["color", "contractAddress", "items", "nextCursor"]);
    expect([r.json.color, r.json.contractAddress, r.json.nextCursor]).toEqual([c03.color, C03, null]);
    const steps = Object.fromEntries(caseIndex.cases.C03!.steps.map((x) => [x.id, x]));
    expect(r.json.items.map((i: Json) => [i.height, i.role, i.wallet ?? null, i.txHash])).toEqual([
      [714617, "utxo-created", WALLET1, steps.mint!.txHash],
      [714617, "mint", WALLET1, steps.mint!.txHash],
      [714624, "metadata-event", null, steps.publish!.txHash],
    ]);
    const mint = r.json.items.find((i: Json) => i.role === "mint");
    expect([mint.contract, mint.kind, mint.amount, mint.color]).toEqual([C03, 2, "1000000", c03.color]);
    expect(r.text).not.toContain(decodeWalletAddress("stagenet", WALLET1)); // the wallet's raw hex never appears
    // C06 (kind 3, no color): the contract's metadata transactions, counts only.
    const C06 = contractOf("C06");
    const all = await ok(idx.base, `/v1/contracts/${C06}/activity`);
    expect([all.contractAddress, all.nextCursor]).toEqual([C06, null]);
    const c06Steps = caseIndex.cases.C06!.steps.filter((x) => x.kind !== "deploy");
    expect(all.items.map((i: Json) => [i.height, i.role, i.events, i.txHash])).toEqual(
      c06Steps.map((x) => [x.height, "metadata-event", { accepted: 1, rejected: 0, firstEventIndex: 0 }, x.txHash]));
    expect(all.items.map((i: Json) => i.height)).toEqual([714796, 714804, 714813, 714827, 714835]);
    for (const i of all.items) for (const k of ["name", "payload", "value", "domainSep", "kind", "wallet"]) expect(i).not.toHaveProperty(k);
    // Pages and orders.
    expect((await walk(idx.base, `/v1/contracts/${C06}/activity`, 2))).toEqual({ items: all.items, pages: 3 });
    const desc = await walk(idx.base, `/v1/contracts/${C06}/activity?order=desc`, 2);
    expect(desc.items).toEqual([...all.items].reverse());
    const p1 = await ok(idx.base, `/v1/contracts/${C06}/activity?limit=2`);
    for (const q of [`order=desc&cursor=${p1.nextCursor}`, "order=up", "limit=0", "limit=501", "cursor=abc%21", "x=1", "order=asc&order=asc"])
      expect((await get(idx.base, `/v1/contracts/${C06}/activity?${q}`)).status, q).toBe(400);
    expect((await get(idx.base, `/v1/contracts/${contractOf("C07")}/activity?cursor=${p1.nextCursor}`)).status).toBe(400); // another listing
    expect((await get(idx.base, `/v1/tokens/${c03.color}/activity?cursor=${p1.nextCursor}`)).status).toBe(400);
    const err = await get(idx.base, `/v1/contracts/${C06}/activity?order=desc&cursor=${p1.nextCursor}`);
    expect(keysOf(err.json.error)).toEqual(["code", "message"]);
    expect(err.json.error.message).not.toContain(p1.nextCursor);
    // A kind-3 token's activity = its contract's metadata transactions (C01: the publish).
    expect((await ok(idx.base, `/v1/contracts/${contractOf("C01")}/activity`)).items.map((i: Json) => i.height)).toEqual([714501]);
    // NIGHT (zero color): known, no NIGHT UTXO in the recorded ranges; unknown color / contract → 404; bad hex → 400.
    expect(await ok(idx.base, `/v1/tokens/${"00".repeat(32)}/activity`)).toEqual({ color: "00".repeat(32), contractAddress: null, items: [], nextCursor: null });
    expect((await get(idx.base, `/v1/tokens/${"ab".repeat(32)}/activity`)).status).toBe(404);
    expect((await get(idx.base, `/v1/contracts/${"ab".repeat(32)}/activity`)).status).toBe(404);
    expect((await get(idx.base, "/v1/tokens/xyz/activity")).status).toBe(400);
    expect((await get(idx.base, `/v1/tokens/${c03.color}/activity/x`)).status).toBe(404);
  }, 120_000);

  it("[[mip0018.api.marks]] marks through the API: C01 ✓ ok, C07 ⚠ incorrect (9 reasons), C08 ⚠ incorrect, a partial identity ⚠ partial (synthetic), a minted token without events unmarked; NIGHT/DUST carry no mark", async () => {
    const list = (await ok(idx.base, "/v1/tokens?limit=500")).items as Json[];
    const mark = (c: string) => list.filter((t) => t.contractAddress === contractOf(c)).map((t) => t.mark.mark);
    expect(mark("C01")).toEqual(["ok"]);
    expect(mark("C07")).toEqual(["incorrect"]);
    expect(mark("C08")).toEqual(["incorrect"]);
    expect(mark("C04")).toEqual(["ok", "ok", "ok"]);
    expect(list.filter((t) => t.source === "identity" && !t.described).map((t) => t.mark)).toEqual([{ mark: "none", reasons: [], reasonCount: 0, unresolved: NO_UNRESOLVED, missing: [], tags: [] }]);
    expect(list.filter((t) => t.source === "builtin").map((t) => t.mark)).toEqual([null, null]);
    // Detail and list agree.
    const c08 = list.find((t) => t.contractAddress === contractOf("C08"));
    expect((await ok(idx.base, `/v1/identities/${c08.contractAddress}/${c08.domainSep}/${c08.kind}`)).mark).toEqual(c08.mark);
    expect(c08.mark.reasons).toEqual(["reserved-valtype"]);
    // A partial identity (synthetic): only `name`.
    const db = await fresh("partial");
    const X = "c1".repeat(32);
    const P = "70".repeat(32);
    await putSyntheticBlocks(db.sql, db.archive, NET, 10, [[call(X, [v1Log(P, 3, [record.utf8("name", "Only A Name")])])]]);
    const s = scanner(db, { decode: decodeSynthetic });
    await s.bootstrap();
    await scanAll(s);
    const base = await startApi(db);
    const part = await ok(base, `/v1/identities/${X}/${P}/3`);
    expect([part.mark, part.common]).toEqual([{ mark: "partial", reasons: [], reasonCount: 0, unresolved: NO_UNRESOLVED, missing: ["symbol", "decimals"], tags: [] }, { name: "Only A Name", symbol: null, decimals: null, standards: null }]);
  }, 120_000);

  it("[[mip0018.api.unresolved-mark]] an unresolved log of a contract (its rename or withdrawal the raw transaction does not show) takes the clean ✓ from every identity of that contract — described, minted-only, list row, detail, color, lookup and contract view all answer ⚠ unresolved with the reason unresolved-log, the count and the log's position (bounded: the first 100 of many); with a rejected event as well the mark is ⚠ incorrect and its reasons end with unresolved-log; another contract keeps ✓", async () => {
    const Y = "c7".repeat(32); // ✓, then a rename whose operand comes from `dup` (log-operand-not-pushed)
    const Z = "c8".repeat(32); // ✓, then a withdrawal inside a branch (log-conditionally-executed)
    const W = "c9".repeat(32); // ✓, then a rejected event and an unresolved log
    const K = "ca".repeat(32); // control: ✓ throughout
    const U = "cb".repeat(32); // 120 unresolved logs in one transaction (bounded positions)
    const D1 = "71".repeat(32);
    const D2 = "72".repeat(32);
    const full = (ds: string, kind: number, name: string): SynthLog =>
      v1Log(ds, kind, [record.utf8("name", name), record.utf8("symbol", name.slice(0, 3).toUpperCase()), record.uint("decimals", 6n, 1)]);
    let n = 0;
    const tx = (address: string, guaranteed: SynthTranscript): SynthArchivedTx => ({
      result: "success",
      tx: { hash: createHash("sha256").update(`r1:${n++}`).digest("hex"), intents: [{ segment: 1, actions: [{ call: { address, entryPoint: "meta", guaranteed } }] }] },
    });
    const evil = v1Log(D1, 1, [record.utf8("name", "Evil")]).data;
    const db = await fresh("unresolvedmark");
    await putSyntheticBlocks(db.sql, db.archive, NET, 40, [
      [
        tx(Y, { logs: [full(D1, 1, "Yacht"), full(D2, 3, "Yawl")], shieldedMints: [[D1, "100"]] }),
        tx(Z, { logs: [full(D1, 1, "Zebra")], shieldedMints: [[D1, "7"], [D2, "8"]] }), // Z's D2: minted, never described
        tx(W, { logs: [full(D1, 3, "Walrus")] }),
        tx(K, { logs: [full(D1, 3, "Kite")] }),
      ],
      [
        tx(Y, { program: [{ push: { cell: evil } }, { dup: 0 }, "log"] }),
        tx(Z, { program: [{ dup: 0 }, { branch: 2 }, { log: v1Log(D1, 1, nullAll("name", "symbol", "decimals")) }, "noop"] }),
        tx(W, { logs: [{ data: Buffer.from(EVENT_NAME).toString("hex") }] }), // all-zero payload → rejected
        tx(W, { program: [{ push: { cell: "01" } }, { dup: 0 }, "log"] }),
        tx(U, { program: Array.from({ length: 120 }, (): SynthOp[] => [{ push: { cell: "02" } }, { dup: 0 }, "log"]).flat() }),
      ],
    ]);
    const until = async (to: number): Promise<void> => {
      const s = scanner(db, { decode: decodeSynthetic, toHeight: to });
      await s.bootstrap();
      await scanAll(s);
    };
    const base = await startApi(db);
    const marks = async (): Promise<Record<string, string>> => Object.fromEntries(((await ok(base, "/v1/tokens?limit=500")).items as Json[])
      .filter((t) => t.source === "identity").map((t) => [`${t.contractAddress.slice(0, 2)}/${t.domainSep.slice(0, 2)}/${t.kind}`, t.mark.mark]));

    await until(40); // every contract published with ordinary push; log → ✓ (Z's never-described D2: no mark)
    expect(await marks()).toEqual({ "c7/71/1": "ok", "c7/72/3": "ok", "c8/71/1": "ok", "c8/72/1": "none", "c9/71/3": "ok", "ca/71/3": "ok" });

    await until(41);
    expect(await marks()).toEqual({
      "c7/71/1": "unresolved", "c7/72/3": "unresolved", "c8/71/1": "unresolved", "c8/72/1": "unresolved",
      "c9/71/3": "incorrect", "ca/71/3": "ok",
    });
    // The unresolved rename and withdrawal were never applied (their values are unknown): Y's name is still the old
    // one and Z's identity still exists — which is exactly why their marks lose the ✓.
    const y = await ok(base, `/v1/identities/${Y}/${D1}/1`);
    expect([y.common.name, y.mark]).toEqual(["Yacht", {
      mark: "unresolved", reasons: ["unresolved-log"], reasonCount: 0,
      unresolved: { count: 1, positions: [{ height: 41, txIndex: 0, eventIndex: 0 }] }, missing: [], tags: [],
    }]);
    const z = await ok(base, `/v1/identities/${Z}/${D1}/1`);
    expect([z.described, z.common.name, z.mark.mark, z.mark.unresolved]).toEqual([true, "Zebra", "unresolved", { count: 1, positions: [{ height: 41, txIndex: 1, eventIndex: 0 }] }]);
    expect((await ok(base, `/v1/identities/${Z}/${D2}/1`)).mark).toMatchObject({ mark: "unresolved", reasons: ["unresolved-log"], missing: [] });
    // Every view of Y's color, and the contract's own token list, answer the same mark.
    const T = tokenColor(D1, Y);
    expect((await ok(base, `/v1/tokens/${T}`)).identities.map((i: Json) => i.mark)).toEqual([y.mark]);
    expect((await ok(base, `/v1/lookup/${T}?held=shielded`)).identity.mark).toEqual(y.mark);
    expect((await ok(base, `/v1/contracts/${Y}/tokens`)).items.map((i: Json) => i.mark.mark)).toEqual(["unresolved", "unresolved"]);
    // A rejected event as well: ⚠ incorrect, the reasons end with unresolved-log.
    const [rejected] = (await ok(base, `/v1/events?contract=${W}`)).items.filter((e: Json) => e.classification === "reject");
    expect((await ok(base, `/v1/identities/${W}/${D1}/3`)).mark).toEqual({
      mark: "incorrect", reasons: [rejected.reason, "unresolved-log"], reasonCount: 1,
      unresolved: { count: 1, positions: [{ height: 41, txIndex: 3, eventIndex: 0 }] }, missing: [], tags: [],
    });
    expect((await ok(base, `/v1/identities/${K}/${D1}/3`)).mark).toEqual({ mark: "ok", reasons: [], reasonCount: 0, unresolved: NO_UNRESOLVED, missing: [], tags: [] });
    // Bounded like the rejections: U's 120 unresolved logs → the count and the first 100 positions (U has no identity,
    // so its summary — what every mark of its tokens would carry — is read through the helper the API uses).
    const u = await contractUnresolvedSummary(db.sql, NET, U, 100, db.mip);
    expect([u.count, u.positions.length, u.positions[0], u.positions[99]]).toEqual([120, 100, { height: 41, txIndex: 4, eventIndex: 0 }, { height: 41, txIndex: 4, eventIndex: 99 }]);
    expect((await ok(base, "/v1/status")).unresolvedEvents).toBe(123);
  }, 120_000);

  it("[[mip0018.api.withdrawn-absent]] C06 step by step: after the tombstone (Null at name) the withdrawn name is absent from every endpoint (text and hex), and stays absent after the revive; synthetic whole withdrawals: a never-minted identity answers 404 and its domainSep and values appear nowhere, a minted one reads exactly like a minted never-described token", async () => {
    // C06 recorded, per step (case-index heights).
    const db = await fresh("c06");
    await archiveTape(db, loadRangeTape("idx"), 714789, 714835);
    await scanner(db).bootstrap();
    const base = await startApi(db);
    const C06 = contractOf("C06");
    const ds = "11".repeat(32);
    const at: Record<string, Map<string, Resp>> = {};
    for (const step of caseIndex.cases.C06!.steps.filter((x) => x.expectedAfter !== undefined)) {
      await scanAll(scanner(db, { toHeight: step.height! }));
      at[step.id] = await crawl(base, [C06], [`/v1/identities/${C06}/${ds}/3`]);
    }
    expect(Object.keys(at)).toEqual(["publish", "rename", "withdraw", "withdraw-again", "revive"]);
    // Positive controls: the crawler finds each name while it is current.
    expect(mentions(at.publish!, "Acme Token").length).toBeGreaterThan(0);
    expect(mentions(at.rename!, "Acme Prime").length).toBeGreaterThan(0);
    expect(mentions(at.rename!, "Acme Token")).toEqual([]); // replaced value: never a fallback, no history
    for (const step of ["withdraw", "withdraw-again", "revive"]) {
      expect(mentions(at[step]!, "Acme Prime"), step).toEqual([]);
      expect(mentions(at[step]!, "Acme Token"), step).toEqual([]);
      expect(at[step]!.size).toBeGreaterThan(5);
    }
    const afterWithdraw = at.withdraw!.get(`/v1/identities/${C06}/${ds}/3`)!.json;
    expect([afterWithdraw.common, afterWithdraw.fields.map((f: Json) => f.key.utf8), afterWithdraw.mark.mark, afterWithdraw.mark.missing]).toEqual([
      { name: null, symbol: "ACMP", decimals: "6", standards: ["mip-0004"] }, ["decimals", "standards", "symbol"], "partial", ["name"],
    ]);
    expect(mentions(at.revive!, "Acme Again").length).toBeGreaterThan(0);
    // The chain events stay (position, classification) — 5 accepted, no values.
    expect(at.revive!.get(`/v1/events?contract=${C06}&limit=500`)!.json.items.map((e: Json) => [e.height, e.classification])).toEqual(
      [[714796, "accept"], [714804, "accept"], [714813, "accept"], [714827, "accept"], [714835, "accept"]]);

    // Synthetic whole withdrawals.
    const sdb = await fresh("withdraw");
    const X = "c2".repeat(32);
    const Z = "7a".repeat(32); // kind 3, never minted
    const M = "6d".repeat(32); // kind 1, minted, described, then withdrawn
    const N = "6e".repeat(32); // kind 1, minted, never described
    const full = (name: string) => [record.utf8("name", name), record.utf8("symbol", "GRP"), record.uint("decimals", 2), record.utf8("standards", "mip-0011")];
    await putSyntheticBlocks(sdb.sql, sdb.archive, NET, 200, [
      [call(X, [v1Log(Z, 3, full("Zed Withdrawn")), v1Log(M, 1, full("Minted Withdrawn"))], { shieldedMints: [[M, "500"], [N, "700"]] })],
      [call(X, [v1Log(Z, 3, nullAll("name", "symbol", "decimals", "standards")), v1Log(M, 1, nullAll("standards", "decimals", "symbol", "name"))])],
    ]);
    const s = scanner(sdb, { decode: decodeSynthetic });
    await s.bootstrap();
    const sbase = await startApi(sdb);
    await s.scanOnce({ maxBlocks: 1 });
    const before = await crawl(sbase, [X], [`/v1/identities/${X}/${Z}/3`]);
    expect(mentions(before, Z).length).toBeGreaterThan(0); // positive control
    expect(mentions(before, "Zed Withdrawn").length).toBeGreaterThan(0);
    expect((await ok(sbase, `/v1/contracts/${X}/tokens`)).groups.map((g: Json) => g.members.map((m: Json) => m.kind))).toEqual([[1, 3]]);
    await s.scanOnce({ maxBlocks: 1 });
    const after = await crawl(sbase, [X], [`/v1/identities/${X}/${Z}/3`, `/v1/identities/${X}/${M}/1`, `/v1/identities/${X}/${N}/1`]);
    expect(mentions(after, Z)).toEqual([]);
    expect(mentions(after, "Zed Withdrawn")).toEqual([]);
    expect(mentions(after, "Minted Withdrawn")).toEqual([]);
    expect(mentions(after, "GRP")).toEqual([]);
    expect(after.get(`/v1/identities/${X}/${Z}/3`)!.status).toBe(404);
    const ct = after.get(`/v1/contracts/${X}/tokens`)!.json;
    expect([ct.groups, ct.items.map((t: Json) => [t.domainSep, t.kind, t.described])]).toEqual([[], [[M, 1, false], [N, 1, false]]]);
    // The withdrawn minted identity reads exactly like the never-described minted one.
    const strip = (j: Json) => ({ ...j, domainSep: "-", color: "-", minted: j.minted === null ? null : { ...j.minted, firstMint: "-", amount: "-" } });
    const m = after.get(`/v1/identities/${X}/${M}/1`)!.json;
    const n = after.get(`/v1/identities/${X}/${N}/1`)!.json;
    expect(strip(m)).toEqual(strip(n));
    expect([m.described, m.fields, m.group, m.common.name, m.mark.mark, m.minted.amountDisplay]).toEqual([false, [], null, null, "none", null]);
    const lk = await ok(sbase, `/v1/lookup/${m.color}?held=shielded`);
    expect([lk.result, lk.identity.described, lk.identity.fields]).toEqual(["identity", false, []]);
    // The chain events of the contract remain, without the identity.
    expect(after.get(`/v1/events?contract=${X}&limit=500`)!.json.items.map((e: Json) => [e.height, e.classification])).toEqual([[200, "accept"], [200, "accept"], [201, "accept"], [201, "accept"]]);
  }, 240_000);

  it("[[mip0018.api.hostile-text]] hostile metadata (bidi and invisible characters, NUL and control characters, markup, non-UTF-8 keys and bytes, a long value) is returned as data: every body is pure printable ASCII with JSON escapes, parses back to the exact text, non-UTF-8 bytes only as hex; a color seen without a mint is listed last; hostile contract entry points (NUL, non-UTF-8, bidi bytes) never stop the scan and are served as their exact hex, with text only when printable", async () => {
    const db = await fresh("hostile");
    const H = "a1".repeat(32);
    const D = "68".repeat(32);
    const SEEN = "5e".repeat(32);
    const name = "\u202Egnp.exe\u200B\u0000<script>alert(1)</script>";
    const symbol = "\u2066SYM\u2069";
    const tag = "x\u202Ey";
    const desc = "\u0000\u0001\u001b[31mred\u001b[0m & \"q\"";
    const long = "\u200F".repeat(70);
    await putSyntheticBlocks(db.sql, db.archive, NET, 300, [[
      call(H, [
        v1Log(D, 3, [record.utf8("name", name), record.utf8("symbol", symbol), record.uint("decimals", 3), record.utf8("standards", `mip-0004 ${tag}`)]),
        v1Log(D, 3, [
          { key: Uint8Array.from([0xff, 0xfe]), valType: 0, value: Uint8Array.from([0xc3, 0x28]) },
          record.utf8("desc", desc), record.utf8("\u0000nul", "x"), record.uri("home", "https://example.invalid/never-fetched"), record.json("j", "{\"a\":\"\\u202e\"}"),
        ]),
        v1Log(D, 3, [record.utf8("k", long)]),
      ], { unshieldedOutputs: [SEEN] }),
    ]]);
    const s = scanner(db, { decode: decodeSynthetic });
    await s.bootstrap();
    await scanAll(s);
    const base = await startApi(db);
    const c = await crawl(base, [H], [`/v1/identities/${H}/${D}/3`, `/v1/tokens/${SEEN}`, `/v1/lookup/${SEEN}?held=unshielded`]);
    for (const [p, r] of c) {
      expect(/^[\x20-\x7e]*$/.test(r.text), p).toBe(true);
      expect(r.text.includes("<"), p).toBe(false);
    }
    const d = c.get(`/v1/identities/${H}/${D}/3`)!.json;
    expect(d.common).toEqual({ name, symbol, decimals: "3", standards: ["mip-0004", tag] });
    expect(d.mark).toEqual({ mark: "ok", reasons: [], reasonCount: 0, unresolved: NO_UNRESOLVED, missing: [], tags: ["mip-0004", tag] });
    const byHex = Object.fromEntries(d.fields.map((f: Json) => [f.key.hex, f]));
    expect(byHex.fffe).toMatchObject({ key: { hex: "fffe", utf8: null }, valType: 0, valTypeName: "bytes", value: { hex: "c328" }, usable: null });
    expect(keysOf(byHex.fffe.value)).toEqual(["hex"]);
    expect(byHex[hexText("desc")].value.text).toBe(desc);
    expect(byHex[hexText("\u0000nul")].key.utf8).toBe("\u0000nul");
    expect(byHex[hexText("home")]).toMatchObject({ valTypeName: "uri", value: { text: "https://example.invalid/never-fetched" } });
    expect(byHex[hexText("j")]).toMatchObject({ valTypeName: "json", value: { text: "{\"a\":\"\\u202e\"}" } });
    expect(byHex[hexText("k")].value.text).toBe(long);
    expect(byHex[hexText("k")].value.hex).toHaveLength(420);
    const rawName = c.get(`/v1/identities/${H}/${D}/3`)!.text;
    expect(rawName).toContain("\\u202e");
    expect(rawName).toContain("\\u0000");
    expect(rawName).toContain("\\u003cscript\\u003e");
    // The list row: last is the seen-only color.
    const list = c.get("/v1/tokens?limit=2")!.json;
    expect(list.items.map((t: Json) => t.symbol)).toEqual(["NIGHT", "DUST"]);
    const rows = (await ok(base, "/v1/tokens?limit=500")).items as Json[];
    expect(rows.map((t: Json) => t.source)).toEqual(["builtin", "builtin", "identity", "seen"]);
    expect(rows[2]).toMatchObject({ name, symbol, decimals: "3" });
    expect(rows[3]).toMatchObject({ id: `color/${SEEN}`, color: SEEN, kind: null, firstSeen: { height: 300, txIndex: 0 }, evidence: ["contract-unshielded"], mark: { mark: "none" } });
    const seen = c.get(`/v1/tokens/${SEEN}`)!.json;
    expect([seen.contractAddress, seen.identities, seen.firstSeen.height, seen.evidence]).toEqual([null, [], 300, ["contract-unshielded"]]);
    expect(c.get(`/v1/lookup/${SEEN}?held=unshielded`)!.json).toMatchObject({ found: false, result: "not-minted-in-indexed-range", seen: { firstSeen: { height: 300 }, evidence: ["contract-unshielded"] } });
    // The serializer: any string round-trips through pure ASCII (incl. a lone surrogate and astral characters).
    const sample = { s: `${name}${symbol}${desc}\ud800\u{1F600}\u2028\u2029\u007f<>&`, n: [1, null, true] };
    const ascii = toAsciiJson(sample);
    expect(/^[\x20-\x7e]*$/.test(ascii)).toBe(true);
    expect(JSON.parse(ascii)).toEqual(sample);
    // The API never fetches: no network client in its modules.
    for (const f of ["api.ts", "api-node.ts", "api-views.ts"]) {
      const src = readFileSync(new URL(`token-indexer/mip0018/${f}`, REPO), "utf8");
      expect(src, f).not.toMatch(/\bfetch\(|node:https|\.request\(|net\.connect|from "undici"/);
    }

    // Contract entry points are arbitrary bytes on the ledger. Calls naming NUL, non-UTF-8 and bidi
    // entry points mint and move tokens (activity rows carry the entry point); the scan goes through every block and
    // the API serves each entry point as its exact hex, with `text` only for a printable one.
    const edb = await fresh("hostileep");
    const E = "e5".repeat(32);
    const Y = "e7".repeat(32);
    const EPS: Array<[string, string | undefined]> = [
      ["6d696e7400", undefined], // "mint" NUL
      ["fffe4100c3", undefined], // not UTF-8
      [hexText("\u202Eevil\u200B"), undefined], // bidi + zero-width
      [hexText("<script>"), undefined], // markup characters are not printable entry-point bytes
      [hexText("mint"), "mint"],
    ];
    const dsOf = (i: number): string => (0x40 + i).toString(16).repeat(32);
    const archived = (t: SynthTxA): SynthArchivedTx => ({ tx: t as unknown as SynthArchivedTx["tx"], result: "success", segments: null });
    await putSyntheticBlocks(edb.sql, edb.archive, NET, 500, [
      [archived({ hash: "f1".repeat(32), intents: [{ segment: 1, calls: EPS.map(([h], i) => ({
        address: E, entryPoint: "unused", entryPointHex: h,
        guaranteed: { unshieldedMints: [[dsOf(i), "1"]], unshieldedInputs: [["unshielded", Y, String(i + 1)]] },
      })) }] })],
      [archived({ hash: "f2".repeat(32), intents: [{ segment: 1, calls: [{ address: E, entryPoint: "later", guaranteed: { unshieldedOutputs: [["unshielded", Y, "9"]] } }] }] })],
    ]);
    const es = scanner(edb, syntheticSeams);
    await es.bootstrap();
    await scanAll(es);
    expect((await es.getCursor())!.nextHeight).toBe(502); // never stopped
    const ebase = await startApi(edb);
    const ec = await crawl(ebase, [E], [`/v1/tokens/${Y}/activity?limit=500`]);
    for (const [p, r] of ec) {
      expect(r.status, p).toBeLessThan(500);
      expect(/^[\x20-\x7e]*$/.test(r.text), p).toBe(true);
      expect(r.text.includes("<"), p).toBe(false);
    }
    const yItems = ec.get(`/v1/tokens/${Y}/activity?limit=500`)!.json.items as Json[];
    expect(yItems.map((i) => [i.role, i.height, i.entryPoint])).toEqual([
      ...EPS.map(([h, text]) => ["contract-in", 500, text === undefined ? { hex: h } : { hex: h, text }]),
      ["contract-out", 501, { hex: hexText("later"), text: "later" }],
    ]);
    for (const [i, [h, text]] of EPS.entries()) {
      const mintItems = (await ok(ebase, `/v1/tokens/${tokenColor(dsOf(i), E)}/activity`)).items as Json[];
      expect(mintItems.map((x) => [x.role, x.entryPoint])).toEqual([["mint", text === undefined ? { hex: h } : { hex: h, text }]]);
    }
    const rawY = ec.get(`/v1/tokens/${Y}/activity?limit=500`)!.text;
    expect(rawY).not.toContain("\\u0000"); // no decoded text of a non-printable entry point travels, not even escaped
    expect(rawY).not.toContain("\\u202e");
  }, 240_000);

  it("[[mip0018.api.errors]] error envelope: 400 for malformed hex, kinds outside 1–3, malformed paths and parameters; 404 for unknown routes, colors, identities and contracts; 405 with Allow for other methods; 503 when the database cannot be read; never the input or internal details; HEAD answers headers only", async () => {
    const C01 = contractOf("C01");
    const cases: Array<[string, number, string?]> = [
      ["/v1/tokens/xyz", 400], [`/v1/tokens/${"a".repeat(63)}`, 400], [`/v1/tokens/${"a".repeat(65)}`, 400], [`/v1/tokens/0x${"g".repeat(64)}`, 400],
      [`/v1/identities/${C01}/${"11".repeat(32)}/0`, 400], [`/v1/identities/${C01}/${"11".repeat(32)}/4`, 400], [`/v1/identities/${C01}/${"11".repeat(32)}/x`, 400],
      [`/v1/identities/${C01}/${"11".repeat(31)}/3`, 400], [`/v1/identities/abc/${"11".repeat(32)}/3`, 400], ["/v1/tokens/%E0%A4%A", 400],
      ["/v1/status?verbose=1", 400], [`/v1/tokens/${"ab".repeat(32)}?limit=1`, 400],
      ["/", 404], ["/v1", 404], ["/v1/nope", 404], ["/v2/tokens", 404], ["/v1/tokens/", 404], ["//v1/tokens", 404], [`/v1/identities/${C01}/${"11".repeat(32)}`, 404],
      [`/v1/tokens/${"ab".repeat(32)}`, 404], [`/v1/contracts/${"ab".repeat(32)}/tokens`, 404], [`/v1/contracts/${C01}`, 404], ["/ui", 404],
    ];
    for (const [path, status] of cases) {
      const r = await get(idx.base, path);
      expect(r.status, path).toBe(status);
      expect(keysOf(r.json), path).toEqual(["error"]);
      expect(keysOf(r.json.error), path).toEqual(["code", "message"]);
      expect(r.json.error.code, path).toBe(status === 400 ? "BAD_REQUEST" : "NOT_FOUND");
      expect(r.json.error.message, path).not.toMatch(/xyz|ggg|aaaa|select|postgres|stack|Error:/i);
      expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    }
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const r = await get(idx.base, "/v1/tokens", { method });
      expect(r.status, method).toBe(405);
      expect(r.headers.get("allow")).toBe("GET, HEAD");
      expect(r.json).toEqual({ error: { code: "METHOD_NOT_ALLOWED", message: "only GET and HEAD are supported" } });
    }
    const head = await get(idx.base, "/v1/status", { method: "HEAD" });
    expect([head.status, head.text, Number(head.headers.get("content-length")) > 0]).toEqual([200, "", true]);
    expect((await get(idx.base, "/v1/nope", { method: "HEAD" })).status).toBe(404);
    // The database cannot be read: a generic 503; the cause goes to the server log only.
    const dead = database.client("idx_mip_0");
    await dead.end();
    const logged: string[] = [];
    const base = await startApi({ sql: dead, archive: idx.archive, mip: idx.mip }, { log: (l) => logged.push(l) });
    const r = await get(base, "/v1/tokens");
    expect([r.status, r.json]).toEqual([503, { error: { code: "UNAVAILABLE", message: "the index database cannot be read" } }]);
    expect(logged.some((l) => l.includes('"status":503'))).toBe(true);
    // A schema that does not exist (API-only before any scan): 503 too, never the SQL text.
    const missing = await startApi({ sql: idx.sql, archive: idx.archive, mip: "no_such_schema" }, { log: () => {} });
    const m = await get(missing, "/v1/tokens");
    expect([m.status, m.json.error.code, /relation|schema|mip0018_/.test(m.text)]).toEqual([503, "UNAVAILABLE", false]);
  }, 120_000);

  it("[[mip0018.api.serve-cli]] serve: binds 127.0.0.1 by default, runs the scan loop following the archive (status indexedHeight reaches the archive's height, scanner following) or only the API (--api-only, read-only); a stalled scan (undecodable transaction) leaves the API serving with scanner stalled; the CLI logs the bound port and exits 0 on SIGTERM; bad arguments are refused", async () => {
    // In process, with the scan loop, over a freshly archived U1 range (nothing scanned yet).
    const db = await fresh("serve");
    await archiveTape(db, loadRangeTape("u1"), 715402, 715433);
    const logs: string[] = [];
    const h = await serve({ sql: db.sql, network: NET, schema: db.mip, archiveSchema: db.archive, port: 0, scanIdleMs: 50, log: (l) => logs.push(l) });
    try {
      expect(h.host).toBe("127.0.0.1");
      const base = `http://127.0.0.1:${h.port}`;
      let st: Json;
      for (let i = 0; i < 200; i++) {
        st = await ok(base, "/v1/status");
        if (st.indexedHeight === 715433) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(st).toMatchObject({ startHeight: 715402, indexedHeight: 715433, archiveHeight: 715433, scanner: "following" });
      const u1 = ((await ok(base, "/v1/tokens")).items as Json[]).filter((t) => t.contractAddress === contractOf("U1"));
      expect(u1.map((t) => [t.kind, t.described, t.minted?.firstMint.height])).toEqual([[1, true, 715409]]);
      expect(logs.some((l) => JSON.parse(l).event === "listening")).toBe(true);
      expect(logs.some((l) => JSON.parse(l).event === "scan")).toBe(true);
    } finally {
      await h.stop();
    }

    // A scan that cannot proceed (an undecodable transaction stops the scan at its block) does not take the API
    // down: status says `stalled`, the other endpoints answer, the cursor stays before the block.
    const bad = await fresh("stall");
    await putSyntheticBlocks(bad.sql, bad.archive, NET, 50, [[call("c3".repeat(32), [])]]); // JSON bytes: not a ledger transaction
    const slogs: string[] = [];
    const hs = await serve({ sql: bad.sql, network: NET, schema: bad.mip, archiveSchema: bad.archive, port: 0, scanIdleMs: 20, log: (l) => slogs.push(l) });
    try {
      const base = `http://127.0.0.1:${hs.port}`;
      let st: Json;
      for (let i = 0; i < 200; i++) {
        st = await ok(base, "/v1/status");
        if (st.scanner === "stalled") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(st).toMatchObject({ scanner: "stalled", startHeight: 50, indexedHeight: null, archiveHeight: 50 });
      expect((await ok(base, "/v1/tokens")).items.map((t: Json) => t.symbol)).toEqual(["NIGHT", "DUST"]);
      expect(slogs.some((l) => JSON.parse(l).event === "scan-error")).toBe(true);
    } finally {
      await hs.stop();
    }

    await expect(serve({ sql: db.sql, network: NET, schema: db.mip, archiveSchema: db.archive, port: 0, scanIdleMs: 0 })).rejects.toThrow(/scanIdleMs/);
    await expect(serveMain([], {})).rejects.toThrow(/usage/);

    // The CLI opens its database from PG_URL: a PostgreSQL server.
    if (onPostgresql("serve-cli-process")) {
      // The CLI as a child process, API only, over the IDX schema; default host; SIGTERM → exit 0.
      const child = spawn(process.execPath, ["--import", "tsx", "token-indexer/mip0018/serve-cli.ts", "--network", NET, "--port", "0", "--api-only", "--schema", idx.mip, "--archive-schema", idx.archive], {
        cwd: new URL(".", REPO).pathname, env: { ...process.env, PG_URL: database.connectionUri() }, stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (b: Buffer) => (out += b.toString()));
      child.stderr.on("data", (b: Buffer) => (err += b.toString()));
      const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
      try {
        for (let i = 0; i < 300 && !out.includes('"listening"'); i++) await new Promise((r) => setTimeout(r, 100));
        const line = JSON.parse(out.split("\n").find((l) => l.includes('"listening"'))!) as { host: string; port: number; scanner: string };
        expect([line.host, line.scanner, line.port > 0]).toEqual(["127.0.0.1", "off", true]);
        const st = await ok(`http://127.0.0.1:${line.port}`, "/v1/status");
        expect(st).toMatchObject({ indexedHeight: 715183, scanner: "off", genesisHash: KNOWN_GENESIS.stagenet });
      } finally {
        child.kill("SIGTERM");
      }
      expect(await exited, err).toBe(0);
      expect(out).toContain('"stopped"');

      await expect(serveMain(["--network", NET, "--port", "70000"], { PG_URL: database.connectionUri() })).rejects.toThrow(/--port/);
      await expect(serveMain(["--network", NET, "--genesis", "abc"], { PG_URL: database.connectionUri() })).rejects.toThrow(/--genesis/);
      // An idle wait of 0 (or below 100 ms) would make the scan loop and its error back-off a hot loop.
      for (const idle of ["0", "99"])
        await expect(serveMain(["--network", NET, "--scan-idle-ms", idle], { PG_URL: database.connectionUri() })).rejects.toThrow(/--scan-idle-ms must be an integer from 100 to 3600000/);
      await expect(serveMain(["--bogus"], { PG_URL: database.connectionUri() })).rejects.toThrow();
    }
  }, 180_000);
});
