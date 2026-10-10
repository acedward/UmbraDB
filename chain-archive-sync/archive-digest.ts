/**
 * What "the same archive" means for the range checks: every `chain_archive` table, every column except the wall-clock
 * ones (`synced_at`, `created_at`, `updated_at`), in primary-key order, bytes as lowercase hex (whether the client reads
 * bytea as a `Buffer`, as postgres.js does, or as a plain `Uint8Array`, as PGlite does). Used by the archive sync's
 * kill-and-resume test (two runs compared row by row), by `record-tape.ts --capture` (the digest of the live Stagenet
 * sync stored in the fixture manifest), by the fixture replay tests (the replayed archive must have the same digest)
 * and by the browser engine's `digest` request. It runs unchanged in Node and in a browser worker: no `Buffer` and no
 * `node:*` import (SHA-256 of the UTF-8 text through `src/postgres/bytes.ts`).
 */
import { bytesToHex, sha256Hex } from "../src/postgres/bytes.js";
import type { UmbraDBSql } from "../src/postgres/client.js";

export async function dumpArchive(sql: UmbraDBSql, schema: string): Promise<Record<string, unknown[]>> {
  const s = sql(schema);
  const blocks = await sql`
    SELECT net, block_hash, height::text AS height, parent_hash, state_root, extrinsics_root, author,
           header_blob_hash, body_blob_hash, is_canonical, status, finalized
    FROM ${s}.blocks ORDER BY net, height, block_hash`;
  const transactions = await sql`
    SELECT net, tx_hash, block_height::text AS block_height, block_hash, position, kind, protocol_version,
           result, segments, raw_blob_hash
    FROM ${s}.transactions ORDER BY net, block_height, block_hash, tx_hash`;
  const bridge = await sql`
    SELECT net, block_height::text AS block_height, block_hash, observation_index, kind, raw_blob_hash
    FROM ${s}.bridge_observations ORDER BY net, block_height, block_hash, observation_index`;
  const blobs = await sql`SELECT hash, data, size_bytes FROM ${s}.chain_blobs ORDER BY hash`;
  const roles = await sql`SELECT blob_hash, role FROM ${s}.chain_blob_roles ORDER BY blob_hash, role`;
  const watermarks = await sql`SELECT kind, key, value FROM ${s}.watermarks ORDER BY kind, key`;
  const vks = await sql`SELECT count(*)::int AS n FROM ${s}.verifier_key_observations`;
  const norm = (rows: readonly Record<string, unknown>[]): unknown[] => rows.map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? bytesToHex(v) : v])));
  return {
    blocks: norm(blocks), transactions: norm(transactions), bridge_observations: norm(bridge),
    chain_blobs: norm(blobs), chain_blob_roles: norm(roles), watermarks: norm(watermarks), verifier_key_observations: norm(vks),
  };
}

/** JSON with object keys sorted at every depth (arrays keep their order): one text per value. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const utf8 = new TextEncoder();

/** SHA-256 of a text's UTF-8 bytes, lowercase hex. */
export const sha256OfText = (text: string): string => sha256Hex(utf8.encode(text));

export interface ArchiveDigest {
  /** Per table: row count and the SHA-256 of the canonical JSON of its rows. */
  tables: Record<string, { rows: number; sha256: string }>;
  /** SHA-256 of the canonical JSON of `tables`: one value for the whole archive. */
  sha256: string;
}

export function archiveDigest(dump: Record<string, unknown[]>): ArchiveDigest {
  const tables: ArchiveDigest["tables"] = {};
  for (const name of Object.keys(dump).sort()) {
    const rows = dump[name]!;
    tables[name] = { rows: rows.length, sha256: sha256OfText(canonicalJson(rows)) };
  }
  return { tables, sha256: sha256OfText(canonicalJson(tables)) };
}
