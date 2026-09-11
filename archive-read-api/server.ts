import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ArchiveDiscontinuityError,
  type ArchiveReadContract,
} from "../src/interfaces/archive-read-contract.js";
import {
  ARCHIVE_READ_ROUTES,
  ARCHIVE_READ_WIRE_VERSION,
  encodeBlockPage,
  encodeIdentity,
  type ArchiveReadApiErrorCode,
} from "../src/interfaces/archive-read-wire.js";
import { StorageError } from "../src/interfaces/storage-errors.js";
import type { ArchiveProgressEvents, ArchiveProgressSubscription } from "./events.js";
import type { ArchiveReadApiConfig } from "./config.js";

/**
 * `umbradb-archive-read-api` — project A's read contract, served over HTTP
 * (organizer sub-plan 00009-08; `spec/00009` US7, FR-025, FR-027, FR-028).
 *
 * ── What this process is for ────────────────────────────────────────────────────────────────
 * `spec/00009` FR-025 requires project B's only access to A to be read-only through an interface
 * "with no schema knowledge in B, so B can later run in a separate process or TEE". Until now
 * that was true of the CODE (B is typed against `ArchiveReadContract` and nothing else) but not
 * of the DEPLOYMENT: the scanner and the API still constructed the PostgreSQL implementation, so
 * B needed credentials for A's database and the two halves shared a server. This process closes
 * that gap. It is the ONLY thing that speaks to the archive's database on B's behalf, and B's
 * entire egress surface becomes one URL.
 *
 * ── It is read-only, structurally ───────────────────────────────────────────────────────────
 * It holds an {@link ArchiveReadContract}, an interface with exactly two methods, both reads. It
 * has no store, no migration runner, no write path — not "does not currently write", but has
 * nothing in scope that could. A reader checking that claim reads the import list.
 *
 * ── No authentication (lean alpha) ──────────────────────────────────────────────────────────
 * Owner decision Q3 governs this surface the same way it governs B's private API. Everything
 * served here is already public on chain, so the risk is availability, not confidentiality; the
 * page cap and the default loopback bind are what bound it. The TEE step adds mTLS and
 * attestation at this exact boundary — see `docs/shielded-monitor-deployment.md`.
 *
 * ── No framework ────────────────────────────────────────────────────────────────────────────
 * `node:http` and the shared wire codec. Four routes do not earn a dependency, and the repository
 * ships no HTTP framework precisely so that a deployment's attack surface is the code in it.
 */

export interface ArchiveReadApiLogRecord {
  readonly requestId: string;
  readonly method: string;
  /** The matched route PATTERN, never the raw URL. */
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface ArchiveReadApiLogger {
  log(record: ArchiveReadApiLogRecord): void;
}

export function stderrLogger(): ArchiveReadApiLogger {
  return {
    log(record) {
      process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
    },
  };
}

export function silentLogger(): ArchiveReadApiLogger {
  return { log: () => undefined };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly wireCode: ArchiveReadApiErrorCode,
    message: string,
    readonly allow?: readonly string[],
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface ArchiveReadApiOptions {
  readonly archive: ArchiveReadContract;
  readonly config: ArchiveReadApiConfig;
  /** Absent means the `/v1/archive/events` stream serves heartbeats only — an honest degradation
   *  that a client cannot mistake for "no new heights", because it still polls. */
  readonly events?: ArchiveProgressEvents;
  readonly logger?: ArchiveReadApiLogger;
}

export interface ArchiveReadApi {
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  readonly server: Server;
}

/** A `?net=` that is absent falls back to the deployment's one network; anything malformed is
 *  refused rather than passed to the store as a row filter that will simply match nothing. */
function readNet(url: URL, fallback: string): string {
  const raw = url.searchParams.get("net");
  if (raw === null || raw === "") return fallback;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) {
    throw new HttpError(400, "VALIDATION_FAILED", "net must match /^[A-Za-z0-9_-]{1,64}$/");
  }
  return raw;
}

function readAfter(url: URL): number {
  const raw = url.searchParams.get("after");
  // Absent means "from genesis". `-1` is the contract's own exclusive lower bound for that, and
  // it is accepted explicitly so a client can be literal about it.
  if (raw === null || raw === "") return -1;
  if (!/^-?\d+$/.test(raw)) {
    throw new HttpError(400, "VALIDATION_FAILED", `after must be a decimal integer, got ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < -1) {
    throw new HttpError(400, "VALIDATION_FAILED", "after must be >= -1 and a safe integer");
  }
  return value;
}

function readMax(url: URL, cap: number): number {
  const raw = url.searchParams.get("max");
  if (raw === null || raw === "") return cap;
  if (!/^\d+$/.test(raw)) {
    throw new HttpError(400, "VALIDATION_FAILED", `max must be a positive decimal integer, got ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (value < 1) throw new HttpError(400, "VALIDATION_FAILED", "max must be >= 1");
  // CLAMPED, not refused — see `DEFAULT_MAX_BLOCKS_PER_PAGE`'s doc. A page may legitimately hold
  // fewer blocks than asked, so a client that resumes from the last returned height is correct.
  return Math.min(value, cap);
}

export function createArchiveReadApi(options: ArchiveReadApiOptions): ArchiveReadApi {
  const { archive, config } = options;
  const logger = options.logger ?? silentLogger();
  /** Open SSE responses, so `close()` can end them instead of hanging on the server's own
   *  `close()` waiting for streams that never finish by themselves. */
  const streams = new Set<{ response: ServerResponse; subscription?: ArchiveProgressSubscription; timer: NodeJS.Timeout }>();

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    let route = "(unmatched)";

    const finish = (status: number, extra?: { code?: string; message?: string }): void => {
      logger.log({
        requestId,
        method,
        route,
        status,
        durationMs: Date.now() - started,
        ...(extra?.code === undefined ? {} : { errorCode: extra.code }),
        ...(extra?.message === undefined ? {} : { errorMessage: extra.message }),
      });
    };

    const sendJson = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store",
      });
      res.end(payload);
    };

    const sendError = (err: HttpError): void => {
      if (err.allow !== undefined) res.setHeader("allow", err.allow.join(", "));
      sendJson(err.status, { error: { code: err.wireCode, message: err.message, requestId } });
      finish(err.status, { code: err.wireCode, message: err.message });
    };

    try {
      const path = url.pathname.replace(/\/+$/, "") || "/";
      switch (path) {
        case ARCHIVE_READ_ROUTES.health: {
          route = "GET /v1/health";
          if (method !== "GET" && method !== "HEAD") {
            throw new HttpError(405, "METHOD_NOT_ALLOWED", `${method} is not allowed here`, ["GET", "HEAD"]);
          }
          sendJson(200, { status: "ok", net: config.net, wireVersion: ARCHIVE_READ_WIRE_VERSION });
          finish(200);
          return;
        }
        case ARCHIVE_READ_ROUTES.identity: {
          route = "GET /v1/archive/identity";
          if (method !== "GET") {
            throw new HttpError(405, "METHOD_NOT_ALLOWED", `${method} is not allowed here`, ["GET"]);
          }
          const net = readNet(url, config.net);
          const identity = await archive.getArchiveIdentity(net);
          if (identity === undefined) {
            // 404, not an empty object: the contract's `undefined` means "this archive cannot yet
            // say who it is" (no genesis block, or no bootstrap), and a client must be able to
            // tell that from an identity whose fields happen to be empty strings.
            throw new HttpError(404, "NOT_FOUND", `the archive cannot yet identify itself for net ${net}`);
          }
          sendJson(200, encodeIdentity(identity));
          finish(200);
          return;
        }
        case ARCHIVE_READ_ROUTES.blocks: {
          route = "GET /v1/archive/blocks";
          if (method !== "GET") {
            throw new HttpError(405, "METHOD_NOT_ALLOWED", `${method} is not allowed here`, ["GET"]);
          }
          const net = readNet(url, config.net);
          const page = await archive.readBlocksSince(net, readAfter(url), readMax(url, config.maxBlocksPerPage));
          sendJson(200, encodeBlockPage(page));
          finish(200);
          return;
        }
        case ARCHIVE_READ_ROUTES.tip: {
          route = "GET /v1/archive/tip";
          if (method !== "GET") {
            throw new HttpError(405, "METHOD_NOT_ALLOWED", `${method} is not allowed here`, ["GET"]);
          }
          const net = readNet(url, config.net);
          // One block asked for past any possible height: two cheap SELECTs in one snapshot that
          // return no block rows at all. The tip is read; the page is not. Exactly what
          // `shielded-monitor/api/source-tip.ts` already does in-process.
          const page = await archive.readBlocksSince(net, Number.MAX_SAFE_INTEGER - 1, 1);
          sendJson(200, { net, sourceTip: page.sourceTip ?? null });
          finish(200);
          return;
        }
        case ARCHIVE_READ_ROUTES.events: {
          route = "GET /v1/archive/events";
          if (method !== "GET") {
            throw new HttpError(405, "METHOD_NOT_ALLOWED", `${method} is not allowed here`, ["GET"]);
          }
          const net = readNet(url, config.net);
          await openEventStream(res, net);
          finish(200);
          return;
        }
        default:
          throw new HttpError(404, "NOT_FOUND", `no route for ${method} ${path}`);
      }
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(err);
        return;
      }
      if (err instanceof ArchiveDiscontinuityError) {
        // Fail-closed all the way to the client: the page the archive refused to assemble must
        // not become a 500 a client might retry into a different answer.
        sendError(new HttpError(409, "ARCHIVE_DISCONTINUITY", err.message));
        return;
      }
      if (err instanceof StorageError) {
        const code = err.code === "BLOB_INTEGRITY" ? "BLOB_INTEGRITY"
          : err.code === "BLOB_MISSING" ? "BLOB_MISSING"
          : "INTERNAL_ERROR";
        sendError(new HttpError(code === "INTERNAL_ERROR" ? 500 : 409, code, err.message));
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      sendError(new HttpError(500, "INTERNAL_ERROR", message));
    }
  }

  /**
   * The SSE stream.
   *
   * Three things are deliberate:
   *  - **`retry:` is sent first**, so a client that loses the connection reconnects on its own
   *    schedule rather than the browser default;
   *  - **a heartbeat comment every `sseHeartbeatMs`**, because an idle chain produces no events
   *    for minutes and every proxy in existence will eventually close a silent connection — the
   *    heartbeat is what distinguishes "nothing happened" from "the stream is dead";
   *  - **the payload carries only `{net, height}`**, and a consumer must not act on the height
   *    beyond "wake up and read": the authoritative sequence is whatever `/v1/archive/blocks`
   *    returns, which is read inside one snapshot.
   */
  async function openEventStream(res: ServerResponse, net: string): Promise<void> {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      // Nginx and friends buffer `text/event-stream` by default, which turns a live stream into
      // a batch delivered when the buffer fills. This header is the documented opt-out.
      "x-accel-buffering": "no",
    });
    res.write(`retry: 2000\n\n`);

    const timer = setInterval(() => {
      // A comment line: valid SSE, ignored by every parser, and enough to keep intermediaries
      // from reaping the connection.
      res.write(`: heartbeat ${Date.now()}\n\n`);
    }, config.sseHeartbeatMs);
    timer.unref?.();

    const entry: { response: ServerResponse; subscription?: ArchiveProgressSubscription; timer: NodeJS.Timeout } = {
      response: res, timer,
    };
    streams.add(entry);

    const cleanup = (): void => {
      clearInterval(timer);
      streams.delete(entry);
      void entry.subscription?.close();
    };
    res.on("close", cleanup);

    if (options.events !== undefined) {
      try {
        entry.subscription = await options.events.subscribe((event) => {
          if (event.net !== net) return;
          res.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
        });
      } catch (err) {
        // The stream stays open with heartbeats only. A client that treats the stream as
        // authoritative would stall here; nothing does, because polling is the contract and the
        // stream is the optimisation.
        res.write(
          `event: degraded\ndata: ${JSON.stringify({
            reason: err instanceof Error ? err.message : String(err),
          })}\n\n`,
        );
      }
    }
  }

  return {
    server,
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const address = server.address() as AddressInfo;
      return { host: address.address, port: address.port };
    },
    async close() {
      for (const entry of [...streams]) {
        clearInterval(entry.timer);
        await entry.subscription?.close().catch(() => undefined);
        entry.response.end();
      }
      streams.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Idle keep-alive sockets would otherwise hold `close()` open for the agent's timeout.
        server.closeIdleConnections?.();
      });
    },
  };
}
