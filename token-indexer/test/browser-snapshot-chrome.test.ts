/**
 * Snapshots of the browser engine's store in Chrome, on OPFS: the static build (with the engine's automatic start off
 * and the snapshot `npm run build:browser` publishes, written by `token-indexer/dev/browser-snapshot.ts`) served from
 * 127.0.0.1, the worker driven through the engine page in headless Chromium (`helpers/cdp-browser.ts`). Each browser is
 * a new profile, so each starts from an empty store. The chain is the recorded IDX range (714485–715183), replayed inside
 * the worker or answered at the site's origin (`/chain/rpc`, `/chain/graphql`, every request recorded). No Stagenet.
 *
 * - `[[browser.worker.snapshot-round-trip]]` — a profile replays IDX to 714800, exports while its engine runs (the page
 *   saves the file as a download, byte for byte), continues to 715183 and exports again. A new profile imports the full
 *   snapshot: archive digest `cb0d5e21…` and range-tables digest `af6583d0…c832c` (the worker's `digest`), the API
 *   answers as in the first profile. A third profile imports the 714800 snapshot and starts the sync over the network
 *   source: the first height it requests is 714801 and none at or below 714800, and the finished store has the same two
 *   digests. The page's watchdog restarts no worker meanwhile.
 * - `[[browser.worker.snapshot-refusals]]` — snapshots of another network, schema version or PGlite version, with a
 *   changed byte or cut short, are refused by the worker with their reasons, and the store is unchanged.
 * - `[[browser.worker.published-snapshot]]` — a new profile with no chain loads the build's published snapshot (fetched
 *   from the site, checked against `snapshots/index.json`): the API answers 714485–715183 with the recorded digests, no
 *   chain request was made, every request went to the site's origin, and no CSP violation was reported (page or
 *   worker). The snapshot was made in Node: rows PGlite exported in Node load into a store PGlite makes in Chrome.
 * - `[[browser.worker.snapshot-follower]]` — a follower tab imports the published snapshot and exports the store through the
 *   leader tab's worker: the file crosses the tabs' BroadcastChannel as a parameter and as a result.
 * - `[[browser.explorer.panel-snapshot]]` — the main page's overview (`index.html`): its export saves the snapshot as a
 *   download, and a new profile's panel imports that file from its file input; the two stores have equal digests, with
 *   no CSP violation.
 * - `[[browser.worker.snapshot-recovery]]` — a profile's store holds an import journal and damaged files when the engine
 *   page opens (as when a worker ended mid-import): the boot finishes the import from the journal before the store is
 *   used (the store made anew, its rows loaded), removes the journal, reports the import, and saves the configuration
 *   that continues it.
 * - `[[browser.worker.reset-new-store]]` — `reset` and `range` remove every file of the OPFS store's directory (a file
 *   left in it too) and create the store anew: `created`, the identity rewritten, the range synced to the recorded
 *   digest.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 * `UMBRADB_BROWSER_REPORT=<file>` writes the measured sizes and timings as JSON (never committed).
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTape } from "../../chain-archive-sync/archive-tape.js";
import { createTapeReplay } from "../../chain-archive-sync/tape-replay.js";
import type { DigestResult, HostStatus } from "../browser/protocol.ts";
import { decodeSnapshotFile, encodeSnapshotFile, type PublishedSnapshotIndex, type SnapshotManifest, sha256Hex } from "../browser/snapshot.ts";
import { writePublishedSnapshots } from "../dev/browser-snapshot.ts";
import { Browser, findBrowser, type Page } from "./helpers/cdp-browser.ts";
import { buildEngineSite, chainDown, type EngineSite, engineDriver, NO_AUTO_START, REPO_ROOT, serveEngineSite } from "./helpers/engine-site.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const IDX = { from: 714485, to: 715183 } as const;
const PART = 714800;
const ARCHIVE = "cb0d5e213730ccffc135984c537b9e31d92c984d2b83f06854971a3a74e5b119";
const TABLES = "af6583d03da69ffd52a31fd89e663fe7892cf45aaf7234d9fc213c335dbc832c";
const FAST = { sync: { idleMs: 200 }, scan: { idleMs: 200 } };
const JOURNAL = "umbradb-stagenet.import.snapshot.tar";

const browserExe = findBrowser();

/** The exported snapshot in the page, as base64 (with its manifest and timings). */
const EXPORT_EXPR = `c.export().then(async (r) => {
  const bytes = new Uint8Array(await r.file.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  window.__lastExport = r;
  return { name: r.name, type: r.file.type, bytes: r.bytes, manifest: r.manifest, timings: r.timings, base64: btoa(s) };
})`;
/** A Blob of `bytes` in the page (`window.__file`). */
const blobExpr = (bytes: Uint8Array): string =>
  `(window.__file = new Blob([Uint8Array.from(atob(${JSON.stringify(Buffer.from(bytes).toString("base64"))}), (ch) => ch.charCodeAt(0))], { type: "application/x-tar" }), true)`;

/** Whether a downloaded file is complete (it reads as a snapshot file). */
function decodeOk(bytes: Uint8Array): boolean {
  try {
    decodeSnapshotFile(new Uint8Array(bytes));
    return true;
  } catch {
    return false;
  }
}

interface Exported { name: string; type: string; bytes: number; manifest: SnapshotManifest; timings: Json; base64: string }

describe("browser engine snapshots in Chrome", () => {
  let out: string;
  let site: EngineSite;
  let index: PublishedSnapshotIndex;
  const browsers: Browser[] = [];
  const report: Record<string, Json> = {};
  const idxReplay = async () => createTapeReplay(await readTape(new Uint8Array(readFileSync(join(REPO_ROOT, "token-indexer/browser/tapes/stagenet-714485-715183.tape.json.gz"))), "gzip"));

  beforeAll(async () => {
    if (browserExe === undefined) throw new Error("no Chromium/Chrome found: set MIP0018_UI_BROWSER or CHROME_BIN (see token-indexer/mip0018/ui/README.md)");
    out = await buildEngineSite(NO_AUTO_START);
    const t0 = performance.now();
    index = await writePublishedSnapshots(out);
    report.publishedSnapshot = { file: index.snapshots[0]!.file, bytes: index.snapshots[0]!.bytes, tarBytes: index.snapshots[0]!.manifest.data.tarBytes, dataBytes: index.snapshots[0]!.manifest.data.bytes, generateMs: Math.round(performance.now() - t0) };
    site = await serveEngineSite(out);
  }, 300_000);

  afterAll(async () => {
    for (const b of browsers.splice(0)) await b.close();
    await site?.close();
    if (out !== undefined) rmSync(out, { recursive: true, force: true });
    if (process.env.UMBRADB_BROWSER_REPORT) writeFileSync(process.env.UMBRADB_BROWSER_REPORT, JSON.stringify(report, null, 2));
  });

  async function profile(opts: { workers?: boolean } = {}) {
    const browser = await Browser.launch(browserExe!);
    browsers.push(browser);
    report.browser ??= await browser.version();
    const page = await browser.newPage(opts);
    const d = engineDriver(page, () => site);
    return { browser, page, d };
  }
  async function closeProfile(browser: Browser): Promise<void> {
    browsers.splice(browsers.indexOf(browser), 1);
    await browser.close();
  }
  const digestOf = async (d: ReturnType<typeof engineDriver>): Promise<DigestResult> => d.engine("c.digest()");
  const exportFrom = async (d: ReturnType<typeof engineDriver>): Promise<{ meta: Exported; bytes: Uint8Array }> => {
    const meta = (await d.engine(EXPORT_EXPR)) as Exported;
    return { meta, bytes: new Uint8Array(Buffer.from(meta.base64, "base64")) };
  };
  const importInto = async (page: Page, d: ReturnType<typeof engineDriver>, bytes: Uint8Array): Promise<Json> => {
    await page.eval(blobExpr(bytes));
    return d.engine("c.import(window.__file).then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.code, message: e.message }))");
  };
  const API_TARGETS = ["/v1/status", "/v1/tokens", "/v1/tokens?limit=2"];
  /** The API's answers; `/v1/status` without `scanner` (`following` while an engine runs, `off` otherwise). */
  const answers = async (d: ReturnType<typeof engineDriver>): Promise<Json[]> =>
    (await Promise.all(API_TARGETS.map((t) => d.api(t)))).map((r, i) => (API_TARGETS[i] === "/v1/status" ? { ...r, body: { ...r.body, scanner: undefined } } : r));

  let full: Uint8Array;
  let fullAnswers: Json[];

  it("[[browser.worker.snapshot-round-trip]] export after replaying IDX, import into a new profile: equal digests and API answers; a partial snapshot continues at its height + 1 to the same digests", async () => {
    // Profile A: IDX to 714800 in the worker, exported while the engine runs, then to the end.
    const a = await profile();
    expect((await a.d.open()).store).toMatchObject({ dataDir: "opfs-ahp://umbradb-stagenet", created: true });
    await a.d.engine(`c.start(${JSON.stringify({ source: { kind: "tape", range: "idx" }, startHeight: IDX.from, endHeight: PART, ...FAST })})`);
    await a.d.until("IDX to 714800", (s) => s.cursors?.sync?.height === PART && s.cursors.scan?.nextHeight === PART + 1);
    const partDigest = await digestOf(a.d);
    const part = await exportFrom(a.d);
    expect((await a.d.status()).engine?.running).toBe(true);
    expect(part.meta).toMatchObject({ name: `umbradb-stagenet-${IDX.from}-${PART}.snapshot.tar`, type: "application/x-tar", bytes: part.bytes.length });
    expect(part.meta.manifest).toMatchObject({ network: "stagenet", archive: { startHeight: IDX.from, height: PART }, scan: { nextHeight: PART + 1 }, pglite: { version: "0.5.8" } });
    expect(decodeSnapshotFile(part.bytes).manifest).toEqual(part.meta.manifest);
    report.exportPart = { bytes: part.bytes.length, tarBytes: part.meta.manifest.data.tarBytes, timings: part.meta.timings };

    // The page saves it as a download, byte for byte, under the build's CSP.
    const downloads = mkdtempSync(join(tmpdir(), "umbradb-downloads-"));
    try {
      await a.browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
      await a.page.eval("window.umbradbEngine.snapshots.save(window.__lastExport), true");
      const target = join(downloads, part.meta.name);
      const end = Date.now() + 30_000;
      while (!(existsSync(target) && readFileSync(target).length === part.bytes.length)) {
        if (Date.now() > end) throw new Error(`no download: ${readdirSync(downloads).join(", ")}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(await sha256Hex(new Uint8Array(readFileSync(target)))).toBe(await sha256Hex(part.bytes));
    } finally {
      rmSync(downloads, { recursive: true, force: true });
    }
    expect(await a.page.eval("window.__cspViolations")).toEqual([]);

    await a.d.engine("c.stop()");
    await a.d.engine(`c.start(${JSON.stringify({ source: { kind: "tape", range: "idx" }, ...FAST })})`);
    await a.d.until("IDX to the end", (s) => s.cursors?.sync?.height === IDX.to && s.cursors.scan?.nextHeight === IDX.to + 1);
    const aDigest = await digestOf(a.d);
    expect(aDigest.archive.sha256).toBe(ARCHIVE);
    expect(aDigest.tables.sha256).toBe(TABLES);
    const fullExport = await exportFrom(a.d);
    full = fullExport.bytes;
    fullAnswers = await answers(a.d);
    expect(await a.page.eval("window.umbradbEngine.restarts()")).toEqual([]);
    expect((await a.d.status()).snapshots.lastExport).toMatchObject({ sha256: fullExport.meta.manifest.data.sha256, bytes: full.length, manifest: { height: IDX.to } });
    report.exportFull = { bytes: full.length, tarBytes: fullExport.meta.manifest.data.tarBytes, timings: fullExport.meta.timings };
    await closeProfile(a.browser);

    // Profile B: the full snapshot into a new store.
    const b = await profile();
    expect((await b.d.open()).store?.created).toBe(true);
    const imported = await importInto(b.page, b.d, full);
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    report.importFull = imported.r.timings;
    expect(imported.r.status.cursors).toMatchObject({ sync: { height: IDX.to, startHeight: IDX.from }, scan: { nextHeight: IDX.to + 1 } });
    expect(imported.r.status.settings).toMatchObject({ autoStart: false, config: { startHeight: IDX.from } });
    const bDigest = await digestOf(b.d);
    expect(bDigest.archive).toEqual(aDigest.archive);
    expect(bDigest.tables).toEqual(aDigest.tables);
    expect(await answers(b.d)).toEqual(fullAnswers);
    expect(site.chainRequests).toEqual([]);
    expect(await b.page.eval("window.umbradbEngine.restarts()")).toEqual([]); // the page's watchdog never fired
    await closeProfile(b.browser);

    // Profile C: the partial snapshot, then the sync over the network source (the site answers from the IDX tape).
    site.chain = (await idxReplay()).answer;
    site.chainRequests.length = 0;
    const c = await profile();
    await c.d.open();
    const partImported = await importInto(c.page, c.d, part.bytes);
    expect(partImported.ok, JSON.stringify(partImported)).toBe(true);
    report.importPart = partImported.r.timings;
    const cPart = await digestOf(c.d);
    expect(cPart.archive).toEqual(partDigest.archive);
    expect(cPart.tables).toEqual(partDigest.tables);
    expect(site.chainRequests).toEqual([]);
    await c.d.engine(`c.start(${JSON.stringify({ source: { kind: "network", nodeUrl: site.nodeUrl, indexerUrl: site.indexerUrl }, ...FAST })})`);
    await c.d.until("IDX to the end", (s) => s.cursors?.sync?.height === IDX.to && s.cursors.scan?.nextHeight === IDX.to + 1, 180_000);
    const heights = site.chainRequests.filter((r) => r.height !== null);
    expect(heights[0]).toMatchObject({ method: "chain_getBlockHash", height: PART + 1 });
    expect(heights.filter((r) => r.height! <= PART)).toEqual([]);
    const cDigest = await digestOf(c.d);
    expect(cDigest.archive.sha256).toBe(ARCHIVE);
    expect(cDigest.tables.sha256).toBe(TABLES);
    expect(await answers(c.d)).toEqual(fullAnswers);
    expect(await c.page.eval("window.umbradbEngine.restarts()")).toEqual([]);
    await closeProfile(c.browser);
    site.chain = chainDown;
  }, 600_000);

  it("[[browser.worker.snapshot-refusals]] snapshots of another network, schema version or PGlite version, changed or cut short are refused by the worker with their reasons; the store is unchanged", async () => {
    expect(full, "the round-trip test exports the full snapshot first").toBeDefined();
    const { manifest, data } = decodeSnapshotFile(full);
    const variant = (change: (m: SnapshotManifest) => void): Uint8Array => {
      const m = structuredClone(manifest);
      change(m);
      return encodeSnapshotFile(m, data);
    };
    const flipped = data.slice();
    flipped[flipped.length >> 1]! ^= 0x40;

    const p = await profile();
    await p.d.open();
    expect((await importInto(p.page, p.d, full)).ok).toBe(true);
    const before = await digestOf(p.d);
    const status = await p.d.status();
    const cases: Array<[string, Uint8Array, string]> = [
      ["network", variant((m) => { m.network = "preprod"; }), "network"],
      ["schema version", variant((m) => { m.schemaVersions.mip0018 = m.schemaVersions.mip0018.slice(0, -1); }), "schema"],
      ["PGlite version", variant((m) => { m.pglite.version = "0.6.0"; }), "pglite"],
      ["hash", encodeSnapshotFile(manifest, flipped), "hash"],
      ["truncated", full.subarray(0, full.length - 4096), "truncated"],
    ];
    const results: Record<string, Json> = {};
    for (const [name, bytes, reason] of cases) {
      const r = await importInto(p.page, p.d, bytes);
      results[name] = r;
      expect(r.ok, name).toBe(false);
      expect(r.code, name).toBe("snapshot-refused");
      expect(r.message, name).toMatch(new RegExp(`^${reason}: `));
    }
    report.refusals = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.message]));
    const after = await p.d.status();
    expect(after.cursors).toEqual(status.cursors);
    expect(after.snapshots).toEqual(status.snapshots);
    expect(await digestOf(p.d)).toEqual({ ...before, elapsedMs: expect.any(Number) });
    expect(await answers(p.d)).toEqual(fullAnswers);
    await closeProfile(p.browser);
  }, 300_000);

  it("[[browser.worker.published-snapshot]] the build's published IDX snapshot, made in Node, boots the explorer API in a new profile with no chain request and no CSP violation", async () => {
    site.chain = chainDown;
    site.chainRequests.length = 0;
    const p = await profile({ workers: true });
    await p.d.open();
    const listed = await p.page.eval<PublishedSnapshotIndex>("window.umbradbEngine.snapshots.list()");
    expect(listed).toEqual(index);
    const r = await p.d.engine(`window.umbradbEngine.snapshots.published("idx").then((f) => c.import(f)).then((r) => ({ ok: true, r }), (e) => ({ ok: false, message: e.message }))`);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    report.importPublished = r.r.timings;
    expect(r.r.status.cursors?.sync).toEqual({ height: IDX.to, startHeight: IDX.from });
    const status = await p.d.api("/v1/status");
    expect(status.body).toMatchObject({ network: "stagenet", startHeight: IDX.from, indexedHeight: IDX.to, archiveHeight: IDX.to, durability: "non-durable" });
    expect(await answers(p.d)).toEqual(fullAnswers);
    const digest = await digestOf(p.d);
    expect(digest.archive.sha256).toBe(ARCHIVE);
    expect(digest.tables.sha256).toBe(TABLES);
    expect(site.chainRequests).toEqual([]);
    const outside = p.page.requests.filter((q) => !q.url.startsWith(`${site.origin}/`) && !q.url.startsWith("blob:") && !q.url.startsWith("data:"));
    expect(outside).toEqual([]);
    expect(p.page.requests.some((q) => q.url === `${site.origin}/snapshots/${index.snapshots[0]!.file}`)).toBe(true);
    expect(await p.page.eval("window.__cspViolations")).toEqual([]);
    expect(await p.page.evalWorker("self.__cspViolations")).toEqual([]);
    await closeProfile(p.browser);
  }, 300_000);

  it("[[browser.worker.snapshot-follower]] a follower tab exports and imports through the leader: the snapshot file crosses BroadcastChannel both ways", async () => {
    const leader = await profile();
    await leader.d.open();
    const follower = await leader.browser.newPage();
    const f = engineDriver(follower, () => site);
    await f.open();
    await follower.waitFor("window.umbradbEngine.tabs.role() === 'follower'", 30_000, "the follower role");
    const r = await f.engine(`window.umbradbEngine.snapshots.published("idx").then((file) => c.import(file)).then((r) => ({ ok: true, height: r.manifest.archive.height, cursors: r.status.cursors }), (e) => ({ ok: false, message: e.code + " " + e.message }))`);
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, height: IDX.to, cursors: { sync: { height: IDX.to } } });
    expect((await leader.d.status()).cursors?.sync?.height).toBe(IDX.to);
    const exported = await f.engine("c.export().then(async (x) => ({ isBlob: x.file instanceof Blob, size: x.file.size, bytes: x.bytes, height: x.manifest.archive.height }))");
    expect(exported).toMatchObject({ isBlob: true, height: IDX.to });
    expect(exported.size).toBe(exported.bytes);
    expect(await follower.eval("window.umbradbEngine.worker === undefined")).toBe(true);
    await closeProfile(leader.browser);
  }, 300_000);

  it("[[browser.explorer.panel-snapshot]] the overview exports the store as a download and a new profile's overview imports that file: equal digests", async () => {
    const U1 = { from: 715402, to: 715433 } as const;
    const msg = "document.querySelector('#engine-panel [data-field=\"message\"]').textContent";
    const openExplorer = async (page: Page): Promise<void> => {
      await page.goto(`${site.origin}/index.html`);
      await page.waitFor("window.umbradbEngine !== undefined && document.querySelector('#engine-panel [data-action=\"export\"]') !== null", 60_000, "the explorer and its panel");
      await page.eval("window.umbradbEngine.client.booted()");
      // The panel has drawn the engine's state and its controls are enabled.
      await page.waitFor("document.querySelector('#engine-panel').getAttribute('data-state') !== null && !document.querySelector('#engine-panel [data-action=\"import\"]').disabled && !document.querySelector('#engine-panel [data-action=\"export\"]').disabled", 60_000, "the panel's controls");
    };
    const waitMessage = async (page: Page, re: RegExp, what: string): Promise<void> => {
      try {
        await page.waitFor(`${re.toString()}.test(${msg})`, 120_000, what);
      } catch (e) {
        throw new Error(`${e instanceof Error ? e.message : String(e)}; the panel says ${JSON.stringify(await page.eval(msg))}`);
      }
    };

    const a = await profile();
    await openExplorer(a.page);
    await a.d.engine(`c.start(${JSON.stringify({ source: { kind: "tape", range: "u1" }, startHeight: U1.from, endHeight: U1.to, ...FAST })})`);
    await a.d.until("U1", (s) => s.cursors?.sync?.height === U1.to && s.cursors.scan?.nextHeight === U1.to + 1);
    const before = await digestOf(a.d);
    const name = `umbradb-stagenet-${U1.from}-${U1.to}.snapshot.tar`;
    const downloads = mkdtempSync(join(tmpdir(), "umbradb-downloads-"));
    let bytes: Uint8Array;
    try {
      await a.browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
      await a.page.eval("document.querySelector('#engine-panel [data-action=\"export\"]').click()");
      await waitMessage(a.page, new RegExp(`^snapshot saved as ${name.replaceAll(".", "\\.")} `), "the panel's export");
      const target = join(downloads, name);
      const end = Date.now() + 30_000;
      while (!(existsSync(target) && readFileSync(target).length > 0 && decodeOk(readFileSync(target)))) {
        if (Date.now() > end) throw new Error(`no download: ${readdirSync(downloads).join(", ")}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      bytes = new Uint8Array(readFileSync(target));
    } finally {
      rmSync(downloads, { recursive: true, force: true });
    }
    expect(decodeSnapshotFile(bytes).manifest.archive).toMatchObject({ startHeight: U1.from, height: U1.to });
    expect(await a.page.eval("window.__cspViolations")).toEqual([]);
    await closeProfile(a.browser);

    const b = await profile();
    await openExplorer(b.page);
    await b.page.eval(`(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(${JSON.stringify(Buffer.from(bytes).toString("base64"))}), (ch) => ch.charCodeAt(0))], ${JSON.stringify(name)}, { type: "application/x-tar" }));
      document.querySelector('#engine-panel [data-input="snapshot"]').files = dt.files;
      document.querySelector('#engine-panel [data-action="import"]').click();
    })()`);
    await waitMessage(b.page, new RegExp(`^snapshot ${name.replaceAll(".", "\\.")} imported: blocks ${U1.from}\u2013${U1.to}; the engine is stopped, and a start continues from block ${U1.to + 1}$`), "the panel's import");
    const after = await digestOf(b.d);
    expect(after.archive).toEqual(before.archive);
    expect(after.tables).toEqual(before.tables);
    expect(await b.page.eval("window.__cspViolations")).toEqual([]);
    await closeProfile(b.browser);
  }, 300_000);

  it("[[browser.worker.snapshot-recovery]] an import journal beside a damaged store is finished by the next boot before the store is used", async () => {
    const p = await profile();
    expect((await p.d.open()).store?.created).toBe(true);
    // Leave the engine page (its worker ends), then, from another page of the site, put a journal beside the store and
    // damage the store's files, as a worker that ended in the middle of an import would leave them.
    await p.page.goto(`${site.origin}/snapshots/index.json`);
    const file = index.snapshots[0]!.file;
    const prepared = await p.page.eval<Json>(`(async () => {
      const root = await navigator.storage.getDirectory();
      const bytes = new Uint8Array(await (await fetch(${JSON.stringify(`./${file}`)})).arrayBuffer());
      const w = await (await root.getFileHandle(${JSON.stringify(JOURNAL)}, { create: true })).createWritable();
      await w.write(bytes);
      await w.close();
      const store = await root.getDirectoryHandle("umbradb-stagenet");
      for (let attempt = 0; ; attempt++) {
        try {
          const state = await (await store.getFileHandle("state.txt")).createWritable();
          await state.write("damaged");
          await state.close();
          break;
        } catch (e) {
          if (attempt > 100) throw e;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      const names = [];
      for await (const [name] of root.entries()) names.push(name);
      return { bytes: bytes.length, names: names.sort() };
    })()`);
    expect(prepared.names).toEqual(expect.arrayContaining([JOURNAL, "umbradb-stagenet"]));

    const s: HostStatus = await p.d.open();
    expect(s.boot.phase).toBe("ready");
    expect(s.cursors?.sync).toEqual({ height: IDX.to, startHeight: IDX.from });
    expect(s.snapshots.lastImport).toMatchObject({ sha256: index.snapshots[0]!.manifest.data.sha256, bytes: null, manifest: { height: IDX.to } });
    expect(s.settings).toMatchObject({ autoStart: false, config: { startHeight: IDX.from } });
    const digest = await digestOf(p.d);
    expect(digest.archive.sha256).toBe(ARCHIVE);
    expect(digest.tables.sha256).toBe(TABLES);
    const names = await p.page.eval<string[]>(`(async () => { const n = []; for await (const [name] of (await navigator.storage.getDirectory()).entries()) n.push(name); return n.sort(); })()`);
    expect(names).not.toContain(JOURNAL);
    expect(names).toContain("umbradb-stagenet");
    report.recovery = { bootMs: s.boot.timings, journalBytes: prepared.bytes };
    await closeProfile(p.browser);
  }, 300_000);

  it("[[browser.worker.reset-new-store]] reset and range remove every file of the OPFS store and create it anew", async () => {
    const U1 = { from: 715402, to: 715433 } as const;
    const U1_ARCHIVE = "fa89d909911b0408fd7651ad58be68430b96e8d1cada804683d5206eaface959";
    const p = await profile();
    expect((await p.d.open()).store?.created).toBe(true);
    await p.d.engine(`c.start(${JSON.stringify({ source: { kind: "tape", range: "u1" }, startHeight: U1.from, endHeight: U1.from + 5, ...FAST })})`);
    await p.d.until("U1 + 5", (s) => s.cursors?.sync?.height === U1.from + 5 && s.cursors?.scan?.nextHeight === U1.from + 6);
    /** A file put into the store's directory from the page (the worker holds only PGlite's own files). */
    const plant = (): Promise<string[]> => p.page.eval<string[]>(`(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("umbradb-stagenet");
      const w = await (await dir.getFileHandle("left-behind", { create: true })).createWritable();
      await w.write("a file of the old store");
      await w.close();
      const names = [];
      for await (const [name] of dir.entries()) names.push(name);
      return names.sort();
    })()`);
    const listing = (): Promise<{ store: string[]; identity: Json }> => p.page.eval(`(async () => {
      const root = await navigator.storage.getDirectory();
      const names = [];
      for await (const [name] of (await root.getDirectoryHandle("umbradb-stagenet")).entries()) names.push(name);
      const identity = JSON.parse(await (await (await root.getFileHandle("umbradb-stagenet.store.json")).getFile()).text());
      return { store: names.sort(), identity };
    })()`);
    for (const request of ["reset", "range"] as const) {
      expect(await plant(), request).toContain("left-behind");
      await p.d.engine("c.stop()");
      const s = (await p.d.engine(request === "reset" ? "c.reset()" : `c.range(${U1.from})`)) as HostStatus;
      expect(s.boot, request).toMatchObject({ phase: "ready", storeProblem: null });
      expect(s.store?.created, request).toBe(true);
      const after = await listing();
      expect(after.store, `${request}: every file of the old store is gone`).not.toContain("left-behind");
      expect(after.store, request).toEqual(expect.arrayContaining(["state.txt"]));
      expect(after.identity, request).toMatchObject({ format: 1, pglite: expect.any(String), postgres: expect.any(String) });
    }
    await p.d.until("the range", (s) => s.cursors?.sync?.height === U1.to && s.cursors?.scan?.nextHeight === U1.to + 1);
    expect((await digestOf(p.d)).archive.sha256).toBe(U1_ARCHIVE);
    await closeProfile(p.browser);
  }, 300_000);
});
