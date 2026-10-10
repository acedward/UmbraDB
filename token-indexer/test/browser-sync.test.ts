/**
 * The browser engine's sync in Chrome: the static build served from 127.0.0.1 (`helpers/engine-site.ts`), its worker on
 * OPFS in headless Chromium driven over the DevTools protocol (`helpers/cdp-browser.ts`), with no network beyond
 * 127.0.0.1.
 *
 * - `[[browser.worker.tape-digests]]` — the recorded IDX range (714485–715183) replayed inside the worker, synced and
 *   scanned on OPFS with the worker's yielding scheduler, gives the recorded live sync's archive digest and the recorded
 *   live range's digest of every table of both schemas; the recorded U1 range (715402–715433), in a new profile, gives
 *   its live archive digest.
 * - `[[browser.worker.start-tip]]` — the engine page's automatic start (the leader tab starts the saved configuration;
 *   the build's default points at a local chain on 127.0.0.1 whose finalized tip the test moves): with an empty profile
 *   and the endpoints failing, the engine waits with back-off, asks for no block and has no first height; once they
 *   answer it starts at the tip H they serve then (`/v1/status` `startHeight` = H); the archive and scan heights follow
 *   the tip through 10 simulated minutes of chain time (100 blocks, moved 10 at a time, each reached by both); the page
 *   asks for persistent storage and reports the answer; a closed and reopened tab resumes at the cursor and fetches each
 *   height of the gap once (no jump, no hole); a storage estimate near the quota (replaced in the worker over DevTools)
 *   pauses the sync, which holds while the tip moves, and a lower one resumes it; `range` drops the data and syncs the
 *   new range, which a reopened tab keeps; `reset` syncs it again to the same digest; after a `stop` a reopened tab
 *   starts nothing. Every wait is bounded and none depends on how fast the machine is.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 * `UMBRADB_BROWSER_REPORT=<file>` writes the measured timings as JSON (never committed).
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTape } from "../../chain-archive-sync/archive-tape.js";
import { createTapeReplay } from "../../chain-archive-sync/tape-replay.js";
import type { DigestResult, HostStatus, StartConfig } from "../browser/protocol.ts";
import { Browser, findBrowser } from "./helpers/cdp-browser.ts";
import { buildEngineSite, chainDown, type EngineSite, engineDriver, NO_AUTO_START, REPO_ROOT, serveEngineSite } from "./helpers/engine-site.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const IDX = { from: 714485, to: 715183 } as const;
const U1 = { from: 715402, to: 715433 } as const;
const FAST = { sync: { idleMs: 200 }, scan: { idleMs: 200 } };

const MANIFEST = JSON.parse(readFileSync(join(REPO_ROOT, "test/integration/fixtures/stagenet-archive/manifest.json"), "utf8")) as {
  ranges: Array<{ name: string; liveSync: { archiveDigest: DigestResult["archive"] } }>;
};
const liveArchive = (name: string): DigestResult["archive"] => MANIFEST.ranges.find((r) => r.name === name)!.liveSync.archiveDigest;
const LIVE_RANGE = JSON.parse(readFileSync(join(REPO_ROOT, "token-indexer/test/fixtures/live-range/stagenet-714485-715183.json"), "utf8")) as {
  liveTables: DigestResult["tables"];
};

const browserExe = findBrowser();

describe("browser engine sync in Chrome", () => {
  let out: string;
  let site: EngineSite;
  const browsers: Browser[] = [];
  const report: Record<string, Json> = {};

  beforeAll(async () => {
    if (browserExe === undefined) throw new Error("no Chromium/Chrome found: set MIP0018_UI_BROWSER or CHROME_BIN (see token-indexer/mip0018/ui/README.md)");
    out = await buildEngineSite(NO_AUTO_START);
    site = await serveEngineSite(out);
  }, 180_000);

  afterAll(async () => {
    for (const b of browsers.splice(0)) await b.close();
    await site?.close();
    if (out !== undefined) rmSync(out, { recursive: true, force: true });
    if (process.env.UMBRADB_BROWSER_REPORT) writeFileSync(process.env.UMBRADB_BROWSER_REPORT, JSON.stringify(report, null, 2));
  });

  /** A new browser profile with the engine page open and booted on a new OPFS store. */
  async function freshEngine() {
    const browser = await Browser.launch(browserExe!);
    browsers.push(browser);
    report.browser ??= await browser.version();
    const page = await browser.newPage();
    const d = engineDriver(page, () => site);
    const s = await d.open();
    expect(s.boot.phase).toBe("ready");
    expect(s.store).toMatchObject({ dataDir: "opfs-ahp://umbradb-stagenet", created: true });
    return { browser, page, d };
  }

  /** Replays a recorded range in the worker from its first height to its last; returns the wall time and the digests. */
  async function replay(d: ReturnType<typeof engineDriver>, range: "idx" | "u1", r: { from: number; to: number }) {
    const t0 = Date.now();
    await d.engine(`c.start(${JSON.stringify({ source: { kind: "tape", range }, startHeight: r.from, endHeight: r.to, ...FAST })})`);
    const done = await d.until(`${range} synced and scanned`, (s: HostStatus) => s.engine!.status.sync.phase === "done" && s.cursors?.scan?.nextHeight === r.to + 1, 240_000);
    const wallMs = Date.now() - t0;
    expect(done.cursors).toMatchObject({ sync: { height: r.to, startHeight: r.from }, scan: { fromHeight: r.from, nextHeight: r.to + 1 } });
    expect(done.engine!.error).toBeNull();
    const digest = (await d.engine("c.digest()")) as DigestResult;
    return { wallMs, digest };
  }

  it("[[browser.worker.tape-digests]] the IDX and U1 ranges replayed in the worker on OPFS give the recorded live archive digests, and IDX the recorded live range's digest of every table of both schemas", async () => {
    const idx = await freshEngine();
    const a = await replay(idx.d, "idx", IDX);
    expect(a.digest.archive).toEqual(liveArchive("idx"));
    expect(a.digest.archive.sha256).toBe("cb0d5e213730ccffc135984c537b9e31d92c984d2b83f06854971a3a74e5b119");
    expect(a.digest.tables).toEqual(LIVE_RANGE.liveTables);
    expect(a.digest.tables.sha256).toBe("af6583d03da69ffd52a31fd89e663fe7892cf45aaf7234d9fc213c335dbc832c");
    expect(Object.keys(a.digest.tables.tables)).toHaveLength(37);
    expect(idx.page.exceptions).toEqual([]);
    report.idx = { blocks: IDX.to - IDX.from + 1, wallMs: a.wallMs, blocksPerSecond: (IDX.to - IDX.from + 1) / (a.wallMs / 1000), digestMs: a.digest.elapsedMs };

    const u1 = await freshEngine();
    const b = await replay(u1.d, "u1", U1);
    expect(b.digest.archive).toEqual(liveArchive("u1"));
    expect(b.digest.archive.sha256).toBe("fa89d909911b0408fd7651ad58be68430b96e8d1cada804683d5206eaface959");
    expect(u1.page.exceptions).toEqual([]);
    report.u1 = { blocks: U1.to - U1.from + 1, wallMs: b.wallMs, digestMs: b.digest.elapsedMs };
    expect(site.chainRequests).toEqual([]); // nothing came over the network
  }, 600_000);
});

describe("browser engine: automatic start at the finalized tip in Chrome", () => {
  let out: string;
  let site: EngineSite;
  let browser: Browser;
  const report: Record<string, Json> = {};

  const START: StartConfig = {
    source: { kind: "network" }, // the endpoints are set once the server's origin is known
    sync: { idleMs: 300, backoff: { baseDelayMs: 200, maxDelayMs: 1_000, maxAttempts: 2 } },
    scan: { idleMs: 200 },
  };

  beforeAll(async () => {
    if (browserExe === undefined) throw new Error("no Chromium/Chrome found: set MIP0018_UI_BROWSER or CHROME_BIN (see token-indexer/mip0018/ui/README.md)");
    site = await serveEngineSite();
    START.source = { kind: "network", nodeUrl: site.nodeUrl, indexerUrl: site.indexerUrl };
    out = await buildEngineSite({
      __UMBRADB_BROWSER_CONFIG__: JSON.stringify({ autoStart: true, start: START, quota: { checkEveryMs: 0, recheckMs: 300, storeEveryMs: 1_000 } }),
    });
    site.dir = out;
    browser = await Browser.launch(browserExe);
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
    if (out !== undefined) rmSync(out, { recursive: true, force: true });
    if (process.env.UMBRADB_BROWSER_REPORT) writeFileSync(process.env.UMBRADB_BROWSER_REPORT.replace(/(\.json)?$/, "-tip.json"), JSON.stringify(report, null, 2));
  });

  it("[[browser.worker.start-tip]] an empty profile starts at the finalized tip with no input, waits while the endpoints fail (never genesis), follows the advancing tip, resumes through the gap after a reopen, pauses before the quota, and range, reset and stop behave as specified", async () => {
    const page = await browser.newPage({ workers: true });
    const d = engineDriver(page, () => site);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const blockRequests = () => site.chainRequests.filter((r) => r.height !== null);

    // 1. Empty profile, endpoints failing: the automatic start waits for the tip; no block is asked for, no genesis.
    site.chain = chainDown;
    const booted = await d.open();
    expect(booted.store).toMatchObject({ created: true });
    // A ready worker's status always carries a storage reading (the boot takes the first one before ready).
    expect(booted.storage).toMatchObject({ paused: false, pausedReason: null });
    expect(booted.storage!.checkedAt).not.toBeNull();
    expect(booted.settings).toEqual({ config: START, autoStart: true });
    const waiting = await d.until("the tip read to fail twice", (s) => s.engine?.running === true && s.engine.status.sync.failures >= 2, 60_000);
    expect(waiting.engine!.config).toEqual(START);
    expect(["starting", "backoff"]).toContain(waiting.engine!.status.sync.phase);
    expect(waiting.engine!.status.sync.startHeight).toBeUndefined();
    expect(waiting.engine!.status.sync.lastError).toMatch(/503/);
    expect(waiting.cursors).toEqual({ sync: null, scan: null });
    expect((await d.api("/v1/status")).body).toMatchObject({ startHeight: null, archiveHeight: null });
    expect(new Set(site.chainRequests.map((r) => r.method))).toEqual(new Set(["chain_getFinalizedHead"]));
    expect(blockRequests()).toEqual([]);
    // The page asked for persistent storage (headless Chrome refuses it here); the worker reports the outcome.
    expect(await page.eval("window.umbradbEngine.persistence")).toEqual({ requested: true, persisted: false, error: null });
    expect(waiting.storage).toMatchObject({ persisted: false, paused: false });
    report.waitingFailures = waiting.engine!.status.sync.failures;

    // 2. The endpoints answer: it starts at the tip they serve then (both serve 714600).
    const tape = await readTape(new Uint8Array(readFileSync(join(REPO_ROOT, "token-indexer/browser/tapes/stagenet-714485-715183.tape.json.gz"))), "gzip");
    const chain = createTapeReplay(tape, { finalizedHeight: 714600 });
    site.chain = (path, body) => chain.answer(path, body);
    const begun = await d.until("the first block", (s) => s.cursors?.scan !== null && s.cursors?.scan !== undefined, 60_000);
    const H = begun.cursors!.sync!.startHeight!;
    expect(H).toBe(714600);
    expect(begun.engine!.status.sync.startHeight).toBe(H);
    expect((await d.api("/v1/status")).body).toMatchObject({ startHeight: H });
    expect(Math.min(...blockRequests().map((r) => r.height!))).toBe(H);

    // It follows the finalized tip for 10 minutes of chain time, simulated: Midnight finalizes a block about every 6 s,
    // so 10 minutes are about 100 blocks; the tape's tip moves one simulated minute (10 blocks) at a time and each time
    // both the archive and the scan reach it. Waiting for each step (bounded), not sampling at fixed times, keeps a slow
    // machine from failing it; the time each step took is recorded.
    const minutes: Array<{ tip: number; ms: number }> = [];
    for (let m = 1; m <= 10; m++) {
      const tip = chain.advanceFinalizedHeight(10);
      const t0 = Date.now();
      await d.until(`simulated minute ${m}: the archive and the scan at the tip ${tip}`, (s) => s.cursors?.sync?.height === tip && s.cursors?.scan?.nextHeight === tip + 1, 60_000);
      minutes.push({ tip, ms: Date.now() - t0 });
    }
    expect(minutes.at(-1)!.tip).toBe(H + 100);
    report.follow = { H, minutes };

    // 3. The tab closes; the tip moves on; the reopened tab resumes at the cursor and fetches the whole gap, once.
    await page.goto("about:blank");
    const askedBefore = Math.max(...blockRequests().map((r) => r.height!));
    expect(askedBefore).toBe(H + 100);
    const mark = site.chainRequests.length;
    const tipAtReopen = chain.advanceFinalizedHeight(20);
    const reopened = await d.open();
    expect(reopened.store).toMatchObject({ created: false });
    const caught = await d.until("the gap", (s) => s.cursors?.sync?.height === tipAtReopen && s.cursors?.scan?.nextHeight === tipAtReopen + 1, 60_000);
    expect(caught.cursors!.sync!.startHeight).toBe(H);
    const after = site.chainRequests.slice(mark).filter((r) => r.method === "chain_getBlockHash").map((r) => r.height!);
    expect(after.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => askedBefore + 1 + i)); // no jump, no hole
    expect((await d.api("/v1/status")).body).toMatchObject({ startHeight: H });
    report.reopen = { askedBefore, firstAfter: after[0], tipAtReopen };

    // 4. A storage estimate near the quota pauses the sync; the API keeps answering; a lower one resumes it.
    await page.evalWorker(`(() => { self.__estimate = { usage: 9.5e9, quota: 1e10 }; StorageManager.prototype.estimate = async function () { return self.__estimate; }; return true; })()`);
    const paused = await d.until("the quota pause", (s) => s.storage?.paused === true, 60_000);
    expect(paused.storage).toMatchObject({ usageBytes: 9.5e9, quotaBytes: 1e10, pauseAtBytes: 9e9, paused: true });
    expect(paused.storage!.pausedReason).toContain("the sync pauses at");
    // A later reading while still paused: the sync is waiting in the guard (it reads again before letting a batch run).
    await d.until("a later reading while paused", (s) => s.storage?.paused === true && (s.storage.checkedAt ?? 0) > paused.storage!.checkedAt!, 60_000);
    await sleep(1_000);
    const held = (await d.status()).cursors!.sync!.height;
    expect(held).toBe(tipAtReopen);
    const tipWhilePaused = chain.advanceFinalizedHeight(5);
    await sleep(2_000);
    expect((await d.status()).cursors!.sync!.height, "the archive holds while paused").toBe(held);
    expect((await d.api("/v1/status")).status).toBe(200);
    // While the archive holds still: one block per height from H to the cursor, across the reopen (no hole).
    const still = (await d.engine("c.digest()")) as DigestResult;
    expect(still.archive.tables.blocks!.rows).toBe(held - H + 1);
    await page.evalWorker(`(() => { self.__estimate = { usage: 1e8, quota: 1e10 }; return true; })()`);
    const resumed = await d.until("the sync to resume", (s) => s.storage?.paused === false && s.cursors?.sync?.height === tipWhilePaused, 60_000);
    expect(resumed.storage!.pausedReason).toBeNull();
    report.quota = { held, resumedAt: resumed.cursors!.sync!.height };

    // 5. range: the data is dropped and the new range syncs; a reopened tab keeps its end.
    const ranged = (await d.engine("c.range(714485, 714520)")) as HostStatus;
    expect(ranged.settings).toEqual({ config: { ...START, startHeight: 714485, endHeight: 714520 }, autoStart: true });
    const rangeDone = await d.until("the range", (s) => s.engine!.status.sync.phase === "done" && s.cursors?.scan?.nextHeight === 714521, 60_000);
    expect(rangeDone.cursors!.sync).toEqual({ height: 714520, startHeight: 714485 });
    expect((await d.api("/v1/status")).body).toMatchObject({ startHeight: 714485, archiveHeight: 714520, indexedHeight: 714520 });
    const d1 = (await d.engine("c.digest()")) as DigestResult;
    expect(d1.archive.tables.blocks!.rows).toBe(36);
    await page.goto("about:blank");
    const kept = await d.open();
    expect(kept.settings).toEqual(ranged.settings);
    const keptDone = await d.until("the kept range", (s) => s.engine?.status.sync.phase === "done", 60_000);
    expect(keptDone.cursors!.sync).toEqual({ height: 714520, startHeight: 714485 });

    // 6. reset: the same range from nothing, to the same digests.
    await d.engine("c.reset()");
    await d.until("the range again", (s) => s.engine!.status.sync.phase === "done" && s.cursors?.scan?.nextHeight === 714521, 60_000);
    const d2 = (await d.engine("c.digest()")) as DigestResult;
    expect({ archive: d2.archive, tables: d2.tables }).toEqual({ archive: d1.archive, tables: d1.tables });

    // 7. stop: a reopened tab starts nothing.
    const stopped = (await d.engine("c.stop()")) as HostStatus;
    expect(stopped.settings!.autoStart).toBe(false);
    await page.goto("about:blank");
    await d.open();
    await sleep(500);
    const idle = await d.status();
    expect(idle.engine).toBeNull();
    expect(idle.cursors!.sync).toEqual({ height: 714520, startHeight: 714485 });
    expect(page.exceptions).toEqual([]);
  }, 600_000);
});
