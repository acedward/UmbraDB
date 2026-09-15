import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadApiConfig } from "../../shielded-monitor/api/config.js";
import {
  createShieldedMonitorApi,
  type ApiLogRecord,
  type ShieldedMonitorApi,
} from "../../shielded-monitor/api/server.js";
import { MonitorNotFoundError } from "../../shielded-monitor/errors.js";
import { createDustModule, type DustModule } from "../../shielded-monitor/node/dust/index.js";
import { loadLedger } from "../../shielded-monitor/offers.js";
import type { PgShieldedMonitorStore } from "../../storage-api/monitor-store-pg.js";
import { readDustNodeFixtureEvents, readDustNodeFixtureMeta } from "./dust-fixture.js";
import { brokenDustDb, dustRowsFromFixture, fakeDustDb } from "./dust-harness.js";

/**
 * The five `/v1/dust/*` routes over a REAL HTTP server, against the committed preprod fixture
 * (`spec/00016-dust-wallet-sync.md` §4, §8, Stories 2 and 3; plan 00016 task 2.5).
 *
 * **No Docker.** The routes' database reads are a fake serving rows that project A's own mapper
 * produced from the same 5 000 preprod events (`dust-harness.ts`), and the mirror folds those very
 * events — so the trees and the rows are two views of one chain, as they are in production. What
 * this suite cannot prove is that the SQL in `db.ts` returns those rows; that is
 * `dust-db.integration.test.ts`, which runs the real queries against a real database.
 *
 * Going through the HTTP server rather than calling the module directly is the point of several
 * cases: the 503 codes, the method and path resolution, the body cap, and — the one that is a
 * custody requirement rather than a convenience — what the ACCESS LOG ends up containing.
 */

const meta = readDustNodeFixtureMeta();
const NET = "preprod";

/** Everything the monitor routes reach. This suite drives none of them; the stub exists so the
 *  server can be built without a database. */
const stubStore = {
  listAll: async () => [],
  get: async (id: string) => {
    throw new MonitorNotFoundError(id);
  },
  getIncludingDeleted: async () => undefined,
  getByFingerprint: async () => undefined,
} as unknown as PgShieldedMonitorStore;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ledger: any;
let events: Uint8Array[];
let snapshotDir: string;
let rows: Awaited<ReturnType<typeof dustRowsFromFixture>>;

let api: ShieldedMonitorApi;
let base: string;
let dust: DustModule;
const logs: ApiLogRecord[] = [];

async function startApi(module: DustModule | undefined): Promise<{ api: ShieldedMonitorApi; base: string }> {
  const started = createShieldedMonitorApi({
    store: stubStore,
    config: loadApiConfig({ API_PORT: "0", STORAGE_URL: "http://storage-api:8788", SHIELDED_MONITOR_NET: NET }),
    logger: { log: (record) => logs.push(record) },
    ...(module !== undefined ? { dust: module } : {}),
  });
  const address = await started.listen();
  return { api: started, base: `http://127.0.0.1:${address.port}` };
}

async function get(pathAndQuery: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${pathAndQuery}`);
  return { status: response.status, body: (await response.json()) as unknown };
}

async function post(pathAndQuery: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${pathAndQuery}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

beforeAll(async () => {
  ledger = await loadLedger();
  events = readDustNodeFixtureEvents();
  snapshotDir = await mkdtemp(path.join(tmpdir(), "umbra-00016-routes-"));
  rows = await dustRowsFromFixture(ledger, events);

  dust = createDustModule(
    {},
    {
      net: NET,
      ledger,
      db: fakeDustDb(events, {
        initialUtxos: rows.initialUtxos,
        generation: rows.generation,
        spends: rows.spends,
      }),
      config: {
        databaseUrl: "postgres://unused@localhost/unused",
        snapshotDir,
        pollMs: 5,
        snapshotEvery: 1_000_000,
        replayBatch: 1_000,
      },
    },
  )!;
  await dust.start();
  // Fold the whole fixture before the routes are exercised: `ready` is what separates
  // `503 DUST_NOT_READY` from an answer, and this suite wants the answers.
  for (let i = 0; i < 50 && !dust.status().ready; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  expect(dust.status().ready).toBe(true);

  const started = await startApi(dust);
  api = started.api;
  base = started.base;
}, 300_000);

afterAll(async () => {
  await api?.close();
  await dust?.stop();
  await rm(snapshotDir, { recursive: true, force: true });
});

describe("GET /v1/dust/tip", () => {
  it("reports the mirror's tip, both firstFree values, both roots and the DUST parameters", async () => {
    const { status, body } = await get(`/v1/dust/tip?net=${NET}`);
    expect(status).toBe(200);
    expect(body.net).toBe(NET);
    expect(body.atEventId).toBe(String(meta.events));
    expect(body.commitmentFirstFree).toBe(meta.finalCommitmentFirstFree);
    expect(body.generationFirstFree).toBe(meta.finalGenerationFirstFree);
    expect(body.commitmentRoot).toBe(meta.rootsAfterEveryFiveHundredDustEvents.at(-1)!.commitmentRoot);
    expect(body.generationRoot).toBe(meta.rootsAfterEveryFiveHundredDustEvents.at(-1)!.generatingRoot);
    // Decimal strings throughout (spec §4): a field element does not survive a JSON number.
    for (const value of [body.atHeight, body.atEventId, body.commitmentFirstFree, body.commitmentRoot]) {
      expect(typeof value).toBe("string");
      expect(value).toMatch(/^[0-9]+$/);
    }
    expect(body.params).toStrictEqual({
      nightDustRatio: "5000000000",
      generationDecayRate: "8267",
      dustGracePeriodSeconds: "10800",
    });
  });

  it("refuses a missing or foreign net", async () => {
    expect((await get("/v1/dust/tip")).body.error.code).toBe("DUST_BAD_PARAM");
    expect((await get("/v1/dust/tip?net=devnet")).body.error.code).toBe("DUST_BAD_PARAM");
  });

  it("answers 405 for the wrong method and 404 for an unknown DUST path", async () => {
    const wrongMethod = await fetch(`${base}/v1/dust/tip?net=${NET}`, { method: "POST" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    expect((await get("/v1/dust/nonsense?net=preprod")).status).toBe(404);
  });
});

describe("GET /v1/dust/initial-utxos", () => {
  it("returns an owner's rows with the generation entry's LATEST dtime", async () => {
    const owner = rows.busiestOwner;
    const { status, body } = await get(`/v1/dust/initial-utxos?net=${NET}&owner=${owner}&limit=1000`);
    expect(status).toBe(200);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.atEventId).toBe(String(meta.events));
    const item = body.items[0];
    // The §4 output shape, in §4 encodings, straight from project A's mapper.
    expect(Object.keys(item.output).sort()).toStrictEqual(
      ["backingNight", "ctime", "initialValue", "mtIndex", "nonce", "owner", "seq"].sort(),
    );
    expect(item.output.owner).toBe(owner);
    expect(item.output.backingNight).toMatch(/^[0-9a-f]+$/);
    expect(typeof item.output.ctime).toBe("number");
    expect(item.generation.generationIndex).toMatch(/^[0-9]+$/);
    expect(item.generation.dtime === null || typeof item.generation.dtime === "number").toBe(true);

    // The merge is not decorative: most preprod generation entries DO get a later dtime.
    const merged = body.items.filter((row: any) => row.generation.dtime !== null);
    expect(merged.length).toBeGreaterThan(0);
  });

  it("pages by afterId and stops with nextAfterId null", async () => {
    const owner = rows.busiestOwner;
    const all = (await get(`/v1/dust/initial-utxos?net=${NET}&owner=${owner}&limit=1000`)).body.items;
    expect(all.length).toBeGreaterThan(2);

    const collected: string[] = [];
    let cursor: string | null = "0";
    // One page per row plus the empty page that ends it: the busiest preprod owner in this
    // sample has more rows than a fixed bound would cover, and a loop that ran out would report a
    // non-null cursor as a paging bug.
    for (let page = 0; page <= all.length && cursor !== null; page += 1) {
      const url: string = `/v1/dust/initial-utxos?net=${NET}&owner=${owner}&limit=1&afterId=${cursor}`;
      const { body } = await get(url);
      for (const item of body.items) collected.push(item.eventId);
      cursor = body.nextAfterId;
    }
    expect(collected).toStrictEqual(all.slice(0, collected.length).map((item: any) => item.eventId));
    expect(cursor).toBeNull();
  });

  it("refuses a bad owner, a bad cursor and an over-cap limit", async () => {
    expect((await get(`/v1/dust/initial-utxos?net=${NET}`)).body.error.code).toBe("DUST_BAD_PARAM");
    expect((await get(`/v1/dust/initial-utxos?net=${NET}&owner=0x1`)).body.error.code).toBe("DUST_BAD_PARAM");
    expect((await get(`/v1/dust/initial-utxos?net=${NET}&owner=1&afterId=x`)).body.error.code).toBe("DUST_BAD_PARAM");
    expect((await get(`/v1/dust/initial-utxos?net=${NET}&owner=1&limit=1001`)).body.error.code).toBe("DUST_BAD_PARAM");
  });

  it("answers an owner with nothing as an empty page, not a 404", async () => {
    const { status, body } = await get(`/v1/dust/initial-utxos?net=${NET}&owner=7`);
    expect(status).toBe(200);
    expect(body.items).toStrictEqual([]);
    expect(body.nextAfterId).toBeNull();
  });
});

describe("GET /v1/dust/generation", () => {
  it("returns an owner's generation entries, paged by index", async () => {
    const owner = rows.busiestOwner;
    const { status, body } = await get(`/v1/dust/generation?net=${NET}&owner=${owner}&limit=1000`);
    expect(status).toBe(200);
    expect(body.items.length).toBeGreaterThan(0);
    const indices = body.items.map((item: any) => BigInt(item.generationIndex));
    expect([...indices].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toStrictEqual(indices);
    for (const item of body.items) {
      expect(item.owner).toBe(owner);
      expect(item.nonce).toMatch(/^[0-9a-f]+$/);
      expect(item.value).toMatch(/^[0-9]+$/);
    }

    const first = await get(`/v1/dust/generation?net=${NET}&owner=${owner}&limit=1`);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextAfterIndex).toBe(first.body.items[0].generationIndex);
  });
});

describe("GET /v1/dust/segments", () => {
  it("cuts the requested ranges, and a wallet rebuilds the mirror's root from them", async () => {
    const firstFree = BigInt(meta.finalCommitmentFirstFree);
    const own = 1_234n;
    const ranges = `0-${own - 1n},${own}-${own},${own + 1n}-${firstFree - 1n}`;
    const { status, body } = await get(`/v1/dust/segments?net=${NET}&tree=commitment&ranges=${ranges}`);
    expect(status).toBe(200);
    expect(body.tree).toBe("commitment");
    expect(body.firstFree).toBe(meta.finalCommitmentFirstFree);
    expect(body.segments).toHaveLength(3);

    // Exactly what a wallet does with the response.
    let state = new ledger.DustLocalState(ledger.LedgerParameters.initialParameters().dust);
    try {
      for (const segment of body.segments) {
        const update = ledger.DustStateMerkleTreeCollapsedUpdate.deserialize(
          new Uint8Array(Buffer.from(segment.update, "hex")),
        );
        const next = state.applyCommitmentCollapsedUpdate(update);
        update.free();
        state.free();
        state = next;
      }
      expect(String(state.commitmentTreeRoot())).toBe(body.root);
    } finally {
      state.free();
    }
  }, 120_000);

  it("serves the generating tree the same way", async () => {
    const firstFree = BigInt(meta.finalGenerationFirstFree);
    const { body } = await get(`/v1/dust/segments?net=${NET}&tree=generation&ranges=0-${firstFree - 1n}`);
    expect(body.firstFree).toBe(meta.finalGenerationFirstFree);
    let state = new ledger.DustLocalState(ledger.LedgerParameters.initialParameters().dust);
    try {
      const update = ledger.DustStateMerkleTreeCollapsedUpdate.deserialize(
        new Uint8Array(Buffer.from(body.segments[0].update, "hex")),
      );
      const next = state.applyGenerationCollapsedUpdate(update);
      update.free();
      state.free();
      state = next;
      expect(String(state.generatingTreeRoot())).toBe(body.root);
    } finally {
      state.free();
    }
  }, 120_000);

  it("refuses more than 256 ranges, overlap, start > end, a non-numeric range and end >= firstFree", async () => {
    const many = Array.from({ length: 257 }, (_, i) => `${i * 2}-${i * 2}`).join(",");
    const bad = [
      `ranges=${many}`,
      "ranges=0-10,5-20",
      "ranges=9-4",
      "ranges=a-b",
      `ranges=0-${meta.finalCommitmentFirstFree}`,
    ];
    for (const query of bad) {
      const { status, body } = await get(`/v1/dust/segments?net=${NET}&tree=commitment&${query}`);
      expect(status, query).toBe(400);
      expect(body.error.code, query).toBe("DUST_RANGE_INVALID");
    }
    expect((await get(`/v1/dust/segments?net=${NET}&tree=both&ranges=0-1`)).body.error.code).toBe("DUST_BAD_PARAM");
  });

  it("answers one immutable state even while the mirror keeps folding", async () => {
    // FR-014. The mirror is already at the tip here, so the observable property is the one that
    // survives a swap: every field of the response describes ONE tip, and the root really is the
    // root of the tree the segments were cut from (proved by the rebuild above).
    const firstFree = BigInt(meta.finalCommitmentFirstFree);
    const [a, b] = await Promise.all([
      get(`/v1/dust/segments?net=${NET}&tree=commitment&ranges=0-${firstFree - 1n}`),
      get(`/v1/dust/segments?net=${NET}&tree=commitment&ranges=0-${firstFree - 1n}`),
    ]);
    expect(a.body.atEventId).toBe(b.body.atEventId);
    expect(a.body.segments[0].update).toBe(b.body.segments[0].update);
  }, 120_000);
});

describe("POST /v1/dust/lookup", () => {
  it("answers in request order, found and not found, with the mirror tip as indexEventId", async () => {
    const real = rows.spends.slice(0, 10).map((row) => row.nullifier);
    const absent = ["11", "22", "33"];
    const asked = [...absent.slice(0, 1), ...real, ...absent.slice(1)];
    const { status, body } = await post("/v1/dust/lookup", { net: NET, nullifiers: asked });
    expect(status).toBe(200);
    expect(body.indexEventId).toBe(String(meta.events));
    expect(body.results.map((r: any) => r.nullifier)).toStrictEqual(asked);
    expect(body.results.filter((r: any) => r.spend !== null)).toHaveLength(real.length);

    const found = body.results.find((r: any) => r.spend !== null).spend;
    expect(Object.keys(found).sort()).toStrictEqual(
      ["blockTime", "commitment", "commitmentIndex", "declaredTime", "eventId", "height", "nullifier", "txHash", "vFee"].sort(),
    );
    expect(found.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(found.commitmentIndex).toMatch(/^[0-9]+$/);
    // The commitment index of a real spend is inside the mirror's tree — the two views agree.
    expect(BigInt(found.commitmentIndex)).toBeLessThan(BigInt(meta.finalCommitmentFirstFree));
  });

  it("refuses 1 001 nullifiers, a malformed decimal, a missing net and a non-JSON body", async () => {
    const many = Array.from({ length: 1_001 }, (_, i) => String(i));
    expect((await post("/v1/dust/lookup", { net: NET, nullifiers: many })).body.error.code).toBe("DUST_LOOKUP_INVALID");
    expect((await post("/v1/dust/lookup", { net: NET, nullifiers: ["0x1"] })).body.error.code)
      .toBe("DUST_LOOKUP_INVALID");
    expect((await post("/v1/dust/lookup", { nullifiers: ["1"] })).body.error.code).toBe("DUST_LOOKUP_INVALID");
    expect((await post("/v1/dust/lookup", "{")).body.error.code).toBe("DUST_LOOKUP_INVALID");
  });

  it("logs the route, the status and a COUNT — never a nullifier", async () => {
    // SC-006. The access log is where a secret leaks by accident: the route pattern is chosen from
    // a fixed list, the URL is never logged, and the body is never touched by the logger.
    const secret = rows.spends[0]!.nullifier;
    logs.length = 0;
    await post("/v1/dust/lookup", { net: NET, nullifiers: [secret, "999999999999999999999999"] });
    await get(`/v1/dust/initial-utxos?net=${NET}&owner=${rows.busiestOwner}&limit=5`);
    expect(logs.length).toBe(2);

    const lookup = logs[0]!;
    expect(lookup.route).toBe("POST /v1/dust/lookup");
    expect(lookup.status).toBe(200);
    expect(lookup.count).toBe(2);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(secret);
    // And not the owner's DUST public key either, which travels in a query STRING — the reason
    // the log carries a route pattern rather than the raw URL.
    expect(serialized).not.toContain(rows.busiestOwner);
    expect(logs[1]!.route).toBe("GET /v1/dust/initial-utxos");
    expect(logs[1]!.count).toBe(5);
  });
});

describe("GET /internal/status carries the dust block (plan 00016 D2.3)", () => {
  /** Only what `internalStatus` reaches. The node's own status fields are its suite's subject;
   *  what this case is about is that the DUST block is MERGED IN without the node knowing about
   *  the waived directory at all. */
  const stubNode = {
    status: () => ({ nodeId: "n1", net: NET, keysHeld: 0, live: 0, syncing: 0, failed: 0, queueB: 0, liveWatermark: "7", lagBlocks: "0" }),
    holdsMonitor: () => ({ holds: false }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  async function statusOf(module: DustModule | undefined): Promise<any> {
    const started = createShieldedMonitorApi({
      store: stubStore,
      config: loadApiConfig({ API_PORT: "0", STORAGE_URL: "http://storage-api:8788", SHIELDED_MONITOR_NET: NET }),
      logger: { log: () => undefined },
      node: stubNode,
      ...(module !== undefined ? { dust: module } : {}),
    });
    const address = await started.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/internal/status`);
      expect(response.status).toBe(200);
      return await response.json();
    } finally {
      await started.close();
    }
  }

  it("reports applied, snapshot, memory and the parameter check when the module is on", async () => {
    const body = await statusOf(dust);
    expect(body.nodeId).toBe("n1"); // the node's own fields are untouched
    expect(body.dust.enabled).toBe(true);
    expect(body.dust.producer).toBe("ingest");
    expect(body.dust.ready).toBe(true);
    expect(body.dust.applied.eventId).toBe(String(meta.events));
    expect(body.dust.lastError).toBeNull();
    // D2.5b: BOTH instruments. `externalBytes` is the WASM heap, which is where the retained trees
    // live; `rss` is what a container limit is written in. SC-004 is stated against the latter.
    expect(body.dust.rss).toBeGreaterThan(0);
    expect(body.dust.externalBytes).toBeGreaterThan(0);
    // Under the role spec §5.3 prescribes, the parameter check cannot read the checkpoint tables.
    // That is a recorded conflict, not a defect — see question Q-15.
    await dust.whenParametersChecked();
    expect(["ok", "skipped", "mismatch"]).toContain(body.dust.parametersCheck);
  });

  it("reports enabled: false when the node was started without DUST_DATABASE_URL", async () => {
    const body = await statusOf(undefined);
    expect(body.dust).toStrictEqual({
      enabled: false,
      producer: "none",
      ready: false,
      applied: { eventId: "0", height: "0" },
      snapshotEventId: null,
      parametersCheck: "skipped",
      lastError: null,
      rss: body.dust.rss,
      externalBytes: body.dust.externalBytes,
    });
  });
});

describe("the 503s (spec §4)", () => {
  it("DUST_DISABLED when the node was started without DUST_DATABASE_URL", async () => {
    const started = await startApi(undefined);
    try {
      const response = await fetch(`${started.base}/v1/dust/tip?net=${NET}`);
      expect(response.status).toBe(503);
      expect(((await response.json()) as any).error.code).toBe("DUST_DISABLED");
      // Still reported on /internal/status, so an operator can see the module is simply off.
      const status = await fetch(`${started.base}/internal/status`);
      // No monitor node in this stub API, so /internal/status is 404 — the DUST block travels
      // with the node's status and is covered by `monitor-node`'s own suite.
      expect(status.status).toBe(404);
    } finally {
      await started.api.close();
    }
  });

  it("DUST_NO_PRODUCER when the archive holds no DUST events for this net", async () => {
    const empty = createDustModule(
      {},
      {
        net: NET,
        ledger,
        db: fakeDustDb([]),
        config: {
          databaseUrl: "postgres://unused@localhost/unused",
          snapshotDir: path.join(snapshotDir, "empty"),
          pollMs: 5,
          snapshotEvery: 1_000_000,
          replayBatch: 1_000,
        },
      },
    )!;
    await empty.start();
    try {
      for (let i = 0; i < 50 && empty.status().producer !== "none"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const reply = await empty.handle("tip", new URL(`http://x/v1/dust/tip?net=${NET}`), Buffer.alloc(0));
      expect(reply.status).toBe(503);
      expect(reply.errorCode).toBe("DUST_NO_PRODUCER");
    } finally {
      await empty.stop();
    }
  }, 60_000);

  it("DUST_NOT_READY before the first catch-up", async () => {
    const cold = createDustModule(
      {},
      {
        net: NET,
        ledger,
        db: fakeDustDb(events),
        config: {
          databaseUrl: "postgres://unused@localhost/unused",
          snapshotDir: path.join(snapshotDir, "cold"),
          pollMs: 3_600_000, // never polls on its own inside this test
          snapshotEvery: 1_000_000,
          replayBatch: 1_000,
        },
      },
    )!;
    await cold.start();
    try {
      const reply = await cold.handle("tip", new URL(`http://x/v1/dust/tip?net=${NET}`), Buffer.alloc(0));
      expect(reply.status).toBe(503);
      // The mirror has seen a non-empty table (its first poll ran) but has not caught up.
      expect(["DUST_NOT_READY", "DUST_NO_PRODUCER"]).toContain(reply.errorCode);
    } finally {
      await cold.stop();
    }
  }, 60_000);

  it("DUST_DB_UNAVAILABLE when the query fails, with nothing of the driver's message on the wire", async () => {
    const broken = createDustModule(
      {},
      {
        net: NET,
        ledger,
        db: brokenDustDb(events),
        config: {
          databaseUrl: "postgres://unused@localhost/unused",
          snapshotDir: path.join(snapshotDir, "broken"),
          pollMs: 5,
          snapshotEvery: 1_000_000,
          replayBatch: 1_000,
        },
      },
    )!;
    await broken.start();
    try {
      for (let i = 0; i < 50 && !broken.status().ready; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const reply = await broken.handle(
        "lookup",
        new URL("http://x/v1/dust/lookup"),
        Buffer.from(JSON.stringify({ net: NET, nullifiers: ["41"] }), "utf8"),
      );
      expect(reply.status).toBe(503);
      expect(reply.errorCode).toBe("DUST_DB_UNAVAILABLE");
      // postgres.js quotes bound parameters in some faults, and a bound parameter here is a
      // nullifier. The message on the wire is this module's own fixed string.
      expect(JSON.stringify(reply.body)).not.toContain("connection terminated");
    } finally {
      await broken.stop();
    }
  }, 300_000);
});
