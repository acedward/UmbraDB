/**
 * The static build's explorer page without a browser:
 *
 * - `[[browser.explorer.transport]]` — the explorer's host (`browser/explorer-transport.ts`): an engine answer becomes a
 *   fetch `Response` with its status, headers (`content-length` included, so the explorer's 8 MiB cap reads it) and body;
 *   the engine is asked `GET` of the path at call time; a failed engine request rejects.
 * - `[[browser.explorer.panel-model]]` — what the engine panel shows (`browser/panel-model.ts`): every engine state, the
 *   first indexed height with "history before block H is not indexed", the configuration, storage from the engine's
 *   reading or the page's, the role, and the typed range checked before it is sent.
 * - `[[browser.explorer.build]]` — the built `index.html` (Vite, `browser/vite.config.ts`, into a temporary folder): the
 *   markup of `GET /ui`, one module script and stylesheets (no inline block), the page policy; the explorer script in the
 *   bundle, not the Node page module; the brand font and the icon emitted as files with the explorer's bytes; the build
 *   plugin refusing a page style without its font reference and a doubled marker.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EXPLORER_MARKER, explorerPage, FONT_FILE_URL, SERVED_FONT_URL } from "../browser/build-explorer.ts";
import { EngineError } from "../browser/client.ts";
import { engineExplorerHost, responseOf } from "../browser/explorer-transport.ts";
import { configurationText, formatBytes, historyText, type PanelInputs, panelView, parseRange } from "../browser/panel-model.ts";
import type { HostStatus } from "../browser/protocol.ts";
import { UI_BODY } from "../mip0018/ui/page.ts";
import { buildEngineSite, NO_AUTO_START } from "./helpers/engine-site.ts";

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

type EngineState = NonNullable<HostStatus["engine"]>;
type LoopStatus = EngineState["status"];

const BOOT_READY: HostStatus["boot"] = {
  phase: "ready", error: null, capabilities: null, storeProblem: null,
  timings: { capabilitiesMs: 1, storeMs: 1, ledgerMs: 1, migrateMs: 1, totalMs: 4 },
};
const STORE: NonNullable<HostStatus["store"]> = {
  dataDir: "opfs-ahp://umbradb-stagenet", created: false, serverVersion: "18.3", fsync: "off", durability: "non-durable",
  migrations: { archive: [], mip0018: [] },
};
const loops = (over: { sync?: Partial<LoopStatus["sync"]>; scan?: Partial<LoopStatus["scan"]> } = {}): LoopStatus => ({
  started: true, stopping: false,
  sync: { phase: "idle", failures: 0, ...over.sync },
  scan: { phase: "idle", failures: 0, scanner: "following", ...over.scan },
  api: { inFlight: 0, maxConcurrentRequests: 8 },
});
const CONFIG = { source: { kind: "tape" as const, range: "u1" as const }, startHeight: 715402, endHeight: 715433 };

function hostStatus(over: Partial<HostStatus> = {}): HostStatus {
  return {
    protocol: 1, network: "stagenet", boot: BOOT_READY, store: STORE,
    engine: { running: true, config: CONFIG, status: loops(), error: null },
    cursors: { sync: { height: 715433, startHeight: 715402 }, scan: { fromHeight: 715402, nextHeight: 715434 } },
    settings: { config: CONFIG, autoStart: true },
    storage: null,
    snapshots: { lastExport: null, lastImport: null },
    ...over,
  };
}
const API = { network: "stagenet", startHeight: 715402, indexedHeight: 715433, archiveHeight: 715433, durability: "non-durable", scanner: "following" };
const inputs = (over: Partial<PanelInputs> = {}): PanelInputs => ({
  role: "leader", connectedTabs: 1, status: hostStatus(), statusError: null, api: API, pageStorage: null, ...over,
});

describe("the static build's explorer page (no browser)", () => {
  it("[[browser.explorer.transport]] the explorer's host answers a /v1 path with the engine's answer as a fetch Response: status, headers (content-length included) and body; it asks the engine GET of the path when called; a failed engine request rejects; the host asks for the start-height notes", async () => {
    const answer = { status: 200, headers: { "content-type": "application/json; charset=utf-8", "content-length": "16", "cache-control": "no-store" }, body: '{"items":["\u00e9"]}' };
    const client = { api: vi.fn(async () => answer) };
    const host = engineExplorerHost(client);
    expect(host.startHeightNotes).toBe(true);
    const r = await host.api("/v1/tokens?limit=100");
    expect(client.api).toHaveBeenCalledWith("GET", "/v1/tokens?limit=100");
    expect(r).toBeInstanceOf(Response);
    expect([r.status, r.ok, r.headers.get("content-length"), r.headers.get("content-type"), r.headers.get("cache-control")]).toEqual([200, true, "16", "application/json; charset=utf-8", "no-store"]);
    expect(new Uint8Array(await r.arrayBuffer()).byteLength).toBe(16); // UTF-8 bytes: the accented letter is two
    // An error answer keeps its status and body; a status without a body has none.
    const busy = responseOf({ status: 503, headers: { "retry-after": "1" }, body: '{"error":{"code":"BUSY"}}' });
    expect([busy.status, busy.ok, busy.headers.get("retry-after"), await busy.text()]).toEqual([503, false, "1", '{"error":{"code":"BUSY"}}']);
    expect(responseOf({ status: 204, headers: {}, body: "" }).body).toBe(null);
    // The client is read when called (a client replaced on the same object is the one asked).
    const swapped = { api: vi.fn(async () => answer) };
    const host2 = engineExplorerHost(swapped);
    swapped.api = vi.fn(async () => ({ ...answer, status: 404 }));
    expect((await host2.api("/v1/status")).status).toBe(404);
    // A failed engine request (no leader, a crashed worker, a store that did not open) rejects as it failed.
    const failing = engineExplorerHost({ api: async () => { throw new EngineError("leader-unavailable", "no leader tab answered", "api"); } });
    await expect(failing.api("/v1/status")).rejects.toMatchObject({ code: "leader-unavailable" });
  });

  it("[[browser.explorer.panel-model]] the panel's view: every engine state with its detail, the first indexed height as 'history before block H is not indexed', the configuration in words, storage from the engine's reading (or the page's until there is one), the role and open tabs, the held range a drop would lose, and the typed range checked before it is sent", () => {
    expect(historyText(714485)).toBe("indexed from block 714485 \u00b7 history before block 714485 is not indexed");
    expect(historyText(null)).toBe("nothing indexed yet");
    const v = panelView(inputs());
    expect(v).toMatchObject({
      role: "leader (this tab runs the engine) \u00b7 1 tab open", network: "stagenet", state: "running", stateDetail: "sync idle \u00b7 scan following",
      startHeight: 715402, history: historyText(715402), synced: "715433", scanned: "715433", durability: "non-durable",
      running: true, ready: true, holdsData: true, heldRange: "715402\u2013715433",
      configuration: "from block 715402 \u00b7 to block 715433 \u00b7 recorded range u1, replayed offline \u00b7 starts by itself",
    });
    // States.
    const state = (over: Partial<PanelInputs>) => { const x = panelView(inputs(over)); return [x.state, x.stateDetail]; };
    expect(state({ status: null })).toEqual(["connecting", ""]);
    expect(state({ status: null, statusError: "leader-unavailable: no leader" })).toEqual(["unavailable", "leader-unavailable: no leader"]);
    expect(state({ status: hostStatus({ boot: { ...BOOT_READY, phase: "store" } }) })).toEqual(["booting", "store"]);
    expect(state({ status: hostStatus({ boot: { ...BOOT_READY, phase: "unsupported", error: "Chrome only" } }) })).toEqual(["unsupported", "Chrome only"]);
    expect(state({ status: hostStatus({ boot: { ...BOOT_READY, phase: "failed", error: "the store did not open" } }) })).toEqual(["failed", "the store did not open"]);
    expect(state({ status: hostStatus({ engine: null }) })).toEqual(["not started", ""]);
    expect(state({ status: hostStatus({ engine: { running: false, config: CONFIG, status: loops(), error: null } }) })).toEqual(["stopped", ""]);
    expect(state({ status: hostStatus({ engine: { running: false, config: CONFIG, status: loops(), error: "boom" } }) })).toEqual(["failed", "boom"]);
    expect(state({ status: hostStatus({ engine: { running: true, config: CONFIG, status: loops({ sync: { phase: "backoff", lastError: "503 from the node" } }), error: null } }) })).toEqual(["waiting (network)", "503 from the node"]);
    expect(state({ status: hostStatus({ engine: { running: true, config: CONFIG, status: loops({ scan: { scanner: "stalled", lastError: "parent hash" } }), error: null } }) })).toEqual(["stalled (scan)", "parent hash"]);
    const paused = { usageBytes: 9.5e9, quotaBytes: 1e10, persisted: false, pauseAtBytes: 9e9, paused: true, pausedReason: "the usage is near the quota", storeBytes: 42.5e6, checkedAt: 1 };
    expect(state({ status: hostStatus({ storage: paused }) })).toEqual(["paused (storage)", "the usage is near the quota"]);
    // The store's own size first; the browser's figures (inflated while the store is open) and the pause after it.
    expect(panelView(inputs({ status: hostStatus({ storage: paused }) })).storage).toBe(
      "store 42.5 MB \u00b7 browser reports 9.5 GB used of 10.0 GB (includes space Chrome reserves for open files) \u00b7 sync pauses at 9.0 GB used \u00b7 persistent: no \u00b7 paused: the usage is near the quota");
    const open = { ...paused, usageBytes: 995_300_000, quotaBytes: 11_732_800_000, pauseAtBytes: 10_559_520_000, paused: false, pausedReason: null, storeBytes: 42_300_000, persisted: true };
    expect(panelView(inputs({ status: hostStatus({ storage: open }) })).storage).toBe(
      "store 42.3 MB \u00b7 browser reports 995.3 MB used of 11.7 GB (includes space Chrome reserves for open files) \u00b7 sync pauses at 10.6 GB used \u00b7 persistent: yes");
    expect(panelView(inputs({ status: hostStatus({ storage: { ...open, storeBytes: null, pauseAtBytes: null } }) })).storage).toBe(
      "store size not read yet \u00b7 browser reports 995.3 MB used of 11.7 GB (includes space Chrome reserves for open files) \u00b7 persistent: yes");
    // Storage from the page until the engine has a reading.
    expect(panelView(inputs({ pageStorage: { usageBytes: 1_015_257_540, quotaBytes: 11_752_675_780, persisted: null } })).storage).toBe(
      "browser reports 1.0 GB used of 11.8 GB \u00b7 persistent: unknown");
    expect(panelView(inputs()).storage).toBe("unknown");
    expect([formatBytes(null), formatBytes(0), formatBytes(42_300_000), formatBytes(999_940_000), formatBytes(1e9), formatBytes(11_732_800_000), formatBytes(1_234_567_000_000)]).toEqual(
      ["unknown", "0.0 MB", "42.3 MB", "999.9 MB", "1.0 GB", "11.7 GB", "1,234.6 GB"]);
    // Nothing indexed yet: no start height, nothing to lose.
    const empty = panelView(inputs({ api: { network: "stagenet", startHeight: null, indexedHeight: null, archiveHeight: null, durability: "non-durable" }, status: hostStatus({ engine: null, cursors: { sync: null, scan: null } }) }));
    expect(empty).toMatchObject({ startHeight: null, history: "nothing indexed yet", synced: "none", scanned: "none", holdsData: false, heldRange: "" });
    // An API answer that is not what it should be is not shown as a height.
    expect(panelView(inputs({ api: { startHeight: "714485", indexedHeight: -1, archiveHeight: 1.5 } })).history).toBe("nothing indexed yet");
    // Role and tabs.
    expect(panelView(inputs({ role: "follower", connectedTabs: 2 })).role).toBe("follower (the engine runs in another tab) \u00b7 2 tabs open");
    expect(panelView(inputs({ role: "connecting", connectedTabs: null })).role).toBe("connecting");
    // Configuration.
    expect(configurationText({}, true)).toBe("from the finalized tip \u00b7 following the finalized tip \u00b7 the network's node and indexer \u00b7 starts by itself");
    expect(configurationText({ startHeight: "tip", source: { kind: "network" } }, false)).toBe("from the finalized tip \u00b7 following the finalized tip \u00b7 the network's node and indexer \u00b7 starts on request");
    expect(configurationText(undefined, undefined)).toBe("none saved");
    // The typed range.
    expect(parseRange("tip", "")).toEqual({ ok: true, startHeight: "tip" });
    expect(parseRange(" TIP ", "")).toEqual({ ok: true, startHeight: "tip" });
    expect(parseRange("", "")).toEqual({ ok: true, startHeight: "tip" });
    expect(parseRange("714485", "715183")).toEqual({ ok: true, startHeight: 714485, endHeight: 715183 });
    expect(parseRange("tip", "900000")).toEqual({ ok: true, startHeight: "tip", endHeight: 900000 });
    for (const [s, e] of [["abc", ""], ["-1", ""], ["1.5", ""], ["1e3", ""], ["10", "x"], ["10", "9"], ["99999999999999999", ""]])
      expect(parseRange(s!, e!).ok, `${s}\u2013${e}`).toBe(false);
  });

  describe("the built page", () => {
    let dir = "";
    beforeAll(async () => {
      dir = await buildEngineSite(NO_AUTO_START);
    }, 180_000);
    afterAll(() => {
      if (dir !== "") rmSync(dir, { recursive: true, force: true });
    });

    it("[[browser.explorer.build]] index.html is the /ui page's markup with one module script and stylesheets (no inline block) under the page policy; the bundle carries the explorer script, not the Node page module; the brand font and icon are emitted with the explorer's bytes; the plugin refuses a page style without its font reference and a doubled marker", async () => {
      const html = readFileSync(join(dir, "index.html"), "utf8");
      expect(html).toContain(UI_BODY);
      expect(html).not.toContain(EXPLORER_MARKER);
      expect(html).toContain("<title>MIP-0018 token explorer</title>");
      const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
      expect(scripts).toHaveLength(1);
      expect(scripts[0]![1]).toMatch(/type="module"/);
      expect(scripts[0]![2]).toBe("");
      const entry = /src="\.\/assets\/(index-[\w-]+\.js)"/.exec(scripts[0]![1]!)![1]!;
      expect(html).not.toMatch(/<style\b/);
      expect(html).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; /);
      const sheets = [...html.matchAll(/<link rel="stylesheet" crossorigin href="\.\/assets\/([\w-]+\.css)">/g)].map((m) => m[1]!);
      expect(sheets.length).toBeGreaterThan(0);
      const icon = /<link rel="icon" href="\.\/assets\/(favicon-[\w-]+\.ico)"/.exec(html)![1]!;

      const assets = readdirSync(join(dir, "assets"));
      const js = assets.filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(dir, "assets", f), "utf8"));
      const entryCode = readFileSync(join(dir, "assets", entry), "utf8");
      // The explorer script (its texts and its host lookup) is in the page's bundle; nothing of the Node page module is.
      expect(entryCode).toContain("umbradbExplorerHost");
      expect(entryCode).toContain("history before block ");
      expect(entryCode).toContain("MIP-0018 mark: ");
      expect(js.filter((c) => c.includes("trusted-types 'none'") || c.includes("/ui/outfit.woff2"))).toEqual([]); // the Node page module's policy and routes
      // The style's font is the emitted file; the font and the icon carry the explorer's bytes.
      const css = sheets.map((f) => readFileSync(join(dir, "assets", f), "utf8")).join("\n");
      const font = /url\(\.\/(Outfit-Variable-latin-[\w-]+\.woff2)\)/.exec(css)![1]!;
      expect(css).not.toContain("/ui/outfit.woff2");
      expect(sha256(readFileSync(join(dir, "assets", font)))).toBe("92684e4acde79ef07758cd09380b7e01e9824d8b061eddeda046f78c166d7b12");
      expect(sha256(readFileSync(join(dir, "assets", icon)))).toBe("b41509ad57381debefaba6fb3e2e478c1e38ea8afc5e6f11ecd1aeaba4e14c45");

      // The plugin: the font reference is rewritten, its absence fails the build, a doubled marker too.
      const plugin = explorerPage();
      const transform = plugin.transform as (code: string, id: string) => { code: string } | null;
      const pageCss = "/repo/token-indexer/mip0018/ui/page.css";
      expect(transform(`a { src: ${SERVED_FONT_URL} }`, pageCss)!.code).toBe(`a { src: ${FONT_FILE_URL} }`);
      expect(() => transform("a { src: url(x) }", pageCss)).toThrow(/no longer references the font/);
      expect(transform("a {}", "/repo/token-indexer/browser/explorer.css")).toBe(null);
      const page = (plugin.transformIndexHtml as { handler: (html: string) => string }).handler;
      expect(page(`<body>${EXPLORER_MARKER}</body>`)).toBe(`<body>${UI_BODY}</body>`);
      expect(page("<body></body>")).toBe("<body></body>");
      expect(() => page(`${EXPLORER_MARKER}${EXPLORER_MARKER}`)).toThrow(/more than once/);
    });
  });
});
