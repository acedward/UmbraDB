import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { drainInterfaceVerifications, retryBackoffMs, verifyInterfaceNow, type DrainDeps } from "../interface/drain.js";
import { DEFAULT_LEVEL1_LIMITS } from "../interface/level1.js";
import type { StateObservation, StateSource } from "../interface/level2.js";
import { markInterfaceStale } from "../interface/store.js";
import { startBundleHost, type BundleHost } from "./helpers/bundle-host.js";
import { startFakeEventIndexer, type FakeEventIndexer } from "./helpers/fake-event-indexer.js";
import { InterfaceChain, NET, currentOf, partsOf } from "./helpers/interface-chain.js";
import { fixtureHex, loadFixtureBundle, payloadFor, wrongHash, type Bundle } from "./helpers/pi-fixture.js";

/**
 * Project 00024-02 task C7 — the verification drain, end to end: synthetic chain → the real scanner
 * → publications stored `pending` → `drainInterfaceVerifications` (outside the scan's transaction) →
 * the guarded HTTP transport against a real local bundle host (TEST-ONLY private-host bypass on) →
 * Level 2 against a stub state provider → Level 3 on the stand-in compiler → the result, its history
 * and its schedule in `public_interface_events` / `public_interface_checks`.
 * Spec FR-010, FR-011, FR-011b, FR-012, Q14, UC-2; plan `plans/00024-02-public-interface.md` C7.
 */

const STAND_IN = fileURLToPath(new URL("./helpers/fake-compact.mjs", import.meta.url));
const CONTRACT = "d7".repeat(32);
const RECHECK = 3_600_000;
/** The test clock starts a minute after the real one: the scan schedules a first check at the
 *  database's `now()`, so it must be due at T0. */
const T0 = new Date(Math.ceil(Date.now() / 1000) * 1000 + 60_000);
const at = (ms: number): Date => new Date(T0.getTime() + ms);

class StubState implements StateSource {
  readonly description = "stub state provider (test)";
  state = fixtureHex("state.hex");
  hook: (() => Promise<void>) | undefined;
  calls = 0;
  async stateOf(): Promise<StateObservation> {
    this.calls++;
    await this.hook?.();
    return { state: this.state, blockHeight: 77, txHash: "ee".repeat(32) };
  }
}

interface Row {
  status: string; level: number; l1: string | null; l2: string | null; l3: string | null; l3_reason: string | null;
  reason: string | null; failed_level: number | null; checks: number; attempts: number; generation: number;
  last_verified_at: Date | null; verified_until: Date | null; next_check_at: Date | null; checked_at: Date | null;
  report: Record<string, any> | null; circuits: unknown[] | null; state_block_height: string | null; // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("public-interface verification drain (C7)", () => {
  let container: StartedPostgreSqlContainer;
  let indexer: FakeEventIndexer;
  let host: BundleHost;
  let chain: InterfaceChain;
  let scratch: string;
  const bundle = loadFixtureBundle();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    indexer = await startFakeEventIndexer();
    host = await startBundleHost();
    chain = new InterfaceChain(() => container.getConnectionUri(), () => indexer);
    scratch = mkdtempSync(join(tmpdir(), "umbradb-drain-test-"));
    // The stand-in compiler's recorded output: the bundle's own artifacts (Level 3 reproduces them).
    const out = join(scratch, "compile-output");
    for (const d of ["keys", "contract", "compiler"]) mkdirSync(join(out, d), { recursive: true });
    for (const [p, body] of bundle) if (p.startsWith("out/")) writeFileSync(join(out, p.slice(4)), body);
    process.env.FAKE_COMPACT_OUTPUT = out;
  }, 180_000);

  afterAll(async () => {
    delete process.env.FAKE_COMPACT_OUTPUT;
    await chain?.closeAll();
    await host?.close();
    await indexer?.close();
    await container?.stop();
    rmSync(scratch, { recursive: true, force: true });
  }, 60_000);

  afterEach(() => {
    indexer.events.clear();
    host.files.clear();
    host.routes.clear();
    host.requests.length = 0;
  });

  function deps(state: StubState, now: Date, extra: Partial<DrainDeps> = {}): DrainDeps {
    return {
      stateSource: state,
      fetchPolicy: { allowPrivateHosts: true, deadlineMs: 5_000 }, // TEST-ONLY bypass: the host is 127.0.0.1
      limits: DEFAULT_LEVEL1_LIMITS,
      level3: { compactBin: STAND_IN, deadlineMs: 20_000, tmpRoot: scratch },
      recheckMs: RECHECK,
      now: () => now,
      ...extra,
    };
  }

  async function row(db: { sql: UmbraDBSql; schema: string }, eventId: number): Promise<Row> {
    const rows = await db.sql<Row[]>`
      SELECT status, level, l1, l2, l3, l3_reason, reason, failed_level, checks, attempts, generation,
             last_verified_at, verified_until, next_check_at, checked_at, report, circuits, state_block_height::text
      FROM ${db.sql(db.schema)}.public_interface_events WHERE net = ${NET} AND event_id = ${eventId}`;
    return rows[0]!;
  }

  async function history(db: { sql: UmbraDBSql; schema: string }, eventId: number) {
    return db.sql<{ check_no: number; trigger: string; status: string; level: number; checked_at: Date }[]>`
      SELECT check_no, trigger, status, level, checked_at FROM ${db.sql(db.schema)}.public_interface_checks
      WHERE net = ${NET} AND event_id = ${eventId} ORDER BY check_no`;
  }

  const publish = (txHash: string, blockHeight: number, id: number, payload: Buffer, position = 0) => ({
    txHash, blockHeight, position, contract: CONTRACT,
    publications: [{ segment: 1, parts: partsOf(payload).map((p, i) => ({ id: id + i, payload: p })) }],
  });
  const serveAt = (base: string, b: Bundle): string => { host.mount(base, b); return `${host.origin}${base}index.json`; };

  it("[[interface-newest-current]] the newest publication is current whatever its result: a newer broken bundle is current and FAILED, the older verified one historical with its own result; P2 decides in one block", async () => {
    const db = await chain.freshDb("newest");
    const state = new StubState();
    const good = serveAt("/pi/", bundle);
    await chain.scan(db, [publish("a1".repeat(32), 100, 10, payloadFor(bundle, good))]);

    // --- the first publication: verified L1/L2/L3 in one drain, outside the scan ---------------------
    const first = await drainInterfaceVerifications(db.sql, db.schema, NET, deps(state, T0));
    expect(first).toEqual({ attempted: 1, verified: 1, failed: 0, unchecked: 0, unfetchable: 0, discarded: 0 });
    const v = await row(db, 10);
    expect(v).toMatchObject({ status: "verified", level: 3, l1: "passed", l2: "passed", l3: "passed", l3_reason: null, reason: null, failed_level: null, checks: 1, attempts: 0 });
    expect(v.last_verified_at).toEqual(T0);
    expect(v.verified_until).toBeNull();
    expect(v.next_check_at).toEqual(at(RECHECK));
    expect(v.state_block_height).toBe("77");
    // The [B] PR #6 verification record: publication, observation, provider limits, state,
    // operations, artifact identities, compiler/build inputs, completed levels.
    expect(v.report).toMatchObject({
      network: NET, contract: CONTRACT, completedLevel: 3, status: "verified",
      publication: { eventId: 10, partEventIds: [10], blockHeight: 100, segment: 1, parts: 1, phase: "guaranteed", url: good },
      observation: { checkedAt: T0.toISOString(), trigger: "initial", stateSource: "stub state provider (test)" },
      state: { blockHeight: 77, txHash: "ee".repeat(32), entryPoints: ["guardedIncrement", "increment", "read"] },
      compiler: { name: "compactc", version: "0.34.0" },
      build: { compiler: "0.34.0", language: "0.26.0", runtime: "0.19.0", interface: "src/PiFixture.compact", flags: [] },
      witnesses: ["emitterSecret"],
      levels: { l1: { status: "passed" }, l2: { status: "passed" }, l3: { status: "passed", compiler: { version: "0.34.0", installed: "0.34.0" } } },
      limits: { maxFiles: 1000, allowPrivateHosts: true, fetchDeadlineMs: 5_000 },
      executed: expect.stringMatching(/nothing from the bundle was executed/),
    });
    expect(v.report!.providerLimits).toHaveLength(3);
    expect(v.report!.artifacts.files).toHaveLength(10);
    expect(v.report!.operations).toHaveLength(3);
    expect(v.report!.levels.l3.generatedKeys).toHaveLength(3);
    expect(v.circuits).toHaveLength(3);
    expect(await history(db, 10)).toMatchObject([{ check_no: 1, trigger: "initial", status: "verified", level: 3 }]);

    // --- a newer publication whose index.json hash is not its commitment -----------------------
    const bad = serveAt("/pi-bad/", wrongHash(bundle));
    await chain.scan(db, [publish("a2".repeat(32), 101, 20, payloadFor(bundle, bad))]);
    expect(await currentOf(db, CONTRACT)).toEqual({ eventId: 20, publications: 2 });
    host.requests.length = 0;
    const second = await drainInterfaceVerifications(db.sql, db.schema, NET, deps(state, at(1_000)));
    expect(second).toMatchObject({ attempted: 1, failed: 1 });
    const f = await row(db, 20);
    expect(f).toMatchObject({ status: "failed", level: 0, l1: "failed", l2: "not_run", l3: "not_run", failed_level: 1 });
    expect(f.reason).toMatch(/^Level 1: index\.json's hash [0-9a-f]{64} is not the event's commitment/);
    expect(f.next_check_at).toEqual(at(1_000 + RECHECK)); // the current one is re-checked on schedule
    expect(host.requests.map((r) => r.path)).toEqual(["/pi-bad/index.json"]); // no second request
    // Current and failed: nothing rolls back to the verified one (Q14) — it is historical, keeps its
    // own last result, and is no longer scheduled.
    expect(await currentOf(db, CONTRACT)).toEqual({ eventId: 20, publications: 2 });
    const old = await row(db, 10);
    expect(old).toMatchObject({ status: "verified", level: 3, checks: 1 });
    expect(old.next_check_at).toBeNull();
    // Even past the re-check time only the current one is checked again.
    const later = await drainInterfaceVerifications(db.sql, db.schema, NET, deps(state, at(2 * RECHECK)));
    expect(later).toMatchObject({ attempted: 1, failed: 1 });
    expect((await row(db, 10)).checks).toBe(1);
    expect((await row(db, 20)).checks).toBe(2);

    // --- P2 in one block: the LATER transaction is current although its event ids are lower ------
    const db2 = await chain.freshDb("newest2");
    await chain.scan(db2, [
      publish("b1".repeat(32), 200, 900, payloadFor(bundle, good), 0),
      publish("b2".repeat(32), 200, 800, payloadFor(bundle, bad), 1),
    ]);
    expect(await currentOf(db2, CONTRACT)).toEqual({ eventId: 800, publications: 2 });
    // Both get their one check, the current one first.
    const both = await drainInterfaceVerifications(db2.sql, db2.schema, NET, deps(state, T0));
    expect(both).toMatchObject({ attempted: 2, verified: 1, failed: 1 });
    expect((await row(db2, 800)).status).toBe("failed");
    expect((await row(db2, 900))).toMatchObject({ status: "verified", next_check_at: null });
    expect((await history(db2, 800))[0]!.checked_at).toEqual(T0);
  }, 180_000);

  it("[[interface-recheck]] the current publication is re-verified on its timer and on demand; bytes changed on the host → failed at L1 with 'verified until'; a limit is retried with backoff", async () => {
    const db = await chain.freshDb("recheck");
    const state = new StubState();
    const url = serveAt("/pi/", bundle);
    const older = serveAt("/pi-old/", bundle);
    await chain.scan(db, [
      publish("c0".repeat(32), 99, 5, payloadFor(bundle, older)),
      publish("c1".repeat(32), 100, 10, payloadFor(bundle, url)),
    ]);
    await drainInterfaceVerifications(db.sql, db.schema, NET, deps(state, T0));
    expect((await row(db, 10))).toMatchObject({ status: "verified", level: 3 });

    // Nothing is due before the re-check interval.
    expect((await drainInterfaceVerifications(db.sql, db.schema, NET, deps(state, at(1_000)))).attempted).toBe(0);

    // The URL is breached: the host now serves other bytes for a listed file.
    host.files.set("/pi/out/contract/index.js", Buffer.from("export const breached = true;\n"));
    const recheck = await drainInterfaceVerifications(db.sql, db.schema, NET, deps(state, at(RECHECK + 1)));
    expect(recheck).toMatchObject({ attempted: 1, failed: 1 });
    const breached = await row(db, 10);
    expect(breached).toMatchObject({ status: "failed", level: 0, l1: "failed", failed_level: 1, checks: 2 });
    expect(breached.reason).toMatch(/^Level 1: out\/contract\/index\.js: 30 bytes, index\.json says 23322/);
    expect(breached.last_verified_at).toEqual(T0);
    expect(breached.verified_until).toEqual(T0); // "verified until <time>"
    expect(breached.next_check_at).toEqual(at(2 * RECHECK + 1));
    // Nothing rolls back: this publication stays current (and failed); the older one stays historical.
    expect(await currentOf(db, CONTRACT)).toEqual({ eventId: 10, publications: 2 });
    expect((await row(db, 5)).next_check_at).toBeNull();
    expect(await history(db, 10)).toMatchObject([
      { check_no: 1, trigger: "initial", status: "verified" }, { check_no: 2, trigger: "recheck", status: "failed" },
    ]);

    // On demand (`verify-interfaces --address`): still failed; the host restored → verified again,
    // "verified until" cleared.
    const demanded = await verifyInterfaceNow(db.sql, db.schema, NET, CONTRACT, deps(state, at(RECHECK + 60_000)));
    expect(demanded).toMatchObject({ eventId: 10, write: "written", result: { status: "failed" } });
    host.mount("/pi/", bundle);
    const restored = await verifyInterfaceNow(db.sql, db.schema, NET, CONTRACT, deps(state, at(RECHECK + 120_000)));
    expect(restored?.result.status).toBe("verified");
    const again = await row(db, 10);
    expect(again).toMatchObject({ status: "verified", level: 3, checks: 4 });
    expect(again.verified_until).toBeNull();
    expect(again.last_verified_at).toEqual(at(RECHECK + 120_000));
    expect((await history(db, 10)).map((h) => [h.trigger, h.status])).toEqual([
      ["initial", "verified"], ["recheck", "failed"], ["on_demand", "failed"], ["on_demand", "verified"],
    ]);
    expect(await verifyInterfaceNow(db.sql, db.schema, NET, "00".repeat(32), deps(state, T0))).toBeUndefined();

    // A limit (the host stalls past the deadline): unchecked, never failed, retried with backoff.
    host.routes.set("/pi/index.json", { kind: "stall" });
    const slow = await verifyInterfaceNow(db.sql, db.schema, NET, CONTRACT, deps(state, at(RECHECK + 180_000), { fetchPolicy: { allowPrivateHosts: true, deadlineMs: 300 } }));
    expect(slow?.result).toMatchObject({ status: "unchecked", level: 0 });
    expect(slow?.result.reason).toMatch(/the 300 ms deadline was reached/);
    const limited = await row(db, 10);
    expect(limited).toMatchObject({ status: "unchecked", attempts: 1 });
    expect(limited.verified_until).toEqual(at(RECHECK + 120_000));
    expect(limited.next_check_at).toEqual(at(RECHECK + 180_000 + retryBackoffMs(1, RECHECK)));
    expect(retryBackoffMs(1, RECHECK)).toBe(30_000);
    expect(retryBackoffMs(20, RECHECK)).toBe(RECHECK);
    host.routes.clear();
    const retry = await drainInterfaceVerifications(db.sql, db.schema, NET, deps(state, at(RECHECK + 180_000 + 31_000)));
    expect(retry).toMatchObject({ attempted: 1, verified: 1 });
    expect((await history(db, 10)).at(-1)).toMatchObject({ trigger: "retry", status: "verified" });
    expect((await row(db, 10)).attempts).toBe(0);
  }, 180_000);

  it("[[interface-stale-on-maintenance]] a maintenance update marks the current interface stale; it is re-verified; a check in flight when it happens is discarded, never written over the stale", async () => {
    const db = await chain.freshDb("stale");
    const state = new StubState();
    const url = serveAt("/pi/", bundle);
    await chain.scan(db, [publish("e1".repeat(32), 100, 10, payloadFor(bundle, url))]);
    await drainInterfaceVerifications(db.sql, db.schema, NET, deps(state, T0));
    expect((await row(db, 10))).toMatchObject({ status: "verified", level: 3, generation: 0 });

    // A maintenance update of the contract (a verifier key replaced) is scanned: stale, due now.
    const outcomes = await chain.scan(db, [{ txHash: "e2".repeat(32), blockHeight: 101, contract: CONTRACT, publications: [], maintenance: [CONTRACT] }]);
    expect(outcomes.reduce((n, o) => n + o.interfacesStaled, 0)).toBe(1);
    const stale = await row(db, 10);
    expect(stale).toMatchObject({ status: "stale", level: 3, l3: "passed", generation: 1, checks: 1 }); // last result kept
    expect(stale.next_check_at!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);

    // Re-verified against the new state: `increment`'s key changed → failed at L2, verified until T0.
    state.state = fixtureHex("state-wrong-increment-key.hex");
    const re = await drainInterfaceVerifications(db.sql, db.schema, NET, deps(state, at(60_000)));
    expect(re).toMatchObject({ attempted: 1, failed: 1 });
    const after = await row(db, 10);
    expect(after).toMatchObject({ status: "failed", level: 1, l1: "passed", l2: "failed", l3: "not_run", failed_level: 2 });
    expect(after.reason).toBe("Level 2: vk increment: shipped key differs from the key on chain");
    expect(after.verified_until).toEqual(T0);
    expect((await history(db, 10)).at(-1)).toMatchObject({ trigger: "stale", status: "failed" });

    // A maintenance update scanned WHILE a check is in flight: the check's result is discarded.
    state.state = fixtureHex("state.hex");
    await verifyInterfaceNow(db.sql, db.schema, NET, CONTRACT, deps(state, at(120_000)));
    expect((await row(db, 10)).status).toBe("verified");
    await db.sql`UPDATE ${db.sql(db.schema)}.public_interface_events SET next_check_at = ${at(130_000)} WHERE net = ${NET} AND event_id = 10`;
    state.hook = async () => { await markInterfaceStale(db.sql, db.schema, NET, CONTRACT); state.hook = undefined; };
    const raced = await drainInterfaceVerifications(db.sql, db.schema, NET, deps(state, at(140_000)));
    expect(raced).toMatchObject({ attempted: 1, discarded: 1, verified: 0 });
    const kept = await row(db, 10);
    expect(kept).toMatchObject({ status: "stale", checks: 3 }); // not overwritten, not counted (initial, stale, on_demand)
    const next = await drainInterfaceVerifications(db.sql, db.schema, NET, deps(state, new Date(Date.now() + 5_000)));
    expect(next).toMatchObject({ attempted: 1, verified: 1, discarded: 0 });
    expect((await history(db, 10)).at(-1)).toMatchObject({ check_no: 4, trigger: "stale", status: "verified" });

    // A maintenance update in a FAILED transaction changed nothing; one of a contract without an
    // interface marks nothing; a never-checked publication stays pending (bumped).
    const failedTx = await chain.scan(db, [{ txHash: "e3".repeat(32), blockHeight: 102, contract: CONTRACT, publications: [], maintenance: [CONTRACT], result: "failure" }]);
    expect(failedTx.reduce((n, o) => n + o.interfacesStaled, 0)).toBe(0);
    expect((await row(db, 10)).status).toBe("verified");
    const other = await chain.scan(db, [{ txHash: "e4".repeat(32), blockHeight: 103, contract: CONTRACT, publications: [], maintenance: ["f0".repeat(32)] }]);
    expect(other.reduce((n, o) => n + o.interfacesStaled, 0)).toBe(0);
    await chain.scan(db, [publish("e5".repeat(32), 104, 30, payloadFor(bundle, url))]);
    await chain.scan(db, [{ txHash: "e6".repeat(32), blockHeight: 105, contract: CONTRACT, publications: [], maintenance: [CONTRACT] }]);
    expect(await row(db, 30)).toMatchObject({ status: "pending", generation: 1, checks: 0 });
  }, 180_000);

  it("[[interface-multipart-url]] a URL longer than 224 bytes is a 2-part publication that verifies; the same parts split over two intents are two packages, each judged alone", async () => {
    const db = await chain.freshDb("multipart");
    const state = new StubState();
    const longBase = `/${"a-long-path-segment-".repeat(12)}pi/`;
    const url = serveAt(longBase, bundle);
    expect(Buffer.byteLength(url)).toBeGreaterThan(224);
    const payload = payloadFor(bundle, url);
    expect(payload).toHaveLength(512);
    await chain.scan(db, [publish("f1".repeat(32), 100, 10, payload)]);
    const stored = await db.sql<{ parts: number; part_event_ids: string[]; url: string }[]>`
      SELECT parts, part_event_ids::text[] AS part_event_ids, url FROM ${db.sql(db.schema)}.public_interface_events WHERE net = ${NET}`;
    expect(stored).toEqual([{ parts: 2, part_event_ids: ["10", "11"], url }]);
    expect(await drainInterfaceVerifications(db.sql, db.schema, NET, deps(state, T0))).toMatchObject({ attempted: 1, verified: 1 });
    expect(await row(db, 10)).toMatchObject({ status: "verified", level: 3 });
    expect((await row(db, 10)).report).toMatchObject({ publication: { parts: 2, partEventIds: [10, 11], url } });

    // The same two parts, each in its own intent: two one-part packages. Neither holds the pointer —
    // part 1 names a truncated URL, part 2 has no commitment and no URL at all — so each is judged on
    // its own bytes; the later one is current.
    const db2 = await chain.freshDb("multipart2");
    const [p1, p2] = partsOf(payload);
    await chain.scan(db2, [{
      txHash: "f2".repeat(32), blockHeight: 100, contract: CONTRACT, publications: [
        { segment: 3, parts: [{ id: 20, payload: p1! }] }, { segment: 5, parts: [{ id: 21, payload: p2! }] },
      ],
    }]);
    const split = await db2.sql<{ event_id: string; parts: number; url: string | null }[]>`
      SELECT event_id::text, parts, url FROM ${db2.sql(db2.schema)}.public_interface_events WHERE net = ${NET} ORDER BY event_id`;
    expect(split.map((r) => [r.event_id, r.parts])).toEqual([["20", 1], ["21", 1]]);
    expect(split[0]!.url).toBe(url.slice(0, 224));
    expect(await currentOf(db2, CONTRACT)).toEqual({ eventId: 21, publications: 2 });
    expect(await drainInterfaceVerifications(db2.sql, db2.schema, NET, deps(state, T0))).toMatchObject({ attempted: 2, unfetchable: 2 });
    expect((await row(db2, 20)).reason).toMatch(/HTTP 404/);
    expect((await row(db2, 21)).reason).toMatch(/is not a URL/);
  }, 180_000);
});

describe("public-interface configuration (C7)", () => {
  it("defaults, overrides and refusals of the TOKEN_INTERFACE_* variables", async () => {
    const { loadConfig, DEFAULT_INTERFACE_CONFIG } = await import("../config.js");
    expect(loadConfig({ PG_URL: "postgres://x" }).interfaces).toEqual({
      ...DEFAULT_INTERFACE_CONFIG, limits: { ...DEFAULT_INTERFACE_CONFIG.limits }, level3: { ...DEFAULT_INTERFACE_CONFIG.level3 },
    });
    expect(DEFAULT_INTERFACE_CONFIG).toMatchObject({ recheckMs: 86_400_000, allowPrivateHosts: false, level3: { enabled: true, compactBin: "compact" } });
    const custom = loadConfig({
      PG_URL: "postgres://x", TOKEN_INTERFACE_RECHECK_MS: "60000", TOKEN_INTERFACE_FETCH_DEADLINE_MS: "5000",
      TOKEN_INTERFACE_MAX_BUNDLE_BYTES: "1000", TOKEN_INTERFACE_L3: "off", COMPACT_BIN: "/opt/compact", TOKEN_INTERFACE_ALLOW_PRIVATE_HOSTS: "1",
    }).interfaces!;
    expect(custom).toMatchObject({ recheckMs: 60_000, fetchDeadlineMs: 5_000, allowPrivateHosts: true, limits: { maxBundleBytes: 1_000 }, level3: { enabled: false, compactBin: "/opt/compact" } });
    expect(() => loadConfig({ PG_URL: "postgres://x", TOKEN_INTERFACE_ALLOW_PRIVATE_HOSTS: "yes" })).toThrow(/TOKEN_INTERFACE_ALLOW_PRIVATE_HOSTS/);
    expect(() => loadConfig({ PG_URL: "postgres://x", TOKEN_INTERFACE_RECHECK_MS: "5" })).toThrow(/TOKEN_INTERFACE_RECHECK_MS/);
  });
});
