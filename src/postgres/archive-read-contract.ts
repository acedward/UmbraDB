import { createHash } from "node:crypto";
import {
  ArchiveDiscontinuityError,
  type ArchiveBlockPage,
  type ArchiveIdentity,
  type ArchiveReadContract,
  type ArchiveTip,
  type ArchivedBlock,
  type ArchivedTransaction,
} from "../interfaces/archive-read-contract.js";
import {
  BlobIntegrityError,
  BlobMissingError,
  type Hex32,
  type TransactionKind,
  type TransactionResult,
} from "../interfaces/chain-archive-store.js";
import { ValidationError } from "../interfaces/storage-errors.js";
import { ARCHIVE_IDENTITY_KEY_PREFIX } from "./chain-archive-store.js";
import type { UmbraDBSql } from "./client.js";
import { translatePostgresError } from "./errors.js";

/**
 * The Postgres implementation of {@link ArchiveReadContract}
 * (`src/interfaces/archive-read-contract.ts`) over the `chain_archive` schema.
 *
 * Read-only by construction: this class issues `SELECT` and nothing else. That is the mechanical
 * half of the spec's Rule B ("B never writes to an archive table", FR-025) -- a consumer holding
 * only this object cannot write to the archive even by mistake, and the write-set audit that
 * checks Rule B has a single object to point at rather than a convention to trust.
 *
 * **Why it is not more methods on `PgChainArchiveStore`.** That class is the writer's adapter and
 * exposes the whole write surface. Handing it to a scanner to "just read from" would hand it
 * `putBlockBundle` too. Composition also keeps the door open for the RPC implementation the spec
 * anticipates (US7: B running in a separate process or a TEE), which will implement this same
 * interface without any Postgres at all.
 *
 * **Snapshot semantics.** One page and its `sourceTip` are read inside ONE `REPEATABLE READ`
 * transaction. Without that, a block committed between the two reads makes `sourceTip` describe a
 * tip lower than a block already in `blocks` -- and a consumer comparing coverage against the tip
 * (FR-011/FR-020: "unscanned" must stay distinguishable from "scanned, empty") would see itself
 * ahead of the archive. Since the archive's writer commits one whole height at a time (Rule A), a
 * snapshot can never straddle a partially written height either.
 */
export class PgArchiveReadContract implements ArchiveReadContract {
  constructor(
    private readonly sql: UmbraDBSql,
    private readonly schema: string = "chain_archive",
  ) {}

  /** @inheritdoc */
  async readBlocksSince(net: string, afterHeight: number, maxBlocks: number): Promise<ArchiveBlockPage> {
    assertPagingArguments(afterHeight, maxBlocks);
    try {
      return await this.sql.begin(async (tx) => {
        // READ ONLY as well as REPEATABLE READ: the isolation level is what makes `blocks` and
        // `sourceTip` one consistent observation; the read-only marker is what makes "this class
        // cannot write" enforced by the database rather than asserted by a comment.
        await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;

        const blockRows = await tx<PageBlockRow[]>`
          SELECT height, block_hash, parent_hash, timestamp_ms
          FROM ${tx(this.schema)}.blocks
          WHERE net = ${net} AND height > ${afterHeight} AND is_canonical AND finalized
          ORDER BY height ASC
          LIMIT ${maxBlocks}
        `;

        const [tipRow] = await tx<{ height: bigint; block_hash: Buffer }[]>`
          SELECT height, block_hash
          FROM ${tx(this.schema)}.blocks
          WHERE net = ${net} AND is_canonical AND finalized
          ORDER BY height DESC
          LIMIT 1
        `;
        const sourceTip: ArchiveTip | undefined = tipRow === undefined
          ? undefined
          : { height: Number(tipRow.height), hash: bufToHex(tipRow.block_hash) };

        if (blockRows.length === 0) return { blocks: [], sourceTip };

        // Parent-linkage check across the page (see `ArchiveDiscontinuityError`). Only WITHIN the
        // page: the first block need not descend from `afterHeight`'s block, because a reader
        // legitimately starts below the archive's earliest retained height.
        for (let i = 1; i < blockRows.length; i++) {
          const previous = blockRows[i - 1]!;
          const current = blockRows[i]!;
          const parent = bufToHex(current.parent_hash);
          const expected = bufToHex(previous.block_hash);
          if (Number(current.height) !== Number(previous.height) + 1 || parent !== expected) {
            throw new ArchiveDiscontinuityError(net, Number(current.height), expected, parent);
          }
        }

        const blockHashes = blockRows.map((row) => row.block_hash);
        const lowestHeight = Number(blockRows[0]!.height);
        const highestHeight = Number(blockRows[blockRows.length - 1]!.height);

        // One query for the page's transactions, not one per block. The height bounds are
        // redundant with `block_hash IN (...)` for correctness and load-bearing for performance:
        // `transactions` is `PARTITION BY RANGE (block_height)`, and without them the planner
        // must consider every partition.
        const txRows = await tx<PageTxRow[]>`
          SELECT block_hash, tx_hash, position, kind, protocol_version, result, raw_blob_hash
          FROM ${tx(this.schema)}.transactions
          WHERE net = ${net}
            AND block_height BETWEEN ${lowestHeight} AND ${highestHeight}
            AND block_hash IN ${tx(blockHashes)}
          ORDER BY block_height ASC, position ASC
        `;

        // One query for every raw payload the page needs, deduplicated by content address (the
        // same bytes can legitimately be referenced by two rows -- `chain_blobs` is one global
        // content-addressed pool).
        const wantedBlobs = [...new Set(txRows.map((row) => bufToHex(row.raw_blob_hash)))];
        const blobs = new Map<Hex32, Uint8Array>();
        if (wantedBlobs.length > 0) {
          const blobRows = await tx<{ hash: Buffer; data: Buffer }[]>`
            SELECT hash, data FROM ${tx(this.schema)}.chain_blobs
            WHERE hash IN ${tx(wantedBlobs.map((hex) => Buffer.from(hex, "hex")))}
          `;
          for (const row of blobRows) {
            const key = bufToHex(row.hash);
            // Rehash-on-read, exactly as `ChainArchiveStore.getBlob` does (AC-3). Reading the
            // page in bulk must not be a way to receive bytes that single-blob reads would have
            // refused.
            const actual = sha256Hex(row.data);
            if (actual !== key) throw new BlobIntegrityError(key, actual);
            blobs.set(key, row.data);
          }
        }

        const byBlock = new Map<Hex32, ArchivedTransaction[]>();
        for (const row of txRows) {
          const blobHash = bufToHex(row.raw_blob_hash);
          const rawBytes = blobs.get(blobHash);
          if (rawBytes === undefined) throw new BlobMissingError(blobHash);
          const list = byBlock.get(bufToHex(row.block_hash)) ?? [];
          list.push({
            txHash: bufToHex(row.tx_hash),
            position: row.position,
            kind: row.kind as TransactionKind,
            protocolVersion: row.protocol_version,
            result: (row.result ?? undefined) as TransactionResult | undefined,
            rawBytes,
          });
          byBlock.set(bufToHex(row.block_hash), list);
        }

        const blocks: ArchivedBlock[] = blockRows.map((row) => {
          const hash = bufToHex(row.block_hash);
          return {
            net,
            height: Number(row.height),
            hash,
            parentHash: bufToHex(row.parent_hash),
            timestampMs: row.timestamp_ms === null ? undefined : Number(row.timestamp_ms),
            transactions: byBlock.get(hash) ?? [],
          };
        });
        return { blocks, sourceTip };
      });
    } catch (err) {
      if (
        err instanceof ArchiveDiscontinuityError || err instanceof BlobIntegrityError ||
        err instanceof BlobMissingError || err instanceof ValidationError
      ) {
        throw err;
      }
      throw translatePostgresError(err);
    }
  }

  /** @inheritdoc */
  async getArchiveIdentity(net: string): Promise<ArchiveIdentity | undefined> {
    try {
      return await this.sql.begin(async (tx) => {
        await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
        const [identityRow] = await tx<{ value: { archiveInstanceId?: unknown } }[]>`
          SELECT value FROM ${tx(this.schema)}.watermarks
          WHERE kind = 'chain_archive' AND key = ${`${ARCHIVE_IDENTITY_KEY_PREFIX}${net}`}
        `;
        const archiveInstanceId = identityRow?.value?.archiveInstanceId;
        if (typeof archiveInstanceId !== "string") return undefined;

        // Genesis is read from the archive's own block 0, not from configuration: the identity
        // must describe what this archive actually holds, so that a consumer comparing it against
        // a remembered one is comparing histories rather than two copies of the same config.
        const [genesisRow] = await tx<{ block_hash: Buffer }[]>`
          SELECT block_hash FROM ${tx(this.schema)}.blocks
          WHERE net = ${net} AND height = 0 AND is_canonical
        `;
        if (genesisRow === undefined) return undefined;
        return { net, genesisHash: bufToHex(genesisRow.block_hash), archiveInstanceId };
      });
    } catch (err) {
      throw translatePostgresError(err);
    }
  }
}

interface PageBlockRow {
  height: bigint;
  block_hash: Buffer;
  parent_hash: Buffer;
  timestamp_ms: bigint | null;
}

interface PageTxRow {
  block_hash: Buffer;
  tx_hash: Buffer;
  position: number;
  kind: string;
  protocol_version: number;
  result: string | null;
  raw_blob_hash: Buffer;
}

function bufToHex(buf: Buffer): Hex32 {
  return buf.toString("hex");
}

function sha256Hex(data: Uint8Array): Hex32 {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Paging arguments are validated rather than clamped.
 *
 * A `maxBlocks` of 0 would return an empty page forever and read as "caught up"; a fractional or
 * huge one would reach `LIMIT` as something the caller did not mean. Silently correcting either
 * hides a caller bug inside a loop whose only symptom is that it never makes progress.
 * `afterHeight` accepts `-1` (start from genesis, since the parameter is exclusive) and any
 * non-negative height, including one above the tip -- which is a legitimate, useful query
 * returning an empty page plus the real tip.
 */
function assertPagingArguments(afterHeight: number, maxBlocks: number): void {
  const issues: { path: string; message: string }[] = [];
  if (!Number.isSafeInteger(afterHeight) || afterHeight < -1) {
    issues.push({
      path: "afterHeight",
      message: `expected a safe integer >= -1 (-1 means "from genesis"); got ${afterHeight}`,
    });
  }
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1) {
    issues.push({
      path: "maxBlocks",
      message:
        `expected a safe integer >= 1; got ${maxBlocks}. Zero or negative page sizes are ` +
        "rejected rather than clamped: an empty page is indistinguishable from being caught up, " +
        "so a clamped 0 would make a reader loop forever reporting no progress.",
    });
  }
  if (issues.length > 0) {
    throw new ValidationError("invalid input at PgArchiveReadContract.readBlocksSince", issues);
  }
}
