import { PgChainArchiveStore } from "../../../src/postgres/chain-archive-store.js";
import type { UmbraDBSql } from "../../../src/postgres/client.js";
import type { Hex32 } from "../../../src/interfaces/chain-archive-store.js";
import { fakeRawTransaction } from "./fake-ledger.js";

/**
 * Writes one synthetic block holding one synthetic transaction into a real `chain_archive` schema,
 * through the real store — so the scanner's own SQL, joins and blob indirection are exercised even
 * when the transaction's CONTENT has to be synthetic (see `fake-ledger.ts` for why: nothing on
 * Stagenet emits a `TokenMetadata` event yet, and proven transaction bytes cannot be forged).
 */
export async function seedSyntheticTransaction(
  sql: UmbraDBSql, schema: string, net: string,
  opts: {
    txHash: string;
    blockHeight: number;
    position?: number;
    result?: "success" | "partial_success" | "failure";
    segments?: { id: number; success: boolean }[] | null;
    marker?: string;
  },
): Promise<void> {
  const store = new PgChainArchiveStore(sql, schema);
  const blockHash = (opts.blockHeight.toString(16).padStart(8, "0") + "ab".repeat(28)).slice(0, 64) as Hex32;
  const pad = (n: number, tag: number): Hex32 =>
    (tag.toString(16).padStart(2, "0") + n.toString(16)).padStart(64, "0") as Hex32;

  await store.putBlockBundle({
    block: {
      net, blockHash, height: opts.blockHeight,
      parentHash: pad(opts.blockHeight - 1, 0xaa),
      stateRoot: pad(opts.blockHeight, 0xbb),
      extrinsicsRoot: pad(opts.blockHeight, 0xcc),
      headerBytes: Buffer.from(`header-${opts.blockHeight}`),
      bodyBytes: Buffer.from(`body-${opts.blockHeight}`),
      isCanonical: true, status: "canonical", finalized: true,
    },
    transactions: [{
      net, txHash: opts.txHash as Hex32, blockHeight: opts.blockHeight, blockHash,
      position: opts.position ?? 0, kind: "regular", protocolVersion: 2_000_000,
      rawBytes: fakeRawTransaction(opts.marker ?? opts.txHash),
    }],
    bridgeObservations: [],
  });

  await sql`
    UPDATE ${sql(schema)}.transactions
    SET result = ${opts.result ?? "success"},
        segments = ${opts.segments === undefined || opts.segments === null ? null : sql.json(opts.segments)}
    WHERE net = ${net} AND tx_hash = ${Buffer.from(opts.txHash, "hex")}
  `;
}

/** A canonical block with NO transactions — what a quiet chain is almost entirely made of, and
 *  what the scanner's idle cursor advance has to be able to walk over. */
export async function seedEmptyBlock(
  sql: UmbraDBSql, schema: string, net: string, height: number,
): Promise<void> {
  const store = new PgChainArchiveStore(sql, schema);
  const blockHash = (height.toString(16).padStart(8, "0") + "ab".repeat(28)).slice(0, 64) as Hex32;
  const pad = (n: number, tag: number): Hex32 =>
    (tag.toString(16).padStart(2, "0") + n.toString(16)).padStart(64, "0") as Hex32;
  await store.putBlockBundle({
    block: {
      net, blockHash, height,
      parentHash: pad(height - 1, 0xaa),
      stateRoot: pad(height, 0xbb),
      extrinsicsRoot: pad(height, 0xcc),
      headerBytes: Buffer.from(`header-${height}`),
      bodyBytes: Buffer.from(`body-${height}`),
      isCanonical: true, status: "canonical", finalized: true,
    },
    transactions: [],
    bridgeObservations: [],
  });
}
