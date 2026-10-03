/**
 * The explorer page in a real browser (project 00026, sub-plan C3; spec FR-030, US4/US5, SC-004; plan C Testing rows
 * "Page" and "Tombstone"). Headless Chromium/Chrome driven over the DevTools protocol (`helpers/cdp-browser.ts`, no
 * npm dependency); the page is served by the real entry point `serve()` (API + `/ui` hook) bound to 127.0.0.1.
 *
 * Data: the recorded Stagenet IDX range (sub-plan D1 tapes) archived by the real sync against the fake chain and
 * scanned by the real scanner; C06's lifecycle replayed step by step while the page stays open (periodic refresh);
 * synthetic archive blocks for what Stagenet does not show (hostile text, a partial and an unusable token, a whole
 * identity withdrawn, a color seen without a mint). The activity endpoints are not in this branch yet (C1 wires them
 * after C2): the routes test asserts whatever the API answers (404 → the "not served" note; 200 → the rows), and
 * `[[mip0018.ui.browser-activity-shape]]` renders C2's documented row shape from a stub route of the test server.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH (see
 * `ui/README.md`). `MIP0018_UI_SCREENSHOTS=<dir>` saves PNGs of the list and some views (never committed).
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { type ArchiveTape, startFakeChain } from "../../test/integration/fixtures/stagenet-archive/fake-chain-server.js";
import { loadCaseIndex, loadRangeTape } from "../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import { createMip0018Api, listen } from "../mip0018/api.ts";
import { Mip0018Scanner } from "../mip0018/scan.ts";
import { serve, type ServeHandle } from "../mip0018/serve-cli.ts";
import { serveUi } from "../mip0018/ui/page.ts";
import { EVENT_NAME, encodePayload, type MetadataRecord, record } from "../vendor/mip0018/codec/src/index.ts";
import { Browser, findBrowser, type Page } from "./helpers/cdp-browser.ts";
import { decodeSynthetic, putSyntheticBlocks, type SynthArchivedTx, type SynthLog } from "./helpers/synthetic-archive.ts";

const NET = "stagenet";
const WALLET_1 = "mn_addr_stagenet1vw57646su9y5z6myarm93m6kcn62j97z0yma94lfkhmta6pz5h5q6utr3k";
const SHOTS = process.env.MIP0018_UI_SCREENSHOTS;
// Raw characters a value may carry that must never reach the drawn text or a tooltip (tab/newline excepted in
// innerText, which uses them for layout).
const HIDDEN_RAW = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
const HIDDEN_RAW_ATTR = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
interface Snap { route: string; state: string; view: string; text: string; attrs: string[]; hrefs: string[]; banner: string | null; strip: string }

/** What the page shows now: the drawn text, every attribute value inside the view/banner/strip, and the view's links. */
const SNAP = `(() => {
  const view = document.getElementById('view');
  const banner = document.getElementById('banner');
  const strip = document.getElementById('strip');
  const attrs = [];
  for (const root of [view, banner, strip]) for (const e of [root, ...root.querySelectorAll('*')]) for (const a of e.attributes) attrs.push(a.value);
  return { route: document.body.getAttribute('data-route'), state: document.body.getAttribute('data-state'), view: view.innerText,
    text: document.body.innerText, attrs, hrefs: [...view.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
    banner: banner.hidden ? null : banner.innerText, strip: strip.innerText };
})()`;

/** The page's route key of a hash (mirrors `parseRoute`/`routeKey` in page.js). */
function keyOf(hash: string): string {
  const p = hash.replace(/^#/, "").split("/").slice(1);
  if (hash === "#/" || hash === "#" || hash === "") return "list";
  if (p[0] === "token") return `identity/${p[1]}/${p[2]}/${p[3]}`;
  if (p[0] === "color" || p[0] === "contract" || p[0] === "tx") return `${p[0]}/${p[1]}`;
  if (p[0] === "builtin" && p[1] === "DUST") return "dust";
  if (p[0] === "status" && p.length === 1) return "status";
  return "unknown";
}

async function visit(page: Page, hash: string): Promise<Snap> {
  const key = keyOf(hash);
  await page.eval(`location.hash = ${JSON.stringify(hash)}`);
  await page.waitFor(`document.body.getAttribute('data-route') === ${JSON.stringify(key)} && document.body.getAttribute('data-state') !== 'loading'`, 30_000, `route ${hash}`);
  return page.eval<Snap>(SNAP);
}

/** Every route reachable from `start` through the view's links (breadth first). */
async function crawl(page: Page, start: readonly string[], limit = 120): Promise<Map<string, Snap>> {
  const seen = new Map<string, Snap>();
  const queue = [...start];
  while (queue.length > 0 && seen.size < limit) {
    const h = queue.shift()!;
    if (seen.has(h)) continue;
    const snap = await visit(page, h);
    seen.set(h, snap);
    for (const x of snap.hrefs) if (x.startsWith("#/") && !seen.has(x) && !queue.includes(x)) queue.push(x);
  }
  expect(queue, "crawl limit reached").toEqual([]);
  return seen;
}

/** The routes whose drawn text or attribute values contain `needle`. */
function mentions(c: Map<string, Snap>, needle: string): string[] {
  return [...c].filter(([, s]) => s.text.includes(needle) || s.attrs.some((a) => a.includes(needle))).map(([h]) => h);
}

function shot(page: Page, name: string): Promise<void> | undefined {
  if (SHOTS === undefined || SHOTS === "") return undefined;
  return page.screenshot().then((png) => {
    mkdirSync(SHOTS, { recursive: true });
    writeFileSync(join(SHOTS, name), png);
  });
}

/** Rows of the page's token table (`#tokens`, or the first table of the view). */
const LIST_ROWS = `[...document.querySelectorAll('#view section table')[0].querySelectorAll('tbody tr')].map((tr) => {
  const mk = tr.querySelector('td.mipcol .mk');
  return { mark: mk ? mk.getAttribute('data-mark') : null, markText: mk ? mk.textContent : null, title: mk ? mk.title : null,
    cells: [...tr.cells].map((c) => c.innerText), href: (tr.querySelector('a[href]') || {}).getAttribute ? tr.querySelector('a[href]').getAttribute('href') : null,
    nameTitle: (tr.cells[1].querySelector('.d') || {}).title || null };
})`;

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
      hash: createHash("sha256").update(`c3-ui:${n}`).digest("hex"),
      intents: [{ segment: 1, actions: [{ call: { address, entryPoint: "meta", guaranteed: { logs, ...extra } } }] }],
    },
  };
}
const nullAll = (...keys: string[]): MetadataRecord[] => keys.map((k) => record.tombstone(k));

const browserExe = findBrowser();

describe("MIP-0018 explorer page in a real browser (00026 C3)", () => {
  let container: StartedPostgreSqlContainer;
  let browser: Browser;
  const clients: UmbraDBSql[] = [];
  const handles: ServeHandle[] = [];
  const servers: Server[] = [];
  let counter = 0;
  const caseIndex = loadCaseIndex();
  const contractOf = (c: string): string => caseIndex.cases[c]!.contract!;
  const stepTx = (c: string, id: string): string => caseIndex.cases[c]!.steps.find((s) => s.id === id)!.txHash!;
  let idx: { sql: UmbraDBSql; archive: string; mip: string; base: string };

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

  async function scanAll(s: Mip0018Scanner): Promise<void> {
    for (;;) {
      const r = await s.scanOnce({ maxBlocks: 1_000 });
      if (r.scannedBlocks === 0 || r.reachedEnd) return;
    }
  }

  /** The real entry point, API only (the test scans), on a free port of 127.0.0.1. */
  async function serveDb(db: { sql: UmbraDBSql; archive: string; mip: string }): Promise<string> {
    const h = await serve({ sql: db.sql, network: NET, schema: db.mip, archiveSchema: db.archive, apiOnly: true, port: 0, log: () => {} });
    handles.push(h);
    expect(h.host).toBe("127.0.0.1");
    return `http://127.0.0.1:${h.port}`;
  }

  async function api(base: string, path: string): Promise<{ status: number; json: Json }> {
    const r = await fetch(base + path);
    const text = await r.text();
    return { status: r.status, json: text === "" ? undefined : JSON.parse(text) };
  }

  /** The page's own requests: same origin, only the page's assets and the API's endpoints, nothing blocked. */
  function expectOnlyApiCalls(page: Page, base: string): string[] {
    const origin = new URL(base).origin;
    const ENDPOINTS = [
      /^\/v1\/status$/, /^\/v1\/tokens$/, /^\/v1\/tokens\/[0-9a-f]{64}$/, /^\/v1\/identities\/[0-9a-f]{64}\/[0-9a-f]{64}\/[123]$/,
      /^\/v1\/contracts\/[0-9a-f]{64}\/tokens$/, /^\/v1\/events$/, /^\/v1\/tokens\/[0-9a-f]{64}\/activity$/, /^\/v1\/contracts\/[0-9a-f]{64}\/activity$/,
    ];
    const paths: string[] = [];
    for (const r of page.requests) {
      if (r.url.startsWith("data:") || r.url === "about:blank") continue;
      const u = new URL(r.url);
      expect(u.origin, r.url).toBe(origin);
      expect(r.method, r.url).toBe("GET");
      expect(r.blockedReason, r.url).toBeUndefined();
      if (u.pathname.startsWith("/v1/")) expect(ENDPOINTS.some((e) => e.test(u.pathname)), r.url).toBe(true);
      else expect(["/ui", "/ui/outfit.woff2", "/ui/favicon.ico", "/favicon.ico"], r.url).toContain(u.pathname);
      paths.push(u.pathname + u.search);
    }
    return paths;
  }

  /** No CSP violation, no uncaught exception, no console error/warning; browser log errors only for expected 404s (`allowed`). */
  async function expectCleanConsole(page: Page, allowed = /\/activity(\?|$)/): Promise<void> {
    expect(await page.eval<string[]>("window.__cspViolations")).toEqual([]);
    expect(page.exceptions).toEqual([]);
    expect(page.console.filter((c) => c.type === "error" || c.type === "warning" || c.type === "assert")).toEqual([]);
    const bad = page.logs.filter((l) => (l.level === "error" || l.level === "warning") && !(l.source === "network" && allowed.test(l.url ?? "")));
    expect(bad).toEqual([]);
  }

  beforeAll(async () => {
    if (browserExe === undefined)
      throw new Error("no Chromium/Chrome: set MIP0018_UI_BROWSER or CHROME_BIN, or run in mcr.microsoft.com/playwright (see token-indexer/mip0018/ui/README.md)");
    browser = await Browser.launch(browserExe);
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    const db = await fresh("uiidx");
    await archiveTape(db, loadRangeTape("idx"), 714485, 715183);
    const s = scanner(db);
    await s.bootstrap();
    await scanAll(s);
    idx = { ...db, base: await serveDb(db) };
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    for (const h of handles) await h.stop();
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
    for (const c of clients) await c.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  it("[[mip0018.ui.browser-routes]] the recorded IDX range: the list shows NIGHT and DUST first, then every API row in order with its ✓/⚠ mark (reason in the tooltip) and standards tags; token, color, built-in, contract, tx and status routes render the API's values; activity as the API answers it; the page makes only same-origin GETs of its assets and the API, with no CSP violation, exception or console error", async () => {
    const page = await browser.newPage();
    await page.goto(`${idx.base}/ui`);
    await page.waitFor("document.body.getAttribute('data-route') === 'list' && document.body.getAttribute('data-state') === 'ready'");
    expect(await page.eval("document.title")).toBe("MIP-0018 token explorer");
    const rows = await page.eval<Json[]>(LIST_ROWS);
    const api16 = (await api(idx.base, "/v1/tokens?limit=500")).json.items as Json[];
    expect(api16).toHaveLength(16);
    expect(rows).toHaveLength(api16.length);
    expect(rows.slice(0, 2).map((r) => [r.cells[1], r.cells[2], r.cells[3]])).toEqual([["NIGHT", "NIGHT", "built-in"], ["DUST", "DUST", "built-in"]]);
    for (const [i, t] of api16.entries()) {
      const r = rows[i]!;
      if (t.source === "builtin") {
        expect(r.mark, t.symbol).toBe(null);
        continue;
      }
      expect(r.mark, t.id).toBe(t.mark.mark);
      expect(r.markText, t.id).toBe({ ok: "\u2713", partial: "\u26a0", incorrect: "\u26a0", none: "" }[t.mark.mark as string]);
      expect(r.cells[1], t.id).toBe(t.name ?? "\u2014");
      expect(r.cells[2], t.id).toBe(t.symbol ?? "\u2014");
      expect(r.cells[3], t.id).toBe(`${t.kind} \u00b7 ${t.kindName}`);
      expect(r.cells[5], t.id).toBe(t.mark.tags.join(""));
      expect(r.href, t.id).toBe(`#/token/${t.contractAddress}/${t.domainSep}/${t.kind}`);
    }
    const byContract = (c: string): Json[] => rows.filter((_, i) => api16[i].contractAddress === contractOf(c));
    expect(byContract("C01").map((r) => [r.mark, r.markText])).toEqual([["ok", "\u2713"]]);
    expect(byContract("C01")[0].title).toMatch(/^\u2713 correct: usable name, symbol and decimals/);
    expect(byContract("C04").map((r) => r.mark)).toEqual(["ok", "ok", "ok"]);
    const c07 = byContract("C07")[0];
    const c07Api = api16.find((t) => t.contractAddress === contractOf("C07"));
    expect([c07.mark, c07.markText]).toEqual(["incorrect", "\u26a0"]);
    expect(c07.title).toContain(`\u26a0 incorrect: its contract has ${c07Api.mark.reasonCount} rejected MIP-0018 events: ${c07Api.mark.reasons.slice(0, 3).join(", ")}`);
    const c08 = byContract("C08")[0];
    expect(c08.mark).toBe("incorrect");
    expect(c08.title.startsWith("\u26a0 incorrect: its contract has 1 rejected MIP-0018 event: reserved-valtype")).toBe(true);
    expect(byContract("C10")[0].cells[5]).toBe("mip-0004");
    const unmarked = rows.filter((_, i) => api16[i].source === "identity" && !api16[i].described);
    expect(unmarked.map((r) => [r.mark, r.markText, r.cells[1]])).toEqual([["none", "", "\u2014"]]);
    await shot(page, "list.png");

    // Every row's route renders (and the built-in rows).
    for (const r of rows) {
      const s = await visit(page, r.href);
      expect(s.state, r.href).toBe("ready");
      expect(s.view, r.href).not.toMatch(/could not be read|no such/);
    }
    // C04 kind 1: identity, common fields, fields, group of three, mark; events of the contract.
    const C04 = contractOf("C04");
    const c04k1 = api16.find((t) => t.contractAddress === C04 && t.kind === 1);
    const d = (await api(idx.base, `/v1/identities/${C04}/${c04k1.domainSep}/1`)).json;
    const s04 = await visit(page, `#/token/${C04}/${c04k1.domainSep}/1`);
    expect(s04.view).toContain("Acme Dollar");
    expect(s04.view).toContain(d.color);
    const fieldRows = await page.eval<string[][]>("[...document.querySelectorAll('#fields tbody tr')].map((tr) => [...tr.cells].map((c) => c.innerText))");
    expect(fieldRows.map((f) => f[0])).toEqual(d.fields.map((f: Json) => f.key.utf8));
    expect(fieldRows.map((f) => f[2])).toEqual(d.fields.map((f: Json) => f.value.text ?? f.value.integer));
    expect(fieldRows.every((f) => f[3] === "usable")).toBe(true);
    const groupLinks = await page.eval<string[]>("[...document.querySelectorAll('#view section')].find((s) => (s.querySelector('h2') || {}).textContent === 'symbol group').innerText");
    expect(groupLinks).toContain("ACD");
    expect(await page.eval<string | null>("document.querySelector('#view .badge[data-mark]').getAttribute('data-mark')")).toBe("ok");
    const ev04 = (await api(idx.base, `/v1/events?contract=${C04}&limit=500`)).json.items as Json[];
    expect(await page.eval<number>("document.querySelectorAll('#events tbody tr').length")).toBe(ev04.length);
    await shot(page, "token-c04.png");

    // C07: the reasons and 18 events (9 accepted, 9 rejected).
    const C07 = contractOf("C07");
    await visit(page, `#/token/${C07}/${c07Api.domainSep}/${c07Api.kind}`);
    expect(await page.eval<number>("[...document.querySelectorAll('#view ol li')].length")).toBe(c07Api.mark.reasons.length);
    expect(await page.eval<string[]>("[...document.querySelectorAll('#events [data-class]')].map((b) => b.getAttribute('data-class'))")).toEqual(
      ((await api(idx.base, `/v1/events?contract=${C07}&limit=500`)).json.items as Json[]).map((e) => e.classification));

    // Activity of C03's unshielded token: as the API answers it.
    const C03 = contractOf("C03");
    const c03 = api16.find((t) => t.contractAddress === C03 && t.kind === 2);
    const act = await api(idx.base, `/v1/tokens/${c03.color}/activity`);
    const s03 = await visit(page, `#/token/${C03}/${c03.domainSep}/2`);
    if (act.status === 404) {
      expect(await page.eval<string | null>("(document.querySelector('#activity [data-activity]') || {}).getAttribute ? document.querySelector('#activity [data-activity]').getAttribute('data-activity') : null")).toBe("unavailable");
      expect(s03.view).toContain("activity is not served by this API yet");
    } else {
      expect(act.status).toBe(200);
      expect(await page.eval<number>("document.querySelectorAll('#activity tbody tr').length")).toBe(act.json.items.length);
      expect(await page.eval<string[]>("[...document.querySelectorAll('#activity .wallet')].map((w) => w.textContent)")).toContain(WALLET_1);
    }

    // Contract view of C04: three identities, the ACD group with three member links; tx view of C08's emitTwo.
    const sc = await visit(page, `#/contract/${C04}`);
    expect(await page.eval<number>("document.querySelectorAll('#tokens tbody tr').length")).toBe(3);
    expect(sc.hrefs.filter((h) => h.startsWith(`#/token/${C04}/`)).length).toBeGreaterThanOrEqual(6);
    const tx = stepTx("C08", "emit-two");
    const st = await visit(page, `#/tx/${tx}`);
    expect(await page.eval<string[][]>("[...document.querySelectorAll('#events tbody tr')].map((tr) => [tr.cells[0].innerText, tr.cells[5].innerText, tr.cells[6].innerText])")).toEqual([
      ["715109", "accepted", ""], ["715109", "rejected", "reserved-valtype"],
    ]);
    expect(st.hrefs).toContain(`#/contract/${contractOf("C08")}`);
    // NIGHT (zero color), DUST, status, an unknown route.
    expect((await visit(page, `#/color/${"0".repeat(64)}`)).view).toMatch(/NIGHT[\s\S]*protocol|NIGHT/);
    expect((await visit(page, "#/builtin/DUST")).view).toContain("DUST has no color and no activity rows.");
    const ss = await visit(page, "#/status");
    expect(ss.view).toContain("715183");
    expect(ss.strip).toMatch(/net: stagenet\s+\u00b7\s+indexed 715183/);
    expect((await visit(page, "#/nope")).view).toContain("no such page");

    // Only the API and the page's own assets; the font was loaded; nothing blocked or logged.
    const paths = expectOnlyApiCalls(page, idx.base);
    expect(paths).toContain("/ui/outfit.woff2");
    expect(page.requests.find((r) => r.url.endsWith("/ui/outfit.woff2"))?.status).toBe(200);
    expect(paths.some((p) => p.startsWith("/v1/identities/"))).toBe(true);
    await expectCleanConsole(page);
    expect(await page.eval<number>("document.scripts.length")).toBe(1);
  }, 300_000);

  it("[[mip0018.ui.browser-activity-shape]] the activity section draws C2's documented row shape (stub route until C1 serves it): every role, Bech32m wallets exactly as served (never hex), heights, tx links, a hostile entry point as visible marks, an unknown role as text, keyset 'load more' with the API's cursor; a 404 says 'not served yet'", async () => {
    const list = (await api(idx.base, "/v1/tokens?limit=500")).json.items as Json[];
    const C03 = contractOf("C03");
    const c03 = list.find((t) => t.contractAddress === C03 && t.kind === 2);
    const mintTx = stepTx("C03", "mint");
    const publishTx = stepTx("C03", "publish");
    const intent = "0c".repeat(32);
    const rowsFor: Record<string, Json[]> = {
      [`tokens/${c03.color}`]: [
        { height: 714617, txIndex: 0, itemIndex: 0, txHash: mintTx, role: "utxo-created", phase: "guaranteed", color: c03.color, amount: "1000000", direction: "in", wallet: WALLET_1, utxo: { intentHash: intent, outputIndex: 0 } },
        { height: 714617, txIndex: 0, itemIndex: 1, txHash: mintTx, role: "mint", phase: "guaranteed", color: c03.color, amount: "1000000", contract: C03, domainSep: c03.domainSep, kind: 2, wallet: WALLET_1, actionIndex: 0, entryPoint: "mint" },
        { height: 714624, txIndex: 0, itemIndex: 0, txHash: publishTx, role: "metadata-event", contract: C03, events: { accepted: 1, rejected: 0, firstEventIndex: 0 } },
        { height: 714700, txIndex: 1, itemIndex: 0, txHash: "ab".repeat(32), role: "contract-in", phase: "fallible", segment: 5, color: c03.color, amount: "5", direction: "in", contract: C03, entryPoint: "\u202Eevil\u0000" },
        { height: 714701, txIndex: 0, itemIndex: 0, txHash: "cd".repeat(32), role: "contract-out", phase: "guaranteed", color: c03.color, amount: "4", direction: "out", contract: C03, recipientContract: contractOf("C04") },
        { height: 714702, txIndex: 0, itemIndex: 0, txHash: "ef".repeat(32), role: "utxo-spent", phase: "guaranteed", color: c03.color, amount: "1000000", direction: "out", wallet: WALLET_1, utxo: { intentHash: intent, outputIndex: 0 } },
        { height: 714703, txIndex: 0, itemIndex: 0, txHash: "12".repeat(32), role: "shielded-offer", phase: "guaranteed", color: c03.color, amount: "7", direction: "out" },
        { height: 714704, txIndex: 0, itemIndex: 0, txHash: "34".repeat(32), role: "future-role" },
      ],
      [`contracts/${contractOf("C06")}`]: [
        { height: 714796, txIndex: 0, itemIndex: 0, txHash: stepTx("C06", "publish"), role: "metadata-event", contract: contractOf("C06"), events: { accepted: 1, rejected: 0, firstEventIndex: 0 } },
      ],
    };
    const PAGE_SIZE = 3;
    const stub = (req: IncomingMessage, res: ServerResponse): boolean => {
      const u = new URL(req.url ?? "/", "http://stub.invalid");
      const m = /^\/v1\/(tokens|contracts)\/([0-9a-f]{64})\/activity$/.exec(u.pathname);
      if (m === null) return serveUi(req, res);
      const rows = rowsFor[`${m[1]}/${m[2]}`];
      const send = (status: number, body: Json): true => {
        const text = JSON.stringify(body);
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(text)) });
        res.end(text);
        return true;
      };
      if (rows === undefined) return send(404, { error: { code: "NOT_FOUND", message: "no such route" } });
      const cursor = u.searchParams.get("cursor");
      const start = cursor === null ? 0 : Number(cursor.slice(1));
      const next = start + PAGE_SIZE < rows.length ? `p${start + PAGE_SIZE}` : null;
      return send(200, { items: rows.slice(start, start + PAGE_SIZE), nextCursor: next, ...(m[1] === "tokens" ? { contract: C03 } : {}) });
    };
    const server = createMip0018Api({ sql: idx.sql, network: NET, schema: idx.mip, archiveSchema: idx.archive, ui: stub, log: () => {} });
    servers.push(server);
    const base = `http://127.0.0.1:${await listen(server, 0, "127.0.0.1")}`;
    const page = await browser.newPage();
    await page.goto(`${base}/ui#/token/${C03}/${c03.domainSep}/2`);
    await page.waitFor(`document.body.getAttribute('data-state') === 'ready' && document.querySelectorAll('#activity tbody tr').length === ${PAGE_SIZE}`);
    for (let pages = 1; pages < 3; pages++) {
      await page.eval("[...document.querySelectorAll('#activity button')].find((b) => b.textContent.startsWith('load more')).click()");
      await page.waitFor(`document.querySelectorAll('#activity tbody tr').length === ${Math.min(8, PAGE_SIZE * (pages + 1))}`);
    }
    expect(await page.eval<number>("[...document.querySelectorAll('#activity button')].filter((b) => b.textContent.startsWith('load more')).length")).toBe(0);
    const drawn = await page.eval<Json[]>("[...document.querySelectorAll('#activity tbody tr')].map((tr) => ({ role: tr.getAttribute('data-role'), cells: [...tr.cells].map((c) => c.innerText), wallets: [...tr.querySelectorAll('.wallet')].map((w) => w.textContent), links: [...tr.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')) }))");
    expect(drawn.map((r) => r.role)).toEqual(["utxo-created", "mint", "metadata-event", "contract-in", "contract-out", "utxo-spent", "shielded-offer", "other"]);
    expect(drawn.map((r) => r.cells[0])).toEqual(["714617", "714617", "714624", "714700", "714701", "714702", "714703", "714704"]);
    expect(drawn.map((r) => r.cells[2])).toEqual(["UTXO created \u00b7 in", "mint", "metadata event", "into contract \u00b7 in", "out of contract \u00b7 out", "UTXO spent \u00b7 out", "shielded offer delta \u00b7 out", "future-role"]);
    expect(drawn.flatMap((r) => r.wallets)).toEqual([WALLET_1, WALLET_1, WALLET_1]);
    expect(drawn[0].links).toEqual([`#/tx/${mintTx}`]);
    expect(drawn[2].cells[5]).toBe("1 accepted \u00b7 0 rejected");
    expect(drawn[3].cells[5]).toContain("fallible \u00b7 segment 5");
    expect(drawn[3].cells[5]).toContain("\u27e8U+202E\u27e9evil\u27e8U+0000\u27e9");
    expect(drawn[4].links).toContain(`#/contract/${contractOf("C04")}`);
    const text = await page.eval<string>("document.body.innerText");
    expect(text).not.toMatch(HIDDEN_RAW);
    expect(text).not.toContain("63a9ed57"); // wallet 1 as hex: never
    await shot(page, "activity-c03-stub.png");
    // A kind-3 identity reads its contract's activity; a contract without the route answers 404 → the note.
    const C06 = contractOf("C06");
    await visit(page, `#/token/${C06}/${"11".repeat(32)}/3`);
    await page.waitFor("document.querySelectorAll('#activity tbody tr').length === 1");
    await visit(page, `#/contract/${contractOf("C01")}`);
    expect(await page.eval<string>("document.querySelector('#activity [data-activity]').getAttribute('data-activity')")).toBe("unavailable");
    expectOnlyApiCalls(page, base);
    await expectCleanConsole(page);
  }, 180_000);

  it("[[mip0018.ui.browser-hostile-text]] hostile metadata renders as visible text: bidi/zero-width/NUL/control characters as ⟨U+XXXX⟩ marks (never raw, also not in tooltips), markup as literal text (no element, no script run), URIs as text never fetched or linked, budgets with 'show all', a partial ⚠ and an unusable field drawn without its value; a seen-only color last", async () => {
    const db = await fresh("uihostile");
    const H = "a1".repeat(32);
    const D = "68".repeat(32);
    const L = "6c".repeat(32);
    const P = "70".repeat(32);
    const U = "75".repeat(32);
    const SEEN = "5e".repeat(32);
    const name = "\u202Egnp.exe\u200B\u0000<script>alert(1)</script>";
    const symbol = "\u2066SYM\u2069";
    const tag = "x\u202Ey";
    const desc = "\u0000\u0001\u001b[31mred\u001b[0m & \"q\"";
    const html = "<img src=x onerror=\"window.__pwned=1\"><b>bold</b>";
    const rlm = "\u200F".repeat(70);
    const ctl = "\u0001".repeat(216);
    await putSyntheticBlocks(db.sql, db.archive, NET, 300, [[
      call(H, [
        v1Log(D, 3, [record.utf8("name", name), record.utf8("symbol", symbol), record.uint("decimals", 3), record.utf8("standards", `mip-0004 ${tag}`)]),
        v1Log(D, 3, [
          { key: Uint8Array.from([0xff, 0xfe]), valType: 0, value: Uint8Array.from([0xc3, 0x28]) },
          record.utf8("desc", desc), record.utf8("\u0000nul", "x"), record.uri("home", "https://example.invalid/never-fetched"), record.json("j", "{\"a\":\"\\u202e\"}"),
        ]),
        v1Log(D, 3, [record.utf8("html", html), record.utf8("js", "javascript:window.__pwned=2")]),
        v1Log(D, 3, [record.utf8("k", rlm)]),
        v1Log(D, 3, [record.utf8("ctl", ctl)]),
        v1Log(L, 3, [record.utf8("name", "W".repeat(200))]),
        v1Log(L, 3, [record.utf8("symbol", "LONG"), record.uint("decimals", 0)]),
        v1Log(P, 3, [record.utf8("name", "Only A Name")]),
        v1Log(U, 3, [record.utf8("name", "Unusable Decimals"), record.utf8("symbol", "UNU"), record.utf8("decimals", "six")]),
      ], { unshieldedOutputs: [SEEN] }),
    ]]);
    const s = scanner(db, { decode: decodeSynthetic });
    await s.bootstrap();
    await scanAll(s);
    const base = await serveDb(db);
    const page = await browser.newPage();
    await page.goto(`${base}/ui`);
    await page.waitFor("document.body.getAttribute('data-route') === 'list' && document.body.getAttribute('data-state') === 'ready'");
    const rows = await page.eval<Json[]>(LIST_ROWS);
    // NIGHT, DUST, D, L, P, U (by domainSep bytes), then the seen color.
    expect(rows.map((r) => r.cells[3])).toEqual(["built-in", "built-in", "3 \u00b7 ledger", "3 \u00b7 ledger", "3 \u00b7 ledger", "3 \u00b7 ledger", "seen"]);
    const [, , rd, rl, rp, ru, rs] = rows;
    expect(rd.cells[1]).toBe("\u27e8U+202E\u27e9gnp.exe\u27e8U+200B\u27e9\u27e8U+0000\u27e9<script>alert(1)<\u2026");
    expect(rd.nameTitle).toBe("drawn 48 of 56 characters");
    expect(rd.cells[2]).toBe("\u27e8U+2066\u27e9SYM\u27e8U+2069\u27e9");
    expect(rd.cells[5]).toBe("mip-0004x\u27e8U+202E\u27e9y");
    expect(rd.mark).toBe("ok");
    expect(rl.cells[1]).toBe(`${"W".repeat(48)}\u2026`);
    expect([rp.mark, rp.markText, rp.title]).toEqual(["partial", "\u26a0", "\u26a0 partial: missing or unusable: symbol, decimals"]);
    expect([ru.mark, ru.title, ru.cells[6]]).toEqual(["partial", "\u26a0 partial: missing or unusable: decimals", "\u2014"]);
    expect([rs.mark, rs.cells[1], rs.cells[4]]).toEqual(["none", "seen color \u2014 no contract known", SEEN.slice(0, 8) + "\u2026" + SEEN.slice(-6)]);

    // D's view: the whole name in the heading, every field drawn as text with marks.
    const sd = await visit(page, `#/token/${H}/${D}/3`);
    expect(await page.eval<string>("document.querySelector('#view h3').innerText")).toBe("\u27e8U+202E\u27e9gnp.exe\u27e8U+200B\u27e9\u27e8U+0000\u27e9<script>alert(1)</script>");
    const fields = await page.eval<Record<string, string>>("Object.fromEntries([...document.querySelectorAll('#fields tbody tr')].map((tr) => [tr.cells[0].innerText, tr.cells[2].innerText]))");
    expect(fields["fffe\u00a0(not UTF-8)"] ?? fields["fffe (not UTF-8)"]).toBe("c328  (2 bytes)");
    expect(fields.desc).toBe("\u27e8U+0000\u27e9\u27e8U+0001\u27e9\u27e8U+001B\u27e9[31mred\u27e8U+001B\u27e9[0m & \"q\"");
    expect(fields["\u27e8U+0000\u27e9nul"]).toBe("x");
    expect(fields.home).toBe("https://example.invalid/never-fetched  (URI: text only, never fetched or followed)");
    expect(fields.j).toBe("{\"a\":\"\\u202e\"}");
    expect(fields.html).toBe(html);
    expect(fields.js).toBe("javascript:window.__pwned=2");
    expect(fields.k).toBe("\u27e8U+200F\u27e9".repeat(70));
    expect(fields.ctl).toBe(`${"\u27e8U+0001\u27e9".repeat(75)}\u2026show all (1728 characters)`);
    await page.eval("[...document.querySelectorAll('#fields button')].find((b) => b.textContent.startsWith('show all')).click()");
    await page.waitFor(`[...document.querySelectorAll('#fields tbody tr')].some((tr) => tr.cells[0].innerText === 'ctl' && tr.cells[2].innerText === ${JSON.stringify("\u27e8U+0001\u27e9".repeat(216))})`);
    // No element came from data, no script ran, no URI became a link or a request.
    expect(await page.eval<Json>("({ scripts: document.scripts.length, media: document.querySelectorAll('img, iframe, object, embed, video, audio, svg image').length, pwned: window.__pwned === undefined ? null : window.__pwned, links: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => !h.startsWith('#/')) })")).toEqual({ scripts: 1, media: 0, pwned: null, links: [] });
    expect(sd.text).not.toMatch(HIDDEN_RAW);
    for (const a of sd.attrs) expect(a).not.toMatch(HIDDEN_RAW_ATTR);
    await shot(page, "token-hostile.png");
    // L: heading within budget, whole on request.
    await visit(page, `#/token/${H}/${L}/3`);
    expect(await page.eval<string>("document.querySelector('#view h3').innerText")).toBe(`${"W".repeat(160)}\u2026show all (200 characters)`);
    await page.eval("document.querySelector('#view h3 button').click()");
    await page.waitFor(`document.querySelector('#view h3').innerText === ${JSON.stringify("W".repeat(200))}`);
    // U: the unusable decimals is drawn as unusable, never its bytes or text; the mark says why.
    const su = await visit(page, `#/token/${H}/${U}/3`);
    expect(su.view).toContain("unusable \u2014 no value shown");
    expect(mentions(new Map([["u", su]]), "six")).toEqual([]);
    expect(su.view).toContain("\u26a0 partial: missing or unusable: decimals");
    // The seen color: no contract.
    const ss = await visit(page, `#/color/${SEEN}`);
    expect(ss.view).toContain("not known: seen in public data, no mint of it in the indexed range");
    // Everything reachable: no raw hidden character anywhere, no request beyond the page and the API.
    const all = await crawl(page, ["#/"]);
    for (const [h, snap] of all) {
      expect(snap.text, h).not.toMatch(HIDDEN_RAW);
      for (const a of snap.attrs) expect(a, h).not.toMatch(HIDDEN_RAW_ATTR);
    }
    expect(page.requests.some((r) => r.url.includes("example.invalid"))).toBe(false);
    expectOnlyApiCalls(page, base);
    await expectCleanConsole(page);
  }, 240_000);

  it("[[mip0018.ui.browser-withdrawn]] with the page open and refreshing on its own: C06 step by step — the withdrawn name is on no reachable view after the tombstone (⚠ partial: name) and stays absent after the revive; a whole identity withdrawn (synthetic) is on no reachable view — not its domainSep, name or symbol — and its direct route says only that no such identity exists; a withdrawn minted token reads like a never-described one", async () => {
    // C06 recorded, per step; the page refreshes every 600 ms, never reloaded.
    const db = await fresh("uic06");
    await archiveTape(db, loadRangeTape("idx"), 714789, 714835);
    await scanner(db).bootstrap();
    const base = await serveDb(db);
    const C06 = contractOf("C06");
    const ds = "11".repeat(32);
    const page = await browser.newPage();
    await page.goto(`${base}/ui?refresh=600#/`);
    await page.waitFor("document.body.getAttribute('data-route') === 'list' && document.body.getAttribute('data-state') !== 'loading'");
    const at: Record<string, Map<string, Snap>> = {};
    for (const step of caseIndex.cases.C06!.steps.filter((x) => x.expectedAfter !== undefined)) {
      await scanAll(scanner(db, { toHeight: step.height! }));
      await page.waitFor(`(/indexed (\\d+)/.exec(document.getElementById('strip').innerText) || [])[1] === '${step.height}'`, 30_000, `indexed ${step.height}`);
      at[step.id] = await crawl(page, ["#/", `#/contract/${C06}`, `#/token/${C06}/${ds}/3`]);
    }
    expect(Object.keys(at)).toEqual(["publish", "rename", "withdraw", "withdraw-again", "revive"]);
    expect(mentions(at.publish!, "Acme Token").length).toBeGreaterThan(0); // positive control
    expect(mentions(at.rename!, "Acme Prime").length).toBeGreaterThan(0);
    expect(mentions(at.rename!, "Acme Token")).toEqual([]);
    for (const step of ["withdraw", "withdraw-again", "revive"]) {
      expect(mentions(at[step]!, "Acme Prime"), step).toEqual([]);
      expect(mentions(at[step]!, "Acme Token"), step).toEqual([]);
      expect(at[step]!.size, step).toBeGreaterThan(3);
    }
    const w = at.withdraw!.get(`#/token/${C06}/${ds}/3`)!;
    expect(w.view).toContain("\u26a0 partial: missing or unusable: name");
    expect(w.view).toContain("unnamed token");
    expect(mentions(at.revive!, "Acme Again").length).toBeGreaterThan(0);
    await shot(page, "c06-after-revive.png");
    expectOnlyApiCalls(page, base);
    await expectCleanConsole(page);

    // Synthetic whole withdrawals (C1's blocks): Z kind 3 never minted; M kind 1 minted + described + withdrawn; N minted only.
    const sdb = await fresh("uiwithdraw");
    const X = "c2".repeat(32);
    const Z = "7a".repeat(32); // ASCII "zzzz…": the page would draw it as text
    const M = "6d".repeat(32);
    const N = "6e".repeat(32);
    const full = (n: string) => [record.utf8("name", n), record.utf8("symbol", "GRP"), record.uint("decimals", 2), record.utf8("standards", "mip-0011")];
    await putSyntheticBlocks(sdb.sql, sdb.archive, NET, 200, [
      [call(X, [v1Log(Z, 3, full("Zed Withdrawn")), v1Log(M, 1, full("Minted Withdrawn"))], { shieldedMints: [[M, "500"], [N, "700"]] })],
      [call(X, [v1Log(Z, 3, nullAll("name", "symbol", "decimals", "standards")), v1Log(M, 1, nullAll("standards", "decimals", "symbol", "name"))])],
    ]);
    const s = scanner(sdb, { decode: decodeSynthetic });
    await s.bootstrap();
    const sbase = await serveDb(sdb);
    await s.scanOnce({ maxBlocks: 1 });
    const page2 = await browser.newPage();
    await page2.goto(`${sbase}/ui?refresh=600#/`);
    await page2.waitFor("(/indexed (\\d+)/.exec(document.getElementById('strip').innerText) || [])[1] === '200'");
    const before = await crawl(page2, ["#/", `#/contract/${X}`]);
    for (const needle of [Z, "z".repeat(32), "Zed Withdrawn", "Minted Withdrawn", "GRP"]) expect(mentions(before, needle).length, needle).toBeGreaterThan(0); // positive controls
    await s.scanOnce({ maxBlocks: 1 });
    await page2.waitFor("(/indexed (\\d+)/.exec(document.getElementById('strip').innerText) || [])[1] === '201'");
    const after = await crawl(page2, ["#/", `#/contract/${X}`]);
    for (const needle of [Z, "z".repeat(32), "Zed Withdrawn", "Minted Withdrawn", "GRP", "mip-0011"]) expect(mentions(after, needle), needle).toEqual([]);
    expect([...after.keys()].some((h) => h.includes(Z))).toBe(false);
    const xs = after.get(`#/contract/${X}`)!;
    expect(xs.view).toContain("no group");
    const mRow = await visit(page2, `#/token/${X}/${M}/1`);
    const nRow = await visit(page2, `#/token/${X}/${N}/1`);
    for (const r of [mRow, nRow]) {
      expect(r.view).toContain("unnamed token");
      expect(r.view).toContain("Not described: this token has no MIP-0018 metadata");
      expect(r.view).toContain("no MIP-0018 event");
    }
    // The direct route of the withdrawn identity: "no such identity", nothing of it drawn.
    const z = await visit(page2, `#/token/${X}/${Z}/3`);
    expect(z.view).toContain("no such token identity in the indexed range");
    expect(z.view.includes(Z) || z.view.includes("z".repeat(32)) || z.attrs.some((a) => a.includes(Z))).toBe(false);
    expectOnlyApiCalls(page2, sbase);
    await expectCleanConsole(page2, /\/activity(\?|$)|\/v1\/identities\//);
  }, 300_000);
});
