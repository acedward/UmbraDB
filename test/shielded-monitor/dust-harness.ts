import type {
  DustCheckpointProbe,
  DustDb,
  DustGenerationRow,
  DustInitialUtxoRow,
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
  readonly checkpoint?: DustCheckpointProbe;
}

export interface FakeDustDb extends DustDb {
  calls: number;
  tipCalls: number;
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
    async selectLatestCheckpoint(_net) {
      return options.checkpoint ?? { status: "unavailable", reason: "42501" };
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
