/**
 * The browser engine at its limits, in Chrome on OPFS: the static build (no automatic start; the storage guard reading
 * the figures before every batch and every 300 ms while paused) served from 127.0.0.1, the recorded ranges replayed in
 * the worker, a new browser profile per test, never the network.
 *
 * - `[[browser.worker.quota-pause]]` — a storage estimate near the quota pauses the sync before it is reached: the
 *   archive's height holds, the scan finishes the archived blocks, the API answers, the system snapshot's health is
 *   `paused-quota` with the reason; the paused store holds exactly its cursors' blocks (every table equals the
 *   uninterrupted replay at its cursors); a lower estimate resumes it and the finished range has the recorded digests.
 * - `[[browser.worker.quota-refused-write]]` — a write the browser refuses (the origin's quota lowered under the usage
 *   through DevTools, which the estimate does not show): the block's transaction is rolled back, the archive holds at
 *   its last full block, the sync pauses with "the browser refused to write to the store for lack of space (could not
 *   extend file …)" in `status`, the panel's and the system snapshot's health; the store equals the replay at its
 *   cursors; once space is back the next batch writes and the finished range has the recorded digests.
 * - `[[browser.worker.persist-refused]]` — `navigator.storage.persist()` refused (and, in another profile, failing): the
 *   explorer's engine panel says the browser refused to keep the site's storage and that the engine runs anyway, the
 *   worker reports `persisted: false`, and the engine replays the recorded U1 range to its recorded digest.
 * - `[[browser.worker.unsupported]]` — a browser without OPFS sync access handles, one that is not Chromium, and one
 *   without Web Locks (in the page and the worker): the boot ends `unsupported` with the "Chrome only" message, the
 *   panel shows it, every request that needs the store answers `unsupported-browser`, and nothing exists in the origin's
 *   OPFS afterwards (no store, no file beside it, no probe file).
 * - `[[browser.worker.store-version]]` — a store whose identity names another PGlite version: the explorer's panel shows
 *   the refusal with its two choices and keeps reset, range and import enabled (start and export disabled), the store's
 *   files are left as they were; importing a snapshot made by this build replaces it (its digests, the identity
 *   rewritten); refused again, the panel's reset button creates a new store and starts the saved configuration.
 * - `[[browser.worker.hidden-tab]]` — the engine page's window minimized (the page `hidden`): the worker replays the IDX
 *   range to its end while the page stays hidden, to the recorded digests; its throughput is measured against the same
 *   replay with the page visible (reported; both must finish).
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 * `UMBRADB_BROWSER_REPORT=<file>` writes the measurements as JSON (never committed).
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DigestResult, HostStatus } from "../browser/protocol.ts";
import { type SystemSnapshot, SystemSnapshotSchema } from "../engine/system-snapshot.ts";
import { Browser, findBrowser, type Page } from "./helpers/cdp-browser.ts";
import { referenceStates, storedHeights, tornTables, withNullElements } from "./helpers/crash-reference.ts";
import { buildEngineSite, engineDriver, REPO_ROOT, serveEngineSite, type EngineSite } from "./helpers/engine-site.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const IDX = { from: 714485, to: 715183 } as const;
const U1 = { from: 715402, to: 715433 } as const;
const IDX_ARCHIVE = "cb0d5e213730ccffc135984c537b9e31d92c984d2b83f06854971a3a74e5b119";
const IDX_TABLES = "af6583d03da69ffd52a31fd89e663fe7892cf45aaf7234d9fc213c335dbc832c";
const U1_ARCHIVE = (JSON.parse(readFileSync(join(REPO_ROOT, "test/integration/fixtures/stagenet-archive/manifest.json"), "utf8")) as {
  ranges: Array<{ name: string; liveSync: { archiveDigest: { sha256: string } } }>;
}).ranges.find((r) => r.name === "u1")!.liveSync.archiveDigest.sha256;
const IDX_CONFIG = { source: { kind: "tape", range: "idx" }, startHeight: IDX.from, endHeight: IDX.to, sync: { idleMs: 200 }, scan: { idleMs: 200 } } as const;
const U1_CONFIG = { source: { kind: "tape", range: "u1" }, startHeight: U1.from, sync: { idleMs: 200 }, scan: { idleMs: 200 } } as const;
const STORE_ENTRIES = ["umbradb-stagenet", "umbradb-stagenet.engine.json", "umbradb-stagenet.store.json", "umbradb-stagenet.import.snapshot.tar"];
const PGLITE = (JSON.parse(readFileSync(join(REPO_ROOT, "node_modules/@electric-sql/pglite/package.json"), "utf8")) as { version: string }).version;
/** The build: no automatic start; the storage guard reads the figures before every batch and every 300 ms while paused. */
const DEFINE = { __UMBRADB_BROWSER_CONFIG__: JSON.stringify({ autoStart: false, quota: { checkEveryMs: 0, recheckMs: 300 } }) };
const RECOVERY = "reset it (its data is dropped and synced again) or load a snapshot made by this build";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const browserExe = findBrowser();

describe("the browser engine at its limits (Chrome, OPFS)", () => {
  let dir: string;
  let site: EngineSite;
  const report: Record<string, Json> = {};

  beforeAll(async () => {
    if (browserExe === undefined) throw new Error("no Chromium/Chrome found: set MIP0018_UI_BROWSER or CHROME_BIN (see token-indexer/mip0018/ui/README.md)");
    dir = await buildEngineSite(DEFINE);
    site = await serveEngineSite(dir);
  }, 180_000);

  afterAll(async () => {
    await site?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    if (process.env.UMBRADB_BROWSER_REPORT) writeFileSync(process.env.UMBRADB_BROWSER_REPORT, JSON.stringify(report, null, 2));
  });

  /** Runs `body` with a browser of its own (a new profile), closed afterwards. */
  async function withBrowser(body: (b: Browser) => Promise<void>): Promise<void> {
    const b = await Browser.launch(browserExe!);
    try {
      await body(b);
    } finally {
      await b.close();
    }
  }

  const drive = (p: Page) => engineDriver(p, () => site);
  /** Opens `page` (default the engine page) in a new tab of `b` and waits for the engine's boot. */
  async function open(b: Browser, path = "engine.html", opts: { workers?: boolean; workerScript?: string; pageScript?: string; newWindow?: boolean } = {}): Promise<Page> {
    const { pageScript, ...pageOpts } = opts;
    const p = await b.newPage({ workers: true, ...pageOpts });
    if (pageScript !== undefined) await p.send("Page.addScriptToEvaluateOnNewDocument", { source: pageScript });
    await p.goto(`${site.origin}/${path}`);
    await p.waitFor("window.umbradbEngine !== undefined", 30_000, "the engine connection");
    await p.eval("window.umbradbEngine.client.booted()");
    return p;
  }
  const untilEnd = (p: Page, to: number, timeoutMs = 300_000): Promise<HostStatus> =>
    drive(p).until(`the range's end ${to}`, (s) => s.cursors?.sync?.height === to && s.cursors?.scan?.nextHeight === to + 1, timeoutMs);
  const digest = async (p: Page): Promise<DigestResult> => (await drive(p).engine("c.digest()")) as DigestResult;
  const snapshot = async (p: Page): Promise<SystemSnapshot> => SystemSnapshotSchema.parse((await drive(p).engine("c.system({ refresh: {} })")).snapshot);
  /** The names in the origin's OPFS root, read from a page of the site with no engine. */
  async function opfsRoot(b: Browser): Promise<string[]> {
    const p = await b.newPage();
    try {
      await p.goto(`${site.origin}/blank`);
      return (await p.eval(`(async () => { const out = []; for await (const [n] of (await navigator.storage.getDirectory()).entries()) out.push(n); return out.sort(); })()`)) as string[];
    } finally {
      await p.close();
    }
  }
  /** Waits until the scan has every archived block (the store then holds still while the sync is paused). */
  const scanCaughtUp = (p: Page): Promise<HostStatus> =>
    drive(p).until("the scan to reach the archive", (s) => s.cursors?.sync !== null && s.cursors?.scan?.nextHeight === s.cursors!.sync!.height + 1, 60_000);

  it("[[browser.worker.quota-pause]] an estimate near the quota pauses the sync before it: the archive holds, the scan catches up, the API answers, health paused-quota; the paused store holds exactly its cursors' blocks; a lower estimate resumes it to the recorded digests", async () => {
    await withBrowser(async (b) => {
      const p = await open(b);
      await p.evalWorker(`(() => { self.__estimate = { usage: 1e8, quota: 1e10 }; StorageManager.prototype.estimate = async function () { return self.__estimate; }; return true; })()`);
      await drive(p).engine(`c.start(${JSON.stringify(IDX_CONFIG)})`);
      await drive(p).until("a first part of the range", (s) => (s.cursors?.sync?.height ?? 0) >= IDX.from + 200);
      await p.evalWorker(`(() => { self.__estimate = { usage: 9.5e9, quota: 1e10 }; return true; })()`);
      const paused = await drive(p).until("the pause", (s) => s.storage?.paused === true);
      expect(paused.storage).toMatchObject({ usageBytes: 9.5e9, quotaBytes: 1e10, pauseAtBytes: 9e9, persisted: false });
      expect(paused.storage!.pausedReason).toMatch(/^the browser counts 9059\.9 MiB of this site's 9536\.7 MiB quota; the sync pauses at 8583\.1 MiB/);
      const held = await scanCaughtUp(p);
      await sleep(1_500);
      const still = await drive(p).status();
      expect(still.cursors!.sync!.height, "the archive holds while paused").toBe(held.cursors!.sync!.height);
      expect((await drive(p).api("/v1/status")).status).toBe(200);
      expect((await snapshot(p)).overview.health).toMatchObject({ state: "paused-quota", reason: paused.storage!.pausedReason });
      const d = await digest(p);
      const h = storedHeights(still);
      const ref = await referenceStates("idx", IDX.from, [h.archive, h.scan]);
      expect(tornTables(ref, h, withNullElements(d.tables.tables, d.nullElements)), "the paused store equals the replay at its cursors").toEqual([]);
      report.quotaPause = { pausedAt: h };

      await p.evalWorker(`(() => { self.__estimate = { usage: 1e8, quota: 1e10 }; return true; })()`);
      await untilEnd(p, IDX.to);
      const end = await digest(p);
      expect([end.archive.sha256, end.tables.sha256]).toEqual([IDX_ARCHIVE, IDX_TABLES]);
      expect(p.exceptions).toEqual([]);
    });
  }, 400_000);

  it("[[browser.worker.quota-refused-write]] a write the browser refuses for lack of space rolls its block back: the archive holds at its last full block, the sync pauses with the refusal as the reason (status, panel, system health), the store equals the replay at its cursors; with space back it finishes to the recorded digests", async () => {
    await withBrowser(async (b) => {
      const p = await open(b, "index.html");
      await drive(p).engine(`c.start(${JSON.stringify({ ...IDX_CONFIG, sync: { idleMs: 200, maxBlocks: 5 } })})`);
      await drive(p).until("a first part of the range", (s) => (s.cursors?.sync?.height ?? 0) >= IDX.from + 200);
      const est = (await p.eval("navigator.storage.estimate().then((e) => ({ usage: e.usage, quota: e.quota }))")) as { usage: number; quota: number };
      // The quota lowered just above what the origin uses now: the store's next growth is refused.
      await p.send("Storage.overrideQuotaForOrigin", { origin: site.origin, quotaSize: est.usage + 512 * 1024 });
      const refused = await drive(p).until("a refused write", (s) => s.storage?.paused === true && /refused to write/.test(s.storage.pausedReason ?? ""), 120_000);
      expect(refused.storage!.pausedReason).toMatch(/^the browser refused to write to the store for lack of space \(could not extend file "[^"]+": File too large\); the store is at its last full block, and the sync tries a later batch again$/);
      // The refused write is a database error of whichever loop wrote first: a sync batch or a scan step (both report it
      // to the storage guard; once the sync is paused it starts no batch, so a scan-first refusal leaves the sync without
      // an error of its own). The engine's log keeps it either way.
      const refusals = (await snapshot(p)).logs.filter((l) => (l.source === "sync" || l.source === "scan") && l.level === "error" && /could not extend file \\"[^"\\]+\\": File too large/.test(l.text));
      expect(refusals.length, "the refused write in the engine's log").toBeGreaterThan(0);
      const held = await scanCaughtUp(p);
      await sleep(2_000);
      const still = await drive(p).status();
      expect(still.cursors!.sync!.height, "the archive holds at its last full block").toBe(held.cursors!.sync!.height);
      expect((await drive(p).api("/v1/status")).status).toBe(200);
      let health = (await snapshot(p)).overview.health;
      for (let i = 0; i < 50 && health.state !== "paused-quota"; i++) health = (await snapshot(p)).overview.health;
      expect(health).toMatchObject({ state: "paused-quota", reason: expect.stringContaining("refused to write") });
      await p.waitFor(`document.querySelector('#engine-panel [data-field=state]')?.textContent.includes('refused to write')`, 30_000, "the panel's reason");
      const panelState = (await p.eval(`document.querySelector('#engine-panel [data-field=state]').textContent`)) as string;
      const d = await digest(p);
      const h = storedHeights(still);
      const ref = await referenceStates("idx", IDX.from, [h.archive, h.scan]);
      expect(tornTables(ref, h, withNullElements(d.tables.tables, d.nullElements)), "the store equals the replay at its cursors").toEqual([]);
      report.refusedWrite = { estimate: est, heldAt: h, panelState, health };

      await p.send("Storage.overrideQuotaForOrigin", { origin: site.origin });
      await untilEnd(p, IDX.to);
      const end = await digest(p);
      expect([end.archive.sha256, end.tables.sha256]).toEqual([IDX_ARCHIVE, IDX_TABLES]);
      expect((await drive(p).status()).storage?.paused).toBe(false);
      expect(p.exceptions).toEqual([]);
    });
  }, 400_000);

  it("[[browser.worker.persist-refused]] a refused or failing persist() is shown by the panel and the engine runs anyway to the recorded digest", async () => {
    for (const [variant, script, text] of [
      ["refused", "StorageManager.prototype.persist = async function () { return false; };", "persistent: no (the browser refused to keep this site's storage, so it may clear the store when space runs low; the engine runs anyway)"],
      ["failing", "StorageManager.prototype.persist = async function () { throw new DOMException('not now', 'InvalidStateError'); };", "persistent: no (asking the browser to keep this site's storage failed: not now; the engine runs anyway)"],
    ] as const) {
      await withBrowser(async (b) => {
        const p = await open(b, "index.html", { pageScript: `StorageManager.prototype.persisted = async function () { return false; }; ${script}` });
        expect(await p.eval("window.umbradbEngine.persistence"), variant).toEqual(variant === "refused" ? { requested: true, persisted: false, error: null } : { requested: true, persisted: false, error: "not now" });
        await drive(p).engine(`c.start(${JSON.stringify(U1_CONFIG)})`);
        const end = await untilEnd(p, U1.to);
        expect(end.storage?.persisted, variant).toBe(false);
        expect((await digest(p)).archive.sha256, variant).toBe(U1_ARCHIVE);
        await p.waitFor(`document.querySelector('#engine-panel [data-field=storage]')?.textContent.endsWith(${JSON.stringify(text)})`, 30_000, `the panel's ${variant} persistence`);
        expect(p.exceptions).toEqual([]);
      });
    }
  }, 300_000);

  it("[[browser.worker.unsupported]] without OPFS sync access handles, outside Chromium, or without Web Locks: unsupported with the Chrome-only message in the panel, every store request refused, nothing in the origin's OPFS", async () => {
    const variants = [
      { name: "no sync access handles", missing: "syncAccessHandle", worker: "delete FileSystemFileHandle.prototype.createSyncAccessHandle;", page: undefined },
      { name: "not Chromium", missing: "chromium", worker: "Object.defineProperty(WorkerNavigator.prototype, 'userAgentData', { get() { return undefined; } });", page: undefined },
      {
        name: "no Web Locks",
        missing: "webLocks",
        worker: "Object.defineProperty(WorkerNavigator.prototype, 'locks', { get() { return undefined; } });",
        page: "Object.defineProperty(Navigator.prototype, 'locks', { get() { return undefined; } });",
      },
    ];
    for (const v of variants) {
      await withBrowser(async (b) => {
        const p = await open(b, "index.html", { workerScript: v.worker, ...(v.page === undefined ? {} : { pageScript: v.page }) });
        const s = await drive(p).status();
        expect(s.boot, v.name).toMatchObject({ phase: "unsupported", storeProblem: null });
        expect(s.boot.capabilities!.missing, v.name).toEqual([v.missing]);
        expect(s.boot.error, v.name).toMatch(/^Chrome only: UmbraDB's browser engine runs in Google Chrome \(desktop\)\. This browser lacks /);
        expect(s).toMatchObject({ store: null, cursors: null, engine: null });
        for (const call of ["c.start()", "c.digest()", "c.export()", `c.api("GET", "/v1/status")`, "c.reset()"])
          expect(await drive(p).engine(`${call}.then(() => "answered", (e) => e.code)`), `${v.name}: ${call}`).toBe("unsupported-browser");
        await p.waitFor(`document.querySelector('#engine-panel [data-field=state]')?.textContent.startsWith('unsupported · Chrome only:')`, 30_000, "the panel's message");
        await p.close();
        const root = await opfsRoot(b);
        expect(root.filter((n) => STORE_ENTRIES.includes(n) || n.startsWith(".umbradb-probe-")), `${v.name}: nothing created in OPFS`).toEqual([]);
      });
    }
  }, 300_000);

  it("[[browser.worker.store-version]] a store of another PGlite version: the panel shows the refusal and keeps reset, range and import usable; the store's files are untouched; a snapshot of this build replaces it; refused again, the panel's reset starts a new store with the saved configuration", async () => {
    await withBrowser(async (b) => {
      // A store of this build holding U1, a snapshot of it, and its identity.
      let p = await open(b, "index.html");
      await drive(p).engine(`c.start(${JSON.stringify(U1_CONFIG)})`);
      await untilEnd(p, U1.to);
      await drive(p).engine("c.stop()");
      const u1 = await digest(p);
      const b64 = (await drive(p).engine(`c.export().then(async (r) => { const b = new Uint8Array(await r.file.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); })`)) as string;
      writeFileSync(join(dir, "limits-u1.snapshot.tar"), Buffer.from(b64, "base64"));
      await p.close();

      const blank = await b.newPage();
      await blank.goto(`${site.origin}/blank`);
      const identity = (): Promise<Json> => blank.eval(`(async () => JSON.parse(await (await (await (await navigator.storage.getDirectory()).getFileHandle("umbradb-stagenet.store.json")).getFile()).text()))()`);
      const setIdentity = (id: Json): Promise<unknown> =>
        blank.eval(`(async () => { const w = await (await (await navigator.storage.getDirectory()).getFileHandle("umbradb-stagenet.store.json", { create: true })).createWritable(); await w.write(${JSON.stringify(JSON.stringify(id))}); await w.close(); return true; })()`);
      const storeFiles = (): Promise<string[]> =>
        blank.eval(`(async () => { const out = []; const walk = async (d, prefix) => { for await (const [n, h] of d.entries()) { if (h.kind === "directory") await walk(h, prefix + n + "/"); else out.push(prefix + n + " " + (await h.getFile()).size); } }; await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle("umbradb-stagenet"), ""); return out.sort(); })()`);
      expect(await identity()).toEqual({ format: 1, pglite: PGLITE, postgres: expect.stringMatching(/^\d+\.\d+/) });
      const old = { format: 1, pglite: "0.4.6", postgres: "17.5" };
      await setIdentity(old);
      const before = await storeFiles();

      // Refused: the panel says so and keeps the three controls that replace the store.
      p = await open(b, "index.html");
      const s = await drive(p).status();
      expect(s.boot).toMatchObject({ phase: "failed", storeProblem: "version" });
      expect(s).toMatchObject({ store: null, cursors: null });
      await p.waitFor(`document.querySelector('#engine-panel [data-field=state]')?.textContent.includes('written by PGlite 0.4.6')`, 30_000, "the panel's refusal");
      const state = (await p.eval(`document.querySelector('#engine-panel [data-field=state]').textContent`)) as string;
      expect(state).toBe(`failed · this store was written by PGlite 0.4.6 (PostgreSQL 17.5) and this build runs PGlite ${PGLITE}, so it is not opened: ${RECOVERY}`);
      const enabled = (await p.eval(`Object.fromEntries([...document.querySelectorAll('#engine-panel button[data-action]')].map((x) => [x.getAttribute('data-action'), !x.disabled]))`)) as Record<string, boolean>;
      expect(enabled).toMatchObject({ start: false, stop: false, export: false, range: true, reset: true, import: true });
      await p.close();
      expect(await storeFiles(), "the refused store's files are untouched").toEqual(before);
      expect(await identity()).toEqual(old);

      // A snapshot made by this build replaces it.
      p = await open(b, "index.html");
      const imported = (await drive(p).engine(`fetch("./limits-u1.snapshot.tar").then((r) => r.blob()).then((f) => c.import(f))`)) as Json;
      expect(imported.status.boot).toMatchObject({ phase: "ready", storeProblem: null });
      const after = await digest(p);
      expect([after.archive.sha256, after.tables.sha256]).toEqual([u1.archive.sha256, u1.tables.sha256]);
      expect((await identity()).pglite).toBe(PGLITE);
      await p.close();

      // Refused again: the panel's reset button creates a new store and starts the saved configuration.
      await setIdentity(old);
      p = await open(b, "index.html");
      expect((await drive(p).status()).boot.storeProblem).toBe("version");
      await p.waitFor(`document.querySelector('#engine-panel button[data-action=reset]')?.disabled === false`, 30_000, "the reset button");
      await p.eval(`document.querySelector('#engine-panel button[data-action=reset]').click()`);
      const reset = await untilEnd(p, U1.to);
      expect(reset.boot).toMatchObject({ phase: "ready", storeProblem: null });
      expect(reset.store!.created).toBe(true);
      expect(reset.engine?.config).toMatchObject({ source: { kind: "tape", range: "u1" }, startHeight: U1.from });
      expect((await digest(p)).archive.sha256).toBe(U1_ARCHIVE);
      expect((await identity()).pglite).toBe(PGLITE);
      expect(p.exceptions).toEqual([]);
      await blank.close();
    });
  }, 300_000);

  it("[[browser.worker.hidden-tab]] with the engine page's window minimized (the page hidden) the worker replays the IDX range to its end, to the recorded digests; its throughput is measured against the page visible", async () => {
    await withBrowser(async (b) => {
      const p = await open(b, "engine.html", { newWindow: true });
      const { windowId } = (await b.send("Browser.getWindowForTarget", { targetId: p.targetId })) as { windowId: number };
      const replay = async (hidden: boolean): Promise<{ ms: number; hiddenAtEnd: boolean }> => {
        if (hidden) {
          await b.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
          await p.waitFor("document.visibilityState === 'hidden'", 10_000, "the page hidden");
        }
        const t0 = Date.now();
        await drive(p).engine(`c.range(${IDX.from}, ${IDX.to})`);
        await untilEnd(p, IDX.to);
        const ms = Date.now() - t0;
        const hiddenAtEnd = (await p.eval("document.visibilityState")) === "hidden";
        if (hidden) {
          await b.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
          await p.waitFor("document.visibilityState === 'visible'", 10_000, "the page visible");
        }
        const d = await digest(p);
        expect([d.archive.sha256, d.tables.sha256], hidden ? "hidden" : "visible").toEqual([IDX_ARCHIVE, IDX_TABLES]);
        return { ms, hiddenAtEnd };
      };
      await drive(p).engine(`c.start(${JSON.stringify({ ...IDX_CONFIG, endHeight: IDX.from })})`);
      await untilEnd(p, IDX.from);
      const hidden = await replay(true);
      const visible = await replay(false);
      expect(hidden.hiddenAtEnd, "the page stayed hidden to the range's end").toBe(true);
      expect(visible.hiddenAtEnd).toBe(false);
      const blocks = IDX.to - IDX.from + 1;
      const measured = {
        hidden: { ms: hidden.ms, blocksPerSecond: Math.round((blocks / hidden.ms) * 10_000) / 10 },
        visible: { ms: visible.ms, blocksPerSecond: Math.round((blocks / visible.ms) * 10_000) / 10 },
      };
      report.hiddenTab = measured;
      console.log("IDX replay (sync + scan, unpaced) with the page hidden and visible", JSON.stringify(measured));
      expect(p.exceptions).toEqual([]);
    });
  }, 400_000);
});
