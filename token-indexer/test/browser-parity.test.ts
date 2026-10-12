/**
 * Parity of the browser build with the Node build, in Chrome, with no network beyond 127.0.0.1: the static build
 * (`helpers/engine-site.ts`) and its worker on OPFS in headless Chromium, driven over the DevTools protocol
 * (`helpers/cdp-browser.ts`). The recorded ranges' digests in the worker are `[[browser.worker.tape-digests]]`
 * (`browser-sync.test.ts`); this file covers the vectors and the API.
 *
 * - `[[browser.parity.vectors]]` — the 110 MIP-0018 vector requests (59 reference normative, 43 informative and
 *   UmbraDB's own 8) answered by the database consumer (`mip0018/vector-consumer-pg.ts`: a fresh migrated `mip0018` schema
 *   per request, the production write path, the read helpers the API serves) in a dedicated worker on OPFS, through the
 *   browser engine's own store module (`browser/store.ts`, PGlite 18.3 in the non-durable mode). The vendored runner
 *   core, unchanged, runs in Node and sends each request to the page (`fixtures/vector-consumer/`); every answer equals
 *   the pure consumer's, as on PostgreSQL (`[[mip0018.vectors.pg-adapter]]`).
 * - `[[browser.parity.case-stop-heights]]` — the recorded cases (`fixtures/mip0018-cases/`, the reference's own
 *   expectations) read through the engine worker's `api` request (the in-browser router): the IDX range replayed in the
 *   worker and stopped at each case's last block (and at each of C06's steps), every finished case equals its
 *   expectation and every later case is absent; U1 at its last block.
 * - `[[browser.parity.case-reference-index]]` — at the end of IDX and U1, through the same router: the reference index's
 *   colors (first and last mint, mint count and amount, from each color's own activity), its v1-named events (position,
 *   segment, phase, classification, reason), its range (`/v1/status`), and IDX/expected.json's colors through
 *   `/v1/lookup`; exactly 6 colors in IDX.
 * - `[[browser.parity.case-marks-activity]]` — every case identity's mark (✓/⚠, reasons, missing keys, tags) equals the
 *   mark rule applied to the reference expectations and the reference index's rejections, also after each C06 step;
 *   every case contract's metadata transactions equal the reference index's.
 * - `[[browser.parity.api-equals-node]]` — every answer of a crawl of the API (every listing page, color, lookup,
 *   identity field page, contract, event page and transaction, the activity pages in both orders, error answers, HEAD
 *   and a refused method) from the engine worker equals the Node handler's (`createMip0018Handler`) over the same range
 *   synced and scanned in Node (PostgreSQL 17, or PGlite in the PGlite run): status, headers and body byte for byte,
 *   `/v1/status` apart from `durability` (the browser store is non-durable).
 *
 * Through the API by design: values the API never serves (event payloads, ignored events, block hashes, deploys,
 * per-range statistics) are not compared here; the digests cover them.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 */
import { readFileSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openTestDatabase, type TestDatabase } from "../../test/helpers/test-database.ts";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { fakeChainFetch } from "../../test/integration/fixtures/stagenet-archive/fake-chain-server.js";
import { loadCaseIndex, loadRangeTape } from "../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import type { HostStatus, StartConfig } from "../browser/protocol.ts";
import { createIndexerEngine, type IndexerEngine } from "../engine/engine.ts";
import { createMip0018Handler, type Mip0018Handler } from "../mip0018/api.ts";
import { tokenColor } from "../mip0018/color.ts";
import { UMBRADB_VECTORS_DIR, VENDORED_VECTORS_DIR, vectorSets } from "../mip0018/run-vectors.ts";
import { handleRequest } from "../mip0018/vector-consumer.ts";
import { loadVectors, requestFor, runVectors, type Json as VectorJson, type LoadedVector } from "../vendor/mip0018/vectors/tools/runner-core.ts";
import { Browser, findBrowser, type Page } from "./helpers/cdp-browser.ts";
import { buildEngineSite, type EngineSite, engineDriver, NO_AUTO_START, serveEngineSite } from "./helpers/engine-site.ts";
import { buildVectorConsumerPage, VECTOR_CONSUMER_PAGE } from "./helpers/vector-consumer-page.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const NET = "stagenet";
const IDX = { from: 714485, to: 715183 } as const;
const U1 = { from: 715402, to: 715433 } as const;
const FAST = { sync: { idleMs: 200 }, scan: { idleMs: 200 } };
const CASES_DIR = new URL("./fixtures/mip0018-cases/", import.meta.url);
const dec = new TextDecoder();

const browserExe = findBrowser();

// ── The API as both sides answer it ──────────────────────────────────────────────────────────────────────────────

interface Answer { status: number; headers: Record<string, string>; body: string }
type Api = (method: string, target: string) => Promise<Answer>;

async function get(api: Api, target: string): Promise<{ status: number; body: Json }> {
  const r = await api("GET", target);
  return { status: r.status, body: r.body === "" ? null : JSON.parse(r.body) };
}

const withParam = (target: string, name: string, value: string): string =>
  `${target}${target.includes("?") ? "&" : "?"}${name}=${encodeURIComponent(value)}`;

/** Every item of a paginated listing (`items` + `nextCursor`). */
async function allItems(api: Api, target: string): Promise<Json[]> {
  const out: Json[] = [];
  let cursor: string | null = null;
  do {
    const r = await get(api, cursor === null ? target : withParam(target, "cursor", cursor));
    expect(r.status, `${target}: ${JSON.stringify(r.body)}`).toBe(200);
    out.push(...r.body.items);
    cursor = r.body.nextCursor;
  } while (cursor !== null);
  return out;
}

/** An identity with every page of its fields. */
async function identityDetail(api: Api, contract: string, domainSep: string, kind: number): Promise<Json> {
  const target = `/v1/identities/${contract}/${domainSep}/${kind}?limit=500`;
  const first = await get(api, target);
  expect(first.status, `${target}: ${JSON.stringify(first.body)}`).toBe(200);
  const detail = first.body;
  for (let cursor = detail.fieldsNextCursor as string | null; cursor !== null; ) {
    const next = await get(api, withParam(target, "cursor", cursor));
    detail.fields.push(...next.body.fields);
    cursor = next.body.fieldsNextCursor;
  }
  return detail;
}

// ── The reference's shapes (as `mip0018-cases.test.ts` reads them) ───────────────────────────────────────────────────

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
  colors: Record<string, RefColor>; events: Record<string, RefEvent[]>;
}

const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, CASES_DIR), "utf8")) as T;
const norm = (h: string): string => h.replace(/^0x/, "").toLowerCase();
const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
  x !== null && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x);

/** The usable common values of an API identity in the expected-state shape (no defaults, nothing unusable). */
function commonOf(detail: Json): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  const { name, symbol, decimals, standards } = detail.common;
  if (name !== null) c.name = name;
  if (symbol !== null) c.symbol = symbol;
  if (decimals !== null) c.decimals = BigInt(decimals) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(decimals) : decimals;
  if (standards !== null) c.standards = (standards as string[]).join(" ");
  return c;
}

/** The API's state of one contract against an expectation ([] when equal): identities, visibility, colored, common
 *  fields, every field's bytes/type/usable flag where the expectation lists them, groups of two or more, counts. */
async function caseDifferences(api: Api, contract: string, expected: ExpectedState): Promise<string[]> {
  const d: string[] = [];
  const tokens = await get(api, `/v1/contracts/${contract}/tokens?limit=500`);
  if (tokens.status !== 200) return [`/v1/contracts/${contract}/tokens answered ${tokens.status}`];
  if (tokens.body.nextCursor !== null) d.push("the contract's identities span more than one page");
  const got = new Map<string, Json>((tokens.body.items as Json[]).filter((i) => i.source === "identity" && i.described).map((i) => [`${i.domainSep}/${i.kind}`, i]));
  const want = new Map(expected.identities.map((e) => [`${norm(e.domainSep)}/${e.kind}`, e]));
  for (const k of want.keys()) if (!got.has(k)) d.push(`identity ${k} expected, absent`);
  for (const k of got.keys()) if (!want.has(k)) d.push(`identity ${k} present, not expected`);
  for (const [k, e] of want) {
    const g = got.get(k);
    if (g === undefined) continue;
    if (e.visible !== true) d.push(`identity ${k}: expected hidden`);
    if (e.colored !== (g.kind !== 3)) d.push(`identity ${k}: colored`);
    const detail = await identityDetail(api, contract, g.domainSep, g.kind);
    if (canon(commonOf(detail)) !== canon(e.common)) d.push(`identity ${k}: common ${canon(commonOf(detail))}, expected ${canon(e.common)}`);
    if ([g.name, g.symbol, g.decimals].join("|") !== [detail.common.name, detail.common.symbol, detail.common.decimals].join("|")) d.push(`identity ${k}: list row and detail differ`);
    if (e.fields !== undefined) {
      const gf = Object.fromEntries((detail.fields as Json[]).map((f) => [f.key.hex, { valType: f.valType, value_hex: f.value.hex, ...(e.fields![f.key.hex]?.usable === undefined ? {} : { usable: f.usable }) }]));
      const ef = Object.fromEntries(Object.entries(e.fields).map(([key, f]) => [key, { valType: f.valType, value_hex: f.value_hex, ...(f.usable === undefined ? {} : { usable: f.usable }) }]));
      if (canon(gf) !== canon(ef)) d.push(`identity ${k}: fields ${canon(gf)}, expected ${canon(ef)}`);
    }
  }
  const multi = (gs: Array<{ symbol: string; members: string[] }>): string =>
    canon(gs.filter((g) => g.members.length >= 2).map((g) => ({ ...g, members: [...g.members].sort() })).sort((a, b) => (a.symbol < b.symbol ? -1 : 1)));
  const gotGroups = (tokens.body.groups as Json[]).map((g) => ({ symbol: dec.decode(Buffer.from(g.symbol.hex, "hex")), members: (g.members as Json[]).map((m) => `${m.domainSep}/${m.kind}`) }));
  const wantGroups = expected.groups.map((g) => ({ symbol: g.symbol, members: g.members.map((m) => `${norm(m.domainSep)}/${m.kind}`) }));
  if (multi(gotGroups) !== multi(wantGroups)) d.push(`groups ${multi(gotGroups)}, expected ${multi(wantGroups)}`);
  const events = await allItems(api, `/v1/events?contract=${contract}&limit=500`);
  const n = (c: string): number => events.filter((x) => x.classification === c).length;
  if (n("unresolved") !== 0) d.push(`unresolved ${n("unresolved")}`); // none exists in the recorded cases
  if (expected.counts !== undefined) {
    // The API serves the MIP-0018-named events (accepted, rejected) only; the reference also counts ignored ones.
    const { events: all, accepted, rejected, ignored } = expected.counts as { events: number; accepted: number; rejected: number; ignored: number };
    if (n("accept") !== accepted || n("reject") !== rejected || accepted + rejected + ignored !== all)
      d.push(`counts accepted ${n("accept")} rejected ${n("reject")}, expected ${canon(expected.counts)}`);
  }
  return d;
}

/** The contract is unknown to the scan (no deploy, call, mint or field yet) and has no event. */
async function caseAbsent(api: Api, contract: string): Promise<string[]> {
  const d: string[] = [];
  const tokens = await get(api, `/v1/contracts/${contract}/tokens`);
  if (tokens.status !== 404) d.push(`/v1/contracts/${contract}/tokens answered ${tokens.status}`);
  if ((await allItems(api, `/v1/events?contract=${contract}`)).length !== 0) d.push("events present");
  return d;
}

// ── The crawl compared with the Node handler ─────────────────────────────────────────────────────────────────────

/** The crawl's targets, read from `api`'s own answers (every page through the cursors it hands out). */
async function crawlTargets(api: Api): Promise<string[]> {
  const targets: string[] = ["/v1/status"];
  const colors = new Set<string>();
  const contracts = new Set<string>();
  const identities = new Set<string>();
  const txs = new Set<string>();
  async function walk(first: string, each: (body: Json) => void, cursorOf: (body: Json) => string | null = (b) => b.nextCursor, base = first): Promise<void> {
    let target = first;
    for (;;) {
      targets.push(target);
      const r = await get(api, target);
      expect(r.status, `${target}: ${JSON.stringify(r.body)}`).toBe(200);
      each(r.body);
      const cursor = cursorOf(r.body);
      if (cursor === null) return;
      target = withParam(base, "cursor", cursor);
    }
  }
  await walk("/v1/tokens?limit=4", (b) => {
    for (const i of b.items as Json[]) {
      if (i.color !== null) colors.add(i.color);
      if (i.contractAddress !== null) contracts.add(i.contractAddress);
      if (i.source === "identity") identities.add(`${i.contractAddress}/${i.domainSep}/${i.kind}`);
    }
  });
  for (const color of [...colors].sort()) {
    targets.push(`/v1/tokens/${color}`, `/v1/lookup/${color}?held=shielded`, `/v1/lookup/${color}?held=unshielded`);
    for (const order of ["asc", "desc"]) await walk(`/v1/tokens/${color}/activity?limit=3&order=${order}`, () => {});
  }
  for (const contract of [...contracts].sort()) {
    await walk(`/v1/contracts/${contract}/tokens?limit=2`, (b) => {
      for (const i of b.items as Json[]) identities.add(`${i.contractAddress}/${i.domainSep}/${i.kind}`);
    });
    for (const order of ["asc", "desc"]) await walk(`/v1/contracts/${contract}/activity?limit=2&order=${order}`, () => {});
    await walk(`/v1/events?contract=${contract}&limit=3`, (b) => {
      for (const e of b.items as Json[]) txs.add(e.txHash);
    });
  }
  for (const id of [...identities].sort()) await walk(`/v1/identities/${id}?limit=1`, () => {}, (b) => b.fieldsNextCursor);
  for (const tx of [...txs].sort()) targets.push(`/v1/events?tx=${tx}`);
  const someColor = [...colors].sort()[0]!;
  targets.push(
    "/v1/tokens/zz", `/v1/tokens/${"0".repeat(64)}`, `/v1/tokens/${"0".repeat(64)}/activity`, `/v1/tokens/${"ab".repeat(32)}`,
    `/v1/lookup/${someColor}`, `/v1/lookup/${"0".repeat(64)}?held=shielded`, `/v1/lookup/${"0".repeat(64)}?held=unshielded`,
    "/v1/nope", "/v1/tokens?limit=0", "/v1/tokens?limit=501", "/v1/tokens?cursor=bogus", "/v1/tokens?limit=1&limit=2", "//v1/tokens", "/v1/tokens/",
    `/v1/identities/${"ab".repeat(32)}/${"cd".repeat(32)}/4`, `/v1/identities/${"ab".repeat(32)}/${"cd".repeat(32)}/1`,
    `/v1/contracts/${"ab".repeat(32)}/tokens`, `/v1/contracts/${"ab".repeat(32)}/activity`, "/v1/events", `/v1/events?contract=${"ab".repeat(32)}`,
    `/v1/tokens/${someColor}/activity?order=sideways`, `/v1/contracts/${[...contracts].sort()[0]!}/activity?cursor=${encodeURIComponent("eyJlIjoidG9rZW5zIn0")}`,
  );
  return targets;
}

/** Differences between two answers to one request ([] when equal); `/v1/status` apart from `durability`. */
function answerDifferences(target: string, browser: Answer, node: Answer): string[] {
  if (target === "/v1/status") {
    const strip = (a: Answer) => {
      const { durability: _d, ...rest } = JSON.parse(a.body) as Record<string, unknown>;
      const { "content-length": _l, ...headers } = a.headers;
      return { status: a.status, headers, body: rest };
    };
    return canon(strip(browser)) === canon(strip(node)) ? [] : [`${target}: ${canon(strip(browser))} vs ${canon(strip(node))}`];
  }
  return canon(browser) === canon(node) ? [] : [`${target}: browser ${browser.status} ${browser.body.slice(0, 300)} vs node ${node.status} ${node.body.slice(0, 300)}`];
}

// ── The suite ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("browser parity in Chrome", () => {
  let out: string;
  let site: EngineSite;
  const browsers: Browser[] = [];
  const caseIndex = loadCaseIndex();
  const contractOf = (c: string): string => caseIndex.cases[c]!.contract!;
  const heightsOf = (c: string): number[] => caseIndex.cases[c]!.heights;
  const lastOf = (c: string): number => Math.max(...heightsOf(c));
  const firstOf = (c: string): number => Math.min(...heightsOf(c));
  const IDX_CASES = ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C10"].sort((a, b) => lastOf(a) - lastOf(b));
  const C06_STEPS = caseIndex.cases.C06!.steps.filter((s) => s.expectedAfter !== undefined);
  const PER_KEY = new Set(["withdraw", "withdraw-again", "revive"]);
  /** The expectation of a case at the end of its range (C06: UmbraDB's own per-key file). */
  const expectation = (c: string): ExpectedState => read<ExpectedState>(c === "C06" ? "C06/umbradb-per-key/expected.json" : `${c}/expected.json`);
  const c06After = (step: string): ExpectedState => {
    const s = C06_STEPS.find((x) => x.id === step)!;
    return read<ExpectedState>(PER_KEY.has(s.id) ? `C06/umbradb-per-key/${s.expectedAfter!}` : `C06/${s.expectedAfter!}`);
  };

  beforeAll(async () => {
    if (browserExe === undefined) throw new Error("no Chromium/Chrome found: set MIP0018_UI_BROWSER or CHROME_BIN (see token-indexer/mip0018/ui/README.md)");
    out = await buildEngineSite(NO_AUTO_START);
    await buildVectorConsumerPage(out);
    site = await serveEngineSite(out);
  }, 240_000);

  afterAll(async () => {
    for (const b of browsers.splice(0)) await b.close();
    await site?.close();
    if (out !== undefined) rmSync(out, { recursive: true, force: true });
    for (const c of nodeClients.splice(0)) await c.end({ timeout: 5 });
    await nodeDatabase?.stop();
  }, 60_000);

  async function newBrowser(): Promise<Browser> {
    const b = await Browser.launch(browserExe!);
    browsers.push(b);
    return b;
  }

  /** A new browser profile with the engine page open and booted on a new OPFS store. */
  async function freshEngine(): Promise<{ page: Page; d: ReturnType<typeof engineDriver>; api: Api }> {
    const page = await (await newBrowser()).newPage();
    const d = engineDriver(page, () => site);
    const s = await d.open();
    expect(s.boot.phase).toBe("ready");
    expect(s.store).toMatchObject({ dataDir: "opfs-ahp://umbradb-stagenet", created: true, durability: "non-durable" });
    const api: Api = (method, target) => d.engine(`c.api(${JSON.stringify(method)}, ${JSON.stringify(target)})`) as Promise<Answer>;
    return { page, d, api };
  }

  /** Runs the engine on the replayed range from its first height to `to`, then stops it (the API is served by the
   *  store, as it is between runs). */
  async function runTo(d: ReturnType<typeof engineDriver>, range: "idx" | "u1", from: number, to: number): Promise<void> {
    const config: StartConfig = { source: { kind: "tape", range }, startHeight: from, endHeight: to, ...FAST };
    await d.engine(`c.start(${JSON.stringify(config)})`);
    const done = await d.until(`${range} synced and scanned to ${to}`, (s: HostStatus) => s.engine!.status.sync.phase === "done" && s.cursors?.scan?.nextHeight === to + 1, 240_000);
    expect(done.cursors).toMatchObject({ sync: { height: to, startHeight: from }, scan: { fromHeight: from, nextHeight: to + 1 } });
    expect(done.engine!.error).toBeNull();
    const stopped = (await d.engine("c.stop()")) as HostStatus;
    expect(stopped.engine?.running).toBe(false);
  }

  // The IDX range in one profile, stopped at each case's last block and at each C06 step; U1 in another.
  let idxPrepared: Promise<{ api: Api; checked: string[]; differences: string[]; c06Marks: Array<{ step: string; api: Json; want: Json }> }> | undefined;
  let u1Prepared: Promise<{ api: Api }> | undefined;

  const idxRun = () => (idxPrepared ??= (async () => {
    const { page, d, api } = await freshEngine();
    const stops = [...new Set([...IDX_CASES.map(lastOf), ...C06_STEPS.map((s) => s.height!)])].sort((a, b) => a - b);
    const checked: string[] = [];
    const differences: string[] = [];
    const c06Marks: Array<{ step: string; api: Json; want: Json }> = [];
    for (const stop of stops) {
      await runTo(d, "idx", IDX.from, stop);
      for (const c of IDX_CASES) {
        let want: ExpectedState | undefined;
        let label = c;
        if (lastOf(c) <= stop) want = expectation(c);
        else if (firstOf(c) <= stop) {
          // Only C06 is stopped inside its own range: at each of its steps.
          const step = C06_STEPS.find((s) => s.height === stop);
          expect(c === "C06" && step !== undefined, `${c} is stopped inside its range at ${stop}`).toBe(true);
          want = c06After(step!.id);
          label = `C06:${step!.id}`;
          for (const e of want.identities) {
            const detail = await identityDetail(api, contractOf("C06"), norm(e.domainSep), e.kind);
            c06Marks.push({ step: step!.id, api: detail.mark, want: e });
          }
        }
        if (want === undefined) {
          differences.push(...(await caseAbsent(api, contractOf(c))).map((x) => `${c} before its first block, at ${stop}: ${x}`));
          continue;
        }
        differences.push(...(await caseDifferences(api, contractOf(c), want)).map((x) => `${label} at ${stop}: ${x}`));
        checked.push(`${label}@${stop}`);
      }
    }
    expect(page.exceptions).toEqual([]);
    expect(site.chainRequests).toEqual([]); // the tape is replayed inside the worker: nothing came over the network
    return { api, checked, differences, c06Marks };
  })());

  const u1Run = () => (u1Prepared ??= (async () => {
    const { page, d, api } = await freshEngine();
    await runTo(d, "u1", U1.from, U1.to);
    expect(page.exceptions).toEqual([]);
    return { api };
  })());

  it("[[browser.parity.vectors]] the 110 vector requests (59/59 reference normative, 43/43 informative, 8/8 UmbraDB versions) answered through the PGlite store in a worker on OPFS in Chrome pass with every check applicable, and every answer equals the pure consumer's", async () => {
    const browser = await newBrowser();
    const page = await browser.newPage();
    await page.goto(`${site.origin}${VECTOR_CONSUMER_PAGE}`);
    await page.waitFor("window.vectorConsumer !== undefined", 30_000, "the vector consumer page");
    const info = await page.eval("window.vectorConsumer.info()");
    expect(info).toMatchObject({ dataDir: "opfs-ahp://umbradb-vector-consumer", created: true, fsync: "off", durability: "non-durable" });
    expect(info.version).toMatch(/^PostgreSQL 18\.3 \(PGlite 0\.5\.8\)/);

    const sets = vectorSets();
    const referenceVectors = loadVectors({ dir: VENDORED_VECTORS_DIR, only: sets.reference.map((v) => v.id) });
    const ownVectors = loadVectors({ dir: UMBRADB_VECTORS_DIR });
    const responses = new Map<string, VectorJson>();
    const consumer = async (req: VectorJson): Promise<VectorJson> => {
      const res = (await page.eval(`window.vectorConsumer.handle(${JSON.stringify(req)})`)) as VectorJson;
      responses.set(String(req.id), res);
      return res;
    };
    const failures = (report: Awaited<ReturnType<typeof runVectors>>): string[] => report.results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.failures.join("; ")}`);
    const reference = await runVectors(referenceVectors, consumer);
    expect(failures(reference)).toEqual([]);
    expect(reference.normative).toEqual({ passed: 59, total: 59 });
    expect(reference.informative).toEqual({ passed: 43, total: 43 });
    expect(reference.notApplicable).toEqual({});
    const own = await runVectors(ownVectors, consumer);
    expect(failures(own)).toEqual([]);
    expect(own.normative).toEqual({ passed: 8, total: 8 });
    expect(own.notApplicable).toEqual({});
    expect(await page.eval("window.vectorConsumer.created()")).toBe(110); // a fresh schema per request…
    expect(await page.eval(`window.vectorConsumer.schemas(${JSON.stringify(info.schemaPrefix)})`)).toBe(0); // …each dropped after its request

    // The pure consumer's answer, request by request; the only allowed difference is the decode `offset` (informative)
    // the database path cannot reproduce from the stored bytes (a payload longer than 256 bytes is stored empty).
    const differences: string[] = [];
    const withoutOffset: string[] = [];
    for (const v of [...referenceVectors, ...ownVectors] as LoadedVector[]) {
      const want = handleRequest(JSON.parse(JSON.stringify(requestFor(v))));
      const got = responses.get(v.entry.id)!;
      if (want.offset !== undefined && got.offset === undefined) {
        withoutOffset.push(v.entry.id);
        delete want.offset;
      }
      if (JSON.stringify(got) !== JSON.stringify(want)) differences.push(`${v.entry.id}: pure ${JSON.stringify(want)} vs browser ${JSON.stringify(got)}`);
    }
    expect(differences).toEqual([]);
    expect(withoutOffset).toEqual(["INF-ZEXT-7"]);
    expect(responses.size).toBe(110);
    expect(page.exceptions).toEqual([]);
    await browser.close(); // its profile is not used again
    browsers.splice(browsers.indexOf(browser), 1);
  }, 600_000);

  it("[[browser.parity.case-stop-heights]] through the engine worker's API, each recorded case replayed in the worker only up to its own last block (and C06 at each step) equals its expectation while every later case is still absent; earlier cases stay equal; U1 at its last block", async () => {
    const idx = await idxRun();
    expect(idx.differences).toEqual([]);
    // 9 + 8 + … + 1 comparisons at the cases' last blocks, plus C01–C05 and C06's step at each of C06's four other steps.
    expect(idx.checked).toHaveLength(45 + 4 * 6);
    expect(idx.checked.filter((x) => x.startsWith("C06:")).map((x) => x.split("@")[0])).toEqual(["C06:publish", "C06:rename", "C06:withdraw", "C06:withdraw-again"]);
    // Negative controls: the comparison sees a wrong expectation (another case's file; C06's reference file with
    // identity-wide tombstones, which the per-key state must NOT match).
    expect(await caseDifferences(idx.api, contractOf("C02"), expectation("C03"))).not.toEqual([]);
    expect(await caseDifferences(idx.api, contractOf("C06"), read<ExpectedState>("C06/expected.json"))).not.toEqual([]);
    // C09: a refused call, no transaction; C01's contract (C09's) is exactly C01's expectation with its one event.
    expect(caseIndex.cases.C09!.contract).toBe(contractOf("C01"));
    expect(await caseDifferences(idx.api, contractOf("C09"), read<ExpectedState>("C01/expected.json"))).toEqual([]);
    expect((await allItems(idx.api, `/v1/events?contract=${contractOf("C09")}`)).map((e) => e.classification)).toEqual(["accept"]);

    const u1 = await u1Run();
    expect(await caseDifferences(u1.api, contractOf("U1"), read<ExpectedState>("U1/expected.json"))).toEqual([]);
  }, 900_000);

  it("[[browser.parity.case-reference-index]] through the engine worker's API at the end of IDX and U1: the reference index's colors (first and last mint, mint count, amount), v1-named events (position, segment, phase, classification, reason) and range, and IDX/expected.json's colors through /v1/lookup; exactly 6 colors in IDX", async () => {
    for (const [range, file, prepared] of [["idx", "IDX/index-summary.json", idxRun], ["u1", "U1/index-summary.json", u1Run]] as const) {
      const { api } = await prepared();
      const ref = read<IndexSummary>(file);
      const status = (await get(api, "/v1/status")).body;
      expect({ genesisHash: status.genesisHash, from: status.startHeight, indexed: status.indexedHeight, archive: status.archiveHeight }, range)
        .toEqual({ genesisHash: ref.network.genesisHash, from: ref.fromHeight, indexed: ref.nextHeight - 1, archive: ref.lastBlock.height });

      // Colors: the identities' colors in the token list, then each color's mints from its own activity.
      const listed = new Set((await allItems(api, "/v1/tokens?limit=500")).filter((i) => i.source === "identity" && i.color !== null).map((i) => i.color as string));
      expect([...listed].sort(), range).toEqual(Object.keys(ref.colors).sort());
      for (const rc of Object.values(ref.colors)) {
        const token = await get(api, `/v1/tokens/${rc.color}`);
        expect(token.status).toBe(200);
        expect([token.body.contractAddress, token.body.domainSep]).toEqual([rc.contractAddress, rc.domainSep]);
        const activity = await allItems(api, `/v1/tokens/${rc.color}/activity?limit=500`);
        for (const [kind, key] of [[1, "shielded"], [2, "unshielded"]] as const) {
          const mints = activity.filter((a) => a.role === "mint" && a.kind === kind);
          const stats = rc[key];
          const identity = (token.body.identities as Json[]).find((i) => i.kind === kind);
          if (stats === undefined) {
            expect(mints, `${rc.color} kind ${kind}`).toEqual([]);
            expect(identity?.minted ?? null).toBeNull();
            continue;
          }
          const point = (a: Json) => ({ height: a.height, txHash: a.txHash });
          expect({
            firstMint: point(mints[0]), lastMint: point(mints.at(-1)), mints: mints.length,
            amount: mints.reduce((s, a) => s + BigInt(a.amount), 0n).toString(),
          }, `${rc.color} ${key}`).toEqual({
            firstMint: { height: stats.firstMint.height, txHash: stats.firstMint.txHash }, lastMint: { height: stats.lastMint.height, txHash: stats.lastMint.txHash },
            mints: stats.mints, amount: stats.amount,
          });
          expect({ height: identity.minted.firstMint.height, txHash: identity.minted.firstMint.txHash, mints: identity.minted.mints, amount: identity.minted.amount })
            .toEqual({ height: stats.firstMint.height, txHash: stats.firstMint.txHash, mints: stats.mints, amount: stats.amount });
        }
      }

      // Events: the reference index lists the v1-named events of each contract; the API serves exactly those.
      for (const [contract, events] of Object.entries(ref.events)) {
        const served = await allItems(api, `/v1/events?contract=${contract}&limit=500`);
        expect(served.map((e) => ({ height: e.height, txIndex: e.txIndex, txHash: e.txHash, eventIndex: e.eventIndex, segment: e.segment, phase: e.phase, result: e.classification, reason: e.reason })), `${range} ${contract}`)
          .toEqual(events.map((e) => ({ height: e.block.height, txIndex: e.txIndex, txHash: e.txHash, eventIndex: e.eventIndex, segment: e.segment, phase: e.phase, result: e.result, reason: e.reason ?? null })));
      }
    }
    const idxRef = read<IndexSummary>("IDX/index-summary.json");
    expect(Object.keys(idxRef.colors)).toHaveLength(6);

    // IDX/expected.json: every matrix color (and C05 bronze, never minted) resolves through the lookup with the held
    // kind, and its identity carries the expected metadata.
    const { api } = await idxRun();
    const entries = read<IdxExpected>("IDX/expected.json").colors;
    expect(entries.map((e) => `${e.case}/${e.kind}/${e.minted}`)).toEqual(["C02/1/true", "C03/2/true", "C04/1/true", "C04/2/true", "C05/1/true", "C05/1/true", "C05/1/false"]);
    for (const e of entries) {
      const contract = contractOf(e.case);
      const color = tokenColor(norm(e.domainSep), contract);
      const lookup = (await get(api, `/v1/lookup/${color}?held=${e.kind === 1 ? "shielded" : "unshielded"}`)).body;
      expect([lookup.found, lookup.result], `${e.case} ${e.domainSep}`).toEqual(e.minted ? [true, "identity"] : [false, "not-minted-in-indexed-range"]);
      if (e.minted) expect([lookup.identity.contractAddress, lookup.identity.domainSep, lookup.identity.kind]).toEqual([contract, norm(e.domainSep), e.kind]);
      const detail = await identityDetail(api, contract, norm(e.domainSep), e.kind);
      expect({ domainSep: `0x${detail.domainSep}`, kind: detail.kind, visible: true, colored: detail.kind !== 3, common: commonOf(detail) }).toEqual(e.identity);
    }
  }, 900_000);

  it("[[browser.parity.case-marks-activity]] through the engine worker's API: every case identity's mark (and C06's after each step) equals the mark rule applied to the reference expectations and the reference index's rejections; the third party's minted token has no mark; every case contract's metadata transactions are the reference index's, with their counts; C05 bronze, never minted, has no color", async () => {
    const idxRef = read<IndexSummary>("IDX/index-summary.json");
    const u1Ref = read<IndexSummary>("U1/index-summary.json");
    const rejections = (contract: string): string[] =>
      [...(idxRef.events[contract] ?? []), ...(u1Ref.events[contract] ?? [])].filter((e) => e.result === "reject").map((e) => e.reason!);
    /** The mark rule: ⚠ incorrect when the contract has a rejected MIP-0018 event; ✓ when name, symbol and decimals are
     *  usable; ⚠ partial otherwise; usable `standards` identifiers as tags. */
    const oracle = (e: ExpectedIdentity, contract: string) => {
      const missing = (["name", "symbol", "decimals"] as const).filter((k) => e.common[k] === undefined);
      const reasons = rejections(contract);
      const tags = typeof e.common.standards === "string" ? [...new Set(e.common.standards.split(" "))] : [];
      return { mark: reasons.length > 0 ? "incorrect" : missing.length === 0 ? "ok" : "partial", reasons, missing, tags };
    };
    const ofApi = (m: Json) => {
      expect(m.reasonCount).toBe(m.reasons.length);
      expect(m.unresolved).toEqual({ count: 0, positions: [] });
      return { mark: m.mark, reasons: m.reasons, missing: m.missing, tags: m.tags };
    };
    const idx = await idxRun();
    const u1 = await u1Run();
    const summary: Record<string, string[]> = {};
    for (const c of ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10", "U1"]) {
      const api = c === "U1" ? u1.api : idx.api;
      const expected = read<ExpectedState>(c === "C06" ? "C06/umbradb-per-key/expected.json" : c === "C09" ? "C01/expected.json" : `${c}/expected.json`);
      const marks: string[] = [];
      for (const e of expected.identities) {
        const detail = await identityDetail(api, contractOf(c), norm(e.domainSep), e.kind);
        expect(ofApi(detail.mark), `${c} ${e.domainSep}/${e.kind}`).toEqual(oracle(e, contractOf(c)));
        marks.push(detail.mark.mark + (detail.mark.tags.length > 0 ? `+${detail.mark.tags.join(",")}` : ""));
      }
      summary[c] = marks;
    }
    expect(summary).toEqual({
      C01: ["ok"], C02: ["ok"], C03: ["ok"], C04: ["ok", "ok", "ok"], C05: ["ok", "ok", "ok"], C06: ["ok+mip-0004"],
      C07: ["incorrect"], C08: ["incorrect"], C09: ["ok"], C10: ["ok+mip-0004"], U1: ["ok"],
    });
    // C06 step by step (read while the IDX range was stopped at each step): ✓ after publish and rename, ⚠ partial (no
    // name) after the withdraw and the withdraw again, ✓ after the revive.
    for (const m of idx.c06Marks) expect(ofApi(m.api), m.step).toEqual(oracle(m.want, contractOf("C06")));
    expect(idx.c06Marks.map((m) => `${m.step}:${m.api.mark}${m.api.missing.length > 0 ? `(${m.api.missing.join(",")})` : ""}`))
      .toEqual(["publish:ok", "rename:ok", "withdraw:partial(name)", "withdraw-again:partial(name)"]);
    expect(summary.C06).toEqual(["ok+mip-0004"]); // after the revive (C06's last block)

    // The only minted token outside the cases never emitted an event: no mark.
    const caseContracts = new Set(Object.values(caseIndex.cases).map((k) => k.contract));
    const third = (await allItems(idx.api, "/v1/tokens?limit=500")).filter((i) => i.source === "identity" && i.color !== null && !caseContracts.has(i.contractAddress));
    expect(third.map((t) => [t.contractAddress, t.mark])).toEqual([[
      caseIndex.otherTransactions.find((o) => o.height === 714802)!.calls[0], { mark: "none", reasons: [], reasonCount: 0, unresolved: { count: 0, positions: [] }, missing: [], tags: [] },
    ]]);

    // Metadata transactions per case contract = the reference index's events grouped by transaction.
    const rows: Record<string, number> = {};
    for (const c of ["C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C10", "U1"]) {
      const ref = (c === "U1" ? u1Ref : idxRef).events[contractOf(c)] ?? [];
      const perTx = new Map<string, { height: number; accepted: number; rejected: number; firstEventIndex: number }>();
      for (const e of ref) {
        const t = perTx.get(e.txHash) ?? { height: e.block.height, accepted: 0, rejected: 0, firstEventIndex: e.eventIndex };
        if (e.result === "accept") t.accepted++;
        else t.rejected++;
        t.firstEventIndex = Math.min(t.firstEventIndex, e.eventIndex);
        perTx.set(e.txHash, t);
      }
      const items = await allItems(c === "U1" ? u1.api : idx.api, `/v1/contracts/${contractOf(c)}/activity?limit=500`);
      expect(items.map((i) => [i.txHash, i.height, i.events]), c).toEqual([...perTx].map(([tx, t]) => [tx, t.height, { accepted: t.accepted, rejected: t.rejected, firstEventIndex: t.firstEventIndex }]));
      expect(items.every((i) => i.role === "metadata-event" && i.contract === contractOf(c)), c).toBe(true);
      const stepTx = new Set(caseIndex.cases[c]!.steps.map((s) => s.txHash));
      expect(items.every((i) => stepTx.has(i.txHash)), c).toBe(true);
      rows[c] = items.length;
    }
    expect(rows).toEqual({ C01: 1, C02: 1, C03: 1, C04: 1, C05: 3, C06: 5, C07: 18, C08: 1, C10: 1, U1: 1 });
    // C09 (C01's contract): only C01's publish.
    expect((await allItems(idx.api, `/v1/contracts/${contractOf("C09")}/activity`)).map((i) => i.txHash))
      .toEqual([caseIndex.cases.C01!.steps.find((s) => s.id === "publish")!.txHash]);
    // C05 bronze: described, never minted → its color is unknown to the API.
    const bronze = tokenColor(Buffer.concat([Buffer.from("mip-0018:example:family:bronze"), Buffer.alloc(32)]).subarray(0, 32).toString("hex"), contractOf("C05"));
    expect((await get(idx.api, `/v1/tokens/${bronze}/activity`)).status).toBe(404);
    expect((await get(idx.api, `/v1/tokens/${bronze}`)).status).toBe(404);
  }, 900_000);

  // The same ranges synced and scanned in Node, on the suite's backend, answered by the Node handler.
  let nodeDatabase: TestDatabase | undefined;
  const nodeClients: UmbraDBSql[] = [];
  async function nodeHandler(range: "idx" | "u1", from: number, to: number): Promise<Mip0018Handler> {
    nodeDatabase ??= await openTestDatabase();
    const mip = `parity_${range}_mip`;
    const archive = `parity_${range}_arch`;
    const sql = nodeDatabase.client(mip);
    nodeClients.push(sql);
    const chain = fakeChainFetch(loadRangeTape(range));
    const engine: IndexerEngine = createIndexerEngine({
      sql, network: NET, schema: mip, archiveSchema: archive, fetch: chain.fetch,
      sync: { nodeUrl: chain.nodeUrl, indexerUrl: chain.indexerUrl, startHeight: from, endHeight: to, maxBlocks: 100, backoff: { jitter: false } },
      scan: { batch: 100 },
    });
    await engine.start();
    const deadline = Date.now() + 240_000;
    while (!(engine.status().sync.phase === "done" && (await engine.scanCursor())?.nextHeight === to + 1)) {
      if (Date.now() > deadline) throw new Error(`the Node engine did not finish ${range}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    await engine.stop();
    // Like the browser between runs: the handler of the store with no loops.
    return createMip0018Handler({ sql, network: NET, schema: mip, archiveSchema: archive });
  }

  it("[[browser.parity.api-equals-node]] every answer of a crawl of the API (every listing page, color, lookup, identity field page, contract, event page and transaction, activity pages in both orders, error answers, HEAD and a refused method) from the engine worker equals the Node handler's over the same range synced and scanned in Node: status, headers and body, /v1/status apart from durability", async () => {
    const counts: Record<string, number> = {};
    for (const [range, prepared, r] of [["idx", idxRun, IDX], ["u1", u1Run, U1]] as const) {
      const { api: browser } = await prepared();
      const node = await nodeHandler(range, r.from, r.to);
      const nodeApi: Api = (method, target) => node.handle(method, target);
      const targets = await crawlTargets(browser);
      const differences: string[] = [];
      const statuses = new Set<number>();
      for (const target of targets) {
        const b = await browser("GET", target);
        statuses.add(b.status);
        differences.push(...answerDifferences(target, b, await nodeApi("GET", target)));
      }
      for (const [method, target] of [["HEAD", "/v1/tokens"], ["HEAD", "/v1/nope"], ["POST", "/v1/status"], ["DELETE", "/v1/tokens"]] as const)
        differences.push(...answerDifferences(`${method} ${target}`, await browser(method, target), await nodeApi(method, target)));
      expect(differences, range).toEqual([]);
      expect(JSON.parse((await browser("GET", "/v1/status")).body).durability).toBe("non-durable");
      expect([...statuses].sort(), range).toEqual([200, 400, 404]);
      counts[range] = targets.length + 4;
    }
    expect(counts).toEqual({ idx: 222, u1: 46 });
  }, 900_000);
});
