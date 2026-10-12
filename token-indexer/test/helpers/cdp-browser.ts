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
 *
 * Failures explain themselves: every page also records the `error` events of the dedicated workers it creates (their
 * message, file, line and column, through a wrapper of the page's `Worker` constructor and a DevTools binding; nothing
 * else in the page changes), printed as they happen; and when a test of a file that uses this module fails, what every
 * page opened during that test (and every page still open) recorded is printed: {@link Page.diagnostics}, the last
 * lines of each list only.
 *
 * A page load the machine's network aborted is loaded again ({@link Page.goto}, at most {@link LOAD_ATTEMPTS} times,
 * one printed line each: `loading it again (attempt N of 3`). Chrome on Linux watches the machine's network
 * interfaces, and when an address appears or goes (a container started beside the browser: Testcontainers' PostgreSQL
 * in a job whose Chrome runs on the runner itself) it fails every request still waiting for a connection, with
 * `net::ERR_NETWORK_CHANGED` — and a dedicated worker's script with `net::ERR_ABORTED`; requests already sent go on.
 * Chrome has no switch to ignore such changes. So an attempt (the navigation, and the `ready` step the caller gives) is
 * aborted by the environment when a load the page needs (the document, a script or module, a stylesheet, a fetch, a
 * worker's script — not an image, a font or the favicon) failed with {@link ENVIRONMENTAL_LOAD_ERRORS}, or when the
 * machine's interfaces ({@link networkState}) changed while it ran and the script of a worker the page created failed
 * with `net::ERR_ABORTED`.
 *
 * The rule: the `ready` step always runs, and a step that fails or succeeds is never loaded again. Once the attempt is
 * seen aborted, the step has {@link READY_SETTLE_MS} (fifteen seconds) more to end:
 * - it fails — it throws, or it sees the page report a failure (a boot that ended "failed"), whatever made it fail: the
 *   attempt's own failure; the step's error is thrown, the attempt's records kept, with one printed line
 *   (`not loaded again`);
 * - it succeeds: the attempt stands, as it is;
 * - it has not ended (its page has not yet got what it waits for): it is late. It goes on as it is (its DevTools
 *   commands still reach the page, so it still sees a boot that ends now) until the decision below.
 * An aborted attempt whose step did not end in time, or that has no step, fails at once if it recorded a failure the
 * aborted loads do not explain: an exception, or an error-level console call or log entry (a CSP violation's report
 * among them), that names none of them; an error event of a worker whose script was not one of them; a load that failed
 * with another error (`net::ERR_ABORTED`, a load cancelled, aside); the load itself never ending (its load event never
 * came), unless the document was what the network aborted. Such an attempt fails like a failed step. Otherwise it is
 * decided once the machine's interfaces have stayed the same for three seconds (at most ten; Chrome passes a change on
 * more than once: a second notice about two seconds after the first fails the requests waiting then too), or as soon as
 * its late step fails or succeeds. Then the late step's abort signal is set: every DevTools command it sends from then
 * on fails with {@link StepAbandonedError}, the driver's own error, and it has at most ten seconds more to stop. The
 * decision, on all that happened until then:
 * - the late step failed with anything but that error (it saw the page report a failure, or a command it sent before
 *   answered with one): a failed step — its error thrown, not loaded again;
 * - the late step succeeded: the page booted, and the attempt stands, as when the step ends in time;
 * - the attempt recorded a failure the aborted loads do not explain (above): it fails like a failed step;
 * - otherwise (the step stopped at its signal, it is still running, or there is no step) the page is loaded again.
 * Each attempt runs in the same browser profile (its storage stays), so a failure only a first boot would show is not
 * repeated by the next attempt: it must be caught in the attempt it happened in.
 * An attempt aborted {@link LOAD_ATTEMPTS} times fails, once decided so; anything with no abort (a failed step, another
 * load error, a load answered with an error status) fails as it fails. What an attempt loaded again recorded (its
 * requests, console, log entries, exceptions, worker errors and workers) is dropped from the page's lists, its reason
 * and its failures kept in {@link Page.loadRetries} and shown by {@link Page.diagnostics}, and the retry's printed line
 * counts them and shows the first. A step that runs after the page is ready (not in `goto`) is not covered.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { beforeEach, onTestFailed } from "vitest";

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

/** The abort signals of the `ready` steps the current code runs in (see {@link Page.goto}): a DevTools command sent from
 *  a step whose load attempt was abandoned fails, so the step stops at its next command. */
const STEPS = new AsyncLocalStorage<readonly AbortSignal[]>();

/** The error a DevTools command of an abandoned step fails with: the driver's own, never the page's. */
export class StepAbandonedError extends Error {
  constructor(method: string) {
    super(`${method}: not sent: the load attempt this step ran in was abandoned (the network aborted it)`);
    this.name = "StepAbandonedError";
  }
}

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
    if (STEPS.getStore()?.some((s) => s.aborted) === true)
      return Promise.reject(new StepAbandonedError(method));
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
  /** Load errors taken for the machine network's (default {@link ENVIRONMENTAL_LOAD_ERRORS}). */
  environmentalErrors?: readonly string[];
  /** The machine's network state, compared during each load attempt (default {@link networkState}). */
  networkState?: () => string;
  /** How long a `ready` step may still take once its attempt is seen aborted (default {@link READY_SETTLE_MS}). */
  readySettleMs?: number;
}

/** The load error Chrome gives the requests it fails when the machine's network changes. */
export const ENVIRONMENTAL_LOAD_ERRORS: readonly string[] = ["net::ERR_NETWORK_CHANGED"];
/** The loads a page needs (DevTools resource types): an environmental error on one of them aborts a load attempt; on
 *  any other (an image, a font, the favicon) it does not. */
const NEEDED_LOADS: ReadonlySet<string> = new Set(["Document", "Script", "Stylesheet", "Fetch", "XHR"]);
/** The load error Chrome gives a dedicated worker's script it fails when the machine's network changes, and a load it
 *  cancels (for example the rest of a module graph whose import failed). */
const WORKER_SCRIPT_ABORT = "net::ERR_ABORTED";
/** How many times {@link Page.goto} loads a page whose loads the machine's network aborted. */
export const LOAD_ATTEMPTS = 3;
/** Before loading an aborted page again, the machine's network state must have stayed the same this long (Chrome tells
 *  its network stack of a change again about two seconds after the first notice, failing waiting requests again) … */
const NETWORK_SETTLE_MS = 3_000;
/** … waited for at most this long. */
const NETWORK_SETTLE_MAX_MS = 10_000;
/** How long a load attempt that is made again waits for its abandoned step to stop. */
const ABANDONED_STEP_MS = 10_000;
/** How long a `ready` step may still take, once its load attempt is seen aborted, to end — succeed or fail — before it
 *  is taken for one the abort stopped (shorter than the steps' own waits, 30 s and more). */
export const READY_SETTLE_MS = 15_000;

/** The machine's network interfaces and their addresses, as one string: what Chrome watches on Linux. */
export function networkState(): string {
  const all = networkInterfaces();
  return Object.keys(all).sort().map((name) => `${name}=${(all[name] ?? []).map((a) => a.address).sort().join(",")}`).join(";");
}

const VIOLATIONS = "__cspViolations = []; addEventListener('securitypolicyviolation', function (e) { __cspViolations.push(e.violatedDirective + ' ' + e.blockedURI); });";

/** The DevTools binding a page reports its workers' `error` events through. */
const WORKER_ERROR_BINDING = "__umbradbWorkerError";
/** Evaluated in every document before its scripts: each `Worker` the page creates reports its `error` events. */
const WORKER_ERRORS = `(function () {
  var W = window.Worker;
  if (typeof W !== "function") return;
  window.Worker = new Proxy(W, { construct: function (target, args, newTarget) {
    var worker = Reflect.construct(target, args, newTarget);
    worker.addEventListener("error", function (e) {
      try {
        window.${WORKER_ERROR_BINDING}(JSON.stringify({ message: String(e.message || ""), file: String(e.filename || ""), line: e.lineno || 0, column: e.colno || 0, worker: String(args[0]) }));
      } catch (x) { /* no binding */ }
    });
    return worker;
  } });
})();`;

/** A dedicated worker's `error` event, as the page saw it. */
export interface WorkerErrorRecord { message: string; file: string; line: number; column: number; worker: string }

/** How many of the latest entries of each list {@link Page.diagnostics} prints, and how long each line may be. */
const DIAGNOSTIC_LINES = 30;
const DIAGNOSTIC_CHARS = 400;

/** Pages opened by this test file, the newest last (for the failure report). */
const pagesOfFile: Page[] = [];

/** What `pages` recorded, for a failed test. */
export function failureReport(pages: readonly Page[]): string {
  return pages.map((p) => p.diagnostics()).join("\n");
}

// A failing test prints what the pages opened during it, and the pages still open, recorded.
try {
  beforeEach(() => {
    const from = pagesOfFile.length;
    onTestFailed(() => {
      const pages = pagesOfFile.filter((p, i) => i >= from || !p.ended).slice(-6);
      if (pages.length > 0) console.error(`browser pages of the failed test:\n${failureReport(pages)}`);
    });
  });
} catch {
  // not imported while a test file is collected
}

export class Page {
  readonly requests: RequestRecord[] = [];
  readonly console: Array<{ type: string; text: string; target?: "worker" }> = [];
  readonly logs: Array<{ source: string; level: string; text: string; url?: string; target?: "worker" }> = [];
  readonly exceptions: string[] = [];
  /** The dedicated workers this page started, once {@link trackWorkers} has been called (or with `{ workers: true }`). */
  readonly workers: WorkerRecord[] = [];
  /** The DevTools sessions of the page's dedicated workers, oldest first (with `{ workers: true }`). */
  readonly workerSessions: string[] = [];
  /** Each worker session's setup (its domains enabled, its scripts evaluated), settled once done or the worker ended. */
  private readonly workerSetups = new Map<string, Promise<void>>();
  private readonly byId = new Map<string, RequestRecord>();
  /** The page's session and, with `{ workers: true }`, its workers' sessions: whatever they report is recorded. */
  private readonly sessions = new Set<string>();
  private loads = 0;
  private trackingWorkers = false;
  /** The `error` events of the dedicated workers the page created. */
  readonly workerErrors: WorkerErrorRecord[] = [];
  /** DevTools reported that the tab's renderer process crashed. */
  crashed = false;
  /** The tab was closed or crashed, or its browser closed. */
  ended = false;
  /** The URL last loaded with {@link goto}. */
  url = "about:blank";
  /** Each load attempt {@link goto} made again: why, and what it recorded that the page's lists dropped (its exceptions,
   *  worker errors, console errors and warnings, and log entries of those levels). */
  readonly loadRetries: Array<{ url: string; reason: string; dropped: string[] }> = [];
  /** Called after each event that can show a load attempt aborted (a failed load, an exception, a worker's error). */
  private recorded: (() => void) | undefined;
  private environmentalErrors: readonly string[] = ENVIRONMENTAL_LOAD_ERRORS;
  private networkStateOf: () => string = networkState;
  private readySettleMs = READY_SETTLE_MS;
  /** The navigation's own error (`Page.navigate`'s `errorText`) in the current load attempt. */
  private navigationError: string | undefined;

  private constructor(private readonly conn: Connection, readonly sessionId: string, readonly targetId: string) {
    this.sessions.add(sessionId);
  }

  static async open(conn: Connection, opts: PageOptions = {}): Promise<Page> {
    const { targetId } = await conn.send("Target.createTarget", { url: "about:blank", ...(opts.newWindow === true ? { newWindow: true } : {}) });
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(conn, sessionId, targetId);
    if (opts.environmentalErrors !== undefined) page.environmentalErrors = opts.environmentalErrors;
    if (opts.networkState !== undefined) page.networkStateOf = opts.networkState;
    if (opts.readySettleMs !== undefined) page.readySettleMs = opts.readySettleMs;
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
      page.recorded?.();
    }));
    conn.on("Runtime.consoleAPICalled", mine((p, w) => page.console.push({ type: p.type, text: (p.args ?? []).map((a: Json) => a.value ?? a.description ?? "").join(" "), ...tag(w) })));
    conn.on("Runtime.exceptionThrown", mine((p) => {
      page.exceptions.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "exception");
      page.recorded?.();
    }));
    conn.on("Log.entryAdded", mine((p, w) => page.logs.push({ source: p.entry.source, level: p.entry.level, text: p.entry.text, url: p.entry.url, ...tag(w) })));
    conn.on("Page.loadEventFired", mine(() => { page.loads++; }));
    conn.on("Inspector.targetCrashed", (_p, s) => { if (s === sessionId) page.crashed = page.ended = true; });
    conn.on("Runtime.bindingCalled", (p, s) => {
      if (s !== sessionId || p.name !== WORKER_ERROR_BINDING) return;
      let e: WorkerErrorRecord;
      try {
        e = JSON.parse(p.payload as string) as WorkerErrorRecord;
      } catch {
        return;
      }
      page.workerErrors.push(e);
      if (page.workerErrors.length <= 5) console.error(`browser page ${page.targetId.slice(0, 8)} (${page.url}): worker error: ${errorLine(e)}`);
      page.recorded?.();
    });
    pagesOfFile.push(page);
    if (opts.workers === true) await page.attachWorkers(true, opts.workerScript);
    for (const d of ["Page", "Runtime", "Network", "Log", "Inspector"]) await conn.send(`${d}.enable`, {}, sessionId);
    await conn.send("Runtime.addBinding", { name: WORKER_ERROR_BINDING }, sessionId);
    await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: WORKER_ERRORS }, sessionId);
    await conn.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__cspViolations = []; document.addEventListener('securitypolicyviolation', function (e) { window.__cspViolations.push(e.violatedDirective + ' ' + e.blockedURI); });",
    }, sessionId);
    await conn.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    return page;
  }

  /**
   * Loads a URL, waits for its load event, then runs `ready` (the page's own readiness: its engine booted, a view
   * drawn); an attempt the machine's network aborted is made again only when `ready` neither failed nor succeeded by
   * the decision, after the network settled (see the module documentation), at most {@link LOAD_ATTEMPTS} times.
   * `ready` gets the attempt's abort signal: it is set at that decision, and every DevTools command the step sends from
   * then on fails with {@link StepAbandonedError}.
   */
  async goto(url: string, timeoutMs = 30_000, ready?: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const marks = {
        requests: this.requests.length, console: this.console.length, logs: this.logs.length, exceptions: this.exceptions.length,
        workerErrors: this.workerErrors.length, workers: this.workers.length,
      };
      const network = this.watchNetwork();
      let failure: { error: unknown; step: boolean } | undefined;
      try {
        await this.load(url, timeoutMs);
      } catch (error) {
        failure = { error, step: false };
      }
      // The step always runs. Once the attempt is seen aborted it has readySettleMs more to end; if it has not, it is
      // late: it goes on as it is, still watching the page, and how it ends counts until the decision below.
      const stepper = new AbortController();
      let step: Promise<unknown> | undefined;
      let stuck = false;
      if (failure === undefined && ready !== undefined) {
        step = STEPS.run([...(STEPS.getStore() ?? []), stepper.signal], () => ready(stepper.signal));
        const ended = await this.settled(step, marks, network);
        if (ended.kind === "failed") failure = { error: ended.error, step: true };
        stuck = ended.kind === "stuck";
      }
      network.stop();
      const reason = this.abortedBy(marks, network.changed());
      if (reason === undefined || (step !== undefined && !stuck && failure === undefined)) {
        // Not aborted, or aborted but the step succeeded: the attempt stands, as it is.
        if (failure !== undefined) throw failure.error;
        return;
      }
      // How the late step ended: it succeeded, it failed, or it stopped at its signal (the driver's own error).
      const late: { end?: { kind: "done" } | { kind: "failed"; error: unknown } | { kind: "abandoned" } } = {};
      const stepEnded = step === undefined || !stuck ? Promise.resolve() : step.then(
        () => { late.end = { kind: "done" }; },
        (error: unknown) => { late.end = error instanceof StepAbandonedError ? { kind: "abandoned" } : { kind: "failed", error }; },
      );
      const last = failure === undefined ? "" : `; the last attempt's error: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`;
      // A failure of the page's own is kept: the step failed (whatever made it fail: it ended), or the attempt recorded
      // what the aborted loads do not explain.
      const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
      const documentAborted = this.navigationError !== undefined && this.environmentalErrors.some((e) => this.navigationError!.includes(e));
      const own = (): string[] => [
        ...(failure?.step === true ? [`the step failed: ${message(failure.error)}`] : []),
        ...(late.end?.kind === "failed" ? [`the step failed late: ${message(late.end.error)}`] : []),
        // The load itself failed (its load event never came): the page's own, unless its document was aborted.
        ...(failure?.step === false && !documentAborted ? [`the load failed: ${message(failure.error)}`] : []),
        ...this.unexplained(marks),
      ];
      const notAgain = (found: string[]): Error => {
        console.error(`browser page ${this.targetId.slice(0, 8)} (${url}): ${reason}, but the attempt also failed on its own (${found.length}: ${found[0]}): not loaded again`);
        if (failure?.step === true) return failure.error as Error;
        if (late.end?.kind === "failed") return late.end.error as Error;
        return new Error(`${url}: the page failed on its own while ${reason}: ${found.join("; ")}; not loaded again`);
      };
      if (own().length > 0) {
        stepper.abort();
        throw notAgain(own());
      }
      // The decision waits until the machine's network has settled (a change comes as several events: an interface, then
      // its addresses), or until the late step has failed or succeeded. Then the late step's signal is set (its DevTools
      // commands fail from then on, so it stops before any next attempt; one already sent can still answer) and it has a
      // bound to stop. A failure that is not the driver's own is the page's; a success means the page booted.
      const settledMs = await this.networkSettled(() => late.end !== undefined && late.end.kind !== "abandoned");
      stepper.abort();
      await Promise.race([stepEnded, sleep(ABANDONED_STEP_MS)]);
      // The late step succeeded: the attempt stands, as when the step ends in time.
      if (late.end?.kind === "done") return;
      // What arrived meanwhile counts too: the late step's failure, and what the attempt recorded.
      if (own().length > 0) throw notAgain(own());
      if (attempt >= LOAD_ATTEMPTS) throw new Error(`${url}: ${reason}, in each of ${attempt} attempts${last}`);
      const dropped = this.droppedSince(marks);
      this.loadRetries.push({ url, reason, dropped });
      const records = dropped.length === 0 ? "" : `; the aborted attempt's records (kept in the page's report): ${dropped.length}, the first: ${dropped[0]!.slice(0, 200)}`;
      console.error(`browser page ${this.targetId.slice(0, 8)} (${url}): ${reason}: loading it again (attempt ${attempt + 1} of ${LOAD_ATTEMPTS}, the network settled for ${settledMs} ms)${records}`);
      // What the aborted attempt recorded is the environment's, not the page's (its failures stay in loadRetries).
      this.requests.length = marks.requests;
      this.console.length = marks.console;
      this.logs.length = marks.logs;
      this.exceptions.length = marks.exceptions;
      this.workerErrors.length = marks.workerErrors;
      this.workers.length = marks.workers;
    }
  }

  /** Navigates to `url` and waits for its load event. */
  private async load(url: string, timeoutMs: number): Promise<void> {
    this.url = url;
    this.navigationError = undefined;
    const before = this.loads;
    const r = (await this.conn.send("Page.navigate", { url }, this.sessionId)) as { errorText?: string };
    if (r.errorText !== undefined && r.errorText !== "") this.navigationError = r.errorText;
    const end = Date.now() + timeoutMs;
    while (this.loads === before) {
      if (Date.now() > end) throw new Error(`load of ${url} timed out`);
      await sleep(50);
    }
  }

  /** Waits until the machine's network state has not changed for {@link NETWORK_SETTLE_MS}, at most
   *  {@link NETWORK_SETTLE_MAX_MS}, or until `ended()` (read every 100 ms) is true; how long it waited. */
  private async networkSettled(ended: () => boolean = () => false): Promise<number> {
    const start = Date.now();
    let state = this.networkStateOf();
    let since = start;
    while (!ended() && Date.now() - since < NETWORK_SETTLE_MS && Date.now() - start < NETWORK_SETTLE_MAX_MS) {
      await sleep(100);
      const now = this.networkStateOf();
      if (now !== state) {
        state = now;
        since = Date.now();
      }
    }
    return Date.now() - start;
  }

  /** Watches the machine's network state from now on: whether it changed (read again when asked). */
  private watchNetwork(): { changed(): boolean; stop(): void } {
    const at = this.networkStateOf();
    let changed = false;
    const timer = setInterval(() => { if (this.networkStateOf() !== at) changed = true; }, 100);
    return {
      changed: () => changed || this.networkStateOf() !== at,
      stop: () => clearInterval(timer),
    };
  }

  /** Why the load attempt that began at `from` (the lengths of the page's lists then) was the environment's, or
   *  `undefined` (see the module documentation). */
  private abortedBy(from: { requests: number; workerErrors: number }, networkChanged: boolean): string | undefined {
    const loads = this.requests.slice(from.requests).filter((r) => r.failed !== undefined).map((r) => ({ url: r.url, error: r.failed!, type: r.type }));
    if (this.navigationError !== undefined) loads.unshift({ url: this.url, error: this.navigationError, type: "Document" });
    const described = (list: Array<{ url: string; error: string }>): string =>
      `${[...new Set(list.map((l) => l.url))].slice(0, 3).join(", ")}${list.length > 3 ? ", …" : ""}`;
    const environmental = loads.filter((l) => NEEDED_LOADS.has(l.type) && this.environmentalErrors.some((e) => l.error.includes(e)));
    if (environmental.length > 0)
      return `${environmental.length} load${environmental.length === 1 ? "" : "s"} failed with ${[...new Set(environmental.map((l) => l.error))].join(", ")} (${described(environmental)})`;
    if (!networkChanged) return undefined;
    const workerScripts = new Set(this.workerErrors.slice(from.workerErrors).map((e) => {
      try {
        return new URL(e.worker, this.url).href;
      } catch {
        return e.worker;
      }
    }));
    const aborted = loads.filter((l) => l.error.includes(WORKER_SCRIPT_ABORT) && workerScripts.has(l.url));
    if (aborted.length > 0)
      return `the machine's network interfaces changed while it loaded and ${aborted.length} worker script${aborted.length === 1 ? "" : "s"} failed with ${WORKER_SCRIPT_ABORT} (${described(aborted)})`;
    return undefined;
  }

  /** Failures the attempt that began at `from` recorded that its failed loads do not explain (see the module
   *  documentation), each as a line. */
  private unexplained(from: { requests: number; console: number; logs: number; exceptions: number; workerErrors: number }): string[] {
    const failed = this.requests.slice(from.requests).filter((r) => r.failed !== undefined);
    const urls = failed.map((r) => r.url);
    if (this.navigationError !== undefined) urls.push(this.url);
    const absolute = (u: string): string => {
      try {
        return new URL(u, this.url).href;
      } catch {
        return u;
      }
    };
    const environmental = (error: string): boolean => error.includes(WORKER_SCRIPT_ABORT) || this.environmentalErrors.some((e) => error.includes(e));
    return [
      ...failed.filter((r) => !environmental(r.failed!)).map((r) => `a load failed with ${r.failed}: ${r.url}`),
      ...this.exceptions.slice(from.exceptions).filter((e) => !urls.some((u) => e.includes(u))).map((e) => `exception: ${e.split("\n")[0]}`),
      ...this.workerErrors.slice(from.workerErrors).filter((e) => !urls.includes(absolute(e.worker))).map((e) => `worker error: ${errorLine(e)}`),
      // Error-level console calls and log entries (a CSP violation's report among them), but those that name a failed
      // load (the browser's own "Failed to load resource" for it).
      ...this.console.slice(from.console).filter((c) => (c.type === "error" || c.type === "assert") && !urls.some((u) => c.text.includes(u)))
        .map((c) => `${c.target === "worker" ? "[worker] " : ""}console ${c.type}: ${c.text}`),
      ...this.logs.slice(from.logs).filter((l) => l.level === "error" && !urls.some((u) => l.url === u || l.text.includes(u)))
        .map((l) => `${l.target === "worker" ? "[worker] " : ""}log error: ${l.text}${l.url === undefined || l.url === "" ? "" : ` (${l.url})`}`),
    ];
  }

  /** What the attempt that began at `from` recorded that dropping it would hide, each as a line. */
  private droppedSince(from: { console: number; logs: number; exceptions: number; workerErrors: number }): string[] {
    const where = (target?: "worker"): string => (target === "worker" ? "[worker] " : "");
    return [
      ...this.exceptions.slice(from.exceptions).map((e) => `exception: ${e.split("\n")[0]}`),
      ...this.workerErrors.slice(from.workerErrors).map((e) => `worker error: ${errorLine(e)}`),
      ...this.console.slice(from.console).filter((c) => c.type === "error" || c.type === "warning" || c.type === "assert").map((c) => `${where(c.target)}console ${c.type}: ${c.text}`),
      ...this.logs.slice(from.logs).filter((l) => l.level === "error" || l.level === "warning").map((l) => `${where(l.target)}log ${l.level}: ${l.text}${l.url === undefined || l.url === "" ? "" : ` (${l.url})`}`),
    ];
  }

  /** How `step` ended: it succeeded, it failed, or — the attempt seen aborted (checked at each event that can show it,
   *  and every 100 ms) — it had not ended {@link readySettleMs} later (`step` then runs on: {@link goto} keeps its
   *  outcome until its decision). */
  private settled(step: Promise<unknown>, from: { requests: number; workerErrors: number }, network: { changed(): boolean }): Promise<{ kind: "done" } | { kind: "failed"; error: unknown } | { kind: "stuck" }> {
    step.catch(() => { /* awaited below, or abandoned */ });
    type Ended = { kind: "done" } | { kind: "failed"; error: unknown } | { kind: "stuck" };
    return new Promise<Ended>((resolve) => {
      let over = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (ended: Ended): void => {
        if (over) return;
        over = true;
        clearInterval(timer);
        clearTimeout(deadline);
        this.recorded = undefined;
        resolve(ended);
      };
      const check = (): void => {
        if (deadline === undefined && this.abortedBy(from, network.changed()) !== undefined)
          deadline = setTimeout(() => finish({ kind: "stuck" }), this.readySettleMs);
      };
      // A change of the interfaces alone comes with no event: read it again every 100 ms.
      const timer = setInterval(check, 100);
      this.recorded = check;
      step.then(() => finish({ kind: "done" }), (error: unknown) => finish({ kind: "failed", error }));
      check();
    });
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
    // Not before the worker's own setup (the CSP listener among it) has been sent and answered.
    await this.workerSetups.get(session);
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

  /** Calls `listener` with each DevTools event `method` of this page's session (its own target, not its workers'). */
  onEvent(method: string, listener: (params: Json) => void): void {
    this.conn.on(method, (p, s) => { if (s === this.sessionId) listener(p); });
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
      if (worker) {
        this.sessions.add(child);
        this.workerSessions.push(child);
      }
      const setup = (async () => {
        if (worker) {
          for (const d of ["Runtime", "Network", "Log"]) await this.conn.send(`${d}.enable`, {}, child);
          if (workerScript !== undefined) await this.beforeWorkerScript(child, workerScript);
        }
        await this.conn.send("Runtime.runIfWaitingForDebugger", {}, child);
        if (worker) await this.conn.send("Runtime.evaluate", { expression: VIOLATIONS }, child);
      })().catch(() => { /* the target closed */ });
      if (worker) this.workerSetups.set(child, setup);
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
   * script runs. A worker's global scope gets its secure-context interfaces (OPFS sync access handles, writable file
   * streams, …) only once its own script has arrived, and an evaluation sent to the worker before that (the
   * `securitypolicyviolation` listener above, sent as the worker is let go) runs without them. So the debugger pauses
   * before each script runs; a pause in a script without a URL (such an evaluation) is let go, and at the first pause in
   * a script of the worker's own (it has a URL) `script` is evaluated, then the worker goes on (the debugger is then
   * turned off).
   */
  private async beforeWorkerScript(session: string, script: string): Promise<void> {
    await this.conn.send("Debugger.enable", {}, session);
    const { breakpointId } = await this.conn.send("Debugger.setInstrumentationBreakpoint", { instrumentation: "beforeScriptExecution" }, session);
    let done = false;
    this.conn.on("Debugger.paused", (p, s) => {
      if (s !== session || done) return;
      const url = (p as { data?: { url?: unknown } }).data?.url;
      if (typeof url !== "string" || url === "") {
        void this.conn.send("Debugger.resume", {}, session).catch(() => { /* the worker ended */ });
        return;
      }
      done = true;
      void (async () => {
        const r = await this.conn.send("Runtime.evaluate", { expression: script }, session);
        if (r.exceptionDetails !== undefined) this.exceptions.push(`worker script: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
        await this.conn.send("Debugger.removeBreakpoint", { breakpointId }, session);
        await this.conn.send("Debugger.resume", {}, session);
        await this.conn.send("Debugger.disable", {}, session);
      })().catch(() => { /* the worker ended */ });
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
    this.ended = true;
    await this.conn.send("Target.closeTarget", { targetId: this.targetId });
  }

  /**
   * What the page recorded, to explain a failure: its workers' `error` events (message, file, line, column), its
   * uncaught exceptions, its console calls and log entries (its workers' too, when recorded), and its workers — the
   * last {@link DIAGNOSTIC_LINES} of each list, each line cut at {@link DIAGNOSTIC_CHARS} characters.
   */
  diagnostics(): string {
    const cut = (t: string): string => (t.length > DIAGNOSTIC_CHARS ? `${t.slice(0, DIAGNOSTIC_CHARS)}… (${t.length} characters)` : t);
    const section = (title: string, lines: readonly string[]): string[] => {
      if (lines.length === 0) return [`  ${title}: none`];
      const shown = lines.slice(-DIAGNOSTIC_LINES);
      return [`  ${title} (${lines.length}${shown.length < lines.length ? `, the last ${shown.length}` : ""}):`, ...shown.map((l) => `    ${cut(l)}`)];
    };
    const where = (target?: "worker"): string => (target === "worker" ? "[worker] " : "");
    return [
      `page ${this.targetId.slice(0, 8)} at ${this.url}${this.crashed ? " (crashed)" : this.ended ? " (closed)" : ""}`,
      ...(this.loadRetries.length === 0 ? [] : [
        `  loaded again (${this.loadRetries.length}):`,
        ...this.loadRetries.flatMap((r) => [
          `    ${cut(`${r.url}: ${r.reason}`)}`,
          ...r.dropped.slice(-DIAGNOSTIC_LINES).map((d) => `      dropped: ${cut(d)}`),
        ]),
      ]),
      ...section("worker errors", this.workerErrors.map(errorLine)),
      ...section("exceptions", this.exceptions),
      ...section("console", this.console.map((c) => `${where(c.target)}${c.type}: ${c.text}`)),
      ...section("log entries", this.logs.map((l) => `${where(l.target)}${l.level} ${l.source}: ${l.text}${l.url === undefined || l.url === "" ? "" : ` (${l.url})`}`)),
      ...section("workers", this.workers.map((w) => `${w.url} ${w.running ? "running" : "ended"}`)),
    ].join("\n");
  }

  /** A PNG of the whole page. */
  async screenshot(): Promise<Buffer> {
    const r = await this.conn.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, this.sessionId);
    return Buffer.from(r.data as string, "base64");
  }
}

/** One worker error as a line: its message and where it was raised. */
function errorLine(e: WorkerErrorRecord): string {
  return `${e.message === "" ? "(no message: the script did not load or did not start)" : e.message} at ${e.file === "" ? e.worker : e.file}:${e.line}:${e.column}`;
}

export class Browser {
  private readonly pages: Page[] = [];
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

  async newPage(opts?: PageOptions): Promise<Page> {
    const page = await Page.open(this.conn, opts);
    this.pages.push(page);
    return page;
  }

  async close(): Promise<void> {
    for (const p of this.pages) p.ended = true;
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
