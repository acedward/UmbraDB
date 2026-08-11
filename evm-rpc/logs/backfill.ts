/**
 * C-G5 — genesis backfill.
 *
 * Compact forbids `emit` in a constructor, so **constructor-minted supply produces no events at
 * all**. Without this step the logs are internally consistent but wrong in aggregate: folding every
 * `Transfer` would show holders spending tokens they never received, and any client reconstructing
 * balances from logs (which is the entire point of ERC20 log compatibility) would disagree with the
 * chain from block 0 onward.
 *
 * The fix is to synthesise the mints the constructor could not emit, from the seed file Part D
 * writes at deploy time (`out/deployment.json`, field `genesisBalances`).
 *
 * ── Why the ids are negative ───────────────────────────────────────────────────────────────────
 * These rows have no source event, but `logs.source_event_id` is `UNIQUE NOT NULL` and is what makes
 * every write idempotent. The indexer only ever issues POSITIVE event ids, so a negative sequence
 * cannot collide with a real one. The id is **derived, not sequential**:
 *
 *     source_event_id = -(address_map.id * 1_000_000 + holderIndex + 1)
 *
 * so it is a pure function of (contract, holder position). Re-running the backfill therefore
 * conflicts on exactly the same ids and inserts nothing — idempotent by construction rather than by
 * a "have I run yet?" flag that could itself be lost. Keying on `address_map.id` also means two
 * different contracts' genesis rows occupy disjoint negative ranges.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import { keccak256Utf8 } from "./keccak256.js";
import {
  TRANSFER_TOPIC0,
  defaultAddressMapper,
  fromHex,
  parseAmount,
  toHex,
  type AddressMapper,
  type LogRow,
} from "./event-map.js";
import { AddressIdCache, resolveAddressId, type SqlLike } from "./address-map.js";
import { writeLogs, type SqlPool } from "./store.js";
import type { WatchEntry } from "./config.js";

/** Holders per contract this scheme can encode before negative ranges would overlap. */
const HOLDERS_PER_CONTRACT = 1_000_000;

const unprefixedHex = z.string().regex(/^(0x)?[0-9a-fA-F]+$/, "must be hex");

export const DeploymentSchema = z.object({
  /** The deployed Midnight contract address. Cross-checked against the watch entry. */
  contractAddress: unprefixedHex.optional(),
  /** Block height the contract was deployed at. Defaults to 0. */
  deployBlock: z.number().int().nonnegative().optional(),
  /** Block hash of the deploy block, if Part D recorded it. */
  deployBlockHash: unprefixedHex.optional(),
  /** Transaction hash of the deploy, if Part D recorded it. */
  deployTxHash: unprefixedHex.optional(),
  genesisBalances: z
    .array(
      z.object({
        /** The OZ witness accountId (`persistentHash(sk)`) — an identity, not a spendable key. */
        accountId: unprefixedHex,
        /** Decimal string (or number) — a tokenId under the erc721 profile. */
        amount: z.union([z.string(), z.number()]),
      }),
    )
    .default([]),
});

export type Deployment = z.infer<typeof DeploymentSchema>;

export function parseDeployment(json: string): Deployment {
  return DeploymentSchema.parse(JSON.parse(json) as unknown);
}

export function loadDeploymentFile(path: string): Deployment {
  try {
    return parseDeployment(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `backfill: failed to load "${path}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface BackfillResult {
  holders: number;
  inserted: number;
  /** Rows whose derived id already existed — a re-run reports every row here and inserts none. */
  skipped: number;
}

export interface BackfillOptions {
  addressMapper?: AddressMapper;
  cache?: AddressIdCache;
  onWarning?: (message: string) => void;
}

/**
 * Deterministic stand-ins for coordinates a deploy record may not carry. Derived from the contract
 * address so they are stable across runs (a random or clock-based value would break idempotency).
 * They are clearly synthetic, and `LOGMAP.md` says so — a client must not expect to find the block
 * or transaction they name on-chain.
 */
function syntheticBlockHash(contractAddress: string): Uint8Array {
  return keccak256Utf8(`midnight-genesis-block:${contractAddress}`);
}
function syntheticTxHash(contractAddress: string): Uint8Array {
  return keccak256Utf8(`midnight-genesis-tx:${contractAddress}`);
}

/**
 * Builds the synthetic genesis mint rows. Pure, given the resolved `addressId` — so the mapping is
 * testable without a database, exactly like `mapEvents`.
 */
export function buildGenesisRows(
  entry: WatchEntry,
  deployment: Deployment,
  addressId: bigint,
  options: BackfillOptions = {},
): LogRow[] {
  if (entry.profile === "misc") {
    options.onWarning?.(
      `backfill: contract ${entry.address} has profile "misc"; genesis balances are an ERC20/721 ` +
        `notion, so no synthetic mints were generated`,
    );
    return [];
  }
  if (deployment.genesisBalances.length > HOLDERS_PER_CONTRACT) {
    throw new Error(
      `backfill: ${deployment.genesisBalances.length} genesis holders exceeds the ` +
        `${HOLDERS_PER_CONTRACT}-per-contract id range`,
    );
  }
  if (
    deployment.contractAddress !== undefined &&
    deployment.contractAddress.replace(/^0x/, "").toLowerCase() !== entry.address.toLowerCase()
  ) {
    throw new Error(
      `backfill: deployment.json contractAddress (${deployment.contractAddress}) does not match ` +
        `the watched address (${entry.address})`,
    );
  }

  const mapper = options.addressMapper ?? defaultAddressMapper;
  const contractEvmAddress = mapper({ kind: "contract", hex: entry.address });
  const blockNumber = deployment.deployBlock ?? 0;
  const blockHash =
    deployment.deployBlockHash === undefined
      ? syntheticBlockHash(entry.address)
      : fromHex(deployment.deployBlockHash);
  const txHash =
    deployment.deployTxHash === undefined
      ? syntheticTxHash(entry.address)
      : fromHex(deployment.deployTxHash);
  if (deployment.deployBlockHash === undefined || deployment.deployTxHash === undefined) {
    options.onWarning?.(
      `backfill: deployment.json for ${entry.address} has no deployBlockHash/deployTxHash; ` +
        `using deterministic synthetic coordinates (see LOGMAP.md)`,
    );
  }

  const zeroWord = new Uint8Array(32);
  return deployment.genesisBalances.map((holder, index) => {
    const recipient = mapper({ kind: "midnight", hex: holder.accountId.replace(/^0x/, "") });
    const to = new Uint8Array(32);
    to.set(recipient, 12);
    const amount = parseAmount(String(holder.amount));

    const topics: Uint8Array[] = [TRANSFER_TOPIC0, zeroWord, to];
    let data: Uint8Array;
    if (entry.profile === "erc721") {
      // Under erc721 the value IS the tokenId, and it is indexed.
      const tokenId = new Uint8Array(32);
      for (let i = 31, v = amount; i >= 0; i--, v >>= 8n) tokenId[i] = Number(v & 0xffn);
      topics.push(tokenId);
      data = new Uint8Array(0);
    } else {
      const word = new Uint8Array(32);
      for (let i = 31, v = amount; i >= 0; i--, v >>= 8n) word[i] = Number(v & 0xffn);
      data = word;
    }

    return {
      address: contractEvmAddress,
      blockNumber,
      blockHash,
      txHash,
      txIndex: 0,
      // Positional within the synthetic deploy transaction; also what keeps
      // `logs_tx_position_unique (tx_hash, log_index)` satisfied across holders.
      logIndex: index,
      topics,
      data,
      sourceEventId: -(Number(addressId) * HOLDERS_PER_CONTRACT + index + 1),
      removed: false,
    };
  });
}

/**
 * Resolves the contract's `address_map` id, builds the synthetic mints and writes them.
 *
 * NO cursor is advanced: `log_cursors` tracks the real event stream, and moving it here would make
 * the ingester skip genuine events. Genesis rows sit outside that sequence entirely.
 */
export async function backfillGenesis(
  sql: SqlPool,
  schema: string,
  entry: WatchEntry,
  deployment: Deployment,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const contractIdentity = { kind: "contract" as const, hex: entry.address };
  const addressId = await resolveAddressId(sql as SqlLike, schema, contractIdentity, {
    firstSeenBlock: deployment.deployBlock ?? 0,
    addressMapper: options.addressMapper,
    cache: options.cache,
  });

  const rows = buildGenesisRows(entry, deployment, addressId, options);
  if (rows.length === 0) return { holders: 0, inserted: 0, skipped: 0 };

  const result = await writeLogs(sql, schema, rows, {
    contractIdentity,
    addressMapper: options.addressMapper,
    cache: options.cache,
  });
  return { holders: rows.length, inserted: result.inserted, skipped: result.skipped };
}

/** Runs the backfill for every watch entry that names a `deploymentFile`. */
export async function backfillWatched(
  sql: SqlPool,
  schema: string,
  entries: readonly WatchEntry[],
  options: BackfillOptions = {},
): Promise<Map<string, BackfillResult>> {
  const results = new Map<string, BackfillResult>();
  for (const entry of entries) {
    if (entry.deploymentFile === undefined) continue;
    const deployment = loadDeploymentFile(entry.deploymentFile);
    results.set(entry.address, await backfillGenesis(sql, schema, entry, deployment, options));
  }
  return results;
}

// ===========================================================================================
// The verification counterpart
// ===========================================================================================

/**
 * Folds every `Transfer` log for one contract into per-address balances — the invariant
 * `LOGMAP.md` §7 states, and what the C-G5 test and the Part F dashboard check both assert against.
 *
 * `address(0)` is the mint/burn sink and is excluded from the result: a mint credits `to` with no
 * corresponding debit, and a burn debits `from` with no credit.
 */
export async function foldTransferBalances(
  sql: SqlLike,
  schema: string,
  evmAddress: Uint8Array,
): Promise<Map<string, bigint>> {
  const rows = await sql<{ topic1: Buffer | null; topic2: Buffer | null; data: Buffer }[]>`
    SELECT l.topic1, l.topic2, l.data
    FROM ${sql(schema)}.logs l
    JOIN ${sql(schema)}.address_map a ON a.id = l.address_id
    WHERE a.evm_addr = ${Buffer.from(evmAddress)}
      AND l.topic0 = ${Buffer.from(TRANSFER_TOPIC0)}
      AND l.removed = false
    ORDER BY l.block_number, l.tx_index, l.log_index
  `;

  const ZERO = "0".repeat(40);
  const balances = new Map<string, bigint>();
  const adjust = (account: string, delta: bigint): void => {
    if (account === ZERO) return; // the mint/burn sink
    balances.set(account, (balances.get(account) ?? 0n) + delta);
  };

  for (const row of rows) {
    if (row.topic1 === null || row.topic2 === null) continue;
    // topics are 32-byte left-padded addresses; the address is the low 20 bytes.
    const from = toHex(row.topic1).slice(24);
    const to = toHex(row.topic2).slice(24);
    const value = row.data.length === 0 ? 0n : BigInt(`0x${toHex(row.data)}`);
    adjust(from, -value);
    adjust(to, value);
  }
  return balances;
}
