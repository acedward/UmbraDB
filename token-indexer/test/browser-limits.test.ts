/**
 * The browser engine at its limits, in Node (the worker host on PGlite in memory or on the Node file system, the
 * recorded ranges replayed with no network). The same in Chrome, on OPFS, is `browser-limits-chrome.test.ts`.
 *
 * - `[[browser.quota.refused-write]]` — the storage guard after a write the browser refused for lack of space: the sync
 *   is paused with the refusal as the reason (readings do not lift it), its next batch is admitted no sooner than the
 *   recheck interval and then tries (a refused write again pauses it again), a stop ends the wait; the errors that count
 *   as a refused write are the database's "could not extend file", "File too large", "No space left on device" and the
 *   browser's `QuotaExceededError`, not a network or constraint error.
 * - `[[browser.host.new-build-old-store]]` — a store written by an older build (the newest `mip0018` migration not
 *   applied yet, blocks already stored) opened by this build: the boot runs the missing migration, keeps the cursors and
 *   the data, writes the store's identity, and the engine continues to the range's end with the recorded archive digest.
 * - `[[browser.host.minted-before-start]]` — a store started after a token's mint (IDX from 714700, after the medals'
 *   mints at 714683 and 714689): `/v1/status` gives that start height; a token minted before it has no mint identity
 *   (no color, `minted: null`) though the uninterrupted range has one; every metadata field held was written at or
 *   after the start; an identity whose metadata was all written before the start is not listed.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerHost } from "../browser/host.ts";
import type { DigestResult, HostStatus } from "../browser/protocol.ts";
import { createQuotaGuard, isRefusedWrite } from "../browser/quota.ts";
import { openStore } from "../browser/store.ts";
import { memoryStoreIdentity } from "../browser/store-identity.ts";
import { apiJson, IDX, result, testHost, U1, untilStatus } from "./helpers/worker-host.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PGLITE = (JSON.parse(readFileSync(`${ROOT}node_modules/@electric-sql/pglite/package.json`, "utf8")) as { version: string }).version;
const U1_ARCHIVE = (JSON.parse(readFileSync(`${ROOT}test/integration/fixtures/stagenet-archive/manifest.json`, "utf8")) as {
  ranges: Array<{ name: string; liveSync: { archiveDigest: { sha256: string } } }>;
}).ranges.find((r) => r.name === "u1")!.liveSync.archiveDigest.sha256;
const MEDALS = "f2d1b6ebfea446cf2624cd498fc585eeb86dddf94e33229ce47107038d2251d6";
const hexOf = (s: string): string => Buffer.from(s, "latin1").toString("hex").padEnd(64, "0");
const GOLD = hexOf("mip-0018:example:family:gold");
const SILVER = hexOf("mip-0018:example:family:silver");

const hosts: WorkerHost[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the browser engine at its limits (Node)", () => {
  it("[[browser.quota.refused-write]] after a refused write the sync stays paused with the refusal as the reason until a batch, no sooner than the recheck interval, tries again; a stop ends the wait; only out-of-space errors count", async () => {
    let now = 1_000;
    const sleeps: number[] = [];
    const logs: string[] = [];
    let estimate = { usage: 1e8, quota: 1e10 };
    const guard = createQuotaGuard({
      env: { estimate: async () => estimate, persisted: async () => false, storeBytes: async () => 1e6 },
      now: () => now,
      sleep: async (ms, signal) => {
        sleeps.push(ms);
        if (!signal.aborted) now += ms;
        await new Promise((r) => setTimeout(r, 0));
      },
      checkEveryMs: 0,
      recheckMs: 300,
      log: (level, message) => logs.push(`${level} ${message}`),
    });
    const run = new AbortController();
    await guard.admit(run.signal);
    expect(guard.status()).toMatchObject({ paused: false, pausedReason: null });

    const message = 'could not extend file "base/5/16404": File too large';
    guard.refusedWrite(message);
    const reason = `the browser refused to write to the store for lack of space (${message}); the store is at its last full block, and the sync tries a later batch again`;
    expect(guard.status()).toMatchObject({ paused: true, pausedReason: reason });
    expect(await guard.check(), "a reading does not lift it").toMatchObject({ paused: true, pausedReason: reason });
    expect((await guard.reading()).paused).toBe(true);
    now += 100;
    await guard.admit(run.signal);
    expect(sleeps, "the next batch waits the rest of the recheck interval").toEqual([200]);
    expect(guard.status()).toMatchObject({ paused: false, pausedReason: null });

    // Refused again at once: paused again; a full interval this time.
    guard.refusedWrite(message);
    sleeps.length = 0;
    await guard.admit(run.signal);
    expect(sleeps).toEqual([300]);

    // The figures near the quota when the batch would try: it stays paused by the rule before the quota.
    guard.refusedWrite(message);
    estimate = { usage: 9.5e9, quota: 1e10 };
    sleeps.length = 0;
    const admitted = guard.admit(run.signal);
    for (let i = 0; i < 20 && sleeps.length < 3; i++) await new Promise((r) => setTimeout(r, 1));
    expect(guard.status()).toMatchObject({ paused: true });
    expect(guard.status()!.pausedReason).toMatch(/^the browser counts /);
    estimate = { usage: 1e8, quota: 1e10 };
    await admitted;
    expect(guard.status()?.paused).toBe(false);

    // A stop while waiting ends the wait.
    guard.refusedWrite(message);
    const stop = new AbortController();
    stop.abort(new Error("stopped"));
    await expect(guard.admit(stop.signal)).rejects.toThrow("stopped");
    expect(logs.filter((l) => l.startsWith("warn sync paused: the browser refused"))).toHaveLength(4);

    for (const m of [message, "could not write to file \"pg_wal/000000010000000000000001\": No space left on device", "QuotaExceededError: the quota has been exceeded", "write failed: disk full"]) expect(isRefusedWrite(m), m).toBe(true);
    for (const m of ["chain_getBlock: request to https://node.invalid/ failed", 'duplicate key value violates unique constraint "blocks_pkey"', "stack depth limit exceeded"]) expect(isRefusedWrite(m), m).toBe(false);
  });

  it("[[browser.host.new-build-old-store]] a store of an older build (the newest migration missing, blocks stored) gets the migration at boot, keeps its cursors and data, gets an identity, and continues to the recorded archive digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "umbradb-old-store-"));
    dirs.push(dir);
    const config = { source: { kind: "tape", range: "u1" }, startHeight: U1.from, sync: { idleMs: 50 }, scan: { idleMs: 100 } } as const;
    const a = testHost({ dataDir: dir });
    await a.host.boot();
    await result(a.host, "start", { config: { ...config, endHeight: U1.from + 15 } });
    const before = await untilStatus(a.host, "the first part", (s) => s.cursors?.sync?.height === U1.from + 15 && s.cursors?.scan?.nextHeight === U1.from + 16);
    await a.host.close();

    // As an older build left it: no activity table, its migration not recorded.
    const old = await openStore(dir);
    await old.mip0018`DROP TABLE mip0018.mip0018_activity`;
    await old.mip0018`DELETE FROM mip0018._migrations WHERE name = '003_mip0018_activity'`;
    const names = (await old.mip0018<{ name: string }[]>`SELECT name FROM mip0018._migrations ORDER BY name`).map((r) => r.name);
    expect(names).toEqual(["000_schema", "001_mip0018_core", "002_mip0018_scan"]);
    await old.close();

    const identity = memoryStoreIdentity();
    const b = testHost({ dataDir: dir, storeIdentity: identity, build: { appCommit: null, pgliteVersion: PGLITE, ledgerVersion: null } });
    hosts.push(b.host);
    expect(await b.host.boot()).toMatchObject({ phase: "ready", storeProblem: null });
    const s = await result<HostStatus>(b.host, "status");
    expect(s.store, "the cursors below show the data kept (`created` is known for OPFS stores only)").toMatchObject({ migrations: { mip0018: ["000_schema", "001_mip0018_core", "002_mip0018_scan", "003_mip0018_activity"] } });
    expect(s.cursors).toEqual(before.cursors);
    expect(await identity.load()).toMatchObject({ format: 1, pglite: PGLITE });
    expect((await apiJson(b.host, "/v1/tokens?limit=10")).status).toBe(200);
    await result(b.host, "start", { config });
    await untilStatus(b.host, "the rest of U1", (x) => x.cursors?.sync?.height === U1.to && x.cursors?.scan?.nextHeight === U1.to + 1);
    expect((await result<DigestResult>(b.host, "digest")).archive.sha256).toBe(U1_ARCHIVE);
  }, 120_000);

  it("[[browser.host.minted-before-start]] a store started after a token's mint: the start height in /v1/status, no mint identity for the token, only metadata written at or after the start, an identity written only before it not listed", async () => {
    const replay = async (from: number): Promise<WorkerHost> => {
      const t = testHost();
      hosts.push(t.host);
      await t.host.boot();
      await result(t.host, "start", { config: { source: { kind: "tape", range: "idx" }, startHeight: from, endHeight: IDX.to, sync: { idleMs: 50 }, scan: { idleMs: 100 } } });
      await untilStatus(t.host, `IDX from ${from}`, (s) => s.cursors?.sync?.height === IDX.to && s.cursors?.scan?.nextHeight === IDX.to + 1, 300_000);
      return t.host;
    };
    const identityOf = async (h: WorkerHost, domainSep: string) => apiJson(h, `/v1/identities/${MEDALS}/${domainSep}/1`);
    const S = 714_700;

    // The whole range: the gold and silver medals are minted (714683, 714689), their metadata written at 714696 and 714703.
    const full = await replay(IDX.from);
    const fullSilver = (await identityOf(full, SILVER)).body;
    expect(fullSilver).toMatchObject({ color: "8c74ec4a937d296f8234a2373812c2df3d962dba06dfe98cda390f9dea38491d", minted: { firstMint: { height: 714689 } } });
    expect((await identityOf(full, GOLD)).status).toBe(200);

    const mid = await replay(S);
    expect((await apiJson(mid, "/v1/status")).body).toMatchObject({ startHeight: S, archiveHeight: IDX.to, indexedHeight: IDX.to });
    const silver = await identityOf(mid, SILVER);
    expect(silver.status).toBe(200);
    expect(silver.body, "minted before the start: no mint identity").toMatchObject({ color: null, minted: null, common: fullSilver.common });
    expect((await identityOf(mid, GOLD)).status, "metadata written only before the start: not listed").toBe(404);
    const tokens: Json[] = (await apiJson(mid, "/v1/tokens?limit=100")).body.items;
    const identities = tokens.filter((t) => t.source === "identity");
    expect(identities.length).toBeGreaterThan(0);
    for (const t of identities) {
      const id = (await apiJson(mid, `/v1/identities/${t.contractAddress}/${t.domainSep}/${t.kind}`)).body;
      for (const f of id.fields as Json[]) expect(f.updatedAt.height, `${t.id} ${f.key.utf8 ?? f.key.hex}`).toBeGreaterThanOrEqual(S);
      if (id.minted !== null) expect(id.minted.firstMint.height, t.id).toBeGreaterThanOrEqual(S);
    }
    expect(identities.some((t) => t.domainSep === GOLD && t.contractAddress === MEDALS)).toBe(false);
  }, 300_000);
});
