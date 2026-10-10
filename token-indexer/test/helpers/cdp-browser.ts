/**
 * A minimal Chrome DevTools Protocol driver for the explorer page's browser tests —
 * no npm dependency: Node's own `WebSocket` client and a headless Chromium or Chrome binary.
 *
 * Where the browser comes from (`findBrowser`): `MIP0018_UI_BROWSER` or `CHROME_BIN` when set; else the Chromium of
 * a Playwright image (`/ms-playwright/chromium-*`, or `PLAYWRIGHT_BROWSERS_PATH`); else `google-chrome`,
 * `google-chrome-stable`, `chromium` or `chromium-browser` on `PATH` (GitHub's ubuntu runners have Chrome). Locally
 * the tests run in the official Playwright image (`mcr.microsoft.com/playwright`), see `ui/README.md`.
 *
 * Recorded per page: every request the page sends (Network domain), responses' statuses, failed loads (incl.
 * `blockedReason`, e.g. `csp`), console calls, browser log entries (CSP reports arrive here), uncaught exceptions, and
 * the page's own `securitypolicyviolation` events (a listener installed before any page script runs). The dedicated
 * workers a page starts are listed in `workers` (and whether each still runs) after `trackWorkers()`; with
 * `newPage({ workers: true })` they are also recorded into the same lists as the page (entries marked
 * `target: "worker"`): each worker is attached before its script runs, so all of its requests and log entries are seen,
 * and gets a `self.__cspViolations` list of its own `securitypolicyviolation` events. `workerScript` is evaluated in
 * each of those workers right before its first script runs. `crash()` kills the tab's renderer process.
 *
 * Every page opens as a new tab of the same browser profile (the default browser context), so pages share storage
 * (OPFS), Web Locks and BroadcastChannel as tabs of one Chrome profile do.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export function findBrowser(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const explicit of [env.MIP0018_UI_BROWSER, env.CHROME_BIN]) if (explicit !== undefined && explicit !== "" && existsSync(explicit)) return explicit;
  for (const root of [env.PLAYWRIGHT_BROWSERS_PATH, "/ms-playwright"]) {
    if (root === undefined || root === "" || !existsSync(root)) continue;
    const dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    for (const d of dirs) for (const sub of ["chrome-linux64/chrome", "chrome-linux-arm64/chrome", "chrome-linux/chrome"]) if (existsSync(join(root, d, sub))) return join(root, d, sub);
  }
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"])
    for (const dir of (env.PATH ?? "").split(delimiter)) if (dir !== "" && existsSync(join(dir, name))) return join(dir, name);
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
interface Pending { resolve: (v: Json) => void; reject: (e: Error) => void; method: string }
type Listener = (params: Json, sessionId: string | undefined) => void;

class Connection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Listener[]>();
  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as Json;
      if (typeof msg.id === "number") {
        const p = this.pending.get(msg.id);
        if (p === undefined) return;
        this.pending.delete(msg.id);
        if (msg.error !== undefined) p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
        return;
      }
      for (const l of this.listeners.get(msg.method) ?? []) l(msg.params, msg.sessionId);
    });
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) p.reject(new Error(`${p.method}: DevTools connection closed`));
      this.pending.clear();
    });
  }
  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }));
    });
  }
  on(method: string, l: Listener): void {
    const ls = this.listeners.get(method) ?? [];
    ls.push(l);
    this.listeners.set(method, ls);
  }
  close(): void {
    this.ws.close();
  }
}

export interface RequestRecord { url: string; method: string; type: string; status?: number; failed?: string; blockedReason?: string; target?: "worker" }
export interface WorkerRecord { targetId: string; url: string; running: boolean }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface PageOptions {
  /** Also record the page's dedicated workers (requests, console, log entries, exceptions, CSP violations). */
  workers?: boolean;
  /** With `workers`: a script evaluated in each dedicated worker the page starts, before the worker's own script runs. */
  workerScript?: string;
  /** Open the tab in a window of its own (still the same profile): it stays visible whatever other tabs are in front,
   *  and minimizing its window hides it alone. */
  newWindow?: boolean;
}

const VIOLATIONS = "__cspViolations = []; addEventListener('securitypolicyviolation', function (e) { __cspViolations.push(e.violatedDirective + ' ' + e.blockedURI); });";

export class Page {
  readonly requests: RequestRecord[] = [];
  readonly console: Array<{ type: string; text: string; target?: "worker" }> = [];
  readonly logs: Array<{ source: string; level: string; text: string; url?: string; target?: "worker" }> = [];
  readonly exceptions: string[] = [];
  /** The dedicated workers this page started, once {@link trackWorkers} has been called (or with `{ workers: true }`). */
  readonly workers: WorkerRecord[] = [];
  /** The DevTools sessions of the page's dedicated workers, oldest first (with `{ workers: true }`). */
  readonly workerSessions: string[] = [];
  private readonly byId = new Map<string, RequestRecord>();
  /** The page's session and, with `{ workers: true }`, its workers' sessions: whatever they report is recorded. */
  private readonly sessions = new Set<string>();
  private loads = 0;
  private trackingWorkers = false;
  /** DevTools reported that the tab's renderer process crashed. */
  crashed = false;

  private constructor(private readonly conn: Connection, readonly sessionId: string, readonly targetId: string) {
    this.sessions.add(sessionId);
  }

  static async open(conn: Connection, opts: PageOptions = {}): Promise<Page> {
    const { targetId } = await conn.send("Target.createTarget", { url: "about:blank", ...(opts.newWindow === true ? { newWindow: true } : {}) });
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(conn, sessionId, targetId);
    const mine = (l: (p: Json, worker: boolean) => void): Listener => (p, s) => { if (s !== undefined && page.sessions.has(s)) l(p, s !== sessionId); };
    const tag = (worker: boolean): { target?: "worker" } => (worker ? { target: "worker" } : {});
    conn.on("Network.requestWillBeSent", mine((p, w) => {
      const r: RequestRecord = { url: p.request.url, method: p.request.method, type: p.type ?? "", ...tag(w) };
      page.requests.push(r);
      page.byId.set(p.requestId, r);
    }));
    conn.on("Network.responseReceived", mine((p) => { const r = page.byId.get(p.requestId); if (r !== undefined) r.status = p.response.status; }));
    conn.on("Network.loadingFailed", mine((p) => {
      const r = page.byId.get(p.requestId);
      if (r !== undefined) { r.failed = p.errorText; if (p.blockedReason !== undefined) r.blockedReason = p.blockedReason; }
    }));
    conn.on("Runtime.consoleAPICalled", mine((p, w) => page.console.push({ type: p.type, text: (p.args ?? []).map((a: Json) => a.value ?? a.description ?? "").join(" "), ...tag(w) })));
    conn.on("Runtime.exceptionThrown", mine((p) => page.exceptions.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "exception")));
    conn.on("Log.entryAdded", mine((p, w) => page.logs.push({ source: p.entry.source, level: p.entry.level, text: p.entry.text, url: p.entry.url, ...tag(w) })));
    conn.on("Page.loadEventFired", mine(() => { page.loads++; }));
    conn.on("Inspector.targetCrashed", (_p, s) => { if (s === sessionId) page.crashed = true; });
    if (opts.workers === true) await page.attachWorkers(true, opts.workerScript);
    for (const d of ["Page", "Runtime", "Network", "Log", "Inspector"]) await conn.send(`${d}.enable`, {}, sessionId);
    await conn.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__cspViolations = []; document.addEventListener('securitypolicyviolation', function (e) { window.__cspViolations.push(e.violatedDirective + ' ' + e.blockedURI); });",
    }, sessionId);
    await conn.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    return page;
  }

  /** Loads a URL and waits for its load event. */
  async goto(url: string, timeoutMs = 30_000): Promise<void> {
    const before = this.loads;
    await this.conn.send("Page.navigate", { url }, this.sessionId);
    const end = Date.now() + timeoutMs;
    while (this.loads === before) {
      if (Date.now() > end) throw new Error(`load of ${url} timed out`);
      await sleep(50);
    }
  }

  /** Evaluates an expression in the page (promises awaited) and returns its JSON value. */
  async eval<T = Json>(expression: string): Promise<T> {
    const r = await this.conn.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, this.sessionId);
    if (r.exceptionDetails !== undefined) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  /** Evaluates an expression in the page's newest dedicated worker (promises awaited) and returns its JSON value. */
  async evalWorker<T = Json>(expression: string): Promise<T> {
    const session = this.workerSessions.at(-1);
    if (session === undefined) throw new Error("no worker recorded: open the page with { workers: true }");
    const r = await this.conn.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
    if (r.exceptionDetails !== undefined) throw new Error(`worker evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }

  /** Polls an expression until it is truthy. */
  async waitFor(expression: string, timeoutMs = 30_000, what = expression): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (await this.eval<boolean>(`Boolean(${expression})`)) return;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  }

  /** Sends a DevTools command to this page's session. */
  send(method: string, params: Json = {}): Promise<Json> {
    return this.conn.send(method, params, this.sessionId);
  }

  /** Records the dedicated workers the page starts from now on, in {@link workers} (attached without pausing them). */
  trackWorkers(): Promise<void> {
    return this.attachWorkers(false);
  }

  /**
   * Attaches to every target the page starts and lists its dedicated workers in {@link workers}. With `record`, each
   * target is held before its script runs until the worker's domains are enabled (its requests, console, log entries
   * and exceptions are then recorded with the page's) and it has a `self.__cspViolations` list.
   */
  private async attachWorkers(record: boolean, workerScript?: string): Promise<void> {
    if (this.trackingWorkers) return;
    this.trackingWorkers = true;
    const bySession = new Map<string, WorkerRecord>();
    this.conn.on("Target.attachedToTarget", (p, s) => {
      if (s !== this.sessionId) return;
      const child = p.sessionId as string;
      const worker = p.targetInfo?.type === "worker";
      if (worker) {
        const w: WorkerRecord = { targetId: p.targetInfo.targetId, url: p.targetInfo.url, running: true };
        this.workers.push(w);
        bySession.set(child, w);
      }
      if (!record) return;
      void (async () => {
        if (worker) {
          this.sessions.add(child);
          this.workerSessions.push(child);
          for (const d of ["Runtime", "Network", "Log"]) await this.conn.send(`${d}.enable`, {}, child);
          if (workerScript !== undefined) await this.beforeWorkerScript(child, workerScript);
        }
        await this.conn.send("Runtime.runIfWaitingForDebugger", {}, child);
        if (worker) await this.conn.send("Runtime.evaluate", { expression: VIOLATIONS }, child);
      })().catch(() => { /* the target closed */ });
    });
    this.conn.on("Target.detachedFromTarget", (p, s) => {
      if (s !== this.sessionId) return;
      const w = bySession.get(p.sessionId);
      if (w !== undefined) w.running = false;
    });
    await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: record, flatten: true });
  }

  /**
   * Evaluates `script` in the worker of `session` once its global scope is complete, right before the worker's first
   * script runs: a worker held at its start has a global scope without most Web APIs yet, so the debugger pauses at the
   * first script's execution, evaluates `script` there, and lets the worker go on (the debugger is then turned off).
   */
  private async beforeWorkerScript(session: string, script: string): Promise<void> {
    await this.conn.send("Debugger.enable", {}, session);
    const { breakpointId } = await this.conn.send("Debugger.setInstrumentationBreakpoint", { instrumentation: "beforeScriptExecution" }, session);
    let done = false;
    this.conn.on("Debugger.paused", (p, s) => {
      if (s !== session || done) return;
      done = true;
      void (async () => {
        const r = await this.conn.send("Runtime.evaluate", { expression: script }, session);
        if (r.exceptionDetails !== undefined) this.exceptions.push(`worker script: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
        await this.conn.send("Debugger.removeBreakpoint", { breakpointId }, session);
        await this.conn.send("Debugger.resume", {}, session);
        await this.conn.send("Debugger.disable", {}, session);
      })().catch(() => { /* the worker ended */ });
      void p;
    });
  }

  /**
   * Kills the tab's renderer process, and with it the page and its dedicated workers, as a crash does (`Page.crash`, which
   * never answers); resolves once DevTools reports the crash.
   */
  async crash(timeoutMs = 10_000): Promise<void> {
    void this.send("Page.crash").catch(() => { /* the crashed target never answers */ });
    const end = Date.now() + timeoutMs;
    while (!this.crashed) {
      if (Date.now() > end) throw new Error("the renderer did not crash");
      await sleep(10);
    }
  }

  /** Closes the tab, as the user closing it does. */
  async close(): Promise<void> {
    await this.conn.send("Target.closeTarget", { targetId: this.targetId });
  }

  /** A PNG of the whole page. */
  async screenshot(): Promise<Buffer> {
    const r = await this.conn.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, this.sessionId);
    return Buffer.from(r.data as string, "base64");
  }
}

export class Browser {
  private constructor(readonly executable: string, private readonly child: ChildProcess, private readonly conn: Connection, private readonly dir: string) {}

  static async launch(executable: string, timeoutMs = 60_000): Promise<Browser> {
    const dir = mkdtempSync(join(tmpdir(), "mip0018-ui-"));
    const child = spawn(executable, [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
      "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider", "--metrics-recording-only", "--mute-audio",
      "--no-pings", "--password-store=basic", "--use-mock-keychain", "--hide-scrollbars", "--font-render-hinting=none",
      `--user-data-dir=${dir}`, "--remote-debugging-port=0", "--window-size=1400,900", "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    const wsUrl = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`the browser did not start within ${timeoutMs} ms: ${err.slice(-2000)}`)), timeoutMs);
      child.stderr!.on("data", (b: Buffer) => {
        err += b.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m !== null) { clearTimeout(t); resolve(m[1]!); }
      });
      child.once("exit", (code) => { clearTimeout(t); reject(new Error(`the browser exited (${code}): ${err.slice(-2000)}`)); });
    });
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("DevTools WebSocket failed")), { once: true });
    });
    return new Browser(executable, child, new Connection(ws), dir);
  }

  /** Sends a DevTools command to the browser. */
  send(method: string, params: Json = {}): Promise<Json> {
    return this.conn.send(method, params);
  }

  async version(): Promise<string> {
    return (await this.conn.send("Browser.getVersion")).product as string;
  }

  newPage(opts?: PageOptions): Promise<Page> {
    return Page.open(this.conn, opts);
  }

  async close(): Promise<void> {
    try {
      await Promise.race([this.conn.send("Browser.close"), sleep(5_000)]);
    } catch {
      // already closing
    }
    this.conn.close();
    if (this.child.exitCode === null) {
      this.child.kill("SIGKILL");
      await new Promise((r) => this.child.once("exit", r));
    }
    rmSync(this.dir, { recursive: true, force: true });
  }
}
