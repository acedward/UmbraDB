import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { ARCHIVE_READ_WIRE_VERSION } from "../src/interfaces/archive-read-wire.js";
import { StorageError, ValidationError } from "../src/interfaces/storage-errors.js";
import {
  createArchiveRouter,
  silentLogger,
  type ArchiveReadApiLogger,
  type ArchiveRouter,
  type ArchiveRouterOptions,
} from "../archive-read-api/server.js";
import {
  IllegalLifecycleTransitionError,
  InvalidViewingKeyError,
  MonitorFencedError,
  MonitorNotFoundError,
} from "../shielded-monitor/errors.js";
import {
  MONITOR_STORE_PREFIX,
  MONITOR_STORE_WIRE_VERSION,
  base64ToBytes,
  decodeAdvanceBatchItem,
  decodeAssociationInput,
  encodeAdvanceBatchResult,
  encodeAdvanceResult,
  encodeAssociation,
  encodeFillGapResult,
  encodeGap,
  encodeLifecycleEvent,
  encodeMonitor,
  encodeDeletion,
  WireAdvanceBatchRequestSchema,
  WireAdvanceRequestSchema,
  WireAuditRequestSchema,
  WireBindSourceRequestSchema,
  WireFillGapRequestSchema,
  WireRegisterRequestSchema,
  WireTransitionRequestSchema,
  type MonitorStoreErrorCode,
} from "../shielded-monitor/storage-wire.js";
import { MAX_ASSOCIATION_PAGE, type ShieldedMonitorStore } from "../shielded-monitor/store.js";
import type { StorageApiConfig } from "./config.js";

/**
 * `umbradb-storage-api` — the ONE process that holds a credential for the main database
 * (sub-plan 00009-08 v2; owner question Q25; `spec/00009` FR-010, FR-012, FR-025, FR-026).
 *
 * ── What this process is for ────────────────────────────────────────────────────────────────
 * Project B — the scanner, the private API and its dashboard, the details backfill — has **no
 * database connection at all**. Everything it reads and everything it writes travels over one
 * HTTP channel to this process, which owns the single PostgreSQL and executes each command as
 * exactly one database transaction. Two route families:
 *
 * - `/v1/archive/*` — project A's read contract, mounted from `archive-read-api/server.ts` so
 *   there is one implementation of those routes rather than two (FR-027, FR-028, US7).
 * - `/v1/monitor-store/*` — project B's own state, **command-shaped**: one call is one
 *   `BEGIN … COMMIT`, and the commands are the store's methods, not its tables. A client cannot
 *   express "insert this row" — it can only express "advance this monitor through this height
 *   with these associations", which is the unit owner Rule B requires to be atomic.
 *
 * ── The correctness argument, in one paragraph ──────────────────────────────────────────────
 * `POST …/advance` carries the expected epoch, the through-height, the batch's associations and
 * (optionally) the lease renewal in one body, and hands them to one `PgShieldedMonitorStore.
 * advance` call, which is one transaction whose fencing `UPDATE` is the same statement that moves
 * coverage. So the property FR-010/FR-012 asks for — "either nothing of height H, or all of H
 * including coverage" — is unchanged by putting HTTP in front of it: the request either reached
 * the transaction or it did not. What HTTP adds is a THIRD outcome for the CLIENT, "I do not know
 * whether it committed", which is why `HttpMonitorStore` re-reads before retrying rather than
 * re-posting blind (see `shielded-monitor/storage-http-client.ts`).
 *
 * ── No authentication, no encryption (lean alpha) ───────────────────────────────────────────
 * Owner decisions Q3 and Q10/Q25. Registration carries a serialized viewing key in the clear over
 * this hop. The default bind is loopback; a deployment binding anything else must restrict
 * network access itself. This boundary is precisely where the TEE step puts mTLS, attestation and
 * at-rest encryption — that is why it exists now, with the fields in plaintext (Q25 option A:
 * "first divide the process, then figure out the correct structure and add the encryption").
 *
 * ── No framework ────────────────────────────────────────────────────────────────────────────
 * `node:http` plus the shared wire codec and `zod`, both of which the repository already ships.
 * 00009-08 adds no runtime dependency.
 */

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly wireCode: MonitorStoreErrorCode,
    message: string,
    readonly detail?: Record<string, string | number>,
    readonly allow?: readonly string[],
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** The one message every removed lease route answers with (00009-09, owner decision Q28). */
const LEASES_ARE_GONE =
  "monitor leases are gone: what a monitor-node holds in RAM is the truth about who scans a " +
  "monitor, and the balancer asks the nodes rather than reading a table (00009-09, owner " +
  "decision Q28)";

/** A route this API used to serve and deliberately no longer does. */
function gone(message: string): HttpError {
  return new HttpError(410, "GONE", message);
}

export interface StorageApiOptions {
  readonly config: StorageApiConfig;
  readonly store: ShieldedMonitorStore;
  /** Mounted archive routes. Omit for a storage API that serves monitor-store commands only —
   *  which is a legitimate deployment (an archive served on its own port by
   *  `umbradb-archive-read-api`), and is what the monitor-store unit suite runs. */
  readonly archive?: Omit<ArchiveRouterOptions, "config" | "fallthrough" | "serveHealth"> & {
    readonly config: ArchiveRouterOptions["config"];
  };
  readonly logger?: ArchiveReadApiLogger;
}

export interface StorageApi {
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  readonly server: Server;
}

/**
 * Reads a bounded request body.
 *
 * A body over the cap is refused with 413 and the stream is **paused, not drained**: continuing
 * to read a body you have already refused is how a size cap becomes a way to make the server read
 * an unbounded amount anyway. Pausing applies TCP backpressure instead, so a sender stalls rather
 * than being served. The socket is closed once the 413 has been written (see `sendError`) —
 * destroying it before that would truncate the very response that explains the refusal.
 */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.pause();
        reject(new HttpError(413, "PAYLOAD_TOO_LARGE", `request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (err) => reject(err));
  });
}

function parseBody<T>(schema: z.ZodType<T>, text: string, what: string): T {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "VALIDATION_FAILED", `${what}: body is not valid JSON`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new HttpError(
      400,
      "VALIDATION_FAILED",
      `${what}: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

function readPositiveInt(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new HttpError(400, "VALIDATION_FAILED", `${name} must be a positive decimal integer`);
  }
  const value = Number(raw);
  if (value < 1) throw new HttpError(400, "VALIDATION_FAILED", `${name} must be >= 1`);
  // Clamped, not refused: a caller asking for more than the store's own page cap gets the cap,
  // exactly as the archive's `max` does, and pages from the last seq it saw.
  return Math.min(value, max);
}

function readBigint(url: URL, name: string, fallback: bigint): bigint {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d{1,39}$/.test(raw)) {
    throw new HttpError(400, "VALIDATION_FAILED", `${name} must be a non-negative decimal integer`);
  }
  return BigInt(raw);
}

/**
 * Maps a store error onto the wire.
 *
 * Every mapping is lossless in the sense that matters: the client reconstructs the SAME error
 * class with the same discriminants, so code above `HttpMonitorStore` cannot tell which
 * implementation it is holding. `MonitorFencedError` carries its `rejection` and the observed
 * epoch/state because a scanner switches on them; `InvalidViewingKeyError` deliberately carries
 * nothing at all, because FR-001 requires every intake failure to be indistinguishable.
 */
function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof MonitorNotFoundError) {
    return new HttpError(404, "MONITOR_NOT_FOUND", err.message, { monitorId: err.monitorId });
  }
  if (err instanceof MonitorFencedError) {
    // 409, the status the sub-plan names for a stale epoch: the request was well-formed and the
    // server understood it; the monitor moved on underneath it.
    return new HttpError(409, "MONITOR_FENCED", err.message, {
      monitorId: err.monitorId,
      rejection: err.rejection,
      epoch: err.observed.epoch.toString(),
      state: err.observed.state,
    });
  }
  if (err instanceof IllegalLifecycleTransitionError) {
    return new HttpError(409, "MONITOR_ILLEGAL_TRANSITION", err.message, {
      from: err.from,
      event: err.event,
    });
  }
  if (err instanceof InvalidViewingKeyError) {
    return new HttpError(400, "INVALID_VIEWING_KEY", err.message);
  }
  if (err instanceof ValidationError) {
    return new HttpError(400, "VALIDATION_FAILED", err.message);
  }
  if (err instanceof StorageError) {
    return new HttpError(500, "INTERNAL_ERROR", err.message);
  }
  return new HttpError(500, "INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
}

export function createStorageApi(options: StorageApiOptions): StorageApi {
  const { config, store } = options;
  const logger = options.logger ?? silentLogger();
  const archiveRouter: ArchiveRouter | undefined =
    options.archive === undefined
      ? undefined
      : createArchiveRouter({ ...options.archive, fallthrough: true, serveHealth: false, ...(options.logger === undefined ? {} : { logger: options.logger }) });

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (archiveRouter !== undefined && (await archiveRouter.handle(req, res, url))) return;

    const requestId = randomUUID();
    const started = Date.now();
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
      finish(status);
    };

    try {
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (path === "/v1/health") {
        route = "GET /v1/health";
        if (method !== "GET" && method !== "HEAD") {
          throw new HttpError(405, "METHOD_NOT_ALLOWED", `${method} is not allowed here`, undefined, ["GET", "HEAD"]);
        }
        sendJson(200, {
          status: "ok",
          net: config.net,
          wireVersion: ARCHIVE_READ_WIRE_VERSION,
          monitorStoreWireVersion: MONITOR_STORE_WIRE_VERSION,
          archiveRoutes: archiveRouter !== undefined,
        });
        return;
      }
      if (!path.startsWith(`${MONITOR_STORE_PREFIX}/`)) {
        throw new HttpError(404, "NOT_FOUND", `no route for ${method} ${path}`);
      }

      const rest = path.slice(MONITOR_STORE_PREFIX.length + 1).split("/").map(decodeURIComponent);
      const result = await dispatch(req, url, method, rest, (matched) => {
        route = matched;
      });
      sendJson(result.status, result.body);
    } catch (err) {
      const http = toHttpError(err);
      if (http.allow !== undefined) res.setHeader("allow", http.allow.join(", "));
      const payload = JSON.stringify({
        error: {
          code: http.wireCode,
          message: http.message,
          requestId,
          ...(http.detail === undefined ? {} : { detail: http.detail }),
        },
      });
      // A refused body is still unread, so the connection cannot be reused: `connection: close`
      // tells the client, and the socket is destroyed only AFTER the response has flushed.
      const refusedBody = http.wireCode === "PAYLOAD_TOO_LARGE";
      res.writeHead(http.status, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(payload),
        "cache-control": "no-store",
        ...(refusedBody ? { connection: "close" } : {}),
      });
      if (refusedBody) res.on("finish", () => req.destroy());
      res.end(payload);
      finish(http.status, { code: http.wireCode, message: http.message });
    }
  }

  /**
   * The monitor-store router.
   *
   * Every branch is one store call, and therefore one database transaction. There is deliberately
   * no branch that performs two — a command that needed two would be a command whose atomicity
   * the wire could not promise, and Rule B's whole point is that the unit of atomicity is
   * nameable.
   */
  async function dispatch(
    req: IncomingMessage,
    url: URL,
    method: string,
    segments: readonly string[],
    setRoute: (route: string) => void,
  ): Promise<{ status: number; body: unknown }> {
    const body = async <T>(schema: z.ZodType<T>, what: string): Promise<T> =>
      parseBody(schema, await readBody(req, config.maxBodyBytes), what);

    const [head, second, third] = segments;

    if (head === "monitors" && second === undefined) {
      if (method === "GET") {
        setRoute("GET /v1/monitor-store/monitors");
        const limit = readPositiveInt(url, "limit", 100, 10_000);
        const state = url.searchParams.get("state") ?? "all";
        if (state !== "all" && state !== "active") {
          throw new HttpError(400, "VALIDATION_FAILED", 'state must be "all" or "active"');
        }
        const monitors = state === "active" ? await store.listActive(limit) : await store.listAll(limit);
        return { status: 200, body: { monitors: monitors.map(encodeMonitor) } };
      }
      if (method === "POST") {
        setRoute("POST /v1/monitor-store/monitors");
        const input = await body(WireRegisterRequestSchema, "register");
        // 00009-09: a FINGERPRINT, never a key. The upsert on `(net, fingerprint)` returns the
        // existing record — with its coverage and its gaps — when one is already there, which is
        // what a monitor-node needs in order to resume a key it has been handed again.
        const monitor = await store.register({
          fingerprint: base64ToBytes(input.fingerprint),
          net: input.net,
          requestedStartHeight: BigInt(input.requestedStartHeight),
          matchingRuleVersion: input.matchingRuleVersion,
          ledgerBuild: input.ledgerBuild,
          ...(input.sourceGenesisHash === undefined ? {} : { sourceGenesisHash: input.sourceGenesisHash }),
          ...(input.sourceInstanceId === undefined ? {} : { sourceInstanceId: input.sourceInstanceId }),
          actor: input.actor,
        });
        return { status: 200, body: { monitor: encodeMonitor(monitor) } };
      }
      throw new HttpError(405, "METHOD_NOT_ALLOWED", `${method} is not allowed here`, undefined, ["GET", "POST"]);
    }

    if (head === "monitors" && second === "by-fingerprint" && third !== undefined) {
      setRoute("GET /v1/monitor-store/monitors/by-fingerprint");
      requireGet(method);
      const net = url.searchParams.get("net");
      if (net === null || !/^[A-Za-z0-9_-]{1,64}$/.test(net)) {
        throw new HttpError(400, "VALIDATION_FAILED", "net must match /^[A-Za-z0-9_-]{1,64}$/");
      }
      const monitor = await store.getByFingerprint(net, base64UrlToBytes(third));
      return { status: 200, body: monitor === undefined ? {} : { monitor: encodeMonitor(monitor) } };
    }

    if (head === "monitors" && second !== undefined) {
      const id = second;
      if (third === undefined) {
        setRoute("GET /v1/monitor-store/monitors/<id>");
        requireGet(method);
        // `includeDeleted` is the store's `getIncludingDeleted` — an administrative read used by
        // the restore path and the operator harness, never to serve a consumer.
        if (url.searchParams.get("includeDeleted") === "1") {
          const monitor = await store.getIncludingDeleted(id);
          return { status: 200, body: monitor === undefined ? {} : { monitor: encodeMonitor(monitor) } };
        }
        return { status: 200, body: { monitor: encodeMonitor(await store.get(id)) } };
      }

      switch (third) {
        case "associations": {
          setRoute("GET /v1/monitor-store/monitors/<id>/associations");
          requireGet(method);
          const afterSeq = readBigint(url, "afterSeq", 0n);
          const limit = readPositiveInt(url, "limit", 100, MAX_ASSOCIATION_PAGE);
          const rows = await store.readAssociations(id, afterSeq, limit);
          return { status: 200, body: { associations: rows.map(encodeAssociation) } };
        }
        case "lifecycle": {
          setRoute("GET /v1/monitor-store/monitors/<id>/lifecycle");
          requireGet(method);
          const events = await store.listLifecycleEvents(id);
          return { status: 200, body: { events: events.map(encodeLifecycleEvent) } };
        }
        // ── 00009-09: routes that are deliberately GONE ─────────────────────────────────────
        //
        // 410, not 404. A 404 says "no such route, check your spelling"; these routes EXISTED and
        // were removed, and an operator running a 00009-08 scanner against a 00009-09 storage API
        // deserves to be told which. `key-material` is gone because the database holds no key
        // material any more (owner Q28) and `lease` because what a monitor-node holds in RAM is
        // the truth about who scans a monitor.
        case "key-material":
          setRoute("GET /v1/monitor-store/monitors/<id>/key-material");
          throw gone(
            "the storage API no longer holds key material: a viewing key lives only in the RAM of " +
              "the monitor-node that was given it (00009-09, owner decision Q28)",
          );
        case "lease":
          setRoute("GET /v1/monitor-store/monitors/<id>/lease");
          throw gone(LEASES_ARE_GONE);
        case "gaps": {
          setRoute("GET /v1/monitor-store/monitors/<id>/gaps");
          requireGet(method);
          return { status: 200, body: { gaps: (await store.listGaps(id)).map(encodeGap) } };
        }
        case "fill-gap": {
          setRoute("POST /v1/monitor-store/monitors/<id>/fill-gap");
          requirePost(method);
          const input = await body(WireFillGapRequestSchema, "fill-gap");
          const result = await store.fillGap(id, {
            expectedEpoch: BigInt(input.expectedEpoch),
            from: BigInt(input.from),
            to: BigInt(input.to),
            associations: input.associations.map(decodeAssociationInput),
          });
          return { status: 200, body: encodeFillGapResult(result) };
        }
        case "advance": {
          setRoute("POST /v1/monitor-store/monitors/<id>/advance");
          requirePost(method);
          const input = await body(WireAdvanceRequestSchema, "advance");
          const result = await store.advance(
            id,
            BigInt(input.expectedEpoch),
            BigInt(input.throughHeight),
            input.associations.map(decodeAssociationInput),
            input.fromHeight === undefined ? {} : { fromHeight: BigInt(input.fromHeight) },
          );
          return { status: 200, body: encodeAdvanceResult(result) };
        }
        case "transition": {
          setRoute("POST /v1/monitor-store/monitors/<id>/transition");
          requirePost(method);
          const input = await body(WireTransitionRequestSchema, "transition");
          const epoch = input.expectedEpoch === undefined ? undefined : BigInt(input.expectedEpoch);
          switch (input.event) {
            case "goLive": {
              if (epoch === undefined) {
                throw new HttpError(400, "VALIDATION_FAILED", "goLive requires expectedEpoch");
              }
              return { status: 200, body: { monitor: encodeMonitor(await store.goLive(id, epoch, input.actor)) } };
            }
            case "delete": {
              const monitor = await store.delete(id, input.actor);
              return { status: 200, body: monitor === undefined ? {} : { monitor: encodeMonitor(monitor) } };
            }
            case "markFailed": {
              if (input.error === undefined) {
                throw new HttpError(400, "VALIDATION_FAILED", "markFailed requires error");
              }
              const monitor = await store.markFailed(id, input.actor, input.error, epoch);
              return { status: 200, body: { monitor: encodeMonitor(monitor) } };
            }
            case "markStaleSource": {
              const monitor = await store.markStaleSource(id, input.actor, input.error, epoch);
              return { status: 200, body: { monitor: encodeMonitor(monitor) } };
            }
          }
          break;
        }
        case "bind-source": {
          setRoute("POST /v1/monitor-store/monitors/<id>/bind-source");
          requirePost(method);
          const input = await body(WireBindSourceRequestSchema, "bind-source");
          const result = await store.bindArchiveSource(id, BigInt(input.expectedEpoch), {
            genesisHash: input.genesisHash,
            instanceId: input.instanceId,
          });
          return {
            status: 200,
            body: { applied: result.applied, monitor: encodeMonitor(result.monitor) },
          };
        }
        default:
          throw new HttpError(404, "NOT_FOUND", `no route for ${method} ${url.pathname}`);
      }
    }

    if (head === "advance-batch" && second === undefined) {
      setRoute("POST /v1/monitor-store/advance-batch");
      requirePost(method);
      const input = await body(WireAdvanceBatchRequestSchema, "advance-batch");
      const result = await store.advanceBatch(
        input.net,
        BigInt(input.height),
        base64ToBytes(input.blockHash),
        input.items.map(decodeAdvanceBatchItem),
      );
      return { status: 200, body: encodeAdvanceBatchResult(result) };
    }

    if (head === "leases" && (second === "claim" || second === "release")) {
      setRoute(`POST /v1/monitor-store/leases/${second}`);
      throw gone(LEASES_ARE_GONE);
    }

    if (head === "deletions" && second === undefined) {
      setRoute("GET /v1/monitor-store/deletions");
      requireGet(method);
      return { status: 200, body: { deletions: (await store.listDeletions()).map(encodeDeletion) } };
    }

    if (head === "audit" && second === undefined) {
      setRoute("POST /v1/monitor-store/audit");
      requirePost(method);
      const input = await body(WireAuditRequestSchema, "audit");
      await store.recordAudit(input.actor, input.action, input.monitorId, input.detail);
      return { status: 200, body: { recorded: true } };
    }

    throw new HttpError(404, "NOT_FOUND", `no route for ${method} ${url.pathname}`);
  }

  function requireGet(method: string): void {
    if (method !== "GET") {
      throw new HttpError(405, "METHOD_NOT_ALLOWED", `${method} is not allowed here`, undefined, ["GET"]);
    }
  }
  function requirePost(method: string): void {
    if (method !== "POST") {
      throw new HttpError(405, "METHOD_NOT_ALLOWED", `${method} is not allowed here`, undefined, ["POST"]);
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
      await archiveRouter?.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
      });
    },
  };
}

/** Fingerprints travel in a PATH segment, so they are base64url (no `+`, `/` or `=`), which needs
 *  no percent-encoding and cannot be mangled by a proxy that normalises paths. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) {
    throw new HttpError(400, "VALIDATION_FAILED", "fingerprint must be base64url");
  }
  return new Uint8Array(Buffer.from(value, "base64url"));
}
