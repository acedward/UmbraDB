import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { FingerprintLocks, fingerprintHexToBase64Url, routingKeyFor } from "./routing.js";

/**
 * `umbradb-shielded-monitor-balancer` — the only published port of project B, and since 00009-09
 * the component that decides **which monitor-node a viewing key goes to**.
 *
 * ── What changed in 00009-09 ────────────────────────────────────────────────────────────────
 * In 00009-08 every B instance was interchangeable, so "pick one at random" was the whole policy.
 * It is still the whole policy for every route but one: a viewing key now lives in the RAM of
 * exactly ONE node, so `POST /v1/monitors` must reach the node that already holds that key —
 * otherwise a second node takes custody of it and two nodes scan one monitor.
 *
 * There is deliberately no shared database and no lease to consult. What a node holds in RAM is
 * the truth, so the balancer ASKS (owner decision Q28):
 *
 * ```text
 *   fp := fingerprint(decodeBech32m(body.viewingKey), net)      # no WASM — see routing.ts
 *   lock(fp)
 *     candidate := hint[fp]
 *     if candidate and holds(candidate, fp): target := candidate
 *     else:
 *       answers := fan-out over healthy nodes of GET /internal/holds?fp= and GET /internal/status
 *       target  := the node that answers holds=true, else argmin(keysHeld, then queueB)
 *     forward to target; hint[fp] := target
 *   unlock(fp)
 * ```
 *
 * **The hint table is a hint.** It is never trusted without a `holds` check, because the node it
 * names may have restarted since — and a restarted node holds nothing. That single verification is
 * what makes a stale hint self-correcting rather than a source of duplicate custody.
 *
 * ── `heldBy` and `keyNeeded` are filled HERE ────────────────────────────────────────────────
 * A node can only answer "I hold it" or "not me"; it cannot see its peers. So for the two monitor
 * READ routes the balancer buffers the JSON, asks every healthy node which monitors it holds (one
 * request per node, not one per monitor), and rewrites `heldBy`/`keyNeeded` before the response
 * reaches the client. A client therefore sees the deployment's answer, not one node's.
 *
 * ── `/internal/*` is never forwarded ────────────────────────────────────────────────────────
 * A client asking for `/internal/status` gets 404 from the balancer, full stop. The nodes are
 * reachable only from the balancer in every supported topology, and this is the second lock on
 * that door. The balancer is nonetheless the only component that CALLS `/internal/*`, which is
 * why the lifecycle forward below lives here and nowhere else.
 *
 * ── A DELETE is forwarded to the holder (§4.5, owner decisions Q31/Q33) ─────────────────────
 * `DELETE /v1/monitors/<id>` is the only lifecycle operation there is, and it is written by
 * whichever node served the request — it is a storage operation — while the KEY it destroys sits
 * in the RAM of a node that may not be that one. The holder finds out anyway at its next
 * `advance-batch`, which is fenced `not-found` (measured at 2.8 s on the live demo), but "the key
 * is gone" is exactly the claim this system makes about deletion, so it is worth making true in
 * milliseconds rather than in a block. After a 2xx the balancer therefore posts a best-effort
 * `{"type":"stateChanged","monitorId":…}` to the node it believes holds that monitor, or to every
 * healthy node when it has no belief. Fire-and-forget with a short timeout: the client's response
 * has already been written and is never affected by it, a failed forward is logged without a body,
 * and the fence remains the backstop.
 *
 * ── What it still does NOT do ───────────────────────────────────────────────────────────────
 * No TLS, no authentication (there is none anywhere in this alpha, owner Q3), no rate limiting, no
 * sticky sessions for anything but key custody, and **no retry for a POST**: `POST /v1/monitors`
 * hands over a key and `POST …/pause` moves a lifecycle epoch; replaying either would invent a
 * request the client never made. A GET is retried once on another healthy upstream.
 *
 * **The registration body is never logged.** It is read into memory to compute the routing
 * fingerprint and forwarded; the log line for that route carries a method, a path pattern and a
 * status, exactly as every other route's does.
 *
 * **No dependency**: `node:http`/`node:https` only.
 */

export interface BalancerOptions {
  readonly upstreams: readonly string[];
  readonly host: string;
  readonly port: number;
  /** The network this deployment serves. Needed for the HRP check and the fingerprint — a key for
   *  another network is not routable here, and is forwarded unrouted so a node produces the
   *  contract's own error for it. */
  readonly net: string;
  /** Milliseconds between health probes. `0` disables probing entirely (every upstream is then
   *  permanently considered healthy) — useful in a test that drives health explicitly. */
  readonly probeMs: number;
  /** Per-request timeout to an upstream. */
  readonly requestTimeoutMs: number;
  /** Cap on a `POST /v1/monitors` body the balancer reads in order to route it. Matches the API's
   *  own default; a larger body is refused rather than buffered. */
  readonly maxBodyBytes?: number;
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
  /** The current hint table, as `fingerprintHex → upstream base URL`. For the tests; an operator
   *  reads `X-Upstream` and `GET /v1/monitors/<id>/holder` instead. */
  hints(): Map<string, string>;
  /** The custody hints learned from `/internal/holds`, as `monitorId → upstream base URL`. Used to
   *  address a lifecycle event at one node instead of every node. For the tests. */
  monitorHints(): Map<string, string>;
  readonly server: Server;
}

interface Upstream {
  readonly base: string;
  readonly url: URL;
  healthy: boolean;
}

/** What one node answers a `holds`/`status` fan-out. */
interface NodeAnswer {
  readonly upstream: Upstream;
  readonly holds: boolean;
  readonly keysHeld: number;
  readonly queueB: number;
  readonly nodeId?: string;
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/** How long a forwarded lifecycle event may take before it is abandoned. Deliberately short: the
 *  client's response is already out, nothing retries this, and the node re-reads its paused keys
 *  every block anyway. */
const EVENT_FORWARD_TIMEOUT_MS = 2_000;

export function createBalancer(options: BalancerOptions): Balancer {
  const log = options.logger ?? (() => undefined);
  const random = options.random ?? Math.random;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
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

  /** `fingerprintHex → upstream base`. A HINT, never trusted without a `holds` check. */
  const hintTable = new Map<string, string>();
  /** `monitorId → upstream base`, learned from the `/internal/holds` fan-out the read routes
   *  already make. Also a hint, and one that costs nothing to be wrong about: it only decides
   *  WHERE a best-effort lifecycle event is posted, and a node that does not hold the monitor
   *  ignores the event. */
  const monitorHintTable = new Map<string, string>();
  const locks = new FingerprintLocks();

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
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        sendUnavailable(res, err instanceof Error ? err.message : "balancer fault");
      } else {
        res.destroy();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", "http://balancer.invalid");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // ── `/internal/*` stops here ───────────────────────────────────────────────────────────
    // Not proxied, not 403'd: 404, the same answer a client gets for any path that does not
    // exist on this service. A 403 would confirm that the route exists somewhere.
    if (path === "/internal" || path.startsWith("/internal/")) {
      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "no such resource" } });
      return;
    }

    // ── `GET /v1/monitors/<id>/holder` (§5.3) ──────────────────────────────────────────────
    const holderMatch = /^\/v1\/monitors\/([^/]+)\/holder$/.exec(path);
    if (holderMatch !== undefined && holderMatch !== null) {
      if (method !== "GET") {
        sendJson(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "method not allowed" } });
        return;
      }
      const heldBy = await holderOf(decodeURIComponent(holderMatch[1]!));
      sendJson(res, 200, { heldBy });
      return;
    }

    // ── `POST /v1/monitors` — the routed one ───────────────────────────────────────────────
    if (method === "POST" && path === "/v1/monitors") {
      await routeRegistration(req, res, url);
      return;
    }

    // ── The monitor READ routes, rewritten with `heldBy`/`keyNeeded` ───────────────────────
    if (method === "GET" && (path === "/v1/monitors" || /^\/v1\/monitors\/[^/]+$/.test(path))) {
      const served = await serveMonitorRead(res, url);
      if (served) return;
      // Falling through is deliberate: if the rewrite could not be done (the upstream answered
      // something that is not a monitor view — an error body, say) the ordinary proxy serves it
      // verbatim, so a client sees the node's own 404/410 rather than a balancer's guess.
    }

    const first = pick();
    if (first === undefined) {
      sendUnavailable(res, "no upstream is available");
      return;
    }
    // A GET body is not forwarded, so a GET can be replayed. Anything else is read once and
    // streamed, and is never retried.
    proxy(req, res, first, method === "GET" || method === "HEAD", undefined, deleteTargetOf(method, path));
  }

  /**
   * The monitor id of a DELETE, or `undefined` for every other request (§4.5, Q33).
   *
   * Deletion is the only thing a consumer can do to a monitor's state, and the only state change
   * worth waking a holder for. A `found` event has no sender here: it is peer-to-peer between
   * nodes and does not pass through the balancer.
   */
  function deleteTargetOf(method: string, path: string): string | undefined {
    const item = /^\/v1\/monitors\/([^/]+)$/.exec(path);
    if (method === "DELETE" && item !== null) return decodeURIComponent(item[1]!);
    return undefined;
  }

  /**
   * Tells the holder that a monitor was deleted, so it destroys the key now (§4.5).
   * Fire-and-forget, by construction: the client's response was written before this is called,
   * nothing here can change it, and nothing retries.
   *
   * One node when a hint names one, every healthy node otherwise — a fan-out of at most one small
   * POST per node, which is cheaper than the `holds` fan-out it would take to be sure, and equally
   * correct because a node that does not hold the monitor discards the event.
   */
  function forwardStateChanged(monitorId: string): void {
    const hinted = monitorHintTable.get(monitorId);
    const addressed = hinted === undefined
      ? []
      : upstreams.filter((u) => u.base === hinted && u.healthy);
    const targets = addressed.length > 0 ? addressed : selectable();
    for (const upstream of targets) void postStateChanged(upstream, monitorId);
  }

  /** One `POST /internal/events`. Never throws, never logs a body or a monitor id: an operator
   *  needs to know that a node did not take the event, not which monitor it was about. */
  async function postStateChanged(upstream: Upstream, monitorId: string): Promise<void> {
    const payload = Buffer.from(JSON.stringify({ type: "stateChanged", monitorId }), "utf8");
    const failure = await new Promise<string | undefined>((resolve) => {
      const send = upstream.url.protocol === "https:" ? httpsRequest : httpRequest;
      const request = send(
        {
          protocol: upstream.url.protocol,
          hostname: upstream.url.hostname,
          port: upstream.url.port,
          method: "POST",
          path: "/internal/events",
          headers: {
            "content-type": "application/json",
            "content-length": payload.byteLength,
            host: upstream.url.host,
          },
          timeout: Math.min(options.requestTimeoutMs, EVENT_FORWARD_TIMEOUT_MS),
        },
        (response) => {
          response.resume();
          const status = response.statusCode ?? 500;
          resolve(status < 400 ? undefined : `status ${status}`);
        },
      );
      request.on("error", (err: Error) => resolve(err.message));
      request.on("timeout", () => {
        request.destroy();
        resolve("timed out");
      });
      request.end(payload);
    });
    if (failure !== undefined) {
      log(`[balancer] ${upstream.base} did not take a lifecycle event (${failure}); its next block's fence will catch it`);
    }
  }

  /**
   * §4.1 / §7, exactly.
   *
   * The body is read ONCE (it is needed to compute the fingerprint and then to forward), the
   * fingerprint is computed without touching a ledger, and the whole decision runs under that
   * fingerprint's own lock so two simultaneous registrations of one key cannot be placed
   * independently.
   */
  async function routeRegistration(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    let body: Buffer;
    try {
      body = await readBody(req, maxBodyBytes);
    } catch {
      sendJson(res, 413, {
        error: { code: "BODY_TOO_LARGE", message: `request body exceeds ${maxBodyBytes} bytes` },
      });
      return;
    }

    const routing = routingKeyFor(body.toString("utf8"), options.net);
    if (!routing.ok) {
      // Unroutable, so unrouted: a node answers with the contract's own one generic error. The
      // REJECTION is not logged either — "which check failed" is exactly what FR-001 keeps from a
      // caller, and a balancer log an operator pastes into an issue is not a private channel.
      const target = pick();
      if (target === undefined) {
        sendUnavailable(res, "no upstream is available");
        return;
      }
      proxy(req, res, target, false, body);
      return;
    }

    const target = await locks.run(routing.fingerprintHex, async () => {
      const hinted = hintTable.get(routing.fingerprintHex);
      const candidate = hinted === undefined ? undefined : upstreams.find((u) => u.base === hinted && u.healthy);
      if (candidate !== undefined && await holdsOn(candidate, routing.fingerprintHex)) {
        return candidate;
      }
      const answers = await fanOut(routing.fingerprintHex);
      const holders = answers.filter((a) => a.holds);
      if (holders.length > 1) {
        // Two holders is a BUG — a key is supposed to live in exactly one node — and it is loud
        // rather than fatal: the request still gets served, by the first holder, and the operator
        // gets a line naming how many nodes answered yes. Refusing the request would turn a
        // recoverable duplication into an outage.
        log(`[balancer] ${holders.length} nodes claim the same key; routing to the first and continuing`);
      }
      const chosen = holders[0] ?? leastLoaded(answers);
      return chosen?.upstream;
    });

    if (target === undefined) {
      sendUnavailable(res, "no upstream is available");
      return;
    }
    hintTable.set(routing.fingerprintHex, target.base);
    proxy(req, res, target, false, body);
  }

  /** argmin(keysHeld, then queueB) over the nodes that answered. A node that did not answer the
   *  fan-out is not a candidate: placing a key on a node that cannot be reached is how a key ends
   *  up nowhere. */
  function leastLoaded(answers: readonly NodeAnswer[]): NodeAnswer | undefined {
    return [...answers].sort((a, b) =>
      a.keysHeld === b.keysHeld ? a.queueB - b.queueB : a.keysHeld - b.keysHeld)[0];
  }

  /** `GET /internal/holds?fp=` + `GET /internal/status` on every healthy node, in parallel. A node
   *  that fails either call is simply absent from the answers. */
  async function fanOut(fingerprintHex: string): Promise<NodeAnswer[]> {
    const fp = fingerprintHexToBase64Url(fingerprintHex);
    const results = await Promise.all(selectable().map(async (upstream): Promise<NodeAnswer | undefined> => {
      const [holds, status] = await Promise.all([
        internalGet(upstream, `/internal/holds?fp=${fp}`),
        internalGet(upstream, "/internal/status"),
      ]);
      if (status === undefined) return undefined;
      const s = status as { keysHeld?: unknown; queueB?: unknown; nodeId?: unknown };
      return {
        upstream,
        holds: (holds as { holds?: unknown } | undefined)?.holds === true,
        keysHeld: typeof s.keysHeld === "number" ? s.keysHeld : Number.MAX_SAFE_INTEGER,
        queueB: typeof s.queueB === "number" ? s.queueB : Number.MAX_SAFE_INTEGER,
        ...(typeof s.nodeId === "string" ? { nodeId: s.nodeId } : {}),
      };
    }));
    return results.filter((a): a is NodeAnswer => a !== undefined);
  }

  async function holdsOn(upstream: Upstream, fingerprintHex: string): Promise<boolean> {
    const answer = await internalGet(upstream, `/internal/holds?fp=${fingerprintHexToBase64Url(fingerprintHex)}`);
    return (answer as { holds?: unknown } | undefined)?.holds === true;
  }

  /** `{monitorId → {nodeId, phase}}` across every healthy node, in one request per node. */
  async function heldMap(): Promise<Map<string, { nodeId: string; phase: string | null }>> {
    const map = new Map<string, { nodeId: string; phase: string | null }>();
    await Promise.all(selectable().map(async (upstream) => {
      const [held, status] = await Promise.all([
        internalGet(upstream, "/internal/holds"),
        internalGet(upstream, "/internal/status"),
      ]);
      const nodeId = (status as { nodeId?: unknown } | undefined)?.nodeId;
      const monitors = (held as { monitors?: unknown } | undefined)?.monitors;
      if (typeof nodeId !== "string" || !Array.isArray(monitors)) return;
      const here = new Set<string>();
      for (const entry of monitors as { monitorId?: unknown; phase?: unknown }[]) {
        if (typeof entry?.monitorId === "string") {
          here.add(entry.monitorId);
          map.set(entry.monitorId, {
            nodeId,
            phase: typeof entry.phase === "string" ? entry.phase : null,
          });
        }
      }
      // This node just enumerated everything it holds, so it is authoritative about ITSELF: what
      // it named is hinted at it, and what it no longer names is un-hinted from it. Nothing is
      // inferred about the other nodes, whose answers are being folded in concurrently.
      for (const [monitorId, base] of [...monitorHintTable]) {
        if (base === upstream.base && !here.has(monitorId)) monitorHintTable.delete(monitorId);
      }
      for (const monitorId of here) monitorHintTable.set(monitorId, upstream.base);
    }));
    return map;
  }

  async function holderOf(monitorId: string): Promise<string | null> {
    return (await heldMap()).get(monitorId)?.nodeId ?? null;
  }

  /**
   * Serves `GET /v1/monitors` and `GET /v1/monitors/<id>` with `heldBy`/`keyNeeded` filled in.
   *
   * Returns `false` when the upstream's answer is not a monitor view — an error body, a 404, a 410
   * — and the caller then proxies the request normally so the client sees the node's own response
   * rather than something this function invented.
   */
  async function serveMonitorRead(res: ServerResponse, url: URL): Promise<boolean> {
    const upstream = pick();
    if (upstream === undefined) return false;
    const answer = await upstreamJson(upstream, "GET", `${url.pathname}${url.search}`)
      ?? await (async () => {
        const next = pick(upstream);
        return next === undefined ? undefined : await upstreamJson(next, "GET", `${url.pathname}${url.search}`);
      })();
    if (answer === undefined || answer.status !== 200 || answer.json === undefined) return false;

    const body = answer.json as Record<string, unknown>;
    // The SHAPE is checked before the fan-out, not after: an answer that is not a monitor view
    // (an error body, a 404 envelope, a service that is not a monitor-node at all) must cost
    // nothing extra, and this route is on the dashboard's polling path.
    const isList = Array.isArray(body.items);
    const isOne = typeof body.monitorId === "string";
    if (!isList && !isOne) return false;

    const held = await heldMap();
    const patch = (view: Record<string, unknown>): Record<string, unknown> => {
      const monitorId = view.monitorId;
      const holder = typeof monitorId === "string" ? held.get(monitorId) : undefined;
      const heldBy = holder?.nodeId ?? null;
      const state = typeof view.state === "string" ? view.state : "";
      return {
        ...view,
        heldBy,
        heldPhase: holder?.phase ?? null,
        keyNeeded: heldBy === null && (state === "backfilling" || state === "live"),
      };
    };

    if (isList) {
      sendJson(res, 200, {
        ...body,
        items: (body.items as Record<string, unknown>[]).map(patch),
      }, upstream.base);
    } else {
      sendJson(res, 200, patch(body), upstream.base);
    }
    return true;
  }

  // ── Transport ─────────────────────────────────────────────────────────────────────────────

  function proxy(
    req: IncomingMessage,
    res: ServerResponse,
    upstream: Upstream,
    retryable: boolean,
    body?: Buffer,
    /** Set for a DELETE: the monitor whose holder is told about a 2xx, so the key it holds is
     *  destroyed at once rather than at its next block (Q31/Q33). */
    lifecycleMonitorId?: string,
  ): void {
    const target = new URL(req.url ?? "/", upstream.url);
    const send = upstream.url.protocol === "https:" ? httpsRequest : httpRequest;
    const headers = { ...req.headers };
    // The upstream's own vhost, not the balancer's: an API that ever starts checking `host`
    // should see the name it is served under.
    headers.host = upstream.url.host;
    delete headers["accept-encoding"]; // keep the body a pass-through, not a re-encode
    if (body !== undefined) {
      // The body was buffered in order to route it, so its length is known exactly; a stale
      // `transfer-encoding` from the client would contradict that.
      delete headers["transfer-encoding"];
      headers["content-length"] = String(body.byteLength);
    }

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
        const status = upstreamRes.statusCode ?? 502;
        res.writeHead(status, {
          ...upstreamRes.headers,
          "x-upstream": upstream.base,
        });
        upstreamRes.pipe(res);
        // AFTER the client's status and headers are on the wire, so the forward cannot delay,
        // change or fail the response the caller sees.
        if (lifecycleMonitorId !== undefined && status >= 200 && status < 300) {
          forwardStateChanged(lifecycleMonitorId);
        }
      },
    );

    const fail = (err: Error): void => {
      outbound.destroy();
      upstream.healthy = false;
      log(`[balancer] ${upstream.base} failed (${err.message}); marking unhealthy`);
      // A dead node holds nothing, so every hint that names it is wrong. Dropping them here rather
      // than waiting for the next `holds` check means the first registration after a node dies
      // takes the fan-out path immediately instead of spending a round trip on a hint that cannot
      // be true.
      dropHintsFor(upstream);
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
      proxy(req, res, next, false, body, lifecycleMonitorId);
    };

    outbound.on("error", fail);
    outbound.on("timeout", () => fail(new Error(`timed out after ${options.requestTimeoutMs} ms`)));
    if (body === undefined) req.pipe(outbound);
    else outbound.end(body);
  }

  /** A JSON request to an upstream's PUBLIC surface, buffered. Used only by the rewrite path. */
  async function upstreamJson(
    upstream: Upstream, method: string, path: string,
  ): Promise<{ status: number; json?: unknown } | undefined> {
    return await new Promise((resolve) => {
      const send = upstream.url.protocol === "https:" ? httpsRequest : httpRequest;
      const request = send(
        {
          protocol: upstream.url.protocol,
          hostname: upstream.url.hostname,
          port: upstream.url.port,
          method,
          path,
          headers: { accept: "application/json", host: upstream.url.host },
          timeout: options.requestTimeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            try {
              resolve({ status: response.statusCode ?? 502, json: JSON.parse(text) as unknown });
            } catch {
              resolve({ status: response.statusCode ?? 502 });
            }
          });
          response.on("error", () => resolve(undefined));
        },
      );
      request.on("error", () => resolve(undefined));
      request.on("timeout", () => {
        request.destroy();
        resolve(undefined);
      });
      request.end();
    });
  }

  /** A GET against a node's `/internal/*`. `undefined` on any failure: a fan-out treats silence as
   *  "this node is not a candidate", never as "this node said no". */
  async function internalGet(upstream: Upstream, path: string): Promise<unknown> {
    const answer = await upstreamJson(upstream, "GET", path);
    return answer === undefined || answer.status !== 200 ? undefined : answer.json;
  }

  async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
      let chunks: Buffer[] = [];
      let total = 0;
      let settled = false;
      req.on("data", (chunk: Buffer) => {
        if (settled) return;
        total += chunk.byteLength;
        if (total > limit) {
          settled = true;
          chunks = [];
          reject(new Error("body too large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks));
      });
      req.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
  }

  function sendJson(res: ServerResponse, status: number, body: unknown, upstreamBase?: string): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
      ...(upstreamBase === undefined ? {} : { "x-upstream": upstreamBase }),
    });
    res.end(payload);
  }

  function sendUnavailable(res: ServerResponse, reason: string): void {
    sendJson(res, 503, { error: { code: "UPSTREAM_UNAVAILABLE", message: reason } });
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
    // A node that went away lost its keys with it, so its hints are stale by definition.
    if (was && !upstream.healthy) dropHintsFor(upstream);
  }

  /** Forgets everything this balancer believed one node was holding — both the fingerprint hints
   *  that route a registration and the monitor hints that address a lifecycle event. A node that
   *  is gone, or that has just been seen to fail, holds nothing. */
  function dropHintsFor(upstream: Upstream): void {
    for (const [fingerprintHex, base] of [...hintTable]) {
      if (base === upstream.base) hintTable.delete(fingerprintHex);
    }
    for (const [monitorId, base] of [...monitorHintTable]) {
      if (base === upstream.base) monitorHintTable.delete(monitorId);
    }
  }

  async function probeOnce(): Promise<void> {
    await Promise.all(upstreams.map(probe));
  }

  return {
    server,
    healthy: () => upstreams.filter((u) => u.healthy).map((u) => u.base),
    hints: () => new Map(hintTable),
    monitorHints: () => new Map(monitorHintTable),
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
