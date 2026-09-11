import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";

/**
 * `umbradb-shielded-monitor-balancer` — a small random balancer in front of the private API
 * instances (sub-plan 00009-08 v2; owner question Q25: "a small, simple balancer that randomly
 * selects one of the B API processes").
 *
 * ── Why a balancer is safe here at all ──────────────────────────────────────────────────────
 * Because the private API is stateless. Every instance reads and writes the SAME state through
 * the storage API, and the one thing that could have made a request instance-bound — the matches
 * cursor — is a per-monitor association sequence (`shielded-monitor/api/cursor.ts`), not a server
 * handle. So a consumer may page matches across instances mid-scroll and see exactly the sequence
 * it would have seen from one. That is a property of the cursor design, not of this file, and it
 * is what makes "pick one at random" a correct policy rather than a hopeful one.
 *
 * ── Random, not round-robin ─────────────────────────────────────────────────────────────────
 * Round-robin needs shared counter state to be fair across several balancer processes, and
 * "fair" is not a property anything here needs: the instances are interchangeable, the load is
 * one consumer, and an independent uniform choice per request is even in expectation with no
 * state at all. It also has no pathological interleaving: a round-robin balancer restarted at the
 * same phase as its peer sends every request to the same instance.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────────────────────
 * No TLS termination, no authentication (there is none anywhere in this alpha, owner Q3), no
 * rate limiting, no sticky sessions, no request buffering beyond what streaming needs, and no
 * retry for anything but a GET. **A POST is never retried**: `POST /v1/monitors` registers a
 * viewing key and `POST …/pause` moves a lifecycle epoch; a balancer that replayed one of those
 * onto a second instance because the first went quiet would be inventing a second request the
 * consumer never made. A GET is retried once on another healthy upstream, because a GET that
 * failed at the transport changed nothing.
 *
 * ── Health ──────────────────────────────────────────────────────────────────────────────────
 * Each upstream's `/v1/health` is probed every `BALANCER_PROBE_MS`; an upstream that fails a
 * probe is excluded from selection and reinstated on its next success. Selection falls back to
 * "all of them" when NONE is healthy, so a probe misconfiguration degrades to "try anyway"
 * rather than to a hard 503 — except at the very start, before any probe has completed, where
 * every upstream is assumed healthy (optimistic, so a balancer is usable the instant it binds).
 *
 * Responses carry `X-Upstream`, so a test — and an operator with `curl -i` — can see which
 * instance answered.
 *
 * **No dependency**: `node:http`/`node:https` only.
 */

export interface BalancerOptions {
  readonly upstreams: readonly string[];
  readonly host: string;
  readonly port: number;
  /** Milliseconds between health probes. `0` disables probing entirely (every upstream is then
   *  permanently considered healthy) — useful in a test that drives health explicitly. */
  readonly probeMs: number;
  /** Per-request timeout to an upstream. */
  readonly requestTimeoutMs: number;
  readonly logger?: (line: string) => void;
  /** Injectable for the distribution test: returns a float in [0, 1). */
  readonly random?: () => number;
}

export interface Balancer {
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  /** The upstreams currently considered healthy, for the boot banner and the tests. */
  healthy(): string[];
  /** Runs one probe round immediately. Exposed so a test need not sleep for a probe interval. */
  probeOnce(): Promise<void>;
  readonly server: Server;
}

interface Upstream {
  readonly base: string;
  readonly url: URL;
  healthy: boolean;
}

export function createBalancer(options: BalancerOptions): Balancer {
  const log = options.logger ?? (() => undefined);
  const random = options.random ?? Math.random;
  const upstreams: Upstream[] = options.upstreams.map((base) => {
    const url = new URL(base);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`BALANCER_UPSTREAMS entries must be http(s) URLs; got ${base}`);
    }
    // Optimistic until the first probe: a balancer that 503s for its first probe interval is a
    // balancer that fails exactly when a compose stack is coming up.
    return { base: base.replace(/\/+$/, ""), url, healthy: true };
  });
  if (upstreams.length === 0) throw new Error("BALANCER_UPSTREAMS must name at least one upstream");

  let probeTimer: NodeJS.Timeout | undefined;
  let closed = false;

  function selectable(): Upstream[] {
    const healthy = upstreams.filter((u) => u.healthy);
    // None healthy → try them all rather than refusing. A probe that is wrong (a firewall, a
    // renamed health route) must not take down a service whose instances are actually fine.
    return healthy.length > 0 ? healthy : [...upstreams];
  }

  function pick(exclude?: Upstream): Upstream | undefined {
    const candidates = selectable().filter((u) => u !== exclude);
    if (candidates.length === 0) return undefined;
    return candidates[Math.floor(random() * candidates.length)]!;
  }

  const server = createServer((req, res) => {
    const method = (req.method ?? "GET").toUpperCase();
    const first = pick();
    if (first === undefined) {
      sendUnavailable(res, "no upstream is available");
      return;
    }
    // A GET body is not forwarded, so a GET can be replayed. Anything else is read once and
    // streamed, and is never retried.
    proxy(req, res, first, method === "GET" || method === "HEAD");
  });

  function proxy(req: IncomingMessage, res: ServerResponse, upstream: Upstream, retryable: boolean): void {
    const target = new URL(req.url ?? "/", upstream.url);
    const send = upstream.url.protocol === "https:" ? httpsRequest : httpRequest;
    const headers = { ...req.headers };
    // The upstream's own vhost, not the balancer's: an API that ever starts checking `host`
    // should see the name it is served under.
    headers.host = upstream.url.host;
    delete headers["accept-encoding"]; // keep the body a pass-through, not a re-encode

    const outbound = send(
      {
        protocol: upstream.url.protocol,
        hostname: upstream.url.hostname,
        port: upstream.url.port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
        timeout: options.requestTimeoutMs,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, {
          ...upstreamRes.headers,
          "x-upstream": upstream.base,
        });
        upstreamRes.pipe(res);
      },
    );

    const fail = (err: Error): void => {
      outbound.destroy();
      upstream.healthy = false;
      log(`[balancer] ${upstream.base} failed (${err.message}); marking unhealthy`);
      if (res.headersSent) {
        // The upstream died mid-body. Nothing honest is left to do: the client has a truncated
        // response and MUST see it as a failure, not as a complete one.
        res.destroy();
        return;
      }
      if (!retryable) {
        sendUnavailable(res, `the upstream failed and ${req.method ?? "this"} requests are not retried`);
        return;
      }
      const next = pick(upstream);
      if (next === undefined) {
        sendUnavailable(res, "no other upstream is available");
        return;
      }
      log(`[balancer] retrying on ${next.base}`);
      // `retryable: false` on the second attempt: one retry, never a storm.
      proxy(req, res, next, false);
    };

    outbound.on("error", fail);
    outbound.on("timeout", () => fail(new Error(`timed out after ${options.requestTimeoutMs} ms`)));
    req.pipe(outbound);
  }

  function sendUnavailable(res: ServerResponse, reason: string): void {
    const body = JSON.stringify({ error: { code: "UPSTREAM_UNAVAILABLE", message: reason } });
    res.writeHead(503, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    res.end(body);
  }

  async function probe(upstream: Upstream): Promise<void> {
    const was = upstream.healthy;
    upstream.healthy = await new Promise<boolean>((resolve) => {
      const send = upstream.url.protocol === "https:" ? httpsRequest : httpRequest;
      const probeRequest = send(
        {
          protocol: upstream.url.protocol,
          hostname: upstream.url.hostname,
          port: upstream.url.port,
          method: "GET",
          path: "/v1/health",
          timeout: Math.min(options.requestTimeoutMs, 5_000),
        },
        (response) => {
          response.resume();
          resolve((response.statusCode ?? 500) < 400);
        },
      );
      probeRequest.on("error", () => resolve(false));
      probeRequest.on("timeout", () => {
        probeRequest.destroy();
        resolve(false);
      });
      probeRequest.end();
    });
    if (was !== upstream.healthy) {
      log(`[balancer] ${upstream.base} is now ${upstream.healthy ? "healthy" : "unhealthy"}`);
    }
  }

  async function probeOnce(): Promise<void> {
    await Promise.all(upstreams.map(probe));
  }

  return {
    server,
    healthy: () => upstreams.filter((u) => u.healthy).map((u) => u.base),
    probeOnce,
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      if (options.probeMs > 0) {
        probeTimer = setInterval(() => {
          if (!closed) void probeOnce();
        }, options.probeMs);
        probeTimer.unref?.();
      }
      const address = server.address() as AddressInfo;
      return { host: address.address, port: address.port };
    },
    async close() {
      closed = true;
      if (probeTimer !== undefined) clearInterval(probeTimer);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
      });
    },
  };
}
