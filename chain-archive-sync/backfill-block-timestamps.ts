import type { UmbraDBSql } from "../src/postgres/client.js";
import { PgChainArchiveStore } from "../src/postgres/chain-archive-store.js";
import { decodeProtocolVersionFromDigest } from "./extrinsic-decoder.js";
import { captureForProtocolVersion } from "./metadata-captures/index.js";
import {
  decodeBlockTimestampMs,
  resolveMetadata,
  type ResolvedRuntimeMetadata,
} from "./runtime-metadata.js";

/**
 * Backfill `blocks.timestamp_ms` (migration 008) for blocks archived before the column existed.
 *
 * **Entirely offline.** No node, no indexer, no network of any kind: everything needed is already
 * in the archive. The block's own body blob is the JSON-encoded extrinsic list the sync writer
 * stored (`sync-service.ts`'s `extrinsicsBytes`), the `Timestamp::set` inherent lives inside it,
 * and the runtime metadata that decodes it is either the archive's own capture
 * (`runtime_metadata`, migration 003) or this repo's committed capture registry. That matters:
 * the historical state a node would need to re-serve this metadata is exactly what a pruned node
 * has thrown away, so a backfill that needed one would be unrunnable on the archives most likely
 * to need it.
 *
 * **Never guesses.** A block whose timestamp cannot be decoded is REPORTED, not filled with a
 * substitute and not silently skipped: `NULL` continues to mean "not decoded" rather than
 * becoming an invented time nothing downstream can distinguish from a real one. The run continues
 * past it (one undecodable block must not strand the other million) and the caller decides what a
 * non-empty `unresolved` list means -- the CLI treats it as a non-zero exit.
 *
 * **Only ever fills NULLs.** Every `UPDATE` carries `AND timestamp_ms IS NULL`, so a re-run is a
 * no-op over already-backfilled rows and a concurrently ingesting writer's freshly written value
 * is never overwritten by a decode of the same block.
 */

export interface BackfillBlockTimestampsOptions {
  net: string;
  schema?: string;
  /** Rows read (and updated) per batch. Bounded so a multi-million-block archive does not
   *  materialise in memory. */
  batchSize?: number;
  /** Stop after this many blocks have been VISITED (not updated). Omit for "all of them". */
  maxBlocks?: number;
  /** Decode and report, write nothing. */
  dryRun?: boolean;
  /** Progress sink; defaults to silence so the function is usable from tests. */
  onProgress?: (message: string) => void;
}

export interface BackfillBlockTimestampsResult {
  /** Blocks visited (rows that had `timestamp_ms IS NULL` when the batch was read). */
  scanned: number;
  /** Blocks whose timestamp was decoded and written (0 in `dryRun`, where `decoded` is the
   *  interesting number). */
  updated: number;
  /** Blocks whose timestamp was successfully decoded, written or not. */
  decoded: number;
  /** Blocks that could not be decoded, with the reason. Never empty-and-ignored: the CLI exits
   *  non-zero when this list is non-empty. */
  unresolved: { height: number; blockHash: string; reason: string }[];
}

interface PendingBlockRow {
  height: bigint;
  block_hash: Buffer;
  header_blob_hash: Buffer;
  body_blob_hash: Buffer | null;
}

interface ArchivedCaptureRow {
  spec_name: string;
  spec_version: number;
  first_seen_height: bigint;
  metadata_blob_hash: Buffer;
}

export async function backfillBlockTimestamps(
  sql: UmbraDBSql, opts: BackfillBlockTimestampsOptions,
): Promise<BackfillBlockTimestampsResult> {
  const schema = opts.schema ?? "chain_archive";
  const batchSize = opts.batchSize ?? 500;
  const report = opts.onProgress ?? ((): void => {});
  const store = new PgChainArchiveStore(sql, schema);
  const result: BackfillBlockTimestampsResult = { scanned: 0, updated: 0, decoded: 0, unresolved: [] };

  // The archive's own captures, newest-runtime-last. A block is decoded with the capture whose
  // `first_seen_height` is the greatest one at or below it -- i.e. the runtime in force when the
  // block was produced. Resolved lazily and cached: `resolveMetadata` parses a multi-megabyte
  // SCALE blob, and an archive typically spans one or two runtimes.
  const archivedCaptures = await sql<ArchivedCaptureRow[]>`
    SELECT spec_name, spec_version, first_seen_height, metadata_blob_hash
    FROM ${sql(schema)}.runtime_metadata
    WHERE net = ${opts.net}
    ORDER BY first_seen_height ASC
  `;
  const resolvedByKey = new Map<string, ResolvedRuntimeMetadata>();
  const resolveArchivedCapture = async (row: ArchivedCaptureRow): Promise<ResolvedRuntimeMetadata> => {
    const key = `${row.spec_name}@${row.spec_version}`;
    const cached = resolvedByKey.get(key);
    if (cached !== undefined) return cached;
    // Through the store, so the capture is rehashed before it is trusted, exactly as every other
    // read of an archived blob is.
    const bytes = await store.getBlob(row.metadata_blob_hash.toString("hex"));
    const resolved = resolveMetadata(bytes, { specName: row.spec_name, specVersion: row.spec_version });
    resolvedByKey.set(key, resolved);
    return resolved;
  };
  const registryByProtocol = new Map<number, ResolvedRuntimeMetadata | undefined>();
  const resolveRegistryCapture = (protocolVersion: number): ResolvedRuntimeMetadata | undefined => {
    if (registryByProtocol.has(protocolVersion)) return registryByProtocol.get(protocolVersion);
    const found = captureForProtocolVersion(protocolVersion);
    const resolved = found === undefined
      ? undefined
      : resolveMetadata(found.bytes, {
        specName: `capture:${found.capture.nodeVersion}`, specVersion: protocolVersion,
      });
    registryByProtocol.set(protocolVersion, resolved);
    return resolved;
  };

  let afterHeight = -1;
  for (;;) {
    if (opts.maxBlocks !== undefined && result.scanned >= opts.maxBlocks) break;
    const remaining = opts.maxBlocks === undefined
      ? batchSize
      : Math.min(batchSize, opts.maxBlocks - result.scanned);
    // Keyset pagination on height rather than OFFSET: rows are being updated as we go, and an
    // OFFSET walk over a shifting result set skips rows.
    const pending = await sql<PendingBlockRow[]>`
      SELECT height, block_hash, header_blob_hash, body_blob_hash
      FROM ${sql(schema)}.blocks
      WHERE net = ${opts.net} AND is_canonical AND timestamp_ms IS NULL AND height > ${afterHeight}
      ORDER BY height ASC
      LIMIT ${remaining}
    `;
    if (pending.length === 0) break;

    for (const row of pending) {
      const height = Number(row.height);
      const blockHash = row.block_hash.toString("hex");
      afterHeight = height;
      result.scanned++;

      if (row.body_blob_hash === null) {
        result.unresolved.push({
          height, blockHash,
          reason: "no body blob is archived for this block, so its Timestamp::set inherent is not " +
            "recoverable from the archive alone",
        });
        continue;
      }

      let timestampMs: number | undefined;
      let reason = "no candidate runtime metadata decoded a Timestamp::set inherent";
      try {
        const extrinsics = decodeArchivedExtrinsics(
          await store.getBlob(row.body_blob_hash.toString("hex")),
        );
        const protocolVersion = decodeProtocolVersionFromDigest(
          decodeArchivedHeaderDigestLogs(await store.getBlob(row.header_blob_hash.toString("hex"))),
        );

        // Candidates in preference order: the archive's own capture for the runtime in force at
        // this height first (it is an observation of THIS chain), then the committed registry
        // keyed by the header's protocol version (evidence about a node RELEASE, which is why it
        // is second). Trying the second only when the first yields nothing is deliberate -- a
        // capture that decodes no timestamp at all decoded nothing, so there is no risk of
        // silently preferring the wrong layout's answer over the right one.
        const candidates: ResolvedRuntimeMetadata[] = [];
        const archived = [...archivedCaptures]
          .reverse()
          .find((capture) => Number(capture.first_seen_height) <= height);
        if (archived !== undefined) candidates.push(await resolveArchivedCapture(archived));
        if (protocolVersion !== undefined) {
          const registry = resolveRegistryCapture(protocolVersion);
          if (registry !== undefined) candidates.push(registry);
        }
        if (candidates.length === 0) {
          reason = protocolVersion === undefined
            ? "the archived header carries no MNSV protocol-version digest and this net has no " +
              "archived runtime metadata, so no capture can be selected"
            : `no archived runtime metadata at or below this height and no committed capture for ` +
              `protocol version ${protocolVersion}`;
        }
        for (const candidate of candidates) {
          const decoded = decodeBlockTimestampMs(candidate, extrinsics);
          if (decoded !== undefined) { timestampMs = decoded; break; }
        }
      } catch (err) {
        reason = `decode failed: ${err instanceof Error ? err.message : String(err)}`;
      }

      if (timestampMs === undefined) {
        result.unresolved.push({ height, blockHash, reason });
        continue;
      }
      result.decoded++;
      if (opts.dryRun === true) continue;

      // `AND timestamp_ms IS NULL` is the whole safety story of this write: it never overwrites a
      // value the ingest path already wrote, and a concurrent re-run of this backfill cannot
      // produce a lost update.
      await sql`
        UPDATE ${sql(schema)}.blocks
        SET timestamp_ms = ${timestampMs}
        WHERE net = ${opts.net} AND height = ${height} AND block_hash = ${row.block_hash}
          AND timestamp_ms IS NULL
      `;
      result.updated++;
    }
    report(
      `[backfill-timestamps] net=${opts.net} scanned=${result.scanned} updated=${result.updated} ` +
        `unresolved=${result.unresolved.length} (through height ${afterHeight})`,
    );
  }
  return result;
}

/** The archived body blob is `stableStringify(extrinsics)` -- a JSON array of `0x`-prefixed hex
 *  strings (`sync-service.ts`'s `extrinsicsBytes`). Parsed defensively: a blob that is not that
 *  shape means the archive was written by something else, and decoding it as extrinsics anyway
 *  would produce a plausible wrong answer. */
function decodeArchivedExtrinsics(bytes: Uint8Array): string[] {
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!Array.isArray(parsed) || parsed.some((e) => typeof e !== "string")) {
    throw new Error(
      "the archived body blob is not the JSON array of hex extrinsics this archive writes",
    );
  }
  return parsed as string[];
}

/** The archived header blob is `stableStringify(header)`. Only the digest logs are needed here
 *  (they carry the MNSV protocol version). */
function decodeArchivedHeaderDigestLogs(bytes: Uint8Array): string[] {
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const logs = (parsed as { digest?: { logs?: unknown } })?.digest?.logs;
  if (!Array.isArray(logs) || logs.some((l) => typeof l !== "string")) {
    throw new Error(
      "the archived header blob has no `digest.logs` array of hex strings, so the block's " +
        "protocol version cannot be read from it",
    );
  }
  return logs as string[];
}
