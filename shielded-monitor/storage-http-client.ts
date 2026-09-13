import { ValidationError } from "../src/interfaces/storage-errors.js";
import { HttpArchiveReadContract, type FetchLike } from "./archive-http-client.js";
import {
  IllegalLifecycleTransitionError,
  InvalidViewingKeyError,
  MonitorFencedError,
  MonitorNotFoundError,
  type FenceRejection,
} from "./errors.js";
import {
  MONITOR_STORE_ROUTES,
  MonitorStoreErrorSchema,
  WireAdvanceResultSchema,
  WireBindSourceResultSchema,
  WireAdvanceBatchResultSchema,
  WireDetailsResultSchema,
  WireFillGapResultSchema,
  WireMonitorOptionalSchema,
  bytesToBase64,
  decodeAdvanceBatchResult,
  decodeAdvanceResult,
  decodeAssociationList,
  decodeGapList,
  decodeFillGapResult,
  decodeLifecycleList,
  decodeMonitor,
  decodeMonitorList,
  decodeDeletionList,
  decodeWith,
  encodeAdvanceBatchItem,
  encodeAssociationInput,
  encodeFillGapRequest,
  monitorRoute,
} from "./storage-wire.js";
import type {
  AdvanceBatchItem,
  AdvanceBatchResult,
  AdvanceResult,
  AssociationInput,
  AssociationRecord,
  FillGapInput,
  FillGapResult,
  LifecycleEventRecord,
  MonitorGap,
  MonitorLastError,
  MonitorRecord,
  RegisterMonitorInput,
  DeletionRecord,
  ShieldedMonitorStore,
} from "./store.js";

/**
 * {@link ShieldedMonitorStore}, over HTTP — project B's ENTIRE persistence surface
 * (sub-plan 00009-08 v2; owner question Q25; `spec/00009` FR-010, FR-012, FR-025, FR-026).
 *
 * ── What this replaces ──────────────────────────────────────────────────────────────────────
 * Every `PgShieldedMonitorStore` call project B used to make against its own PostgreSQL. There
 * is no driver here, no connection string, no schema name and no SQL: one base URL
 * (`STORAGE_URL`), and one request per store operation. The A-side `umbradb-storage-api` turns
 * each request back into exactly the one database transaction the method always was, so the
 * atomicity and fencing guarantees of Rule B, FR-010 and FR-012 are the SAME guarantees — they
 * are enforced in the same statements, in the same transaction, on the same rows.
 *
 * ── Errors are reconstructed, not flattened ─────────────────────────────────────────────────
 * A `MonitorFencedError` thrown by the store on the server arrives here as a 409 carrying its
 * `rejection` and the observed epoch and state, and is re-thrown as the SAME class with the SAME
 * fields. That is what lets the scanner, the private API and the parity suite hold either
 * implementation without knowing which: `catch (err) { if (err instanceof MonitorFencedError) … }`
 * behaves identically on both sides of the wire.
 *
 * ── The one genuinely new failure mode: a LOST RESPONSE ─────────────────────────────────────
 * In-process, a call either threw or returned. Over HTTP there is a third outcome: the request
 * reached the server, the transaction committed, and the response never came back. Retrying the
 * POST blind would be the classic way to duplicate a write — except that `advance` is guarded by
 * the monotonic coverage predicate, so a blind retry would be refused rather than duplicated.
 * This client does not rely on that. On a transport failure it **re-reads the monitor** and
 * resolves the ambiguity from the coverage it finds:
 *
 * - coverage already at or past `throughHeight` → the batch committed; report `already-advanced`,
 *   which is exactly what the in-process store reports for a replayed batch (US5 scenario 2);
 * - coverage still short of it → the transaction did not commit (it is all-or-nothing), so the
 *   request is safe to send once more;
 * - the re-read fails too → throw. An unresolved outcome is never guessed at.
 *
 * Reads (GET) are idempotent and are simply retried once.
 *
 * ── No new dependency ───────────────────────────────────────────────────────────────────────
 * Node's global `fetch` and `AbortSignal.timeout`, with `fetch` injectable — the same seam a TEE
 * deployment replaces with an attested, mutually authenticated transport.
 */

/** The storage API answered, but not with something this client can use, and not with an error
 *  it could reconstruct as a store error. */
export class StorageHttpError extends Error {
  readonly code = "STORAGE_HTTP_ERROR" as const;
  constructor(
    readonly status: number,
    readonly serverCode: string | undefined,
    readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = "StorageHttpError";
  }
}

/** The storage API could not be reached at all (DNS, connection refused, timeout, aborted).
 *  `outcomeKnown` says whether the caller may assume nothing was written: `true` for a request
 *  this client proved did not commit, `false` for one whose fate is genuinely unknown. */
export class StorageUnreachableError extends Error {
  readonly code = "STORAGE_UNREACHABLE" as const;
  constructor(
    readonly url: string,
    override readonly cause: unknown,
    readonly outcomeKnown = false,
  ) {
    super(
      `the storage API at ${url} could not be reached: ` +
        (cause instanceof Error ? cause.message : String(cause)) +
        (outcomeKnown ? "" : " (the outcome of this request is UNKNOWN)"),
    );
    this.name = "StorageUnreachableError";
  }
}

export interface HttpMonitorStoreOptions {
  /** Per-request timeout. Generous: an `advance` body can carry a whole batch of detail-bearing
   *  associations. It exists to stop a hung connection from wedging a worker forever. */
  readonly requestTimeoutMs?: number;
  readonly fetch?: FetchLike;
  /** Sent as `user-agent`, so an operator reading the storage API's access log can tell which B
   *  component is calling. Carries no monitor id and nothing key-derived. */
  readonly userAgent?: string;
}

export const DEFAULT_STORAGE_REQUEST_TIMEOUT_MS = 60_000;

/** Trims a trailing slash so `${base}${route}` never produces a double slash. */
export function normalizeStorageBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.search !== "" || url.hash !== "") {
    throw new Error(
      `STORAGE_URL must be a bare base URL (scheme, host, optional path), got ${JSON.stringify(baseUrl)}`,
    );
  }
  return url.toString().replace(/\/+$/, "");
}

/** Fingerprints travel in a path segment, so base64url (no `+`, `/` or `=`). */
function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

export class HttpMonitorStore implements ShieldedMonitorStore {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly doFetch: FetchLike;
  private readonly userAgent: string;

  constructor(baseUrl: string, options: HttpMonitorStoreOptions = {}) {
    this.base = normalizeStorageBaseUrl(baseUrl);
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_STORAGE_REQUEST_TIMEOUT_MS;
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.userAgent = options.userAgent ?? "umbradb-shielded-monitor";
  }

  /** The base URL this client speaks to, for log lines and the boot banner. Never contains a
   *  credential: the storage API is unauthenticated in the alpha. */
  get baseUrl(): string {
    return this.base;
  }

  // ── Registration and reads ─────────────────────────────────────────────────────────────────

  /**
   * Registration, carrying a FINGERPRINT and no key material at all (00009-09).
   *
   * This used to be "the one call that carries key material". It no longer carries any: the key
   * stays in the monitor-node's RAM and only its SHA-256 crosses this boundary. The storage API
   * upserts on `(net, fingerprint)` and returns the existing record — coverage, gaps and all —
   * when one is already there, which is how a node resumes a key it has been handed again.
   */
  async register(input: RegisterMonitorInput): Promise<MonitorRecord> {
    const body = await this.post(MONITOR_STORE_ROUTES.monitors, {
      net: input.net,
      fingerprint: bytesToBase64(input.fingerprint),
      requestedStartHeight: input.requestedStartHeight.toString(),
      matchingRuleVersion: input.matchingRuleVersion,
      ledgerBuild: input.ledgerBuild,
      ...(input.sourceGenesisHash === undefined ? {} : { sourceGenesisHash: input.sourceGenesisHash }),
      ...(input.sourceInstanceId === undefined ? {} : { sourceInstanceId: input.sourceInstanceId }),
      actor: input.actor,
    });
    return decodeMonitor(unwrapMonitor(body));
  }

  async get(id: string): Promise<MonitorRecord> {
    return decodeMonitor(unwrapMonitor(await this.get_(monitorRoute(id))));
  }

  async getIncludingDeleted(id: string): Promise<MonitorRecord | undefined> {
    const body = await this.get_(monitorRoute(id), { includeDeleted: "1" });
    const parsed = decodeWith(WireMonitorOptionalSchema, body, "monitor");
    return parsed.monitor === undefined ? undefined : decodeMonitor(parsed.monitor);
  }

  async getByFingerprint(net: string, fingerprint: Uint8Array): Promise<MonitorRecord | undefined> {
    const body = await this.get_(
      `${MONITOR_STORE_ROUTES.byFingerprint}/${bytesToBase64Url(fingerprint)}`,
      { net },
    );
    const parsed = decodeWith(WireMonitorOptionalSchema, body, "monitor");
    return parsed.monitor === undefined ? undefined : decodeMonitor(parsed.monitor);
  }

  async listActive(limit = 100): Promise<MonitorRecord[]> {
    return decodeMonitorList(
      await this.get_(MONITOR_STORE_ROUTES.monitors, { state: "active", limit: String(limit) }),
    );
  }

  async listAll(limit = 100): Promise<MonitorRecord[]> {
    return decodeMonitorList(
      await this.get_(MONITOR_STORE_ROUTES.monitors, { state: "all", limit: String(limit) }),
    );
  }

  async listGaps(monitorId: string): Promise<MonitorGap[]> {
    return decodeGapList(await this.get_(monitorRoute(monitorId, "gaps")));
  }

  async readAssociations(monitorId: string, afterSeq: bigint, limit: number): Promise<AssociationRecord[]> {
    return decodeAssociationList(
      await this.get_(monitorRoute(monitorId, "associations"), {
        afterSeq: afterSeq.toString(),
        limit: String(limit),
      }),
    );
  }

  async listLifecycleEvents(monitorId: string): Promise<LifecycleEventRecord[]> {
    return decodeLifecycleList(await this.get_(monitorRoute(monitorId, "lifecycle")));
  }

  async listDeletions(): Promise<DeletionRecord[]> {
    return decodeDeletionList(await this.get_(MONITOR_STORE_ROUTES.deletions));
  }

  // ── The fenced write path ──────────────────────────────────────────────────────────────────

  /**
   * One height's (or one batch's) associations, its coverage advance and — when asked — this
   * instance's lease renewal, in ONE server-side transaction (owner Rule B; FR-010, FR-012).
   *
   * The lost-response protocol described in the class doc lives here, and nowhere else: it is the
   * only non-idempotent call this client makes whose result the caller acts on.
   */
  async advance(
    monitorId: string,
    epoch: bigint,
    throughHeight: bigint,
    associations: readonly AssociationInput[],
    opts: { readonly fromHeight?: bigint } = {},
  ): Promise<AdvanceResult> {
    const url = this.url(monitorRoute(monitorId, "advance"));
    const payload = {
      expectedEpoch: epoch.toString(),
      throughHeight: throughHeight.toString(),
      associations: associations.map(encodeAssociationInput),
      ...(opts.fromHeight === undefined ? {} : { fromHeight: opts.fromHeight.toString() }),
    };

    try {
      return decodeAdvanceResult(
        decodeWith(WireAdvanceResultSchema, await this.send("POST", url, payload), "advance result"),
      );
    } catch (err) {
      if (!(err instanceof StorageUnreachableError)) throw err;
      // UNKNOWN. Re-read before deciding anything — never re-post blind.
      const observed = await this.resolveAdvance(monitorId, throughHeight, err);
      if (observed === "committed") {
        // The same answer the in-process store gives for a replayed batch. `coverage` comes from
        // the re-read, so the caller sees the real state rather than an assumed one.
        const monitor = await this.get(monitorId);
        return { applied: false, reason: "already-advanced", coverage: monitor.coverage };
      }
      // Proved NOT committed (the transaction is all-or-nothing and coverage is short of the
      // target), so exactly one resend is safe.
      return decodeAdvanceResult(
        decodeWith(WireAdvanceResultSchema, await this.send("POST", url, payload), "advance result"),
      );
    }
  }

  /** Decides whether a lost `advance` committed, by reading the monitor's coverage. Rethrows the
   *  original transport error when the re-read cannot answer — an unresolved outcome is never
   *  guessed at. */
  private async resolveAdvance(
    monitorId: string, throughHeight: bigint, original: StorageUnreachableError,
  ): Promise<"committed" | "not-committed"> {
    let monitor: MonitorRecord;
    try {
      monitor = await this.get(monitorId);
    } catch (readErr) {
      if (readErr instanceof StorageUnreachableError) throw original;
      throw readErr;
    }
    const through = monitor.coverage.scannedThrough;
    return through !== undefined && through >= throughHeight ? "committed" : "not-committed";
  }

  /**
   * ONE block, every monitor a node holds, ONE server-side transaction (00009-09).
   *
   * **The lost response is resolved by re-sending, not by re-reading.** `advance`'s protocol
   * re-reads ONE monitor's coverage to decide whether its commit landed; the same trick for a
   * batch would mean re-reading every monitor in it and then sending a partial batch, which is a
   * second, differently-shaped request whose own failure would need its own protocol. This call
   * needs none of that, because the whole batch is idempotent by construction: every item is
   * guarded by the monotonic coverage predicate, so re-sending a batch that already committed
   * returns exactly the same block's work as `fenced: already-advanced` for every item, writes
   * nothing, and duplicates nothing. So an unreachable storage API is retried once, and the caller
   * reads `fenced` as it would on any other run.
   */
  async advanceBatch(
    net: string,
    height: bigint,
    blockHash: Uint8Array,
    items: readonly AdvanceBatchItem[],
  ): Promise<AdvanceBatchResult> {
    const url = this.url(MONITOR_STORE_ROUTES.advanceBatch);
    const payload = {
      net,
      height: height.toString(),
      blockHash: bytesToBase64(blockHash),
      items: items.map(encodeAdvanceBatchItem),
    };
    const send = async (): Promise<AdvanceBatchResult> =>
      decodeAdvanceBatchResult(
        decodeWith(WireAdvanceBatchResultSchema, await this.send("POST", url, payload), "advance-batch result"),
      );
    try {
      return await send();
    } catch (err) {
      if (!(err instanceof StorageUnreachableError)) throw err;
      return await send();
    }
  }

  /**
   * A back-sync's commit: one range, one monitor, one server-side transaction (00009-09).
   *
   * Idempotent for the same reason `advanceBatch` is, by a different mechanism: the gap rows it
   * shrinks are gone after the first success, so a replay finds nothing to shrink, and the
   * `UNIQUE (monitor_id, block_height, block_hash, position)` index refuses the association rows it
   * would otherwise re-insert. Since a refused INSERT would abort the whole transaction rather
   * than silently duplicating, a lost response is NOT retried blind here: the gaps that come back
   * from a re-read are what the caller acts on.
   */
  async fillGap(monitorId: string, input: FillGapInput): Promise<FillGapResult> {
    const body = await this.post(monitorRoute(monitorId, "fill-gap"), encodeFillGapRequest(input));
    return decodeFillGapResult(decodeWith(WireFillGapResultSchema, body, "fill-gap result"));
  }

  async bindArchiveSource(
    id: string,
    expectedEpoch: bigint,
    source: { readonly genesisHash: string; readonly instanceId: string },
  ): Promise<{ readonly applied: boolean; readonly monitor: MonitorRecord }> {
    const body = await this.post(monitorRoute(id, "bind-source"), {
      expectedEpoch: expectedEpoch.toString(),
      genesisHash: source.genesisHash,
      instanceId: source.instanceId,
    });
    const parsed = decodeWith(WireBindSourceResultSchema, body, "bind-source result");
    return { applied: parsed.applied, monitor: decodeMonitor(parsed.monitor) };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────────────────

  async goLive(id: string, expectedEpoch: bigint, actor: string): Promise<MonitorRecord> {
    return this.transition(id, { event: "goLive", actor, expectedEpoch: expectedEpoch.toString() });
  }

  async markFailed(
    id: string, actor: string, error: MonitorLastError, expectedEpoch?: bigint,
  ): Promise<MonitorRecord> {
    return this.transition(id, {
      event: "markFailed",
      actor,
      error,
      ...(expectedEpoch === undefined ? {} : { expectedEpoch: expectedEpoch.toString() }),
    });
  }

  async markStaleSource(
    id: string, actor: string, error?: MonitorLastError, expectedEpoch?: bigint,
  ): Promise<MonitorRecord> {
    return this.transition(id, {
      event: "markStaleSource",
      actor,
      ...(error === undefined ? {} : { error }),
      ...(expectedEpoch === undefined ? {} : { expectedEpoch: expectedEpoch.toString() }),
    });
  }

  async delete(id: string, actor: string): Promise<MonitorRecord | undefined> {
    const body = await this.post(monitorRoute(id, "transition"), { event: "delete", actor });
    const parsed = decodeWith(WireMonitorOptionalSchema, body, "monitor");
    return parsed.monitor === undefined ? undefined : decodeMonitor(parsed.monitor);
  }

  private async transition(id: string, payload: Record<string, unknown>): Promise<MonitorRecord> {
    return decodeMonitor(unwrapMonitor(await this.post(monitorRoute(id, "transition"), payload)));
  }

  // ── Audit ──────────────────────────────────────────────────────────────────────────────────

  async recordAudit(
    actor: string, action: string, monitorId?: string, detail?: Record<string, unknown>,
  ): Promise<void> {
    await this.post(MONITOR_STORE_ROUTES.audit, {
      actor,
      action,
      ...(monitorId === undefined ? {} : { monitorId }),
      ...(detail === undefined ? {} : { detail }),
    });
  }

  // ── Transport ──────────────────────────────────────────────────────────────────────────────

  private url(route: string, params: Record<string, string> = {}): string {
    const url = new URL(`${this.base}${route}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  /** A GET, retried ONCE on a transport failure. Safe without any reasoning about outcomes:
   *  every route reached this way is a read. */
  private async get_(route: string, params: Record<string, string> = {}): Promise<unknown> {
    const url = this.url(route, params);
    try {
      return await this.send("GET", url);
    } catch (err) {
      if (!(err instanceof StorageUnreachableError)) throw err;
      return await this.send("GET", url);
    }
  }

  private async post(route: string, payload: unknown): Promise<unknown> {
    return await this.send("POST", this.url(route), payload);
  }

  private async send(method: "GET" | "POST", url: string, payload?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.doFetch(url, {
        method,
        headers: {
          accept: "application/json",
          "user-agent": this.userAgent,
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new StorageUnreachableError(url, err);
    }

    const text = await response.text().catch(() => "");
    if (!response.ok) throw toStoreError(response.status, text, url);
    const body = safeJson(text);
    if (body === undefined) {
      throw new StorageHttpError(response.status, undefined, url, `${url} returned a body that is not JSON`);
    }
    return body;
  }
}

/** `{monitor: …}` → the monitor, or a typed failure if the server omitted it where the route
 *  promises one. Never `undefined` silently: a missing monitor on a route that must return one
 *  would otherwise decode into an error about a dozen absent fields. */
function unwrapMonitor(body: unknown): unknown {
  const parsed = decodeWith(WireMonitorOptionalSchema, body, "monitor");
  if (parsed.monitor === undefined) {
    throw new StorageHttpError(200, undefined, "(monitor route)", "the storage API returned no monitor where one is required");
  }
  return parsed.monitor;
}

/**
 * Rebuilds the store error the server threw.
 *
 * The mapping is the inverse of `storage-api/server.ts`'s `toHttpError`, and the pair is what
 * makes the two implementations substitutable. An unrecognised code becomes a
 * {@link StorageHttpError} rather than being coerced into the nearest store error — inventing a
 * `MonitorNotFoundError` out of a 502 from a proxy would be worse than a clear transport failure.
 */
function toStoreError(status: number, text: string, url: string): Error {
  const parsed = MonitorStoreErrorSchema.safeParse(safeJson(text));
  if (!parsed.success) {
    return new StorageHttpError(status, undefined, url, `the storage API refused ${url}: ${status}`);
  }
  const { code, message, detail } = parsed.data.error;
  switch (code) {
    case "MONITOR_NOT_FOUND":
      return new MonitorNotFoundError(detail?.monitorId ?? "(unknown)");
    case "MONITOR_FENCED":
      return new MonitorFencedError(
        detail?.monitorId ?? "(unknown)",
        (detail?.rejection ?? "epoch") as FenceRejection,
        { epoch: BigInt(detail?.epoch ?? "0"), state: detail?.state ?? "(unknown)" },
      );
    case "MONITOR_ILLEGAL_TRANSITION":
      return new IllegalLifecycleTransitionError(detail?.from ?? "(unknown)", detail?.event ?? "(unknown)");
    case "INVALID_VIEWING_KEY":
      // The rejection reason is deliberately NOT on the wire (FR-001: one indistinguishable
      // client error), so the client records that it came from the storage boundary.
      return new InvalidViewingKeyError("ledger-rejected");
    case "VALIDATION_FAILED":
      return new ValidationError(message, [{ path: "(storage-api)", message }]);
    default:
      return new StorageHttpError(status, code, url, `the storage API refused ${url}: ${status} ${code} — ${message}`);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Both halves of project B's dependency on the storage API, from one base URL.
 *
 * The archive read contract and the monitor store are separate interfaces with separate route
 * families, but in the v2 topology they are served by ONE process, so a composition root should
 * not have to know that the two clients happen to point at the same place.
 */
export interface StorageClients {
  readonly archive: HttpArchiveReadContract;
  readonly monitors: HttpMonitorStore;
  readonly baseUrl: string;
}

export function createStorageClients(
  baseUrl: string,
  options: HttpMonitorStoreOptions = {},
): StorageClients {
  const normalized = normalizeStorageBaseUrl(baseUrl);
  return {
    archive: new HttpArchiveReadContract(normalized, options),
    monitors: new HttpMonitorStore(normalized, options),
    baseUrl: normalized,
  };
}
