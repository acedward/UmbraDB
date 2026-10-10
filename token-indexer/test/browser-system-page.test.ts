/**
 * The system status page's text, outside a browser: the hidden-character rules it draws engine text with
 * (`token-indexer/browser/visible-text.ts`) and its view of a system snapshot (`token-indexer/browser/system-model.ts`).
 * The page itself, on the static build in Chrome, is `browser-system-page-chrome.test.ts`.
 *
 * - `[[browser.status.text-rules]]` — the page's rule is the explorer's (`token-indexer/mip0018/ui/page.js`): the same
 *   regular expression, and the same split into ordinary runs and `⟨U+XXXX⟩` marks for every code point and for
 *   hostile strings (bidi overrides and isolates, zero-width characters, NUL and other controls, lone surrogates,
 *   markup), computed by the explorer's own functions taken from its script.
 * - `[[browser.status.model]]` — every section of the page in the specified order, each value written from the
 *   snapshot: heights in plain digits, counts and bytes in full, times in UTC with their distance from the snapshot's
 *   own time, the per-endpoint table, each schema's migrations and tables (estimates, sizes, exact counts), storage,
 *   API, engine, browser, snapshot records and the log lines newest first; a missing value is "—".
 * - `[[browser.status.model-states]]` — the health line names every state by `HEALTH_LABELS` with its reason and tone;
 *   a follower's snapshot is marked "follower" with the time it was received; errors carry their time.
 */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { bytesText, collectionText, countText, durationText, grouped, healthLine, NONE, roleText, SECTION_IDS, startText, statusSections, timeText } from "../browser/system-model.ts";
import { HIDDEN_CHARACTER, markOf, visibleParts, visibleText } from "../browser/visible-text.ts";
import { HEALTH_LABELS, HEALTH_STATES, type SystemSnapshot, SystemSnapshotSchema } from "../engine/system-snapshot.ts";

const PAGE_JS = readFileSync(new URL("../mip0018/ui/page.js", import.meta.url), "utf8");

/** The explorer's own `parts()` and its `HIDDEN` source, taken from its script and run as they are. */
function explorerRules(): { parts: (v: string) => Array<{ m: boolean; s: string }>; hiddenSource: string } {
  const from = PAGE_JS.indexOf("  var HIDDEN = ");
  const to = PAGE_JS.indexOf("  function shown(v)");
  if (from < 0 || to < 0 || to < from) throw new Error("page.js no longer has HIDDEN … parts() before shown()");
  const code = PAGE_JS.slice(from, to);
  const ctx: Record<string, unknown> = {};
  runInNewContext(`${code}\nthis.parts = parts; this.hiddenSource = HIDDEN.source; this.hiddenFlags = HIDDEN.flags;`, ctx);
  expect(ctx.hiddenFlags).toBe("u");
  return { parts: ctx.parts as (v: string) => Array<{ m: boolean; s: string }>, hiddenSource: ctx.hiddenSource as string };
}

const T0 = Date.UTC(2026, 9, 10, 8, 15, 2, 0);

/** A whole snapshot with distinctive values (each test changes what it looks at). */
function snapshot(over: Partial<SystemSnapshot> = {}): SystemSnapshot {
  const endpoint = (n: number) => ({
    requests: 1000 + n, inFlight: 1, ok: 990 + n, http429: 2, http403: 1, http5xx: 3, httpOther: 0, transportErrors: 4, aborted: 0, retries: 7,
    throttledRetries: 3, lastRequestAt: T0 - 1_500, lastOkAt: T0 - 1_500, lastFailureAt: T0 - 65_000,
  });
  const base: SystemSnapshot = {
    format: "umbradb-system-snapshot",
    version: 1,
    generatedAt: T0,
    role: "leader",
    relayedAt: null,
    overview: {
      health: { state: "catching-up", label: "catching up", reason: "scan 1234 blocks behind the finalized tip" },
      startHeight: 714485,
      archiveHeight: 715183,
      scanHeight: 714900,
      finalizedTip: 716134,
      finalizedTipAt: T0 - 2_000,
      lag: { blocks: 1234, archiveBlocks: 951, scanBehindArchive: 283, seconds: 7404, secondsPerBlock: 6, catchUpSeconds: 61.7 },
    },
    configuration: {
      network: "stagenet",
      genesisHash: "0x2f76825abc239fecf6107c9df99016de57037b451ae57a4394b76c8cf53a9491",
      endpoints: { node: "https://rpc.stagenet.shielded.tools/", indexer: "https://indexer.stagenet.shielded.tools/api/v4/graphql" },
      schemas: { archive: "chain_archive", mip0018: "mip0018" },
      sync: { maxBlocks: 20, concurrency: 4, minIntervalMs: { node: 250, indexer: 250 }, timeoutMs: 30_000, idleMs: 6_000 },
      scan: { mode: "follow", batch: 10, idleMs: 2_000, maxBackoffMs: 60_000, fromHeight: null, toHeight: null },
      retry: { baseDelayMs: 1_000, maxDelayMs: 60_000, maxAttempts: 8, jitter: true },
      start: { mode: "tip", startHeight: 714485, endHeight: null, autoStart: true },
      durability: "non-durable",
      watchdogLimitMs: 30_000,
      api: { maxConcurrentRequests: 8 },
      build: {
        appCommit: "0123456789abcdef0123456789abcdef01234567", pgliteVersion: "0.5.8", postgresVersion: "18.3", ledgerVersion: "1.0.0-rc.3",
        mip: { id: "MIP-0018", commit: "274a84f221bcfc17e4b73e2c8b32fd8c028ea092" }, vendored: { repository: "https://github.com/midnight-experiments/mip-0018", commit: "daec1f19747b09f4e245885ab0dd9ecc789a82ce" },
      },
    },
    sync: {
      phase: "running", archiveStart: 714485, archiveHeight: 715183, nodeFinalizedHeight: 716140, indexerTipHeight: 716134, finalizedTip: 716134,
      blocksPerSecond: 1.3712, ingestedSinceStart: 699, endpoints: { node: endpoint(10), indexer: endpoint(5) }, lastSuccessAt: T0 - 800, nextAttemptAt: T0 + 3_000,
      lastError: { message: "chain_getBlock: HTTP 503 from https://rpc.stagenet.shielded.tools/", at: T0 - 65_000 }, failures: 0,
    },
    scan: {
      phase: "running", scanner: "following", startHeight: 714485, nextHeight: 714901, lagBehindArchive: 283, blocksPerSecond: 12.5, scannedSinceStart: 416,
      totals: { transactions: 69, events: 31, mints: 9, sightings: 12, actions: 140 }, unresolvedEvents: 0, lastSuccessAt: T0 - 300, nextAttemptAt: null, lastError: null, failures: 0,
    },
    databases: {
      dataDir: "opfs-ahp://umbradb-stagenet", serverVersion: "18.3", fsync: "off", durability: "non-durable", databaseBytes: 10_551_419,
      schemas: [
        {
          name: "chain_archive", exists: true,
          migrations: [{ name: "000_schema", appliedAt: T0 - 3_600_000 }, { name: "001_chain_archive_core", appliedAt: T0 - 3_599_000 }],
          tables: [
            { name: "blocks", kind: "partitioned", partitionOf: null, estimatedRows: null, totalBytes: 0, exactRows: 699, partitions: { count: 2, estimatedRows: 699, totalBytes: 4_259_840 } },
            { name: "blocks_p0", kind: "partition", partitionOf: "blocks", estimatedRows: 699, totalBytes: 4_218_880, exactRows: 699, partitions: null },
            { name: "watermarks", kind: "table", partitionOf: null, estimatedRows: 1, totalBytes: 16_384, exactRows: null, partitions: null },
          ],
        },
        { name: "mip0018", exists: false, migrations: [], tables: [] },
      ],
      collectedAt: T0 - 12_000, statements: [{ label: "settings", ms: 1.2 }, { label: "tables:chain_archive", ms: 3.9 }], exactRowsAt: T0 - 11_000, error: null,
    },
    storage: {
      usageBytes: 1_239_700_000, quotaBytes: 11_977_000_000, persisted: false, estimatedAt: T0 - 400, pauseAtBytes: 10_779_300_000, paused: false, pausedReason: null,
      databaseBytes: 10_551_419, bytesPerBlock: { store: 15_095.02, growth: 5_918.4 },
    },
    api: { inFlight: 2, maxConcurrentRequests: 8, served: 12_345, byStatus: { "2xx": 12_000, "3xx": 0, "4xx": 340, "5xx": 5 }, busy: 3, latencyMs: { p50: 1.04, p95: 15.66, samples: 1000, window: 1000 } },
    engine: {
      started: true, stopping: false, connectedTabs: 2, startedAt: T0 - 3_725_000, uptimeMs: 3_725_000, watchdogRestarts: 1,
      lastWatchdogRestart: { at: T0 - 90_000, reason: "the engine worker sent nothing for 4487 ms (limit 2000 ms)" }, pgliteReopens: 0, lastReopenAt: null,
      failedStatementsSinceOpen: 3, failedStatementsTotal: 5,
    },
    browser: { browser: "Chromium 153", checks: { chromium: true, opfs: true, syncAccessHandle: true, webLocks: true, broadcastChannel: true, persistentStorage: false } },
    snapshots: {
      lastExport: {
        at: T0 - 60_000, sha256: "a".repeat(64), bytes: 10_407_424,
        manifest: { network: "stagenet", height: 715183, blockHash: "90893e25", schemaVersions: { chain_archive: ["000", "001", "002"], mip0018: ["000", "001"] }, pgliteVersion: "0.5.8" },
      },
      lastImport: null,
    },
    logs: [
      { seq: 9, at: T0 - 1_000, level: "error", source: "sync", text: "newest \u202Eline" },
      { seq: 8, at: T0 - 5_000, level: "info", source: "scan", text: "older line" },
    ],
    collection: { watching: true, countersEveryMs: 2_000, databaseEveryMs: 30_000, statusAt: T0 - 100, statusError: null },
  };
  return SystemSnapshotSchema.parse({ ...base, ...over });
}

/** The value of `field` in the sections. */
function valueOf(s: SystemSnapshot, field: string): string {
  for (const sec of statusSections(s)) for (const v of sec.values) if (v.field === field) return v.text;
  throw new Error(`no value ${field}`);
}
function tableOf(s: SystemSnapshot, field: string): string[][] {
  for (const sec of statusSections(s)) for (const t of sec.tables) if (t.field === field) return t.rows.map((r) => r.map((c) => c.text));
  throw new Error(`no table ${field}`);
}

describe("system status page: text and view", () => {
  it("[[browser.status.text-rules]] the page draws engine text with the explorer's hidden-character rules: the same expression and the same runs and marks for every code point and for hostile strings", () => {
    const explorer = explorerRules();
    expect(HIDDEN_CHARACTER.source).toBe(explorer.hiddenSource);
    expect(HIDDEN_CHARACTER.flags).toBe("u");
    const mine = (v: string) => visibleParts(v).map((p) => ({ m: p.mark, s: p.text }));
    let marks = 0;
    for (let c = 0; c <= 0x10ffff; c++) {
      const one = String.fromCodePoint(c);
      const a = mine(one);
      const b = explorer.parts(one);
      if (a.length !== b.length || a[0]!.m !== b[0]!.m || a[0]!.s !== b[0]!.s) throw new Error(`U+${c.toString(16)}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
      if (a[0]!.m) marks++;
    }
    // Controls, format characters, private use, unassigned, surrogates and the ignorables: most of the code space.
    expect(marks).toBeGreaterThan(900_000);
    const hostile = [
      "\u202Egnp.exe\u200B\u0000<script>alert(1)</script>",
      "\u2066SYM\u2069 \u200F\u200E \u061C",
      "\u001b[31mred\u001b[0m & \"q\" \t tab \n newline \r\n \u2028 \u2029",
      "lone \uD800 high, lone \uDC00 low, pair \u{1F600} ok",
      "tag \u{E0041}\u{E007F} variation \uFE0F mongolian \u180B soft\u00ADhyphen \u3164 filler",
      "<img src=x onerror=\"window.__pwned=1\"> javascript:alert(1)",
      "",
    ];
    for (const h of hostile) expect(mine(h), JSON.stringify(h)).toEqual(explorer.parts(h));
    expect(visibleText("a\u202Eb\u0000c")).toBe(`a${markOf(0x202e)}b${markOf(0)}c`);
    expect(markOf(0xe0041)).toBe("⟨U+E0041⟩");
  });

  it("[[browser.status.model]] every section in order, each value written from the snapshot (heights, counts, bytes, times, tables, records, logs newest first); a missing value is a dash", () => {
    const s = snapshot();
    const sections = statusSections(s);
    expect(sections.map((x) => x.id)).toEqual([...SECTION_IDS]);
    expect(sections.map((x) => x.title)).toEqual(["overview", "configuration", "sync", "scan", "databases", "storage", "API", "engine", "browser", "snapshots", "logs"]);
    for (const sec of sections) {
      expect(sec.values.length + sec.tables.length, sec.id).toBeGreaterThan(0);
      for (const v of sec.values) expect(v.field.startsWith(`${sec.id}.`), v.field).toBe(true);
    }
    const fields = sections.flatMap((x) => x.values.map((v) => v.field));
    expect(new Set(fields).size).toBe(fields.length);

    // Formatting.
    expect([grouped(0), grouped(999), grouped(1000), grouped(1_234_567), grouped(-4321)]).toEqual(["0", "999", "1,000", "1,234,567", "-4,321"]);
    expect([bytesText(0), bytesText(1023), bytesText(1024), bytesText(10_551_419), bytesText(11_977_000_000)]).toEqual(["0 B", "1,023 B", "1,024 B (1.0 KiB)", "10,551,419 B (10.1 MiB)", "11,977,000,000 B (11.2 GiB)"]);
    expect([durationText(250), durationText(2_000), durationText(2_500), durationText(250_000), durationText(3_725_000), durationText(2 * 86_400_000 + 4 * 3_600_000)]).toEqual(["250 ms", "2 s", "2.5 s", "4 min 10 s", "1 h 2 min", "2 d 4 h"]);
    expect(timeText(T0, T0)).toBe("2026-10-10 08:15:02 UTC (now)");
    expect(timeText(T0 - 65_000, T0)).toBe("2026-10-10 08:13:57 UTC (1 min 5 s ago)");
    expect(timeText(T0 + 3_000, T0)).toBe("2026-10-10 08:15:05 UTC (in 3 s)");
    expect([timeText(null, T0), countText(null), bytesText(null), durationText(null)]).toEqual([NONE, NONE, NONE, NONE]);

    // Overview: the heights as /v1/status gives them, the lag in blocks and time.
    expect(valueOf(s, "overview.startHeight")).toBe("714485 · history before block 714485 is not indexed");
    expect(valueOf(s, "overview.archiveHeight")).toBe("715183");
    expect(valueOf(s, "overview.scanHeight")).toBe("714900");
    expect(valueOf(s, "overview.finalizedTip")).toBe("716134 (read 2026-10-10 08:15:00 UTC (2 s ago))");
    expect(valueOf(s, "overview.lagBlocks")).toBe("1,234 not scanned yet (archive 951 behind the tip, scan 283 behind the archive)");
    expect(valueOf(s, "overview.lagTime")).toBe("2 h 3 min behind the chain (6 s per block)");
    expect(valueOf(s, "overview.catchUp")).toBe("about 1 min 2 s at the scan's pace");
    // Configuration.
    expect(valueOf(s, "configuration.nodeUrl")).toBe("https://rpc.stagenet.shielded.tools/");
    expect(valueOf(s, "configuration.start")).toBe("at the finalized tip, then following");
    expect(valueOf(s, "configuration.endHeight")).toBe("none (follows new blocks)");
    expect(valueOf(s, "configuration.pacing")).toBe("node 250 ms, indexer 250 ms between requests");
    expect(valueOf(s, "configuration.syncBatch")).toBe("20 heights, 4 at a time, timeout 30 s, idle 6 s");
    expect(valueOf(s, "configuration.retry")).toBe("8 attempts, 1 s doubling to 1 min, with jitter");
    expect(valueOf(s, "configuration.watchdogLimit")).toBe("30 s");
    expect(valueOf(s, "configuration.apiCap")).toBe("8");
    expect(valueOf(s, "configuration.mip")).toBe("MIP-0018 @ 274a84f221bcfc17e4b73e2c8b32fd8c028ea092");
    // Sync: the endpoints' counters.
    expect(valueOf(s, "sync.blocksPerSecond")).toBe("1.37 blocks/s");
    expect(valueOf(s, "sync.nextAttemptAt")).toBe("2026-10-10 08:15:05 UTC (in 3 s)");
    expect(valueOf(s, "sync.lastError")).toBe("chain_getBlock: HTTP 503 from https://rpc.stagenet.shielded.tools/ (2026-10-10 08:13:57 UTC (1 min 5 s ago))");
    expect(tableOf(s, "sync.endpoints")).toEqual([
      ["node", "1,010", "1", "1,000", "2", "1", "3", "0", "4", "0", "7", "3", "2026-10-10 08:15:00 UTC (1.5 s ago)", "2026-10-10 08:15:00 UTC (1.5 s ago)", "2026-10-10 08:13:57 UTC (1 min 5 s ago)"],
      ["indexer", "1,005", "1", "995", "2", "1", "3", "0", "4", "0", "7", "3", "2026-10-10 08:15:00 UTC (1.5 s ago)", "2026-10-10 08:15:00 UTC (1.5 s ago)", "2026-10-10 08:13:57 UTC (1 min 5 s ago)"],
    ]);
    expect(valueOf(s, "scan.totals")).toBe("69 transactions, 31 events, 9 mints, 12 sightings, 140 actions");
    // Databases: migrations and tables per schema.
    expect(valueOf(s, "databases.databaseBytes")).toBe("10,551,419 B (10.1 MiB)");
    expect(valueOf(s, "databases.statements")).toBe("2, 5 ms in all, the longest 4 ms");
    expect(tableOf(s, "databases.chain_archive.migrations")).toEqual([["000_schema", "2026-10-10 07:15:02 UTC (1 h 0 min ago)"], ["001_chain_archive_core", "2026-10-10 07:15:03 UTC (59 min 59 s ago)"]]);
    expect(tableOf(s, "databases.chain_archive.tables")).toEqual([
      ["blocks", "partitioned: 2 partitions, 699 estimated rows, 4,259,840 B (4.1 MiB)", "no estimate", "0 B", "699"],
      ["blocks_p0", "partition of blocks", "699", "4,218,880 B (4.0 MiB)", "699"],
      ["watermarks", "table", "1", "16,384 B (16.0 KiB)", "not counted"],
    ]);
    expect(tableOf(s, "databases.mip0018.tables")).toEqual([]);
    const db = sections.find((x) => x.id === "databases")!;
    expect(db.tables.find((t) => t.field === "databases.mip0018.migrations")!.empty).toBe("the schema has no table");
    // Storage, API, engine, browser, snapshots.
    expect(valueOf(s, "storage.usageBytes")).toBe("1,239,700,000 B (1.2 GiB)");
    expect(valueOf(s, "storage.share")).toBe("10.4 %");
    expect(valueOf(s, "storage.persisted")).toBe("no");
    expect(valueOf(s, "storage.bytesPerBlock")).toBe("15,095 B (database size ÷ archived blocks)");
    expect(valueOf(s, "api.queue")).toBe("2 / 8");
    expect(valueOf(s, "api.byStatus")).toBe("2xx 12,000, 3xx 0, 4xx 340, 5xx 5");
    expect([valueOf(s, "api.p50"), valueOf(s, "api.p95"), valueOf(s, "api.busy")]).toEqual(["1.0 ms", "15.7 ms", "3"]);
    expect(valueOf(s, "engine.connectedTabs")).toBe("2");
    expect(valueOf(s, "engine.uptime")).toBe("1 h 2 min");
    expect(valueOf(s, "engine.watchdogRestarts")).toBe("1");
    expect(valueOf(s, "engine.lastWatchdogRestart")).toBe("the engine worker sent nothing for 4487 ms (limit 2000 ms) (2026-10-10 08:13:32 UTC (1 min 30 s ago))");
    expect(valueOf(s, "engine.lastReopenAt")).toBe(NONE);
    expect(valueOf(s, "browser.persistentStorage")).toBe("not supported");
    expect(valueOf(s, "browser.syncAccessHandle")).toBe("supported");
    expect(valueOf(s, "snapshots.lastExport.manifest")).toBe("stagenet, height 715183, block 90893e25, PGlite 0.5.8");
    expect(valueOf(s, "snapshots.lastExport.schemaVersions")).toBe("chain_archive 000, 001, 002; mip0018 000, 001");
    expect(valueOf(s, "snapshots.lastExport.bytes")).toBe("10,407,424 B (9.9 MiB)");
    expect(valueOf(s, "snapshots.lastImport")).toBe("none");
    // Logs: newest first, as the snapshot holds them; the text as it is (the page draws its marks).
    expect(valueOf(s, "logs.count")).toBe("2 (the latest 200 at most, newest first)");
    expect(tableOf(s, "logs.lines")).toEqual([["9", "2026-10-10 08:15:01 UTC (1 s ago)", "error", "sync", "newest \u202Eline"], ["8", "2026-10-10 08:14:57 UTC (5 s ago)", "info", "scan", "older line"]]);
    expect(collectionText(s)).toBe("snapshot of 2026-10-10 08:15:02 UTC · counters every 2 s, database statistics every 30 s while a status page is visible");

    // Missing values.
    const empty = snapshot({
      overview: { ...s.overview, startHeight: null, archiveHeight: null, scanHeight: null, finalizedTip: null, finalizedTipAt: null, lag: { blocks: null, archiveBlocks: null, scanBehindArchive: null, seconds: null, secondsPerBlock: null, catchUpSeconds: null } },
      browser: null,
      snapshots: { lastExport: null, lastImport: null },
      logs: [],
      collection: { ...s.collection, statusError: "/v1/status answered 503 BUSY" },
    });
    expect([valueOf(empty, "overview.startHeight"), valueOf(empty, "overview.archiveHeight"), valueOf(empty, "overview.lagTime"), valueOf(empty, "overview.catchUp")]).toEqual(["nothing indexed yet", NONE, NONE, NONE]);
    expect(valueOf(empty, "browser.browser")).toBe("not reported");
    expect(valueOf(empty, "snapshots.lastExport")).toBe("none");
    expect(tableOf(empty, "logs.lines")).toEqual([]);
    expect(collectionText(empty)).toContain("the last /v1/status read failed: /v1/status answered 503 BUSY");
    expect(startText(0)).toBe("0 · history before block 0 is not indexed");
  });

  it("[[browser.status.model-states]] the health line names every state by HEALTH_LABELS with its reason and tone; a follower's snapshot is marked follower with the time it was received", () => {
    const base = snapshot();
    const tones: Record<string, string | undefined> = {};
    for (const state of HEALTH_STATES) {
      const s = snapshot({ overview: { ...base.overview, health: { state, label: HEALTH_LABELS[state], reason: `why ${state}` } } });
      const line = healthLine(s);
      expect(line.label).toBe(HEALTH_LABELS[state]);
      expect(valueOf(s, "overview.health")).toBe(HEALTH_LABELS[state]);
      expect(valueOf(s, "overview.reason")).toBe(`why ${state}`);
      tones[state] = statusSections(s)[0]!.values[0]!.tone;
    }
    expect(tones).toEqual({ running: "ok", following: "ok", "catching-up": "warn", "waiting-network": "warn", "stalled-scan": "bad", "paused-quota": "warn", stopped: undefined, error: "bad" });
    expect(valueOf(base, "overview.role")).toBe("leader: this tab runs the engine");
    expect(roleText(base)).toBe("leader: this tab runs the engine");
    const follower = snapshot({ role: "follower", relayedAt: T0 + 40 });
    expect(valueOf(follower, "overview.role")).toBe("follower: this tab shows the leader tab's engine (received 2026-10-10 08:15:02 UTC (now))");
    expect(valueOf(follower, "engine.role")).toBe("follower");
    expect(statusSections(follower)[0]!.values.find((v) => v.field === "overview.role")!.tone).toBe("warn");
    // A stalled scan: its error and the scanner state.
    const stalled = snapshot({
      overview: { ...base.overview, health: { state: "stalled-scan", label: "stalled (scan)", reason: "block 714901: parent 00 is not the scanned block 714900 (11)" } },
      scan: { ...base.scan, scanner: "stalled", lastError: { message: "block 714901: parent 00 is not the scanned block 714900 (11)", at: T0 - 2_000 }, failures: 3 },
    });
    expect(valueOf(stalled, "overview.health")).toBe("stalled (scan)");
    expect(valueOf(stalled, "scan.scanner")).toBe("stalled");
    expect(valueOf(stalled, "scan.lastError")).toBe("block 714901: parent 00 is not the scanned block 714900 (11) (2026-10-10 08:15:00 UTC (2 s ago))");
    expect(valueOf(stalled, "scan.failures")).toBe("3");
    // A quota pause.
    const paused = snapshot({ storage: { ...base.storage, paused: true, pausedReason: "the sync pauses at 9 GB" } });
    expect([valueOf(paused, "storage.paused"), valueOf(paused, "storage.pausedReason")]).toEqual(["yes", "the sync pauses at 9 GB"]);
  });
});
