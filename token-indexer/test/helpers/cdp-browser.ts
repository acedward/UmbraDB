/**
 * A minimal Chrome DevTools Protocol driver for the explorer page's browser tests (project 00026, sub-plan C3) —
 * no npm dependency: Node's own `WebSocket` client and a headless Chromium or Chrome binary.
 *
 * Where the browser comes from (`findBrowser`): `MIP0018_UI_BROWSER` or `CHROME_BIN` when set; else the Chromium of
 * a Playwright image (`/ms-playwright/chromium-*`, or `PLAYWRIGHT_BROWSERS_PATH`); else `google-chrome`,
 * `google-chrome-stable`, `chromium` or `chromium-browser` on `PATH` (GitHub's ubuntu runners have Chrome). Locally
 * the tests run in the official Playwright image (`mcr.microsoft.com/playwright`), see `ui/README.md`.
 *
 * Recorded per page: every request the page sends (Network domain), responses' statuses, failed loads (incl.
 * `blockedReason`, e.g. `csp`), console calls, browser log entries (CSP reports arrive here), uncaught exceptions, and
 * the page's own `securitypolicyviolation` events (a listener installed before any page script runs).
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
    for (const d of dirs) for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) if (existsSync(join(root, d, sub))) return join(root, d, sub);
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

export interface RequestRecord { url: string; method: string; type: string; status?: number; failed?: string; blockedReason?: string }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class Page {
  readonly requests: RequestRecord[] = [];
  readonly console: Array<{ type: string; text: string }> = [];
  readonly logs: Array<{ source: string; level: string; text: string; url?: string }> = [];
  readonly exceptions: string[] = [];
  private readonly byId = new Map<string, RequestRecord>();
  private loads = 0;

  private constructor(private readonly conn: Connection, readonly sessionId: string) {}

  static async open(conn: Connection): Promise<Page> {
    const { targetId } = await conn.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(conn, sessionId);
    const mine = (l: (p: Json) => void): Listener => (p, s) => { if (s === sessionId) l(p); };
    conn.on("Network.requestWillBeSent", mine((p) => {
      const r: RequestRecord = { url: p.request.url, method: p.request.method, type: p.type ?? "" };
      page.requests.push(r);
      page.byId.set(p.requestId, r);
    }));
    conn.on("Network.responseReceived", mine((p) => { const r = page.byId.get(p.requestId); if (r !== undefined) r.status = p.response.status; }));
    conn.on("Network.loadingFailed", mine((p) => {
      const r = page.byId.get(p.requestId);
      if (r !== undefined) { r.failed = p.errorText; if (p.blockedReason !== undefined) r.blockedReason = p.blockedReason; }
    }));
    conn.on("Runtime.consoleAPICalled", mine((p) => page.console.push({ type: p.type, text: (p.args ?? []).map((a: Json) => a.value ?? a.description ?? "").join(" ") })));
    conn.on("Runtime.exceptionThrown", mine((p) => page.exceptions.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "exception")));
    conn.on("Log.entryAdded", mine((p) => page.logs.push({ source: p.entry.source, level: p.entry.level, text: p.entry.text, url: p.entry.url })));
    conn.on("Page.loadEventFired", mine(() => { page.loads++; }));
    for (const d of ["Page", "Runtime", "Network", "Log"]) await conn.send(`${d}.enable`, {}, sessionId);
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

  /** Polls an expression until it is truthy. */
  async waitFor(expression: string, timeoutMs = 30_000, what = expression): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if (await this.eval<boolean>(`Boolean(${expression})`)) return;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
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

  async version(): Promise<string> {
    return (await this.conn.send("Browser.getVersion")).product as string;
  }

  newPage(): Promise<Page> {
    return Page.open(this.conn);
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
