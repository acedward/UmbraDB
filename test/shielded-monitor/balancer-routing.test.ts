import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBalancer, type Balancer } from "../../shielded-monitor/balancer/balancer.js";
import {
  FingerprintLocks, fingerprintHexToBase64Url, routingKeyFor,
} from "../../shielded-monitor/balancer/routing.js";
import { monitorFingerprint } from "../../shielded-monitor/fingerprint.js";
import { encodeViewingKey } from "../../shielded-monitor/viewing-key.js";
import { fixtureViewingKey } from "./helpers.js";

/**
 * **Registration routing** (00009-09 §4.1 and §7), against node doubles.
 *
 * The split-topology suite proves the same routing with real monitor-nodes and a real database.
 * This file exists for what that suite cannot make happen on demand: a node that answers `holds`
 * one way and `status` another, a hint pointing at a node that has forgotten the key, two nodes
 * claiming one key, and the exact tie-break between `keysHeld` and `queueB`. Those are decision-
 * table facts, and doubles are the only instrument that can enumerate them.
 *
 * The doubles speak the real `/internal/*` wire, so a change to that contract breaks this suite
 * rather than silently making it test a shape nothing serves.
 */

const NET = "undeployed";

interface FakeNode {
  readonly base: string;
  readonly nodeId: string;
  /** Fingerprints (hex) this node claims to hold. */
  readonly holds: Set<string>;
  keysHeld: number;
  queueB: number;
  /** Every `POST /v1/monitors` this node received, as raw bodies. */
  readonly registrations: string[];
  /** Every `POST /internal/events` this node received (00009-09, Q31). */
  readonly events: { type: string; monitorId: string }[];
  /** Every lifecycle write this node served, as `<method> <path>`. */
  readonly lifecycleWrites: string[];
  /** Answers `/internal/*` with 500 — a node that is up but broken. */
  broken: boolean;
  stop(): Promise<void>;
}

/** The monitor id a double reports for a fingerprint it holds. UUID-shaped, because that is what
 *  the real `/internal/holds` answers and what the lifecycle routes take. */
function monitorIdFor(fingerprintHex: string): string {
  const h = fingerprintHex;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Polls until `predicate` holds or the budget runs out. A forwarded event is fire-and-forget by
 *  design, so its arrival is observed rather than awaited. */
async function waitFor(predicate: () => boolean, budgetMs: number, what: string): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`${what}: not met within ${budgetMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function startFakeNode(nodeId: string): Promise<FakeNode> {
  const holds = new Set<string>();
  const registrations: string[] = [];
  const events: { type: string; monitorId: string }[] = [];
  const lifecycleWrites: string[] = [];
  const node = {
    nodeId, holds, registrations, events, lifecycleWrites, keysHeld: 0, queueB: 0, broken: false,
  } as unknown as FakeNode & { base: string };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://node.invalid");
    const json = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
    };
    if (node.broken && url.pathname.startsWith("/internal/")) {
      json(500, { error: "broken" });
      return;
    }
    if (url.pathname === "/v1/health") { json(200, { status: "ok" }); return; }
    if (url.pathname === "/internal/status") {
      json(200, {
        nodeId, net: NET, keysHeld: node.keysHeld, live: node.keysHeld, syncing: 0, paused: 0,
        queueB: node.queueB, liveWatermark: "0", lagBlocks: "0",
      });
      return;
    }
    if (url.pathname === "/internal/holds") {
      const fp = url.searchParams.get("fp");
      if (fp !== null) {
        json(200, { holds: holds.has(Buffer.from(fp, "base64url").toString("hex")) });
        return;
      }
      json(200, { monitors: [...holds].map((h) => ({ monitorId: monitorIdFor(h), phase: "live" })) });
      return;
    }
    if (url.pathname === "/internal/events" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        events.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as { type: string; monitorId: string });
        json(202, { accepted: true });
      });
      return;
    }
    // The one lifecycle write, which any node may serve: it is a storage operation, and the key
    // it destroys may live in another node's RAM.
    if (/^\/v1\/monitors\/[^/]+$/.test(url.pathname) && req.method === "DELETE") {
      req.resume();
      lifecycleWrites.push(`DELETE ${url.pathname}`);
      json(200, { deleted: true });
      return;
    }
    if (url.pathname === "/v1/monitors" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        registrations.push(Buffer.concat(chunks).toString("utf8"));
        json(200, { monitorId: "00000000-0000-4000-8000-000000000000", state: "backfilling" });
      });
      return;
    }
    json(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  node.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  node.stop = async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); }); };
  return node;
}

describe("the balancer's registration routing (00009-09 §7)", () => {
  let one: FakeNode;
  let two: FakeNode;
  let balancer: Balancer;
  let base: string;
  let viewingKey: string;
  let fingerprintHex: string;

  beforeAll(async () => {
    const key = await fixtureViewingKey(4242, NET);
    viewingKey = encodeViewingKey(key.yesIKnowTheSecurityImplicationsOfThis_serialized(), NET);
    fingerprintHex = key.fingerprint.toString("hex");
    one = await startFakeNode("node-1");
    two = await startFakeNode("node-2");
    balancer = createBalancer({
      upstreams: [one.base, two.base],
      net: NET,
      host: "127.0.0.1",
      port: 0,
      probeMs: 0,
      requestTimeoutMs: 5_000,
      // Fixed, so "where did it go" is a routing answer rather than a coin flip. The uniform
      // choice for every OTHER route is the balancer suite's subject, not this one's.
      random: () => 0,
    });
    base = `http://127.0.0.1:${(await balancer.listen()).port}`;
  });

  afterAll(async () => {
    await balancer?.close();
    await one?.stop();
    await two?.stop();
  });

  async function register(): Promise<Response> {
    return await fetch(`${base}/v1/monitors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ viewingKey, startHeight: 0 }),
    });
  }

  function reset(): void {
    one.holds.clear();
    two.holds.clear();
    one.registrations.length = 0;
    two.registrations.length = 0;
    one.keysHeld = 0;
    two.keysHeld = 0;
    one.queueB = 0;
    two.queueB = 0;
    one.broken = false;
    two.broken = false;
    one.events.length = 0;
    two.events.length = 0;
    one.lifecycleWrites.length = 0;
    two.lifecycleWrites.length = 0;
  }

  it("computes the routing fingerprint from a Bech32m decode and a SHA-256, with no ledger", () => {
    // The whole reason `routing.ts` exists as its own module: a balancer must answer "who holds
    // this key" in microseconds, on every registration, and loading a WASM ledger to do it would
    // be absurd. The value it produces must still be the one the node and the database use.
    const routed = routingKeyFor(JSON.stringify({ viewingKey }), NET);
    expect(routed.ok).toBe(true);
    expect(routed.ok && routed.fingerprintHex).toBe(fingerprintHex);
  });

  it("reports, rather than throws, for every body it cannot turn into a routing key", () => {
    expect(routingKeyFor("not json", NET)).toStrictEqual({ ok: false, rejection: "not-json" });
    expect(routingKeyFor("[]", NET)).toStrictEqual({ ok: false, rejection: "not-json" });
    expect(routingKeyFor("{}", NET)).toStrictEqual({ ok: false, rejection: "no-viewing-key" });
    expect(routingKeyFor(JSON.stringify({ viewingKey: "mn_shield-esk_undeployed1zzzz" }), NET))
      .toStrictEqual({ ok: false, rejection: "bech32m" });
    // A key for ANOTHER network decodes cleanly and is still not routable here.
    expect(routingKeyFor(JSON.stringify({ viewingKey }), "preview"))
      .toStrictEqual({ ok: false, rejection: "network-hrp" });
  });

  it("[[shielded-monitor.balancer.routing-decision-table]] follows §7 exactly: hint verified, else fan-out, else the least-loaded node", async () => {
    // ── 1. No hint, nobody holds it → the node with the FEWEST keys ────────────────────────
    reset();
    one.keysHeld = 7;
    two.keysHeld = 2;
    expect((await register()).headers.get("x-upstream")).toBe(two.base);
    expect(two.registrations).toHaveLength(1);
    expect(one.registrations).toHaveLength(0);

    // ── 2. Equal keys → the shorter Queue B breaks the tie ─────────────────────────────────
    reset();
    one.keysHeld = 3;
    two.keysHeld = 3;
    one.queueB = 0;
    two.queueB = 9;
    expect((await register()).headers.get("x-upstream")).toBe(one.base);

    // ── 3. A HOLDER wins over any load ─────────────────────────────────────────────────────
    reset();
    one.keysHeld = 0;
    two.keysHeld = 50;
    two.queueB = 99;
    two.holds.add(fingerprintHex);
    expect((await register()).headers.get("x-upstream")).toBe(two.base);
    expect(balancer.hints().get(fingerprintHex)).toBe(two.base);

    // ── 4. The hint is USED, and it is verified ────────────────────────────────────────────
    // Still pointing at `two` from step 3, which still holds it: no fan-out needed, same answer.
    one.keysHeld = 0;
    expect((await register()).headers.get("x-upstream")).toBe(two.base);

    // ── 5. A STALE hint is not trusted ─────────────────────────────────────────────────────
    // `two` forgets the key (a restart). The hint still names it, and the balancer must check
    // rather than believe — otherwise a restarted node silently keeps receiving a key it lost.
    two.holds.clear();
    one.holds.add(fingerprintHex);
    expect((await register()).headers.get("x-upstream")).toBe(one.base);
    expect(balancer.hints().get(fingerprintHex)).toBe(one.base);

    // ── 6. A node that cannot answer the fan-out is not a candidate ────────────────────────
    // Placing a key on a node that cannot be reached is how a key ends up nowhere.
    reset();
    one.broken = true;
    one.keysHeld = 0;
    two.keysHeld = 40;
    expect((await register()).headers.get("x-upstream")).toBe(two.base);
  }, 60_000);

  it("[[shielded-monitor.balancer.delete-is-forwarded-to-the-holder]] tells the holder about a 2xx DELETE — the hinted node, or every healthy node — without touching the client's response", async () => {
    // Owner decision Q33: deleting is the only thing a consumer can do to a monitor, and it is
    // supposed to destroy the KEY, which lives in the RAM of a node that may not be the one that
    // served the request. The holder finds out at its next block regardless (the `not-found`
    // fence, measured at 2.8 s on the live demo), but "the key is gone" is the claim this system
    // makes, so it is worth making true in milliseconds.
    reset();
    two.holds.add(fingerprintHex);
    const monitorId = monitorIdFor(fingerprintHex);

    // ── 1. HINTED: one node is told, and only that node ────────────────────────────────────
    // The hint comes from the `holds` fan-out the read routes already make, so no extra request
    // is spent learning it.
    expect(await (await fetch(`${base}/v1/monitors/${monitorId}/holder`)).json())
      .toStrictEqual({ heldBy: "node-2" });
    expect(balancer.monitorHints().get(monitorId)).toBe(two.base);

    const deleted = await fetch(`${base}/v1/monitors/${monitorId}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(deleted.headers.get("x-upstream")).toBe(one.base); // served by whoever; forwarded to the holder
    await waitFor(() => two.events.length === 1, 5_000, "the holder is told about the delete");
    expect(two.events).toStrictEqual([{ type: "stateChanged", monitorId }]);
    expect(one.events, "an addressed event must not be broadcast").toStrictEqual([]);

    // A read is not a lifecycle write, and neither is a registration.
    two.events.length = 0;
    await fetch(`${base}/v1/monitors/${monitorId}`);
    await register();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect([...one.events, ...two.events]).toStrictEqual([]);

    // ── 2. UNHINTED: every healthy node is told ────────────────────────────────────────────
    // A node that does not hold the monitor discards the event, so a fan-out of one small POST
    // per node is both cheaper and more reliable than a `holds` fan-out to find the holder first.
    reset();
    const unknownId = monitorIdFor("f".repeat(64));
    expect(balancer.monitorHints().has(unknownId)).toBe(false);
    const unhinted = await fetch(`${base}/v1/monitors/${unknownId}`, { method: "DELETE" });
    expect(unhinted.status).toBe(200);
    await waitFor(() => one.events.length === 1 && two.events.length === 1, 5_000, "both nodes are told");

    // ── 3. A FAILED forward changes nothing the client can see ─────────────────────────────
    reset();
    one.broken = true;
    two.broken = true;
    const stillFine = await fetch(`${base}/v1/monitors/${monitorId}`, { method: "DELETE" });
    expect(stillFine.status).toBe(200);
    expect(await stillFine.json()).toMatchObject({ deleted: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect([...one.events, ...two.events], "the forwards were refused").toStrictEqual([]);
    // And the delete itself still happened — the forward is an extra, never a precondition.
    expect([...one.lifecycleWrites, ...two.lifecycleWrites])
      .toStrictEqual([`DELETE /v1/monitors/${monitorId}`]);
  }, 60_000);

  it("[[shielded-monitor.balancer.hint-invalidated-when-a-node-goes-away]] drops every hint naming a node the moment that node is seen to be gone", async () => {
    reset();
    two.holds.add(fingerprintHex);
    await register();
    expect(balancer.hints().get(fingerprintHex)).toBe(two.base);

    // The node goes away. A dead node holds nothing, so every hint naming it is wrong — and
    // dropping them at the probe rather than at the next `holds` check is what makes the first
    // registration after a death take the fan-out path instead of spending a round trip on a
    // hint that cannot be true.
    await two.stop();
    await balancer.probeOnce();
    expect(balancer.healthy()).toStrictEqual([one.base]);
    expect(balancer.hints().has(fingerprintHex), "a hint naming a dead node must be dropped").toBe(false);

    // And the next registration goes to the survivor.
    one.holds.clear();
    const response = await register();
    expect(response.headers.get("x-upstream")).toBe(one.base);
    // Restart it, so the shared `afterAll` teardown and any later case still work.
    two = await startFakeNode("node-2");
  }, 60_000);

  it("forwards a body it cannot route, rather than inventing its own error for it", async () => {
    // FR-001 requires every intake failure to be ONE indistinguishable client error, produced by
    // the node. A balancer that answered its own 400 for a malformed key would create a second,
    // subtly different error shape for exactly the input a client is most likely to get wrong.
    reset();
    const response = await fetch(`${base}/v1/monitors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ viewingKey: "not-a-key" }),
    });
    expect(response.status).toBe(200); // whatever the node said — here, the double's 200
    expect([one.registrations.length, two.registrations.length].reduce((a, b) => a + b)).toBe(1);
  });

  it("refuses a registration body over the cap instead of buffering it", async () => {
    reset();
    const response = await fetch(`${base}/v1/monitors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ viewingKey: "x".repeat(200_000) }),
    });
    expect(response.status).toBe(413);
    expect(one.registrations.length + two.registrations.length).toBe(0);
  });

  it("serialises registrations of ONE fingerprint and runs different ones concurrently", async () => {
    // Two simultaneous registrations of the same key routed independently can land on two nodes,
    // and then two nodes scan one monitor. Different keys must NOT be serialised: each placement
    // costs a fan-out, and a global lock would make them queue behind each other.
    const locks = new FingerprintLocks();
    const order: string[] = [];
    const slow = async (tag: string, ms: number): Promise<void> => {
      order.push(`${tag}:start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`${tag}:end`);
    };
    await Promise.all([
      locks.run("aa", () => slow("aa-1", 40)),
      locks.run("aa", () => slow("aa-2", 1)),
      locks.run("bb", () => slow("bb", 1)),
    ]);
    // The two `aa` runs never interleave…
    expect(order.indexOf("aa-1:end")).toBeLessThan(order.indexOf("aa-2:start"));
    // …while `bb` finished while `aa-1` was still running.
    expect(order.indexOf("bb:end")).toBeLessThan(order.indexOf("aa-1:end"));
    // And the map does not grow with every key ever seen.
    expect(locks.size).toBe(0);
  });

  it("spells a fingerprint the same way on both sides of the /internal/holds query", () => {
    const fp = monitorFingerprint(NET, Uint8Array.from([1, 2, 3, 4])).toString("hex");
    const encoded = fingerprintHexToBase64Url(fp);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(encoded, "base64url").toString("hex")).toBe(fp);
  });
});
