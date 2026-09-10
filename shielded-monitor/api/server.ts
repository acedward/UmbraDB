import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { StorageError, ValidationError } from "../../src/interfaces/storage-errors.js";
import {
  IllegalLifecycleTransitionError,
  InvalidViewingKeyError,
  MonitorFencedError,
  MonitorNotFoundError,
  MonitorRevokedError,
} from "../errors.js";
import type { MonitorState } from "../lifecycle.js";
import type { MonitorRecord, PgShieldedMonitorStore } from "../store.js";
import { LEDGER_BUILD_ID, parseViewingKey } from "../viewing-key.js";
import { loadApiConfig, type ApiConfig } from "./config.js";
import { CursorError, decodeCursor, encodeCursor } from "./cursor.js";
import { unknownSourceTip, type SourceTipProvider } from "./source-tip.js";
import { coverageView, matchView, monitorView, type MatchPageView, type MonitorView } from "./views.js";

/**
 * The private shielded-monitor HTTP API (organizer spec FR-017..021, FR-023, FR-026).
 *
 * ── No authentication, by owner decision ────────────────────────────────────────────────────
 * Owner decision Q3 (2026-09-10): the alpha private API has **no security**. There is no
 * authentication, no authorization, no tenant scoping, no rate limiting and no quota. Anyone who
 * can open a TCP connection to the listening port can register a viewing key, read any monitor's
 * matches and delete any monitor. The server therefore binds `127.0.0.1` by default and the
 * documentation states that a deployment binding anything else MUST restrict network access by
 * other means (`docs/shielded-monitor-api.md`, `README.md`, `SECURITY.md`). This is a recorded
 * decision with a recorded consequence, not an oversight.
 *
 * ── No HTTP framework ───────────────────────────────────────────────────────────────────────
 * `node:http` and `zod` (already a dependency). `design/design.md` §7's dependency-minimalism
 * rule applies to this surface as it does to the driver choice, and six routes over two path
 * shapes do not earn a framework — see `openspec/changes/00009-04-private-api-cli/design.md` §1.
 *
 * ── The viewing key exists in exactly one function ──────────────────────────────────────────
 * It is accepted only in the `POST /v1/monitors` body (FR-017), never in a query string, never
 * in a header, never returned. Request logging is handed a fixed record that has no access to a
 * body, and it logs the matched ROUTE PATTERN rather than the raw URL, so a future path parameter
 * cannot become a log field by accident. On the create route no error message is logged at all —
 * that route is the only place in the process where a key exists, so it is the only place a
 * message could quote one (FR-023, SC-004).
 */

// ── Logging ──────────────────────────────────────────────────────────────────────────────────

/** One access-log record. Deliberately a closed shape: there is no `extra` bag a body could be
 *  dropped into, and no field that holds caller-supplied text other than the route pattern
 *  (which this module chooses from a fixed list) and error codes (likewise). */
export interface ApiLogRecord {
  readonly requestId: string;
  readonly method: string;
  /** The matched route PATTERN (`GET /v1/monitors/:id`), never the raw URL. */
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
  readonly requestBytes: number;
  readonly errorCode?: string;
  /** The error's class name, for the 500 path where the code is generic. Never its message. */
  readonly errorName?: string;
  /** Present only for routes where a message cannot contain key material — i.e. everything
   *  except `POST /v1/monitors`. See the class note. */
  readonly errorMessage?: string;
}

export interface ApiLogger {
  log(record: ApiLogRecord): void;
}

/** The default logger: one JSON object per line on stderr. stderr rather than stdout so a
 *  consumer piping the CLI's JSON output is not fed access logs. */
export function stderrLogger(): ApiLogger {
  return {
    log(record) {
      process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
    },
  };
}

/** A logger that discards everything. For tests that assert on their own capture. */
export function silentLogger(): ApiLogger {
  return { log: () => undefined };
}

// ── Wire errors ──────────────────────────────────────────────────────────────────────────────

/** The stable error codes this API returns. A consumer switches on these, not on messages. */
export type ApiErrorCode =
  | "MONITOR_NOT_FOUND"
  | "MONITOR_REVOKED"
  | "ILLEGAL_TRANSITION"
  | "MONITOR_FENCED"
  | "INVALID_VIEWING_KEY"
  | "INVALID_CURSOR"
  | "VALIDATION_FAILED"
  | "BODY_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "METHOD_NOT_ALLOWED"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

interface WireError {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly issues?: ReadonlyArray<{ readonly path: string; readonly message: string }>;
  };
}

/** The fixed message every unmapped fault returns. An unexpected error's message is the one
 *  string here that nobody has reviewed for what it might contain — a driver error can quote a
 *  bound parameter, and on the create path a bound parameter is a viewing key — so it never
 *  reaches the wire. */
const INTERNAL_ERROR_MESSAGE = "internal error";

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly wireCode: ApiErrorCode,
    message: string,
    readonly issues?: ReadonlyArray<{ readonly path: string; readonly message: string }>,
    readonly allow?: readonly string[],
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// ── Boundary schemas (`design/design-interfaces.md` §1.4) ────────────────────────────────────

/**
 * A height on the wire: a JSON number, a decimal string, or the word `"earliest"`.
 *
 * A string is admitted alongside a number for the same reason responses render heights as
 * strings — a height above 2^53 cannot survive a JSON number. `"earliest"` is spelled out rather
 * than encoded as `0` so a consumer's intent ("wherever history starts") is distinguishable in
 * the request from a deliberate `0`; both resolve to height 0 today, and when retention trims
 * history the scanner reports the real boundary through `coverage.scannedFrom`.
 */
const StartHeightSchema = z.union([
  z.literal("earliest"),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z.string().regex(/^\d{1,20}$/, "must be a decimal block height"),
]);

/**
 * The create body.
 *
 * `viewingKey` is typed only as a bounded string; it is never handed to a value-sensitive
 * refinement, and any issue on its path is scrubbed before rendering (see {@link scrubIssues}).
 * Zod's own messages do not echo values today — but "does not today" is not a property, and this
 * is the one field where being wrong is unrecoverable.
 *
 * `.strict()` so an unknown field is a 400 rather than silently ignored: a consumer that
 * misspells `startHeight` should be told, not quietly given height 0.
 */
const CreateMonitorBodySchema = z
  .object({
    viewingKey: z.string().min(1).max(2048),
    startHeight: StartHeightSchema.optional(),
  })
  .strict();

const MonitorIdSchema = z.string().uuid();

function scrubIssues(
  issues: ReadonlyArray<{ readonly path: string; readonly message: string }>,
): ReadonlyArray<{ readonly path: string; readonly message: string }> {
  return issues.map((issue) =>
    issue.path === "viewingKey" || issue.path.startsWith("viewingKey.")
      ? { path: issue.path, message: "invalid" }
      : issue,
  );
}

// ── Server ───────────────────────────────────────────────────────────────────────────────────

export interface ShieldedMonitorApiDeps {
  readonly store: PgShieldedMonitorStore;
  readonly config?: ApiConfig;
  readonly sourceTipProvider?: SourceTipProvider;
  readonly logger?: ApiLogger;
  /** Recorded as the actor on every lifecycle event this API causes. */
  readonly actor?: string;
  readonly matchingRuleVersion?: string;
  readonly ledgerBuild?: string;
}

export interface ShieldedMonitorApi {
  readonly config: ApiConfig;
  readonly server: Server;
  /** Starts listening and resolves with the address actually bound (which matters when
   *  `API_PORT` is 0 — the shared-host-friendly "ask the kernel" case). */
  listen(): Promise<{ readonly host: string; readonly port: number }>;
  close(): Promise<void>;
}

interface Route {
  readonly pattern: string;
  readonly handle: (ctx: RequestContext) => Promise<Reply>;
}

interface RequestContext {
  readonly req: IncomingMessage;
  readonly url: URL;
  readonly monitorId: string;
  readonly requestId: string;
  readBody(): Promise<Buffer>;
}

interface Reply {
  readonly status: number;
  readonly body?: unknown;
}

export function createShieldedMonitorApi(deps: ShieldedMonitorApiDeps): ShieldedMonitorApi {
  const config = deps.config ?? loadApiConfig();
  const store = deps.store;
  const tips = deps.sourceTipProvider ?? unknownSourceTip();
  const logger = deps.logger ?? stderrLogger();
  const actor = deps.actor ?? "private-api";
  const matchingRuleVersion = deps.matchingRuleVersion ?? "shielded-monitor/v1";
  const ledgerBuild = deps.ledgerBuild ?? LEDGER_BUILD_ID;

  /** The source tip, or `undefined` when this deployment cannot observe it. A provider fault is
   *  never allowed to fail a request: `sourceTip` is advisory, and answering "unknown" is
   *  strictly better than 500-ing a status read because the archive reader hiccuped. */
  async function currentTip(net: string): Promise<bigint | undefined> {
    try {
      return await tips.sourceTip(net);
    } catch {
      return undefined;
    }
  }

  async function viewOf(record: MonitorRecord): Promise<MonitorView> {
    return monitorView(record, await currentTip(record.net));
  }

  // ── Handlers ───────────────────────────────────────────────────────────────────────────────

  async function createMonitor(ctx: RequestContext): Promise<Reply> {
    const parsed = CreateMonitorBodySchema.safeParse(await readJson(ctx));
    if (!parsed.success) {
      throw new HttpError(
        400,
        "VALIDATION_FAILED",
        "invalid request body",
        scrubIssues(ValidationError.fromZod("POST /v1/monitors", parsed.error).issues),
      );
    }

    // `parseViewingKey` raises ONE generic error for every failure class — malformed Bech32m,
    // wrong network, non-canonical payload, ledger rejection — carrying no fragment of the input
    // and deliberately no `cause` (organizer spec FR-001, 00009-02's `viewing-key.ts`).
    const key = await parseViewingKey(parsed.data.viewingKey, config.net);
    const requestedStartHeight = resolveStartHeight(parsed.data.startHeight);

    // Idempotent registration (organizer spec FR-004, US1 scenario 5) reported honestly: 201
    // only when a monitor was actually created. A concurrent double-create can still produce two
    // 201s naming the SAME monitor, which is harmless — `register` is idempotent at the database
    // level (`ON CONFLICT … DO NOTHING`) — and is the only way to avoid a lock held across an
    // HTTP request.
    const existing = await store.getByFingerprint(config.net, key.fingerprint);
    if (existing !== undefined) {
      if (existing.state === "revoked") throw new MonitorRevokedError(existing.id);
      return { status: 200, body: await viewOf(existing) };
    }

    const monitor = await store.register({
      key,
      net: config.net,
      requestedStartHeight,
      matchingRuleVersion,
      ledgerBuild,
      actor,
    });
    return { status: 201, body: await viewOf(monitor) };
  }

  async function getMonitor(ctx: RequestContext): Promise<Reply> {
    // `store.get` already draws the contract's own line: `MonitorNotFoundError` for unknown AND
    // for deleted (US3 scenario 4 — a deleted monitor must be indistinguishable from one that
    // never existed), `MonitorRevokedError` for revoked (US3 scenario 3 — refused, not hidden).
    return { status: 200, body: await viewOf(await store.get(ctx.monitorId)) };
  }

  async function getMatches(ctx: RequestContext): Promise<Reply> {
    const record = await store.get(ctx.monitorId);

    const rawCursor = ctx.url.searchParams.get("cursor");
    const afterSeq = rawCursor === null || rawCursor === "" ? 0n : decodeCursor(rawCursor, ctx.monitorId);
    const limit = parseLimit(ctx.url.searchParams.get("limit"), config);

    const associations = await store.readAssociations(ctx.monitorId, afterSeq, limit);
    const last = associations.at(-1);
    const page: MatchPageView = {
      items: associations.map((a) => matchView(ctx.monitorId, a)),
      // An empty page returns the caller's OWN position, not a null and not a reset: a poller
      // that reaches the end of the stream must be able to write `nextCursor` back to its cursor
      // file unconditionally and resume from the same place on the next tick. A `null` here
      // would make every consumer write the same three-line special case, and the consumer that
      // forgets it silently re-reads its whole history.
      nextCursor: encodeCursor(ctx.monitorId, last?.seq ?? afterSeq),
      coverage: coverageView(record.coverage, await currentTip(record.net)),
    };
    return { status: 200, body: page };
  }

  /** Loads a monitor for a lifecycle write and applies the endpoint contract before the
   *  transition table gets a say. Without this, `pause` on a revoked monitor would surface the
   *  store's `IllegalLifecycleTransitionError` as 409, while the contract says every operation on
   *  a revoked monitor answers 410. */
  async function loadForLifecycle(monitorId: string, event: "pause" | "resume" | "revoke" | "delete") {
    const record = await store.getIncludingRevoked(monitorId);
    if (record === undefined || record.state === ("deleted" satisfies MonitorState)) {
      throw new MonitorNotFoundError(monitorId);
    }
    if (record.state === ("revoked" satisfies MonitorState) && event !== "revoke" && event !== "delete") {
      throw new MonitorRevokedError(monitorId);
    }
    return record;
  }

  async function pauseMonitor(ctx: RequestContext): Promise<Reply> {
    await loadForLifecycle(ctx.monitorId, "pause");
    return { status: 200, body: await viewOf(await store.pause(ctx.monitorId, actor)) };
  }

  async function resumeMonitor(ctx: RequestContext): Promise<Reply> {
    await loadForLifecycle(ctx.monitorId, "resume");
    return { status: 200, body: await viewOf(await store.resume(ctx.monitorId, actor)) };
  }

  async function revokeMonitor(ctx: RequestContext): Promise<Reply> {
    const record = await loadForLifecycle(ctx.monitorId, "revoke");
    // Idempotent (organizer spec FR-016): re-revoking answers 200 with the revoked view rather
    // than 410. Refusing a caller's own successful operation because it already succeeded is the
    // one place 410 would be actively unhelpful.
    if (record.state === "revoked") return { status: 200, body: await viewOf(record) };
    return { status: 200, body: await viewOf(await store.revoke(ctx.monitorId, actor)) };
  }

  async function deleteMonitor(ctx: RequestContext): Promise<Reply> {
    // A monitor that is already deleted answers 404, exactly as one that never existed does
    // (US3 scenario 4). After a successful delete, EVERY endpoint for that id answers 404 — the
    // only self-consistent reading of "as if the monitor never existed".
    await loadForLifecycle(ctx.monitorId, "delete");
    await store.delete(ctx.monitorId, actor);
    return { status: 204 };
  }

  async function health(): Promise<Reply> {
    // Organizer spec US6 scenario 2: with zero monitors the API must boot healthy and idle. This
    // endpoint is what makes that observable, and it deliberately touches no table.
    return { status: 200, body: { status: "ok", net: config.net } };
  }

  // ── Routing ────────────────────────────────────────────────────────────────────────────────

  const collectionRoutes: Record<string, Route> = {
    POST: { pattern: "POST /v1/monitors", handle: createMonitor },
  };
  const itemRoutes: Record<string, Route> = {
    GET: { pattern: "GET /v1/monitors/:id", handle: getMonitor },
    DELETE: { pattern: "DELETE /v1/monitors/:id", handle: deleteMonitor },
  };
  const matchesRoutes: Record<string, Route> = {
    GET: { pattern: "GET /v1/monitors/:id/matches", handle: getMatches },
  };
  const actionRoutes: Record<string, Route> = {
    pause: { pattern: "POST /v1/monitors/:id/pause", handle: pauseMonitor },
    resume: { pattern: "POST /v1/monitors/:id/resume", handle: resumeMonitor },
    revoke: { pattern: "POST /v1/monitors/:id/revoke", handle: revokeMonitor },
  };

  /** Resolves a request to a route, or throws the 404/405 the contract requires. Returns the
   *  monitor id too, because path validation belongs with path parsing. */
  function resolve(method: string, url: URL): { route: Route; monitorId: string } {
    const segments = url.pathname.split("/").filter((s) => s !== "");

    if (segments.length === 2 && segments[0] === "v1" && segments[1] === "health") {
      if (method !== "GET") throw methodNotAllowed(["GET"]);
      return { route: { pattern: "GET /v1/health", handle: health }, monitorId: "" };
    }
    if (segments[0] !== "v1" || segments[1] !== "monitors") throw notFound();

    if (segments.length === 2) {
      const route = collectionRoutes[method];
      if (route === undefined) throw methodNotAllowed(Object.keys(collectionRoutes));
      return { route, monitorId: "" };
    }

    const rawId = segments[2] ?? "";
    // The id is validated BEFORE the route is dispatched, so a malformed id is a 404 rather than
    // a `ValidationError` from deep inside the store. A caller cannot tell a malformed id from an
    // unknown one, which is the correct amount of information to give about an id space.
    if (!MonitorIdSchema.safeParse(rawId).success) throw notFound();

    if (segments.length === 3) {
      const route = itemRoutes[method];
      if (route === undefined) throw methodNotAllowed(Object.keys(itemRoutes));
      return { route, monitorId: rawId };
    }
    if (segments.length === 4 && segments[3] === "matches") {
      const route = matchesRoutes[method];
      if (route === undefined) throw methodNotAllowed(Object.keys(matchesRoutes));
      return { route, monitorId: rawId };
    }
    if (segments.length === 4) {
      const route = actionRoutes[segments[3] ?? ""];
      if (route === undefined) throw notFound();
      if (method !== "POST") throw methodNotAllowed(["POST"]);
      return { route, monitorId: rawId };
    }
    throw notFound();
  }

  // ── The request pipeline ───────────────────────────────────────────────────────────────────

  const server = createServer((req, res) => {
    const requestId = randomUUID();
    const startedAt = process.hrtime.bigint();
    let requestBytes = 0;
    let route = "unmatched";

    const finish = (status: number, body: unknown, errorCode?: string, errorName?: string, errorMessage?: string, allow?: readonly string[]): void => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body, bigintSafe), "utf8");
      res.statusCode = status;
      res.setHeader("x-request-id", requestId);
      if (allow !== undefined) res.setHeader("allow", allow.join(", "));
      if (payload !== undefined) {
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("content-length", String(payload.byteLength));
      }
      res.end(payload);
      logger.log({
        requestId,
        method: req.method ?? "?",
        route,
        status,
        durationMs,
        requestBytes,
        ...(errorCode !== undefined ? { errorCode } : {}),
        ...(errorName !== undefined ? { errorName } : {}),
        ...(errorMessage !== undefined ? { errorMessage } : {}),
      });
    };

    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const resolved = resolve(req.method ?? "GET", url);
        route = resolved.route.pattern;
        const ctx: RequestContext = {
          req,
          url,
          monitorId: resolved.monitorId,
          requestId,
          readBody: async () => {
            const body = await readBody(req, config.maxBodyBytes);
            requestBytes = body.byteLength;
            return body;
          },
        };
        const reply = await resolved.route.handle(ctx);
        finish(reply.status, reply.body);
      } catch (err) {
        // `route` is already the matched pattern when the failure happened inside a handler, and
        // "unmatched" when routing itself failed — either way it is one of this module's own
        // fixed strings, never caller text.
        const mapped = mapError(err, requestId, route);
        finish(mapped.status, mapped.body, mapped.body.error.code, mapped.errorName, mapped.logMessage, mapped.allow);
      }
    })();
  });

  // A slow or absent client must not pin a socket forever. Node's defaults are already finite
  // (`requestTimeout` 300 s, `headersTimeout` 60 s); these are tightened because every legitimate
  // request to this API is a few hundred bytes and completes in milliseconds.
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  return {
    config,
    server,
    listen: () =>
      new Promise((resolve_, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.removeListener("error", reject);
          const address = server.address() as AddressInfo | null;
          resolve_({ host: config.host, port: address?.port ?? config.port });
        });
      }),
    close: () =>
      new Promise((resolve_, reject) => {
        // `closeAllConnections` first: `server.close()` alone waits for keep-alive sockets to go
        // idle, which a test's `fetch` agent will happily hold open past the suite's teardown
        // budget.
        server.closeAllConnections();
        server.close((err) => (err === undefined ? resolve_() : reject(err)));
      }),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

function notFound(): HttpError {
  return new HttpError(404, "NOT_FOUND", "no such resource");
}

function methodNotAllowed(allow: readonly string[]): HttpError {
  return new HttpError(405, "METHOD_NOT_ALLOWED", "method not allowed", undefined, allow);
}

/** `JSON.stringify` replacer. The view builders already render every height as a string, so this
 *  is a backstop for a field a future edit forgets — a `bigint` reaching `JSON.stringify`
 *  unhandled throws a `TypeError`, which would turn a correct response into a 500. */
function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString(10) : value;
}

function resolveStartHeight(value: string | number | undefined): bigint {
  if (value === undefined || value === "earliest") return 0n;
  return typeof value === "number" ? BigInt(value) : BigInt(value);
}

function parseLimit(raw: string | null, config: ApiConfig): number {
  if (raw === null || raw === "") return config.defaultPage;
  if (!/^\d{1,9}$/.test(raw)) {
    throw new HttpError(400, "VALIDATION_FAILED", "invalid page size", [
      { path: "limit", message: "must be a decimal integer" },
    ]);
  }
  const limit = Number(raw);
  if (limit < 1 || limit > config.maxPage) {
    throw new HttpError(400, "VALIDATION_FAILED", "invalid page size", [
      { path: "limit", message: `must be between 1 and ${config.maxPage}` },
    ]);
  }
  return limit;
}

/**
 * Reads a request body, enforcing the cap **while reading**.
 *
 * Buffering first and checking after would make the cap a formality: the memory is already spent
 * by the time the check runs, which is precisely what an oversized-body cap exists to prevent.
 * Once the running total passes the limit the promise rejects immediately and every subsequent
 * chunk is **discarded rather than accumulated**, so the peak retained bytes never exceed the
 * cap by more than one chunk.
 *
 * What this deliberately does NOT do is destroy the socket on violation. That is the tempting
 * move — the request is over, why keep reading? — and it loses the response: a client that is
 * still uploading has not read anything yet, so tearing down its connection turns a clean
 * `400 BODY_TOO_LARGE` into a transport error it cannot interpret. Node already handles the
 * remainder correctly on its own: when a response finishes while its request is unconsumed, the
 * server dumps the rest of that request rather than leaving it in the pipe.
 */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    let chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const fail = (err: Error, destroy: boolean): void => {
      if (settled) return;
      settled = true;
      // Free what has been read: the handler is about to answer, and holding the partial body
      // until the socket closes is exactly the memory the cap exists to bound.
      chunks = [];
      if (destroy) req.destroy();
      reject(err);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return; // over the limit already: drain and discard, do not accumulate
      total += chunk.byteLength;
      if (total > maxBytes) {
        fail(new HttpError(400, "BODY_TOO_LARGE", `request body exceeds ${maxBytes} bytes`), false);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    // A broken stream is different: there is no response to preserve, so the socket goes.
    req.on("error", (err) => fail(err instanceof Error ? err : new Error("request stream error"), true));
    req.on("aborted", () => fail(new Error("request aborted"), true));
  });
}

/** Reads and parses a JSON body, checking the content type first. */
async function readJson(ctx: RequestContext): Promise<unknown> {
  const contentType = (ctx.req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "content-type must be application/json");
  }
  const body = await ctx.readBody();
  if (body.byteLength === 0) {
    throw new HttpError(400, "VALIDATION_FAILED", "request body is empty", [
      { path: "", message: "expected a JSON object" },
    ]);
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    // The parser's own message quotes the input around the failure position. On this route the
    // input is a body containing a viewing key, so it is dropped rather than forwarded.
    throw new HttpError(400, "VALIDATION_FAILED", "request body is not valid JSON", [
      { path: "", message: "malformed JSON" },
    ]);
  }
}

interface MappedError {
  readonly status: number;
  readonly body: WireError;
  readonly errorName: string;
  /** What may be written to the log. `undefined` means "log no message at all". */
  readonly logMessage?: string;
  readonly allow?: readonly string[];
}

/**
 * Total map from a thrown value to an HTTP reply (`design/design-interfaces.md` §1.1's single
 * error idiom on the way out).
 *
 * `route` decides whether an error MESSAGE may be logged. `POST /v1/monitors` is the only route
 * on which a viewing key exists anywhere in the process, so it is the only route on which a
 * message — including a driver message that might quote a bound parameter — could contain one.
 * On that route nothing but the code and the class name is logged. Everywhere else the message
 * is this repository's own text about monitor ids, cursors and states, none of which is secret.
 */
function mapError(err: unknown, requestId: string, route: string): MappedError {
  const messageSafeToLog = route !== "POST /v1/monitors";
  const name = err instanceof Error ? err.name : typeof err;
  const withMessage = (m: string): string | undefined => (messageSafeToLog ? m : undefined);

  const wire = (
    status: number,
    code: ApiErrorCode,
    message: string,
    issues?: ReadonlyArray<{ readonly path: string; readonly message: string }>,
    allow?: readonly string[],
  ): MappedError => ({
    status,
    body: { error: { code, message, requestId, ...(issues !== undefined ? { issues } : {}) } },
    errorName: name,
    ...(withMessage(message) !== undefined ? { logMessage: withMessage(message) } : {}),
    ...(allow !== undefined ? { allow } : {}),
  });

  if (err instanceof HttpError) {
    return wire(err.status, err.wireCode, err.message, err.issues, err.allow);
  }
  if (err instanceof CursorError) {
    return wire(400, "INVALID_CURSOR", err.message);
  }
  if (err instanceof InvalidViewingKeyError) {
    // ONE generic message for every intake failure class (organizer spec FR-001). The
    // discriminating `rejection` field stays server-side — and is deliberately not logged on this
    // route either, because the whole point is that a caller cannot learn which check failed.
    return wire(400, "INVALID_VIEWING_KEY", err.message);
  }
  if (err instanceof MonitorNotFoundError) {
    return wire(404, "MONITOR_NOT_FOUND", "no such monitor");
  }
  if (err instanceof MonitorRevokedError) {
    return wire(410, "MONITOR_REVOKED", "monitor is revoked");
  }
  if (err instanceof IllegalLifecycleTransitionError) {
    return wire(409, "ILLEGAL_TRANSITION", err.message);
  }
  if (err instanceof MonitorFencedError) {
    return wire(409, "MONITOR_FENCED", "monitor changed under this request; reload and retry");
  }
  if (err instanceof ValidationError) {
    return wire(400, "VALIDATION_FAILED", "invalid request", scrubIssues(err.issues));
  }
  if (err instanceof StorageError) {
    // A typed storage fault that is not one of B's own — a connection failure, for instance.
    // The code is stable and safe; the message is this repository's, but on the create route it
    // may still have been produced by the driver, so the log rule above applies unchanged.
    return {
      status: 503,
      body: { error: { code: "INTERNAL_ERROR", message: "storage unavailable", requestId } },
      errorName: `${name}:${err.code}`,
      ...(withMessage(err.message) !== undefined ? { logMessage: withMessage(err.message)! } : {}),
    };
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: INTERNAL_ERROR_MESSAGE, requestId } },
    errorName: name,
    // No message, on ANY route: an unmapped error is by definition one nobody has reviewed.
  };
}
