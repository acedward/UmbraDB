/**
 * The browser engine in Chrome: the static build (`token-indexer/browser/vite.config.ts`, built here with Vite into a
 * temporary folder) served from 127.0.0.1, its worker booting on OPFS in headless Chromium driven over the DevTools
 * protocol (`helpers/cdp-browser.ts`), syncing and scanning recorded Stagenet blocks with no network, and surviving
 * page reloads with the same cursors and API answers.
 *
 * - `[[browser.build.bundle]]` — the build holds one ledger-v9 instance (one WASM file, one chunk defining its classes,
 *   with their names kept), PGlite's assets and the tapes; the node-free plugin fails a build that would bundle
 *   postgres.js or a Node built-in.
 * - `[[browser.worker.opfs-reload-resume]]` — first open creates the OPFS store; the worker syncs and scans part of the
 *   U1 range replayed inside the worker (its mint is decoded by the bundled ledger); after a reload the store is reopened (not created) and reports the same
 *   cursors and the same API answers; a new start, this time reading the chain over `fetch` (the page's origin answers
 *   from the same tape), continues at the cursor and fetches only the missing heights; a second reload keeps it all.
 * - `[[browser.worker.protocol]]` — the real worker answers malformed and unknown messages with their error codes,
 *   refuses a second start, and answers `not-implemented` for export and import.
 *
 * The build turns the engine's automatic start off (`__UMBRADB_BROWSER_CONFIG__`), so each test starts what it needs.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 * `UMBRADB_BROWSER_REPORT=<file>` writes the measured boot timings as JSON (never committed).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTape } from "../../chain-archive-sync/archive-tape.js";
import { createTapeReplay, type TapeReplay } from "../../chain-archive-sync/tape-replay.js";
import { nodeFreeBundle } from "../browser/build-guard.ts";
import type { HostStatus } from "../browser/protocol.ts";
import { Browser, findBrowser, type Page } from "./helpers/cdp-browser.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CONFIG = join(ROOT, "token-indexer/browser/vite.config.ts");
const U1 = { from: 715402, to: 715433 } as const;
const MID = U1.from + 15;
const FAST = { sync: { idleMs: 200 }, scan: { idleMs: 200 } };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm", ".data": "application/octet-stream",
  ".gz": "application/gzip", ".json": "application/json", ".css": "text/css",
};

/** The built site plus the chain's two endpoints (`/chain/rpc`, `/chain/graphql`) answered from a tape, on 127.0.0.1. */
async function serveSite(dir: string, chain: TapeReplay): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/chain/")) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        void chain.answer(url.pathname.slice("/chain".length), Buffer.concat(chunks).toString("utf8")).then((a) => {
          res.writeHead(a.status, a.headers);
          res.end(a.body);
        });
      });
      return;
    }
    const file = normalize(join(dir, decodeURIComponent(url.pathname)));
    if (!file.startsWith(dir + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-length": body.length, "cache-control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
  for (let attempt = 0; ; attempt++) {
    const port = 10_000 + Math.floor(Math.random() * 50_000);
    const ok = await new Promise<boolean>((done) => {
      server.once("error", () => done(false));
      server.listen(port, "127.0.0.1", () => done(true));
    });
    if (ok) return { server, origin: `http://127.0.0.1:${port}` };
    if (attempt > 20) throw new Error("no free port at or above 10000 on 127.0.0.1");
  }
}

/** Builds with Vite; returns the error message, or `undefined` when the build succeeds. */
async function buildError(opts: Parameters<typeof import("vite")["build"]>[0]): Promise<string | undefined> {
  const { build } = await import("vite");
  try {
    await build({ logLevel: "silent", ...opts });
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const browserExe = findBrowser();

describe("browser engine worker in Chrome", () => {
  let out: string;
  let browser: Browser;
  let page: Page;
  let site: { server: Server; origin: string };
  let chain: TapeReplay;
  const report: Record<string, Json> = {};

  const engine = (expr: string): Promise<Json> => page.eval(`(async () => { const c = window.umbradbEngine.client; return ${expr}; })()`);
  const status = (): Promise<HostStatus> => engine("c.status()");
  const api = async (target: string): Promise<{ status: number; body: Json }> => {
    const r = (await engine(`c.api("GET", ${JSON.stringify(target)})`)) as { status: number; body: string };
    return { status: r.status, body: JSON.parse(r.body) };
  };
  async function until(what: string, ok: (s: HostStatus) => boolean, timeoutMs = 120_000): Promise<HostStatus> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const s = await status();
      if (ok(s)) return s;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify({ boot: s.boot.phase, cursors: s.cursors, engine: s.engine?.status })}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  /** Loads the engine page and waits until the worker's boot has ended; returns the boot and the page's time to it. */
  async function open(): Promise<{ status: HostStatus; pageToReadyMs: number }> {
    await page.goto(`${site.origin}/engine.html`);
    await page.waitFor("window.umbradbEngine !== undefined", 30_000, "the engine page");
    const pageToReadyMs = (await page.eval("window.umbradbEngine.client.booted().then(() => performance.now())")) as number;
    return { status: await status(), pageToReadyMs };
  }

  beforeAll(async () => {
    if (browserExe === undefined) throw new Error("no Chromium/Chrome found: set MIP0018_UI_BROWSER or CHROME_BIN (see token-indexer/mip0018/ui/README.md)");
    out = mkdtempSync(join(tmpdir(), "umbradb-browser-build-"));
    const err = await buildError({ configFile: CONFIG, define: { __UMBRADB_BROWSER_CONFIG__: JSON.stringify({ autoStart: false }) }, build: { outDir: out, emptyOutDir: true } });
    if (err !== undefined) throw new Error(`the browser build failed: ${err}`);
    const tapeBytes = readFileSync(join(ROOT, "token-indexer/browser/tapes/stagenet-715402-715433.tape.json.gz"));
    chain = createTapeReplay(await readTape(new Uint8Array(tapeBytes), "gzip"));
    site = await serveSite(out, chain);
    browser = await Browser.launch(browserExe);
    report.browser = await browser.version();
    page = await browser.newPage();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((r) => (site?.server ? site.server.close(r) : r(undefined)));
    if (out !== undefined) rmSync(out, { recursive: true, force: true });
    if (process.env.UMBRADB_BROWSER_REPORT) writeFileSync(process.env.UMBRADB_BROWSER_REPORT, JSON.stringify(report, null, 2));
  });

  it("[[browser.build.bundle]] the build holds one ledger-v9 instance with its class names kept, PGlite's assets and both tapes; the node-free plugin refuses postgres.js and Node built-ins", async () => {
    const assets = readdirSync(join(out, "assets"));
    expect(readdirSync(out).sort()).toEqual(["_headers", "assets", "engine.html", "index.html"]);
    expect(assets.filter((f) => /^midnight_ledger_wasm_v9_bg-.*\.wasm$/.test(f))).toHaveLength(1);
    expect(assets.filter((f) => f.endsWith(".wasm")).map((f) => f.replace(/-[\w-]+\.wasm$/, "")).sort()).toEqual(["initdb", "midnight_ledger_wasm_v9_bg", "pglite"]);
    expect(assets.filter((f) => /^pglite-.*\.data$/.test(f))).toHaveLength(1);
    expect(assets.filter((f) => /^stagenet-71(4485-715183|5402-715433)\.tape\.json-.*\.gz$/.test(f))).toHaveLength(2);
    const js = assets.filter((f) => f.endsWith(".js"));
    const defining = js.filter((f) => /class ContractCall\b/.test(readFileSync(join(out, "assets", f), "utf8")));
    expect(defining, "exactly one chunk defines the ledger's classes, under their own names").toHaveLength(1);
    for (const name of ["Transaction", "ContractDeploy", "MaintenanceUpdate"]) expect(readFileSync(join(out, "assets", defining[0]!), "utf8")).toMatch(new RegExp(`class ${name}\\b`));
    expect(js.filter((f) => /^worker-.*\.js$/.test(f))).toHaveLength(1);

    const dir = mkdtempSync(join(tmpdir(), "umbradb-guard-"));
    try {
      const entry = (name: string, text: string): string => {
        const f = join(dir, name);
        writeFileSync(f, text);
        return f;
      };
      const guarded = (input: string) => ({ configFile: false as const, root: dir, plugins: [nodeFreeBundle(ROOT)], build: { outDir: join(dir, "out"), rolldownOptions: { input } } });
      expect(await buildError(guarded(entry("pg.js", 'import "postgres";\n')))).toContain("imports postgres (postgres.js)");
      const client = resolve(ROOT, "src/postgres/client.ts");
      expect(await buildError(guarded(entry("client.js", `import ${JSON.stringify(client)};\n`)))).toContain("src/postgres/client.ts imports postgres (postgres.js)");
      expect(await buildError(guarded(entry("fs.js", 'import { readFileSync } from "node:fs";\nconsole.log(readFileSync);\n')))).toContain("imports the Node module node:fs");
      expect(await buildError(guarded(entry("ok.js", 'console.log("fine");\n')))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("[[browser.worker.opfs-reload-resume]] the worker boots on OPFS, syncs and scans a replayed range, survives reloads with the same cursors and API answers, and resumes at the cursor fetching only the missing heights", async () => {
    // First open: a new OPFS store.
    const first = await open();
    const caps = first.status.boot.capabilities!;
    expect(first.status.boot.phase).toBe("ready");
    expect(caps).toMatchObject({ supported: true, missing: [] });
    expect(Object.values(caps.checks).every(Boolean)).toBe(true);
    expect(first.status.store).toMatchObject({ dataDir: "opfs-ahp://umbradb-stagenet", created: true, fsync: "off", durability: "non-durable" });
    expect(first.status.store!.serverVersion).toMatch(/^18\./);
    expect(first.status.cursors).toEqual({ sync: null, scan: null });
    report.firstOpen = { pageToReadyMs: first.pageToReadyMs, boot: first.status.boot.timings, capabilities: caps };

    // Part of the range, replayed inside the worker.
    const started = await engine(`c.start(${JSON.stringify({ source: { kind: "tape", range: "u1" }, startHeight: U1.from, endHeight: MID, ...FAST })})`) as HostStatus;
    expect(started.engine?.running).toBe(true);
    const t0 = Date.now();
    const synced = await until("the first part", (s) => s.engine!.status.sync.phase === "done" && s.cursors?.scan?.nextHeight === MID + 1);
    report.firstPart = { blocks: MID - U1.from + 1, wallMs: Date.now() - t0 };
    expect(synced.cursors).toEqual({ sync: { height: MID, startHeight: U1.from }, scan: { fromHeight: U1.from, nextHeight: MID + 1, lastBlockHash: synced.cursors!.scan!.lastBlockHash } });
    expect(synced.cursors!.scan!.lastBlockHash).toMatch(/^[0-9a-f]{64}$/);
    const statusBefore = await api("/v1/status");
    expect(statusBefore.body).toMatchObject({ network: "stagenet", startHeight: U1.from, indexedHeight: MID, archiveHeight: MID, scanner: "following", durability: "non-durable" });
    const tokensBefore = await api("/v1/tokens");
    expect(tokensBefore.status).toBe(200);
    // U1's mint (715409) was decoded in the worker: a ContractCall recognized by the bundle's one ledger instance.
    const minted = (tokensBefore.body.items as Json[]).filter((t) => t.source === "identity" && t.minted !== null);
    expect(minted.map((t) => [t.contractAddress, t.kind, t.minted.firstMint])).toEqual([
      ["11010832a39954d9ccce48f6b5fce25fc789abb1d700ee45b26b69af3e5dd63b", 1, { height: 715409, txIndex: 0, txHash: "173ad3b6344edc42b9468a42e001cff52dc9fb1136a51a9e3c1275ed6a2b3ad7" }],
    ]);
    expect(chain.counts.size).toBe(0); // nothing came over the network

    // Reload while the engine runs (as closing the tab does): the store is reopened with the same cursors and answers.
    const second = await open();
    expect(second.status.boot.phase).toBe("ready");
    expect(second.status.store).toMatchObject({ created: false, fsync: "off" });
    expect(second.status.store!.migrations).toEqual(first.status.store!.migrations);
    expect(second.status.engine).toBeNull();
    expect(second.status.cursors).toEqual(synced.cursors);
    expect((await api("/v1/status")).body).toEqual({ ...statusBefore.body, scanner: "off" });
    expect(await api("/v1/tokens")).toEqual(tokensBefore);
    report.reopen = { pageToReadyMs: second.pageToReadyMs, boot: second.status.boot.timings };

    // Resume over fetch: no start height needed, the archive continues at its cursor; only the missing heights are fetched.
    const net = { kind: "network", nodeUrl: `${site.origin}/chain/rpc`, indexerUrl: `${site.origin}/chain/graphql` };
    await engine(`c.start(${JSON.stringify({ source: net, ...FAST })})`);
    const t1 = Date.now();
    const resumed = await until("the rest of the range", (s) => s.cursors?.sync?.height === U1.to && s.cursors?.scan?.nextHeight === U1.to + 1);
    report.resume = { blocks: U1.to - MID, wallMs: Date.now() - t1 };
    expect(resumed.cursors).toMatchObject({ sync: { height: U1.to, startHeight: U1.from }, scan: { fromHeight: U1.from, nextHeight: U1.to + 1 } });
    expect(chain.counts.get("chain_getBlock")).toBe(U1.to - MID);
    expect(chain.counts.get("indexer.block")).toBe(U1.to - MID);
    const statusEnd = await api("/v1/status");
    expect(statusEnd.body).toMatchObject({ startHeight: U1.from, indexedHeight: U1.to, archiveHeight: U1.to, scanner: "following" });
    const tokensEnd = await api("/v1/tokens");

    // A second reload keeps everything.
    const third = await open();
    expect(third.status.store!.created).toBe(false);
    expect(third.status.cursors).toEqual(resumed.cursors);
    expect((await api("/v1/status")).body).toEqual({ ...statusEnd.body, scanner: "off" });
    expect(await api("/v1/tokens")).toEqual(tokensEnd);
    expect(page.exceptions).toEqual([]);
    report.reopen2 = { pageToReadyMs: third.pageToReadyMs, boot: third.status.boot.timings };
  }, 300_000);

  it("[[browser.worker.protocol]] the worker answers malformed and unknown messages with their error codes, refuses a second start, and answers not-implemented for export and import", async () => {
    await open();
    const raw = (message: Json): Promise<Json> => page.eval(`new Promise((resolve) => {
      const w = window.umbradbEngine.worker;
      const on = (e) => { if (e.data && e.data.type === "response" && e.data.id === ${JSON.stringify(message.id ?? null)}) { w.removeEventListener("message", on); resolve(e.data); } };
      w.addEventListener("message", on);
      w.postMessage(${JSON.stringify(message)});
    })`);
    expect(await raw({ v: 1, id: 9001, type: "system" })).toMatchObject({ ok: false, id: 9001, error: { code: "unknown-type" } });
    expect(await raw({ v: 2, id: 9002, type: "status" })).toMatchObject({ ok: false, id: 9002, error: { code: "unsupported-version" } });
    expect(await raw({ v: 1, id: 9003, type: "api", method: "GET" })).toMatchObject({ ok: false, id: 9003, error: { code: "bad-request" } });
    const okRaw = await raw({ v: 1, id: 9004, type: "api", method: "GET", target: "/v1/status" });
    expect(okRaw).toMatchObject({ ok: true, id: 9004, request: "api", result: { status: 200 } });

    const codes = await engine(`Promise.all([c.export(), c.import(new Blob(["x"]))].map((p) => p.then(() => "resolved", (e) => e.code)))`);
    expect(codes).toEqual(["not-implemented", "not-implemented"]);
    await engine(`c.start(${JSON.stringify({ source: { kind: "tape", range: "u1" }, ...FAST })})`);
    expect(await engine(`c.start({}).then(() => "resolved", (e) => e.code)`)).toBe("already-running");
    const stopped = (await engine("c.stop()")) as HostStatus;
    expect(stopped.engine).toMatchObject({ running: false, error: null });
    expect(stopped.cursors).toMatchObject({ sync: { height: U1.to }, scan: { nextHeight: U1.to + 1 } });
  }, 120_000);
});

