/**
 * The browser engine's sync in Chrome: the static build served from 127.0.0.1 (`helpers/engine-site.ts`), its worker on
 * OPFS in headless Chromium driven over the DevTools protocol (`helpers/cdp-browser.ts`), with no network beyond
 * 127.0.0.1.
 *
 * - `[[browser.worker.tape-digests]]` — the recorded IDX range (714485–715183) replayed inside the worker, synced and
 *   scanned on OPFS with the worker's yielding scheduler, gives the recorded live sync's archive digest and the recorded
 *   live range's digest of every table of both schemas; the recorded U1 range (715402–715433), in a new profile, gives
 *   its live archive digest.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 * `UMBRADB_BROWSER_REPORT=<file>` writes the measured timings as JSON (never committed).
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DigestResult, HostStatus } from "../browser/protocol.ts";
import { Browser, findBrowser } from "./helpers/cdp-browser.ts";
import { buildEngineSite, type EngineSite, engineDriver, REPO_ROOT, serveEngineSite } from "./helpers/engine-site.ts";

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
    out = await buildEngineSite();
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
