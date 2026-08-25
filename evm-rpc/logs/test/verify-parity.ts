/**
 * Parity check: `eth_getLogs` output === everything the pipeline is supposed to have written, i.e.
 * `mapEvents(raw GraphQL contractEvents output)` **∪** `buildGenesisRows(deployment.json)`.
 *
 *   npx tsx evm-rpc/logs/test/verify-parity.ts
 *
 * Reads the SAME events the ingester consumed, but over the plain HTTP GraphQL **query** rather than
 * the subscription, maps them with the pure mapper, and compares the result against what
 * `eth_getLogs` serves out of Postgres. It is a regression net for the whole C pipeline in one
 * assertion: any divergence means the ingester, the mapper and the RPC read path have stopped
 * agreeing — including a mapping change that was applied to live ingestion but never backfilled.
 *
 * ── Why the genesis rows are part of the expected set ──────────────────────────────────────────
 * Compact forbids `emit` in a constructor, so constructor-minted supply has NO source event and
 * `mapEvents` can never produce it; `backfill.ts` synthesises those rows instead (negative
 * `source_event_id`, LOGMAP.md). `eth_getLogs` serves them like any other row, so an expected set
 * built from events alone reports every genesis holder as an EXTRA row — the checker being
 * incomplete, not the pipeline being wrong. This script therefore rebuilds them from exactly the
 * input the backfill consumes: the `deploymentFile` named on the watch entry, through the same
 * `buildGenesisRows` the backfill calls. Entries without a `deploymentFile` contribute none, which
 * mirrors `backfillWatched` skipping them.
 *
 * Environment (see `config.ts`):
 *   INDEXER_HTTP           e.g. http://127.0.0.1:10001/api/v4/graphql
 *   PG_URL                 e.g. postgres://…:10010/umbradb
 *   WATCH_CONTRACTS_FILE   the watch config (its `deploymentFile` paths resolve relative to CWD)
 *   EVM_RPC_SCHEMA         optional, defaults to evm_rpc
 *
 * Exit code 0 = parity holds for every watched contract. **Non-zero = at least one contract
 * diverged** (the differing rows are printed, first 5 of each direction), so this is usable as a
 * gate rather than something whose stdout has to be read by a human.
 *
 * ── Requires a live indexer ────────────────────────────────────────────────────────────────────
 * This is the one Part C check that cannot run without the Part A stack, which is why it is a
 * script rather than a vitest case: the automated suites use `test/fake-indexer.ts` instead. Run
 * this the moment Part A is up — see `RUNBOOK.md` in this directory.
 */

import { createClient } from "../../../src/postgres/client.js";
import type { SqlLike } from "../address-map.js";
import { buildGenesisRows, loadDeploymentFile } from "../backfill.js";
import { loadWatchConfigFile, type WatchEntry } from "../config.js";
import { getLogs, type RpcLog } from "../get-logs.js";
import {
  defaultAddressMapper,
  mapEvents,
  splitCompleteTransactions,
  toHex,
  type MidnightEvent,
} from "../event-map.js";
import { rowToRpcLog } from "../subscribe.js";

/** The query form of the subscription document in `ingest.ts`, with limit/offset paging. */
const CONTRACT_EVENTS_QUERY = `
query ParityContractEvents($filter: ContractEventFilter!, $limit: Int, $offset: Int) {
  contractEvents(filter: $filter, limit: $limit, offset: $offset) {
    __typename
    id
    maxId
    contractAddress
    transactionId
    transaction {
      hash
      block { height hash transactions { hash } }
    }
    ... on UnshieldedSpendEvent {
      sender { kind userAddress contractAddress }
      domainSep tokenType amount
    }
    ... on UnshieldedReceiveEvent {
      recipient { kind userAddress contractAddress }
      domainSep tokenType amount
    }
    ... on UnshieldedMintEvent { domainSep tokenType amount }
    ... on UnshieldedBurnEvent {
      sender { kind userAddress contractAddress }
      tokenType amount
    }
    ... on ShieldedSpendEvent { nullifier }
    ... on ShieldedReceiveEvent { commitment ciphertext receivingContractAddress }
    ... on ShieldedMintEvent { commitment domainSep amount }
    ... on ShieldedBurnEvent { nullifier amount }
    ... on MiscContractEvent { name payload }
  }
}`.trim();

/** The indexer's documented hard cap is 500 per page. */
const PAGE_SIZE = 500;

async function graphql<T>(url: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    throw new Error(`indexer HTTP ${response.status}: ${await response.text()}`);
  }
  const body = (await response.json()) as { data?: T; errors?: unknown[] };
  if (body.errors !== undefined && body.errors.length > 0) {
    throw new Error(`indexer GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  if (body.data === undefined) throw new Error("indexer returned no data");
  return body.data;
}

/**
 * Fetches every event for `entry`, pinning `toBlock` across pages. Without the pin, a block landing
 * mid-pagination shifts offsets and rows are silently skipped or repeated.
 */
async function fetchAllEvents(url: string, entry: WatchEntry, toBlock: number): Promise<MidnightEvent[]> {
  const events: MidnightEvent[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const filter: Record<string, unknown> = { contractAddress: entry.address, toBlock };
    if (entry.fromBlock !== undefined) filter.fromBlock = entry.fromBlock;
    const data = await graphql<{ contractEvents: MidnightEvent[] }>(url, CONTRACT_EVENTS_QUERY, {
      filter,
      limit: PAGE_SIZE,
      offset,
    });
    events.push(...data.contractEvents);
    if (data.contractEvents.length < PAGE_SIZE) break;
  }
  return events;
}

/**
 * Read-only counterpart of `resolveAddressId`: a check that AUDITS the database must not write to
 * it, and `resolveAddressId` is an upsert. A miss is not fatal — `address_map.id` feeds only
 * `source_event_id`, which parity does not key on (see `logKey`) — so it degrades to a placeholder
 * with a warning rather than failing a run whose comparison would be unaffected.
 */
async function lookupContractAddressId(
  sql: SqlLike,
  schema: string,
  contractAddress: string,
): Promise<bigint | undefined> {
  const rows = await sql<{ id: bigint }[]>`
    SELECT id FROM ${sql(schema)}.address_map
    WHERE mn_address = ${contractAddress.replace(/^0x/, "").toLowerCase()}
  `;
  return rows[0]?.id;
}

/**
 * The genesis-backfill half of the expected set for one watch entry, in `eth_getLogs` shape.
 *
 * Deliberately built by calling `buildGenesisRows` — the very function the backfill uses — on the
 * very file the backfill reads. A parity check that re-derived the synthetic mints independently
 * would agree with a wrong backfill just as happily as with a right one.
 */
async function expectedGenesisLogs(
  sql: SqlLike,
  schema: string,
  entry: WatchEntry,
  toBlock: number,
): Promise<RpcLog[]> {
  // No `deploymentFile` ⇒ `backfillWatched` skips the contract ⇒ there is nothing to expect.
  if (entry.deploymentFile === undefined) return [];

  let addressId = await lookupContractAddressId(sql, schema, entry.address);
  if (addressId === undefined) {
    console.warn(
      `  warn address-map-miss: ${entry.address} has no address_map row — either the backfill ` +
        `never ran or the schema is empty; comparing with a placeholder id`,
    );
    addressId = 0n;
  }

  return buildGenesisRows(entry, loadDeploymentFile(entry.deploymentFile), addressId, {
    onWarning: (message) => console.warn(`  warn ${message}`),
  })
    // Same upper bound as the events: a genesis row above the ingested tip is outside the window
    // `getLogs` is asked for, so comparing it would be a false MISSING.
    .filter((row) => row.blockNumber <= toBlock)
    .map(rowToRpcLog);
}

/** Canonical, order-independent key for one log. */
const logKey = (log: RpcLog): string =>
  [log.address, log.blockNumber, log.transactionHash, log.logIndex, log.topics.join(","), log.data].join("|");

async function main(): Promise<void> {
  const indexerHttp = process.env.INDEXER_HTTP;
  const pgUrl = process.env.PG_URL;
  const watchFile = process.env.WATCH_CONTRACTS_FILE;
  const schema = process.env.EVM_RPC_SCHEMA ?? "evm_rpc";
  if (!indexerHttp || !pgUrl || !watchFile) {
    throw new Error("verify-parity: INDEXER_HTTP, PG_URL and WATCH_CONTRACTS_FILE are all required");
  }

  const contracts = loadWatchConfigFile(watchFile);
  const sql = createClient({ connectionString: pgUrl, schema });
  let failures = 0;

  try {
    // Pin the upper bound ONCE, from what has actually been ingested: comparing against a moving
    // tip would report spurious differences for events the ingester has not reached yet.
    const tip = await sql<{ max: bigint | null }[]>`
      SELECT max(block_number) AS max FROM ${sql(schema)}.logs
    `;
    const toBlock = tip[0]?.max == null ? 0 : Number(tip[0].max);
    console.log(`verify-parity: comparing through block ${toBlock}\n`);

    for (const entry of contracts) {
      const events = await fetchAllEvents(indexerHttp, entry, toBlock);
      // Only whole transactions are comparable — the ingester holds an incomplete trailing
      // transaction back on purpose, so including it here would be comparing against work that has
      // deliberately not happened yet.
      const { complete } = splitCompleteTransactions([...events, SENTINEL_TERMINATOR]);
      const eventLogs = mapEvents(
        complete.filter((event) => event !== SENTINEL_TERMINATOR),
        entry.profile,
        undefined,
        { onWarning: (warning) => console.warn(`  warn ${warning.code}: ${warning.message}`) },
      ).map(rowToRpcLog);

      // The rows no event can account for (see the header): rebuilt from the backfill's own input
      // and through the backfill's own builder, so a change to either side is caught here instead
      // of being explained away as "that is just the genesis mint".
      const genesisLogs = await expectedGenesisLogs(sql, schema, entry, toBlock);
      const expected = [...eventLogs, ...genesisLogs];

      // Served from the database, filtered by the contract's EVM address — derived the same way the
      // mapper derives it, so the two sides are keyed on the same identity.
      const contractEvmAddress = `0x${toHex(defaultAddressMapper({ kind: "contract", hex: entry.address }))}`;
      const contractLogs = await getLogs({ sql, schema }, [
        {
          address: contractEvmAddress,
          fromBlock: "earliest",
          toBlock: `0x${toBlock.toString(16)}`,
        },
      ]);

      const expectedKeys = new Set(expected.map(logKey));
      const servedKeys = new Set(contractLogs.map(logKey));
      const missing = [...expectedKeys].filter((key) => !servedKeys.has(key));
      const extra = [...servedKeys].filter((key) => !expectedKeys.has(key));

      const status = missing.length === 0 && extra.length === 0 ? "OK" : "MISMATCH";
      console.log(
        `${entry.address.slice(0, 12)}… [${entry.profile}] ${status} — ` +
          `${events.length} event(s) -> ${eventLogs.length} mapped` +
          (genesisLogs.length > 0 ? ` + ${genesisLogs.length} genesis` : "") +
          ` = ${expected.length} expected log(s), ${contractLogs.length} served`,
      );
      for (const key of missing.slice(0, 5)) console.log(`  MISSING from eth_getLogs: ${key}`);
      for (const key of extra.slice(0, 5)) console.log(`  EXTRA in eth_getLogs:     ${key}`);
      if (status === "MISMATCH") failures += 1;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  if (failures > 0) {
    console.error(`\nverify-parity: ${failures} contract(s) diverged`);
    process.exit(1);
  }
  console.log("\nverify-parity: parity holds for every watched contract");
}

/**
 * `splitCompleteTransactions` holds back the LAST transaction it sees. Appending a sentinel with a
 * transaction id nothing else uses makes the real final transaction complete, so a fully-drained
 * stream compares in full rather than always leaving one transaction out.
 */
const SENTINEL_TERMINATOR: MidnightEvent = {
  __typename: "PausedEvent",
  id: Number.MAX_SAFE_INTEGER,
  contractAddress: "00".repeat(32),
  transactionId: -1,
  transaction: { hash: "00".repeat(32), block: { height: 0, hash: "00".repeat(32) } },
};

void main().catch((error: unknown) => {
  console.error(`verify-parity: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
