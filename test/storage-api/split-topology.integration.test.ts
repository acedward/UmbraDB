import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBalancer, type Balancer } from "../../shielded-monitor/balancer/balancer.js";
import { openArchiveSource } from "../../shielded-monitor/archive-source.js";
import { createShieldedMonitorApi, silentLogger, type ShieldedMonitorApi } from "../../shielded-monitor/api/server.js";
import { loadApiConfig } from "../../shielded-monitor/api/config.js";
import { archiveSourceTip } from "../../shielded-monitor/api/source-tip.js";
import { readScannerConfig } from "../../shielded-monitor/scanner-config.js";
import { ShieldedMonitorScanner } from "../../shielded-monitor/scanner.js";
import { ShieldedMonitorScannerService } from "../../shielded-monitor/scanner-service.js";
import { HttpMonitorStore } from "../../shielded-monitor/storage-http-client.js";
import { encodeViewingKey } from "../../shielded-monitor/viewing-key.js";
import { createScannerWorld, destroyWorld, type ScannerWorld } from "../shielded-monitor/scanner-harness.js";
import { startStorageApi, type StartedStorageApi } from "./helpers.js";

/**
 * **The 2×2 split deployment, end to end** (sub-plan 00009-08 v2; owner question Q25;
 * `spec/00009` FR-010, FR-012, FR-025, FR-026, US2, US5).
 *
 * ```text
 *                          ┌── shielded-monitor-scanner-1 ──┐
 *   one PostgreSQL         │   shielded-monitor-scanner-2   │  STORAGE_URL only
 *        ▲                 │                                │
 *        │  the ONLY       │   shielded-monitor-api-1  ◄────┼── balancer ◄── consumer
 *        └── credential ── umbradb-storage-api               │   (random upstream)
 *                          │   shielded-monitor-api-2  ◄────┘
 * ```
 *
 * Everything below runs as real processes-in-one-process: real HTTP servers, real sockets, real
 * `fetch`. The only thing faked is the container boundary, and it is faked in the direction that
 * makes the test STRONGER — the four B components hold `HttpMonitorStore` instances and nothing
 * else, so a database access from any of them would be a compile error, not a runtime surprise.
 *
 * What it proves, in order:
 *  1. two scanners over HTTP produce exactly the fixture oracle, once, with no duplicated commit;
 *  2. leases are visible and correct THROUGH the storage API (claim, hand-back, takeover);
 *  3. a consumer talking to the balancer can register on one API instance and poll on the other;
 *  4. coverage advances and `sourceTip` is reported — the archive read contract travels over the
 *     same one base URL as the monitor store;
 *  5. the environment a split B process actually gets contains no `*_PG` at all, and the config
 *     loaders refuse one if it appears.
 */

const NET = "undeployed";

describe("the split topology: 2 scanners + 2 APIs + 1 balancer + 1 storage API, one database", () => {
  let container: StartedPostgreSqlContainer;
  let world: ScannerWorld;
  let storage: StartedStorageApi;
  let apiOne: ShieldedMonitorApi;
  let apiTwo: ShieldedMonitorApi;
  let balancer: Balancer;
  let balancerUrl: string;
  let apiOneUrl: string;
  let apiTwoUrl: string;

  /** The environment a split B container really gets: one URL, and nothing else. */
  const splitEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    STORAGE_URL: storage.baseUrl,
    SHIELDED_MONITOR_NET: NET,
    NET,
    API_PORT: "0",
    ...extra,
  });

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    world = await createScannerWorld(container, "split", { maxConnections: 12 });

    // ── A side: the one process with a credential ──────────────────────────────────────────
    storage = await startStorageApi(world.store, {
      config: { monitorSchema: world.monitorSchema, archiveSchema: world.archiveSchema, net: NET },
      archive: { archive: world.archive },
    });

    // ── B side: two private API instances, each an HTTP client and nothing more ────────────
    const buildApi = async (): Promise<{ api: ShieldedMonitorApi; url: string }> => {
      const config = loadApiConfig(splitEnv());
      const api = createShieldedMonitorApi({
        store: new HttpMonitorStore(config.storageUrl),
        config,
        sourceTipProvider: archiveSourceTip(
          openArchiveSource({ archiveUrl: config.archiveUrl, wake: false }).archive,
        ),
        logger: silentLogger(),
      });
      const address = await api.listen();
      return { api, url: `http://127.0.0.1:${address.port}` };
    };
    const first = await buildApi();
    const second = await buildApi();
    apiOne = first.api;
    apiTwo = second.api;
    apiOneUrl = first.url;
    apiTwoUrl = second.url;

    balancer = createBalancer({
      upstreams: [apiOneUrl, apiTwoUrl],
      host: "127.0.0.1",
      port: 0,
      probeMs: 0,
      requestTimeoutMs: 20_000,
    });
    balancerUrl = `http://127.0.0.1:${(await balancer.listen()).port}`;
    await balancer.probeOnce();
  }, 300_000);

  afterAll(async () => {
    await balancer?.close();
    await apiOne?.close();
    await apiTwo?.close();
    await storage?.close();
    if (world !== undefined) await destroyWorld(world);
    await container?.stop();
  }, 180_000);

  it("a split B process's environment holds no database configuration, and one is refused", () => {
    const env = splitEnv();
    expect(Object.keys(env).filter((k) => k.endsWith("_PG"))).toStrictEqual([]);
    expect(readScannerConfig(splitEnv(), []).storageUrl).toBe(storage.baseUrl);
    expect(loadApiConfig(env).storageUrl).toBe(storage.baseUrl);
    // And the refusal, from the same environment plus the one variable a migration would leave.
    expect(() => readScannerConfig(splitEnv({ MONITOR_PG: "postgres://u:p@h/db" }), []))
      .toThrow(/database configuration in its environment/);
    expect(() => loadApiConfig(splitEnv({ MONITOR_PG: "postgres://u:p@h/db" })))
      .toThrow(/database configuration in its environment/);
  });

  it("the storage API's health names both wire versions and serves the archive routes too", async () => {
    const health = (await (await fetch(`${storage.baseUrl}/v1/health`)).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ status: "ok", net: NET, archiveRoutes: true });
    expect(health.monitorStoreWireVersion).toBe(1);
    const tip = (await (await fetch(`${storage.baseUrl}/v1/archive/tip?net=${NET}`)).json()) as {
      sourceTip: { height: number } | null;
    };
    expect(tip.sourceTip?.height).toBe(world.corpus.bundles.at(-1)!.block.height);
  }, 60_000);

  it("[[storage-api.split-topology.two-scanners-two-apis-one-balancer]] two scanners over HTTP reproduce the fixture oracle exactly once, and both do work", async () => {
    const seen: { instance: string; monitorId: string; height: string }[] = [];
    const makeInstance = (instance: string): ShieldedMonitorScannerService => {
      // Exactly what `scanner-cli.ts` builds from `STORAGE_URL`: an HTTP store and an HTTP
      // archive. No `sql`, no schema, no driver — this is the whole of the instance's world.
      const store = new HttpMonitorStore(storage.baseUrl, { userAgent: instance });
      const source = openArchiveSource({ archiveUrl: storage.baseUrl, wake: false });
      const instrumented = new Proxy(store, {
        get(target, property, receiver) {
          if (property !== "advance") return Reflect.get(target, property, receiver) as unknown;
          return async (...args: Parameters<HttpMonitorStore["advance"]>) => {
            const result = await target.advance(...args);
            if (result.applied) seen.push({ instance, monitorId: args[0], height: args[2].toString() });
            return result;
          };
        },
      });
      const scanner = new ShieldedMonitorScanner(source.archive, instrumented, {
        net: NET,
        batchBlocks: 1,
        // Remote archive ⇒ the transaction-identity check is ON (organizer question Q23). The
        // corpus carries the ledger's real `transactionHash()`, so this exercises it.
        verifyTxIdentity: source.remote,
        lease: { owner: instance, ttlMs: 30_000 },
      });
      return new ShieldedMonitorScannerService(scanner, instrumented, source.wake, {
        net: NET,
        concurrency: 2,
        instanceId: instance,
        leaseTtlMs: 30_000,
      });
    };

    const a = makeInstance("scanner-1");
    const b = makeInstance("scanner-2");
    for (let round = 0; round < 4; round++) {
      await Promise.all([a.runCycle(), b.runCycle()]);
    }

    // 1. No (monitor, height) was committed twice. A racing instance is refused by the monotonic
    //    coverage guard as `already-advanced`, which the proxy does not record.
    const keys = seen.map((s) => `${s.monitorId}@${s.height}`);
    expect(new Set(keys).size).toBe(keys.length);

    // 2. The oracle (SC-001), unchanged by putting HTTP between the scanner and the store.
    const lastHeight = BigInt(world.corpus.bundles.at(-1)!.block.height);
    for (const key of world.corpus.manifest.keys) {
      const monitorId = world.monitors.get(key.id)!;
      const expected = world.corpus.expectedMatches.get(key.id) ?? [];
      const stored = await world.store.readAssociations(monitorId, 0n, 100);
      expect(stored.map((x) => `${x.blockHeight}/${x.position}`)).toStrictEqual(
        expected.map((t) => `${t.blockHeight}/${t.position}`),
      );
      expect((await world.store.get(monitorId)).coverage.scannedThrough).toBe(lastHeight);
    }

    // 3. Non-vacuity: BOTH instances really committed something. Without this a lease bug that
    //    gave every monitor to one instance would pass 1 and 2 in silence.
    expect(new Set(seen.map((s) => s.instance))).toStrictEqual(new Set(["scanner-1", "scanner-2"]));

    // 4. Every lease was handed back at the end of its turn, through the storage API.
    for (const key of world.corpus.manifest.keys) {
      expect(await world.store.readMonitorLease(world.monitors.get(key.id)!)).toBeUndefined();
    }
  }, 300_000);

  it("claims, refusals and takeover all work THROUGH the storage API", async () => {
    const monitorId = world.monitors.get("K")!;
    const one = new HttpMonitorStore(storage.baseUrl);
    const two = new HttpMonitorStore(storage.baseUrl);

    expect((await one.claimMonitorLease(monitorId, "http-1", 1_500)).acquired).toBe(true);
    expect((await two.claimMonitorLease(monitorId, "http-2", 30_000)).acquired).toBe(false);
    const lease = await two.readMonitorLease(monitorId);
    expect(lease?.owner).toBe("http-1");
    expect(lease?.expiresAt.getTime()).toBeGreaterThan(lease!.claimedAt.getTime());

    // The TTL is the only thing that lets a dead instance's monitors move.
    await new Promise((r) => setTimeout(r, 1_700));
    expect((await two.claimMonitorLease(monitorId, "http-2", 30_000)).acquired).toBe(true);
    // A release is scoped to its owner, over HTTP exactly as in-process.
    expect((await one.releaseMonitorLease(monitorId, "http-1")).released).toBe(false);
    expect((await two.releaseMonitorLease(monitorId, "http-2")).released).toBe(true);
    expect(await one.readMonitorLease(monitorId)).toBeUndefined();
  }, 120_000);

  it("a consumer registers on one API instance through the balancer and polls on the other", async () => {
    // The property that makes a random balancer legitimate: a cursor is a per-monitor association
    // sequence, not a server handle, so a consumer may be moved between instances mid-flow.
    const serialized = world.corpus.keyBytes.get("K")!;
    const viewingKey = encodeViewingKey(serialized, NET);

    const created = await fetch(`${balancerUrl}/v1/monitors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ viewingKey, startHeight: 0 }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { monitorId: string; coverage: Record<string, unknown> };
    expect(typeof createdBody.monitorId).toBe("string");
    // Registration is idempotent per (net, key), so this returns the monitor the harness already
    // registered — which is the one the scanners above filled with matches.
    expect(createdBody.monitorId).toBe(world.monitors.get("K")!);
    const registeredOn = created.headers.get("x-upstream");
    expect([apiOneUrl, apiTwoUrl]).toContain(registeredOn);

    // Poll every page through the balancer. Over enough requests both instances answer, and the
    // pages concatenate into exactly the oracle regardless of which one served each.
    const servers = new Set<string>();
    const seenMatches: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 12; page++) {
      const url = new URL(`${balancerUrl}/v1/monitors/${createdBody.monitorId}/matches`);
      url.searchParams.set("limit", "1");
      if (cursor !== undefined) url.searchParams.set("cursor", cursor);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      servers.add(response.headers.get("x-upstream")!);
      const body = (await response.json()) as {
        items: { blockHeight: string; position: number }[];
        nextCursor: string;
        coverage: { scannedThrough?: string | null; sourceTip?: string | null };
      };
      for (const match of body.items) seenMatches.push(`${match.blockHeight}/${match.position}`);
      // The archive read contract travels over the same base URL, so a split API still answers
      // "am I caught up?" honestly (organizer question Q14).
      expect(body.coverage.sourceTip).toBe(String(world.corpus.bundles.at(-1)!.block.height));
      if (body.items.length === 0) break;
      cursor = body.nextCursor;
    }
    const expected = (world.corpus.expectedMatches.get("K") ?? []).map(
      (t) => `${t.blockHeight}/${t.position}`,
    );
    expect(seenMatches).toStrictEqual(expected);
    expect(servers.size, `both API instances should have served a page (saw ${[...servers].join(", ")})`)
      .toBeGreaterThan(1);
  }, 180_000);

  it("the dashboard and the monitor list are served through the balancer", async () => {
    const list = await fetch(`${balancerUrl}/v1/monitors`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      items: { monitorId: string; state: string }[];
      sourceTip: string | null;
      net: string;
    };
    expect(body.items.length).toBe(world.corpus.manifest.keys.length);
    expect(body.items.every((m) => typeof m.monitorId === "string")).toBe(true);
    // The deployment-level tip comes from the archive routes of the SAME storage API.
    expect(body.sourceTip).toBe(String(world.corpus.bundles.at(-1)!.block.height));
    expect(body.net).toBe(NET);

    const ui = await fetch(`${balancerUrl}/ui`);
    expect(ui.status).toBe(200);
    expect(ui.headers.get("content-type")).toContain("text/html");
    expect(ui.headers.get("x-upstream")).not.toBeNull();
  }, 120_000);
});
