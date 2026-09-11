import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBalancer, type Balancer } from "../../shielded-monitor/balancer/balancer.js";
import { loadBalancerConfig } from "../../shielded-monitor/balancer/balancer-cli.js";

/**
 * `umbradb-shielded-monitor-balancer` (sub-plan 00009-08 v2; owner question Q25: "a small, simple
 * balancer that randomly selects one of the B API processes").
 *
 * Four properties, and they are the whole contract:
 *
 *  1. **Random, not sticky.** Over 200 requests both upstreams must receive traffic, and the
 *     split must be near even. A balancer that is "random" but in practice pins every request to
 *     one instance would pass a naive "both got at least one" check only by luck, so the
 *     assertion is a real band around 50%.
 *  2. **Health exclusion and reinstatement.** A stopped upstream is out of selection within one
 *     probe, and back in when it returns — otherwise a rolling restart of two API instances takes
 *     the service down.
 *  3. **A GET is retried once; a POST is NEVER retried.** Replaying a POST onto a second instance
 *     is how a balancer invents a request the consumer never made — and this API's POSTs register
 *     viewing keys and move lifecycle epochs.
 *  4. **`X-Upstream` names the instance that answered**, so this suite (and an operator with
 *     `curl -i`) can see the distribution rather than infer it.
 *
 * No Docker and no database: the upstreams are two `node:http` servers that report which one they
 * are. The balancer has no knowledge of the private API at all, so nothing is lost by that.
 */

interface FakeUpstream {
  readonly name: string;
  readonly base: string;
  readonly server: Server;
  /** Requests this instance actually served, as `METHOD path`. */
  readonly seen: string[];
  /** When true, every request is destroyed without a response — a crashed instance. */
  broken: boolean;
  /** When true, `/v1/health` answers 503 — an instance that is up but not ready. */
  unhealthy: boolean;
  stop(): Promise<void>;
}

async function startUpstream(name: string): Promise<FakeUpstream> {
  const seen: string[] = [];
  const state = { broken: false, unhealthy: false };
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/v1/health") {
      if (state.unhealthy || state.broken) {
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok", name }));
      return;
    }
    if (state.broken) {
      req.destroy();
      res.destroy();
      return;
    }
    seen.push(`${req.method ?? "GET"} ${path}`);
    // Drain the body so a POST completes; the payload is irrelevant to the balancer.
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ served: name, path }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    name,
    base: `http://127.0.0.1:${port}`,
    server,
    seen,
    get broken() {
      return state.broken;
    },
    set broken(value: boolean) {
      state.broken = value;
    },
    get unhealthy() {
      return state.unhealthy;
    },
    set unhealthy(value: boolean) {
      state.unhealthy = value;
    },
    stop: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

describe("the private-API balancer", () => {
  let one: FakeUpstream;
  let two: FakeUpstream;
  let balancer: Balancer;
  let base: string;

  beforeAll(async () => {
    one = await startUpstream("api-1");
    two = await startUpstream("api-2");
    balancer = createBalancer({
      upstreams: [one.base, two.base],
      host: "127.0.0.1",
      port: 0,
      // Probing is driven explicitly by `probeOnce()` so the suite never sleeps for an interval.
      probeMs: 0,
      requestTimeoutMs: 5_000,
    });
    const address = await balancer.listen();
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await balancer?.close();
    await one?.stop();
    await two?.stop();
  });

  it("[[shielded-monitor.balancer.random-selection-over-two-upstreams]] spreads 200 requests over both upstreams, near evenly, and names the one that answered", async () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 200; i++) {
      const response = await fetch(`${base}/v1/monitors`);
      expect(response.status).toBe(200);
      const upstream = response.headers.get("x-upstream");
      expect(upstream, "every response must name its upstream").not.toBeNull();
      const body = (await response.json()) as { served: string };
      // The header and the body must agree: a header written from a different variable than the
      // request was sent on would be worse than no header.
      expect(upstream).toBe(body.served === "api-1" ? one.base : two.base);
      counts.set(body.served, (counts.get(body.served) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toStrictEqual(["api-1", "api-2"]);
    const first = counts.get("api-1")!;
    // A uniform choice over two upstreams, 200 draws: the probability of falling outside 70..130
    // is on the order of 10^-5. Tight enough to catch "random" that is really sticky, loose
    // enough not to be flaky.
    expect(first, `api-1 served ${first}/200`).toBeGreaterThan(70);
    expect(first).toBeLessThan(130);
  }, 60_000);

  it("excludes an unhealthy upstream within one probe and reinstates it when it recovers", async () => {
    two.unhealthy = true;
    await balancer.probeOnce();
    expect(balancer.healthy()).toStrictEqual([one.base]);

    const before = two.seen.length;
    for (let i = 0; i < 20; i++) {
      const response = await fetch(`${base}/v1/monitors`);
      expect(response.headers.get("x-upstream")).toBe(one.base);
    }
    expect(two.seen.length, "an excluded upstream must receive nothing").toBe(before);

    two.unhealthy = false;
    await balancer.probeOnce();
    expect(balancer.healthy().sort()).toStrictEqual([one.base, two.base].sort());
  }, 60_000);

  /**
   * A balancer whose choice is FIXED on the first healthy upstream.
   *
   * The retry cases are about what happens after a chosen upstream fails, and a uniform choice
   * would make them pass or fail depending on the draw. `random: () => 0` removes the coin flip
   * without removing anything under test: the selection policy itself is the subject of the
   * distribution case above.
   */
  async function withFirstPicked<T>(body: (b: Balancer, url: string) => Promise<T>): Promise<T> {
    const fixed = createBalancer({
      upstreams: [one.base, two.base],
      host: "127.0.0.1",
      port: 0,
      probeMs: 0,
      requestTimeoutMs: 5_000,
      random: () => 0,
    });
    const address = await fixed.listen();
    try {
      return await body(fixed, `http://127.0.0.1:${address.port}`);
    } finally {
      await fixed.close();
    }
  }

  it("retries a GET on the other upstream when one fails mid-request", async () => {
    // `one` accepts the connection and destroys it: the shape of an instance that dies while
    // serving, which no health probe can have noticed yet.
    one.broken = true;
    try {
      await withFirstPicked(async (fixed, url) => {
        const before = two.seen.length;
        const response = await fetch(`${url}/v1/monitors/abc`);
        expect(response.status).toBe(200);
        expect(response.headers.get("x-upstream")).toBe(two.base);
        expect(two.seen.length).toBe(before + 1);
        // The failure also marked it unhealthy, without waiting for a probe.
        expect(fixed.healthy()).toStrictEqual([two.base]);
      });
    } finally {
      one.broken = false;
    }
  }, 60_000);

  it("NEVER retries a POST — it answers 503 instead of replaying a write", async () => {
    // Only `one` is broken, and it is the one the fixed choice picks. If the balancer retried,
    // `two` would serve the POST and the assertion on its request log would fail — which is the
    // point: a retried write is a write the consumer never made.
    one.broken = true;
    try {
      await withFirstPicked(async (_fixed, url) => {
        const beforeOne = one.seen.length;
        const beforeTwo = two.seen.length;
        const response = await fetch(`${url}/v1/monitors`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ viewingKey: "mn_shield-esk_undeployed1…" }),
        });
        expect(response.status).toBe(503);
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe("UPSTREAM_UNAVAILABLE");
        expect(one.seen.length, "the broken upstream logged nothing").toBe(beforeOne);
        expect(two.seen.length, "the healthy upstream must NOT have received a replay").toBe(beforeTwo);
      });
    } finally {
      one.broken = false;
    }
  }, 60_000);

  it("falls back to trying every upstream when the probe says none is healthy", async () => {
    // A probe that is WRONG (a firewall, a renamed health route) must not take down a service
    // whose instances are fine. Both report 503 on /v1/health while serving requests normally.
    one.unhealthy = true;
    two.unhealthy = true;
    await balancer.probeOnce();
    expect(balancer.healthy()).toStrictEqual([]);
    const response = await fetch(`${base}/v1/monitors`);
    expect(response.status).toBe(200);
    one.unhealthy = false;
    two.unhealthy = false;
    await balancer.probeOnce();
  }, 60_000);

  it("passes the path and query through untouched", async () => {
    const response = await fetch(`${base}/v1/monitors/abc/matches?limit=7&cursor=xyz`);
    const body = (await response.json()) as { path: string };
    expect(body.path).toBe("/v1/monitors/abc/matches?limit=7&cursor=xyz");
  });
});

describe("the balancer's configuration", () => {
  it("requires BALANCER_UPSTREAMS and splits it on commas", () => {
    expect(() => loadBalancerConfig({})).toThrow(/BALANCER_UPSTREAMS is required/);
    expect(loadBalancerConfig({ BALANCER_UPSTREAMS: "http://a:1, http://b:2 " }).upstreams).toStrictEqual([
      "http://a:1",
      "http://b:2",
    ]);
  });

  it("defaults to loopback and refuses a non-numeric port", () => {
    const config = loadBalancerConfig({ BALANCER_UPSTREAMS: "http://a:1" });
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8789);
    expect(config.probeMs).toBe(5_000);
    expect(() => loadBalancerConfig({ BALANCER_UPSTREAMS: "http://a:1", BALANCER_PORT: "x" })).toThrow(
      /invalid BALANCER_PORT/,
    );
  });

  it("refuses a database credential in its environment, like every other project-B process", () => {
    expect(() => loadBalancerConfig({ BALANCER_UPSTREAMS: "http://a:1", MONITOR_PG: "postgres://x" }))
      .toThrow(/database configuration in its environment[\s\S]*MONITOR_PG/);
  });

  it("refuses an upstream that is not an http(s) URL", () => {
    expect(() =>
      createBalancer({
        upstreams: ["ftp://nope"],
        host: "127.0.0.1",
        port: 0,
        probeMs: 0,
        requestTimeoutMs: 1_000,
      }),
    ).toThrow(/http\(s\) URLs/);
  });
});
