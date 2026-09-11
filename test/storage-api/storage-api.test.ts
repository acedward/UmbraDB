import { describe, expect, it } from "vitest";
import {
  IllegalLifecycleTransitionError,
  MonitorFencedError,
  MonitorNotFoundError,
  MonitorRevokedError,
} from "../../shielded-monitor/errors.js";
import { HttpMonitorStore } from "../../shielded-monitor/storage-http-client.js";
import type {
  AdvanceResult,
  MonitorRecord,
  ShieldedMonitorStore,
} from "../../shielded-monitor/store.js";
import { ValidationError } from "../../src/interfaces/storage-errors.js";
import { startStorageApi } from "./helpers.js";

/**
 * The storage API's HTTP surface (sub-plan 00009-08 v2), checked against a store DOUBLE rather
 * than a database.
 *
 * The parity suite already proves the two implementations agree against real PostgreSQL. What a
 * double buys is the half that a database cannot easily produce on demand: every typed error at
 * the exact moment it matters, the status codes they map to, the method and routing rules, and
 * the body cap. Each of those is a property of the WIRE, so testing it without a database is not
 * a compromise — it is the right subject.
 *
 * The one property this file exists for above all others: **a stale epoch is a 409, and the
 * client turns it back into the same `MonitorFencedError` the in-process store threw**, with the
 * same rejection and the same observed epoch and state. That is what keeps the scanner's fence
 * handling (organizer spec FR-012, US3 scenario 1) working across the process boundary.
 */

const MONITOR: MonitorRecord = {
  id: "11111111-2222-3333-4444-555555555555",
  net: "undeployed",
  state: "backfilling",
  epoch: 3n,
  coverage: { requestedStart: 0n, scannedFrom: 0n, scannedThrough: 41n },
  matchingRuleVersion: "shielded-monitor/v1",
  ledgerBuild: "ledger-v8@8.1.0-syshash.4",
  createdAt: new Date("2026-09-11T10:00:00.000Z"),
  updatedAt: new Date("2026-09-11T10:05:00.000Z"),
};

/** A store that answers whatever the test told it to, and records what it was asked. */
function stubStore(overrides: Partial<ShieldedMonitorStore> = {}): ShieldedMonitorStore & { calls: string[] } {
  const calls: string[] = [];
  const fail = (name: string) => async (): Promise<never> => {
    calls.push(name);
    throw new Error(`${name} was not stubbed`);
  };
  const base: ShieldedMonitorStore = {
    register: fail("register"),
    get: async (id) => {
      calls.push(`get:${id}`);
      return MONITOR;
    },
    getIncludingRevoked: async () => MONITOR,
    getByFingerprint: async () => undefined,
    listActive: async () => [MONITOR],
    listAll: async () => [MONITOR],
    getKeyMaterial: async () => Uint8Array.from([1, 2, 3, 4]),
    readAssociations: async () => [],
    readAssociationsMissingDetails: async () => [],
    listLifecycleEvents: async () => [],
    advance: fail("advance"),
    updateAssociationDetails: async () => ({ applied: 0 }),
    bindArchiveSource: async () => ({ applied: true, monitor: MONITOR }),
    goLive: async () => MONITOR,
    pause: async () => MONITOR,
    resume: async () => MONITOR,
    markFailed: async () => MONITOR,
    markStaleSource: async () => MONITOR,
    revoke: async () => MONITOR,
    delete: async () => MONITOR,
    recordAudit: async () => undefined,
    listRevocations: async () => [],
    claimMonitorLease: async () => ({ acquired: true }),
    releaseMonitorLease: async () => ({ released: true }),
    readMonitorLease: async () => undefined,
  };
  return Object.assign({ calls }, base, overrides);
}

async function withApi<T>(
  store: ShieldedMonitorStore,
  body: (ctx: { url: string; client: HttpMonitorStore }) => Promise<T>,
  config?: Parameters<typeof startStorageApi>[1],
): Promise<T> {
  const started = await startStorageApi(store, config);
  try {
    return await body({ url: started.baseUrl, client: started.client });
  } finally {
    await started.close();
  }
}

describe("the storage API's monitor-store routes", () => {
  it("answers /v1/health with both wire versions and no archive routes when none are mounted", async () => {
    await withApi(stubStore(), async ({ url }) => {
      const body = (await (await fetch(`${url}/v1/health`)).json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.net).toBe("undeployed");
      expect(body.monitorStoreWireVersion).toBe(1);
      expect(body.archiveRoutes).toBe(false);
    });
  });

  it("[[storage-api.fencing.stale-epoch-is-409-and-rethrown]] turns a stale epoch into 409 MONITOR_FENCED, and the client back into MonitorFencedError", async () => {
    const store = stubStore({
      advance: async () => {
        throw new MonitorFencedError(MONITOR.id, "epoch", { epoch: 9n, state: "paused" });
      },
    });
    await withApi(store, async ({ url, client }) => {
      const raw = await fetch(`${url}/v1/monitor-store/monitors/${MONITOR.id}/advance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedEpoch: "3", throughHeight: "42", associations: [] }),
      });
      expect(raw.status).toBe(409);
      const payload = (await raw.json()) as { error: { code: string; detail?: Record<string, string> } };
      expect(payload.error.code).toBe("MONITOR_FENCED");
      expect(payload.error.detail).toMatchObject({ rejection: "epoch", epoch: "9", state: "paused" });

      // And the round trip: the caller above `HttpMonitorStore` sees the same class it always did.
      await expect(client.advance(MONITOR.id, 3n, 42n, [])).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(MonitorFencedError);
        const fenced = err as MonitorFencedError;
        expect(fenced.rejection).toBe("epoch");
        expect(fenced.observed).toStrictEqual({ epoch: 9n, state: "paused" });
        return true;
      });
    });
  });

  it("maps every typed store error onto its status and back onto its class", async () => {
    const cases: ReadonlyArray<readonly [Error, number, string, (err: unknown) => void]> = [
      [new MonitorNotFoundError(MONITOR.id), 404, "MONITOR_NOT_FOUND", (e) => expect(e).toBeInstanceOf(MonitorNotFoundError)],
      [new MonitorRevokedError(MONITOR.id), 403, "MONITOR_REVOKED", (e) => expect(e).toBeInstanceOf(MonitorRevokedError)],
      [
        new IllegalLifecycleTransitionError("revoked", "resume"),
        409,
        "MONITOR_ILLEGAL_TRANSITION",
        (e) => expect(e).toBeInstanceOf(IllegalLifecycleTransitionError),
      ],
      [
        new ValidationError("bad input", [{ path: "x", message: "nope" }]),
        400,
        "VALIDATION_FAILED",
        (e) => expect(e).toBeInstanceOf(ValidationError),
      ],
    ];
    for (const [thrown, status, code, assertClass] of cases) {
      const store = stubStore({
        get: async () => {
          throw thrown;
        },
      });
      await withApi(store, async ({ url, client }) => {
        const raw = await fetch(`${url}/v1/monitor-store/monitors/${MONITOR.id}`);
        expect(raw.status, code).toBe(status);
        expect(((await raw.json()) as { error: { code: string } }).error.code).toBe(code);
        await client.get(MONITOR.id).then(
          () => expect.unreachable(`${code} must not resolve`),
          (err: unknown) => assertClass(err),
        );
      });
    }
  });

  it("an unexpected error becomes a 500 INTERNAL_ERROR, never a store error the client would misread", async () => {
    const store = stubStore({
      get: async () => {
        throw new Error("the database went away");
      },
    });
    await withApi(store, async ({ url }) => {
      const raw = await fetch(`${url}/v1/monitor-store/monitors/${MONITOR.id}`);
      expect(raw.status).toBe(500);
      expect(((await raw.json()) as { error: { code: string } }).error.code).toBe("INTERNAL_ERROR");
    });
  });

  it("refuses the wrong method with 405 and an Allow header, and an unknown path with 404", async () => {
    await withApi(stubStore(), async ({ url }) => {
      const wrongMethod = await fetch(`${url}/v1/monitor-store/monitors/${MONITOR.id}/advance`);
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get("allow")).toBe("POST");
      expect(((await wrongMethod.json()) as { error: { code: string } }).error.code).toBe("METHOD_NOT_ALLOWED");

      const unknown = await fetch(`${url}/v1/monitor-store/nope`);
      expect(unknown.status).toBe(404);
      const outside = await fetch(`${url}/v2/whatever`);
      expect(outside.status).toBe(404);
    });
  });

  it("caps the request body and refuses an oversized one with 413 rather than buffering it", async () => {
    await withApi(
      stubStore(),
      async ({ url }) => {
        const raw = await fetch(`${url}/v1/monitor-store/monitors/${MONITOR.id}/advance`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pad: "x".repeat(4096) }),
        });
        expect(raw.status).toBe(413);
        expect(((await raw.json()) as { error: { code: string } }).error.code).toBe("PAYLOAD_TOO_LARGE");
      },
      { config: { maxBodyBytes: 1024 } },
    );
  });

  it("refuses a malformed body with 400 before it reaches the store", async () => {
    let advanced = false;
    const store = stubStore({
      advance: async () => {
        advanced = true;
        return { applied: false, reason: "already-advanced", coverage: MONITOR.coverage } as AdvanceResult;
      },
    });
    await withApi(store, async ({ url }) => {
      for (const body of ["{not json", JSON.stringify({ expectedEpoch: -1 }), JSON.stringify({})]) {
        const raw = await fetch(`${url}/v1/monitor-store/monitors/${MONITOR.id}/advance`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        expect(raw.status, body).toBe(400);
        expect(((await raw.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_FAILED");
      }
    });
    expect(advanced, "a malformed body must never reach the store").toBe(false);
  });

  it("carries bigints as decimal strings, so a sequence above 2^53 survives the round trip", async () => {
    // The one value where a JSON number would be wrong in a way nobody notices until it is far
    // too late: `seq` is the consumer's cursor, and a rounded cursor skips or repeats matches.
    const huge = 9_007_199_254_740_995n; // 2^53 + 3, not representable as a JS number
    const store = stubStore({
      advance: async () => ({
        applied: true,
        firstSeq: huge,
        lastSeq: huge + 1n,
        coverage: { requestedStart: 0n, scannedThrough: huge },
        leaseHeld: true,
      }),
    });
    await withApi(store, async ({ url, client }) => {
      const raw = await (
        await fetch(`${url}/v1/monitor-store/monitors/${MONITOR.id}/advance`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedEpoch: "3", throughHeight: "42", associations: [] }),
        })
      ).text();
      expect(raw).toContain('"firstSeq":"9007199254740995"');
      const result = await client.advance(MONITOR.id, 3n, 42n, []);
      expect(result.applied).toBe(true);
      if (result.applied) {
        expect(result.firstSeq).toBe(huge);
        expect(result.lastSeq).toBe(huge + 1n);
        expect(result.leaseHeld).toBe(true);
      }
    });
  });

  it("hands the advance body to the store as ONE call — one call is one transaction", async () => {
    // Rule B in the shape the wire has to preserve: the associations, the through-height, the
    // fence and the lease renewal reach the store together or not at all. A route that made two
    // store calls would be a route whose atomicity the wire cannot promise.
    const seen: unknown[] = [];
    const store = stubStore({
      advance: async (monitorId, epoch, throughHeight, associations, opts) => {
        seen.push({ monitorId, epoch, throughHeight, count: associations.length, opts });
        return { applied: true, firstSeq: 1n, lastSeq: 2n, coverage: MONITOR.coverage, leaseHeld: true };
      },
    });
    await withApi(store, async ({ client }) => {
      await client.advance(
        MONITOR.id,
        3n,
        42n,
        [
          {
            net: "undeployed",
            blockHeight: 42n,
            blockHash: Uint8Array.from([1, 2, 3]),
            position: 0,
            txHash: Uint8Array.from([4, 5, 6]),
            protocolVersion: 1n,
            matchedSegments: [0, 2],
            blockTimestampMs: 1_700_000_000_000n,
          },
        ],
        { fromHeight: 40n, lease: { owner: "scanner-1", ttlMs: 30_000 } },
      );
    });
    expect(seen).toStrictEqual([
      {
        monitorId: MONITOR.id,
        epoch: 3n,
        throughHeight: 42n,
        count: 1,
        opts: { fromHeight: 40n, lease: { owner: "scanner-1", ttlMs: 30_000 } },
      },
    ]);
  });

  it("serves key material only through its own route, and never in a log line", async () => {
    const logged: string[] = [];
    const started = await startStorageApi(stubStore(), { onLog: (line) => logged.push(line) });
    try {
      const client = new HttpMonitorStore(started.baseUrl);
      expect([...(await client.getKeyMaterial(MONITOR.id))]).toStrictEqual([1, 2, 3, 4]);
      // The access log records the route PATTERN and the status, never a body or a raw URL — so a
      // key cannot reach a log through it (organizer spec FR-023, SC-004).
      expect(logged.length).toBeGreaterThan(0);
      expect(logged.join("\n")).toContain("GET /v1/monitor-store/monitors/<id>/key-material");
      expect(logged.join("\n")).not.toContain("AQIDBA==");
      expect(logged.join("\n")).not.toContain(MONITOR.id);
    } finally {
      await started.close();
    }
  });

  it("sets cache-control: no-store on every response", async () => {
    await withApi(stubStore(), async ({ url }) => {
      for (const path of ["/v1/health", `/v1/monitor-store/monitors/${MONITOR.id}`, "/v1/monitor-store/nope"]) {
        expect((await fetch(`${url}${path}`)).headers.get("cache-control"), path).toBe("no-store");
      }
    });
  });
});
