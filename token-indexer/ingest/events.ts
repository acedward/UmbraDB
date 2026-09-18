import type { ISql } from "postgres";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { applyMetadataEvent, type RawContractEvent } from "./fold.js";
import { isTokenMetadataName } from "./payload.js";

/**
 * Project 00020 — the event lookup (spec §6.5, FR-004). Transaction-driven, no watch list.
 *
 * A contract event's CONTENTS are not in the transaction: `emit` compiles to the `log` opcode,
 * whose data comes from the VM stack. What IS public in the transaction is the presence and count
 * of those ops in each transcript's program. So the scanner, for every call whose counted
 * transcripts contain `log` ops, asks the indexer for exactly that `(contract, transaction)` pair —
 * one HTTP query, all event types, so the returned count can be checked against the `log` count.
 *
 *  - `returned == expected` → process.
 *  - `returned <  expected` → the indexer has not finished correlating the transaction. Whatever
 *    did arrive is stored (the fold is idempotent and order-independent), the pair goes into
 *    `pending_event_lookups` with exponential backoff, and **the scan cursor moves on** — one slow
 *    transaction never stalls the scanner.
 *  - `returned >  expected` → a hard error naming the transaction. The model would be wrong, and
 *    quietly accepting extra events would mean the `log`-count assertion bought nothing.
 *
 * Owner decision Q3: the indexer is the event source for this experimental version, behind this
 * interface, so the owner's stated next step — reading the midnight-node directly, where
 * `TransactionResult.events` carries the same `ContractLog` items — is a second implementation and
 * nothing else changes.
 */

/** One contract event of ANY type, as the indexer serves it. Only `MiscContractEvent` carries
 *  `nameHex`/`payloadHex`; the others are counted and discarded, which is the point of asking for
 *  all types. */
export interface IndexerContractEvent {
  eventId: number;
  typename: string;
  contractAddress: string;
  txHash: string;
  blockHeight: number;
  nameHex: string | undefined;
  payloadHex: string | undefined;
}

/** Spec §6.5's interface. `IndexerEventSource` is the only implementation today. */
export interface EventSource {
  eventsFor(txHash: string, contractAddress: string): Promise<IndexerContractEvent[]>;
}

export const CONTRACT_EVENTS_QUERY = `query($filter: ContractEventFilter!, $limit: Int!, $offset: Int!) {
  contractEvents(filter: $filter, limit: $limit, offset: $offset) {
    __typename
    id
    contractAddress
    transaction { hash block { height } }
    ... on MiscContractEvent { name payload }
  }
}`;

/** The indexer caps `limit` at 500 and defaults `offset` to 0 (its own SDL doc). */
export const EVENTS_PAGE_SIZE = 500;

export class EventSourceError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "EventSourceError";
  }
}

export interface IndexerEventSourceOptions {
  url: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pageSize?: number;
}

/**
 * HTTP GraphQL event source. Plain `fetch`, no SDK, no websocket — the same posture as
 * `chain-archive-sync/indexer-client.ts`, which this deliberately does not reuse: that client's
 * `query` method is private and its shapes are the block-sync's, and copying 30 lines is cheaper
 * than widening a module two other pipelines depend on.
 */
export class IndexerEventSource implements EventSource {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly pageSize: number;

  constructor(opts: IndexerEventSourceOptions) {
    this.url = opts.url;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.pageSize = opts.pageSize ?? EVENTS_PAGE_SIZE;
  }

  async eventsFor(txHash: string, contractAddress: string): Promise<IndexerContractEvent[]> {
    const out: IndexerContractEvent[] = [];
    for (let offset = 0; ; offset += this.pageSize) {
      const page = await this.queryPage(txHash, contractAddress, offset);
      out.push(...page);
      if (page.length < this.pageSize) break;
    }
    return out;
  }

  private async queryPage(
    txHash: string, contractAddress: string, offset: number,
  ): Promise<IndexerContractEvent[]> {
    let res: Response;
    const body = JSON.stringify({
      query: CONTRACT_EVENTS_QUERY,
      variables: {
        filter: { contractAddress, transactionHash: txHash },
        limit: this.pageSize,
        offset,
      },
    });
    try {
      res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new EventSourceError(`contractEvents request failed for tx ${txHash}`, error);
    }
    if (!res.ok) {
      throw new EventSourceError(`contractEvents HTTP ${res.status} for tx ${txHash}`);
    }
    let parsed: { data?: { contractEvents?: unknown[] }; errors?: { message: string }[] };
    try {
      parsed = (await res.json()) as typeof parsed;
    } catch (error) {
      throw new EventSourceError(`contractEvents response for tx ${txHash} was not valid JSON`, error);
    }
    if (parsed.errors !== undefined && parsed.errors.length > 0) {
      throw new EventSourceError(
        `contractEvents GraphQL error for tx ${txHash}: ${parsed.errors.map((e) => e.message).join("; ")}`,
      );
    }
    return (parsed.data?.contractEvents ?? []).map((raw) => normalizeEvent(raw as Record<string, unknown>));
  }
}

function unprefixed(hex: unknown): string {
  const text = String(hex ?? "");
  return (text.startsWith("0x") || text.startsWith("0X") ? text.slice(2) : text).toLowerCase();
}

export function normalizeEvent(raw: Record<string, unknown>): IndexerContractEvent {
  const transaction = (raw.transaction ?? {}) as { hash?: string; block?: { height?: number } };
  return {
    eventId: Number(raw.id),
    typename: String(raw.__typename ?? "ContractEvent"),
    contractAddress: unprefixed(raw.contractAddress),
    txHash: unprefixed(transaction.hash),
    blockHeight: Number(transaction.block?.height ?? 0),
    nameHex: raw.name === undefined || raw.name === null ? undefined : unprefixed(raw.name),
    payloadHex: raw.payload === undefined || raw.payload === null ? undefined : unprefixed(raw.payload),
  };
}

/**
 * A `MiscContractEvent` named `pad(32, "mip-xxxx:token-metadata[v1]")` with a payload — everything
 * else is COUNTED and then discarded, which is exactly MIP §1's "Any other event MUST be ignored":
 * an event of another type, of another name (including the pre-MIP `TokenMetadata` this project
 * shipped in 00020), or with no payload is not stored, not rejected and not evidence of anything.
 */
export function isTokenMetadataEvent(event: IndexerContractEvent): boolean {
  return event.typename === "MiscContractEvent"
    && event.nameHex !== undefined
    && isTokenMetadataName(event.nameHex)
    && event.payloadHex !== undefined;
}

export interface LookupPair {
  txHash: string;
  address: string;
  blockHeight: number;
  /** `log` ops counted in this call's COUNTED transcripts (spec FR-004). */
  expected: number;
}

export interface LookupOutcome {
  got: number;
  short: boolean;
  applied: number;
  rejected: number;
  /** Events whose payload could not even be stored (Q31) — counted, never silently dropped. */
  unstorable: number;
}

export class UnexpectedEventCountError extends Error {
  constructor(readonly txHash: string, readonly address: string, readonly expected: number, readonly got: number) {
    super(
      `contract ${address} in transaction ${txHash} returned ${got} events but its transcripts ` +
      `declared only ${expected} log ops — the scanner's model of emission is wrong, refusing to continue`,
    );
    this.name = "UnexpectedEventCountError";
  }
}

/** Backoff for a short answer: 1 s, 2 s, 4 s … capped at 60 s; 30 attempts, then the row stays
 *  visible in `/internal/status` with its last error rather than being retried forever. */
export const LOOKUP_BACKOFF_BASE_MS = 1_000;
export const LOOKUP_BACKOFF_MAX_MS = 60_000;
export const LOOKUP_MAX_ATTEMPTS = 30;

export function lookupBackoffMs(attempts: number): number {
  return Math.min(LOOKUP_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), LOOKUP_BACKOFF_MAX_MS);
}

/**
 * Fetches one `(transaction, contract)` pair's events, stores every `TokenMetadata` one, and
 * records or clears its entry in the retry queue — all on the caller's `sql`, which is the scan
 * batch's own transaction, so rows and cursor commit together (spec FR-014).
 */
export async function lookupEventsFor(
  sql: ISql, schema: string, net: string, source: EventSource, pair: LookupPair,
): Promise<LookupOutcome> {
  const events = await source.eventsFor(pair.txHash, pair.address);
  const got = events.length;

  if (got > pair.expected) {
    throw new UnexpectedEventCountError(pair.txHash, pair.address, pair.expected, got);
  }

  let applied = 0;
  let rejected = 0;
  let unstorable = 0;
  for (const event of events) {
    if (!isTokenMetadataEvent(event)) continue;
    const raw: RawContractEvent = {
      eventId: event.eventId,
      contractAddress: pair.address,
      txHash: pair.txHash,
      blockHeight: event.blockHeight === 0 ? pair.blockHeight : event.blockHeight,
      nameHex: event.nameHex!,
      payloadHex: event.payloadHex!,
    };
    const outcome = await applyMetadataEvent(sql, schema, net, raw);
    if (outcome.unstorable) { unstorable++; continue; }
    if (outcome.applied && outcome.stored) applied++;
    else if (outcome.stored) rejected++;
  }

  if (got < pair.expected) {
    await recordPendingLookup(sql, schema, net, pair, got, undefined);
    return { got, short: true, applied, rejected, unstorable };
  }
  await clearPendingLookup(sql, schema, net, pair.txHash, pair.address);
  return { got, short: false, applied, rejected, unstorable };
}

export async function recordPendingLookup(
  sql: ISql, schema: string, net: string, pair: LookupPair, got: number, lastError: string | undefined,
): Promise<void> {
  await sql`
    INSERT INTO ${sql(schema)}.pending_event_lookups
      (net, tx_hash, address, block_height, expected_events, got_events, attempts, next_attempt_at, last_error)
    VALUES
      (${net}, ${Buffer.from(pair.txHash, "hex")}, ${Buffer.from(pair.address, "hex")}, ${pair.blockHeight},
       ${pair.expected}, ${got}, 1, now() + ${`${lookupBackoffMs(1)} milliseconds`}::interval, ${lastError ?? null})
    ON CONFLICT (net, tx_hash, address) DO UPDATE SET
      got_events      = EXCLUDED.got_events,
      expected_events = EXCLUDED.expected_events,
      attempts        = ${sql(schema)}.pending_event_lookups.attempts + 1,
      last_error      = EXCLUDED.last_error,
      next_attempt_at = now() + (LEAST(
        ${LOOKUP_BACKOFF_BASE_MS} * (2 ^ LEAST(${sql(schema)}.pending_event_lookups.attempts, 16)),
        ${LOOKUP_BACKOFF_MAX_MS}) || ' milliseconds')::interval
  `;
}

export async function clearPendingLookup(
  sql: ISql, schema: string, net: string, txHash: string, address: string,
): Promise<void> {
  await sql`
    DELETE FROM ${sql(schema)}.pending_event_lookups
    WHERE net = ${net} AND tx_hash = ${Buffer.from(txHash, "hex")} AND address = ${Buffer.from(address, "hex")}
  `;
}

export interface DrainOutcome {
  attempted: number;
  completed: number;
  stillShort: number;
  givenUp: number;
  applied: number;
}

/**
 * Retries every due `pending_event_lookups` row. Run by `serve` on a timer, independently of the
 * scanner, so the scan cursor and the retry queue never block one another.
 *
 * A row that has exhausted {@link LOOKUP_MAX_ATTEMPTS} is left alone — visible in
 * `/internal/status` with its last error. It is not deleted: "we asked 30 times and the indexer
 * never produced the events it should have" is a fact worth keeping.
 */
export async function drainPendingLookups(
  sql: UmbraDBSql, schema: string, net: string, source: EventSource, opts: { limit?: number } = {},
): Promise<DrainOutcome> {
  const due = await sql<{
    tx_hash: Buffer; address: Buffer; block_height: string; expected_events: number; attempts: number;
  }[]>`
    SELECT tx_hash, address, block_height, expected_events, attempts
    FROM ${sql(schema)}.pending_event_lookups
    WHERE net = ${net} AND next_attempt_at <= now() AND attempts < ${LOOKUP_MAX_ATTEMPTS}
    ORDER BY block_height
    LIMIT ${opts.limit ?? 50}
  `;
  const outcome: DrainOutcome = { attempted: 0, completed: 0, stillShort: 0, givenUp: 0, applied: 0 };
  for (const row of due) {
    const pair: LookupPair = {
      txHash: row.tx_hash.toString("hex"),
      address: row.address.toString("hex"),
      blockHeight: Number(row.block_height),
      expected: row.expected_events,
    };
    outcome.attempted++;
    try {
      const result = await sql.begin(async (tx) => lookupEventsFor(tx, schema, net, source, pair));
      outcome.applied += result.applied;
      if (result.short) {
        outcome.stillShort++;
        if (row.attempts + 1 >= LOOKUP_MAX_ATTEMPTS) outcome.givenUp++;
      } else {
        outcome.completed++;
      }
    } catch (error) {
      if (error instanceof UnexpectedEventCountError) throw error;
      await recordPendingLookup(sql, schema, net, pair, 0, error instanceof Error ? error.message : String(error));
      outcome.stillShort++;
    }
  }
  return outcome;
}
