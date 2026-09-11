import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { loadApiConfig } from "../../shielded-monitor/api/config.js";
import { encodeCursor } from "../../shielded-monitor/api/cursor.js";
import {
  createShieldedMonitorApi,
  stderrLogger,
  type ApiLogRecord,
  type ShieldedMonitorApi,
} from "../../shielded-monitor/api/server.js";
import type { SourceTipProvider } from "../../shielded-monitor/api/source-tip.js";
import { INVALID_VIEWING_KEY_MESSAGE } from "../../shielded-monitor/errors.js";
import type { PgShieldedMonitorStore } from "../../shielded-monitor/store.js";
import { encodeViewingKey } from "../../shielded-monitor/viewing-key.js";
import {
  association,
  fixtureViewingKey,
  fixtureViewingKeyEncoded,
  freshStore,
  uniqueSchema,
} from "./helpers.js";

/**
 * The private HTTP API against a real socket and a real PostgreSQL 17 (organizer spec FR-017,
 * FR-019, FR-020, FR-021, FR-023; US1–US3, US6; SC-004).
 *
 * Everything here goes over the loopback network through `fetch` — no handler is called
 * directly. A test that invoked the route functions in-process would pass while the router, the
 * body reader, the status codes and the content types were all wrong, which is most of what this
 * change actually adds.
 *
 * There is no scanner in this stack (Phase 3), so coverage is advanced and associations are
 * seeded through `PgShieldedMonitorStore.advance` — the same trusted path the Phase 2 harness
 * uses. That is a deliberate stand-in for the scanner and it is the right one for THIS change:
 * the API's contract is about what it does with coverage and associations, not about how they
 * came to exist.
 */
describe("shielded-monitor private API", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let store: PgShieldedMonitorStore;
  let api: ShieldedMonitorApi;
  let base: string;
  const schema = uniqueSchema("sm_api");

  /** Every log record the server emitted, for the SC-004 scan. */
  const logRecords: ApiLogRecord[] = [];
  /** Every response body the server returned, for the same scan. */
  const responseBodies: string[] = [];

  /** Controls what the source-tip seam reports, so the `null` case and the observed case are
   *  both exercised against one server (organizer question Q14). */
  let reportedTip: bigint | undefined;
  const tipProvider: SourceTipProvider = { sourceTip: async () => reportedTip };

  interface Call {
    readonly status: number;
    readonly headers: Headers;
    readonly text: string;
    readonly json: Record<string, unknown>;
  }

  /** One HTTP call, recording the raw body for the leak scan. */
  async function call(method: string, path: string, init: RequestInit = {}): Promise<Call> {
    const response = await fetch(`${base}${path}`, { method, ...init });
    const text = await response.text();
    responseBodies.push(text);
    let json: Record<string, unknown> = {};
    if (text !== "") {
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = { "//unparseable": text };
      }
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  async function postJson(path: string, body: unknown): Promise<Call> {
    return call("POST", path, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** Registers a fixture key over HTTP and returns the created monitor id. */
  async function register(seed: number, startHeight: unknown = "earliest"): Promise<string> {
    const created = await postJson("/v1/monitors", {
      viewingKey: await fixtureViewingKeyEncoded(seed),
      startHeight,
    });
    expect(created.status, created.text).toBe(201);
    return created.json.monitorId as string;
  }

  function coverageOf(body: Record<string, unknown>): Record<string, unknown> {
    return body.coverage as Record<string, unknown>;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    ({ sql, store } = await freshStore(container, schema));
    api = createShieldedMonitorApi({
      store,
      // Port 0: the kernel picks a free port. This is a shared host and a fixed port would
      // collide with a parallel suite or with something else on the box entirely.
      config: { ...loadApiConfig({ API_PORT: "0", API_MAX_PAGE: "50" }), schema, maxBodyBytes: 1024 },
      sourceTipProvider: tipProvider,
      logger: { log: (record) => logRecords.push(record) },
    });
    const address = await api.listen();
    base = `http://127.0.0.1:${address.port}`;
  }, 240_000);

  afterAll(async () => {
    await api?.close();
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  // ── Boot and health (US6 scenario 2) ───────────────────────────────────────────────────────

  it("boots healthy and idle against an empty monitor table (US6 scenario 2)", async () => {
    const health = await call("GET", "/v1/health");
    expect(health.status).toBe(200);
    expect(health.json).toMatchObject({ status: "ok", net: "undeployed" });
    expect(await store.listActive()).toHaveLength(0);
  });

  it("binds loopback by default (FR-018)", () => {
    expect(loadApiConfig({}).host).toBe("127.0.0.1");
  });

  // ── Registration (US1, FR-017) ─────────────────────────────────────────────────────────────

  describe("POST /v1/monitors", () => {
    it("creates a monitor in `backfilling`, with coverage, and never echoes the key (US1 scenario 1)", async () => {
      const encoded = await fixtureViewingKeyEncoded(101);
      const created = await postJson("/v1/monitors", { viewingKey: encoded, startHeight: 0 });

      expect(created.status).toBe(201);
      expect(created.headers.get("content-type")).toMatch(/^application\/json/);
      expect(created.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.json.state).toBe("backfilling");
      expect(created.json.monitorId).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.json.net).toBe("undeployed");

      // No key, no fingerprint, anywhere in the response — asserted over the raw text, not over
      // named fields, so a field added later cannot slip one through.
      expect(created.text).not.toContain(encoded);
      expect(Object.keys(created.json)).not.toContain("viewingKey");
      expect(created.text.toLowerCase()).not.toContain("fingerprint");

      // Coverage carries all four fields, and "not scanned yet" is null — never zero (FR-020).
      expect(coverageOf(created.json)).toEqual({
        requestedStart: "0",
        scannedFrom: null,
        scannedThrough: null,
        sourceTip: null,
      });
    });

    it("is idempotent per network and key: the second registration answers 200 with the same id (US1 scenario 5)", async () => {
      const encoded = await fixtureViewingKeyEncoded(102);
      const first = await postJson("/v1/monitors", { viewingKey: encoded, startHeight: "earliest" });
      const second = await postJson("/v1/monitors", { viewingKey: encoded, startHeight: 999 });

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.json.monitorId).toBe(first.json.monitorId);
      // The second request's `startHeight` is ignored, as idempotency requires: the monitor is
      // the one that already exists, not a re-registration with new terms.
      expect(coverageOf(second.json).requestedStart).toBe("0");
    });

    it("accepts a start height as a decimal string above 2^53 without rounding", async () => {
      const huge = "9007199254740993"; // 2^53 + 1: unrepresentable as a JSON number
      const created = await postJson("/v1/monitors", {
        viewingKey: await fixtureViewingKeyEncoded(103),
        startHeight: huge,
      });
      expect(created.status).toBe(201);
      expect(coverageOf(created.json).requestedStart).toBe(huge);
    });

    it("refuses a start height above what the column can hold, as a 400 and not a 500", async () => {
      // 2^63 — one past PostgreSQL's signed bigint. Without the boundary check this surfaces as
      // a numeric-overflow fault from the driver, i.e. a server error for a plain client mistake.
      const refused = await postJson("/v1/monitors", {
        viewingKey: await fixtureViewingKeyEncoded(105),
        startHeight: "9223372036854775808",
      });
      expect(refused.status).toBe(400);
      expect((refused.json.error as Record<string, unknown>).code).toBe("VALIDATION_FAILED");
    });

    it.each([
      ["malformed bech32m", "not-a-key"],
      ["a bech32m string for another network", "wrong-network"],
      ["a well-formed envelope with a junk payload", "junk-payload"],
      ["a non-canonical payload (trailing byte)", "non-canonical"],
    ])("refuses %s with ONE generic error (FR-001)", async (_name, kind) => {
      const key = await fixtureViewingKey(200);
      const serialized = key.yesIKnowTheSecurityImplicationsOfThis_serialized();
      const viewingKey =
        kind === "not-a-key"
          ? "definitely not bech32m"
          : kind === "wrong-network"
            ? encodeViewingKey(serialized, "preview")
            : kind === "junk-payload"
              ? encodeViewingKey(Uint8Array.from([0xff, 0xff, 0xff, 0xff]), "undeployed")
              : encodeViewingKey(Uint8Array.from([...serialized, 0xaa]), "undeployed");

      const refused = await postJson("/v1/monitors", { viewingKey });
      expect(refused.status).toBe(400);
      expect((refused.json.error as Record<string, unknown>).code).toBe("INVALID_VIEWING_KEY");
      // Byte-identical across every failure class: a caller must not learn WHICH check failed.
      expect((refused.json.error as Record<string, unknown>).message).toBe(INVALID_VIEWING_KEY_MESSAGE);
    });

    it("rejects an unknown body field rather than silently ignoring it", async () => {
      const refused = await postJson("/v1/monitors", {
        viewingKey: await fixtureViewingKeyEncoded(104),
        startheight: 5, // lower-case 'h': a real typo, not a synthetic one
      });
      expect(refused.status).toBe(400);
      expect((refused.json.error as Record<string, unknown>).code).toBe("VALIDATION_FAILED");
    });

    it("refuses a body one byte over the cap with 400 BODY_TOO_LARGE (FR-021)", async () => {
      const oversized = "x".repeat(api.config.maxBodyBytes + 1);
      const refused = await call("POST", "/v1/monitors", {
        headers: { "content-type": "application/json" },
        body: oversized,
      });
      expect(refused.status).toBe(400);
      expect((refused.json.error as Record<string, unknown>).code).toBe("BODY_TOO_LARGE");
      // The offending body is not echoed back.
      expect(refused.text).not.toContain("xxxx");
    });

    it("refuses a non-JSON content type with 415", async () => {
      const refused = await call("POST", "/v1/monitors", {
        headers: { "content-type": "text/plain" },
        body: "{}",
      });
      expect(refused.status).toBe(415);
    });

    it("refuses a malformed JSON body without quoting it", async () => {
      const refused = await call("POST", "/v1/monitors", {
        headers: { "content-type": "application/json" },
        body: '{"viewingKey": "mn_shield-esk_undeployed1secret", ',
      });
      expect(refused.status).toBe(400);
      expect(refused.text).not.toContain("mn_shield-esk");
    });
  });

  // ── Status, unknown, revoked, deleted ──────────────────────────────────────────────────────

  describe("GET /v1/monitors/:id", () => {
    it("returns the monitor view", async () => {
      const id = await register(110);
      const got = await call("GET", `/v1/monitors/${id}`);
      expect(got.status).toBe(200);
      expect(got.json.monitorId).toBe(id);
      expect(got.json.ledgerBuild).toBe("ledger-v8@8.1.0-syshash.4");
    });

    it("answers 404 for an unknown id and for a malformed one, indistinguishably", async () => {
      const unknown = await call("GET", `/v1/monitors/${randomUUID()}`);
      const malformed = await call("GET", "/v1/monitors/not-a-uuid");
      expect(unknown.status).toBe(404);
      expect(malformed.status).toBe(404);
    });

    it("answers 405 with an `allow` header for a wrong verb, and 404 for an unknown route", async () => {
      const id = await register(111);
      const wrongVerb = await call("PUT", `/v1/monitors/${id}`);
      expect(wrongVerb.status).toBe(405);
      expect(wrongVerb.headers.get("allow")?.split(", ").sort()).toEqual(["DELETE", "GET"]);

      expect((await call("GET", "/v2/monitors")).status).toBe(404);
      expect((await call("GET", `/v1/monitors/${id}/nonsense`)).status).toBe(404);
    });
  });

  // ── Coverage (FR-011, FR-020, US2 scenario 3) ──────────────────────────────────────────────

  describe("coverage", () => {
    it("distinguishes not-scanned-yet from scanned-and-empty (FR-020, US2 scenario 1)", async () => {
      const id = await register(120);
      const monitor = await store.getIncludingRevoked(id);

      const before = await call("GET", `/v1/monitors/${id}/matches`);
      expect(before.status).toBe(200);
      expect(before.json.items).toEqual([]);
      expect(coverageOf(before.json)).toMatchObject({ scannedFrom: null, scannedThrough: null });
      // The FR-020 assertion, spelled out: an unscanned range must not render as height zero.
      expect(coverageOf(before.json).scannedThrough).not.toBe("0");

      // Advance over a range with NO matches — the scanner's normal empty-block case.
      const advanced = await store.advance(id, monitor!.epoch, 40n, []);
      expect(advanced.applied).toBe(true);

      const after = await call("GET", `/v1/monitors/${id}/matches`);
      expect(after.json.items).toEqual([]);
      expect(coverageOf(after.json)).toMatchObject({ scannedFrom: "0", scannedThrough: "40" });
      // Same empty page, different coverage: the two states ARE distinguishable, which is the
      // entire content of FR-020.
      expect(coverageOf(after.json)).not.toEqual(coverageOf(before.json));
    });

    it("reports sourceTip when a provider observes it, and null when none does (Q14)", async () => {
      const id = await register(121);

      reportedTip = undefined;
      const unknownTip = await call("GET", `/v1/monitors/${id}`);
      expect(coverageOf(unknownTip.json).sourceTip).toBeNull();

      reportedTip = 123_456n;
      const knownTip = await call("GET", `/v1/monitors/${id}`);
      expect(coverageOf(knownTip.json).sourceTip).toBe("123456");

      // The gap between coverage and the tip is visible as three separate numbers, never
      // collapsed into "no matches" (US2 scenario 3).
      expect(coverageOf(knownTip.json)).toEqual({
        requestedStart: "0",
        scannedFrom: null,
        scannedThrough: null,
        sourceTip: "123456",
      });
      reportedTip = undefined;
    });
  });

  // ── Matches and the cursor (FR-019) ────────────────────────────────────────────────────────

  describe("GET /v1/monitors/:id/matches", () => {
    const TOTAL = 37;
    let pagedId: string;

    beforeAll(async () => {
      pagedId = await register(130);
      const monitor = await store.getIncludingRevoked(pagedId);
      // 37 associations spread over 8 heights with several per height, deliberately handed to
      // the store OUT of (height, position) order so the ordering guarantee is the store's
      // structural one and not an artefact of how the test happened to build its array.
      const batch = [];
      for (let i = 0; i < TOTAL; i += 1) {
        batch.push(association(BigInt(100 + (i % 8)), Math.floor(i / 8)));
      }
      batch.reverse();
      const result = await store.advance(pagedId, monitor!.epoch, 200n, batch);
      expect(result.applied).toBe(true);
    }, 120_000);

    it("[[shielded-monitor.api.cursor-pages-each-match-exactly-once]] pages every match exactly once, in (blockHeight, position) order", async () => {
      const seen: Array<{ blockHeight: string; position: number; txHash: string }> = [];
      let cursor: string | undefined;
      // Bounded: 37 items at 5 per page is 8 pages, so 20 iterations is generous and a runaway
      // loop fails the test instead of hanging the suite.
      for (let page = 0; page < 20; page += 1) {
        const query = new URLSearchParams({ limit: "5" });
        if (cursor !== undefined) query.set("cursor", cursor);
        const response = await call("GET", `/v1/monitors/${pagedId}/matches?${query.toString()}`);
        expect(response.status).toBe(200);
        const items = response.json.items as Array<Record<string, unknown>>;
        seen.push(
          ...items.map((item) => ({
            blockHeight: item.blockHeight as string,
            position: item.position as number,
            txHash: item.txHash as string,
          })),
        );
        cursor = response.json.nextCursor as string;
        if (items.length < 5) break;
      }

      expect(seen).toHaveLength(TOTAL);
      // No duplicates: the identity of an association is (height, position).
      expect(new Set(seen.map((s) => `${s.blockHeight}:${s.position}`)).size).toBe(TOTAL);
      // Exactly the seeded set, and in (blockHeight, position) order.
      const sorted = [...seen].sort((a, b) =>
        a.blockHeight === b.blockHeight
          ? a.position - b.position
          : BigInt(a.blockHeight) < BigInt(b.blockHeight)
            ? -1
            : 1,
      );
      expect(seen).toEqual(sorted);
      // And it really is the whole set the store holds, not just a self-consistent subset.
      const fromStore = await store.readAssociations(pagedId, 0n, 1000);
      expect(seen.map((s) => s.txHash)).toEqual(fromStore.map((a) => a.txHash.toString("hex")));
    });

    it("returns the same page for the same cursor", async () => {
      const first = await call("GET", `/v1/monitors/${pagedId}/matches?limit=7`);
      const cursor = (first.json.items as Array<Record<string, unknown>>)[2]!.cursor as string;
      const a = await call("GET", `/v1/monitors/${pagedId}/matches?limit=7&cursor=${cursor}`);
      const b = await call("GET", `/v1/monitors/${pagedId}/matches?limit=7&cursor=${cursor}`);
      expect(a.json.items).toEqual(b.json.items);
      expect(a.json.nextCursor).toBe(b.json.nextCursor);
    });

    it("returns the caller's own cursor at the end of the stream, so a poller keeps its place", async () => {
      const all = await call("GET", `/v1/monitors/${pagedId}/matches?limit=50`);
      const end = all.json.nextCursor as string;
      const beyond = await call("GET", `/v1/monitors/${pagedId}/matches?limit=50&cursor=${end}`);
      expect(beyond.json.items).toEqual([]);
      expect(beyond.json.nextCursor).toBe(end);
      // Coverage still travels with the empty page (FR-020).
      expect(coverageOf(beyond.json).scannedThrough).toBe("200");
    });

    it("refuses a cursor minted for another monitor (FR-019)", async () => {
      const other = await register(131);
      const foreign = encodeCursor(other, 3n);
      const refused = await call("GET", `/v1/monitors/${pagedId}/matches?cursor=${foreign}`);
      expect(refused.status).toBe(400);
      expect((refused.json.error as Record<string, unknown>).code).toBe("INVALID_CURSOR");
      expect(refused.json.items).toBeUndefined();
    });

    it.each(["not-base64url!", "YWJjZA==", Buffer.from("garbage").toString("base64url")])(
      "refuses the malformed cursor %s",
      async (cursor) => {
        const refused = await call(
          "GET",
          `/v1/monitors/${pagedId}/matches?cursor=${encodeURIComponent(cursor)}`,
        );
        expect(refused.status).toBe(400);
      },
    );

    it.each(["0", "-1", "abc", "51"])("refuses limit=%s (FR-021)", async (limit) => {
      const refused = await call("GET", `/v1/monitors/${pagedId}/matches?limit=${limit}`);
      expect(refused.status).toBe(400);
      expect((refused.json.error as Record<string, unknown>).code).toBe("VALIDATION_FAILED");
    });

    it("exposes appliedOutcome `unknown` and the matched segments (US1 scenarios 2 and 3)", async () => {
      const page = await call("GET", `/v1/monitors/${pagedId}/matches?limit=1`);
      const item = (page.json.items as Array<Record<string, unknown>>)[0]!;
      expect(item.appliedOutcome).toBe("unknown");
      expect(item.matchedSegments).toEqual([0]);
      expect(item.protocolVersion).toBe("1");
      expect(item.matchingRuleVersion).toBe("shielded-monitor/v1");
    });

    it("carries sourceOutcome when the archive recorded one, without replacing appliedOutcome (FR-009)", async () => {
      const id = await register(132);
      const monitor = await store.getIncludingRevoked(id);
      await store.advance(id, monitor!.epoch, 10n, [
        association(10n, 0, { sourceOutcome: "success" }),
      ]);
      const page = await call("GET", `/v1/monitors/${id}/matches`);
      const item = (page.json.items as Array<Record<string, unknown>>)[0]!;
      expect(item.sourceOutcome).toBe("success");
      expect(item.appliedOutcome).toBe("unknown");
    });
  });

  // ── Lifecycle (US3) ────────────────────────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("pauses, resumes, and refuses a resume that the state machine does not admit", async () => {
      const id = await register(140);

      const paused = await postJson(`/v1/monitors/${id}/pause`, undefined);
      expect(paused.status).toBe(200);
      expect(paused.json.state).toBe("paused");

      const resumed = await postJson(`/v1/monitors/${id}/resume`, undefined);
      expect(resumed.status).toBe(200);
      expect(resumed.json.state).toBe("backfilling");

      const again = await postJson(`/v1/monitors/${id}/resume`, undefined);
      expect(again.status).toBe(409);
      expect((again.json.error as Record<string, unknown>).code).toBe("ILLEGAL_TRANSITION");
    });

    it("keeps matches readable while paused (US3 scenario 1)", async () => {
      const id = await register(141);
      const monitor = await store.getIncludingRevoked(id);
      await store.advance(id, monitor!.epoch, 5n, [association(5n, 0)]);
      await postJson(`/v1/monitors/${id}/pause`, undefined);

      const page = await call("GET", `/v1/monitors/${id}/matches`);
      expect(page.status).toBe(200);
      expect(page.json.items).toHaveLength(1);
      expect(coverageOf(page.json).scannedThrough).toBe("5");
    });

    it("answers 410 everywhere once revoked, and stays idempotent on revoke (US3 scenario 3)", async () => {
      const id = await register(142);

      const revoked = await postJson(`/v1/monitors/${id}/revoke`, undefined);
      expect(revoked.status).toBe(200);
      expect(revoked.json.state).toBe("revoked");

      expect((await call("GET", `/v1/monitors/${id}`)).status).toBe(410);
      expect((await call("GET", `/v1/monitors/${id}/matches`)).status).toBe(410);
      expect((await postJson(`/v1/monitors/${id}/pause`, undefined)).status).toBe(410);
      expect((await postJson(`/v1/monitors/${id}/resume`, undefined)).status).toBe(410);

      const again = await postJson(`/v1/monitors/${id}/revoke`, undefined);
      expect(again.status).toBe(200);
      expect(again.json.state).toBe("revoked");
    });

    it("refuses to re-register a revoked key (Q11)", async () => {
      const encoded = await fixtureViewingKeyEncoded(143);
      const created = await postJson("/v1/monitors", { viewingKey: encoded });
      await postJson(`/v1/monitors/${created.json.monitorId as string}/revoke`, undefined);

      const retried = await postJson("/v1/monitors", { viewingKey: encoded });
      expect(retried.status).toBe(410);
      expect((retried.json.error as Record<string, unknown>).code).toBe("MONITOR_REVOKED");
    });

    it("deletes, then answers as if the monitor never existed (US3 scenario 4)", async () => {
      const id = await register(144);
      const monitor = await store.getIncludingRevoked(id);
      await store.advance(id, monitor!.epoch, 3n, [association(3n, 0)]);

      const deleted = await call("DELETE", `/v1/monitors/${id}`);
      expect(deleted.status).toBe(204);
      expect(deleted.text).toBe("");

      // Every endpoint, 404 — the same answer a never-issued id gets.
      expect((await call("GET", `/v1/monitors/${id}`)).status).toBe(404);
      expect((await call("GET", `/v1/monitors/${id}/matches`)).status).toBe(404);
      expect((await postJson(`/v1/monitors/${id}/pause`, undefined)).status).toBe(404);
      expect((await call("DELETE", `/v1/monitors/${id}`)).status).toBe(404);

      // And the rows really are gone, not merely hidden.
      const rows = await sql<{ count: bigint }[]>`
        SELECT count(*)::bigint AS count FROM ${sql(schema)}.associations WHERE monitor_id = ${id}
      `;
      expect(rows[0]!.count).toBe(0n);
    });

    it("re-registering a DELETED key mints a fresh monitor (the fingerprint was shed)", async () => {
      const encoded = await fixtureViewingKeyEncoded(145);
      const first = await postJson("/v1/monitors", { viewingKey: encoded });
      await call("DELETE", `/v1/monitors/${first.json.monitorId as string}`);
      const second = await postJson("/v1/monitors", { viewingKey: encoded });
      expect(second.status).toBe(201);
      expect(second.json.monitorId).not.toBe(first.json.monitorId);
    });

    it("surfaces a failed monitor's error CLASS only", async () => {
      const id = await register(146);
      await store.markFailed(id, "test", {
        code: "UNSUPPORTED_PROTOCOL_VERSION",
        message: "an internal message that is not part of the wire contract",
        atHeight: "77",
      });
      const status = await call("GET", `/v1/monitors/${id}`);
      expect(status.json.state).toBe("failed");
      expect(status.json.lastError).toEqual({ code: "UNSUPPORTED_PROTOCOL_VERSION", atHeight: "77" });
      expect(status.text).not.toContain("not part of the wire contract");
    });
  });

  // ── Key hygiene (FR-023, SC-004) ───────────────────────────────────────────────────────────

  describe("no viewing key reaches a log record or an error body (SC-004)", () => {
    /** Every encoding of the fixture key a leak could plausibly take. */
    async function keyEncodings(seed: number): Promise<string[]> {
      const key = await fixtureViewingKey(seed);
      const serialized = key.yesIKnowTheSecurityImplicationsOfThis_serialized();
      const bech32m = await fixtureViewingKeyEncoded(seed);
      return [
        bech32m,
        bech32m.slice(bech32m.lastIndexOf("1") + 1), // the data part alone
        Buffer.from(serialized).toString("hex"),
        Buffer.from(serialized).toString("base64"),
        Buffer.from(serialized).toString("base64url"),
      ];
    }

    function findLeaks(haystacks: readonly string[], needles: readonly string[]): string[] {
      const hits: string[] = [];
      for (const hay of haystacks) {
        for (const needle of needles) {
          if (needle.length >= 8 && hay.includes(needle)) hits.push(needle);
        }
      }
      return hits;
    }

    it("[[shielded-monitor.api.key-never-logged]] finds zero keys after every endpoint has been exercised, and the scan is proven able to find one", async () => {
      // A key that is used ONLY here, so the scan cannot pass because an earlier test happened
      // not to touch it.
      const seed = 900;
      const needles = await keyEncodings(seed);
      const encoded = await fixtureViewingKeyEncoded(seed);

      // Exercise the whole surface with this key, including four failing intakes.
      const created = await postJson("/v1/monitors", { viewingKey: encoded, startHeight: 0 });
      expect(created.status).toBe(201);
      const id = created.json.monitorId as string;
      await postJson("/v1/monitors", { viewingKey: encoded });
      await call("GET", `/v1/monitors/${id}`);
      await call("GET", `/v1/monitors/${id}/matches?limit=3`);
      await postJson("/v1/monitors", { viewingKey: `${encoded}xx` }); // bad checksum
      await postJson("/v1/monitors", { viewingKey: encoded.toUpperCase() }); // mixed-case bech32
      await postJson("/v1/monitors", { viewingKey: encodeViewingKey(
        (await fixtureViewingKey(seed)).yesIKnowTheSecurityImplicationsOfThis_serialized(),
        "preview",
      ) }); // wrong network, SAME key bytes — the nastiest case for a leak
      await call("POST", "/v1/monitors", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewingKey: encoded, unexpected: true }),
      }); // schema failure with the key present in the body
      await postJson(`/v1/monitors/${id}/pause`, undefined);
      await postJson(`/v1/monitors/${id}/revoke`, undefined);
      await call("DELETE", `/v1/monitors/${id}`);

      const logText = logRecords.map((r) => JSON.stringify(r));
      expect(findLeaks(logText, needles)).toEqual([]);
      expect(findLeaks(responseBodies, needles)).toEqual([]);

      // POSITIVE CONTROL (SC-004 requires one): the same scan, over a haystack that really does
      // contain the key, must find it. A leak scanner that cannot detect a leak it was handed is
      // the failure mode this exists to catch — without it, a scan that silently looked at the
      // wrong strings would pass forever.
      const control = findLeaks([`log line containing ${encoded} by mistake`], needles);
      expect(control.length).toBeGreaterThan(0);
    }, 120_000);

    it("logs the route PATTERN, never the raw URL, and never a body", async () => {
      const id = await register(901);
      logRecords.length = 0;
      await call("GET", `/v1/monitors/${id}/matches?limit=3&cursor=${encodeCursor(id, 1n)}`);
      const record = logRecords.at(-1)!;
      expect(record.route).toBe("GET /v1/monitors/:id/matches");
      // The id is not in the log line, so neither is anything else that ever travels in a path.
      expect(JSON.stringify(record)).not.toContain(id);
      expect(Object.keys(record)).not.toContain("body");
    });

    it("logs no error MESSAGE on the create route (the only route where a key exists)", async () => {
      logRecords.length = 0;
      await postJson("/v1/monitors", { viewingKey: "definitely not bech32m" });
      const created = logRecords.at(-1)!;
      expect(created.route).toBe("POST /v1/monitors");
      expect(created.errorCode).toBe("INVALID_VIEWING_KEY");
      expect(created.errorMessage).toBeUndefined();

      // On other routes the message IS logged — it is this repository's own text about ids and
      // states, and withholding it everywhere would make the service undebuggable for no gain.
      logRecords.length = 0;
      await call("GET", `/v1/monitors/${randomUUID()}`);
      expect(logRecords.at(-1)!.errorMessage).toBeDefined();
    });

    it("the DEFAULT stderr logger emits no key either", async () => {
      // The suite above injects a capturing logger, which is not the code a deployment runs.
      // This exercises the real default, capturing the process's own stderr around one request.
      const captured: string[] = [];
      const realWrite = process.stderr.write.bind(process.stderr);
      const local = createShieldedMonitorApi({
        store,
        config: { ...api.config, port: 0 },
        logger: stderrLogger(),
      });
      const address = await local.listen();
      const encoded = await fixtureViewingKeyEncoded(902);
      try {
        process.stderr.write = ((chunk: string | Uint8Array) => {
          captured.push(String(chunk));
          return true;
        }) as typeof process.stderr.write;
        await fetch(`http://127.0.0.1:${address.port}/v1/monitors`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ viewingKey: encoded }),
        });
      } finally {
        process.stderr.write = realWrite;
        await local.close();
      }
      expect(captured.join("")).not.toBe("");
      expect(captured.join("")).not.toContain(encoded);
      expect(captured.join("")).toContain("POST /v1/monitors");
    }, 60_000);
  });
});
