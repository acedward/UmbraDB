/**
 * One engine across tabs in Chrome (`token-indexer/browser/tabs.ts`): the static build served from 127.0.0.1, opened in
 * two or three tabs of one headless Chromium profile (the tabs share OPFS, Web Locks and BroadcastChannel), driven over
 * the DevTools protocol (`helpers/cdp-browser.ts`). Each test starts a new browser profile, so each starts from an empty
 * store. The chain is the recorded U1 range (715402–715433): replayed inside the worker, or answered from the same tape at
 * the page's origin (`/chain/rpc`, `/chain/graphql`), where every request is recorded and heights can be held back.
 *
 * - `[[browser.tabs.one-engine]]` — two tabs: exactly one worker runs (in the leader tab), it alone holds the store's
 *   lock, the follower starts none; the follower starts the engine through the leader; every API answer, the status and
 *   the cursors are identical in both tabs.
 * - `[[browser.tabs.handover]]` — the leader tab is closed while its sync waits for the next height: the follower becomes
 *   leader, boots its own worker on the same store, resumes the same configuration and continues from the stored
 *   cursors: no height up to the cursor is fetched again, every later height is fetched once, and the finished store
 *   answers as an uninterrupted run's.
 * - `[[browser.tabs.in-flight]]` — three tabs; requests sent to a frozen leader are in flight when it is closed: the
 *   reads are answered by the next leader (also for the third tab), the state changes fail with `leader-changed`, and
 *   the next leader resumes the replay in its worker to the end.
 *
 * Needs a browser: `MIP0018_UI_BROWSER` / `CHROME_BIN`, the Playwright image's Chromium, or Chrome on PATH.
 * `UMBRADB_BROWSER_REPORT=<file>` writes the measured handover timings as JSON (never committed).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ArchiveTape, readTape } from "../../chain-archive-sync/archive-tape.js";
import { createTapeReplay, type TapeReplay } from "../../chain-archive-sync/tape-replay.js";
import type { HostStatus, StartConfig } from "../browser/protocol.ts";
import { Browser, findBrowser, type Page } from "./helpers/cdp-browser.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CONFIG = join(ROOT, "token-indexer/browser/vite.config.ts");
const U1 = { from: 715402, to: 715433 } as const;
const STORE = "opfs-ahp://umbradb-stagenet";
const FAST = { sync: { idleMs: 200 }, scan: { idleMs: 200 } };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm", ".data": "application/octet-stream",
  ".gz": "application/gzip", ".json": "application/json", ".css": "text/css",
};

interface ChainRequest { op: string; height: number | null; at: number }

/** The built site plus the chain's endpoints answered from the tape, recording every chain request with its height. */
interface Site {
  server: Server;
  origin: string;
  requests: ChainRequest[];
  /** Holds back every request for a height above `height` until {@link release}. */
  holdAbove(height: number): void;
  release(): void;
  held(): number;
  reset(): void;
}

async function serveSite(dir: string, tape: ArchiveTape): Promise<Site> {
  let chain: TapeReplay = createTapeReplay(tape);
  const heightOfHash = new Map(tape.blocks.map((b) => [b.blockHash.replace(/^0x/, ""), b.height]));
  const requests: ChainRequest[] = [];
  let holdAbove: number | null = null;
  let gate: { promise: Promise<void>; open: () => void } | undefined;
  let held = 0;
  const classify = (path: string, body: string): { op: string; height: number | null } => {
    try {
      const m = JSON.parse(body) as Json;
      if (path === "/rpc") {
        const height = m.method === "chain_getBlockHash" ? Number(m.params?.[0])
          : m.method === "chain_getBlock" ? heightOfHash.get(String(m.params?.[0]).replace(/^0x/, "")) ?? null : null;
        return { op: String(m.method), height };
      }
      const h = m.variables?.height;
      return typeof h === "number" ? { op: "indexer.block", height: h } : { op: "indexer.other", height: null };
    } catch {
      return { op: "invalid", height: null };
    }
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/chain/")) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        void (async () => {
          const path = url.pathname.slice("/chain".length);
          const body = Buffer.concat(chunks).toString("utf8");
          const r = classify(path, body);
          requests.push({ ...r, at: Date.now() });
          if (holdAbove !== null && r.height !== null && r.height > holdAbove && gate !== undefined) {
            held++;
            await gate.promise;
            held--;
          }
          const a = await chain.answer(path, body);
          if (res.destroyed) return;
          res.writeHead(a.status, a.headers);
          res.end(a.body);
        })();
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
    if (ok) break;
    if (attempt > 20) throw new Error("no free port at or above 10000 on 127.0.0.1");
  }
  const address = server.address() as { port: number };
  const release = (): void => {
    holdAbove = null;
    gate?.open();
    gate = undefined;
  };
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    holdAbove(height) {
      release();
      let open!: () => void;
      const promise = new Promise<void>((r) => (open = r));
      gate = { promise, open };
      holdAbove = height;
    },
    release,
    held: () => held,
    reset() {
      release();
      requests.length = 0;
      chain = createTapeReplay(tape);
    },
  };
}

/** Builds with Vite; throws the build's error. */
async function build(outDir: string): Promise<void> {
  const { build: viteBuild } = await import("vite");
  await viteBuild({ logLevel: "silent", configFile: CONFIG, build: { outDir, emptyOutDir: true } });
}

const browserExe = findBrowser();

interface Tab {
  page: Page;
  id: string;
  /** Evaluates `expr` in the page with `e` = `window.umbradbEngine`, `c` = its client and `t` = its tabs. */
  run(expr: string): Promise<Json>;
}

async function waitUntil(what: string, ok: () => Promise<boolean> | boolean, timeoutMs = 120_000, detail?: () => Promise<unknown>): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await ok()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${detail === undefined ? "" : `: ${JSON.stringify(await detail())}`}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("one engine across tabs in Chrome", () => {
  let out: string;
  let site: Site;
  const report: Record<string, Json> = {};
  /** The answers of an uninterrupted run over U1 (the first test), for the handover tests to compare with. */
  let reference: Record<string, Json> | undefined;

  beforeAll(async () => {
    if (browserExe === undefined) throw new Error("no Chromium/Chrome found: set MIP0018_UI_BROWSER or CHROME_BIN (see token-indexer/mip0018/ui/README.md)");
    out = mkdtempSync(join(tmpdir(), "umbradb-tabs-build-"));
    await build(out);
    const tape = await readTape(new Uint8Array(readFileSync(join(ROOT, "token-indexer/browser/tapes/stagenet-715402-715433.tape.json.gz"))), "gzip");
    site = await serveSite(out, tape);
  }, 180_000);

  afterAll(async () => {
    site?.release();
    await new Promise((r) => (site?.server ? site.server.close(r) : r(undefined)));
    if (out !== undefined) rmSync(out, { recursive: true, force: true });
    if (process.env.UMBRADB_BROWSER_REPORT) writeFileSync(process.env.UMBRADB_BROWSER_REPORT, JSON.stringify(report, null, 2));
  });

  async function openTab(browser: Browser): Promise<Tab> {
    const page = await browser.newPage();
    await page.trackWorkers();
    await page.goto(`${site.origin}/engine.html`);
    await page.waitFor("window.umbradbEngine !== undefined", 30_000, "the engine page");
    const run = (expr: string): Promise<Json> =>
      page.eval(`(async () => { const e = window.umbradbEngine; const c = e.client; const t = e.tabs; return ${expr}; })()`);
    await run("t.ready");
    return { page, id: (await run("t.tabId")) as string, run };
  }
  const status = (t: Tab): Promise<HostStatus> => t.run("c.status()");
  const api = async (t: Tab, target: string): Promise<{ status: number; headers: Record<string, string>; body: Json }> => {
    const r = (await t.run(`c.api("GET", ${JSON.stringify(target)})`)) as { status: number; headers: Record<string, string>; body: string };
    return { ...r, body: JSON.parse(r.body) };
  };
  const atEnd = (s: HostStatus): boolean => s.cursors?.sync?.height === U1.to && s.cursors?.scan?.nextHeight === U1.to + 1;

  /** Every API route over the finished U1 store: status, the token list and, for each token and contract, its pages. */
  async function targetsOf(t: Tab): Promise<string[]> {
    const tokens = (await api(t, "/v1/tokens")).body.items as Json[];
    const colors = tokens.map((i) => i.color as string).filter((c) => typeof c === "string");
    const contracts = [...new Set(tokens.map((i) => i.contractAddress as string | null).filter((a): a is string => typeof a === "string"))];
    return [
      "/v1/status", "/v1/tokens", "/v1/tokens?limit=1", "/v1/tokens/zz", "/v1/nowhere",
      ...colors.flatMap((c) => [`/v1/tokens/${c}`, `/v1/tokens/${c}/activity`, `/v1/lookup/${c}`]),
      ...contracts.flatMap((a) => [`/v1/contracts/${a}/tokens`, `/v1/contracts/${a}/activity`, `/v1/events?contract=${a}`]),
    ];
  }

  it("[[browser.tabs.one-engine]] with two tabs exactly one worker runs, in the leader tab, and alone holds the store; the follower starts none, starts the engine through the leader, and gets identical answers", async () => {
    const browser = await Browser.launch(browserExe!);
    try {
      const leader = await openTab(browser);
      expect(await leader.run("t.role()")).toBe("leader");
      const boot = (await leader.run("c.booted()")) as HostStatus["boot"];
      expect(boot.phase).toBe("ready");
      const follower = await openTab(browser);
      expect(await follower.run("t.role()")).toBe("follower");
      await waitUntil("the follower knows the leader", async () => (await follower.run("t.leader()")) === leader.id);
      await follower.run("(window.__notices = [], c.onNotice((n) => window.__notices.push(n)), true)");

      // One worker, in the leader tab; the follower started none.
      expect(leader.page.workers.filter((w) => w.running)).toHaveLength(1);
      expect(leader.page.workers[0]!.url).toMatch(/\/assets\/worker-[\w-]+\.js$/);
      expect(follower.page.workers).toEqual([]);
      expect(await follower.run("e.worker === undefined")).toBe(true);
      for (const t of [leader, follower]) expect(await t.run("t.connectedTabs()")).toBe(2);

      // The locks as the follower sees them: one leader (the leader page), one store holder (its worker, another
      // context), two tabs present, and the follower queued for leadership.
      const locks = (await follower.run("navigator.locks.query()")) as { held: Json[]; pending: Json[] };
      const held = (name: string): Json[] => locks.held.filter((l) => l.name === name);
      expect(held(`umbradb-engine-leader:${STORE}`)).toHaveLength(1);
      expect(held(`umbradb-store:${STORE}`)).toHaveLength(1);
      expect(locks.held.filter((l) => String(l.name).startsWith(`umbradb-engine-tab:${STORE}:`)).map((l) => l.name).sort())
        .toEqual([leader.id, follower.id].map((id) => `umbradb-engine-tab:${STORE}:${id}`).sort());
      expect(held(`umbradb-store:${STORE}`)[0].clientId).not.toBe(held(`umbradb-engine-leader:${STORE}`)[0].clientId);
      const queued = locks.pending.filter((l) => l.name === `umbradb-engine-leader:${STORE}`);
      expect(queued).toHaveLength(1);
      expect(queued[0].clientId).not.toBe(held(`umbradb-engine-leader:${STORE}`)[0].clientId);

      // The follower starts the engine: the request is forwarded to the leader, whose worker replays U1.
      const config: StartConfig = { source: { kind: "tape", range: "u1" }, startHeight: U1.from, endHeight: U1.to, ...FAST };
      const started = (await follower.run(`c.start(${JSON.stringify(config)})`)) as HostStatus;
      expect(started.engine).toMatchObject({ running: true, config });
      await waitUntil("both cursors at the end", async () => atEnd(await status(follower)));
      await waitUntil("the follower got the engine notice", async () =>
        ((await follower.run("window.__notices")) as Json[]).some((n) => n.notice === "engine" && n.engine.state === "running"));

      // Identical answers in both tabs.
      const [ls, fs] = [await status(leader), await status(follower)];
      expect(fs.store).toEqual(ls.store);
      expect(fs.cursors).toEqual(ls.cursors);
      expect(fs.boot).toEqual(ls.boot);
      expect(fs.engine?.config).toEqual(ls.engine?.config);
      expect(ls.store).toMatchObject({ dataDir: STORE, created: true });
      const targets = await targetsOf(follower);
      expect(targets.length).toBeGreaterThan(10);
      const answers: Record<string, Json> = {};
      for (const target of targets) {
        const [a, b] = [await api(leader, target), await api(follower, target)];
        expect(b, target).toEqual(a);
        answers[target] = a;
      }
      expect(answers["/v1/status"]).toMatchObject({ status: 200, body: { network: "stagenet", startHeight: U1.from, indexedHeight: U1.to, archiveHeight: U1.to, scanner: "following" } });
      expect(answers["/v1/tokens/zz"].status).toBe(400);
      expect(answers["/v1/nowhere"].status).toBe(404);
      expect(site.requests).toEqual([]); // the replay ran inside the worker

      // Still one worker, still none in the follower.
      expect(leader.page.workers.filter((w) => w.running)).toHaveLength(1);
      expect(follower.page.workers).toEqual([]);
      expect(leader.page.exceptions).toEqual([]);
      expect(follower.page.exceptions).toEqual([]);
      reference = answers;
      report.oneEngine = { targets: targets.length, boot: boot.timings };
    } finally {
      await browser.close();
    }
  }, 240_000);

  it("[[browser.tabs.handover]] closing the leader while its sync waits for the next height: the follower leads, boots its own worker on the same store, resumes the same configuration from the stored cursors, fetches no stored height again and every later one once, and ends with the uninterrupted run's answers", async () => {
    site.reset();
    const HOLD = U1.from + 15;
    site.holdAbove(HOLD);
    const browser = await Browser.launch(browserExe!);
    try {
      const first = await openTab(browser);
      expect(await first.run("t.role()")).toBe("leader");
      expect((await first.run("c.booted()")).phase).toBe("ready");
      const second = await openTab(browser);
      expect(await second.run("t.role()")).toBe("follower");
      await waitUntil("the follower knows the leader", async () => (await second.run("t.leader()")) === first.id);

      const net = { kind: "network", nodeUrl: `${site.origin}/chain/rpc`, indexerUrl: `${site.origin}/chain/graphql` } as const;
      const config: StartConfig = { source: net, startHeight: U1.from, endHeight: U1.to, sync: { concurrency: 1, maxBlocks: 4, idleMs: 200 }, scan: { idleMs: 200 } };
      await first.run(`c.start(${JSON.stringify(config)})`);
      await waitUntil(
        "the leader stored everything up to the held height",
        async () => {
          const s = await status(second);
          return s.cursors?.sync?.height === HOLD && s.cursors?.scan?.nextHeight === HOLD + 1 && site.held() >= 1;
        },
        60_000,
        async () => ({ cursors: (await status(second)).cursors, held: site.held() }),
      );
      const atClose = (await status(second)).cursors;
      expect(atClose).toMatchObject({ sync: { height: HOLD, startHeight: U1.from }, scan: { fromHeight: U1.from, nextHeight: HOLD + 1 } });
      expect(site.requests.filter((r) => r.height === HOLD + 1).map((r) => r.op)).toEqual(["chain_getBlockHash"]);

      // Close the leader tab (its worker dies with it) while its request for HOLD + 1 is still unanswered.
      const closedAt = Date.now();
      await first.page.close();
      await waitUntil("the follower leads", async () => (await second.run("t.role()")) === "leader", 30_000);
      const ledAt = Date.now();
      const booted = (await second.run("c.booted()")) as HostStatus["boot"];
      expect(booted.phase).toBe("ready");
      const bootedAt = Date.now();
      await waitUntil("the new leader asks for the next height", () => site.requests.some((r) => r.at >= closedAt && r.height !== null), 30_000);
      const resumedAt = Date.now();
      const after = (): ChainRequest[] => site.requests.filter((r) => r.at >= closedAt);
      expect(after().find((r) => r.height !== null)).toMatchObject({ op: "chain_getBlockHash", height: HOLD + 1 });
      expect(second.page.workers.filter((w) => w.running)).toHaveLength(1);
      const taken = await status(second);
      expect(taken.store).toMatchObject({ dataDir: STORE, created: false });
      expect(taken.cursors).toEqual(atClose);
      expect(taken.engine).toMatchObject({ running: true, config });

      site.release();
      await waitUntil("both cursors at the end", async () => atEnd(await status(second)), 60_000);

      // Every height: fetched once in all (node hash, node block, indexer block); none at or below the cursor after the
      // close; HOLD + 1's hash request is the old leader's unanswered one, asked again by the new leader.
      const count = (rs: ChainRequest[], op: string, h: number): number => rs.filter((r) => r.op === op && r.height === h).length;
      const before = site.requests.filter((r) => r.at < closedAt);
      for (let h = U1.from; h <= U1.to; h++) {
        const stored = h <= HOLD;
        expect([h, count(before, "chain_getBlockHash", h), count(before, "chain_getBlock", h), count(before, "indexer.block", h)])
          .toEqual([h, stored || h === HOLD + 1 ? 1 : 0, stored ? 1 : 0, stored ? 1 : 0]);
        expect([h, count(after(), "chain_getBlockHash", h), count(after(), "chain_getBlock", h), count(after(), "indexer.block", h)])
          .toEqual([h, stored ? 0 : 1, stored ? 0 : 1, stored ? 0 : 1]);
      }

      // The store answers as the uninterrupted run's.
      expect(reference, "the one-engine test's answers").toBeDefined();
      for (const [target, expected] of Object.entries(reference!)) expect(await api(second, target), target).toEqual(expected);
      expect(await second.run("t.connectedTabs()")).toBe(1);
      expect(second.page.exceptions).toEqual([]);
      report.handover = { closeToLeaderMs: ledAt - closedAt, closeToBootedMs: bootedAt - closedAt, closeToFirstFetchMs: resumedAt - closedAt, boot: booted.timings };
    } finally {
      site.release();
      await browser.close();
    }
  }, 240_000);

  it("[[browser.tabs.in-flight]] requests in flight to a frozen leader when it closes: reads are answered by the next leader, also for a third tab; state changes fail with leader-changed; the next leader resumes the replay in its worker to the end", async () => {
    site.reset();
    const browser = await Browser.launch(browserExe!);
    try {
      const a = await openTab(browser);
      expect((await a.run("c.booted()")).phase).toBe("ready");
      const b = await openTab(browser);
      const c = await openTab(browser);
      for (const t of [b, c]) await waitUntil("the followers know the leader", async () => (await t.run("t.leader()")) === a.id);

      // A slow replay inside the leader's worker, so it is mid-range when the leader goes.
      const config: StartConfig = {
        source: { kind: "tape", range: "u1" }, startHeight: U1.from, endHeight: U1.to,
        sync: { concurrency: 1, maxBlocks: 2, minIntervalMs: 100, idleMs: 200 }, scan: { idleMs: 200 },
      };
      await c.run(`c.start(${JSON.stringify(config)})`);
      await waitUntil("the replay is under way", async () => ((await status(b)).cursors?.sync?.height ?? 0) >= U1.from + 4, 60_000);
      const beforeFreeze = (await status(b)).cursors!;

      // Freeze the leader tab: it holds its locks but answers nothing.
      try {
        await a.page.send("Page.setWebLifecycleState", { state: "frozen" });
        report.suspend = "frozen";
      } catch {
        await a.page.send("Debugger.enable");
        await a.page.send("Debugger.pause");
        report.suspend = "paused in the debugger";
      }
      const issue = `(window.__inflight = {}, ((s) => {
        s("status", c.status()); s("api", c.api("GET", "/v1/status")); s("tokens", c.api("GET", "/v1/tokens"));
        s("stop", c.stop()); s("start", c.start(${JSON.stringify(config)}));
      })((k, p) => p.then((v) => { window.__inflight[k] = { ok: true, v }; }, (err) => { window.__inflight[k] = { ok: false, code: err.code, message: err.message }; })), true)`;
      await b.run(issue);
      await c.run(issue);
      await new Promise((r) => setTimeout(r, 750));
      expect(await b.run("window.__inflight")).toEqual({});
      expect(await c.run("window.__inflight")).toEqual({});

      await a.page.close();
      await waitUntil("the next tab leads", async () => (await b.run("t.role()")) === "leader" && (await c.run("t.leader()")) === b.id, 30_000);
      const settled = async (t: Tab): Promise<Json> => {
        await waitUntil("the in-flight requests settled", async () => Object.keys(await t.run("window.__inflight")).length === 5, 60_000);
        return t.run("window.__inflight");
      };
      for (const t of [b, c]) {
        const r = await settled(t);
        expect(r.stop).toMatchObject({ ok: false, code: "leader-changed" });
        expect(r.start).toMatchObject({ ok: false, code: "leader-changed" });
        expect(r.stop.message).toMatch(/may or may not have been applied/);
        // Answered by the next leader's worker, possibly while it boots (the old leader's store reports created: true).
        expect(r.status).toMatchObject({ ok: true, v: { protocol: 1, network: "stagenet" } });
        expect(r.status.v.store === null || r.status.v.store.created === false, JSON.stringify(r.status.v.store)).toBe(true);
        expect(r.api).toMatchObject({ ok: true, v: { status: 200 } });
        expect(JSON.parse(r.api.v.body)).toMatchObject({ network: "stagenet", startHeight: U1.from });
        expect(r.tokens).toMatchObject({ ok: true, v: { status: 200 } });
      }

      // The next leader runs its own worker on the same store and resumes the replay from the stored cursors.
      expect(b.page.workers.filter((w) => w.running)).toHaveLength(1);
      expect(c.page.workers).toEqual([]);
      await waitUntil("the next leader resumed the engine", async () => (await status(c)).engine?.running === true, 30_000);
      const taken = await status(c);
      expect(taken.engine).toMatchObject({ running: true, config });
      expect(taken.cursors!.sync!.height).toBeGreaterThanOrEqual(beforeFreeze.sync!.height);
      await waitUntil("both cursors at the end", async () => atEnd(await status(c)), 60_000);
      expect(reference, "the one-engine test's answers").toBeDefined();
      for (const [target, expected] of Object.entries(reference!)) expect(await api(c, target), target).toEqual(expected);
      for (const t of [b, c]) expect(await t.run("t.connectedTabs()")).toBe(2);
      expect(b.page.exceptions).toEqual([]);
      expect(c.page.exceptions).toEqual([]);
      report.inFlight = { beforeFreeze, taken: taken.cursors };
    } finally {
      await browser.close();
    }
  }, 240_000);
});
