import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgArchiveReadContract } from "../../../src/postgres/archive-read-contract.js";
import { PgChainArchiveStore } from "../../../src/postgres/chain-archive-store.js";
import { createClient, type UmbraDBSql } from "../../../src/postgres/client.js";
import { runMigrations } from "../../../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../../../src/postgres/migrations/chain_archive/index.js";
import { bootstrapShieldedMonitorSchema } from "../../../storage-api/bootstrap.js";
import { LEDGER_BUILD_ID, MATCHING_RULE_VERSION } from "../../../shielded-monitor/offers.js";
import { ShieldedMonitorScanner } from "../../../shielded-monitor/scanner.js";
import { MonitorFencedError } from "../../../shielded-monitor/errors.js";
import { HttpMonitorStore, StorageUnreachableError } from "../../../shielded-monitor/storage-http-client.js";
import { PgShieldedMonitorStore } from "../../../storage-api/monitor-store-pg.js";
import { encodeViewingKey, parseViewingKey } from "../../../shielded-monitor/viewing-key.js";
import { buildCorpus, type BuiltCorpus } from "../../fixtures/shielded-monitor/build-corpus.js";
import { startStorageApi, type StartedStorageApi } from "../../storage-api/helpers.js";
import {
  classifyRuleBState, CRASH_NET, crashHeightBundle, heightShape, observeMonitorHeight,
} from "./monitor-batch-fixture.js";

/**
 * **Owner Rule B across the HTTP boundary** (`spec/00009` US5 scenario 2, FR-010, FR-012;
 * sub-plan 00009-08 v2).
 *
 * `shielded-monitor-batch-atomicity.crash.test.ts` proves the rule for the WRITER: a PostgreSQL
 * kill or a SIGKILL at any point leaves exactly `nothing-of-height` or `all-of-height`, never a
 * third state. That suite is untouched, and it still holds — the transaction it kills is the same
 * transaction, now executed by `umbradb-storage-api` on project B's behalf.
 *
 * What putting HTTP in front of it ADDS is a failure the in-process store could not have: the
 * CLIENT can lose the answer. Three distinct things can happen to a request, and only the middle
 * one is new:
 *
 *  1. it never reached the transaction — nothing of H, and the batch is safe to redo;
 *  2. **it committed and the response was lost** — the client does not know, and a blind resend
 *     would be a second write of the same height;
 *  3. it was refused by the fence — nothing of H, and a redo would be refused identically.
 *
 * This suite drives all three through a fault proxy that sits between `HttpMonitorStore` and the
 * real storage API, and classifies the surviving state with the SAME `classifyRuleBState` the
 * writer suite uses. The classifier is not re-implemented here and not relaxed: a partial height
 * fails this suite exactly as it fails that one.
 *
 * The property being established is precise: **the client's lost-response protocol never produces
 * a state the writer's own atomicity does not already permit, and never writes a height twice.**
 */

type FaultMode =
  /** Forward normally. */
  | "none"
  /** Destroy the connection BEFORE forwarding: the request never reaches the transaction. */
  | "drop-before"
  /** Forward, let the server commit, then destroy the connection WITHOUT returning the response:
   *  the commit happened and the client cannot know it. */
  | "drop-after";

interface FaultProxy {
  readonly url: string;
  mode: FaultMode;
  /** How many faulted requests were actually forwarded to the storage API. */
  forwarded: number;
  close(): Promise<void>;
}

/**
 * A one-hop proxy that can lose a request, or lose its response after the server acted on it.
 *
 * The fault applies to `POST …/advance` and to NOTHING else, deliberately. A proxy that dropped
 * every request would also break the scanner's key read and its lifecycle calls, and the suite
 * would end up measuring how the scanner reacts to a totally unavailable storage API — a real but
 * different question. What is under test here is the ONE non-idempotent call, at the one moment
 * its outcome becomes unknown.
 */
const FAULTED_ROUTE = "/advance";

async function startFaultProxy(target: string): Promise<FaultProxy> {
  const upstream = new URL(target);
  const state = { mode: "none" as FaultMode, forwarded: 0 };
  const server: Server = createServer((req, res) => {
    const faulted = state.mode !== "none" && (req.url ?? "").endsWith(FAULTED_ROUTE);
    if (faulted && state.mode === "drop-before") {
      req.destroy();
      res.destroy();
      return;
    }
    const outbound = httpRequest(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: upstream.host },
      },
      (upstreamRes) => {
        if (faulted) state.forwarded += 1;
        if (faulted && state.mode === "drop-after") {
          // The server has already answered — which means the transaction has already committed —
          // and the client is about to learn nothing about it.
          upstreamRes.resume();
          upstreamRes.on("end", () => {
            res.destroy();
          });
          return;
        }
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    outbound.on("error", () => res.destroy());
    req.pipe(outbound);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    get mode() {
      return state.mode;
    },
    set mode(value: FaultMode) {
      state.mode = value;
    },
    get forwarded() {
      return state.forwarded;
    },
    set forwarded(value: number) {
      state.forwarded = value;
    },
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

describe("Rule B over HTTP: a lost response never duplicates a height, and never leaves a partial one", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let corpus: BuiltCorpus;
  let archive: PgArchiveReadContract;
  let serverStore: PgShieldedMonitorStore;
  let storage: StartedStorageApi;
  let proxy: FaultProxy;
  let client: HttpMonitorStore;
  let monitorId: string;
  const archiveSchema = "rule_b_http_archive";
  const monitorSchema = "rule_b_http_monitor";
  const HEIGHTS = 12;

  beforeAll(async () => {
    corpus = await buildCorpus();
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema: monitorSchema, maxConnections: 6 });
    await runMigrations(sql, { schema: archiveSchema, migrations: chainArchiveMigrations });
    await bootstrapShieldedMonitorSchema(sql, monitorSchema);

    const archiveStore = new PgChainArchiveStore(sql, archiveSchema);
    archive = new PgArchiveReadContract(sql, archiveSchema);
    serverStore = new PgShieldedMonitorStore(sql, monitorSchema);
    await archiveStore.ensureArchiveInstanceId(CRASH_NET);
    const rawById = new Map(corpus.transactions.map((t) => [t.spec.id, t.rawBytes]));
    for (let height = 0; height < HEIGHTS; height++) {
      await archiveStore.putBlockBundle(crashHeightBundle(height, rawById, corpus.manifest.protocolVersion));
    }

    storage = await startStorageApi(serverStore, {
      config: { monitorSchema, archiveSchema, net: CRASH_NET },
    });
    proxy = await startFaultProxy(storage.baseUrl);
    client = new HttpMonitorStore(proxy.url, { requestTimeoutMs: 15_000 });

    const key = await parseViewingKey(encodeViewingKey(corpus.keyBytes.get("K")!, CRASH_NET), CRASH_NET);
    const monitor = await serverStore.register({
      key, net: CRASH_NET, requestedStartHeight: 0n,
      matchingRuleVersion: MATCHING_RULE_VERSION, ledgerBuild: LEDGER_BUILD_ID, actor: "rule-b-http",
    });
    monitorId = monitor.id;
    const identity = (await archive.getArchiveIdentity(CRASH_NET))!;
    await serverStore.bindArchiveSource(monitorId, monitor.epoch, {
      genesisHash: identity.genesisHash, instanceId: identity.archiveInstanceId,
    });
  }, 600_000);

  afterAll(async () => {
    await proxy?.close();
    await storage?.close();
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 120_000);

  /** Scans exactly one height through the HTTP client, with the fault armed for that batch. */
  async function scanHeightThroughProxy(height: number, mode: FaultMode): Promise<{
    kind: string; forwarded: number; threw: unknown;
  }> {
    const scanner = new ShieldedMonitorScanner(archive, client, {
      net: CRASH_NET,
      batchBlocks: 1,
      // The archive here is IN-PROCESS (this suite is about the store hop, not the archive hop),
      // so the transaction-identity check stays off exactly as the composition root would set it.
      verifyTxIdentity: false,
    });
    proxy.forwarded = 0;
    proxy.mode = mode;
    let threw: unknown;
    let kind = "(none)";
    try {
      kind = (await scanner.scanBatch(await serverStore.get(monitorId))).kind;
    } catch (err) {
      threw = err;
    } finally {
      proxy.mode = "none";
    }
    void height;
    return { kind, forwarded: proxy.forwarded, threw };
  }

  it("a request that never reaches the server leaves NOTHING of the height, and the redo lands it whole", async () => {
    const height = 0;
    const shape = heightShape(height);
    const before = await observeMonitorHeight(sql, monitorSchema, monitorId, height);

    const attempt = await scanHeightThroughProxy(height, "drop-before");
    expect(attempt.forwarded, "the proxy must not have forwarded anything").toBe(0);
    expect(attempt.threw, "an unreachable storage API must surface as a failure").toBeDefined();
    expect(attempt.threw).toBeInstanceOf(StorageUnreachableError);
    expect(
      classifyRuleBState(await observeMonitorHeight(sql, monitorSchema, monitorId, height), {
        height, associationRows: shape.matchPositions.length, totalBefore: before.totalAssociationRows,
      }),
    ).toBe("nothing-of-height");

    // The recovery the rule promises: the same batch, unfaulted, lands whole and exactly once.
    const redo = await scanHeightThroughProxy(height, "none");
    expect(redo.kind).toBe("advanced");
    expect(
      classifyRuleBState(await observeMonitorHeight(sql, monitorSchema, monitorId, height), {
        height, associationRows: shape.matchPositions.length, totalBefore: before.totalAssociationRows,
      }),
    ).toBe("all-of-height");
  }, 120_000);

  it("[[crash.shielded-monitor-http.lost-response-never-duplicates]] a LOST RESPONSE after a commit is resolved by re-reading — the height lands exactly once", async () => {
    // The one failure mode HTTP adds. The transaction committed; the client will never see the
    // answer. It must neither duplicate the height nor report a failure the scanner would treat
    // as "nothing was written".
    const height = 1;
    const shape = heightShape(height);
    const before = await observeMonitorHeight(sql, monitorSchema, monitorId, height);

    const attempt = await scanHeightThroughProxy(height, "drop-after");
    expect(attempt.forwarded, "the request DID reach the storage API").toBeGreaterThan(0);
    expect(attempt.threw, "the client must resolve the unknown rather than fail").toBeUndefined();
    // The scanner sees the crash-retry outcome the in-process store reports for a replayed batch
    // (US5 scenario 2) — not a failure, and not a second write.
    expect(["advanced", "already-advanced"]).toContain(attempt.kind);

    const observed = await observeMonitorHeight(sql, monitorSchema, monitorId, height);
    expect(
      classifyRuleBState(observed, {
        height, associationRows: shape.matchPositions.length, totalBefore: before.totalAssociationRows,
      }),
    ).toBe("all-of-height");
    // Explicitly, because it is the whole point: the height's rows were written ONCE.
    expect(observed.associationRows).toBe(shape.matchPositions.length);
    expect(observed.totalAssociationRows).toBe(before.totalAssociationRows + shape.matchPositions.length);
  }, 120_000);

  it("a stale epoch is refused over HTTP with nothing written, exactly as in-process", async () => {
    const height = 2;
    const shape = heightShape(height);
    const before = await observeMonitorHeight(sql, monitorSchema, monitorId, height);
    const monitor = await serverStore.get(monitorId);

    await expect(
      client.advance(monitorId, monitor.epoch + 5n, BigInt(height), []),
    ).rejects.toBeInstanceOf(MonitorFencedError);

    expect(
      classifyRuleBState(await observeMonitorHeight(sql, monitorSchema, monitorId, height), {
        height, associationRows: shape.matchPositions.length, totalBefore: before.totalAssociationRows,
      }),
    ).toBe("nothing-of-height");
  }, 120_000);

  it("a lifecycle transition landing under a worker refuses the commit, over HTTP, with no partial height", async () => {
    // US3 scenario 1 over the wire: the epoch fence is the server's, and the 409 it produces is
    // re-thrown here as the same `MonitorFencedError` the scanner has always handled.
    const height = 3;
    const shape = heightShape(height);
    const before = await observeMonitorHeight(sql, monitorSchema, monitorId, height);
    const monitor = await serverStore.get(monitorId);
    // The worker's loaded epoch, captured BEFORE the pause lands.
    const loadedEpoch = monitor.epoch;
    await serverStore.pause(monitorId, "test");
    try {
      await expect(
        client.advance(monitorId, loadedEpoch, BigInt(height), []),
      ).rejects.toBeInstanceOf(MonitorFencedError);
      expect(
        classifyRuleBState(await observeMonitorHeight(sql, monitorSchema, monitorId, height), {
          height, associationRows: shape.matchPositions.length, totalBefore: before.totalAssociationRows,
        }),
      ).toBe("nothing-of-height");
    } finally {
      await serverStore.resume(monitorId, "test");
    }
  }, 120_000);

  it("scanning the rest of the corpus through the proxy, with faults every other height, still equals the oracle", async () => {
    // The end-to-end shape: a run in which roughly half the batches lose their request or their
    // response still produces each height exactly once, with coverage that never skips.
    // The height a batch scans is decided by the monitor's own coverage, not by this loop — the
    // fence cases above deliberately advanced nothing, so coverage is behind the height numbers.
    for (;;) {
      const coverage = (await serverStore.get(monitorId)).coverage.scannedThrough;
      const height = coverage === undefined ? 0 : Number(coverage) + 1;
      if (height >= HEIGHTS) break;
      const shape = heightShape(height);
      const before = await observeMonitorHeight(sql, monitorSchema, monitorId, height);
      const mode: FaultMode = height % 3 === 0 ? "drop-before" : height % 3 === 1 ? "drop-after" : "none";
      const attempt = await scanHeightThroughProxy(height, mode);
      if (mode === "drop-before") {
        expect(attempt.threw).toBeInstanceOf(StorageUnreachableError);
        // Redo, unfaulted, as a restarted scanner would.
        expect((await scanHeightThroughProxy(height, "none")).kind).toBe("advanced");
      }
      const observed = await observeMonitorHeight(sql, monitorSchema, monitorId, height);
      expect(
        classifyRuleBState(observed, {
          height, associationRows: shape.matchPositions.length, totalBefore: before.totalAssociationRows,
        }),
        `height ${height} under ${mode}`,
      ).toBe("all-of-height");
      expect(observed.coverageThrough).toBe(height);
    }

    // The golden set: every association exactly once, in (height, position) order, with no gap in
    // the per-monitor sequence.
    const rows = await serverStore.readAssociations(monitorId, 0n, 1000);
    const seen = rows.map((r) => `${r.blockHeight}/${r.position}`);
    expect(new Set(seen).size, "no duplicate (height, position)").toBe(seen.length);
    expect([...seen]).toStrictEqual([...seen].sort((a, b) => {
      const [ah, ap] = a.split("/").map(Number) as [number, number];
      const [bh, bp] = b.split("/").map(Number) as [number, number];
      return ah === bh ? ap - bp : ah - bh;
    }));
    expect(rows.map((r) => r.seq)).toStrictEqual(rows.map((_r, i) => BigInt(i + 1)));
    let expectedTotal = 0;
    for (let height = 0; height < HEIGHTS; height++) expectedTotal += heightShape(height).matchPositions.length;
    expect(rows.length).toBe(expectedTotal);
  }, 300_000);
});
