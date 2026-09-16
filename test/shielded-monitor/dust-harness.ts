import type { DustEventRecord } from "../../src/interfaces/chain-archive-store.js";
import type {
  DustDb,
  DustGenerationRow,
  DustInitialUtxoRow,
  DustParametersRow,
  DustRawEvent,
  DustSpendRow,
} from "../../shielded-monitor/node/dust/db.js";

/**
 * An in-memory `DustDb` for the node's DUST suites.
 *
 * WHY A FAKE AND NOT ONLY A CONTAINER. The mirror's behaviour — batching, lease lifetimes,
 * snapshot refusal, a mid-request swap — is about ORDER and TIMING, and driving those through a
 * real PostgreSQL would mean writing 5 000 rows per case and then hoping the scheduler cooperates.
 * The queries themselves are not faked away: `dust-db.integration.test.ts` runs every one of them
 * against a real database seeded through project A's own store, which is the only way to prove the
 * SQL and the indexes are right. The two suites answer different questions and both are needed.
 *
 * The fake counts its calls, so a test can assert the real query pattern (one query per batch)
 * rather than a proxy for it.
 */

export interface FakeDustDbOptions {
  /** Throw a connection fault on every call after this many. */
  readonly failAfter?: number;
  readonly initialUtxos?: readonly DustInitialUtxoRow[];
  readonly generation?: readonly DustGenerationRow[];
  readonly spends?: readonly DustSpendRow[];
  /**
   * What `selectDustParametersAtOrBelow` answers (question Q-22 option C). A function so a test
   * can make a NEW row appear mid-run, which is how the mirror's parameter-change rebuild is
   * driven without a database.
   */
  readonly parameters?:
    | DustParametersRow
    | ((atHeight: bigint | undefined) => DustParametersRow | undefined);
}

export interface FakeDustDb extends DustDb {
  calls: number;
  tipCalls: number;
  parameterCalls: number;
  /** Every batch of nullifiers the routes asked about, so a custody test can prove what was sent
   *  reached the query — and, in the log assertions, that it reached nothing else. */
  lookedUp: string[][];
}

export function fakeDustDb(events: readonly Uint8Array[], options: FakeDustDbOptions = {}): FakeDustDb {
  const rows: DustRawEvent[] = events.map((raw, index) => ({
    id: BigInt(index + 1),
    // A plausible height progression: the mirror only ever reports the last row's height, so what
    // matters is that it is monotonic, as the archive's is.
    blockHeight: BigInt(1_000 + Math.floor(index / 7)),
    raw,
  }));

  const db: FakeDustDb = {
    calls: 0,
    tipCalls: 0,
    parameterCalls: 0,
    lookedUp: [],
    async selectEventsAfter(_net, afterId, limit) {
      db.calls += 1;
      if (options.failAfter !== undefined && db.calls > options.failAfter) {
        throw new Error("connection terminated unexpectedly");
      }
      return rows.filter((row) => row.id > afterId).slice(0, limit);
    },
    async selectTableTip(_net) {
      db.tipCalls += 1;
      if (options.failAfter !== undefined && db.calls > options.failAfter) {
        throw new Error("connection terminated unexpectedly");
      }
      const last = rows[rows.length - 1];
      return last === undefined ? undefined : { eventId: last.id, height: last.blockHeight };
    },
    async selectDustParametersAtOrBelow(_net, atHeight) {
      db.parameterCalls += 1;
      const source = options.parameters;
      if (source === undefined) return undefined;
      return typeof source === "function" ? source(atHeight) : source;
    },
    async selectInitialUtxosByOwner(_net, owner, afterId, limit) {
      const all = (options.initialUtxos ?? []).filter(
        (row) => String(row.output.owner) === owner && row.id > afterId,
      );
      return all.slice(0, limit);
    },
    async selectGenerationByOwner(_net, owner, afterIndex, limit) {
      const all = (options.generation ?? []).filter(
        (row) => row.owner === owner && row.generationIndex > afterIndex,
      );
      return all.slice(0, limit);
    },
    async selectSpendsByNullifiers(_net, nullifiers) {
      db.lookedUp.push([...nullifiers]);
      const wanted = new Set(nullifiers);
      return (options.spends ?? []).filter((row) => wanted.has(row.nullifier));
    },
    async close() {
      /* nothing to close */
    },
  };
  return db;
}

/** A `DustDb` whose every call fails — for the `503 DUST_DB_UNAVAILABLE` cases. */
export function brokenDustDb(events: readonly Uint8Array[]): FakeDustDb {
  const db = fakeDustDb(events);
  const fail = async (): Promise<never> => {
    throw new Error("connection terminated unexpectedly");
  };
  return {
    ...db,
    selectInitialUtxosByOwner: fail,
    selectGenerationByOwner: fail,
    selectSpendsByNullifiers: fail,
  };
}

// ── Real preprod rows, derived from the committed fixture ────────────────────────────────────

/**
 * The fixture's events as `dust_events` ROWS, produced by project A's own mapper.
 *
 * WHY THE REAL MAPPER and not hand-written rows: the routes return `payload.output` and
 * `payload.generation` almost verbatim, so a hand-written payload would be a test asserting its
 * own fiction. Running `mapDustEvents` over the real preprod events means the shapes the routes
 * serve are the shapes the ingest actually writes, in the encodings spec §4 fixes.
 *
 * `dustCommitment` is stubbed to `0n`. It is the one field of a kind-1 row no route reads (and at
 * 804 µs per initial UTxO it is the mapper's whole cost — see question Q-13, which records exactly
 * that trade-off), so paying it 1 381 times per suite would buy nothing.
 *
 * THE DTIME MERGE IS REPRODUCED HERE. `db.ts` does it in SQL (a lateral join to the newest kind-2
 * row); this does it in TypeScript. That means a route test cannot prove the SQL — which is why
 * `dust-db.integration.test.ts` runs the real queries against a real database over these same
 * rows and compares.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function dustRowsFromFixture(
  ledger: any,
  events: readonly Uint8Array[],
  /** How many fixture events share one synthetic block. Only the integration suite cares: it
   *  writes one `putBlockBundle` per block, so 7 events per block means 715 transactions for the
   *  whole fixture. */
  eventsPerBlock = 7,
): Promise<{
  initialUtxos: DustInitialUtxoRow[];
  generation: DustGenerationRow[];
  spends: DustSpendRow[];
  /** The owner with the most initial UTxOs, for the paging cases. */
  busiestOwner: string;
  /** The same events as the rows project A's ingest would write, grouped by synthetic block —
   *  what `dust-db.integration.test.ts` seeds a real database with. */
  records: { readonly id: bigint; readonly record: DustEventRecord }[];
}> {
  const { mapDustEvents } = await import("../../chain-archive-sync/dust-events.js");
  const records: { id: bigint; record: Awaited<ReturnType<typeof mapOne>>[number] }[] = [];

  /** One distinct 32-byte hash per synthetic block, so the archive's `(net, height, hash)` key
   *  and the FK from `dust_events` both hold. */
  function blockHashFor(index: number): string {
    return (1_000 + Math.floor(index / eventsPerBlock)).toString(16).padStart(64, "0");
  }

  function mapOne(index: number, raw: Uint8Array) {
    const event = ledger.Event.deserialize(raw);
    const content = event.content;
    const tag = typeof content?.tag === "string" ? content.tag : "";
    const txHash = String(event.source?.transactionHash ?? "").replace(/^0x/, "").toLowerCase();
    return mapDustEvents(
      { net: "preprod", blockHeight: 1_000 + Math.floor(index / eventsPerBlock), blockHash: blockHashFor(index) },
      [{ txPosition: index, eventIndex: 0, txKind: "system", txHash, tag, raw, content }],
      () => 0n,
    );
  }

  // Ids are DENSE OVER THE MAPPED ROWS, which is how the archive numbers them: `dust_events`
  // holds only the three DUST kinds, so the two `notYetSupportedEventType` events in this sample
  // occupy no id. That makes these ids comparable with a real database's, which is what
  // `dust-db.integration.test.ts` needs.
  //
  // It also means they are NOT the ids `fakeDustDb` hands out for the replay stream, which are the
  // fixture's own indices — the committed roots were recorded over all 5 000 events, so the mirror
  // suites fold all 5 000. Nothing compares the two spaces, and each is right about its own thing.
  for (const [index, raw] of events.entries()) {
    for (const record of mapOne(index, raw)) records.push({ id: BigInt(records.length + 1), record });
  }

  // The latest dtime per generation entry — the merge `db.ts` expresses as a lateral join.
  const latestDtime = new Map<string, number | null>();
  for (const { record } of records) {
    if (record.kind === 2 && record.generationIndex !== undefined) {
      latestDtime.set(record.generationIndex.toString(10), record.dtime ?? null);
    }
  }

  const initialUtxos: DustInitialUtxoRow[] = [];
  const generation: DustGenerationRow[] = [];
  const spends: DustSpendRow[] = [];
  const ownerCounts = new Map<string, number>();

  for (const { id, record } of records) {
    const payload = record.payload as { output?: Record<string, unknown>; generation?: Record<string, unknown> };
    const txHash = new Uint8Array(Buffer.from(record.txHash, "hex"));
    if (record.kind === 1) {
      const key = record.generationIndex!.toString(10);
      const merged = { ...(payload.generation ?? {}) };
      if (latestDtime.has(key)) merged.dtime = latestDtime.get(key)!;
      initialUtxos.push({
        id,
        blockHeight: BigInt(record.blockHeight),
        txHash,
        generationIndex: record.generationIndex!,
        output: payload.output ?? {},
        generation: merged,
      });
      generation.push({
        generationIndex: record.generationIndex!,
        value: String(merged.value ?? "0"),
        owner: String(merged.owner ?? "0"),
        nonce: String(merged.nonce ?? ""),
        dtime: merged.dtime === undefined || merged.dtime === null ? null : Number(merged.dtime),
      });
      const owner = String(record.owner);
      ownerCounts.set(owner, (ownerCounts.get(owner) ?? 0) + 1);
      continue;
    }
    if (record.kind === 3) {
      spends.push({
        id,
        blockHeight: BigInt(record.blockHeight),
        txHash,
        nullifier: record.nullifier!,
        commitment: record.commitment!,
        commitmentIndex: record.commitmentIndex!,
        vFee: record.vFee!,
        declaredTime: BigInt(record.declaredTime!),
        blockTime: BigInt(record.blockTime),
      });
    }
  }

  generation.sort((a, b) => (a.generationIndex < b.generationIndex ? -1 : a.generationIndex > b.generationIndex ? 1 : 0));
  const busiestOwner = [...ownerCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "0";
  return { initialUtxos, generation, spends, busiestOwner, records };
}
