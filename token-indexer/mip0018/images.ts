/**
 * Token images (MIP-0018 "Common fields": `image`, a type-4 URI, and `image_sha256`, the SHA-256 of the file at
 * `image`, exactly 32 bytes; "Off-chain content"; "Security considerations") — everything about them except the
 * network, which only the background fetcher (`image-fetcher.ts`) uses:
 *
 * - `imageKeysOf` — which image an identity names: its usable `image` and, when usable, its `image_sha256`;
 * - `classifyContent` — what fetched bytes are: `verified` (their SHA-256 equals `image_sha256`), `mismatch` (it
 *   differs), `unverified` (no usable `image_sha256`), `not-image` (not a PNG, JPEG, GIF or WebP file by its magic
 *   bytes; SVG, HTML and anything else). With `image_sha256` set, content whose hash differs is never kept or shown,
 *   whatever it is;
 * - the cache table `mip0018_images` (migration `004_mip0018_images`): discovery of the images that identities name,
 *   the fetcher's queue (claim with a lease, record a result, release), and the API's reads — the `image` object of
 *   a token and the bytes behind `/v1/images/{id}`.
 *
 * Only `verified` and `unverified` raster bytes are stored and served; they are served from this indexer's own
 * origin with the type their magic bytes show, `X-Content-Type-Options: nosniff` and a sandbox CSP, so an image can
 * never run a script. The image id is the SHA-256 of the stored bytes. The URL itself is only ever served as text.
 */
import { createHash } from "node:crypto";
import { ValType } from "../vendor/mip0018/codec/src/index.ts";
import type { Queryable } from "./fields.ts";

/** The key bytes of the image fields (MIP "Common fields"). */
export const IMAGE_KEY = Buffer.from("image", "utf8");
export const IMAGE_SHA256_KEY = Buffer.from("image_sha256", "utf8");

const hexOf = (b: Uint8Array): string => Buffer.from(b).toString("hex");
export const sha256 = (b: Uint8Array): Buffer => createHash("sha256").update(b).digest();

// ── Which image an identity names ────────────────────────────────────────────────────────────────────────────────

/** A stored field's value type and bytes (a `mip0018_fields` row). */
export interface RawField {
  valType: number;
  value: Uint8Array;
}

/** The image an identity names: the `image` URI bytes (ASCII) and its usable `image_sha256`, or `null` for none. */
export interface ImageKeys {
  url: Buffer;
  sha256: Buffer | null;
}

/** A type-4 value is ASCII without spaces or controls (RFC 3986); anything else is not a URI this fetcher reads. */
const isUriBytes = (b: Uint8Array): boolean => b.length > 0 && b.every((c) => c > 0x20 && c < 0x7f);

/**
 * The image an identity names, from its current `image` and `image_sha256` fields (MIP "Common fields"): `image` is
 * usable when it is a type-4 URI (an accepted event's type-4 value is a valid RFC 3986 URI, ASCII only),
 * `image_sha256` when it is type-0 bytes of exactly 32 bytes. Without a usable `image` the identity names no image;
 * an unusable `image_sha256` counts as none, so the image is at best unverified.
 */
export function imageKeysOf(image: RawField | undefined, hash: RawField | undefined): ImageKeys | undefined {
  if (image === undefined || image.valType !== ValType.Uri || !isUriBytes(image.value)) return undefined;
  const usableHash = hash !== undefined && hash.valType === ValType.Bytes && hash.value.length === 32;
  return { url: Buffer.from(image.value), sha256: usableHash ? Buffer.from(hash.value) : null };
}

// ── What fetched bytes are ───────────────────────────────────────────────────────────────────────────────────────

export type RasterType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type ImageStatus = "pending" | "verified" | "unverified" | "mismatch" | "not-image" | "unreachable";

const startsWith = (b: Uint8Array, prefix: readonly number[], at = 0): boolean =>
  b.length >= at + prefix.length && prefix.every((v, i) => b[at + i] === v);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87A = ascii("GIF87a");
const GIF89A = ascii("GIF89a");
const RIFF = ascii("RIFF");
const WEBP = ascii("WEBP");

/** The raster type of a file by its magic bytes (PNG, JPEG, GIF, WebP), or `undefined` for anything else. */
export function rasterType(bytes: Uint8Array): RasterType | undefined {
  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, GIF87A) || startsWith(bytes, GIF89A)) return "image/gif";
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return "image/webp";
  return undefined;
}

/** A completed check of fetched content. `bytes` and `contentType` only for `verified` / `unverified`. */
export interface ContentResult {
  status: "verified" | "unverified" | "mismatch" | "not-image";
  contentSha256: Buffer;
  size: number;
  contentType?: RasterType;
  bytes?: Buffer;
}

/**
 * Classifies fetched content against the identity's usable `image_sha256` (`null` = none). A set hash that differs
 * is `mismatch` whatever the content is (MIP: such content MUST NOT be displayed); then anything that is not a raster
 * image by its magic bytes is `not-image`; else `verified` (hash set and equal) or `unverified` (no usable hash).
 */
export function classifyContent(bytes: Uint8Array, expected: Uint8Array | null): ContentResult {
  const contentSha256 = sha256(bytes);
  const base = { contentSha256, size: bytes.length };
  if (expected !== null && !contentSha256.equals(Buffer.from(expected))) return { ...base, status: "mismatch" };
  const contentType = rasterType(bytes);
  if (contentType === undefined) return { ...base, status: "not-image" };
  return { ...base, status: expected === null ? "unverified" : "verified", contentType, bytes: Buffer.from(bytes) };
}

// ── The cache table: discovery and the fetcher's queue ───────────────────────────────────────────────────────────

/** An identity as the discovery cursor keeps it (lowercase hex, kind). */
export interface ImageIdentity {
  contractAddress: string;
  domainSep: string;
  kind: number;
}

interface ImageFieldRow {
  contract_address: Buffer;
  domain_sep: Buffer;
  kind: number;
  image_type: number;
  image_value: Buffer;
  hash_type: number | null;
  hash_value: Buffer | null;
}

const hashField = (r: { hash_type: number | null; hash_value: Buffer | null }): RawField | undefined =>
  r.hash_type === null || r.hash_value === null ? undefined : { valType: r.hash_type, value: r.hash_value };

/**
 * One page of discovery: the identities of `network` with an `image` field after `after` (in (contract, domainSep,
 * kind) order), and a `pending` cache row for each image they name that has none yet (due now). Bounded by `limit`
 * (an index range of the `image` rows); `last` is the cursor of the next page, `undefined` after the last page.
 */
export async function discoverImages(
  sql: Queryable, network: string, schema: string, o: { after?: ImageIdentity; limit: number },
): Promise<{ identities: number; inserted: number; last?: ImageIdentity }> {
  const s = sql(schema);
  const start = o.after === undefined
    ? sql``
    : sql`AND (f.contract_address, f.domain_sep, f.kind) > (${Buffer.from(o.after.contractAddress, "hex")}, ${Buffer.from(o.after.domainSep, "hex")}, ${o.after.kind}::smallint)`;
  const rows = await sql<ImageFieldRow[]>`
    SELECT f.contract_address, f.domain_sep, f.kind, f.val_type AS image_type, f.value AS image_value,
           h.val_type AS hash_type, h.value AS hash_value
    FROM ${s}.mip0018_fields f
    LEFT JOIN ${s}.mip0018_fields h
      ON h.network = f.network AND h.contract_address = f.contract_address AND h.domain_sep = f.domain_sep
     AND h.kind = f.kind AND h.key = ${IMAGE_SHA256_KEY}
    WHERE f.network = ${network} AND f.key = ${IMAGE_KEY} ${start}
    ORDER BY f.contract_address, f.domain_sep, f.kind
    LIMIT ${o.limit}`;
  const wanted = new Map<string, { url: Buffer; hash: Buffer }>();
  for (const r of rows) {
    const k = imageKeysOf({ valType: r.image_type, value: r.image_value }, hashField(r));
    if (k === undefined) continue;
    const hash = k.sha256 ?? Buffer.alloc(0);
    wanted.set(`${hexOf(k.url)}/${hexOf(hash)}`, { url: k.url, hash });
  }
  let inserted = 0;
  if (wanted.size > 0) {
    const list = [...wanted.values()];
    const r = await sql`
      INSERT INTO ${s}.mip0018_images (url, image_sha256, status, next_attempt_at)
      SELECT u, h, 'pending', now() FROM unnest(${sql.array(list.map((w) => w.url), 17)}::bytea[], ${sql.array(list.map((w) => w.hash), 17)}::bytea[]) AS x(u, h)
      ON CONFLICT (url, image_sha256) DO NOTHING`;
    inserted = r.count;
  }
  const lastRow = rows.length < o.limit ? undefined : rows[rows.length - 1];
  return {
    identities: rows.length,
    inserted,
    ...(lastRow === undefined ? {} : { last: { contractAddress: hexOf(lastRow.contract_address), domainSep: hexOf(lastRow.domain_sep), kind: lastRow.kind } }),
  };
}

/** A cache row the fetcher claimed: what to fetch, what the identity expects, and the row's current state. */
export interface ClaimedImage {
  url: Buffer;
  imageSha256: Buffer;
  status: ImageStatus;
  attempts: number;
}

/**
 * Claims up to `limit` due rows for one fetch each: their next check moves `leaseMs` ahead, so a fetcher that dies
 * mid-fetch leaves them due again once the lease ends, and two fetchers never claim one row (`SKIP LOCKED`).
 */
export async function claimDueImages(sql: Queryable, schema: string, o: { limit: number; leaseMs: number }): Promise<ClaimedImage[]> {
  if (o.limit <= 0) return [];
  const s = sql(schema);
  const rows = await sql<{ url: Buffer; image_sha256: Buffer; status: ImageStatus; attempts: number }[]>`
    UPDATE ${s}.mip0018_images i SET next_attempt_at = now() + ${o.leaseMs}::double precision * interval '1 millisecond'
    FROM (
      SELECT url, image_sha256 FROM ${s}.mip0018_images
      WHERE next_attempt_at IS NOT NULL AND next_attempt_at <= now()
      ORDER BY next_attempt_at
      LIMIT ${o.limit}
      FOR UPDATE SKIP LOCKED
    ) due
    WHERE i.url = due.url AND i.image_sha256 = due.image_sha256
    RETURNING i.url, i.image_sha256, i.status, i.attempts`;
  return rows.map((r) => ({ url: Buffer.from(r.url), imageSha256: Buffer.from(r.image_sha256), status: r.status, attempts: r.attempts }));
}

/** The fetcher's schedule: when a row is checked again. */
export interface ImageSchedule {
  /** `unverified`, `mismatch` and `not-image` results are checked again after this long (a host can change a file). */
  recheckMs: number;
  /** A failed check is retried after `retryBaseMs × 2^(consecutive failures − 1)`, at most `retryMaxMs`. */
  retryBaseMs: number;
  retryMaxMs: number;
}

/** The retry delay after `failures` consecutive failed checks (1 = the first). */
export function retryDelayMs(failures: number, s: ImageSchedule): number {
  return Math.min(s.retryMaxMs, s.retryBaseMs * 2 ** Math.min(Math.max(failures - 1, 0), 40));
}

const after = (sql: Queryable, ms: number | null) =>
  ms === null ? sql`NULL` : sql`now() + ${ms}::double precision * interval '1 millisecond'`;

/**
 * Records a completed check: the content's status (bytes only for `verified` / `unverified`). A `verified` row is
 * never checked again (its bytes are the ones `image_sha256` names); the others after `recheckMs`.
 */
export async function recordImageContent(sql: Queryable, schema: string, item: ClaimedImage, r: ContentResult, s: ImageSchedule): Promise<void> {
  await sql`
    UPDATE ${sql(schema)}.mip0018_images SET
      status = ${r.status}, reason = NULL, content_type = ${r.contentType ?? null}, content_sha256 = ${r.contentSha256},
      size = ${r.size}, bytes = ${r.bytes ?? null}, attempts = 0, checked_at = now(),
      next_attempt_at = ${after(sql, r.status === "verified" ? null : s.recheckMs)}
    WHERE url = ${item.url} AND image_sha256 = ${item.imageSha256}`;
}

/**
 * Records a failed check (`reason`: the fetcher's word for it). A row that never had content becomes `unreachable`; a
 * row that has a result keeps it (a host that is down for a while does not hide a checked image). Either way it is
 * retried with back-off.
 */
export async function recordImageFailure(sql: Queryable, schema: string, item: ClaimedImage, reason: string, s: ImageSchedule): Promise<void> {
  const failures = item.attempts + 1;
  const delay = retryDelayMs(failures, s);
  if (item.status === "pending" || item.status === "unreachable")
    await sql`
      UPDATE ${sql(schema)}.mip0018_images SET status = 'unreachable', reason = ${reason}, attempts = ${failures},
        checked_at = now(), next_attempt_at = ${after(sql, delay)}
      WHERE url = ${item.url} AND image_sha256 = ${item.imageSha256}`;
  else
    await sql`
      UPDATE ${sql(schema)}.mip0018_images SET attempts = ${failures}, next_attempt_at = ${after(sql, delay)}
      WHERE url = ${item.url} AND image_sha256 = ${item.imageSha256}`;
}

/** Gives a claimed row back unchecked, due after `delayMs` (a rate-limited host, or a fetcher that is stopping). */
export async function releaseImage(sql: Queryable, schema: string, item: ClaimedImage, delayMs: number): Promise<void> {
  await sql`
    UPDATE ${sql(schema)}.mip0018_images SET next_attempt_at = ${after(sql, Math.max(0, delayMs))}
    WHERE url = ${item.url} AND image_sha256 = ${item.imageSha256}`;
}

// ── What the API serves ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * A token's image as the API serves it: the URL as plain text, the status of the image it names (`pending` until the
 * fetcher has checked it) and, only when the image may be displayed (`verified`, `unverified`), the same-origin path
 * of its bytes.
 */
export interface ImageJson {
  url: string;
  status: ImageStatus;
  imageUrl: string | null;
}

/** The path the API serves stored image bytes at (`id` = their SHA-256, hex). */
export const imagePath = (contentSha256: Uint8Array): string => `/v1/images/${hexOf(contentSha256)}`;

const identityKey = (k: ImageIdentity): string => `${k.contractAddress}/${k.domainSep}/${k.kind}`;

/**
 * The `image` object of each given identity that names a usable image (identities without one are absent from the
 * map). Bounded: two field rows and one cache row per identity.
 */
export async function imagesFor(sql: Queryable, network: string, keys: readonly ImageIdentity[], schema: string): Promise<Map<string, ImageJson>> {
  const out = new Map<string, ImageJson>();
  if (keys.length === 0) return out;
  const s = sql(schema);
  const rows = await sql<Array<ImageFieldRow & { c: string; d: string; k: number }>>`
    SELECT i.c, i.d, i.k, f.val_type AS image_type, f.value AS image_value, h.val_type AS hash_type, h.value AS hash_value
    FROM unnest(${sql.array(keys.map((k) => k.contractAddress))}::text[], ${sql.array(keys.map((k) => k.domainSep))}::text[],
                ${sql.array(keys.map((k) => String(k.kind)))}::text[]::int[]) AS i(c, d, k)
    JOIN ${s}.mip0018_fields f
      ON f.network = ${network} AND f.contract_address = decode(i.c, 'hex') AND f.domain_sep = decode(i.d, 'hex')
     AND f.kind = i.k AND f.key = ${IMAGE_KEY}
    LEFT JOIN ${s}.mip0018_fields h
      ON h.network = f.network AND h.contract_address = f.contract_address AND h.domain_sep = f.domain_sep
     AND h.kind = f.kind AND h.key = ${IMAGE_SHA256_KEY}`;
  const named: Array<{ key: string; url: Buffer; hash: Buffer }> = [];
  for (const r of rows) {
    const k = imageKeysOf({ valType: r.image_type, value: r.image_value }, hashField(r));
    if (k !== undefined) named.push({ key: identityKey({ contractAddress: r.c, domainSep: r.d, kind: r.k }), url: k.url, hash: k.sha256 ?? Buffer.alloc(0) });
  }
  if (named.length === 0) return out;
  const cached = await sql<{ url: Buffer; image_sha256: Buffer; status: ImageStatus; content_sha256: Buffer | null }[]>`
    SELECT i.url, i.image_sha256, i.status, i.content_sha256
    FROM unnest(${sql.array(named.map((n) => n.url), 17)}::bytea[], ${sql.array(named.map((n) => n.hash), 17)}::bytea[]) AS x(u, h)
    JOIN ${s}.mip0018_images i ON i.url = x.u AND i.image_sha256 = x.h`;
  const byKey = new Map(cached.map((c) => [`${hexOf(c.url)}/${hexOf(c.image_sha256)}`, c]));
  for (const n of named) {
    const c = byKey.get(`${hexOf(n.url)}/${hexOf(n.hash)}`);
    const status: ImageStatus = c?.status ?? "pending";
    const displayable = (status === "verified" || status === "unverified") && c?.content_sha256 != null;
    out.set(n.key, { url: n.url.toString("latin1"), status, imageUrl: displayable ? imagePath(c.content_sha256!) : null });
  }
  return out;
}

/** Headers of a served image: its raster type, no sniffing, no script, cacheable for ever (the id is its hash). */
export const IMAGE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox; default-src 'none'",
  "cache-control": "public, max-age=31536000, immutable",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
};

/** The body of `/v1/images/{id}`: raster bytes (not JSON) and their headers. */
export class ImageBody {
  constructor(readonly contentType: RasterType, readonly bytes: Buffer) {}

  headers(): Record<string, string> {
    return { ...IMAGE_RESPONSE_HEADERS, "content-type": this.contentType, "content-length": String(this.bytes.length) };
  }
}

/**
 * The stored bytes whose SHA-256 is `id` (64 lowercase hex), from a `verified` or `unverified` row only; `undefined`
 * when there are none (any other status stores no bytes). The type is the one the bytes' magic bytes show now.
 */
export async function imageBody(sql: Queryable, schema: string, id: string): Promise<ImageBody | undefined> {
  const [r] = await sql<{ bytes: Buffer; content_type: RasterType }[]>`
    SELECT bytes, content_type FROM ${sql(schema)}.mip0018_images
    WHERE content_sha256 = ${Buffer.from(id, "hex")} AND bytes IS NOT NULL AND status IN ('verified', 'unverified')
    LIMIT 1`;
  if (r === undefined) return undefined;
  const bytes = Buffer.from(r.bytes);
  const type = rasterType(bytes);
  if (type === undefined || type !== r.content_type || !sha256(bytes).equals(Buffer.from(id, "hex"))) return undefined;
  return new ImageBody(type, bytes);
}
