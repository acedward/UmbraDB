import type { ISql } from "postgres";
import { assertValidSchemaName } from "../../client.js";

export const name = "004_mip0018_images";

/**
 * Token images: the cache of the background image fetcher of `serve` (`token-indexer/mip0018/image-fetcher.ts`), one
 * row per (`url`, `image_sha256`) that a token identity's usable `image` and `image_sha256` name (MIP "Common
 * fields": `image` is a type-4 URI, `image_sha256` the SHA-256 of the file at `image`, exactly 32 bytes).
 *
 * - `url` — the `image` value's exact bytes (chain bytes, so `bytea`; a type-4 value is ASCII). `image_sha256` — the
 *   usable `image_sha256` value, or empty bytes when the identity has none (no usable hash).
 * - `status` — `pending` (never checked), `verified` (the content's SHA-256 equals `image_sha256`), `unverified` (no
 *   usable hash), `mismatch` (the content's SHA-256 differs from `image_sha256`), `not-image` (not a PNG, JPEG, GIF or
 *   WebP file by its magic bytes), `unreachable` (no content could be fetched; `reason` says why).
 * - `bytes` — the content, kept only for `verified` and `unverified` raster images (`content_type` is the type its
 *   magic bytes show; `content_sha256` and `size` describe it). The API serves these bytes at
 *   `/v1/images/{content_sha256}`; content of any other status is never stored.
 * - `attempts`, `checked_at`, `next_attempt_at` — the fetcher's own schedule (consecutive failures, last check, next
 *   check; `next_attempt_at` NULL = never checked again). Wall-clock time for retry scheduling only; never served.
 *
 * Text columns hold fixed vocabularies only (`status`, `content_type`) and the fetcher's own ASCII reason words
 * (`reason`); no chain byte reaches a text column.
 */
export async function up(sql: ISql, schema: string): Promise<void> {
  assertValidSchemaName(schema);
  await sql`
    CREATE TABLE ${sql(schema)}.mip0018_images (
      url             bytea       NOT NULL CHECK (octet_length(url) BETWEEN 1 AND 219),
      image_sha256    bytea       NOT NULL CHECK (octet_length(image_sha256) IN (0, 32)),
      status          text        NOT NULL CHECK (status IN ('pending', 'verified', 'unverified', 'mismatch', 'not-image', 'unreachable')),
      reason          text        CHECK (reason IS NULL OR reason ~ '^[a-z0-9-]{1,40}$'),
      content_type    text        CHECK (content_type IS NULL OR content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
      content_sha256  bytea       CHECK (content_sha256 IS NULL OR octet_length(content_sha256) = 32),
      size            integer     CHECK (size IS NULL OR size BETWEEN 0 AND 16777216),
      bytes           bytea,
      attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      checked_at      timestamptz,
      next_attempt_at timestamptz,
      PRIMARY KEY (url, image_sha256),
      CHECK ((status = 'pending') = (checked_at IS NULL)),
      CHECK ((status = 'unreachable') = (reason IS NOT NULL)),
      CHECK ((status IN ('pending', 'unreachable')) = (content_sha256 IS NULL AND size IS NULL)),
      CHECK ((status IN ('verified', 'unverified')) = (bytes IS NOT NULL)),
      CHECK ((bytes IS NULL) = (content_type IS NULL)),
      CHECK (bytes IS NULL OR (octet_length(bytes) = size AND sha256(bytes) = content_sha256)),
      CHECK (status <> 'verified' OR content_sha256 = image_sha256),
      CHECK (status <> 'unverified' OR octet_length(image_sha256) = 0),
      CHECK (status <> 'mismatch' OR (octet_length(image_sha256) = 32 AND content_sha256 <> image_sha256))
    )
  `;
  // `/v1/images/{id}`: the stored bytes by their SHA-256.
  await sql`
    CREATE INDEX mip0018_images_content_idx ON ${sql(schema)}.mip0018_images (content_sha256) WHERE bytes IS NOT NULL`;
  // The fetcher's queue: rows due for a (first or next) check, oldest first.
  await sql`
    CREATE INDEX mip0018_images_due_idx ON ${sql(schema)}.mip0018_images (next_attempt_at) WHERE next_attempt_at IS NOT NULL`;
  // The fetcher discovers images from the identities' `image` fields only (key bytes "image"), page by page.
  await sql`
    CREATE INDEX mip0018_fields_image_idx ON ${sql(schema)}.mip0018_fields (network, contract_address, domain_sep, kind)
    WHERE key = '\\x696d616765'::bytea`;
}
