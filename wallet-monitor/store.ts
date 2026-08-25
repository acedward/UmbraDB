import type { TransactionSql } from "postgres";
import type { UmbraDBSql } from "../src/postgres/client.js";
import { evmAddressBytes } from "./address.js";
import type { SubscriptionUtxo, UnshieldedSubscriptionEvent } from "./subscription.js";

type MonitorTx = TransactionSql<{ bigint: bigint }>;

interface IdRow { id: bigint }
interface CursorRow { transaction_id: string }
interface SumRow { value: string }

function hexBytes(value: string, name: string, bytes?: number): Buffer {
  const hex = value.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) throw new Error(`${name} is not valid hex`);
  const result = Buffer.from(hex, "hex");
  if (bytes !== undefined && result.length !== bytes) throw new Error(`${name} must be ${bytes} bytes`);
  return result;
}

function pairKey(addressId: bigint, tokenType: string): string {
  return `${addressId}:${tokenType.replace(/^0x/, "").toLowerCase()}`;
}

export class WalletMonitorStore {
  constructor(private readonly sql: UmbraDBSql, private readonly schema = "evm_rpc") {}

  async getCursor(address: string): Promise<number | undefined> {
    const rows = await this.sql<CursorRow[]>`
      SELECT value->>'transactionId' AS transaction_id
      FROM ${this.sql(this.schema)}.watermarks
      WHERE kind = 'unshielded_subscription' AND key = ${address}
    `;
    if (rows[0] === undefined) return undefined;
    const parsed = Number(rows[0].transaction_id);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid persisted cursor for ${address}`);
    return parsed;
  }

  private async ensureAddress(tx: MonitorTx, mnAddress: string, blockHeight: number): Promise<bigint> {
    const rows = await tx<IdRow[]>`
      INSERT INTO ${tx(this.schema)}.address_map (evm_addr, kind, mn_address, first_seen_block)
      VALUES (${evmAddressBytes(mnAddress)}, 'midnight', ${mnAddress}, ${blockHeight})
      ON CONFLICT (evm_addr) DO UPDATE SET
        mn_address = EXCLUDED.mn_address,
        first_seen_block = LEAST(
          COALESCE(${tx(this.schema)}.address_map.first_seen_block, EXCLUDED.first_seen_block),
          EXCLUDED.first_seen_block
        )
      WHERE ${tx(this.schema)}.address_map.mn_address IS NULL
         OR ${tx(this.schema)}.address_map.mn_address = EXCLUDED.mn_address
      RETURNING id
    `;
    if (rows[0] === undefined) throw new Error(`EVM address is already mapped to a different Midnight address: ${mnAddress}`);
    return rows[0].id;
  }

  private async advanceCursor(tx: MonitorTx, address: string, transactionId: number): Promise<void> {
    await tx`
      INSERT INTO ${tx(this.schema)}.watermarks (kind, key, value)
      VALUES ('unshielded_subscription', ${address}, ${tx.json({ transactionId })})
      ON CONFLICT (kind, key) DO UPDATE SET
        value = jsonb_build_object(
          'transactionId',
          GREATEST(
            (${tx(this.schema)}.watermarks.value->>'transactionId')::bigint,
            (EXCLUDED.value->>'transactionId')::bigint
          )
        ),
        updated_at = now()
    `;
  }

  private async upsertUtxo(
    tx: MonitorTx,
    utxo: SubscriptionUtxo,
    addressId: bigint,
    spentTransactionId?: number,
  ): Promise<void> {
    const spentTx = spentTransactionId ?? utxo.spentAtTransaction?.id ?? null;
    await tx`
      INSERT INTO ${tx(this.schema)}.utxos
        (intent_hash, output_index, address_id, token_type, value, created_tx, spent_tx)
      VALUES
        (${hexBytes(utxo.intentHash, "intentHash")}, ${utxo.outputIndex}, ${addressId},
         ${hexBytes(utxo.tokenType, "tokenType", 32)}, ${utxo.value},
         ${utxo.createdAtTransaction.id}, ${spentTx})
      ON CONFLICT (intent_hash, output_index) DO UPDATE SET
        address_id = EXCLUDED.address_id,
        token_type = EXCLUDED.token_type,
        value = EXCLUDED.value,
        created_tx = LEAST(${tx(this.schema)}.utxos.created_tx, EXCLUDED.created_tx),
        spent_tx = CASE
          WHEN ${tx(this.schema)}.utxos.spent_tx IS NULL THEN EXCLUDED.spent_tx
          WHEN EXCLUDED.spent_tx IS NULL THEN ${tx(this.schema)}.utxos.spent_tx
          ELSE LEAST(${tx(this.schema)}.utxos.spent_tx, EXCLUDED.spent_tx)
        END
    `;
  }

  private async refreshBalance(tx: MonitorTx, addressId: bigint, tokenTypeHex: string, blockHeight: number): Promise<void> {
    const tokenType = hexBytes(tokenTypeHex, "tokenType", 32);
    const rows = await tx<SumRow[]>`
      SELECT COALESCE(sum(value), 0)::text AS value
      FROM ${tx(this.schema)}.utxos
      WHERE address_id = ${addressId} AND token_type = ${tokenType} AND spent_tx IS NULL
    `;
    await tx`
      INSERT INTO ${tx(this.schema)}.balances (address_id, token_type, value, updated_block)
      VALUES (${addressId}, ${tokenType}, ${rows[0]!.value}, ${blockHeight})
      ON CONFLICT (address_id, token_type) DO UPDATE SET
        value = EXCLUDED.value,
        updated_block = GREATEST(${tx(this.schema)}.balances.updated_block, EXCLUDED.updated_block)
    `;
  }

  async processEvent(subscriptionAddress: string, event: UnshieldedSubscriptionEvent): Promise<void> {
    if (event.__typename === "UnshieldedTransactionsProgress") {
      // The indexer can announce the snapshot high-water mark before it delivers the
      // corresponding historical transactions. Persisting that value here could skip
      // data after a crash. Only a transaction event may advance the durable cursor.
      return;
    }

    const transaction = event.transaction;
    await this.sql.begin(async (tx) => {
      // Two watched addresses can receive the same transaction concurrently. Serializing that
      // identity makes the duplicate deliveries deterministic while preserving parallelism for
      // unrelated transactions.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${transaction.hash}, 3))`;

      const addressIds = new Map<string, bigint>();
      for (const utxo of [...event.createdUtxos, ...event.spentUtxos]) {
        if (!addressIds.has(utxo.owner)) {
          addressIds.set(utxo.owner, await this.ensureAddress(tx, utxo.owner, transaction.block.height));
        }
      }

      const affectedPairs = new Map<string, { addressId: bigint; tokenType: string }>();
      for (const utxo of event.createdUtxos) {
        const addressId = addressIds.get(utxo.owner)!;
        await this.upsertUtxo(tx, utxo, addressId);
        affectedPairs.set(pairKey(addressId, utxo.tokenType), { addressId, tokenType: utxo.tokenType });
      }
      for (const utxo of event.spentUtxos) {
        const addressId = addressIds.get(utxo.owner)!;
        await this.upsertUtxo(tx, utxo, addressId, transaction.id);
        affectedPairs.set(pairKey(addressId, utxo.tokenType), { addressId, tokenType: utxo.tokenType });
      }

      const fromId = event.spentUtxos[0] === undefined ? null : addressIds.get(event.spentUtxos[0].owner)!;
      const firstDifferentReceiver = event.createdUtxos.find((utxo) => addressIds.get(utxo.owner) !== fromId);
      const toUtxo = firstDifferentReceiver ?? event.createdUtxos[0];
      const toId = toUtxo === undefined ? null : addressIds.get(toUtxo.owner)!;
      await tx`
        INSERT INTO ${tx(this.schema)}.tx_index
          (hash, block_height, block_hash, status, fee, from_id, to_id, raw_ref)
        VALUES
          (${hexBytes(transaction.hash, "transaction hash")}, ${transaction.block.height},
           ${hexBytes(transaction.block.hash, "block hash")},
           ${transaction.transactionResult?.status ?? "SUCCESS"}, ${transaction.fee ?? null},
           ${fromId}, ${toId}, ${`indexer:transaction:${transaction.id}`})
        ON CONFLICT (hash) DO UPDATE SET
          block_height = EXCLUDED.block_height,
          block_hash = EXCLUDED.block_hash,
          status = EXCLUDED.status,
          fee = EXCLUDED.fee,
          from_id = COALESCE(EXCLUDED.from_id, ${tx(this.schema)}.tx_index.from_id),
          to_id = CASE
            -- A sender subscription only exposes that sender's change output, while the
            -- receiver subscription exposes the actual recipient. Keep whichever candidate
            -- differs from the merged sender regardless of delivery order.
            WHEN ${tx(this.schema)}.tx_index.to_id IS NOT NULL
              AND ${tx(this.schema)}.tx_index.to_id IS DISTINCT FROM
                COALESCE(EXCLUDED.from_id, ${tx(this.schema)}.tx_index.from_id)
              AND EXCLUDED.to_id IS NOT NULL
              AND EXCLUDED.to_id IS DISTINCT FROM
                COALESCE(EXCLUDED.from_id, ${tx(this.schema)}.tx_index.from_id)
              THEN CASE WHEN
                (SELECT evm_addr FROM ${tx(this.schema)}.address_map
                 WHERE id = ${tx(this.schema)}.tx_index.to_id)
                <=
                (SELECT evm_addr FROM ${tx(this.schema)}.address_map
                 WHERE id = EXCLUDED.to_id)
                THEN ${tx(this.schema)}.tx_index.to_id ELSE EXCLUDED.to_id END
            WHEN ${tx(this.schema)}.tx_index.to_id IS NOT NULL
              AND ${tx(this.schema)}.tx_index.to_id IS DISTINCT FROM
                COALESCE(EXCLUDED.from_id, ${tx(this.schema)}.tx_index.from_id)
              THEN ${tx(this.schema)}.tx_index.to_id
            WHEN EXCLUDED.to_id IS NOT NULL
              AND EXCLUDED.to_id IS DISTINCT FROM
                COALESCE(EXCLUDED.from_id, ${tx(this.schema)}.tx_index.from_id)
              THEN EXCLUDED.to_id
            ELSE COALESCE(EXCLUDED.to_id, ${tx(this.schema)}.tx_index.to_id)
          END,
          raw_ref = EXCLUDED.raw_ref
      `;

      for (const pair of affectedPairs.values()) {
        await this.refreshBalance(tx, pair.addressId, pair.tokenType, transaction.block.height);
      }
      // This is deliberately last in the same transaction: a durable cursor can never name
      // transaction data whose UTXO/balance/tx_index writes did not commit.
      await this.advanceCursor(tx, subscriptionAddress, transaction.id);
    });
  }
}
