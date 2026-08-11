/**
 * Parity check: `eth_getLogs` output === `mapEvents(raw GraphQL contractEvents output)`.
 *
 *   npx tsx evm-rpc/logs/test/verify-parity.ts
 *
 * Reads the SAME events the ingester consumed, but over the plain HTTP GraphQL **query** rather than
 * the subscription, maps them with the pure mapper, and compares the result against what
 * `eth_getLogs` serves out of Postgres. It is a regression net for the whole C pipeline in one
 * assertion: any divergence means the ingester, the mapper and the RPC read path have stopped
 * agreeing — including a mapping change that was applied to live ingestion but never backfilled.
 *
 * Environment (see `config.ts`):
 *   INDEXER_HTTP           e.g. http://127.0.0.1:10001/api/v4/graphql
 *   PG_URL                 e.g. postgres://…:10010/umbradb
 *   WATCH_CONTRACTS_FILE   the watch config
 *   EVM_RPC_SCHEMA         optional, defaults to evm_rpc
 *
 * Exit code 0 = parity holds. Non-zero = a difference, printed as the first N mismatching rows.
 *
 * ── Requires a live indexer ────────────────────────────────────────────────────────────────────
 * This is the one Part C check that cannot run without the Part A stack, which is why it is a
 * script rather than a vitest case: the automated suites use `test/fake-indexer.ts` instead. Run
 * this the moment Part A is up — see `RUNBOOK.md` in this directory.
 */

import { createClient } from "../../../src/postgres/client.js";
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
      const expected = mapEvents(
        complete.filter((event) => event !== SENTINEL_TERMINATOR),
        entry.profile,
        undefined,
        { onWarning: (warning) => console.warn(`  warn ${warning.code}: ${warning.message}`) },
      ).map(rowToRpcLog);

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
          `${events.length} event(s) -> ${expected.length} expected log(s), ${contractLogs.length} served`,
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
