import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { drainDepsFromConfig, drainInterfaceVerifications, retryBackoffMs, verifyInterfaceNow, type DrainDeps } from "../interface/drain.js";
import { DEFAULT_LEVEL1_LIMITS } from "../interface/level1.js";
import type { StateObservation, StateSource } from "../interface/level2.js";
import { markInterfaceStale } from "../interface/store.js";
import { startBundleHost, type BundleHost, type Route } from "./helpers/bundle-host.js";
import { startFakeEventIndexer, type FakeEventIndexer } from "./helpers/fake-event-indexer.js";
import { InterfaceChain, NET, currentOf, partsOf } from "./helpers/interface-chain.js";
import { clone, fixtureHex, loadFixtureBundle, payloadFor, wrongHash, type Bundle } from "./helpers/pi-fixture.js";

/**
 * Project 00024-02 task C7 — the verification drain, end to end: synthetic chain → the real scanner
 * → publications stored `pending` → `drainInterfaceVerifications` (outside the scan's transaction) →
 * the guarded HTTP transport against a real local bundle host (TEST-ONLY private-host bypass on) →
 * Level 2 against a stub state provider → Level 3 on the stand-in compiler → the result, its history
 * and its schedule in `public_interface_events` / `public_interface_checks`.
 * Spec FR-010, FR-011, FR-011b, FR-012, Q14, UC-2; plan `plans/00024-02-public-interface.md` C7.
 * Task C9 (owner Q25, UC-13): a host that does not deliver → `unreachable`, no level claimed,
 * retried with exponential backoff; a later delivery is verified from Level 1.
 */

const STAND_IN = fileURLToPath(new URL("./helpers/fake-compact.mjs", import.meta.url));
const CONTRACT = "d7".repeat(32);
const RECHECK = 3_600_000;
/** The test clock: set when each test starts, ten minutes after the real clock — the scan schedules a
 *  first check at the database's `now()`, so it must be due at T0 however long the run takes. */
let T0 = new Date();
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

  beforeEach(() => { T0 = new Date(Math.ceil(Date.now() / 1000) * 1000 + 600_000); });

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
    expect(first).toEqual({ attempted: 1, verified: 1, failed: 0, unchecked: 0, unfetchable: 0, unreachable: 0, discarded: 0 });
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

  it("[[interface-recheck]] the current publication is re-verified on its timer and on demand; bytes changed on the host → failed at L1 with 'verified until'; a limit is retried with backoff; a verified one whose host goes away → unreachable with 'verified until'", async () => {
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

    // The host goes away (C9, owner Q25): at the next re-check the current, VERIFIED publication is
    // unreachable — no level claimed, not failed — and keeps "verified until" its last verified check.
    const lastVerified = at(RECHECK + 180_000 + 31_000);
    expect((await row(db, 10)).last_verified_at).toEqual(lastVerified);
    host.routes.set("/pi/index.json", { kind: "status", status: 503 });
    const awayAt = new Date(lastVerified.getTime() + RECHECK);
    const away = await drainInterfaceVerifications(db.sql, db.schema, NET, deps(state, awayAt));
    expect(away).toMatchObject({ attempted: 1, unreachable: 1, failed: 0 });
    const gone = await row(db, 10);
    expect(gone).toMatchObject({ status: "unreachable", level: 0, l1: "not_run", l2: "not_run", l3: "not_run", failed_level: null, attempts: 1 });
    expect(gone.reason).toMatch(/^the host did not deliver: index\.json: http:\/\/127\.0\.0\.1:\d+\/pi\/index\.json returned HTTP 503$/);
    expect(gone.last_verified_at).toEqual(lastVerified);
    expect(gone.verified_until).toEqual(lastVerified); // "verified until <time>"
    expect(gone.next_check_at).toEqual(new Date(awayAt.getTime() + retryBackoffMs(1, RECHECK)));
    expect(await currentOf(db, CONTRACT)).toEqual({ eventId: 10, publications: 2 });
    expect((await history(db, 10)).at(-1)).toMatchObject({ trigger: "recheck", status: "unreachable", level: 0 });
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
    // Part 1's truncated URL is not served (the host did not deliver: unreachable, C9); part 2 is not
    // a URL at all (a policy refusal: unfetchable).
    expect(await drainInterfaceVerifications(db2.sql, db2.schema, NET, deps(state, T0))).toMatchObject({ attempted: 2, unreachable: 1, unfetchable: 1 });
    expect(await row(db2, 20)).toMatchObject({ status: "unreachable", level: 0, reason: expect.stringMatching(/HTTP 404/) });
    expect(await row(db2, 21)).toMatchObject({ status: "unfetchable", level: 0, reason: expect.stringMatching(/is not a URL/) });
  }, 180_000);

  it("[[interface-unreachable-backoff]] a host that does not deliver is retried with exponential backoff — base · 2^(n−1), capped, configurable and zod-validated; nothing is due before its time; every kind of non-delivery keeps the same schedule and claims no level", async () => {
    // --- the delay: doubles from the base, then stays at the cap (and never beyond the re-check) ----
    const configured = { baseMs: 1_000, capMs: 8_000 };
    expect(Array.from({ length: 8 }, (_, i) => retryBackoffMs(i + 1, RECHECK, configured)))
      .toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000, 8_000]);
    expect(Array.from({ length: 9 }, (_, i) => retryBackoffMs(i + 1, 86_400_000))) // the defaults: 30 s … 1 h
      .toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000]);
    expect(retryBackoffMs(3, 3_000, configured)).toBe(3_000);
    expect(retryBackoffMs(0, RECHECK, configured)).toBe(1_000);
    expect(retryBackoffMs(2_000_000_000, RECHECK, configured)).toBe(8_000); // 2^n overflows; the cap wins

    // --- configured through the environment, validated like the other TOKEN_INTERFACE_* variables --
    const { loadConfig } = await import("../config.js");
    const env = { PG_URL: "postgres://x" };
    expect(loadConfig(env).interfaces!.retry).toEqual({ baseMs: 30_000, capMs: 3_600_000 });
    const fromEnv = loadConfig({ ...env, TOKEN_INTERFACE_RETRY_BASE_MS: "1000", TOKEN_INTERFACE_RETRY_CAP_MS: "8000" }).interfaces!;
    expect(fromEnv.retry).toEqual(configured);
    expect(drainDepsFromConfig(fromEnv, "http://indexer.test/api/v4/graphql").retryBackoff).toEqual(configured);
    expect(() => loadConfig({ ...env, TOKEN_INTERFACE_RETRY_BASE_MS: "10" })).toThrow(/TOKEN_INTERFACE_RETRY_BASE_MS/);
    expect(() => loadConfig({ ...env, TOKEN_INTERFACE_RETRY_CAP_MS: "soon" })).toThrow(/TOKEN_INTERFACE_RETRY_CAP_MS/);
    expect(() => loadConfig({ ...env, TOKEN_INTERFACE_RETRY_BASE_MS: "9000", TOKEN_INTERFACE_RETRY_CAP_MS: "8000" }))
      .toThrow(/TOKEN_INTERFACE_RETRY_CAP_MS: must be at least TOKEN_INTERFACE_RETRY_BASE_MS \(9000\)/);

    // --- end to end: a host that never delivers, each drain run exactly when the row is due ---------
    const db = await chain.freshDb("backoff");
    const state = new StubState();
    const path = "/down/index.json";
    await chain.scan(db, [publish("0b".repeat(32), 100, 10, payloadFor(bundle, `${host.origin}${path}`))]);
    const d = (now: Date) => deps(state, now, { retryBackoff: fromEnv.retry });
    // One way of not delivering per attempt; the schedule does not care which.
    const behaviours: [Route | undefined, RegExp][] = [
      [{ kind: "status", status: 503 }, /HTTP 503$/],
      [{ kind: "reset" }, /(ECONNRESET|socket hang up)$/],
      [undefined, /HTTP 404$/], // nothing served
      [{ kind: "redirect", location: path }, /more than 3 redirects$/],
      [{ kind: "body", body: Buffer.from("{}"), headers: { "content-encoding": "gzip" } }, /Content-Encoding "gzip"; only the identity bytes can be checked$/],
      [{ kind: "status", status: 500 }, /HTTP 500$/],
      [{ kind: "status", status: 503 }, /HTTP 503$/],
    ];
    let now = T0;
    const delays: number[] = [];
    for (const [n, [route, why]] of behaviours.entries()) {
      host.routes.clear();
      if (route !== undefined) host.routes.set(path, route);
      host.requests.length = 0;
      expect(await drainInterfaceVerifications(db.sql, db.schema, NET, d(now)), `attempt ${n + 1}`).toMatchObject({ attempted: 1, unreachable: 1 });
      expect(host.requests.length, `attempt ${n + 1}`).toBeGreaterThan(0);
      expect(host.requests.every((r) => r.path === path), `attempt ${n + 1}`).toBe(true); // nothing past index.json
      const r = await row(db, 10);
      expect(r, `attempt ${n + 1}`).toMatchObject({ status: "unreachable", level: 0, l1: "not_run", l2: "not_run", l3: "not_run", failed_level: null, attempts: n + 1, checks: n + 1 });
      expect(r.reason, `attempt ${n + 1}`).toMatch(/^the host did not deliver: index\.json: /);
      expect(r.reason, `attempt ${n + 1}`).toMatch(why);
      delays.push(r.next_check_at!.getTime() - now.getTime());
      // One millisecond early, nothing is due.
      expect((await drainInterfaceVerifications(db.sql, db.schema, NET, d(new Date(r.next_check_at!.getTime() - 1)))).attempted, `attempt ${n + 1}`).toBe(0);
      now = r.next_check_at!;
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000]);
    expect(state.calls).toBe(0); // no level claimed: the contract state was never read
    const checks = await history(db, 10);
    expect(checks.map((h) => [h.trigger, h.status, h.level])).toEqual([
      ["initial", "unreachable", 0], ...Array.from({ length: 6 }, () => ["retry", "unreachable", 0]),
    ]);
    const last = await row(db, 10);
    expect(last.report).toMatchObject({ status: "unreachable", completedLevel: 0, state: null, operations: [], levels: { l1: { status: "not_run", outcome: "unreachable", file: "index.json" }, l2: { status: "not_run" }, l3: { status: "not_run" } } });
    expect(last.last_verified_at).toBeNull();
    expect(last.verified_until).toBeNull();
  }, 180_000);

  it("[[interface-unreachable-recovery]] unreachable → delivered → verified: a publication whose host did not deliver claims no level, and once the host delivers the retry verifies it from Level 1; a verified one whose listed file goes missing is unreachable with 'verified until' and recovers the same way", async () => {
    const db = await chain.freshDb("recovery");
    const state = new StubState();
    const url = `${host.origin}/later/index.json`; // nothing served there yet: HTTP 404
    await chain.scan(db, [publish("0c".repeat(32), 100, 10, payloadFor(bundle, url))]);
    const d = (now: Date) => deps(state, now, { retryBackoff: { baseMs: 1_000, capMs: 8_000 } });
    const wholeBundle = ["/later/index.json", ...[...bundle.keys()].filter((p) => p !== "index.json").sort().map((p) => `/later/${p}`)];

    // --- 1. never delivered: unreachable, no level, only index.json asked, retried after the base ---
    expect(await drainInterfaceVerifications(db.sql, db.schema, NET, d(T0)))
      .toEqual({ attempted: 1, verified: 0, failed: 0, unchecked: 0, unfetchable: 0, unreachable: 1, discarded: 0 });
    const u = await row(db, 10);
    expect(u).toMatchObject({ status: "unreachable", level: 0, l1: "not_run", l2: "not_run", l3: "not_run", failed_level: null, attempts: 1, checks: 1, last_verified_at: null, verified_until: null });
    expect(u.reason).toMatch(/^the host did not deliver: index\.json: http:\/\/127\.0\.0\.1:\d+\/later\/index\.json returned HTTP 404$/);
    expect(u.next_check_at).toEqual(at(1_000));
    expect(u.report).toMatchObject({ status: "unreachable", completedLevel: 0, levels: { l1: { status: "not_run", outcome: "unreachable", file: "index.json" } } });
    expect(host.requests.map((r) => r.path)).toEqual(["/later/index.json"]);
    expect(state.calls).toBe(0);

    // --- 2. the host now delivers: the retry verifies it, starting again at Level 1 -----------------
    host.mount("/later/", bundle);
    host.requests.length = 0;
    expect(await drainInterfaceVerifications(db.sql, db.schema, NET, d(at(1_000)))).toMatchObject({ attempted: 1, verified: 1, unreachable: 0 });
    const v = await row(db, 10);
    expect(v).toMatchObject({ status: "verified", level: 3, l1: "passed", l2: "passed", l3: "passed", reason: null, failed_level: null, attempts: 0, checks: 2, verified_until: null });
    expect(v.last_verified_at).toEqual(at(1_000));
    expect(v.next_check_at).toEqual(at(1_000 + RECHECK)); // back on the re-check timer
    expect(host.requests.map((r) => r.path)).toEqual(wholeBundle); // index.json first, then every listed file
    expect(state.calls).toBe(1);

    // --- 3. a listed file goes missing on the host: unreachable (not failed), "verified until" ----
    host.files.delete("/later/out/keys/read.verifier");
    expect(await drainInterfaceVerifications(db.sql, db.schema, NET, d(at(1_000 + RECHECK)))).toMatchObject({ attempted: 1, unreachable: 1, failed: 0 });
    const g = await row(db, 10);
    expect(g).toMatchObject({ status: "unreachable", level: 0, l1: "not_run", l2: "not_run", l3: "not_run", failed_level: null, attempts: 1, checks: 3 });
    expect(g.reason).toMatch(/^the host did not deliver: out\/keys\/read\.verifier: http:\/\/127\.0\.0\.1:\d+\/later\/out\/keys\/read\.verifier returned HTTP 404$/);
    expect(g.last_verified_at).toEqual(at(1_000));
    expect(g.verified_until).toEqual(at(1_000)); // "verified until <time>"
    expect(g.next_check_at).toEqual(at(1_000 + RECHECK + 1_000));
    expect((await drainInterfaceVerifications(db.sql, db.schema, NET, d(at(1_000 + RECHECK + 999)))).attempted).toBe(0);

    // --- 4. the file is back: verified again from Level 1, "verified until" cleared -----------------
    host.mount("/later/", bundle);
    host.requests.length = 0;
    expect(await drainInterfaceVerifications(db.sql, db.schema, NET, d(at(1_000 + RECHECK + 1_000)))).toMatchObject({ attempted: 1, verified: 1 });
    const b = await row(db, 10);
    expect(b).toMatchObject({ status: "verified", level: 3, attempts: 0, checks: 4, verified_until: null });
    expect(b.last_verified_at).toEqual(at(1_000 + RECHECK + 1_000));
    expect(host.requests.map((r) => r.path)).toEqual(wholeBundle);
    expect((await history(db, 10)).map((h) => [h.trigger, h.status, h.level])).toEqual([
      ["initial", "unreachable", 0], ["retry", "verified", 3], ["recheck", "unreachable", 0], ["retry", "verified", 3],
    ]);
  }, 180_000);

  it("[[interface-check-ordering]] overlapping checks of one publication are ordered by a database ticket drawn when each starts: an earlier-started check never overwrites a later one's result — even in the same millisecond or on a skewed clock (audit 02 E2-F2, E2-R2A)", async () => {
    const db = await chain.freshDb("ordering");
    const url = serveAt("/pi/", bundle);
    await chain.scan(db, [publish("e1".repeat(32), 100, 10, payloadFor(bundle, url))]);
    await drainInterfaceVerifications(db.sql, db.schema, NET, deps(new StubState(), T0));
    expect(await row(db, 10)).toMatchObject({ status: "verified", level: 3, checks: 1 });

    // Check A (the periodic re-check) has downloaded the honest bundle and is at Level 2 when the
    // host is breached and check B (`verify-interfaces --address`, started later) runs to the end —
    // both on the SAME clock value: no timestamp can order them, the tickets do.
    const slow = new StubState();
    let demanded: Awaited<ReturnType<typeof verifyInterfaceNow>>;
    slow.hook = async () => {
      slow.hook = undefined;
      host.files.set("/pi/out/contract/index.js", Buffer.from("export const breached = true;\n"));
      demanded = await verifyInterfaceNow(db.sql, db.schema, NET, CONTRACT, deps(new StubState(), at(RECHECK)));
    };
    const a = await drainInterfaceVerifications(db.sql, db.schema, NET, deps(slow, at(RECHECK)));
    expect(demanded!).toMatchObject({ eventId: 10, write: "written", result: { status: "failed" } });
    // A verified the bytes it had, but B's later observation is what is stored.
    expect(a).toEqual({ attempted: 1, verified: 0, failed: 0, unchecked: 0, unfetchable: 0, unreachable: 0, discarded: 1 });
    const r = await row(db, 10);
    expect(r).toMatchObject({ status: "failed", level: 0, l1: "failed", failed_level: 1, checks: 2 });
    expect(r.reason).toMatch(/^Level 1: out\/contract\/index\.js: 30 bytes, index\.json says/);
    expect(r.checked_at).toEqual(at(RECHECK));
    expect(r.last_verified_at).toEqual(T0);
    expect(r.verified_until).toEqual(T0);
    expect(r.next_check_at).toEqual(at(2 * RECHECK));
    expect(await history(db, 10)).toMatchObject([
      { check_no: 1, trigger: "initial", status: "verified" }, { check_no: 2, trigger: "on_demand", status: "failed" },
    ]);
    // A check that starts later is written, even on a clock that is BEHIND the stored result's.
    host.mount("/pi/", bundle);
    const skewed = await verifyInterfaceNow(db.sql, db.schema, NET, CONTRACT, deps(new StubState(), at(RECHECK - 60_000)));
    expect(skewed).toMatchObject({ write: "written", result: { status: "verified" } });
    expect(await row(db, 10)).toMatchObject({ status: "verified", checks: 3, verified_until: null });
    // …and the tickets are the database's: strictly increasing, one per check started.
    const tickets = await db.sql<{ result_ticket: string }[]>`SELECT result_ticket::text FROM ${db.sql(db.schema)}.public_interface_events WHERE net = ${NET} AND event_id = 10`;
    expect(BigInt(tickets[0]!.result_ticket)).toBeGreaterThan(2n);
  }, 180_000);

  it("[[interface-hostile-diagnostics]] a bundle-controlled NUL in a diagnostic is stored made safe, and one publication whose result the database refuses never holds up the others (audit 02 E2-F1)", async () => {
    const db = await chain.freshDb("hostile");
    const state = new StubState();
    const OTHER = "d8".repeat(32);
    // index.json's `compiler` is not covered by the commitment: a NUL in its flags keeps the hash and
    // the entries valid, and Level 1 fails on the compiler mismatch with a reason quoting that NUL.
    const hostile = clone(bundle);
    const index = JSON.parse(hostile.get("index.json")!.toString("utf8")) as { compiler: Record<string, unknown> };
    index.compiler.flags = ["\u0000"];
    hostile.set("index.json", Buffer.from(`${JSON.stringify(index, null, 2)}\n`));
    const hostileUrl = serveAt("/hostile/", hostile);
    const goodUrl = serveAt("/pi/", bundle);
    const other = (txHash: string, blockHeight: number, id: number, payload: Buffer) => ({
      ...publish(txHash, blockHeight, id, payload), contract: OTHER,
    });
    await chain.scan(db, [
      publish("b1".repeat(32), 100, 10, payloadFor(bundle, hostileUrl)),
      other("b2".repeat(32), 101, 20, payloadFor(bundle, goodUrl)),
    ]);

    // One pass: the hostile one (first in the queue) gets its outcome, the next one is still verified.
    const pass = await drainInterfaceVerifications(db.sql, db.schema, NET, deps(state, T0));
    expect(pass).toEqual({ attempted: 2, verified: 1, failed: 1, unchecked: 0, unfetchable: 0, unreachable: 0, discarded: 0 });
    const h = await row(db, 10);
    expect(h).toMatchObject({ status: "failed", level: 0, l1: "failed", failed_level: 1, checks: 1 });
    expect(h.reason).toMatch(/^Level 1: index\.json names compiler compactc 0\.34\.0 �, but the bundle's package\.json pins compactc 0\.34\.0$/);
    expect(h.reason).not.toContain("\u0000");
    expect(h.next_check_at).toEqual(at(RECHECK));
    expect(await history(db, 10)).toMatchObject([{ check_no: 1, trigger: "initial", status: "failed" }]);
    expect(await row(db, 20)).toMatchObject({ status: "verified", level: 3, checks: 1 });

    // A result the database refuses for any other reason (here a trigger standing in for it): the
    // row gets an `unchecked` internal-error result and its backoff, and the queue moves on.
    await db.sql.unsafe(`
      CREATE FUNCTION ${db.schema}.refuse_verified() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_id = 30 AND NEW.status <> 'unchecked' THEN RAISE EXCEPTION 'refused by the test trigger'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER refuse_verified BEFORE UPDATE ON ${db.schema}.public_interface_events
        FOR EACH ROW EXECUTE FUNCTION ${db.schema}.refuse_verified();
    `);
    await chain.scan(db, [
      publish("b3".repeat(32), 102, 30, payloadFor(bundle, goodUrl)),
      other("b4".repeat(32), 103, 40, payloadFor(bundle, goodUrl)),
    ]);
    const refused = await drainInterfaceVerifications(db.sql, db.schema, NET, deps(state, at(1_000)));
    expect(refused).toMatchObject({ attempted: 2, verified: 1, unchecked: 1, discarded: 0 });
    const r = await row(db, 30);
    expect(r).toMatchObject({ status: "unchecked", level: 0, attempts: 1, checks: 1 });
    expect(r.reason).toMatch(/internal error: Error: the result could not be stored: refused by the test trigger/);
    expect(r.next_check_at).toEqual(at(1_000 + 30_000)); // the retry backoff, not the front of the queue
    expect(await row(db, 40)).toMatchObject({ status: "verified", level: 3 });

    // No provider credential is stored or served (E2-F4, E2-R2B): the configured INDEXER_HTTP may
    // carry one in its userinfo, path, query or fragment. A publication that passes Level 1 reaches
    // the state request, which fetch refuses in an error QUOTING that URL: the record names the
    // provider by its origin only and the reason carries none of it.
    await db.sql.unsafe(`DROP TRIGGER refuse_verified ON ${db.schema}.public_interface_events`);
    const { DEFAULT_INTERFACE_CONFIG } = await import("../config.js");
    const configured = drainDepsFromConfig({ ...DEFAULT_INTERFACE_CONFIG, allowPrivateHosts: true },
      "https://operator:hunter2@provider.invalid/v3/SECRETKEY/graphql?api_key=SECRETQ#SECRETF");
    await chain.scan(db, [publish("b5".repeat(32), 104, 50, payloadFor(bundle, goodUrl))]);
    expect(await drainInterfaceVerifications(db.sql, db.schema, NET, { ...configured, now: () => at(2_000) })).toMatchObject({ attempted: 1, unchecked: 1 });
    const keyed = await row(db, 50);
    expect(keyed).toMatchObject({ status: "unchecked", level: 1, l1: "passed", l2: "not_run" });
    expect(keyed.reason).toMatch(/^Level 2: the contract state is unavailable \(contractAction request failed: TypeError/);
    expect(keyed.report!.observation.stateSource).toBe("indexer contractAction(address) at https://provider.invalid");
    const stored = JSON.stringify(keyed) + JSON.stringify(await history(db, 50));
    for (const secret of ["hunter2", "operator", "SECRETKEY", "SECRETQ", "SECRETF"]) expect(stored, secret).not.toContain(secret);
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
