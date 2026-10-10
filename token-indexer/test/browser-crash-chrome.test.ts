/**
 * The browser engine killed at exact points, in Chrome on OPFS: the static build (no automatic start, never the
 * network) served from 127.0.0.1, the recorded IDX range (714485–715183) replayed in the worker, and a tap in the worker
 * (`helpers/crash-tap.ts`) that holds the worker's thread at the chosen point, where the test kills it: the page's
 * `Worker.terminate()`, or a crash of the tab's renderer process (`Page.crash`), which ends the page and its worker
 * with no clean-up at all.
 *
 * - `[[browser.crash.kills]]` — `UMBRADB_CRASH_RUNS` kills (default 10; `npm run test:crash` runs 100), each followed by
 *   a new tab on the same profile, at points spread over: the first boot creating the store (PGlite's initdb) and its
 *   migrations; a statement inside a sync block's transaction and inside a scan block's transaction; a file write
 *   while either's `COMMIT` runs; the start of a transaction (none open); any file write; and a random time. Every
 *   planned point must actually be reached: one the worker does not reach (the range ended first, or the boot ended)
 *   is killed anyway and checked, then tried again on a fresh range, and the campaign fails when it is still not reached
 *   after three attempts, with what the worker did instead (the tap's counts, the boot, the watchdog's restarts). Kill
 *   modes alternate, so with two rounds of points (18 runs or more) every point is reached by both, and the campaign
 *   checks it; with fewer, both modes must have run at their points. After each kill the new worker's boot must end
 *   `ready` and the store must hold exactly the blocks of its cursors: every one of the 37 tables, and the NULL
 *   `bytea[]` elements beside them, equals the uninterrupted replay's after the archive's cursor (chain archive tables)
 *   or after the scan's cursor (`mip0018` tables), computed in Node afterwards (`helpers/crash-reference.ts`); the
 *   cursors never go below what a status read saw before the kill. Before a store is replaced by a new one (each round
 *   of points starts with the boot points) and after the last kill, its range is finished and must have the recorded
 *   live digests (archive `cb0d5e21…`, all tables `af6583d0…c832c`) and no NULL `bytea[]` element.
 *   The seed is printed before the first run and is in every failure message: `UMBRADB_CRASH_SEED` (with the same
 *   `UMBRADB_CRASH_RUNS`) repeats a campaign; `UMBRADB_CRASH_REPORT=<file>` writes every run as JSON (never committed).
 * - `[[browser.crash.import-swap]]` — kills during a snapshot import: in its trial (the rows loaded into a store in
 *   memory) and before the journal is complete (the store stays as it was); then while the store is marked as being
 *   created, while PGlite creates it and the rows load into it, while its identity and while the configuration that
 *   continues the import are saved (the next boot finishes the import from the journal): each reopened store is one of
 *   the two, whole, with its digests, and after a finished import the continuing configuration is saved.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 */
import { rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DigestResult, HostStatus } from "../browser/protocol.ts";
import { Browser, findBrowser, type Page } from "./helpers/cdp-browser.ts";
import { type ParkedAt, PARKED_MARKER, crashTapScript, type Trigger } from "./helpers/crash-tap.ts";
import { compareNullElements, noNullElements } from "../engine/range-tables.ts";
import { referenceStates, storedHeights, tornTables, withNullElements } from "./helpers/crash-reference.ts";
import { buildEngineSite, engineDriver, NO_AUTO_START, serveEngineSite, type EngineSite } from "./helpers/engine-site.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const IDX = { from: 714485, to: 715183 } as const;
/** The recorded live digests of the IDX range: the archive (7 tables) and every table of both schemas (37). */
const IDX_ARCHIVE = "cb0d5e213730ccffc135984c537b9e31d92c984d2b83f06854971a3a74e5b119";
const IDX_TABLES = "af6583d03da69ffd52a31fd89e663fe7892cf45aaf7234d9fc213c335dbc832c";
/** The range holds no NULL `bytea[]` element (which the 37-table digest counts as empty bytes). */
const IDX_NULLS = noNullElements(["mip0018.mip0018_contract_actions"]);
const CONFIG = { source: { kind: "tape", range: "idx" }, startHeight: IDX.from, endHeight: IDX.to, sync: { idleMs: 200 }, scan: { idleMs: 200 } } as const;
/** The store and the files beside it in the OPFS root. */
const STORE_ENTRIES = ["umbradb-stagenet", "umbradb-stagenet.engine.json", "umbradb-stagenet.store.json", "umbradb-stagenet.import.snapshot.tar"];
/** A first boot writes about 4,000 times to OPFS: about 3,330 while PGlite creates the database, the rest migrating. */
const CREATE_WRITES = 3_300;
const MIGRATE_WRITES = { from: 3_340, to: 4_000 } as const;

const RUNS = Number(process.env.UMBRADB_CRASH_RUNS ?? 10);
/** Attempts at a planned point: one more on a fresh range when it was not reached, then the campaign fails. */
const MAX_ATTEMPTS = 3;
/**
 * How long a run waits for its point at most. The wait follows the worker instead: it ends when the tap holds the
 * worker, or when the boot (boot points) or the range (the others) has ended without reaching the point. A loaded host
 * makes a first boot slow (its last writes, where the migration points are, can come more than a minute after the tab
 * opens), so the wait is not cut by the clock before the boot or the range has had its chance.
 */
const POINT_WAIT_CAP_MS = 600_000;
const SEED = Number(process.env.UMBRADB_CRASH_SEED ?? Math.floor(Math.random() * 2 ** 31));

export const KILL_POINTS = ["boot-create", "boot-migrate", "archive-statement", "archive-commit", "scan-statement", "scan-commit", "between", "write", "blind"] as const;
type KillPoint = (typeof KILL_POINTS)[number];
type KillMode = "terminate" | "renderer";

interface Run {
  run: number;
  /** 1 for the planned kill; 2, 3, … for the same plan again after its point was not reached. */
  attempt: number;
  point: KillPoint;
  mode: KillMode;
  trigger: Trigger | null;
  delayMs: number | null;
  /** Where the tap held the worker (`null`: a random-time kill, or the point was never reached). */
  parked: ParkedAt | null;
  /** The cursors the last status read before the kill saw. */
  seen: { archive: number | null; scan: number | null } | null;
  /** The store after the reopen that followed. */
  after: { archive: number | null; scan: number | null; created: boolean; bootMs: number; cycle: number } | null;
  /** The per-table digests after the reopen, with the NULL `bytea[]` elements (checked against the reference at the end). */
  tables?: Record<string, { rows: number; sha256: string }>;
  /** Why the tap did not hold the worker at the point: what the worker had done instead. */
  missed?: Json;
}

/** A small seeded generator, so a campaign can be repeated (`UMBRADB_CRASH_SEED`). */
function rng(seed: number): (lo: number, hi: number) => number {
  let a = seed >>> 0;
  return (lo, hi) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const x = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return lo + Math.floor(x * (hi - lo + 1));
  };
}

/** The runs of a campaign: the points in turn (both boot points first, on a new store), the two kill modes alternating
 *  so that every point gets both over two rounds, random positions within each point. */
export function planRuns(n: number, seed: number): Run[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i): Run => {
    const point = KILL_POINTS[i % KILL_POINTS.length]!;
    const mode: KillMode = ((i % KILL_POINTS.length) + Math.floor(i / KILL_POINTS.length)) % 2 === 0 ? "terminate" : "renderer";
    const trigger: Trigger | null = (() => {
      switch (point) {
        case "boot-create": return { point: "boot", write: r(1, CREATE_WRITES) };
        case "boot-migrate": return { point: "boot", write: r(MIGRATE_WRITES.from, MIGRATE_WRITES.to) };
        case "archive-statement": return { point, tx: r(1, 40), statement: r(1, 6) };
        case "scan-statement": return { point, tx: r(1, 40), statement: r(1, 4) };
        // A block's COMMIT writes its WAL once (measured: 700 of 702 sync commits, every scan commit).
        case "archive-commit": return { point, tx: r(1, 40), write: 1 };
        case "scan-commit": return { point, tx: r(1, 40), write: 1 };
        case "between": return { point, tx: r(1, 120) };
        case "write": return { point, write: r(1, 1_500) };
        case "blind": return null;
      }
    })();
    return { run: i + 1, attempt: 1, point, mode, trigger, delayMs: point === "blind" ? r(0, 2_500) : null, parked: null, seen: null, after: null };
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const browserExe = findBrowser();

describe("the browser engine killed at exact points (Chrome, OPFS)", () => {
  let dir: string;
  let site: EngineSite;
  let browser: Browser;
  const report: Record<string, Json> = { seed: SEED, runs: RUNS };

  beforeAll(async () => {
    if (browserExe === undefined) throw new Error("no Chromium/Chrome found: set MIP0018_UI_BROWSER or CHROME_BIN (see token-indexer/mip0018/ui/README.md)");
    dir = await buildEngineSite(NO_AUTO_START);
    site = await serveEngineSite(dir);
    browser = await Browser.launch(browserExe);
    report.browser = await browser.version();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    if (process.env.UMBRADB_CRASH_REPORT) writeFileSync(process.env.UMBRADB_CRASH_REPORT, JSON.stringify(report, null, 2));
  });

  /** Removes the store and the files beside it, from a page of the site with no engine (retried while the files are
   *  still held by a worker that is ending). */
  async function removeStore(): Promise<void> {
    const p = await browser.newPage();
    try {
      await p.goto(`${site.origin}/blank`);
      const end = Date.now() + 30_000;
      for (;;) {
        const r = (await p.eval(`(async () => {
          const root = await navigator.storage.getDirectory();
          try {
            for (const n of ${JSON.stringify(STORE_ENTRIES)}) await root.removeEntry(n, { recursive: true }).catch((e) => { if (e.name !== "NotFoundError") throw e; });
            return "ok";
          } catch (e) { return e.name + ": " + e.message; }
        })()`)) as string;
        if (r === "ok") return;
        if (Date.now() > end) throw new Error(`the store could not be removed: ${r}`);
        await sleep(100);
      }
    } finally {
      await p.close();
    }
  }

  /** A new tab of the profile on the engine page, with the tap in its worker (armed from the start for `boot`). */
  async function engineTab(trigger?: Trigger): Promise<Page> {
    const p = await browser.newPage({ workers: true, workerScript: crashTapScript(trigger) });
    void p.goto(`${site.origin}/engine.html`).catch(() => { /* a tab killed while it loads */ });
    await p.waitFor("window.umbradbEngine !== undefined", 30_000, "the engine page");
    return p;
  }

  /** Waits until the tap holds the worker; `null` when it does not within `timeoutMs` (or `done` says to stop). */
  async function parkedIn(p: Page, timeoutMs: number, done: () => Promise<boolean> = async () => false): Promise<ParkedAt | null> {
    const end = Date.now() + timeoutMs;
    for (let i = 0; ; i++) {
      const m = p.console.find((c) => c.text.startsWith(`${PARKED_MARKER} `));
      if (m !== undefined) return JSON.parse(m.text.slice(PARKED_MARKER.length + 1)) as ParkedAt;
      if (Date.now() > end || (i % 25 === 24 && (await done()))) return null;
      await sleep(20);
    }
  }

  async function kill(p: Page, mode: KillMode): Promise<void> {
    if (mode === "terminate") {
      await p.eval("(() => { window.umbradbEngine.worker?.terminate(); return true; })()");
      await p.close();
    } else {
      await p.crash();
      await p.close().catch(() => { /* already gone */ });
    }
  }

  const statusOf = (p: Page): Promise<HostStatus> => engineDriver(p, () => site).status();
  /** Reads the cursors (and whether the engine runs) every 50 ms inside the page (a read never blocks the test when the
   *  worker is held). */
  const watchCursors = (p: Page): Promise<unknown> =>
    p.eval(`(() => { window.__seen = null; window.__running = null; setInterval(() => window.umbradbEngine.client.status().then((s) => { window.__seen = s.cursors; window.__running = s.engine === null ? null : s.engine.running; }, () => {}), 50); return true; })()`);

  it(`[[browser.crash.kills]] ${RUNS} kills of the worker (terminate and renderer crash) at exact points of the first boot, of sync and scan block transactions and their commits, between transactions, at file writes and at random times, each point actually reached: every reopened store is ready and holds exactly the blocks of its cursors in all 37 tables, never fewer than seen before the kill; each finished range and the last one have the recorded live digests`, async () => {
    const runs = planRuns(RUNS, SEED);
    // First, so that a failing campaign can be repeated.
    console.log(`crash campaign: seed ${SEED}, ${RUNS} runs (repeat with UMBRADB_CRASH_SEED=${SEED} UMBRADB_CRASH_RUNS=${RUNS})`);
    const tag = (r: Run): string => `seed ${SEED} run ${r.run}/${RUNS} ${r.point}/${r.mode}${r.attempt > 1 ? ` attempt ${r.attempt}` : ""}`;
    report.plan = runs.map((r) => ({ run: r.run, point: r.point, mode: r.mode, trigger: r.trigger, delayMs: r.delayMs }));
    /** Every kill, the attempts at a point not reached included. */
    const executed: Run[] = [];
    report.executed = executed;
    /** Each finished range's digests (`afterRun` -1: finished before its store was replaced). */
    const finished: Array<{ afterRun: number; archive: string; tables: string }> = [];
    let cycle = 0;
    /** The store holds the whole range: the next run starts on a new store. */
    let complete = false;
    let page: Page | undefined;

    /** Opens the store in a new tab and checks it; returns the tab, ready. */
    async function reopen(previous: Run | null): Promise<Page> {
      const t0 = Date.now();
      const p = await engineTab();
      await p.eval("window.umbradbEngine.client.booted()");
      const s = await statusOf(p);
      const bootMs = Date.now() - t0;
      const what = previous === null ? `seed ${SEED}` : tag(previous);
      expect(s.boot, `${what}: the boot after the kill`).toMatchObject({ phase: "ready", error: null, storeProblem: null });
      const h = storedHeights(s);
      const d = (await engineDriver(p, () => site).engine("c.digest()")) as DigestResult;
      if (previous !== null) {
        previous.after = { ...h, created: s.store!.created, bootMs, cycle };
        previous.tables = withNullElements(d.tables.tables, d.nullElements);
        expect(h.archive ?? -1, `${what}: the archive kept every block seen committed`).toBeGreaterThanOrEqual(previous.seen?.archive ?? -1);
        expect(h.scan ?? -1, `${what}: the scan kept every block seen committed`).toBeGreaterThanOrEqual(previous.seen?.scan ?? -1);
      }
      complete = h.archive === IDX.to && h.scan === IDX.to;
      if (complete) {
        finished.push({ afterRun: previous?.run ?? 0, archive: d.archive.sha256, tables: d.tables.sha256 });
        expect(d.archive.sha256, `${what}, cycle ${cycle}: the finished archive digest`).toBe(IDX_ARCHIVE);
        expect(d.tables.sha256, `${what}, cycle ${cycle}: the finished 37-table digest`).toBe(IDX_TABLES);
        expect(compareNullElements(d.nullElements, IDX_NULLS), `${what}, cycle ${cycle}: the finished NULL bytea[] elements`).toEqual([]);
      }
      return p;
    }

    /** Finishes the current store's range and checks its digests, then removes the store; the next tab creates a new
     *  one. */
    async function newStore(): Promise<void> {
      if (page !== undefined && !complete) {
        await engineDriver(page, () => site).engine(`c.start(${JSON.stringify(CONFIG)})`);
        await engineDriver(page, () => site).until("the rest of the range", (s) => s.cursors?.sync?.height === IDX.to && s.cursors?.scan?.nextHeight === IDX.to + 1, 300_000);
        const d = (await engineDriver(page, () => site).engine("c.digest()")) as DigestResult;
        finished.push({ afterRun: -1, archive: d.archive.sha256, tables: d.tables.sha256 });
        expect(d.archive.sha256, `seed ${SEED}, cycle ${cycle}: the finished archive digest`).toBe(IDX_ARCHIVE);
        expect(d.tables.sha256, `seed ${SEED}, cycle ${cycle}: the finished 37-table digest`).toBe(IDX_TABLES);
        expect(compareNullElements(d.nullElements, IDX_NULLS), `seed ${SEED}, cycle ${cycle}: the finished NULL bytea[] elements`).toEqual([]);
      }
      await page?.close().catch(() => {});
      page = undefined;
      await removeStore();
      cycle++;
      complete = false;
    }

    /** Whether the worker's boot has ended (a held worker does not answer: not ended). */
    const bootEnded = (p: Page) => async (): Promise<boolean> => {
      const phase = await p.eval(`Promise.race([window.umbradbEngine.client.status().then((s) => s.boot.phase, () => "error"), new Promise((r) => setTimeout(() => r("pending"), 500))])`).catch(() => "pending");
      return phase === "ready" || phase === "failed" || phase === "unsupported";
    };

    /** What the worker did instead of reaching the point: the tap's counts, the boot, the watchdog's restarts, the
     *  tab's role and its workers. */
    async function missedPoint(p: Page): Promise<Json> {
      const tap = await p.evalWorker(`({ writes: self.__crashTap.writes, writesBeforeFirstStatement: self.__crashTap.writesBeforeFirstStatement, statements: self.__crashTap.statements, txCount: self.__crashTap.txCount, armed: self.__crashTap.armed, statement: self.__crashTap.statement && self.__crashTap.statement.slice(0, 120) })`).catch((e: unknown) => String(e));
      const pageSide = await p.eval(`Promise.race([window.umbradbEngine.client.status().then((s) => ({ boot: s.boot, cursors: s.cursors }), (e) => String(e)), new Promise((r) => setTimeout(() => r("no answer"), 1000))]).then((status) => ({ status, restarts: window.umbradbEngine.restarts(), role: window.umbradbEngine.tabs.role() }))`).catch((e: unknown) => String(e));
      return { tap, page: pageSide, workers: p.workers.map((w) => ({ url: w.url.replace(/^.*\//, ""), running: w.running })) };
    }

    try {
      for (const planned of runs) {
        for (let attempt = 1; ; attempt++) {
          const run: Run = { ...planned, attempt, parked: null, seen: null, after: null };
          executed.push(run);
          console.log(`${tag(run)}: ${run.trigger === null ? `random time ${run.delayMs} ms` : JSON.stringify(run.trigger)}`);
          if (run.point === "boot-create" || run.point === "boot-migrate") {
            await newStore();
            page = await engineTab(run.trigger!);
            run.parked = await parkedIn(page, POINT_WAIT_CAP_MS, bootEnded(page));
            run.seen = { archive: null, scan: null };
          } else {
            if (complete) await newStore();
            page ??= await reopen(null);
            await watchCursors(page);
            if (run.trigger !== null) await page.evalWorker(`self.__crashTap.arm(${JSON.stringify(run.trigger)})`);
            // Not awaited: the worker may be held before it answers.
            await page.eval(`(() => { window.__started = window.umbradbEngine.client.start(${JSON.stringify(CONFIG)}).then(() => "ok", (e) => String(e)); return true; })()`);
            const p = page;
            // The range ended, or the engine stopped by itself: the point can no longer come.
            const ended = async (): Promise<boolean> => {
              const [c, running] = (await p.eval("[window.__seen, window.__running]")) as [HostStatus["cursors"], boolean | null];
              return (c?.sync?.height === IDX.to && c?.scan?.nextHeight === IDX.to + 1) || running === false;
            };
            if (run.trigger !== null) run.parked = await parkedIn(page, POINT_WAIT_CAP_MS, ended);
            else await sleep(run.delayMs!);
            run.seen = storedHeights({ cursors: (await page.eval("window.__seen")) as HostStatus["cursors"] });
          }
          if (run.trigger !== null && run.parked === null) {
            run.missed = await missedPoint(page);
            console.log(`${tag(run)}: the point was not reached: ${JSON.stringify(run.missed)}`);
          }
          await kill(page, run.mode);
          page = await reopen(run);
          console.log(`${tag(run)}: ${run.parked === null ? (run.trigger === null ? "killed at a random time" : "killed without the point") : `${run.parked.point} ${JSON.stringify(run.parked.tx)} w${run.parked.writesInStatement}`} → archive ${run.after!.archive} scan ${run.after!.scan}${run.after!.created ? " (created again)" : ""}`);
          // A point not reached is tried again on a fresh range: a new store for a boot point, the next store (the
          // range ended first) or the same one (it did not) for the others; it must be reached within the attempts.
          if (run.trigger === null || run.parked !== null || attempt >= MAX_ATTEMPTS) break;
        }
      }

      // The last store: finish the range (and read how many file writes the commits made).
      await engineDriver(page!, () => site).engine(`c.start(${JSON.stringify(CONFIG)})`);
      const end = await engineDriver(page!, () => site).until("the rest of the range", (s) => s.cursors?.sync?.height === IDX.to && s.cursors?.scan?.nextHeight === IDX.to + 1, 300_000);
      expect(end.boot.phase).toBe("ready");
      const last = (await engineDriver(page!, () => site).engine("c.digest()")) as DigestResult;
      report.commitWrites = await page!.evalWorker("self.__crashTap.commitWrites");
      finished.push({ afterRun: RUNS, archive: last.archive.sha256, tables: last.tables.sha256 });
      expect(last.archive.sha256, `seed ${SEED}: the last archive digest`).toBe(IDX_ARCHIVE);
      expect(last.tables.sha256, `seed ${SEED}: the last 37-table digest`).toBe(IDX_TABLES);
      expect(compareNullElements(last.nullElements, IDX_NULLS), `seed ${SEED}: the last NULL bytea[] elements`).toEqual([]);
      expect(page!.exceptions).toEqual([]);
    } finally {
      // A failed campaign leaves no tab holding the store (the next test removes it).
      await page?.close().catch(() => {});
      page = undefined;
    }

    // Every reopened store against the uninterrupted replay at its cursors.
    const heights = executed.flatMap((r) => [r.after!.archive, r.after!.scan]);
    const ref = await referenceStates("idx", IDX.from, heights);
    const torn = executed.map((r) => ({ run: r.run, attempt: r.attempt, point: r.point, mode: r.mode, at: r.after, torn: tornTables(ref, r.after!, r.tables!) })).filter((t) => t.torn.length > 0);

    /** A kill at its point: the tap held the worker there (a random-time kill needs no point). */
    const hit = (r: Run): boolean => r.trigger === null || r.parked !== null;
    const byPoint = Object.fromEntries(KILL_POINTS.map((k) => {
      const of = executed.filter((r) => r.point === k);
      const hits = of.filter(hit);
      return [k, { runs: of.filter((r) => r.attempt === 1).length, attempts: of.length, hits: hits.length, terminate: hits.filter((r) => r.mode === "terminate").length, renderer: hits.filter((r) => r.mode === "renderer").length, createdAgain: of.filter((r) => r.after?.created === true && r.point === "boot-create").length }];
    }));
    report.runs = executed.map(({ tables: _t, ...r }) => r);
    delete report.executed;
    report.byPoint = byPoint;
    report.finished = finished;
    report.cycles = cycle;
    report.torn = torn;
    report.referenceMs = Math.round(ref.elapsedMs);
    console.log("crash campaign", JSON.stringify({ seed: SEED, runs: RUNS, kills: executed.length, cycles: cycle, finished: finished.length, byPoint, torn: torn.length, referenceMs: report.referenceMs }));
    expect(torn, `seed ${SEED}: stores whose tables are not exactly the blocks of their cursors`).toEqual([]);
    // Every planned kill reached its point (within its attempts), every point was planned, and both kill modes ran at
    // their points: at every point once each point has been planned twice (two rounds alternate the modes), else overall.
    const missed = runs.filter((p) => !hit(executed.filter((r) => r.run === p.run).at(-1)!)).map((p) => `run ${p.run} ${p.point}/${p.mode}: ${JSON.stringify(executed.filter((r) => r.run === p.run).at(-1)!.missed)}`);
    expect(missed, `seed ${SEED}: planned points never reached in ${MAX_ATTEMPTS} attempts`).toEqual([]);
    for (const k of KILL_POINTS.slice(0, Math.min(RUNS, KILL_POINTS.length))) expect(byPoint[k]!.hits, `seed ${SEED}: ${k} reached`).toBeGreaterThan(0);
    if (RUNS >= 2 * KILL_POINTS.length) {
      for (const k of KILL_POINTS) expect([byPoint[k]!.terminate > 0, byPoint[k]!.renderer > 0], `seed ${SEED}: ${k} reached by both kill modes`).toEqual([true, true]);
    } else {
      const hits = executed.filter(hit);
      expect([hits.some((r) => r.mode === "terminate"), hits.some((r) => r.mode === "renderer")], `seed ${SEED}: both kill modes ran at their points`).toEqual([true, true]);
    }
  }, 600_000 + RUNS * 120_000);

  it("[[browser.crash.import-swap]] kills during a snapshot import leave the store as it was (in the trial, before the journal is complete) or the snapshot's with its continuing configuration (the next boot finishes the import from the journal), whole, with their digests", async () => {
    await removeStore();
    const H1 = IDX.from + 300;
    let page = await engineTab();
    await page.eval("window.umbradbEngine.client.booted()");
    const on = (p: Page) => engineDriver(p, () => site);
    await on(page).engine(`c.start(${JSON.stringify({ ...CONFIG, endHeight: H1 })})`);
    await on(page).until("the snapshot's height", (s) => s.cursors?.sync?.height === H1 && s.cursors?.scan?.nextHeight === H1 + 1);
    await on(page).engine("c.stop()");
    const atH1 = (await on(page).engine("c.digest()")) as DigestResult;
    // The snapshot, kept as a file of the site so that every new tab can fetch it.
    const b64 = (await on(page).engine(`c.export().then(async (r) => { const b = new Uint8Array(await r.file.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); })`)) as string;
    writeFileSync(`${dir}/crash-snapshot.tar`, Buffer.from(b64, "base64"));
    const toEnd = async (p: Page): Promise<DigestResult> => {
      await on(p).engine(`c.start(${JSON.stringify(CONFIG)})`);
      await on(p).until("the end of the range", (s) => s.cursors?.sync?.height === IDX.to && s.cursors?.scan?.nextHeight === IDX.to + 1);
      await on(p).engine("c.stop()");
      return (await on(p).engine("c.digest()")) as DigestResult;
    };
    const atEnd = await toEnd(page);
    expect(atEnd.archive.sha256).toBe(IDX_ARCHIVE);
    expect(atEnd.tables.sha256).toBe(IDX_TABLES);
    const importIn = (p: Page): Promise<unknown> =>
      p.eval(`(() => { window.__imported = fetch("./crash-snapshot.tar").then((r) => r.blob()).then((b) => window.umbradbEngine.client.import(b)).then(() => "ok", (e) => String(e)); return true; })()`);

    // One import with no kill: how many file writes it makes.
    await page.close();
    page = await engineTab();
    await page.eval("window.umbradbEngine.client.booted()");
    const counts = async () => (await page.evalWorker("({ writes: self.__crashTap.writes, closes: self.__crashTap.closes, tx: self.__crashTap.anyTx })")) as { writes: number; closes: number; tx: number };
    const c0 = await counts();
    await importIn(page);
    expect(await page.eval("window.__imported")).toBe("ok");
    const c1 = await counts();
    const writes = c1.writes - c0.writes;
    // The import's writable streams, in order: the journal, the store marked as being created, its identity, the
    // configuration that continues the import.
    expect(c1.closes - c0.closes).toBe(4);
    expect(((await on(page).engine("c.digest()")) as DigestResult).tables.sha256).toBe(atH1.tables.sha256);
    report.importSwap = { writes, transactions: c1.tx - c0.tx, kills: [] as Json[] };
    expect((await toEnd(page)).tables.sha256).toBe(IDX_TABLES);

    const points: Array<{ trigger: Trigger; outcome: "as it was" | "snapshot" }> = [
      // The trial: the first transaction after the request (the migrations of the store in memory).
      { trigger: { point: "between", tx: 1 }, outcome: "as it was" },
      { trigger: { point: "file-close", write: 1 }, outcome: "as it was" },
      { trigger: { point: "file-close", write: 2 }, outcome: "snapshot" },
      { trigger: { point: "write", write: 1 }, outcome: "snapshot" },
      { trigger: { point: "write", write: Math.max(1, Math.floor(writes / 3)) }, outcome: "snapshot" },
      { trigger: { point: "write", write: Math.max(1, Math.floor((2 * writes) / 3)) }, outcome: "snapshot" },
      // Near the end of the load (an import's count varies by a few writes).
      { trigger: { point: "write", write: Math.max(1, writes - 100) }, outcome: "snapshot" },
      { trigger: { point: "file-close", write: 3 }, outcome: "snapshot" },
      { trigger: { point: "file-close", write: 4 }, outcome: "snapshot" },
    ];
    for (const [i, { trigger, outcome: expected }] of points.entries()) {
      const mode: KillMode = i % 2 === 0 ? "renderer" : "terminate";
      await page.close();
      page = await engineTab();
      await page.eval("window.umbradbEngine.client.booted()");
      await page.evalWorker(`self.__crashTap.arm(${JSON.stringify(trigger)})`);
      await importIn(page);
      const parked = await parkedIn(page, 60_000);
      expect(parked, `${JSON.stringify(trigger)} reached`).not.toBeNull();
      await kill(page, mode);
      page = await engineTab();
      await page.eval("window.umbradbEngine.client.booted()");
      const s = await on(page).status();
      expect(s.boot, `${JSON.stringify(trigger)}: the boot after the kill`).toMatchObject({ phase: "ready", storeProblem: null });
      const d = (await on(page).engine("c.digest()")) as DigestResult;
      const h = storedHeights(s);
      const outcome = d.tables.sha256 === atH1.tables.sha256 && d.archive.sha256 === atH1.archive.sha256 ? "snapshot" : d.tables.sha256 === IDX_TABLES && d.archive.sha256 === IDX_ARCHIVE ? "as it was" : "neither";
      (report.importSwap.kills as Json[]).push({ trigger, mode, parked: { statement: parked!.statement?.slice(0, 60) ?? null, writes: parked!.writes }, outcome, heights: h, lastImport: s.snapshots.lastImport !== null });
      console.log(`import-swap kill ${JSON.stringify(trigger)} ${mode}: ${outcome} (archive ${h.archive}, scan ${h.scan})`);
      expect(outcome, `${JSON.stringify(trigger)}: the store after the kill`).not.toBe("neither");
      if (expected === "as it was") expect(outcome, `${JSON.stringify(trigger)}: an import whose journal is not complete leaves the store as it was`).toBe("as it was");
      else {
        expect(outcome, `${JSON.stringify(trigger)}: a complete journal is finished at the next boot`).toBe("snapshot");
        expect(s.snapshots.lastImport, "the finished import is reported").not.toBeNull();
        expect(s.settings).toMatchObject({ autoStart: false, config: { startHeight: IDX.from } });
      }
      if (outcome === "snapshot") expect((await toEnd(page)).tables.sha256).toBe(IDX_TABLES);
    }
    expect(page.exceptions).toEqual([]);
    await page.close();
  }, 600_000);
});
