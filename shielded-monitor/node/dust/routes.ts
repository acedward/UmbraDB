import type { DustDb, DustSpendRow } from "./db.js";
import type { DustMirrorLease, DustStateMirror } from "./mirror.js";
import {
  DustHttpError,
  assertRangesWithin,
  decimalOf,
  hexOf,
  optionalCursor,
  optionalLimit,
  parseLookupBody,
  parseRanges,
  requireDecimal,
  requireNet,
  requireTree,
} from "./wire.js";

/**
 * The five `/v1/dust/*` routes (`spec/00016-dust-wallet-sync.md` §4, §8, Stories 2 and 3;
 * FR-013…FR-016).
 *
 * ── Where each answer comes from, and why it matters that they differ ───────────────────────
 * `tip` and `segments` read the **mirror's trees**. `initial-utxos`, `generation` and `lookup`
 * read the **table**, which is normally AHEAD of the mirror — the ingest commits a block's events
 * before the mirror's next poll folds them.
 *
 * That gap is not hidden. Every response carries `atHeight`/`atEventId` (FR-013), which is always
 * the MIRROR's applied tip, never the table's. A wallet that gets a spend back from `lookup` at
 * event 1 490 233 while `indexEventId` says 1 489 000 can see that the commitment it now needs is
 * not in the trees yet and wait (spec §5.5 step 9). Reporting the table's tip instead would make
 * that check silently useless, which is the one failure this project cannot detect from roots.
 *
 * ── Custody (SC-006, owner Q-2) ─────────────────────────────────────────────────────────────
 * A nullifier reaches exactly one place: the bound array parameter of `selectSpendsByNullifiers`.
 * It is not logged (the access log takes the route PATTERN and a count, never the URL or a body),
 * not persisted, and not echoed into an error message — including the DATABASE's own error
 * message, which is why a driver fault here becomes a fixed `DUST_DB_UNAVAILABLE` string rather
 * than being passed through: postgres.js quotes bound parameters in some failures, and a bound
 * parameter on this route is the wallet's spend chain.
 */

/** The route names, which are also their path segments. */
export const DUST_ROUTE_NAMES = ["tip", "initial-utxos", "generation", "segments", "lookup"] as const;
export type DustRouteName = (typeof DUST_ROUTE_NAMES)[number];

/** What a DUST route answers with. `count` reaches the access log; the body reaches the client. */
export interface DustReply {
  readonly status: number;
  readonly body: unknown;
  /** Present on a refusal, so the access log carries the code without the message. */
  readonly errorCode?: string;
  /** Items returned, or nullifiers asked about — the one number FR-015 allows to be logged. */
  readonly count?: number;
}

export interface DustRoutesDeps {
  readonly db: DustDb;
  readonly mirror: DustStateMirror;
  /** The one network this node serves. A request naming another is refused rather than answered
   *  from the wrong trees. */
  readonly net: string;
}

/** The default page size when a caller does not ask (spec §4's samples use 100). */
const DEFAULT_PAGE = 100;

export function createDustRoutes(deps: DustRoutesDeps) {
  const { db, mirror, net: serverNet } = deps;

  function assertNet(net: string): void {
    if (net !== serverNet) {
      throw new DustHttpError(400, "DUST_BAD_PARAM", `this node serves net ${serverNet}`);
    }
  }

  /**
   * Takes the mirror's current trees for the duration of one request, after the two refusals that
   * must come first.
   *
   * `DUST_NO_PRODUCER` before `DUST_NOT_READY`, deliberately: "the ingest never captured anything"
   * is a deployment mistake an operator has to fix, while "not ready" invites a client to retry.
   * Reporting the permanent condition as the transient one would have every wallet retry forever.
   */
  function lease(): DustMirrorLease {
    if (mirror.producer === "none") {
      throw new DustHttpError(
        503,
        "DUST_NO_PRODUCER",
        "this archive holds no DUST events; the ingest that fills them runs with REPLAY_VALIDATION=1",
      );
    }
    if (!mirror.ready) {
      throw new DustHttpError(503, "DUST_NOT_READY", "the DUST mirror is still replaying");
    }
    const held = mirror.acquire();
    if (held === undefined) throw new DustHttpError(503, "DUST_NOT_READY", "the DUST mirror has not started");
    return held;
  }

  /**
   * Runs a database read and converts ANY fault into one fixed refusal.
   *
   * The driver's own message never reaches the client or the log. On `lookup` it can quote a bound
   * parameter, and a bound parameter there is a nullifier.
   */
  async function query<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch {
      throw new DustHttpError(503, "DUST_DB_UNAVAILABLE", "the archive database is unreachable");
    }
  }

  /** `atHeight`/`atEventId`: always the MIRROR's tip (FR-013). */
  function at(held: DustMirrorLease): { atHeight: string; atEventId: string } {
    return {
      atHeight: held.applied.height.toString(10),
      atEventId: held.applied.eventId.toString(10),
    };
  }

  /** A tree's root, or `null` when it has no leaves (spec's `commitmentFirstFree = 0` edge case —
   *  devnet at genesis, where the empty root is a constant nobody should compare against). */
  function rootOrNull(value: unknown, firstFree: bigint): string | null {
    return firstFree === 0n ? null : String(value);
  }

  function spendView(row: DustSpendRow): Record<string, unknown> {
    return {
      eventId: row.id.toString(10),
      height: row.blockHeight.toString(10),
      txHash: hexOf(row.txHash),
      nullifier: decimalOf(row.nullifier),
      commitment: decimalOf(row.commitment),
      commitmentIndex: row.commitmentIndex.toString(10),
      vFee: decimalOf(row.vFee),
      declaredTime: Number(row.declaredTime),
      blockTime: Number(row.blockTime),
    };
  }

  async function tip(url: URL): Promise<DustReply> {
    assertNet(requireNet(url.searchParams));
    const held = lease();
    try {
      const commitmentFirstFree = BigInt(held.state.commitmentTreeFirstFree);
      const generationFirstFree = BigInt(held.state.generatingTreeFirstFree);
      // The ARCHIVE's row, not `held.state.params` (question Q-22 option C). Two reasons: the row
      // is the chain's own record of what it uses, written by the ingest from the ledger state it
      // was holding; and `state.params` is a wasm-bindgen getter that mints a handle on every
      // access, which this route leaked once per request. The mirror's state is CONSTRUCTED from
      // the same row, so the two agree by construction rather than by coincidence.
      const params = mirror.parameters;
      return {
        status: 200,
        body: {
          net: serverNet,
          ...at(held),
          commitmentFirstFree: commitmentFirstFree.toString(10),
          generationFirstFree: generationFirstFree.toString(10),
          commitmentRoot: rootOrNull(held.state.commitmentTreeRoot(), commitmentFirstFree),
          generationRoot: rootOrNull(held.state.generatingTreeRoot(), generationFirstFree),
          params: {
            nightDustRatio: decimalOf(params.nightDustRatio),
            generationDecayRate: decimalOf(params.generationDecayRate),
            dustGracePeriodSeconds: decimalOf(params.dustGracePeriodSeconds),
          },
        },
      };
    } finally {
      held.release();
    }
  }

  async function initialUtxos(url: URL): Promise<DustReply> {
    const net = requireNet(url.searchParams);
    assertNet(net);
    const owner = requireDecimal(url.searchParams, "owner");
    const afterId = optionalCursor(url.searchParams, "afterId");
    const limit = optionalLimit(url.searchParams, DEFAULT_PAGE);
    const held = lease();
    try {
      const rows = await query(async () => await db.selectInitialUtxosByOwner(net, owner, afterId, limit));
      const items = rows.map((row) => ({
        eventId: row.id.toString(10),
        height: row.blockHeight.toString(10),
        txHash: hexOf(row.txHash),
        output: row.output,
        generation: { ...row.generation, generationIndex: row.generationIndex.toString(10) },
      }));
      return {
        status: 200,
        count: items.length,
        body: {
          ...at(held),
          items,
          // `null` only when the page was short: a full page is assumed to have more behind it,
          // which costs the caller one empty request and never loses a row.
          nextAfterId: items.length === limit ? (rows[rows.length - 1]?.id.toString(10) ?? null) : null,
        },
      };
    } finally {
      held.release();
    }
  }

  async function generation(url: URL): Promise<DustReply> {
    const net = requireNet(url.searchParams);
    assertNet(net);
    const owner = requireDecimal(url.searchParams, "owner");
    const afterIndex = optionalCursor(url.searchParams, "afterIndex");
    const limit = optionalLimit(url.searchParams, DEFAULT_PAGE);
    const held = lease();
    try {
      const rows = await query(async () => await db.selectGenerationByOwner(net, owner, afterIndex, limit));
      const items = rows.map((row) => ({
        generationIndex: row.generationIndex.toString(10),
        value: row.value,
        owner: row.owner,
        nonce: row.nonce,
        dtime: row.dtime,
      }));
      return {
        status: 200,
        count: items.length,
        body: {
          ...at(held),
          items,
          nextAfterIndex:
            items.length === limit ? (rows[rows.length - 1]?.generationIndex.toString(10) ?? null) : null,
        },
      };
    } finally {
      held.release();
    }
  }

  async function segments(url: URL): Promise<DustReply> {
    assertNet(requireNet(url.searchParams));
    const tree = requireTree(url.searchParams);
    const ranges = parseRanges(url.searchParams.get("ranges"));
    const held = lease();
    try {
      // ONE immutable state reference for the whole response (FR-014). The lease is what makes
      // that true even when a batch lands mid-request: the mirror retires the reference, the last
      // reader frees it, and nothing under this handler changes.
      const firstFree = BigInt(
        tree === "commitment" ? held.state.commitmentTreeFirstFree : held.state.generatingTreeFirstFree,
      );
      assertRangesWithin(ranges, firstFree);
      const cut: { start: string; end: string; update: string }[] = [];
      for (const range of ranges) {
        const update =
          tree === "commitment"
            ? held.state.collapsedCommitmentUpdate(range.start, range.end)
            : held.state.collapsedGenerationUpdate(range.start, range.end);
        try {
          cut.push({
            start: range.start.toString(10),
            end: range.end.toString(10),
            update: Buffer.from(update.serialize() as Uint8Array).toString("hex"),
          });
        } finally {
          // Each update is a WASM handle. A 256-range request that leaked them would hold 256
          // collapsed subtrees until a garbage collection this process cannot schedule.
          update.free();
        }
      }
      const root =
        tree === "commitment"
          ? rootOrNull(held.state.commitmentTreeRoot(), firstFree)
          : rootOrNull(held.state.generatingTreeRoot(), firstFree);
      return {
        status: 200,
        count: cut.length,
        body: { ...at(held), tree, firstFree: firstFree.toString(10), root, segments: cut },
      };
    } finally {
      held.release();
    }
  }

  async function lookup(body: Buffer): Promise<DustReply> {
    const request = parseLookupBody(body);
    assertNet(request.net);
    const held = lease();
    try {
      const rows = await query(async () => await db.selectSpendsByNullifiers(request.net, request.nullifiers));
      // Lowest id wins if the table somehow held two rows for one nullifier: a nullifier can be
      // spent once, so the earlier row is the real one and a later duplicate would be a bug this
      // route should not amplify by reporting the newer.
      const byNullifier = new Map<string, DustSpendRow>();
      for (const row of rows) {
        const key = decimalOf(row.nullifier);
        const existing = byNullifier.get(key);
        if (existing === undefined || row.id < existing.id) byNullifier.set(key, row);
      }
      return {
        status: 200,
        count: request.nullifiers.length,
        body: {
          indexHeight: held.applied.height.toString(10),
          indexEventId: held.applied.eventId.toString(10),
          results: request.nullifiers.map((nullifier) => {
            const row = byNullifier.get(nullifier);
            return { nullifier, spend: row === undefined ? null : spendView(row) };
          }),
        },
      };
    } finally {
      held.release();
    }
  }

  return async function handle(route: DustRouteName, url: URL, body: Buffer): Promise<DustReply> {
    switch (route) {
      case "tip":
        return await tip(url);
      case "initial-utxos":
        return await initialUtxos(url);
      case "generation":
        return await generation(url);
      case "segments":
        return await segments(url);
      case "lookup":
        return await lookup(body);
    }
  };
}
