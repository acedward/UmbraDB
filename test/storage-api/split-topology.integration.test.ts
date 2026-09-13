import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openArchiveSource } from "../../shielded-monitor/archive-source.js";
import { createShieldedMonitorApi, silentLogger, type ShieldedMonitorApi } from "../../shielded-monitor/api/server.js";
import { archiveSourceTip } from "../../shielded-monitor/api/source-tip.js";
import { createBalancer, type Balancer } from "../../shielded-monitor/balancer/balancer.js";
import { loadBalancerConfig } from "../../shielded-monitor/balancer/balancer-cli.js";
import { loadMonitorNodeConfig } from "../../shielded-monitor/node/config.js";
import { MonitorNode } from "../../shielded-monitor/node/monitor-node.js";
import { HttpMonitorStore } from "../../shielded-monitor/storage-http-client.js";
import { encodeViewingKey } from "../../shielded-monitor/viewing-key.js";
import { NO_WAKE } from "../../shielded-monitor/wake.js";
import { createScannerWorld, destroyWorld, type ScannerWorld } from "../shielded-monitor/scanner-harness.js";
import { startStorageApi, type StartedStorageApi } from "./helpers.js";

/**
 * **The split deployment, end to end** (00009-09; owner decisions Q25 and Q28; `spec/00009`
 * FR-010, FR-012, FR-025, FR-026, US2, US5).
 *
 * ```text
 *                          ┌── monitor-node-1 ◄────┐        keys live HERE, in RAM only
 *   one PostgreSQL         │   (API + /ui + scan)  │
 *        ▲                 │                       ├── balancer ◄── consumer
 *        │  the ONLY       │   monitor-node-2 ◄────┘   routes registration to the holder
 *        └── credential ── umbradb-storage-api
 * ```
 *
 * Everything below runs as real processes-in-one-process: real HTTP servers, real sockets, real
 * `fetch`. The only thing faked is the container boundary, and it is faked in the direction that
 * makes the test STRONGER — each node holds an `HttpMonitorStore` and nothing else, so a database
 * access from either of them would be a compile error, not a runtime surprise.
 *
 * The nodes are booted with `loops: false` and their queues are turned by hand. That is not a
 * weaker test: it is the same `MonitorNode`, running the same `runQueueAOnce` / `runQueueBOnce`
 * the timers would call, with the suite deciding WHEN instead of racing a poll interval on a
 * shared machine.
 *
 * What it proves, in order:
 *  1. a split B process's environment holds no database configuration, and one is refused;
 *  2. registering every corpus key through the balancer spreads them across both nodes, and each
 *     node's scanning reproduces the fixture oracle exactly once;
 *  3. re-registering a key lands on the node that already HOLDS it — never a second custodian;
 *  4. killing the holder makes the monitor report `key needed`, and re-sending the key routes it
 *     to the survivor, which syncs it back to the tip with no duplicate association;
 *  5. `/internal/*` is answered 404 by the balancer and served by a node;
 *  6. a consumer can page matches across nodes through the balancer.
 */

const NET = "undeployed";

/** Polls `predicate` until it is true or the budget runs out. */
async function waitFor(predicate: () => Promise<boolean>, budgetMs: number, what: string): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`${what}: not met within ${budgetMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

interface RunningNode {
  readonly node: MonitorNode;
  readonly api: ShieldedMonitorApi;
  readonly url: string;
}

describe("the split topology: 2 monitor-nodes + 1 balancer + 1 storage API, one database", () => {
  let container: StartedPostgreSqlContainer;
  let world: ScannerWorld;
  let storage: StartedStorageApi;
  let nodes: RunningNode[] = [];
  let balancer: Balancer;
  let balancerUrl: string;
  /** The highest height archived so far; `appendEmptyBlock` walks it forward, parent-linked. */
  let tipHeight: number;
  let tipHash: string;

  /** The environment a split B container really gets: one URL, and nothing else. */
  const splitEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    STORAGE_URL: storage.baseUrl,
    SHIELDED_MONITOR_NET: NET,
    NET,
    API_PORT: "0",
    ...extra,
  });

  /** Starts one monitor-node exactly as `node-cli.ts` composes it, minus the timers. */
  async function startNode(nodeId: string): Promise<RunningNode> {
    const config = loadMonitorNodeConfig(splitEnv({ MONITOR_NODE_ID: nodeId }));
    const store = new HttpMonitorStore(config.api.storageUrl, { userAgent: nodeId });
    const source = openArchiveSource({ archiveUrl: config.api.archiveUrl, wake: false });
    const node = new MonitorNode(source.archive, store, NO_WAKE, {
      net: config.api.net,
      nodeId,
      syncBatchBlocks: 1,
      // Remote archive ⇒ the transaction-identity check is ON (organizer question Q23). The
      // corpus carries the ledger's real `transactionHash()`, so this exercises it.
      verifyTxIdentity: source.remote,
    });
    const api = createShieldedMonitorApi({
      store,
      config: config.api,
      node,
      sourceTipProvider: archiveSourceTip(source.archive),
      logger: silentLogger(),
    });
    const address = await api.listen();
    await node.start({ loops: false });
    return { node, api, url: `http://127.0.0.1:${address.port}` };
  }

  /**
   * Commits one more, empty, block through the archive's REAL writer, so the tip a node reads
   * moves the way it does in a running deployment. Needed by the lifecycle case: "coverage frozen"
   * only means something while the tip is going somewhere.
   */
  async function appendEmptyBlock(): Promise<bigint> {
    const template = world.corpus.bundles.at(-1)!;
    const height = tipHeight + 1;
    const blockHash = `${"c".repeat(58)}${height.toString(16).padStart(6, "0")}`;
    await world.archiveStore.putBlockBundle({
      ...template,
      block: { ...template.block, height, blockHash, parentHash: tipHash },
      transactions: [],
      bridgeObservations: [],
      watermark: { key: `sync_cursor:${NET}`, value: { height } },
      notifyChannel: "chain_archive_progress",
    });
    tipHeight = height;
    tipHash = blockHash;
    return BigInt(height);
  }

  /** Turns every node's queues until nothing is left to do. */
  async function drainNodes(rounds = 40): Promise<void> {
    for (let round = 0; round < rounds; round++) {
      let worked = false;
      for (const running of nodes) {
        if (await running.node.runQueueBOnce()) worked = true;
        const turn = await running.node.runQueueAOnce();
        if (turn.blocks > 0) worked = true;
      }
      if (!worked) return;
    }
  }

  async function registerThroughBalancer(
    keyId: string,
  ): Promise<{ status: number; upstream: string | null; body: Record<string, unknown> }> {
    const viewingKey = encodeViewingKey(world.corpus.keyBytes.get(keyId)!, NET);
    const response = await fetch(`${balancerUrl}/v1/monitors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ viewingKey, startHeight: 0 }),
    });
    return {
      status: response.status,
      upstream: response.headers.get("x-upstream"),
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    // The harness registers the corpus monitors by fingerprint, which is exactly the state a
    // deployment is in after a restart: rows with coverage and no holder. The nodes below then
    // take custody by being SENT the keys, which is the only way a key ever enters one.
    world = await createScannerWorld(container, "split", { maxConnections: 12 });
    tipHeight = world.corpus.bundles.at(-1)!.block.height;
    tipHash = world.corpus.bundles.at(-1)!.block.blockHash;

    // ── A side: the one process with a credential ──────────────────────────────────────────
    storage = await startStorageApi(world.store, {
      config: { monitorSchema: world.monitorSchema, archiveSchema: world.archiveSchema, net: NET },
      archive: { archive: world.archive },
    });

    nodes = [await startNode("node-1"), await startNode("node-2")];

    balancer = createBalancer({
      upstreams: nodes.map((n) => n.url),
      net: NET,
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
    for (const running of nodes) {
      await running.api?.close();
      await running.node?.stop();
    }
    await storage?.close();
    if (world !== undefined) await destroyWorld(world);
    await container?.stop();
  }, 180_000);

  it("a split B process's environment holds no database configuration, and one is refused", () => {
    const env = splitEnv();
    expect(Object.keys(env).filter((k) => k.endsWith("_PG"))).toStrictEqual([]);
    expect(loadMonitorNodeConfig(env).api.storageUrl).toBe(storage.baseUrl);
    expect(loadBalancerConfig({ ...env, BALANCER_UPSTREAMS: nodes[0]!.url }).net).toBe(NET);
    // And the refusal, from the same environment plus the one variable a migration would leave.
    expect(() => loadMonitorNodeConfig(splitEnv({ MONITOR_PG: "postgres://u:p@h/db" })))
      .toThrow(/database configuration in its environment/);
    expect(() => loadBalancerConfig(splitEnv({
      BALANCER_UPSTREAMS: nodes[0]!.url, MONITOR_PG: "postgres://u:p@h/db",
    }))).toThrow(/database configuration in its environment/);
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

  it("[[storage-api.split-topology.two-monitor-nodes-one-balancer]] every key registered through the balancer is scanned exactly once, by the node that holds it", async () => {
    for (const key of world.corpus.manifest.keys) {
      const created = await registerThroughBalancer(key.id);
      // 200, not 201: the harness already registered these fingerprints, and re-sending a key to
      // a deployment that knows the monitor is the NORMAL recovery flow, not an error.
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      expect(created.body.monitorId).toBe(world.monitors.get(key.id)!);
      expect(nodes.map((n) => n.url)).toContain(created.upstream);
    }

    await drainNodes();

    // 1. The oracle (SC-001), unchanged by a block-centric scan across two nodes.
    const lastHeight = BigInt(world.corpus.bundles.at(-1)!.block.height);
    for (const key of world.corpus.manifest.keys) {
      const monitorId = world.monitors.get(key.id)!;
      const expected = world.corpus.expectedMatches.get(key.id) ?? [];
      const stored = await world.store.readAssociations(monitorId, 0n, 100);
      expect(new Set(stored.map((x) => `${x.blockHeight}/${x.position}`))).toStrictEqual(
        new Set(expected.map((t) => `${t.blockHeight}/${t.position}`)),
      );
      // Exactly once: a (height, position) written twice would show up here as a longer list.
      expect(stored.length).toBe(expected.length);
      const monitor = await world.store.get(monitorId);
      expect(monitor.coverage.scannedThrough).toBe(lastHeight);
      expect(monitor.gaps, `${key.id} should have no holes`).toStrictEqual([]);
    }

    // 2. Non-vacuity: every key is held by exactly one node, and both nodes hold something. A
    //    routing bug that gave every key to one node would pass 1 in silence.
    const holders = new Map<string, string[]>();
    for (const running of nodes) {
      for (const entry of running.node.heldMonitors()) {
        holders.set(entry.monitorId, [...(holders.get(entry.monitorId) ?? []), running.node.nodeId]);
      }
    }
    for (const key of world.corpus.manifest.keys) {
      expect(holders.get(world.monitors.get(key.id)!), `${key.id} must have exactly one holder`)
        .toHaveLength(1);
    }
    expect(new Set([...holders.values()].flat()).size,
      "both nodes should hold at least one key — otherwise placement is not load-aware")
      .toBeGreaterThan(1);
  }, 300_000);

  it("[[shielded-monitor.balancer.duplicate-registration-lands-on-the-holder]] re-sending a key reaches the node that already holds it, and never mints a second custodian", async () => {
    const keyId = "K";
    const monitorId = world.monitors.get(keyId)!;
    const holder = nodes.find((n) => n.node.holdsMonitor(monitorId).holds)!;
    expect(holder, "the previous case must have placed this key").toBeDefined();

    // Five more registrations of the SAME key. Every one must reach the holder — not "usually",
    // which is what a random balancer would give and what would let a second node take custody.
    for (let i = 0; i < 5; i++) {
      const again = await registerThroughBalancer(keyId);
      expect(again.status).toBe(200);
      expect(again.body.monitorId).toBe(monitorId);
      expect(again.upstream).toBe(holder.url);
    }

    // Still exactly one holder, asked of the nodes themselves rather than of the hint table.
    const claiming = nodes.filter((n) => n.node.holdsMonitor(monitorId).holds);
    expect(claiming.map((n) => n.node.nodeId)).toStrictEqual([holder.node.nodeId]);

    // And the balancer's own answer agrees.
    const response = await fetch(`${balancerUrl}/v1/monitors/${monitorId}/holder`);
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ heldBy: holder.node.nodeId });
  }, 180_000);

  it("[[shielded-monitor.node.restart-shows-key-needed-and-a-resend-resumes]] killing the holder leaves `key needed`, and re-sending the key routes it to the survivor and resumes from its coverage", async () => {
    const keyId = "Kprime";
    const monitorId = world.monitors.get(keyId)!;
    const holderIndex = nodes.findIndex((n) => n.node.holdsMonitor(monitorId).holds);
    expect(holderIndex, "the key must be held before it can be lost").toBeGreaterThanOrEqual(0);
    const holder = nodes[holderIndex]!;
    const before = await world.store.readAssociations(monitorId, 0n, 100);
    const coverageBefore = (await world.store.get(monitorId)).coverage.scannedThrough;

    // The node dies. Its keys die with it — that is the design, not a failure of it.
    await holder.api.close();
    await holder.node.stop();
    nodes = nodes.filter((_, i) => i !== holderIndex);
    expect(holder.node.keys.size, "a stopped node must hold nothing").toBe(0);
    await balancer.probeOnce();

    // The deployment now reports the monitor as needing its key back. `heldBy` is the BALANCER's
    // answer — a fan-out over the survivors — not the surviving node's guess about itself.
    const view = await fetch(`${balancerUrl}/v1/monitors/${monitorId}`);
    expect(view.status).toBe(200);
    const body = (await view.json()) as {
      heldBy: string | null; heldPhase: string | null; keyNeeded: boolean; state: string;
    };
    expect(body.heldBy).toBeNull();
    expect(body.heldPhase, "nobody holds it, so there is no phase to report").toBeNull();
    expect(body.keyNeeded).toBe(true);

    // The client re-sends the key. Same fingerprint ⇒ same monitor ⇒ the survivor picks it up and
    // resumes from the coverage already in the database rather than rescanning history.
    const resent = await registerThroughBalancer(keyId);
    expect(resent.status).toBe(200);
    expect(resent.body.monitorId).toBe(monitorId);
    expect(resent.upstream).toBe(nodes[0]!.url);
    await drainNodes();

    const after = await world.store.readAssociations(monitorId, 0n, 100);
    expect(after.map((a) => `${a.blockHeight}/${a.position}`))
      .toStrictEqual(before.map((a) => `${a.blockHeight}/${a.position}`));
    const monitor = await world.store.get(monitorId);
    expect(monitor.coverage.scannedThrough).toBe(coverageBefore);
    expect(nodes[0]!.node.holdsMonitor(monitorId).holds).toBe(true);

    const recovered = await fetch(`${balancerUrl}/v1/monitors/${monitorId}`);
    const recoveredBody = (await recovered.json()) as { heldBy: string | null; keyNeeded: boolean };
    expect(recoveredBody.heldBy).toBe(nodes[0]!.node.nodeId);
    expect(recoveredBody.keyNeeded).toBe(false);
  }, 300_000);

  it("[[shielded-monitor.balancer.internal-routes-are-never-forwarded]] /internal/* is 404 at the balancer and served on a node", async () => {
    for (const path of ["/internal/status", "/internal/holds", "/internal/events", "/internal"]) {
      const response = await fetch(`${balancerUrl}${path}`);
      expect(response.status, `${path} must not be forwarded`).toBe(404);
      expect(response.headers.get("x-upstream"), `${path} must not have reached a node`).toBeNull();
    }
    // The same route IS served on a node, which is what makes the 404 above a routing decision
    // rather than a missing feature.
    const direct = await fetch(`${nodes[0]!.url}/internal/status`);
    expect(direct.status).toBe(200);
    expect((await direct.json()) as { nodeId: string }).toMatchObject({ nodeId: nodes[0]!.node.nodeId });
  }, 60_000);

  it("a consumer pages matches through the balancer and the pages concatenate into the oracle", async () => {
    // The property that makes a random balancer legitimate for reads: a cursor is a per-monitor
    // association sequence, not a server handle, so a consumer may be moved between nodes.
    const monitorId = world.monitors.get("K")!;
    const seenMatches: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 12; page++) {
      const url = new URL(`${balancerUrl}/v1/monitors/${monitorId}/matches`);
      url.searchParams.set("limit", "1");
      if (cursor !== undefined) url.searchParams.set("cursor", cursor);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        items: { blockHeight: string; position: number }[];
        nextCursor: string;
        coverage: { sourceTip?: string | null };
      };
      for (const match of body.items) seenMatches.push(`${match.blockHeight}/${match.position}`);
      // The archive read contract travels over the same base URL, so a split node still answers
      // "am I caught up?" honestly (organizer question Q14).
      expect(body.coverage.sourceTip).toBe(String(world.corpus.bundles.at(-1)!.block.height));
      if (body.items.length === 0) break;
      cursor = body.nextCursor;
    }
    expect(new Set(seenMatches)).toStrictEqual(
      new Set((world.corpus.expectedMatches.get("K") ?? []).map((t) => `${t.blockHeight}/${t.position}`)),
    );
  }, 180_000);

  it("the dashboard and the monitor list are served through the balancer, with custody filled in", async () => {
    const list = await fetch(`${balancerUrl}/v1/monitors`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      items: {
        monitorId: string; state: string; heldBy: string | null; heldPhase: string | null;
        keyNeeded: boolean; gaps: unknown[];
      }[];
      sourceTip: string | null;
      net: string;
    };
    expect(body.items.length).toBe(world.corpus.manifest.keys.length);
    // `heldBy` is the DEPLOYMENT's answer: the node that served this request can only speak for
    // itself, so a list in which every item held by the other node read `null` would be the bug
    // this assertion exists to catch.
    const held = body.items.filter((m) => m.heldBy !== null);
    expect(held.length).toBe(body.items.length);
    expect(body.items.every((m) => m.keyNeeded === false)).toBe(true);
    // The key's PHASE inside its holder travels too, and it is a different fact from the state:
    // `live` here means "in the block-centric pass", not "coverage has reached the tip".
    expect(body.items.every((m) => m.heldPhase === "live"), JSON.stringify(body.items.map((m) => m.heldPhase)))
      .toBe(true);
    expect(body.items.every((m) => Array.isArray(m.gaps))).toBe(true);
    expect(body.sourceTip).toBe(String(world.corpus.bundles.at(-1)!.block.height));
    expect(body.net).toBe(NET);

    const ui = await fetch(`${balancerUrl}/ui`);
    expect(ui.status).toBe(200);
    expect(ui.headers.get("content-type")).toContain("text/html");
    expect(ui.headers.get("x-upstream")).not.toBeNull();
  }, 120_000);

  it("[[shielded-monitor.key-never-logged-through-the-balancer-and-the-node]] a registration's viewing key never reaches a log line, at the balancer or at the node", async () => {
    // SC-004, extended to 00009-09's two new handlers: the balancer READS the body in order to
    // route it, and the node holds the key in RAM for the rest of its life. Both are new places a
    // key could leak into a log, so both are captured and searched here — with a positive control,
    // because a search that can never find anything proves nothing.
    const lines: string[] = [];
    const capture = (line: string): void => { lines.push(line); };
    const loggingBalancer = createBalancer({
      upstreams: nodes.map((n) => n.url),
      net: NET,
      host: "127.0.0.1",
      port: 0,
      probeMs: 0,
      requestTimeoutMs: 20_000,
      logger: capture,
    });
    const url = `http://127.0.0.1:${(await loggingBalancer.listen()).port}`;
    const apiLines: string[] = [];
    const loggingNode = await (async () => {
      const config = loadMonitorNodeConfig(splitEnv({ MONITOR_NODE_ID: "node-logging" }));
      const store = new HttpMonitorStore(config.api.storageUrl);
      const source = openArchiveSource({ archiveUrl: config.api.archiveUrl, wake: false });
      const node = new MonitorNode(source.archive, store, NO_WAKE, {
        net: NET, nodeId: "node-logging", logger: (line) => apiLines.push(line),
      });
      const api = createShieldedMonitorApi({
        store,
        config: config.api,
        node,
        logger: { log: (record) => apiLines.push(JSON.stringify(record)) },
      });
      const address = await api.listen();
      await node.start({ loops: false });
      return { node, api, url: `http://127.0.0.1:${address.port}` };
    })();

    const viewingKey = encodeViewingKey(world.corpus.keyBytes.get("K")!, NET);
    try {
      await fetch(`${url}/v1/monitors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewingKey, startHeight: 0 }),
      });
      // A deliberately malformed key too: the error path is where a message is most likely to
      // quote its input.
      await fetch(`${loggingNode.url}/v1/monitors`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ viewingKey: `${viewingKey}zz`, startHeight: 0 }),
      });

      const captured = [...lines, ...apiLines].join("\n");
      expect(captured).not.toContain(viewingKey);
      // Not even a fragment: a truncated key is still key material.
      expect(captured).not.toContain(viewingKey.slice(-24));
      // Positive control: the search WOULD find the key if it were there.
      expect(`${captured}\n${viewingKey}`).toContain(viewingKey);
    } finally {
      await loggingBalancer.close();
      await loggingNode.api.close();
      await loggingNode.node.stop();
    }
  }, 180_000);

  it("[[shielded-monitor.node.delete-through-the-balancer-destroys-the-key-and-the-rows]] a delete through the balancer drops the key from its holder within one block, answers 404 afterwards, and lets the same key start a FRESH monitor", async () => {
    // The whole lifecycle a consumer has, end to end over two nodes and a real database (owner
    // decision Q33): give a key, delete it, and what is left is nothing — no key in RAM, no
    // matches, no monitor. Registering the same key again is a new monitor, not a resurrection.
    const keyId = "Kthird";
    const monitorId = world.monitors.get(keyId)!;
    const holder = nodes.find((n) => n.node.holdsMonitor(monitorId).holds)!;
    expect(holder, "the key must be held before it can be deleted").toBeDefined();
    expect((await world.store.readAssociations(monitorId, 0n, 100)).length).toBeGreaterThan(0);

    // ── The delete ─────────────────────────────────────────────────────────────────────────
    const deleted = await fetch(`${balancerUrl}/v1/monitors/${monitorId}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);

    // The holder destroys the key. Nothing has been scanned since, so the only thing that can
    // have told it this fast is the event the balancer forwarded after that 204; the `not-found`
    // fence on the next block is the backstop, and the block below proves it too.
    await waitFor(
      async () => !holder.node.holdsMonitor(monitorId).holds,
      10_000,
      "the holder destroys the key it was given",
    );

    // ── Afterwards, the monitor is gone for every reader ───────────────────────────────────
    expect((await fetch(`${balancerUrl}/v1/monitors/${monitorId}`)).status).toBe(404);
    expect((await fetch(`${balancerUrl}/v1/monitors/${monitorId}/matches`)).status).toBe(404);
    expect((await fetch(`${balancerUrl}/v1/monitors/${monitorId}`, { method: "DELETE" })).status).toBe(404);
    expect((await world.store.listAll(100)).map((m) => m.id)).not.toContain(monitorId);
    const rows = await world.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${world.sql(world.monitorSchema)}.associations
       WHERE monitor_id = ${monitorId}
    `;
    expect(rows[0]?.n, "the matches went with it").toBe(0);

    // ── The tip moves; nothing resurrects ──────────────────────────────────────────────────
    const newHeight = await appendEmptyBlock();
    await drainNodes();
    expect(nodes.some((n) => n.node.holdsMonitor(monitorId).holds)).toBe(false);
    // Non-vacuity: the block really was scanned, for the monitors that are still alive.
    const neighbour = world.monitors.get("K")!;
    expect((await world.store.get(neighbour)).coverage.scannedThrough).toBe(newHeight);

    // ── The same key can be given again, and it starts over ────────────────────────────────
    const reborn = await registerThroughBalancer(keyId);
    expect(reborn.status, JSON.stringify(reborn.body)).toBe(201);
    expect(reborn.body.monitorId).not.toBe(monitorId);
    expect(reborn.body.state).toBe("backfilling");
    const rebornId = reborn.body.monitorId as string;
    expect((await world.store.get(rebornId)).coverage.scannedThrough,
      "a fresh monitor has scanned nothing").toBeUndefined();
    expect(await world.store.readAssociations(rebornId, 0n, 10)).toStrictEqual([]);
  }, 300_000);
});
