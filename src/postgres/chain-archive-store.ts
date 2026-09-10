import { createHash, randomBytes } from "node:crypto";
import {
  BlobIntegrityError,
  BlobMissingError,
  BlockNotFoundError,
  Hex32Schema,
  type BlockBundle,
  type BlockMeta,
  type BlockRecord,
  type BridgeObservationKind,
  type BridgeObservationMeta,
  type BridgeObservationRecord,
  type ReplayCheckpointRecord,
  type RuntimeMetadataRecord,
  type ChainArchiveStore,
  type Hex32,
  type TransactionMeta,
  type TransactionRecord,
  type VerifierKeyObservationRecord,
} from "../interfaces/chain-archive-store.js";
import { ValidationError } from "../interfaces/storage-errors.js";
import type { JSONValue, TransactionSql } from "postgres";
import type { UmbraDBSql } from "./client.js";
import { translatePostgresError } from "./errors.js";

/** The `sql` handle `UmbraDBSql.begin(async (tx) => ...)` hands its callback -- used to type the
 *  shared row-insert helpers below so they can run either as their own standalone transaction
 *  (`putBlock`/`putTransactions`/`putBridgeObservations`, unchanged public call sites) or
 *  composed together inside ONE transaction (`putBlockBundle`, Fix 1). */
type ChainArchiveTx = TransactionSql<{ bigint: bigint }>;

function sha256Hex(data: Uint8Array): Hex32 {
  return createHash("sha256").update(data).digest("hex");
}

function hexToBuf(hex: Hex32): Buffer {
  return Buffer.from(hex, "hex");
}

function bufToHex(buf: Buffer): Hex32 {
  return buf.toString("hex");
}

/** The `watermarks` key this archive keeps its own instance identity under, per net
 *  (`spec/00009` FR-028). Exported so the read contract and the sync bootstrap agree on it
 *  without either re-deriving the string. */
export const ARCHIVE_IDENTITY_KEY_PREFIX = "archive_identity:";

function assertHex32(value: string, field: string): void {
  const parsed = Hex32Schema.safeParse(value);
  if (!parsed.success) throw ValidationError.fromZod(`PgChainArchiveStore.${field}`, parsed.error);
}

interface BlockRow {
  net: string;
  block_hash: Buffer;
  height: bigint;
  parent_hash: Buffer;
  state_root: Buffer;
  extrinsics_root: Buffer;
  author: Buffer | null;
  header_blob_hash: Buffer;
  body_blob_hash: Buffer | null;
  is_canonical: boolean;
  status: string;
  finalized: boolean;
  /** Migration 008. `null` for rows archived before it, or not yet backfilled. */
  timestamp_ms: bigint | null;
}

interface TxRow {
  net: string;
  tx_hash: Buffer;
  block_height: bigint;
  block_hash: Buffer;
  position: number;
  kind: string;
  protocol_version: number;
  result: string | null;
  raw_blob_hash: Buffer;
}

interface BridgeObservationRow {
  net: string;
  block_height: bigint;
  block_hash: Buffer;
  observation_index: number;
  kind: BridgeObservationKind;
  raw_blob_hash: Buffer;
}

function toBlockMeta(row: BlockRow): BlockMeta {
  return {
    net: row.net,
    blockHash: bufToHex(row.block_hash),
    height: Number(row.height),
    parentHash: bufToHex(row.parent_hash),
    stateRoot: bufToHex(row.state_root),
    extrinsicsRoot: bufToHex(row.extrinsics_root),
    author: row.author ? bufToHex(row.author) : undefined,
    headerBlobHash: bufToHex(row.header_blob_hash),
    bodyBlobHash: row.body_blob_hash ? bufToHex(row.body_blob_hash) : undefined,
    isCanonical: row.is_canonical,
    status: row.status as BlockMeta["status"],
    finalized: row.finalized,
    // `null` (not decoded / archived before migration 008) becomes `undefined`, never 0 -- the
    // whole point of the nullable column is that "unknown" and "the epoch" stay distinguishable.
    timestampMs: row.timestamp_ms === null ? undefined : Number(row.timestamp_ms),
  };
}

function toTxMeta(row: TxRow): TransactionMeta {
  return {
    net: row.net,
    txHash: bufToHex(row.tx_hash),
    blockHeight: Number(row.block_height),
    blockHash: bufToHex(row.block_hash),
    position: row.position,
    kind: row.kind as TransactionMeta["kind"],
    protocolVersion: row.protocol_version,
    result: (row.result ?? undefined) as TransactionMeta["result"],
    rawBlobHash: bufToHex(row.raw_blob_hash),
  };
}

function toBridgeObservationMeta(row: BridgeObservationRow): BridgeObservationMeta {
  return {
    net: row.net,
    blockHeight: Number(row.block_height),
    blockHash: bufToHex(row.block_hash),
    observationIndex: row.observation_index,
    kind: row.kind,
    rawBlobHash: bufToHex(row.raw_blob_hash),
  };
}

/**
 * Postgres implementation of `ChainArchiveStore` (`src/interfaces/chain-archive-store.ts`)
 * against the `chain_archive` schema (`migrations/chain_archive/001_chain_archive_core.ts`).
 * Does not run migrations itself -- call `runMigrations(sql, { schema, migrations:
 * chainArchiveMigrations })` before constructing this against a fresh database, matching every
 * other Postgres adapter in this repo (`checkpoint-store.ts`, `watermarks.ts`).
 *
 * Blob writes are content-addressed and idempotent: `putBlob` computes SHA-256 itself (never
 * trusts a caller-supplied hash) and uses `INSERT ... ON CONFLICT (hash) DO NOTHING` so a byte-
 * identical blob already present (from an earlier ingest, or shared across the header/body/tx
 * split) is reused rather than duplicated or rejected, matching `chain_blobs`'s documented
 * single-global-content-addressed-pool design (`design/full-chain-storage-design.md` §4.1). The
 * `chain_blob_roles` row is inserted the same way -- `ON CONFLICT DO NOTHING` on its own
 * `(blob_hash, role)` PK -- so re-registering an already-classified blob under the same role is a
 * no-op, not an error.
 */
export class PgChainArchiveStore implements ChainArchiveStore {
  constructor(
    private readonly sql: UmbraDBSql,
    private readonly schema: string = "chain_archive",
  ) {}

  /** Not part of the public interface -- an internal helper `chain-archive-sync` doesn't need to
   *  duplicate its own SHA-256/idempotent-insert logic for a blob that isn't yet attached to any
   *  metadata row (used by the AC-3 test harness directly against a real blob, and internally by
   *  `putBlock`/`putTransactions`). Exposed as a plain method (not `private`) so tests can drive
   *  it directly without needing a full block/transaction row just to exercise blob integrity. */
  async putBlobWithRole(data: Uint8Array, role: string): Promise<Hex32> {
    try {
      return await this.sql.begin(async (tx) => {
        const hashHex = sha256Hex(data);
        const hash = hexToBuf(hashHex);
        await tx`
          INSERT INTO ${tx(this.schema)}.chain_blobs (hash, data)
          VALUES (${hash}, ${Buffer.from(data)})
          ON CONFLICT (hash) DO NOTHING
        `;
        await tx`
          INSERT INTO ${tx(this.schema)}.chain_blob_roles (blob_hash, role)
          VALUES (${hash}, ${role})
          ON CONFLICT (blob_hash, role) DO NOTHING
        `;
        return hashHex;
      });
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /** Shared by `putBlock` (standalone, its own transaction) and `putBlockBundle` (composed
   *  alongside the transactions/bridge-observations insert in ONE transaction, Fix 1). The
   *  terminal `blocks` insert is `ON CONFLICT (net, height, block_hash) DO NOTHING` -- re-running
   *  this against an already-committed row (a retry after the row durably committed but a LATER
   *  step in the caller's own sequence failed/crashed) is a safe no-op rather than a
   *  duplicate-key error. */
  private async insertBlockRow(
    tx: ChainArchiveTx, block: BlockRecord,
  ): Promise<{ headerBlobHash: Hex32; bodyBlobHash?: Hex32 }> {
    const headerHashHex = sha256Hex(block.headerBytes);
    const headerHash = hexToBuf(headerHashHex);
    await tx`
      INSERT INTO ${tx(this.schema)}.chain_blobs (hash, data)
      VALUES (${headerHash}, ${Buffer.from(block.headerBytes)})
      ON CONFLICT (hash) DO NOTHING
    `;
    await tx`
      INSERT INTO ${tx(this.schema)}.chain_blob_roles (blob_hash, role)
      VALUES (${headerHash}, 'block_header')
      ON CONFLICT (blob_hash, role) DO NOTHING
    `;

    let bodyHash: Buffer | null = null;
    let bodyHashHex: Hex32 | undefined;
    if (block.bodyBytes !== undefined) {
      bodyHashHex = sha256Hex(block.bodyBytes);
      bodyHash = hexToBuf(bodyHashHex);
      await tx`
        INSERT INTO ${tx(this.schema)}.chain_blobs (hash, data)
        VALUES (${bodyHash}, ${Buffer.from(block.bodyBytes)})
        ON CONFLICT (hash) DO NOTHING
      `;
      await tx`
        INSERT INTO ${tx(this.schema)}.chain_blob_roles (blob_hash, role)
        VALUES (${bodyHash}, 'block_body')
        ON CONFLICT (blob_hash, role) DO NOTHING
      `;
    }

    // `timestamp_ms` (migration 008) is written HERE, inside the same statement as the rest of
    // the block row and therefore inside `putBlockBundle`'s one transaction (owner Rule A). It is
    // `NULL` when the caller has none: the value lives in the block body, and a caller that has
    // not decoded it must be able to archive the block rather than invent a time.
    //
    // The conflict clause stays `DO NOTHING`, unchanged. A re-ingest of an already-archived block
    // therefore does NOT retro-fill a `NULL` timestamp -- deliberately, so this method keeps its
    // established "byte-identical retry is a silent no-op" contract and never rewrites a
    // committed row. Filling in pre-008 rows is the backfill's job
    // (`chain-archive-sync/backfill-block-timestamps.ts`), which is explicit about it.
    await tx`
      INSERT INTO ${tx(this.schema)}.blocks
        (net, block_hash, height, parent_hash, state_root, extrinsics_root, author,
         header_blob_hash, body_blob_hash, is_canonical, status, finalized, timestamp_ms)
      VALUES
        (${block.net}, ${hexToBuf(block.blockHash)}, ${block.height},
         ${hexToBuf(block.parentHash)}, ${hexToBuf(block.stateRoot)},
         ${hexToBuf(block.extrinsicsRoot)}, ${block.author ? hexToBuf(block.author) : null},
         ${headerHash}, ${bodyHash}, ${block.isCanonical}, ${block.status}, ${block.finalized},
         ${block.timestampMs ?? null})
      ON CONFLICT (net, height, block_hash) DO NOTHING
    `;

    return { headerBlobHash: headerHashHex, bodyBlobHash: bodyHashHex };
  }

  /** Shared by `putTransactions` and `putBlockBundle`. The terminal `transactions` insert is a
   *  bare `ON CONFLICT DO NOTHING` (no target list) rather than one naming a specific constraint
   *  -- `transactions` carries TWO independent unique constraints (the
   *  `(net, block_height, block_hash, tx_hash)` PK and the separate
   *  `UNIQUE (net, block_height, block_hash, position)`), and for a genuine idempotent retry
   *  (byte-identical row) either one alone identifies the same already-committed row; targeting
   *  only one by name would leave the other free to still raise if Postgres happened to check it
   *  first. */
  private async insertTransactionRows(tx: ChainArchiveTx, txs: readonly TransactionRecord[]): Promise<void> {
    for (const t of txs) {
      const rawHashHex = sha256Hex(t.rawBytes);
      const rawHash = hexToBuf(rawHashHex);
      await tx`
        INSERT INTO ${tx(this.schema)}.chain_blobs (hash, data)
        VALUES (${rawHash}, ${Buffer.from(t.rawBytes)})
        ON CONFLICT (hash) DO NOTHING
      `;
      await tx`
        INSERT INTO ${tx(this.schema)}.chain_blob_roles (blob_hash, role)
        VALUES (${rawHash}, 'tx_raw')
        ON CONFLICT (blob_hash, role) DO NOTHING
      `;
      await tx`
        INSERT INTO ${tx(this.schema)}.transactions
          (net, tx_hash, block_height, block_hash, position, kind, protocol_version, result, raw_blob_hash)
        VALUES
          (${t.net}, ${hexToBuf(t.txHash)}, ${t.blockHeight}, ${hexToBuf(t.blockHash)},
           ${t.position}, ${t.kind}, ${t.protocolVersion}, ${t.result ?? null}, ${rawHash})
        ON CONFLICT DO NOTHING
      `;
    }
  }

  /** Shared by `putBridgeObservations` and `putBlockBundle`. */
  private async insertBridgeObservationRows(tx: ChainArchiveTx, obs: readonly BridgeObservationRecord[]): Promise<void> {
    for (const o of obs) {
      const rawHashHex = sha256Hex(o.rawBytes);
      const rawHash = hexToBuf(rawHashHex);
      await tx`
        INSERT INTO ${tx(this.schema)}.chain_blobs (hash, data)
        VALUES (${rawHash}, ${Buffer.from(o.rawBytes)})
        ON CONFLICT (hash) DO NOTHING
      `;
      await tx`
        INSERT INTO ${tx(this.schema)}.chain_blob_roles (blob_hash, role)
        VALUES (${rawHash}, 'bridge_observation')
        ON CONFLICT (blob_hash, role) DO NOTHING
      `;
      await tx`
        INSERT INTO ${tx(this.schema)}.bridge_observations
          (net, block_height, block_hash, observation_index, kind, raw_blob_hash)
        VALUES
          (${o.net}, ${o.blockHeight}, ${hexToBuf(o.blockHash)}, ${o.observationIndex}, ${o.kind}, ${rawHash})
        ON CONFLICT (net, block_height, block_hash, observation_index) DO NOTHING
      `;
    }
  }

  async putBlock(block: BlockRecord): Promise<{ headerBlobHash: Hex32; bodyBlobHash?: Hex32 }> {
    assertHex32(block.blockHash, "putBlock.blockHash");
    assertHex32(block.parentHash, "putBlock.parentHash");
    assertHex32(block.stateRoot, "putBlock.stateRoot");
    assertHex32(block.extrinsicsRoot, "putBlock.extrinsicsRoot");
    if (block.author !== undefined) assertHex32(block.author, "putBlock.author");

    try {
      return await this.sql.begin(async (tx) => this.insertBlockRow(tx, block));
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async putTransactions(txs: readonly TransactionRecord[]): Promise<void> {
    if (txs.length === 0) return;
    for (const t of txs) {
      assertHex32(t.txHash, "putTransactions.txHash");
      assertHex32(t.blockHash, "putTransactions.blockHash");
    }
    try {
      await this.sql.begin(async (tx) => this.insertTransactionRows(tx, txs));
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async putBridgeObservations(obs: readonly BridgeObservationRecord[]): Promise<void> {
    if (obs.length === 0) return;
    try {
      await this.sql.begin(async (tx) => this.insertBridgeObservationRows(tx, obs));
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async getLatestBridgeObservation(
    net: string, kind: BridgeObservationKind, maxHeight: number,
  ): Promise<BridgeObservationMeta | undefined> {
    try {
      const [row] = await this.sql<BridgeObservationRow[]>`
        SELECT o.net, o.block_height, o.block_hash, o.observation_index, o.kind, o.raw_blob_hash
        FROM ${this.sql(this.schema)}.bridge_observations o
        JOIN ${this.sql(this.schema)}.blocks b
          ON b.net = o.net AND b.height = o.block_height AND b.block_hash = o.block_hash
        WHERE o.net = ${net} AND o.kind = ${kind} AND o.block_height <= ${maxHeight}
          AND b.is_canonical AND b.finalized
        ORDER BY o.block_height DESC, o.observation_index DESC
        LIMIT 1
      `;
      return row === undefined ? undefined : toBridgeObservationMeta(row);
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /** Compare the transaction-history shape while the caller holds this height's advisory lock.
   * The service's earlier read is useful for a fast refusal, but cannot be authoritative: two
   * processes can both read the old snapshot before either writes. */
  private async assertBundleTransactionHistoryAgrees(
    tx: ChainArchiveTx, bundle: BlockBundle,
  ): Promise<void> {
    const { block, transactions: incoming } = bundle;
    const existing = await tx<TxRow[]>`
      SELECT net, tx_hash, block_height, block_hash, position, kind, protocol_version, result,
             raw_blob_hash
      FROM ${tx(this.schema)}.transactions
      WHERE net = ${block.net} AND block_height = ${block.height}
        AND block_hash = ${hexToBuf(block.blockHash)}
      ORDER BY position ASC
    `;
    if (existing.length === 0) return;

    const shape = (rows: readonly { position: number; txHash: string; kind: string }[]) =>
      [...rows]
        .sort((a, b) => a.position - b.position)
        .map((row) => `${row.position}:${row.txHash.toLowerCase()}:${row.kind}`)
        .join(" ");
    const before = shape(existing.map(toTxMeta));
    const after = shape(incoming);
    if (before === after) return;

    throw new Error(
      `height ${block.height}: this block is already archived with different contents under the ` +
        `database ingest lock. Stored: [${before}]. Re-ingest would write: [${after}]. ` +
        "Concurrent or historical writers must either agree byte-for-byte on the archive's " +
        "(position, tx_hash, kind) contract or refuse; silently interleaving/keeping one side is " +
        "not an idempotent retry.",
    );
  }

  /** Shared by `putReplayCheckpoint` (standalone) and `putBlockBundle` (owner Rule A: composed
   *  into the ONE per-height transaction). `replay_checkpoints` carries a real FK to `blocks`, so
   *  inside the bundle this must run AFTER `insertBlockRow` -- ordinary same-transaction MVCC
   *  visibility then satisfies the FK even though the block row has not committed yet, which is
   *  exactly the mechanism the transactions/bridge-observations inserts already rely on. */
  private async insertReplayCheckpointRows(
    tx: ChainArchiveTx, record: ReplayCheckpointRecord,
  ): Promise<void> {
    const hashHex = sha256Hex(record.stateBytes);
    const hash = hexToBuf(hashHex);
    await tx`
      INSERT INTO ${tx(this.schema)}.chain_blobs (hash, data)
      VALUES (${hash}, ${Buffer.from(record.stateBytes)})
      ON CONFLICT (hash) DO NOTHING
    `;
    await tx`
      INSERT INTO ${tx(this.schema)}.chain_blob_roles (blob_hash, role)
      VALUES (${hash}, 'ledger_state')
      ON CONFLICT (blob_hash, role) DO NOTHING
    `;
    await tx`
      INSERT INTO ${tx(this.schema)}.replay_checkpoints
        (net, block_height, block_hash, state_blob_hash, ledger_version, block_timestamp_ms,
         ledger_network_id)
      VALUES (${record.net}, ${record.blockHeight}, ${hexToBuf(record.blockHash)},
              ${hash}, ${record.ledgerVersion}, ${record.blockTimestampMs},
              ${record.ledgerNetworkId})
      ON CONFLICT (net, block_height, block_hash) DO NOTHING
    `;
  }

  /** Shared by `setWatermark` (standalone) and `putBlockBundle` (owner Rule A). The monotonic
   *  guard is part of the STATEMENT, not of the calling method, so folding the watermark advance
   *  into the per-height transaction keeps it -- a regressed height still cannot overwrite a
   *  higher one. See `setWatermark`'s own doc for why the guard is scoped to `{height}`-shaped
   *  values only. */
  private async upsertWatermarkRow(
    tx: ChainArchiveTx, key: string, value: unknown,
  ): Promise<void> {
    await tx`
      INSERT INTO ${tx(this.schema)}.watermarks AS w (kind, key, value, updated_at)
      VALUES ('chain_archive', ${key}, ${tx.json(value as JSONValue)}, now())
      ON CONFLICT (kind, key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = now()
      WHERE jsonb_typeof(w.value -> 'height') IS DISTINCT FROM 'number'
         OR jsonb_typeof(EXCLUDED.value -> 'height') IS DISTINCT FROM 'number'
         OR (EXCLUDED.value ->> 'height')::numeric > (w.value ->> 'height')::numeric
    `;
  }

  /** Fix 1 (sprint-fix round, HIGH): collapses the block + transactions + bridge-observations
   *  writes for one block into ONE Postgres transaction, so a partial block can never be
   *  committed at all -- see this method's own doc on `ChainArchiveStore` for the full
   *  before/after failure-mode writeup.
   *
   *  O2: the advisory xact lock and repeated history check belong INSIDE this transaction. A
   *  service-layer `SELECT` followed by this call has a race window; a database transaction guard
   *  serializes independent Node processes as well as independent service instances. */
  async putBlockBundle(bundle: BlockBundle): Promise<{ headerBlobHash: Hex32; bodyBlobHash?: Hex32 }> {
    const { block, transactions: txs, bridgeObservations: obs } = bundle;
    const checkpoint = bundle.replayCheckpoint;
    assertHex32(block.blockHash, "putBlockBundle.blockHash");
    assertHex32(block.parentHash, "putBlockBundle.parentHash");
    assertHex32(block.stateRoot, "putBlockBundle.stateRoot");
    assertHex32(block.extrinsicsRoot, "putBlockBundle.extrinsicsRoot");
    if (block.author !== undefined) assertHex32(block.author, "putBlockBundle.author");
    for (const t of txs) {
      assertHex32(t.txHash, "putBlockBundle.transactions.txHash");
      assertHex32(t.blockHash, "putBlockBundle.transactions.blockHash");
    }
    // Rule A: a checkpoint folded into this height's transaction must describe THIS height. A
    // checkpoint naming another block would make resume fold this chain onto a state that is not
    // its own -- silent, permanent divergence -- and inside one transaction there is no later
    // step where the mismatch could still be noticed. Rejected before anything is written.
    if (checkpoint !== undefined) {
      assertHex32(checkpoint.blockHash, "putBlockBundle.replayCheckpoint.blockHash");
      if (
        checkpoint.net !== block.net || checkpoint.blockHeight !== block.height ||
        checkpoint.blockHash !== block.blockHash
      ) {
        throw new ValidationError(
          "invalid input at PgChainArchiveStore.putBlockBundle.replayCheckpoint",
          [{
            path: "replayCheckpoint",
            message:
              `the bundled replay checkpoint describes ${checkpoint.net}#${checkpoint.blockHeight} ` +
              `(${checkpoint.blockHash}) but the bundle writes ${block.net}#${block.height} ` +
              `(${block.blockHash}). A checkpoint committed with a block it does not describe ` +
              "would be resumed against the wrong state.",
          }],
        );
      }
    }

    try {
      return await this.sql.begin(async (tx) => {
        // One unambiguous text key is hashed to PostgreSQL's 64-bit advisory-lock namespace. JSON
        // array encoding prevents concatenation ambiguities (`["a:1",2]` vs `["a",1:2]`). The
        // lock is transaction-scoped, so commit/rollback releases it even on every error path.
        await tx`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${JSON.stringify([block.net, block.height])}, ${0}::bigint)
          )
        `;

        // The production writer is finalized-only. If another finalized canonical block already
        // owns this height, a different hash is not an idempotent agreement and must be named as a
        // refusal rather than disappearing under the partial unique index's ON CONFLICT handling.
        const [canonical] = await tx<{ block_hash: Buffer }[]>`
          SELECT block_hash FROM ${tx(this.schema)}.blocks
          WHERE net = ${block.net} AND height = ${block.height} AND is_canonical AND finalized
          LIMIT 1
        `;
        if (canonical !== undefined && bufToHex(canonical.block_hash) !== block.blockHash) {
          throw new Error(
            `height ${block.height}: finalized-only ingest is racing/stitching two canonical ` +
              `blocks for net=${block.net}. Stored hash ${bufToHex(canonical.block_hash)} differs ` +
              `from incoming ${block.blockHash}; refusing the second writer.`,
          );
        }

        await this.assertBundleTransactionHistoryAgrees(tx, bundle);
        const result = await this.insertBlockRow(tx, block);
        // FK-ordering note: `transactions`/`bridge_observations` both carry a real FK back to
        // `blocks (net, height, block_hash)` (001_chain_archive_core.ts) -- inserting the block
        // row first, in the SAME transaction, makes it visible to these later statements' own FK
        // checks (ordinary same-transaction MVCC visibility), so the FK is satisfied even though
        // the referenced row hasn't committed yet.
        if (txs.length > 0) await this.insertTransactionRows(tx, txs);
        if (obs.length > 0) await this.insertBridgeObservationRows(tx, obs);

        // ── Owner Rule A (spec/00009 FR-029): everything else this height produces, HERE ──
        //
        // Both of the writes below used to be separate, independently committed transactions
        // issued by `chain-archive-sync/sync-service.ts` after this method returned. Each gap
        // between them was an observable durable state -- height without checkpoint, height
        // without watermark -- and recovery had to reason about all of them. Inside this
        // transaction there is nothing between them to crash in: the height commits whole or not
        // at all.
        //
        // ORDER MATTERS and is not arbitrary: the checkpoint's FK to `blocks` is satisfied by the
        // block row inserted above being visible to this same transaction, which is why the
        // checkpoint could not simply have been written first in the old two-transaction shape.
        if (checkpoint !== undefined) await this.insertReplayCheckpointRows(tx, checkpoint);
        if (bundle.watermark !== undefined) {
          await this.upsertWatermarkRow(tx, bundle.watermark.key, bundle.watermark.value);
        }
        // Transactional NOTIFY: PostgreSQL queues it and delivers it only if this transaction
        // commits, so a listener is never woken for a height that did not land. A listener that
        // misses it loses nothing -- polling is still the contract (`spec/00009`, wake-up hook is
        // an optimisation).
        if (bundle.notifyChannel !== undefined) {
          await tx`SELECT pg_notify(${bundle.notifyChannel}, ${`${block.net}:${block.height}`})`;
        }
        return result;
      });
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async putVerifierKeyObservation(vk: VerifierKeyObservationRecord): Promise<void> {
    try {
      await this.sql.begin(async (tx) => {
        const vkHashHex = sha256Hex(vk.vkBytes);
        const vkHash = hexToBuf(vkHashHex);
        await tx`
          INSERT INTO ${tx(this.schema)}.chain_blobs (hash, data)
          VALUES (${vkHash}, ${Buffer.from(vk.vkBytes)})
          ON CONFLICT (hash) DO NOTHING
        `;
        await tx`
          INSERT INTO ${tx(this.schema)}.chain_blob_roles (blob_hash, role)
          VALUES (${vkHash}, 'verifier_key')
          ON CONFLICT (blob_hash, role) DO NOTHING
        `;
        // Matches the schema's own documented upsert convention (001_chain_archive_core.ts's
        // verifier_key_observations comment): first_seen_height is a mutable "earliest known"
        // fact, not part of the identity key, so a repeated observation of the same context
        // collapses via LEAST rather than violating the UNIQUE constraint via a plain INSERT.
        await tx`
          INSERT INTO ${tx(this.schema)}.verifier_key_observations
            (vk_hash, net, scope, tag, contract_address, first_seen_height)
          VALUES
            (${vkHash}, ${vk.net}, ${vk.scope}, ${vk.tag},
             ${vk.contractAddress ? hexToBuf(vk.contractAddress) : null}, ${vk.firstSeenHeight})
          ON CONFLICT (vk_hash, net, scope, contract_address, tag) DO UPDATE
          SET first_seen_height = LEAST(
            ${tx(this.schema)}.verifier_key_observations.first_seen_height, EXCLUDED.first_seen_height)
        `;
      });
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async setCanonical(
    net: string, height: number, blockHash: Hex32, opts?: { finalized?: boolean },
  ): Promise<void> {
    assertHex32(blockHash, "setCanonical.blockHash");
    const blockHashBuf = hexToBuf(blockHash);
    try {
      await this.sql.begin(async (tx) => {
        // Un-mark whichever OTHER block currently holds is_canonical at this height first --
        // required ordering under the partial-unique-index enforcement (AC-2): the new row
        // cannot become canonical while the old one still holds the slot, since
        // blocks_one_canonical_per_height permits at most one is_canonical=true row per
        // (net, height) at every instant, not just at transaction end.
        await tx`
          UPDATE ${tx(this.schema)}.blocks
          SET is_canonical = false, status = 'orphaned'
          WHERE net = ${net} AND height = ${height} AND is_canonical
            AND block_hash <> ${blockHashBuf}
        `;
        const updated = await tx<{ block_hash: Buffer }[]>`
          UPDATE ${tx(this.schema)}.blocks
          SET is_canonical = true, status = 'canonical',
              finalized = COALESCE(${opts?.finalized ?? null}, finalized)
          WHERE net = ${net} AND height = ${height} AND block_hash = ${blockHashBuf}
          RETURNING block_hash
        `;
        if (updated.length === 0) {
          throw new BlockNotFoundError(net, height, blockHash);
        }
      });
    } catch (err) {
      if (err instanceof BlockNotFoundError) throw err;
      throw translatePostgresError(err);
    }
  }

  async getBlocksAtHeight(net: string, height: number): Promise<BlockMeta[]> {
    try {
      const rows = await this.sql<BlockRow[]>`
        SELECT net, block_hash, height, parent_hash, state_root, extrinsics_root, author,
               header_blob_hash, body_blob_hash, is_canonical, status, finalized, timestamp_ms
        FROM ${this.sql(this.schema)}.blocks
        WHERE net = ${net} AND height = ${height}
        ORDER BY block_hash
      `;
      return rows.map(toBlockMeta);
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async getCanonicalBlockAtHeight(net: string, height: number): Promise<BlockMeta | undefined> {
    try {
      const rows = await this.sql<BlockRow[]>`
        SELECT net, block_hash, height, parent_hash, state_root, extrinsics_root, author,
               header_blob_hash, body_blob_hash, is_canonical, status, finalized, timestamp_ms
        FROM ${this.sql(this.schema)}.blocks
        WHERE net = ${net} AND height = ${height} AND is_canonical
      `;
      return rows[0] ? toBlockMeta(rows[0]) : undefined;
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async getTransactionsByHash(net: string, txHash: Hex32): Promise<TransactionMeta[]> {
    assertHex32(txHash, "getTransactionsByHash.txHash");
    try {
      const rows = await this.sql<TxRow[]>`
        SELECT net, tx_hash, block_height, block_hash, position, kind, protocol_version, result, raw_blob_hash
        FROM ${this.sql(this.schema)}.transactions
        WHERE net = ${net} AND tx_hash = ${hexToBuf(txHash)}
        ORDER BY block_hash
      `;
      return rows.map(toTxMeta);
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async getTransactionsForBlock(net: string, blockHash: Hex32): Promise<TransactionMeta[]> {
    assertHex32(blockHash, "getTransactionsForBlock.blockHash");
    try {
      const rows = await this.sql<TxRow[]>`
        SELECT net, tx_hash, block_height, block_hash, position, kind, protocol_version, result, raw_blob_hash
        FROM ${this.sql(this.schema)}.transactions
        WHERE net = ${net} AND block_hash = ${hexToBuf(blockHash)}
        ORDER BY position ASC
      `;
      return rows.map(toTxMeta);
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async getCanonicalChainRange(net: string, fromHeight: number, toHeight: number): Promise<BlockMeta[]> {
    try {
      const rows = await this.sql<BlockRow[]>`
        SELECT net, block_hash, height, parent_hash, state_root, extrinsics_root, author,
               header_blob_hash, body_blob_hash, is_canonical, status, finalized, timestamp_ms
        FROM ${this.sql(this.schema)}.blocks
        WHERE net = ${net} AND height BETWEEN ${fromHeight} AND ${toHeight} AND is_canonical
        ORDER BY height ASC
      `;
      return rows.map(toBlockMeta);
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  async getBlob(hash: Hex32): Promise<Uint8Array> {
    assertHex32(hash, "getBlob.hash");
    try {
      const rows = await this.sql<{ data: Buffer }[]>`
        SELECT data FROM ${this.sql(this.schema)}.chain_blobs WHERE hash = ${hexToBuf(hash)}
      `;
      if (rows.length === 0) throw new BlobMissingError(hash);
      const data = rows[0]!.data;
      // AC-3 rehash-on-read: recompute SHA-256 over the retrieved bytes and reject if it
      // disagrees with the key we looked it up by -- mirrors CheckpointStore.loadImpl's proven
      // ChunkIntegrityError pattern (checkpoint-store.ts:260-278), rather than trusting the key
      // was correct at write time.
      const actualHash = sha256Hex(data);
      if (actualHash !== hash) throw new BlobIntegrityError(hash, actualHash);
      return data;
    } catch (err) {
      if (err instanceof BlobMissingError || err instanceof BlobIntegrityError) throw err;
      throw translatePostgresError(err);
    }
  }

  async getWatermark(key: string): Promise<unknown | undefined> {
    try {
      const rows = await this.sql<{ value: unknown }[]>`
        SELECT value FROM ${this.sql(this.schema)}.watermarks WHERE kind = 'chain_archive' AND key = ${key}
      `;
      return rows.length === 0 ? undefined : rows[0]!.value;
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /** Fix 5 (sprint-fix round, MEDIUM): a monotonic guard against watermark regression. Nothing
   *  prevents two overlapping `syncOnce()` calls (two service instances, or a scheduler firing
   *  while a slow previous run is still in flight) from racing each other's `setWatermark` calls
   *  -- without a guard, a slower/lagging call finishing AFTER a faster one can overwrite the
   *  cursor backward with a stale, lower height, which then makes the next sync attempt
   *  re-process already-ingested heights and hit the duplicate-key wedge Fix 1 addresses.
   *
   *  The guard is scoped to this store's one real convention -- a JSON value shaped
   *  `{ height: number }` (`chain-archive-sync/sync-service.ts`'s sync cursor; also this file's
   *  own test coverage) -- via the `ON CONFLICT ... DO UPDATE ... WHERE` clause below: when BOTH
   *  the already-stored value and the incoming value carry a numeric `height` field, the update
   *  is only applied if the incoming height is strictly greater, so a stale/regressed write is
   *  silently dropped (the row keeps its later, correct value) rather than clobbering forward
   *  progress. Any OTHER value shape (either side missing a numeric `height`, e.g. a future,
   *  unrelated `chain_archive` watermark consumer with its own value convention) falls through to
   *  the previous unconditional last-write-wins behavior unchanged -- this guard deliberately does
   *  not assume every current or future caller of this generic `(key, value)` API uses the
   *  height-cursor convention. */
  async setWatermark(key: string, value: unknown): Promise<void> {
    try {
      // Delegates to the shared statement `putBlockBundle` also issues, so the standalone path
      // and the folded Rule A path cannot drift apart in their monotonic guard. `begin` around a
      // single statement is not overhead worth avoiding: `postgres.js` would wrap it in an
      // implicit transaction anyway.
      await this.sql.begin(async (tx) => this.upsertWatermarkRow(tx, key, value));
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /**
   * @inheritdoc
   *
   * Stored as its own `watermarks` row (`kind = 'chain_archive'`, `key = 'archive_identity:<net>'`)
   * rather than through {@link setWatermark}: that method's guard only protects `{height}`-shaped
   * values and otherwise takes the last write, which for an identity means a second bootstrap
   * could silently replace the id every consumer has already bound to. `ON CONFLICT DO NOTHING`
   * plus a read-back gives the opposite property -- first writer wins, every later caller
   * observes that same value, and two concurrent bootstraps agree without coordinating.
   */
  async ensureArchiveInstanceId(net: string): Promise<string> {
    const key = `${ARCHIVE_IDENTITY_KEY_PREFIX}${net}`;
    try {
      return await this.sql.begin(async (tx) => {
        // 16 bytes of CSPRNG output. Hex rather than base64url so the value survives every
        // transport a future RPC implementation of the read contract might use unchanged, and so
        // it reads the same in a psql session as it does in a log line.
        const candidate = randomBytes(16).toString("hex");
        await tx`
          INSERT INTO ${tx(this.schema)}.watermarks (kind, key, value, updated_at)
          VALUES ('chain_archive', ${key}, ${tx.json({ archiveInstanceId: candidate })}, now())
          ON CONFLICT (kind, key) DO NOTHING
        `;
        const [row] = await tx<{ value: { archiveInstanceId?: unknown } }[]>`
          SELECT value FROM ${tx(this.schema)}.watermarks
          WHERE kind = 'chain_archive' AND key = ${key}
        `;
        const stored = row?.value?.archiveInstanceId;
        if (typeof stored !== "string" || !/^[0-9a-f]{32}$/.test(stored)) {
          // Reachable only if something outside this method wrote the identity row. Refusing is
          // the point: a consumer binding to a malformed identity cannot detect a re-synced
          // archive afterwards, and that failure would be silent.
          throw new Error(
            `${this.schema}.watermarks holds a malformed archive identity at key "${key}": ` +
              `${JSON.stringify(row?.value)}. Expected {"archiveInstanceId": "<32 hex chars>"}. ` +
              "Refusing rather than minting a second identity over it.",
          );
        }
        return stored;
      });
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /** @inheritdoc */
  async getRuntimeMetadata(
    net: string, specName: string, specVersion: number,
  ): Promise<Uint8Array | undefined> {
    try {
      const [row] = await this.sql<{ hash: Buffer }[]>`
        SELECT metadata_blob_hash AS hash FROM ${this.sql(this.schema)}.runtime_metadata
        WHERE net = ${net} AND spec_name = ${specName} AND spec_version = ${specVersion}
      `;
      if (row === undefined) return undefined;
      // Through getBlob, so the capture is rehashed before use like every other archived blob.
      // Metadata that silently rotted would misdecode every block of its runtime.
      return await this.getBlob(bufToHex(row.hash) as Hex32);
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /** @inheritdoc */
  async getLatestReplayCheckpoint(
    net: string, maxHeight: number,
  ): Promise<ReplayCheckpointRecord | undefined> {
    try {
      // The join to `blocks` on the FULL key -- including `block_hash` -- plus `is_canonical`
      // excludes an already-orphaned checkpoint. Under the finalized-only writer, catch-up then
      // verifies every successor's parent hash. This does NOT claim sound selection during an
      // arbitrary partially-applied height-at-a-time `setCanonical` reorg (T5a's explicit scope).
      const [row] = await this.sql<
        {
          height: string; block_hash: Buffer; hash: Buffer; ledger_version: string;
          block_timestamp_ms: string; ledger_network_id: string;
        }[]
      >`
        SELECT c.block_height::text AS height, c.block_hash, c.state_blob_hash AS hash,
               c.ledger_version, c.block_timestamp_ms::text AS block_timestamp_ms,
               c.ledger_network_id
        FROM ${this.sql(this.schema)}.replay_checkpoints c
        JOIN ${this.sql(this.schema)}.blocks b
          ON b.net = c.net AND b.height = c.block_height AND b.block_hash = c.block_hash
        WHERE c.net = ${net} AND c.block_height <= ${maxHeight} AND b.is_canonical
        ORDER BY c.block_height DESC
        LIMIT 1
      `;
      if (row === undefined) return undefined;
      return {
        net,
        blockHeight: Number(row.height),
        blockHash: bufToHex(row.block_hash),
        // Through getBlob, so the state is rehashed before a replay trusts it. Silently corrupted
        // state would produce wrong replay outcomes rather than an error.
        stateBytes: await this.getBlob(bufToHex(row.hash)),
        ledgerVersion: row.ledger_version,
        blockTimestampMs: Number(row.block_timestamp_ms),
        ledgerNetworkId: row.ledger_network_id,
      };
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /** @inheritdoc */
  async putReplayCheckpoint(record: ReplayCheckpointRecord): Promise<void> {
    try {
      await this.sql.begin(async (tx) => this.insertReplayCheckpointRows(tx, record));
    } catch (err) {
      throw translatePostgresError(err);
    }
  }

  /** @inheritdoc */
  async putRuntimeMetadata(record: RuntimeMetadataRecord): Promise<void> {
    try {
      const hashHex = sha256Hex(record.metadataBytes);
      const hash = hexToBuf(hashHex);
      await this.sql.begin(async (tx) => {
        await tx`
          INSERT INTO ${tx(this.schema)}.chain_blobs (hash, data)
          VALUES (${hash}, ${Buffer.from(record.metadataBytes)})
          ON CONFLICT (hash) DO NOTHING
        `;
        await tx`
          INSERT INTO ${tx(this.schema)}.chain_blob_roles (blob_hash, role)
          VALUES (${hash}, 'runtime_metadata')
          ON CONFLICT (blob_hash, role) DO NOTHING
        `;
        // DO NOTHING, not DO UPDATE: the first capture wins, so `first_seen_height` keeps naming
        // the block that genuinely introduced the runtime rather than the most recent re-sync.
        await tx`
          INSERT INTO ${tx(this.schema)}.runtime_metadata
            (net, spec_name, spec_version, first_seen_height, metadata_blob_hash)
          VALUES (${record.net}, ${record.specName}, ${record.specVersion},
                  ${record.firstSeenHeight}, ${hash})
          ON CONFLICT (net, spec_name, spec_version) DO NOTHING
        `;
      });
    } catch (err) {
      throw translatePostgresError(err);
    }
  }
}
