/**
 * Measurements of the browser build (`token-indexer/browser/`) in headless Chromium, behind `MEASUREMENTS.md` there.
 * Development tool, not a test: it prints one JSON line per run on stdout (and appends it to `--out <file>`).
 *
 *   node --import tsx token-indexer/dev/measure-browser.ts sizes [--dir dist-browser]
 *   node --import tsx token-indexer/dev/measure-browser.ts cold [--runs 7] [--page index.html]
 *   node --import tsx token-indexer/dev/measure-browser.ts replay [--runs 7] [--page engine.html]
 *   node --import tsx token-indexer/dev/measure-browser.ts memory [--runs 3]
 *   node --import tsx token-indexer/dev/measure-browser.ts hidden [--runs 5] [--paced] [--page index.html]
 *   node --import tsx token-indexer/dev/measure-browser.ts status-page [--rounds 30] [--single]
 *
 * - `sizes`: every file of a built site, raw, gzip (level 9) and brotli (quality 11), and the totals with and without
 *   the recorded tapes and the published snapshot (`npm run build:browser` writes `dist-browser/`).
 * Every other scenario builds the site with Vite (`token-indexer/browser/vite.config.ts`; the engine does not start by
 * itself) into a temporary folder, serves it with its `_headers` rules (the policy, COOP/COEP: the pages and the worker
 * are cross-origin isolated) from 127.0.0.1 on a random free port at or above 10000, and drives Chromium (`findBrowser`
 * of `token-indexer/test/helpers/cdp-browser.ts`; `--headless=new`, a new profile per run) over the DevTools protocol
 * directly, so pages can be hidden and Chromium takes `--enable-blink-features=ForceEagerMeasureMemory`. The engine
 * replays the recorded IDX range (714485–715183, 699 blocks) from the build's tape: nothing reaches the network.
 * - `cold`: page open → engine ready, in phases, for a first open (new profile: the database is created), a reload,
 *   and a browser restart on the same profile.
 * - `replay`: the IDX range synced and scanned in the worker on OPFS, timed by the engine itself (its log lines: the
 *   sync's `start` to the scan step that reached 715183); the digests checked; the store's files (an OPFS walk in the
 *   worker) and `pg_database_size` before and after, and after a reload.
 * - `memory`: the worker's WebAssembly memories (tracked from the worker's first script: the memories its modules
 *   import or export, sampled every 100 ms), `performance.measureUserAgentSpecificMemory()` and the renderer processes'
 *   resident memory (`/proc`, so run it where Chromium runs), at boot and after the replay.
 * - `hidden`: the replay with the page visible or its window minimized (`document.visibilityState` "hidden"),
 *   alternating; `--paced` spaces chain requests 250 ms apart per endpoint, as on Stagenet.
 * Any scenario takes `--chrome-args "<switches>"`, extra Chromium switches (e.g. `--disable-renderer-backgrounding`).
 * - `status-page`: the replay with the system status page open or closed, in rounds of both (ABBA order): the explorer
 *   leads in its own window, the status page follows in a second one, shown (it watches and draws the engine's
 *   snapshots) or minimized (it watches nothing). Each arm replays the range again (`range`). The last line is the
 *   cost: the mean of log(open / closed) per round as a percentage, with its 95 % t-interval. `--single` toggles one
 *   tab instead, the status page leading (its renderer, which runs the worker, is then also in the background).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { findBrowser } from "../test/helpers/cdp-browser.ts";
import { type LocalServer, parseHeadersFile, serveStaticSite } from "../test/helpers/static-site.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const CONFIG = join(REPO, "token-indexer/browser/vite.config.ts");
const FROM = 714485;
const TO = 715183;
const BLOCKS = TO - FROM + 1;
const ARCHIVE_SHA = "cb0d5e213730ccffc135984c537b9e31d92c984d2b83f06854971a3a74e5b119";
const TABLES_SHA = "af6583d03da69ffd52a31fd89e663fe7892cf45aaf7234d9fc213c335dbc832c";
const TAPE = { source: { kind: "tape", range: "idx" }, startHeight: FROM, endHeight: TO, sync: { idleMs: 200 }, scan: { idleMs: 200 } };
/** The build's settings: no automatic start; the store's files are walked at every storage reading. */
const MEASURE_BUILD = { autoStart: false, quota: { storeEveryMs: 0 } };

const args = process.argv.slice(2);
const scenario = args[0] ?? "";
const opt = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : dflt;
};
const flag = (name: string): boolean => args.includes(`--${name}`);
const OUT = opt("out", "");
/** Extra Chromium switches (`--chrome-args "--a --b"`), recorded with every line. */
const CHROME_ARGS = opt("chrome-args", "").split(" ").filter((a) => a !== "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const record = (o: Json): void => {
  const line = JSON.stringify({ scenario, at: new Date().toISOString(), load: loadavg(), ...(CHROME_ARGS.length > 0 ? { chromeArgs: CHROME_ARGS } : {}), ...o });
  if (OUT !== "") appendFileSync(OUT, `${line}\n`);
  console.log(line);
};

// ── Sizes ────────────────────────────────────────────────────────────────────────────────────────────────────────

function sizes(dir: string): void {
  const files: string[] = [];
  (function walk(d: string) { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else files.push(p); } })(dir);
  const rows = files.map((f) => {
    const b = readFileSync(f);
    return {
      file: relative(dir, f), raw: b.length, gzip: gzipSync(b, { level: 9 }).length,
      brotli: brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: b.length } }).length,
    };
  }).sort((a, b) => b.raw - a.raw);
  const sum = (rs: typeof rows) => rs.reduce((a, r) => ({ files: a.files + 1, raw: a.raw + r.raw, gzip: a.gzip + r.gzip, brotli: a.brotli + r.brotli }), { files: 0, raw: 0, gzip: 0, brotli: 0 });
  const tape = (r: (typeof rows)[number]) => r.file.includes(".tape.json");
  const snapshot = (r: (typeof rows)[number]) => r.file.startsWith("snapshots/");
  record({
    dir, files: rows,
    total: { withoutTapesAndSnapshot: sum(rows.filter((r) => !tape(r) && !snapshot(r))), withTapes: sum(rows.filter((r) => !snapshot(r))), all: sum(rows) },
  });
}

// ── Build and serve ──────────────────────────────────────────────────────────────────────────────────────────────

const builds: string[] = [];
async function buildSite(config: Json): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "umbradb-measure-site-"));
  builds.push(dir);
  const { build } = await import("vite");
  await build({ logLevel: "silent", configFile: CONFIG, define: { __UMBRADB_BROWSER_CONFIG__: JSON.stringify(config) }, build: { outDir: dir, emptyOutDir: true } });
  return dir;
}

function serve(dir: string): Promise<LocalServer> {
  return serveStaticSite(dir, { headers: parseHeadersFile(readFileSync(join(dir, "_headers"), "utf8")) });
}

// ── A DevTools client ────────────────────────────────────────────────────────────────────────────────────────────

class Cdp {
  private id = 0;
  private readonly pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; m: string }>();
  private readonly listeners: Array<(m: Json) => void> = [];
  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (ev: MessageEvent) => {
      const m = JSON.parse(String(ev.data));
      if (typeof m.id === "number") {
        const p = this.pending.get(m.id);
        if (p === undefined) return;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(`${p.m}: ${JSON.stringify(m.error)}`));
        else p.resolve(m.result);
        return;
      }
      for (const l of this.listeners) l(m);
    });
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error(`${p.m}: connection closed`));
      this.pending.clear();
    });
  }
  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, m: method });
      this.ws.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }));
    });
  }
  on(l: (m: Json) => void): void {
    this.listeners.push(l);
  }
  close(): void {
    this.ws.close();
  }
}

interface Chrome { cdp: Cdp; child: ChildProcess; profile: string; version: string; close(keepProfile?: boolean): Promise<void> }

async function launch(executable: string, profile?: string): Promise<Chrome> {
  const dir = profile ?? mkdtempSync(join(tmpdir(), "umbradb-measure-profile-"));
  const child = spawn(executable, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
    "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider", "--metrics-recording-only", "--mute-audio",
    "--no-pings", "--password-store=basic", "--use-mock-keychain", "--hide-scrollbars", "--font-render-hinting=none",
    "--enable-blink-features=ForceEagerMeasureMemory",
    ...CHROME_ARGS,
    `--user-data-dir=${dir}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--window-size=1400,900", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  const url = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`the browser did not start: ${err.slice(-1000)}`)), 60_000);
    child.stderr!.on("data", (b: Buffer) => {
      err += b.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m !== null) { clearTimeout(t); resolve(m[1]!); }
    });
    child.once("exit", (code) => { clearTimeout(t); reject(new Error(`the browser exited (${code}): ${err.slice(-1000)}`)); });
  });
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("the DevTools WebSocket failed")), { once: true });
  });
  const cdp = new Cdp(ws);
  const version = (await cdp.send("Browser.getVersion")).product as string;
  return {
    cdp, child, profile: dir, version,
    async close(keepProfile = false) {
      try { await Promise.race([cdp.send("Browser.close"), sleep(5000)]); } catch { /* closing */ }
      cdp.close();
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        await Promise.race([exited, sleep(5000)]);
        if (child.exitCode === null) { child.kill("SIGKILL"); await exited; }
      }
      if (!keepProfile) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Installed in every page before its scripts: when the engine client attached to its worker (the first `message`
 *  listener on a Worker) and when each boot notice arrived, on the page's clock. */
const PAGE_PROBE = `(() => {
  const probe = (window.__measure = { boot: {}, workerListenAt: null });
  const add = EventTarget.prototype.addEventListener;
  const seen = new WeakSet();
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type === "message" && typeof Worker !== "undefined" && this instanceof Worker && !seen.has(this)) {
      seen.add(this);
      probe.workerListenAt ??= performance.now();
      add.call(this, "message", (e) => {
        const d = e.data;
        if (d && d.type === "notice" && d.notice === "boot" && d.boot && probe.boot[d.boot.phase] === undefined) probe.boot[d.boot.phase] = performance.now();
      });
    }
    return add.call(this, type, listener, options);
  };
  window.__cspViolations = [];
  document.addEventListener("securitypolicyviolation", (e) => window.__cspViolations.push(e.violatedDirective + " " + e.blockedURI));
})();`;

/**
 * Installed in the engine worker right before its first script (`memory`): tracks the WebAssembly memories its modules
 * import (`env.memory`) or export (`memory`) around `WebAssembly.instantiate`/`instantiateStreaming`, and samples
 * their live total every 100 ms. (Enumerating every import namespace stalls PGlite's start: its import objects are
 * proxies; DevTools `Runtime.queryObjects` hangs the worker.)
 */
const WORKER_PROBE = `(() => {
  if (self.__measureWasm) return true;
  const mems = [];
  const probe = (self.__measureWasm = { instances: 0, peak: 0, peakAt: 0, samples: 0 });
  const track = (m, kind) => {
    if (!(m instanceof WebAssembly.Memory) || mems.some((w) => w.ref.deref() === m)) return;
    mems.push({ ref: new WeakRef(m), kind });
  };
  const live = () => mems.map((w) => { const m = w.ref.deref(); return m === undefined ? null : { kind: w.kind, bytes: m.buffer.byteLength }; }).filter(Boolean);
  const sample = () => {
    probe.samples++;
    const total = live().reduce((a, x) => a + x.bytes, 0);
    if (total > probe.peak) { probe.peak = total; probe.peakAt = performance.now(); }
  };
  probe.live = live;
  for (const name of ["instantiate", "instantiateStreaming"]) {
    const original = WebAssembly[name];
    WebAssembly[name] = function (source, imports, ...rest) {
      let env;
      try { env = imports && imports.env; } catch {}
      return original.call(this, source, imports, ...rest).then((r) => {
        probe.instances++;
        try { if (env) track(env.memory, "imported"); } catch {}
        try { track((r.instance ?? r).exports.memory, "exported"); } catch {}
        sample();
        return r;
      });
    };
  }
  const tick = () => { sample(); setTimeout(tick, 100); };
  if (typeof setTimeout === "function") tick();
  return true;
})()`;

interface Tab {
  workerSessions: string[];
  exceptions: string[];
  eval(expr: string): Promise<Json>;
  evalWorker(expr: string): Promise<Json>;
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  windowState(state: "normal" | "minimized"): Promise<void>;
  violations(): Promise<string[]>;
}

/** A new tab in a window of its own; its dedicated workers are attached (with `probeWorkers`, each gets the memory
 *  probe before its first script, through a `beforeScriptExecution` breakpoint). */
async function openTab(c: Chrome, opts: { probeWorkers?: boolean } = {}): Promise<Tab> {
  const { targetId } = await c.cdp.send("Target.createTarget", { url: "about:blank", newWindow: true });
  const { sessionId } = await c.cdp.send("Target.attachToTarget", { targetId, flatten: true });
  let loads = 0;
  const exceptions: string[] = [];
  const workerSessions: string[] = [];
  c.cdp.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Page.loadEventFired") loads++;
    if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params.exceptionDetails?.exception?.description ?? "exception");
    if (m.method !== "Target.attachedToTarget" || m.params.targetInfo?.type !== "worker") return;
    const child = m.params.sessionId as string;
    workerSessions.push(child);
    void (async () => {
      if (opts.probeWorkers === true) {
        await c.cdp.send("Debugger.enable", {}, child);
        const { breakpointId } = await c.cdp.send("Debugger.setInstrumentationBreakpoint", { instrumentation: "beforeScriptExecution" }, child);
        let done = false;
        c.cdp.on((p) => {
          if (p.sessionId !== child || p.method !== "Debugger.paused" || done) return;
          done = true;
          void (async () => {
            const r = await c.cdp.send("Runtime.evaluate", { expression: WORKER_PROBE, returnByValue: true }, child);
            if (r.exceptionDetails !== undefined) exceptions.push(`probe: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
            await c.cdp.send("Debugger.removeBreakpoint", { breakpointId }, child);
            await c.cdp.send("Debugger.resume", {}, child);
            await c.cdp.send("Debugger.disable", {}, child);
          })().catch(() => { /* the worker ended */ });
        });
      }
      await c.cdp.send("Runtime.runIfWaitingForDebugger", {}, child);
    })().catch(() => { void c.cdp.send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => {}); });
  });
  await c.cdp.send("Page.enable", {}, sessionId);
  await c.cdp.send("Runtime.enable", {}, sessionId);
  await c.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_PROBE }, sessionId);
  await c.cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: opts.probeWorkers === true, flatten: true }, sessionId);
  const evalIn = async (expr: string, sid: string): Promise<Json> => {
    const r = await c.cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    if (r.exceptionDetails !== undefined) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const waitLoad = async (before: number) => {
    const end = Date.now() + 60_000;
    while (loads === before) {
      if (Date.now() > end) throw new Error("the page did not load");
      await sleep(20);
    }
  };
  const { windowId } = await c.cdp.send("Browser.getWindowForTarget", { targetId });
  return {
    workerSessions, exceptions,
    eval: (expr) => evalIn(expr, sessionId),
    evalWorker: (expr) => {
      const s = workerSessions.at(-1);
      if (s === undefined) throw new Error("no worker");
      return evalIn(expr, s);
    },
    async goto(url) {
      const before = loads;
      await c.cdp.send("Page.navigate", { url }, sessionId);
      await waitLoad(before);
    },
    async reload() {
      const before = loads;
      await c.cdp.send("Page.reload", {}, sessionId);
      await waitLoad(before);
    },
    async windowState(state) {
      await c.cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: state } });
    },
    violations: () => evalIn("window.__cspViolations ?? []", sessionId),
  };
}

const engine = (t: Tab, expr: string): Promise<Json> => t.eval(`(async () => { const c = window.umbradbEngine.client; return ${expr}; })()`);

async function waitReady(t: Tab): Promise<Json> {
  const end = Date.now() + 120_000;
  while (!(await t.eval("Boolean(window.umbradbEngine)").catch(() => false))) {
    if (Date.now() > end) throw new Error("no engine on the page");
    await sleep(20);
  }
  return engine(t, "c.booted()");
}

/** A page open in phases, on the page's clock (milliseconds since the navigation started), and the worker's own boot
 *  timings and resource fetches (on its clock, from its creation). */
async function openTimings(t: Tab): Promise<Json> {
  const boot = await waitReady(t);
  for (let i = 0; i < 100 && (await t.eval("window.__measure.boot.ready === undefined")); i++) await sleep(20);
  const page = await t.eval(`(() => {
    const n = performance.getEntriesByType("navigation")[0];
    return { timeOrigin: performance.timeOrigin, responseEnd: n.responseEnd, domContentLoaded: n.domContentLoadedEventEnd, load: n.loadEventEnd,
      moduleRan: window.umbradbEngine.loadedAt, workerListen: window.__measure.workerListenAt, notices: window.__measure.boot,
      crossOriginIsolated: self.crossOriginIsolated };
  })()`);
  for (let i = 0; i < 50 && t.workerSessions.length === 0; i++) await sleep(20);
  const worker = t.workerSessions.length === 0 ? null : await t.evalWorker(`({ timeOrigin: performance.timeOrigin, crossOriginIsolated: self.crossOriginIsolated,
    resources: performance.getEntriesByType("resource").map((r) => ({ name: r.name.split("/").pop(), start: r.startTime, end: r.responseEnd, bytes: r.encodedBodySize })) })`).catch(() => null);
  const status = await engine(t, "c.status()");
  const ready = page.notices.ready ?? null;
  return {
    pageToReadyMs: ready,
    phases: {
      htmlResponseEnd: page.responseEnd, pageModuleRan: page.moduleRan, workerCreated: worker === null ? null : worker.timeOrigin - page.timeOrigin,
      clientAttached: page.workerListen, workerBootStart: ready === null ? null : ready - boot.timings.totalMs, notices: page.notices,
    },
    boot: boot.timings, bootPhase: boot.phase, created: status.store?.created ?? null, role: await t.eval("window.umbradbEngine.tabs.role()"),
    crossOriginIsolated: { page: page.crossOriginIsolated, worker: worker?.crossOriginIsolated ?? null }, workerResources: worker?.resources ?? null,
  };
}

/** The OPFS store's files, walked in the worker (bytes, count, the largest), and the browser's estimate. */
const OPFS_WALK = `(async () => {
  const dir = await navigator.storage.getDirectory();
  let bytes = 0, files = 0;
  const all = [];
  const walk = async (d, path) => { for await (const h of d.values()) {
    if (h.kind === "directory") await walk(h, path + "/" + h.name);
    else { const f = await h.getFile(); bytes += f.size; files++; all.push([path + "/" + h.name, f.size]); } } };
  await walk(dir, "");
  all.sort((a, b) => b[1] - a[1]);
  const est = await navigator.storage.estimate();
  return { bytes, files, largest: all.slice(0, 3), usage: est.usage, quota: est.quota };
})()`;

/** Replays the IDX range in the worker (`start`, or `range`, which drops the store's data first) and times it from the
 *  engine's own log lines: the sync's `start` to the scan step that reached the range's end. A paced run writes more
 *  lines than the log keeps (200), so with `early` the `start` line is read once shortly after the start. */
type LogLine = { at: number; source: string; text: string };
const startLine = (lines: LogLine[]) => lines.filter((l) => l.source === "sync" && l.text.startsWith("start ")).at(-1);

async function replayOnce(t: Tab, how: "start" | "range", config: Json = TAPE, pollMs = 250, early = false): Promise<Json> {
  const t0 = Date.now();
  if (how === "start") await engine(t, `c.start(${JSON.stringify(config)})`);
  else await engine(t, `c.range(${FROM}, ${TO})`);
  let earlyStart: LogLine | undefined;
  if (early) {
    await sleep(2000);
    earlyStart = startLine([...(await engine(t, "c.system({ refresh: {} })")).snapshot.logs].reverse());
  }
  const visibility = new Set<string>();
  for (;;) {
    const s = await engine(t, "c.status()");
    if (s.cursors?.scan?.nextHeight === TO + 1) break;
    if (s.engine?.error) throw new Error(`the engine failed: ${s.engine.error}`);
    if (Date.now() - t0 > 900_000) throw new Error("the replay timed out");
    visibility.add(await t.eval("document.visibilityState"));
    await sleep(pollMs);
  }
  const wallMs = Date.now() - t0;
  const lines = [...(await engine(t, "c.system({ refresh: {} })")).snapshot.logs].reverse() as LogLine[];
  const start = earlyStart ?? startLine(lines);
  if (start === undefined) throw new Error("no sync start in the log");
  const after = lines.filter((l) => l.at >= start.at);
  const syncDone = after.find((l) => l.source === "sync" && l.text.startsWith("batch ") && JSON.parse(l.text.slice(6)).to === TO);
  const scanDone = after.find((l) => l.source === "scan" && l.text.startsWith("batch ") && JSON.parse(l.text.slice(6)).toHeight === TO);
  if (scanDone === undefined) throw new Error("no final scan step in the log");
  const engineMs = scanDone.at - start.at;
  return { engineMs, syncMs: syncDone === undefined ? null : syncDone.at - start.at, wallMs, blocksPerSecond: BLOCKS / (engineMs / 1000), visibility: [...visibility] };
}

async function digests(t: Tab): Promise<Json> {
  const d = await engine(t, "c.digest()");
  return { archive: d.archive.sha256 === ARCHIVE_SHA, tables: d.tables.sha256 === TABLES_SHA, ms: d.elapsedMs };
}

/** The resident memory of the Chromium renderer processes on this machine (`/proc`), largest first. */
function rendererMemory(): Array<{ pid: number; vmHwmMB: number; vmRssMB: number }> {
  const out: Array<{ pid: number; vmHwmMB: number; vmRssMB: number }> = [];
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("--type=renderer")) continue;
      const st = readFileSync(`/proc/${pid}/status`, "utf8");
      const kb = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+) kB`).exec(st)?.[1] ?? NaN);
      out.push({ pid: Number(pid), vmHwmMB: kb("VmHWM") / 1024, vmRssMB: kb("VmRSS") / 1024 });
    } catch { /* gone */ }
  }
  return out.sort((a, b) => b.vmRssMB - a.vmRssMB);
}

// ── Scenarios ────────────────────────────────────────────────────────────────────────────────────────────────────

async function cold(exe: string, site: LocalServer, runs: number): Promise<void> {
  const page = opt("page", "index.html");
  for (let r = 0; r < runs; r++) {
    const c = await launch(exe);
    let profile = c.profile;
    try {
      const t = await openTab(c);
      await t.goto(`${site.origin}/${page}`);
      const first = await openTimings(t);
      await t.reload();
      const reopen = await openTimings(t);
      await t.goto("about:blank"); // so the restarted browser restores no tab of the site
      await c.close(true);
      const c2 = await launch(exe, profile);
      try {
        const t2 = await openTab(c2);
        await t2.goto(`${site.origin}/${page}`);
        const restart = await openTimings(t2);
        record({ run: r, page, browser: c.version, first, reopen, restart, violations: await t2.violations(), exceptions: [...t.exceptions, ...t2.exceptions] });
      } finally {
        await c2.close();
        profile = "";
      }
    } finally {
      if (c.child.exitCode === null) await c.close();
      else if (profile !== "") rmSync(profile, { recursive: true, force: true });
    }
  }
}

async function replay(exe: string, site: LocalServer, runs: number): Promise<void> {
  const page = opt("page", "engine.html");
  const relationBytes = (s: Json) => s.databases.schemas.reduce((a: number, sc: Json) => a + sc.tables.reduce((b: number, x: Json) => b + x.totalBytes, 0), 0);
  for (let r = 0; r < runs; r++) {
    const c = await launch(exe);
    try {
      const t = await openTab(c);
      await t.goto(`${site.origin}/${page}`);
      const open = await openTimings(t);
      const filesEmpty = await t.evalWorker(OPFS_WALK);
      const dbEmpty = (await engine(t, "c.system({ refresh: { database: true } })")).snapshot;
      const rep = await replayOnce(t, "start");
      const filesFull = await t.evalWorker(OPFS_WALK);
      const dbFull = (await engine(t, "c.system({ refresh: { database: true } })")).snapshot;
      const ok = await digests(t);
      await engine(t, "c.stop()");
      await t.reload();
      await waitReady(t);
      const filesReopened = await t.evalWorker(OPFS_WALK);
      record({
        run: r, page, browser: c.version, pageToReadyMs: open.pageToReadyMs, boot: open.boot, ...rep, digests: ok,
        bytes: {
          files: { empty: filesEmpty, full: filesFull, reopened: filesReopened, perBlock: (filesFull.bytes - filesEmpty.bytes) / BLOCKS },
          database: { empty: dbEmpty.databases.databaseBytes, full: dbFull.databases.databaseBytes, perBlock: (dbFull.databases.databaseBytes - dbEmpty.databases.databaseBytes) / BLOCKS },
          relations: { empty: relationBytes(dbEmpty), full: relationBytes(dbFull), perBlock: (relationBytes(dbFull) - relationBytes(dbEmpty)) / BLOCKS },
        },
        violations: await t.violations(), exceptions: t.exceptions,
      });
    } finally {
      await c.close();
    }
  }
}

async function memory(exe: string, site: LocalServer, runs: number): Promise<void> {
  const uasm = (t: Tab) => t.eval(`performance.measureUserAgentSpecificMemory().then((m) => ({ bytes: m.bytes,
    breakdown: m.breakdown.filter((b) => b.bytes > 0).map((b) => ({ bytes: b.bytes, types: b.types, scope: b.attribution.map((a) => a.scope) })) }))`)
    .catch((e: Error) => ({ error: e.message }));
  const wasm = (t: Tab) => t.evalWorker("({ peak: self.__measureWasm.peak, peakAt: self.__measureWasm.peakAt, samples: self.__measureWasm.samples, instances: self.__measureWasm.instances, live: self.__measureWasm.live() })")
    .catch((e: Error) => ({ error: e.message }));
  for (let r = 0; r < runs; r++) {
    const c = await launch(exe);
    const rss = new Map<number, { maxRssMB: number; maxHwmMB: number }>();
    const sampler = setInterval(() => {
      for (const p of rendererMemory()) {
        const m = rss.get(p.pid) ?? { maxRssMB: 0, maxHwmMB: 0 };
        rss.set(p.pid, { maxRssMB: Math.max(m.maxRssMB, p.vmRssMB), maxHwmMB: Math.max(m.maxHwmMB, p.vmHwmMB) });
      }
    }, 200);
    try {
      const t = await openTab(c, { probeWorkers: true });
      await t.goto(`${site.origin}/engine.html`);
      const boot = await waitReady(t);
      const wasmReady = await wasm(t);
      const uasmReady = await uasm(t);
      const rep = await replayOnce(t, "start");
      const wasmEnd = await wasm(t);
      const uasmEnd = await uasm(t);
      record({
        run: r, browser: c.version, crossOriginIsolated: await t.eval("self.crossOriginIsolated"), boot: boot.timings, wasmReady, wasmEnd, uasmReady, uasmEnd,
        renderers: [...rss.entries()].map(([pid, m]) => ({ pid, ...m })).sort((a, b) => b.maxRssMB - a.maxRssMB), replay: rep, digests: await digests(t),
        exceptions: t.exceptions,
      });
    } finally {
      clearInterval(sampler);
      await c.close();
    }
  }
}

async function hidden(exe: string, site: LocalServer, runs: number, paced: boolean): Promise<void> {
  const page = opt("page", "index.html");
  const config = paced ? { ...TAPE, sync: { ...TAPE.sync, minIntervalMs: 250 } } : TAPE;
  for (let r = 0; r < runs; r++) {
    for (const mode of r % 2 === 0 ? ["visible", "hidden"] : ["hidden", "visible"]) {
      const c = await launch(exe);
      try {
        const t = await openTab(c);
        await t.goto(`${site.origin}/${page}`);
        await waitReady(t);
        if (mode === "hidden") await t.windowState("minimized");
        await sleep(500);
        const atStart = await t.eval("document.visibilityState");
        const rep = await replayOnce(t, "start", config, paced ? 2000 : 250, paced);
        record({ run: r, mode, paced, page, browser: c.version, visibilityAtStart: atStart, ...rep, digests: await digests(t), exceptions: t.exceptions });
      } finally {
        await c.close();
      }
    }
  }
}

/** Mean of log(open / closed) over the rounds, as a percentage, with its 95 % t-interval. */
function cost(rows: Array<{ round: number; arm: string; engineMs: number }>): Json {
  const by = new Map<number, Record<string, number>>();
  for (const r of rows) by.set(r.round, { ...by.get(r.round), [r.arm]: r.engineMs });
  const logs = [...by.values()].filter((v) => v.open !== undefined && v.closed !== undefined).map((v) => Math.log(v.open! / v.closed!));
  const n = logs.length;
  const mean = logs.reduce((a, x) => a + x, 0) / n;
  const sd = Math.sqrt(logs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  // Student's t, two-sided 95 %: exact for small samples, 1.96 beyond.
  const T = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
    2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
  const half = (T[n - 2] ?? 2.0) * sd / Math.sqrt(n);
  const pct = (x: number) => (Math.exp(x) - 1) * 100;
  return { rounds: n, meanCostPct: pct(mean), ci95Pct: [pct(mean - half), pct(mean + half)], openSlowerRounds: logs.filter((x) => x > 0).length };
}

async function statusPage(exe: string, site: LocalServer, rounds: number): Promise<void> {
  const single = flag("single");
  const c = await launch(exe);
  const rows: Array<{ round: number; arm: string; engineMs: number }> = [];
  try {
    const lead = await openTab(c);
    await lead.goto(`${site.origin}/${single ? "system.html" : "index.html"}`);
    await waitReady(lead);
    const status = single ? lead : await openTab(c);
    if (!single) {
      await status.goto(`${site.origin}/system.html`);
      await waitReady(status);
    }
    const roles = { lead: await lead.eval("window.umbradbEngine.tabs.role()"), status: await status.eval("window.umbradbEngine.tabs.role()") };
    const warm = await replayOnce(lead, "start", TAPE, 500);
    record({ warmup: true, single, roles, browser: c.version, ...warm });
    for (let r = 0; r < rounds; r++) {
      for (const arm of r % 2 === 0 ? ["open", "closed"] : ["closed", "open"]) {
        await status.windowState(arm === "open" ? "normal" : "minimized");
        await sleep(3000);
        const visibilityOf = { status: await status.eval("document.visibilityState"), lead: await lead.eval("document.visibilityState") };
        const before = await status.eval("window.umbradbSystem.renders");
        const rep = await replayOnce(lead, "range", TAPE, 500);
        const renders = (await status.eval("window.umbradbSystem.renders")) - before;
        const snap = (await engine(lead, "c.system({ refresh: {} })")).snapshot;
        rows.push({ round: r, arm, engineMs: rep.engineMs });
        record({ round: r, arm, single, visibilityOf, renders, ...rep, watching: snap.collection.watching, catalogStatements: snap.databases.statements });
      }
    }
    record({
      summary: true, single, cost: cost(rows), digests: await digests(lead), restarts: await lead.eval("window.umbradbEngine.restarts().length"),
      violations: [...(await lead.violations()), ...(single ? [] : await status.violations())], exceptions: [...lead.exceptions, ...(single ? [] : status.exceptions)],
    });
  } finally {
    await c.close();
  }
}

async function main(): Promise<void> {
  if (scenario === "sizes") return sizes(opt("dir", join(REPO, "dist-browser")));
  const scenarios = ["cold", "replay", "memory", "hidden", "status-page"];
  if (!scenarios.includes(scenario)) throw new Error(`scenario: sizes, ${scenarios.join(", ")}`);
  const exe = findBrowser();
  if (exe === undefined) throw new Error("no Chromium/Chrome found: set MIP0018_UI_BROWSER or CHROME_BIN");
  const site = await serve(await buildSite(scenario === "status-page" ? { autoStart: false } : MEASURE_BUILD));
  try {
    if (scenario === "cold") await cold(exe, site, Number(opt("runs", "7")));
    else if (scenario === "replay") await replay(exe, site, Number(opt("runs", "7")));
    else if (scenario === "memory") await memory(exe, site, Number(opt("runs", "3")));
    else if (scenario === "hidden") await hidden(exe, site, Number(opt("runs", "5")), flag("paced"));
    else await statusPage(exe, site, Number(opt("rounds", "30")));
  } finally {
    await site.close();
    for (const d of builds) rmSync(d, { recursive: true, force: true });
  }
}

await main();
process.exit(0);
