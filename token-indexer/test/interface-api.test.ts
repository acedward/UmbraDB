import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTokenApi, listen } from "../api/server.js";
import type { TokenIndexerConfig } from "../config.js";
import { drainInterfaceVerifications, type DrainDeps } from "../interface/drain.js";
import { DEFAULT_LEVEL1_LIMITS } from "../interface/level1.js";
import type { StateObservation, StateSource } from "../interface/level2.js";
import { startBundleHost, type BundleHost } from "./helpers/bundle-host.js";
import { startFakeEventIndexer, type FakeEventIndexer } from "./helpers/fake-event-indexer.js";
import { InterfaceChain, NET, partsOf } from "./helpers/interface-chain.js";
import { fixtureHex, loadFixtureBundle, payloadFor, wrongHash } from "./helpers/pi-fixture.js";

/**
 * Project 00024-02 task C8 — the public-interface API (spec §5, FR-010, FR-015 additive, FR-016b
 * origins; plan `plans/00024-02-public-interface.md` C8), over real HTTP, on a database the real
 * scanner and the verification drain filled. No page change: `ui/` is untouched in project 02.
 */

const STAND_IN = fileURLToPath(new URL("./helpers/fake-compact.mjs", import.meta.url));
const A = "a1".repeat(32); // publishes a good bundle, then a broken one (current and failed)
const B = "b2".repeat(32); // publishes a good bundle (verified, level 3)
const C = "c3".repeat(32); // publishes, not yet checked (pending)
const D = "d4".repeat(32); // publishes a URL its host does not serve (unreachable, C9 / owner Q25)
const MINT_DOMAIN = "aa".repeat(32);

class StubState implements StateSource {
  readonly description = "stub state provider (test)";
  async stateOf(): Promise<StateObservation> {
    return { state: fixtureHex("state.hex"), blockHeight: 77, txHash: "ee".repeat(32) };
  }
}

describe("public-interface API (C8)", () => {
  let container: StartedPostgreSqlContainer;
  let indexer: FakeEventIndexer;
  let host: BundleHost;
  let chain: InterfaceChain;
  let scratch: string;
  let server: Server;
  let base: string;
  const bundle = loadFixtureBundle();
  let goodUrl = "";
  let badUrl = "";
  let goneUrl = "";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    indexer = await startFakeEventIndexer();
    host = await startBundleHost();
    chain = new InterfaceChain(() => container.getConnectionUri(), () => indexer);
    scratch = mkdtempSync(join(tmpdir(), "umbradb-api-test-"));
    const out = join(scratch, "compile-output");
    for (const d of ["keys", "contract", "compiler"]) mkdirSync(join(out, d), { recursive: true });
    for (const [p, body] of bundle) if (p.startsWith("out/")) writeFileSync(join(out, p.slice(4)), body);
    process.env.FAKE_COMPACT_OUTPUT = out;

    host.mount("/pi/", bundle);
    host.mount("/pi-bad/", wrongHash(bundle));
    goodUrl = `${host.origin}/pi/index.json`;
    badUrl = `${host.origin}/pi-bad/index.json`;
    goneUrl = `${host.origin}/pi-gone/index.json`; // nothing mounted there: HTTP 404
    const pub = (txHash: string, blockHeight: number, contract: string, id: number, url: string, extraCalls = [] as never[]) => ({
      txHash, blockHeight, contract, extraCalls,
      publications: [{ segment: 1, parts: partsOf(payloadFor(bundle, url)).map((p, i) => ({ id: id + i, payload: p })) }],
    });

    const db = await chain.freshDb("api");
    const deps: DrainDeps = {
      stateSource: new StubState(), fetchPolicy: { allowPrivateHosts: true, deadlineMs: 5_000 }, limits: DEFAULT_LEVEL1_LIMITS,
      level3: { compactBin: STAND_IN, deadlineMs: 20_000, tmpRoot: scratch }, recheckMs: 3_600_000,
    };
    // A: a good bundle and, in the same transaction, a mint (so A has a token row).
    await chain.scan(db, [pub("d1".repeat(32), 100, A, 10, goodUrl, [
      { address: A, entryPoint: "mint", segment: 2, guaranteed: { unshielded: { [MINT_DOMAIN]: 1000n } } },
    ] as never[])]);
    await drainInterfaceVerifications(db.sql, db.schema, NET, deps);
    await chain.scan(db, [pub("d2".repeat(32), 101, A, 20, badUrl)]);
    await chain.scan(db, [pub("d3".repeat(32), 102, B, 30, goodUrl)]);
    await drainInterfaceVerifications(db.sql, db.schema, NET, deps);
    await chain.scan(db, [pub("d5".repeat(32), 103, D, 50, goneUrl)]);
    await drainInterfaceVerifications(db.sql, db.schema, NET, deps);
    await chain.scan(db, [pub("d4".repeat(32), 104, C, 40, goodUrl)]);

    const config: TokenIndexerConfig = {
      pgUrl: "", indexerHttp: undefined, net: NET, apiPort: 0, schema: db.schema, archiveSchema: db.archiveSchema,
      scanBatch: 500, live2x: false,
    };
    server = createTokenApi({ sql: db.sql, config });
    base = `http://127.0.0.1:${await listen(server, 0)}`;
  }, 240_000);

  afterAll(async () => {
    delete process.env.FAKE_COMPACT_OUTPUT;
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await chain?.closeAll();
    await host?.close();
    await indexer?.close();
    await container?.stop();
    rmSync(scratch, { recursive: true, force: true });
  }, 60_000);

  async function get(path: string, status = 200): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const res = await fetch(`${base}${path}`);
    if (res.status !== status) console.error(path, res.status, await res.clone().text());
    expect(res.status, path).toBe(status);
    return res.json();
  }

  /** FR-016b on an interface value: origin public-interface, with the publication as evidence. */
  function expectInterfaceOrigin(o: any, eventId: number): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(o.origin).toBe("public-interface");
    expect(o.evidence).toMatchObject({ eventId, partEventIds: expect.any(Array), txHash: expect.stringMatching(/^[0-9a-f]{64}$/), commitment: expect.stringMatching(/^[0-9a-f]{64}$/), levels: expect.any(Object) });
  }

  it("[[interface-api-contract]] GET /v1/interfaces, /v1/contracts/:a/interface and /interface/events; Token.interface and the contract's interface; origins on every interface value; counters", async () => {
    // --- /v1/interfaces: contracts with an interface, newest current publication first ------------
    const list = await get("/v1/interfaces");
    expect(list.items.map((i: any) => [i.address, i.eventId, i.status, i.level, i.role])).toEqual([ // eslint-disable-line @typescript-eslint/no-explicit-any
      [C, 40, "pending", 0, "current"], [D, 50, "unreachable", 0, "current"], [B, 30, "verified", 3, "current"], [A, 20, "failed", 0, "current"],
    ]);
    expect(list.nextCursor).toBeNull();
    const a = list.items[3];
    expect(a).toMatchObject({ publications: 2, url: badUrl, levels: { l1: "failed", l2: "not_run", l3: "not_run" }, failedLevel: 1, parts: 1, segment: 1 });
    expect(a.reason).toMatch(/^Level 1: index\.json's hash/);
    expect(list.items[0]).toMatchObject({ levels: { l1: null, l2: null, l3: null }, checkedAt: null, checks: 0 });
    for (const item of list.items) expectInterfaceOrigin(item.origin, item.eventId);
    expect((await get("/v1/interfaces?status=failed")).items.map((i: any) => i.address)).toEqual([A]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await get("/v1/interfaces?status=verified")).items.map((i: any) => i.address)).toEqual([B]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await get("/v1/interfaces?status=unreachable")).items.map((i: any) => i.address)).toEqual([D]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await get("/v1/interfaces?status=unfetchable")).items).toEqual([]);
    const bad = await get("/v1/interfaces?status=historical", 400);
    expect(bad.error).toMatchObject({ code: "TOKEN_BAD_REQUEST", message: expect.stringMatching(/status must be one of pending, verified, failed, unchecked, unfetchable, unreachable, stale/) });
    const page1 = await get("/v1/interfaces?limit=2");
    expect(page1.items.map((i: any) => i.address)).toEqual([C, D]); // eslint-disable-line @typescript-eslint/no-explicit-any
    const page2 = await get(`/v1/interfaces?limit=2&cursor=${page1.nextCursor}`);
    expect(page2.items.map((i: any) => i.address)).toEqual([B, A]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(page2.nextCursor).toBeNull();
    await get("/v1/interfaces?cursor=not-a-cursor", 400);

    // --- /v1/contracts/:a/interface: the newest publication is current and FAILED; the older one
    //     historical with its own result (FR-010, Q14) ----------------------------------------------
    const ia = await get(`/v1/contracts/${A}/interface`);
    expect(ia).toMatchObject({
      address: A, eventId: 20, role: "current", status: "failed", level: 0, failedLevel: 1, url: badUrl, parts: 1,
      payloadLength: 256, commitment: createHash("sha256").update("x").digest("hex").length === 64 ? expect.stringMatching(/^[0-9a-f]{64}$/) : "",
      files: [], keys: [], circuits: [], witnesses: [], publications: 2,
    });
    expect(ia.payloadSha256).toBe(createHash("sha256").update(payloadFor(bundle, badUrl)).digest("hex"));
    expect(ia.checkHistory).toMatchObject([{ checkNo: 1, trigger: "initial", status: "failed", level: 0, levels: { l1: "failed" } }]);
    expect(ia.history).toHaveLength(1);
    expect(ia.history[0]).toMatchObject({ eventId: 10, role: "historical", status: "verified", level: 3, levels: { l1: "passed", l2: "passed", l3: "passed" }, url: goodUrl, nextCheckAt: null });
    expectInterfaceOrigin(ia.origin, 20);
    expect(ia.origin.evidence).toMatchObject({ status: "failed", level: 0, url: badUrl, blockHeight: 101 });
    expectInterfaceOrigin(ia.history[0].origin, 10);
    expect(ia.report).toMatchObject({ status: "failed", completedLevel: 0, contract: A });

    // --- a verified interface: files, keys and circuits, each with its origin; compiler, build, state
    const ib = await get(`/v1/contracts/${B}/interface`);
    expect(ib).toMatchObject({
      address: B, eventId: 30, role: "current", status: "verified", level: 3, levels: { l1: "passed", l2: "passed", l3: "passed" },
      l3Reason: null, reason: null, failedLevel: null, compiler: { name: "compactc", version: "0.34.0" },
      build: { compiler: "0.34.0", interface: "src/PiFixture.compact" }, witnesses: ["emitterSecret"],
      state: { blockHeight: 77, txHash: "ee".repeat(32) }, history: [], publications: 1,
    });
    expect(ib.files).toHaveLength(10);
    expect(ib.keys.map((k: any) => [k.circuit, k.l2])).toEqual([["guardedIncrement", "OK"], ["increment", "OK"], ["read", "OK"]]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(ib.keys[2].sha256).toBe(createHash("sha256").update(bundle.get("out/keys/read.verifier")!).digest("hex"));
    expect(ib.circuits.map((c: any) => [c.name, c.resultType, c.l2])).toEqual([["increment", "[]", "OK"], ["read", "Uint<64>", "OK"], ["guardedIncrement", "[]", "OK"]]); // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const value of [...ib.files, ...ib.keys, ...ib.circuits]) expectInterfaceOrigin(value.origin, 30);
    expect(ib.lastVerifiedAt).not.toBeNull();
    expect(ib.verifiedUntil).toBeNull();
    // --- an unreachable interface (C9, owner Q25): no level claimed, the delivery named, retried ------
    const id = await get(`/v1/contracts/${D}/interface`);
    expect(id).toMatchObject({
      address: D, eventId: 50, role: "current", status: "unreachable", level: 0, levels: { l1: "not_run", l2: "not_run", l3: "not_run" },
      failedLevel: null, url: goneUrl, lastVerifiedAt: null, verifiedUntil: null, files: [], keys: [], circuits: [], history: [], publications: 1,
    });
    expect(id.reason).toMatch(/^the host did not deliver: index\.json: .*returned HTTP 404$/);
    expect(id.nextCheckAt).not.toBeNull(); // retried with backoff
    expect(id.checkHistory).toMatchObject([{ checkNo: 1, trigger: "initial", status: "unreachable", level: 0 }]);
    expectInterfaceOrigin(id.origin, 50);
    expect(id.origin.evidence).toMatchObject({ status: "unreachable", level: 0 });
    expect((await get(`/v1/contracts/${D}`)).interface).toMatchObject({ eventId: 50, status: "unreachable", level: 0, verifiedUntil: null });

    // A contract without an interface: 404; a malformed address: 400.
    expect((await get(`/v1/contracts/${"0f".repeat(32)}/interface`, 404)).error.code).toBe("TOKEN_NOT_FOUND");
    await get("/v1/contracts/nothex/interface", 400);

    // --- /v1/contracts/:a/interface/events: every publication, newest first, each its own result --
    const events = await get(`/v1/contracts/${A}/interface/events`);
    expect(events.items.map((e: any) => [e.eventId, e.role, e.status, e.level])).toEqual([[20, "current", "failed", 0], [10, "historical", "verified", 3]]); // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const e of events.items) expectInterfaceOrigin(e.origin, e.eventId);
    const ev1 = await get(`/v1/contracts/${A}/interface/events?limit=1`);
    expect(ev1.items.map((e: any) => e.eventId)).toEqual([20]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await get(`/v1/contracts/${A}/interface/events?limit=1&cursor=${ev1.nextCursor}`)).items.map((e: any) => e.eventId)).toEqual([10]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await get(`/v1/contracts/${"0f".repeat(32)}/interface/events`)).items).toEqual([]);

    // --- Token.interface (additive) and the contract route ----------------------------------------
    const tokens = await get("/v1/tokens");
    const minted = tokens.items.find((t: any) => t.address === A); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(minted).toMatchObject({ kind: 0, status: "observed", interface: { eventId: 20, status: "failed", level: 0, levels: { l1: "failed" }, url: badUrl } });
    expectInterfaceOrigin(minted.interface.origin, 20);
    // A token's `origins` keep exactly their 00024-01 fields: the interface carries its own origin.
    expect(Object.keys(minted.origins).sort()).toEqual(["color", "decimals", "metadata", "mints", "name", "status", "symbol", "tokenUri"]);
    for (const t of tokens.items.filter((t: any) => t.status === "builtin")) expect(t.interface).toBeNull(); // eslint-disable-line @typescript-eslint/no-explicit-any
    const one = await get(`/v1/contracts/${A}/tokens/${MINT_DOMAIN}/0`);
    expect(one.interface).toMatchObject({ eventId: 20, status: "failed" });
    const contract = await get(`/v1/contracts/${A}`);
    expect(contract.interface).toMatchObject({ eventId: 20, status: "failed", level: 0 });
    // A contract known only by its publication (no token) is still a contract.
    expect((await get(`/v1/contracts/${B}`)).interface).toMatchObject({ eventId: 30, status: "verified", level: 3 });

    // --- /internal/status counters ------------------------------------------------------------
    const status = await get("/internal/status");
    expect(status.counters).toMatchObject({
      interfaces: 4, interfacePublications: 5, interfacesVerified: 1, interfacesFailed: 1, interfacesWaiting: 1, interfacesUnavailable: 0,
      interfacesUnreachable: 1,
    });
    const c = status.counters;
    expect(c.interfacesVerified + c.interfacesFailed + c.interfacesWaiting + c.interfacesUnavailable + c.interfacesUnreachable).toBe(c.interfaces);
  }, 120_000);
});
