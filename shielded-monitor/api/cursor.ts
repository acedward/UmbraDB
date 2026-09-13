/**
 * The matches cursor (organizer spec FR-019).
 *
 * A cursor is the base64url encoding of `"<monitorId>:<seq>"`, where `seq` is the per-monitor
 * association sequence `PgShieldedMonitorStore.advance` allocates. It is deliberately opaque and
 * deliberately unauthenticated:
 *
 * - **Opaque** because a bare integer invites arithmetic. A consumer that computes `cursor + 1`
 *   is correct only for as long as `seq` allocation stays exactly what it is today; the encoding
 *   makes the value visibly not-a-number, so the only supported way to move is to send back the
 *   `nextCursor` the service returned.
 * - **base64url**, not base64, because the value travels in a query string, where `+` and `/`
 *   need escaping and `=` is a delimiter in some frameworks' parsers.
 * - **Unauthenticated**: signing is deferred with User Story 4 (owner, 2026-09-10). The residual
 *   risk is bounded — a forged cursor can only reposition a caller *within a monitor it can
 *   already read in full*, and this alpha has no authentication at all, so the caller could read
 *   that monitor from sequence 0 regardless.
 *
 * The monitor id is inside the cursor even though the request path already carries it. That
 * redundancy is the point: FR-019 requires a cursor to be bound to its monitor, and without the
 * binding a consumer that juggles two monitors and crosses its cursor files reads monitor A's
 * offsets against monitor B — producing a *plausible* page from the wrong position rather than an
 * error. With the binding it is a 400 on the first request.
 */

/** Why a cursor was refused. Safe to return to the caller: none of these carries data derived
 *  from anything secret, and the cursor itself is not secret. */
export type CursorRejection =
  | "not-base64url"
  | "malformed"
  | "monitor-mismatch"
  | "sequence-out-of-range";

/** Thrown by {@link decodeCursor}. The API maps it to `400`. */
export class CursorError extends Error {
  readonly code = "INVALID_CURSOR" as const;
  constructor(readonly rejection: CursorRejection) {
    super(`invalid cursor (${rejection})`);
    this.name = "CursorError";
  }
}

/** PostgreSQL `bigint` is signed 64-bit and `associations.seq` is `bigint`, so this is the
 *  largest sequence the column can hold. A cursor above it can only be a forgery or a bug, and
 *  admitting it would let a caller ask the database to compare against a value it cannot store. */
const MAX_SEQ = 9_223_372_036_854_775_807n;

/** `randomUUID()`'s shape, which is what `monitors.id` is. Checked here as well as by the route's
 *  own schema so a cursor cannot smuggle a differently-shaped id past the comparison. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** base64url alphabet, unpadded. Node's `Buffer.from(s, "base64url")` is famously lenient — it
 *  ignores characters outside the alphabet rather than failing — so the shape is checked
 *  explicitly first, and a cursor that decodes "successfully" from garbage is refused. */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Encodes a page position. `seq` is the sequence of the LAST item the caller has seen, so the
 *  next page is everything with a strictly greater sequence; the empty cursor is `seq = 0`. */
export function encodeCursor(monitorId: string, seq: bigint): string {
  return Buffer.from(`${monitorId}:${seq.toString(10)}`, "utf8").toString("base64url");
}

/**
 * Decodes a page position and checks it belongs to `expectedMonitorId`.
 *
 * @throws CursorError for every rejection class; the caller maps it to `400`.
 */
export function decodeCursor(text: string, expectedMonitorId: string): bigint {
  if (text.length === 0 || text.length > 256 || !BASE64URL_PATTERN.test(text)) {
    throw new CursorError("not-base64url");
  }

  const decoded = Buffer.from(text, "base64url").toString("utf8");
  // A single ':' separator: the monitor id is a UUID and cannot contain one, and the sequence is
  // decimal digits, so `indexOf` and `lastIndexOf` agree for every well-formed cursor. Requiring
  // that agreement rejects `a:b:c` instead of silently reading one of its halves.
  const sep = decoded.indexOf(":");
  if (sep <= 0 || sep !== decoded.lastIndexOf(":")) throw new CursorError("malformed");

  const monitorId = decoded.slice(0, sep);
  const rawSeq = decoded.slice(sep + 1);
  if (!UUID_PATTERN.test(monitorId)) throw new CursorError("malformed");
  // `/^\d+$/` and not `BigInt()`'s own parsing: `BigInt(" 1")`, `BigInt("0x10")` and `BigInt("")`
  // all succeed, so three different strings would name the same position.
  if (!/^\d+$/.test(rawSeq)) throw new CursorError("malformed");

  if (monitorId.toLowerCase() !== expectedMonitorId.toLowerCase()) {
    throw new CursorError("monitor-mismatch");
  }

  const seq = BigInt(rawSeq);
  if (seq > MAX_SEQ) throw new CursorError("sequence-out-of-range");
  return seq;
}
