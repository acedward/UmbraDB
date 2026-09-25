/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ISql } from "postgres";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { applyMetadataEvent, type RawContractEvent } from "./fold.js";
import { MULTIPART_OPT_INS, PackageReadError, readPackages, type PartEvent } from "./packages.js";
import { LEGACY_NAME_HEX, isTokenMetadataName } from "./payload.js";
import { RawEventError, decodeRawMiscEvent } from "./raw-event.js";

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
 *
 * ── Project 00024-01: opted-in names are read as [Y] packages, behind a barrier ────────────────
 * Events of a name opted into the Multi-Part Event rule ([Y]; `mip-0018:token-metadata[v1]` —
 * {@link MULTIPART_OPT_INS}) are not folded one by one. For such a pair (audit F1, plan B2):
 *
 *  - **complete-response barrier**: nothing of the pair's opted-in events is grouped, stored or
 *    folded until the WHOLE response is complete (`got == expected`) and EVERY opted-in event's
 *    `raw` decodes into a consistent `Misc` event (`raw-event.ts`). A short response, an
 *    undecodable `raw` or a reader error records the pending lookup and commits no package
 *    history and no projection — so a truncated package can never be stored, and the retry (whose
 *    first part would have the same identity) cannot be shadowed by `ON CONFLICT DO NOTHING`;
 *  - then each event's intent is its own `EventSource.physicalSegment` (spec FR-003), its position
 *    its indexer event id (ledger emission order), and its PHASE comes from the archived
 *    transcripts: the ledger applies the whole guaranteed section of a transaction before any
 *    fallible segment, so of this contract's events in this transaction, ordered by id, the first
 *    `Σ guaranteed log ops` are guaranteed and the rest fallible ({@link multipartPartEvents});
 *  - `readPackages` groups them ([Y] §4) and every package of the pair is folded in the caller's
 *    database transaction — atomically with the scan batch's cursor, or with the drain's retry.
 *
 * The superseded draft name `mip-xxxx:token-metadata[v1]` is NOT opted in (spec FR-006) and keeps
 * its behaviour exactly: each event is folded on its own, even from a short response (the fold is
 * idempotent on the event id and a draft event is complete by itself).
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
  /** The serialized ledger `Event` (every `ContractEvent` type carries it) — the only source of
   *  the event's physical intent (project 00024-01, spec FR-003). */
  rawHex: string | undefined;
}

/** Spec §6.5's interface. `IndexerEventSource` is the only implementation today. */
export interface EventSource {
  eventsFor(txHash: string, contractAddress: string): Promise<IndexerContractEvent[]>;
}

export const CONTRACT_EVENTS_QUERY = `query($filter: ContractEventFilter!, $limit: Int!, $offset: Int!) {
  contractEvents(filter: $filter, limit: $limit, offset: $offset) {
    __typename
    id
    raw
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
    rawHex: raw.raw === undefined || raw.raw === null ? undefined : unprefixed(raw.raw),
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

/** A recognised event of a name opted into [Y] — read as a part of a package, behind the barrier. */
export function isMultipartEvent(event: IndexerContractEvent, optIns: readonly string[] = MULTIPART_OPT_INS): boolean {
  return event.typename === "MiscContractEvent"
    && event.nameHex !== undefined
    && event.payloadHex !== undefined
    && optIns.includes(event.nameHex.toLowerCase());
}

/** A recognised event of the superseded draft name — folded on its own, as before 00024. */
function isDraftNameEvent(event: IndexerContractEvent): boolean {
  return isTokenMetadataEvent(event) && event.nameHex!.toLowerCase() === LEGACY_NAME_HEX;
}

/**
 * The counted `log` ops of ONE contract's calls in ONE physical intent, split by phase — what the
 * transaction itself says that contract emitted there (00020 FR-004; project 00024-01 reads each
 * part's phase off it, see {@link emissionByAddress}). Only COUNTED transcripts appear: a failed
 * fallible segment's ops produced no applied event (00020 FR-002).
 */
export interface EmissionEntry {
  segment: number;
  guaranteed: number;
  fallible: number;
}

export interface LookupPair {
  txHash: string;
  address: string;
  blockHeight: number;
  /** The transaction's index in its block (MIP-0018 §6.2's second ordering key). */
  txPosition: number;
  /** `log` ops counted in this call's COUNTED transcripts (spec FR-004). */
  expected: number;
  /** The same ops, per physical intent and phase, ascending by segment. Their sum is `expected`. */
  emission: EmissionEntry[];
}

/** The per-intent, per-phase `log` counts of every contract a transaction's calls emitted from —
 *  built from the decoder's call records, COUNTED transcripts only (00020 FR-002). */
export function emissionByAddress(
  calls: readonly {
    segment: number; address: string;
    guaranteed: { logOps: number; counted: boolean } | undefined;
    fallible: { logOps: number; counted: boolean } | undefined;
  }[],
): Map<string, EmissionEntry[]> {
  const byAddress = new Map<string, Map<number, EmissionEntry>>();
  for (const call of calls) {
    const g = call.guaranteed !== undefined && call.guaranteed.counted ? call.guaranteed.logOps : 0;
    const f = call.fallible !== undefined && call.fallible.counted ? call.fallible.logOps : 0;
    if (g === 0 && f === 0) continue;
    const segments = byAddress.get(call.address) ?? new Map<number, EmissionEntry>();
    const entry = segments.get(call.segment) ?? { segment: call.segment, guaranteed: 0, fallible: 0 };
    entry.guaranteed += g;
    entry.fallible += f;
    segments.set(call.segment, entry);
    byAddress.set(call.address, segments);
  }
  const out = new Map<string, EmissionEntry[]>();
  for (const [address, segments] of byAddress) {
    out.set(address, [...segments.values()].sort((a, b) => a.segment - b.segment));
  }
  return out;
}

export interface LookupOutcome {
  got: number;
  /** The pair was left in `pending_event_lookups` — its answer was short, or (00024-01) one of its
   *  opted-in events could not be read; nothing of those was stored. */
  short: boolean;
  /** Why the pair is pending, when it is. */
  pendingReason?: "short" | "undecodable_raw" | "reader";
  applied: number;
  rejected: number;
  /** Events whose payload could not even be stored (Q31) — counted, never silently dropped. */
  unstorable: number;
  /** [Y] packages folded from this answer (00024-01). */
  packages: number;
}

/** The pair's events contradict what its own transcripts say it emitted, per intent and phase — the
 *  scanner's model of emission would be wrong, which is refused exactly like an over-count. */
export class EmissionModelError extends Error {
  constructor(readonly txHash: string, readonly address: string, detail: string) {
    super(`contract ${address} in transaction ${txHash}: ${detail} — the scanner's model of emission is wrong, refusing to continue`);
    this.name = "EmissionModelError";
  }
}

/** How the lookup reads an opted-in event's `raw`: the loaded ledger-v9 module (injected). */
export interface LookupOptions {
  ledger?: any;
  /** Test configuration only (spec US2): names opted into [Y] other than {@link MULTIPART_OPT_INS}. */
  optIns?: readonly string[];
}

/**
 * The reader's input for one COMPLETE `(transaction, contract)` answer: every opted-in event,
 * decoded from its `raw`, with its intent, its position and its phase.
 *
 * The phase rule, from the ledger's own application order (`midnight-ledger` `semantics.rs`: the
 * guaranteed section of every intent first, then each fallible segment; evidence note §01-B): of
 * this contract's events in this transaction, ordered by indexer id, the first `G` are guaranteed —
 * `G` being the counted guaranteed `log` ops of its calls — and the rest fallible. Checked per intent
 * against the emission plan; a contradiction is an {@link EmissionModelError}.
 *
 * @throws {RawEventError} when an opted-in event's `raw` is missing, does not decode, or disagrees
 *   with the typed fields or the pair.
 */
export function multipartPartEvents(
  events: readonly IndexerContractEvent[], pair: LookupPair, net: string, opts: LookupOptions = {},
): PartEvent[] {
  const optIns = opts.optIns ?? MULTIPART_OPT_INS;
  const planned = pair.emission.reduce((sum, e) => sum + e.guaranteed + e.fallible, 0);
  if (planned !== pair.expected) {
    throw new Error(
      `lookup of ${pair.address} in ${pair.txHash}: the emission plan sums to ${planned}, not ${pair.expected}`,
    );
  }
  const guaranteedTotal = pair.emission.reduce((sum, e) => sum + e.guaranteed, 0);
  const ordered = [...events].sort((a, b) => a.eventId - b.eventId);
  const perIntent = new Map(pair.emission.map((e) => [e.segment, { ...e, seenG: 0, seenF: 0 }]));
  const parts: PartEvent[] = [];
  ordered.forEach((event, index) => {
    if (!isMultipartEvent(event, optIns)) return;
    const decoded = decodeRawMiscEvent(
      opts.ledger,
      { eventId: event.eventId, rawHex: event.rawHex, nameHex: event.nameHex!, payloadHex: event.payloadHex! },
      { txHash: pair.txHash, address: pair.address },
    );
    const phase = index < guaranteedTotal ? "guaranteed" : "fallible";
    const plan = perIntent.get(decoded.physicalSegment);
    if (plan === undefined) {
      throw new EmissionModelError(pair.txHash, pair.address,
        `event ${event.eventId} came from intent ${decoded.physicalSegment}, where its transcripts log nothing`);
    }
    if (phase === "guaranteed") plan.seenG++; else plan.seenF++;
    if (plan.seenG > plan.guaranteed || plan.seenF > plan.fallible) {
      throw new EmissionModelError(pair.txHash, pair.address,
        `intent ${decoded.physicalSegment} logs ${plan.guaranteed} guaranteed and ${plan.fallible} fallible ` +
        `events, but event ${event.eventId} would be one ${phase} event too many`);
    }
    parts.push({
      network: net, contract: pair.address, nameHex: decoded.nameHex,
      transactionHash: pair.txHash, segment: decoded.physicalSegment, position: event.eventId,
      payload: decoded.payload, phase,
    });
  });
  return parts;
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
 * Fetches one `(transaction, contract)` pair's events, stores every token-metadata declaration,
 * and records or clears its entry in the retry queue — all on the caller's `sql`, which is the
 * scan batch's own transaction (or the drain's), so rows and cursor commit together (spec FR-014).
 *
 * Draft-name events are folded one by one, as before. Opted-in events go through the barrier
 * described in this module's header: stored only from a complete, fully decoded answer, as whole
 * [Y] packages.
 */
export async function lookupEventsFor(
  sql: ISql, schema: string, net: string, source: EventSource, pair: LookupPair,
  opts: LookupOptions = {},
): Promise<LookupOutcome> {
  const events = await source.eventsFor(pair.txHash, pair.address);
  const got = events.length;

  if (got > pair.expected) {
    throw new UnexpectedEventCountError(pair.txHash, pair.address, pair.expected, got);
  }

  const outcome: LookupOutcome = { got, short: false, applied: 0, rejected: 0, unstorable: 0, packages: 0 };
  const count = (result: { unstorable: boolean; applied: boolean; stored: boolean }): void => {
    if (result.unstorable) { outcome.unstorable++; return; }
    if (result.applied && result.stored) outcome.applied++;
    else if (result.stored) outcome.rejected++;
  };

  // ── the superseded draft name: one event at a time, exactly as before (FR-006) ──────────────
  for (const event of events) {
    if (!isDraftNameEvent(event)) continue;
    const raw: RawContractEvent = {
      eventId: event.eventId,
      contractAddress: pair.address,
      txHash: pair.txHash,
      blockHeight: event.blockHeight === 0 ? pair.blockHeight : event.blockHeight,
      txPosition: pair.txPosition,
      nameHex: event.nameHex!,
      payloadHex: event.payloadHex!,
    };
    count(await applyMetadataEvent(sql, schema, net, raw));
  }

  const pending = async (reason: NonNullable<LookupOutcome["pendingReason"]>, lastError: string | undefined): Promise<LookupOutcome> => {
    await recordPendingLookup(sql, schema, net, pair, got, lastError);
    return { ...outcome, short: true, pendingReason: reason };
  };

  // ── the barrier (audit F1): a short answer stores NOTHING of an opted-in name ──────────────
  if (got < pair.expected) return pending("short", undefined);

  const optIns = opts.optIns ?? MULTIPART_OPT_INS;
  if (events.some((e) => isMultipartEvent(e, optIns))) {
    let packages;
    try {
      packages = readPackages(multipartPartEvents(events, pair, net, opts), { optIns, network: net }).packages;
    } catch (error) {
      if (error instanceof RawEventError) return pending("undecodable_raw", error.message);
      if (error instanceof PackageReadError) return pending("reader", `${error.reason}: ${error.message}`);
      throw error;
    }
    // Complete and decoded: every package of the pair, folded in this one database transaction.
    for (const pkg of packages) {
      const result = await applyMetadataEvent(sql, schema, net, {
        eventId: pkg.positions[0]!,
        partEventIds: pkg.positions,
        contractAddress: pair.address,
        txHash: pair.txHash,
        blockHeight: pair.blockHeight,
        txPosition: pair.txPosition,
        nameHex: pkg.nameHex,
        payloadHex: Buffer.from(pkg.payload).toString("hex"),
        segment: pkg.segment,
        phase: pkg.phase,
      });
      outcome.packages++;
      count(result);
    }
  }

  await clearPendingLookup(sql, schema, net, pair.txHash, pair.address);
  return outcome;
}

export async function recordPendingLookup(
  sql: ISql, schema: string, net: string, pair: LookupPair, got: number, lastError: string | undefined,
): Promise<void> {
  await sql`
    INSERT INTO ${sql(schema)}.pending_event_lookups
      (net, tx_hash, address, block_height, tx_position, expected_events, emission, got_events,
       attempts, next_attempt_at, last_error)
    VALUES
      (${net}, ${Buffer.from(pair.txHash, "hex")}, ${Buffer.from(pair.address, "hex")}, ${pair.blockHeight},
       ${pair.txPosition}, ${pair.expected}, ${sql.json(pair.emission as never)}, ${got}, 1,
       now() + ${`${lookupBackoffMs(1)} milliseconds`}::interval, ${lastError ?? null})
    ON CONFLICT (net, tx_hash, address) DO UPDATE SET
      got_events      = EXCLUDED.got_events,
      expected_events = EXCLUDED.expected_events,
      emission        = EXCLUDED.emission,
      tx_position     = EXCLUDED.tx_position,
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
  sql: UmbraDBSql, schema: string, net: string, source: EventSource,
  opts: { limit?: number } & LookupOptions = {},
): Promise<DrainOutcome> {
  const due = await sql<{
    tx_hash: Buffer; address: Buffer; block_height: string; tx_position: number;
    expected_events: number; emission: EmissionEntry[]; attempts: number;
  }[]>`
    SELECT tx_hash, address, block_height, tx_position, expected_events, emission, attempts
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
      txPosition: row.tx_position,
      expected: row.expected_events,
      emission: row.emission,
    };
    outcome.attempted++;
    try {
      const result = await sql.begin(async (tx) => lookupEventsFor(tx, schema, net, source, pair, opts));
      outcome.applied += result.applied;
      if (result.short) {
        outcome.stillShort++;
        if (row.attempts + 1 >= LOOKUP_MAX_ATTEMPTS) outcome.givenUp++;
      } else {
        outcome.completed++;
      }
    } catch (error) {
      if (error instanceof UnexpectedEventCountError || error instanceof EmissionModelError) throw error;
      await recordPendingLookup(sql, schema, net, pair, 0, error instanceof Error ? error.message : String(error));
      outcome.stillShort++;
    }
  }
  return outcome;
}
