/**
 * The `/v1/dust/*` wire contract: its error type, its encodings, and every piece of request
 * validation (`spec/00016-dust-wallet-sync.md` §4, FR-014, FR-015).
 *
 * PURE ON PURPOSE. Nothing here opens a connection, loads the WASM or reads a tree, so the whole
 * contract — the encodings a wallet decodes against, and every way a request can be refused — is
 * testable without a database, a node or a network. That matters more than usual for this surface
 * because two of its rules are security rules rather than convenience: a `POST /v1/dust/lookup`
 * body is capped **before** it is parsed, and a refusal never quotes the offending nullifier.
 *
 * ── Encodings (spec §4), in one place so a route cannot invent a second one ──────────────────
 * Field elements (`owner`, output `nonce`, `commitment`, `nullifier`) are **decimal strings**:
 * they are `bigint` in the WASM bindings and `numeric(78)` in the archive, and JSON numbers
 * cannot hold them. `backingNight`, a generation `nonce` (an `InitialNonce`) and hashes are
 * **lowercase hex without `0x`**. u64/u128 magnitudes and ids are decimal strings for the same
 * reason. Timestamps are **integer unix seconds**. `dtime` is `null` when a generation has no end
 * time — never absent, so a consumer can tell "no end time" from "field not written".
 */

/** The stable error codes `/v1/dust/*` returns (spec §4). A consumer switches on these. */
export type DustErrorCode =
  | "DUST_DISABLED"
  | "DUST_NO_PRODUCER"
  | "DUST_NOT_READY"
  | "DUST_DB_UNAVAILABLE"
  | "DUST_RANGE_INVALID"
  | "DUST_LOOKUP_INVALID"
  | "DUST_BAD_PARAM";

/**
 * A refusal with the status and code spec §4 assigns it.
 *
 * The message is written by this module from a fixed vocabulary and **never interpolates caller
 * input**. On the lookup route the caller input is a nullifier — the one value this whole design
 * promises never to log or persist — and an error message is the easiest way for it to reach a
 * log, because a message travels into the access log's `errorMessage` field by default.
 */
export class DustHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: DustErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DustHttpError";
  }
}

/** The wire shape of a refusal: `{ error: { code, message } }` (spec §4). */
export function dustErrorBody(error: DustHttpError): { error: { code: DustErrorCode; message: string } } {
  return { error: { code: error.code, message: error.message } };
}

// ── Encodings ────────────────────────────────────────────────────────────────────────────────

/** A field element / magnitude as a decimal string. */
export function decimalOf(value: bigint | number | string): string {
  return BigInt(value).toString(10);
}

/** Lowercase hex without `0x`. Accepts a `Buffer`/`Uint8Array` (the driver's `bytea` shape) or a
 *  string that may already carry a prefix. */
export function hexOf(value: Uint8Array | string): string {
  if (typeof value === "string") return value.replace(/^0x/, "").toLowerCase();
  return Buffer.from(value).toString("hex");
}

/** `null` stays `null`; anything else becomes an integer unix second. */
export function secondsOrNull(value: bigint | number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

// ── Shared parameter validation ──────────────────────────────────────────────────────────────

/**
 * A field element in its CANONICAL decimal spelling: no sign, no leading zero (except `0`
 * itself), at most 80 digits (a BN254 scalar is 77).
 *
 * Canonical rather than lenient on purpose. `POST /v1/dust/lookup` echoes each nullifier back in
 * request order and a client matches its own frontier against the echo; accepting `0041` and
 * answering `41` would make that match fail for a caller that did nothing wrong, and accepting it
 * and echoing it verbatim would let the same nullifier have two spellings in one request. One
 * spelling, refused early, is the version of this that has no failure mode.
 */
const DECIMAL = /^(0|[1-9][0-9]{0,79})$/;

/** `net`, required on every route as it is on `/v1/archive/*` (spec §4). */
export function requireNet(params: URLSearchParams): string {
  const net = params.get("net")?.trim() ?? "";
  if (net === "") throw new DustHttpError(400, "DUST_BAD_PARAM", "net is required");
  // The same shape `node/config.ts` accepts for `NET`. A net is a row scope, not free text.
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(net)) {
    throw new DustHttpError(400, "DUST_BAD_PARAM", "net must match /^[A-Za-z0-9_.:-]{1,64}$/");
  }
  return net;
}

/** A required decimal parameter (`owner`). */
export function requireDecimal(params: URLSearchParams, name: string): string {
  const raw = params.get(name)?.trim() ?? "";
  if (raw === "") throw new DustHttpError(400, "DUST_BAD_PARAM", `${name} is required`);
  if (!DECIMAL.test(raw)) {
    throw new DustHttpError(400, "DUST_BAD_PARAM", `${name} must be a decimal field element`);
  }
  return BigInt(raw).toString(10);
}

/** An optional decimal cursor (`afterId`, `afterIndex`). Absent → `0n`, i.e. from the start. */
export function optionalCursor(params: URLSearchParams, name: string): bigint {
  const raw = params.get(name)?.trim() ?? "";
  if (raw === "") return 0n;
  if (!DECIMAL.test(raw)) throw new DustHttpError(400, "DUST_BAD_PARAM", `${name} must be a decimal integer`);
  return BigInt(raw);
}

/** `limit`, defaulting to `fallback` and capped at 1 000 (spec §4). A limit ABOVE the cap is a
 *  refusal rather than a silent clamp: a client that asked for 5 000 and got 1 000 would page
 *  wrongly if it trusted its own request. */
export function optionalLimit(params: URLSearchParams, fallback: number, cap = 1_000): number {
  const raw = params.get("limit")?.trim() ?? "";
  if (raw === "") return fallback;
  if (!/^[0-9]{1,6}$/.test(raw)) throw new DustHttpError(400, "DUST_BAD_PARAM", "limit must be a decimal integer");
  const value = Number(raw);
  if (value < 1 || value > cap) throw new DustHttpError(400, "DUST_BAD_PARAM", `limit must be 1..${cap}`);
  return value;
}

/** `tree=commitment|generation` (spec §4). */
export function requireTree(params: URLSearchParams): "commitment" | "generation" {
  const raw = params.get("tree")?.trim() ?? "";
  if (raw === "commitment" || raw === "generation") return raw;
  throw new DustHttpError(400, "DUST_BAD_PARAM", "tree must be commitment or generation");
}

// ── Segments (FR-014) ────────────────────────────────────────────────────────────────────────

/** One requested `[start, end]` range of a tree, inclusive. */
export interface DustRange {
  readonly start: bigint;
  readonly end: bigint;
}

/** At most this many ranges in one `GET /v1/dust/segments` (spec §4). */
export const MAX_RANGES = 256;

/**
 * Parses `ranges=s-e,s-e,…` and enforces every rule of FR-014 **except** the `firstFree` bound,
 * which needs the mirror and is applied by {@link assertRangesWithin}.
 *
 * The whole request fails on the first bad range rather than serving the good ones: a wallet
 * walks the returned segments in ascending order and inserts its own leaves between them, so a
 * partial answer is not a smaller answer, it is one that produces a wrong root — and the wallet
 * would only find out at the root comparison, with nothing to say which range was missing.
 *
 * Ascending and non-overlapping are required for the same reason. They are also what makes the
 * response cheap to produce: the mirror cuts each range from one immutable state.
 */
export function parseRanges(raw: string | null): DustRange[] {
  const text = raw?.trim() ?? "";
  if (text === "") throw new DustHttpError(400, "DUST_RANGE_INVALID", "ranges is required");
  const parts = text.split(",");
  if (parts.length > MAX_RANGES) {
    throw new DustHttpError(400, "DUST_RANGE_INVALID", `at most ${MAX_RANGES} ranges per request`);
  }
  const ranges: DustRange[] = [];
  let previousEnd: bigint | undefined;
  for (const part of parts) {
    const match = /^([0-9]{1,20})-([0-9]{1,20})$/.exec(part.trim());
    if (match === null) {
      throw new DustHttpError(400, "DUST_RANGE_INVALID", "each range must be <start>-<end> in decimal");
    }
    const start = BigInt(match[1]!);
    const end = BigInt(match[2]!);
    if (start > end) throw new DustHttpError(400, "DUST_RANGE_INVALID", "a range's start is above its end");
    if (previousEnd !== undefined && start <= previousEnd) {
      throw new DustHttpError(400, "DUST_RANGE_INVALID", "ranges must be ascending and non-overlapping");
    }
    previousEnd = end;
    ranges.push({ start, end });
  }
  return ranges;
}

/**
 * FR-014's `[0, firstFree − 1]` bound, checked against the mirror's own tree.
 *
 * `firstFree === 0n` (a tree with no leaves — devnet at genesis, spec's edge cases) admits NO
 * range at all, which is why the comparison is `end >= firstFree` rather than `end > firstFree - 1`:
 * the latter underflows on an unsigned zero.
 */
export function assertRangesWithin(ranges: readonly DustRange[], firstFree: bigint): void {
  for (const range of ranges) {
    if (range.end >= firstFree) {
      throw new DustHttpError(
        400,
        "DUST_RANGE_INVALID",
        `a range ends at or past the tree's firstFree (${firstFree.toString(10)})`,
      );
    }
  }
}

// ── Lookup (FR-015) ──────────────────────────────────────────────────────────────────────────

/** At most this many nullifiers in one `POST /v1/dust/lookup` (spec §4). */
export const MAX_NULLIFIERS = 1_000;
/** And at most this many bytes of body, checked before parsing (FR-015). */
export const MAX_LOOKUP_BODY_BYTES = 64 * 1024;

export interface DustLookupRequest {
  readonly net: string;
  /** Decimal strings, in the caller's own order — the response preserves it. */
  readonly nullifiers: readonly string[];
}

/**
 * Parses a lookup body.
 *
 * Every refusal is `400 DUST_LOOKUP_INVALID` with a message that names the RULE, never the value:
 * "nullifier 3 is not a decimal field element" and not the nullifier itself. A duplicate is
 * accepted and answered twice, in place — the client's chain-following loop may legitimately ask
 * about the same successor twice, and rejecting it would push a dedupe into every caller.
 */
export function parseLookupBody(body: Buffer): DustLookupRequest {
  if (body.byteLength > MAX_LOOKUP_BODY_BYTES) {
    throw new DustHttpError(400, "DUST_LOOKUP_INVALID", `body exceeds ${MAX_LOOKUP_BODY_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new DustHttpError(400, "DUST_LOOKUP_INVALID", "body is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DustHttpError(400, "DUST_LOOKUP_INVALID", "body must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const net = typeof record.net === "string" ? record.net.trim() : "";
  if (net === "" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(net)) {
    throw new DustHttpError(400, "DUST_LOOKUP_INVALID", "net is required");
  }
  const raw = record.nullifiers;
  if (!Array.isArray(raw)) throw new DustHttpError(400, "DUST_LOOKUP_INVALID", "nullifiers must be an array");
  if (raw.length === 0) throw new DustHttpError(400, "DUST_LOOKUP_INVALID", "nullifiers must not be empty");
  if (raw.length > MAX_NULLIFIERS) {
    throw new DustHttpError(400, "DUST_LOOKUP_INVALID", `at most ${MAX_NULLIFIERS} nullifiers per request`);
  }
  const nullifiers: string[] = [];
  for (const [position, entry] of raw.entries()) {
    if (typeof entry !== "string" || !DECIMAL.test(entry.trim())) {
      throw new DustHttpError(
        400,
        "DUST_LOOKUP_INVALID",
        `nullifier at position ${position} is not a decimal field element`,
      );
    }
    nullifiers.push(BigInt(entry.trim()).toString(10));
  }
  return { net, nullifiers };
}
