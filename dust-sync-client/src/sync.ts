import {
  MAX_NULLIFIERS_PER_REQUEST,
  MAX_RANGES_PER_REQUEST,
  bytesFromHex,
  chunk,
  dateFromSeconds,
  gapRanges,
  generationFromWire,
  qdoFromWire,
  rangesParam,
  toBigInt,
  type Range,
} from "./encode.js";
import { DustSyncError, asNonLinear } from "./errors.js";
import { DustHttpClient, delay } from "./http.js";
import {
  assertLedgerSurface,
  type DustGenerationValue,
  type DustLocalStateLike,
  type DustQdo,
  type DustSecretKeyLike,
  type LedgerLike,
} from "./ledger.js";
import type {
  DustGenerationItem,
  DustGenerationResponse,
  DustInitialUtxoItem,
  DustInitialUtxosResponse,
  DustLookupResponse,
  DustSegmentsResponse,
  DustSyncStats,
  DustSyncTiming,
  DustTipResponse,
} from "./types.js";

/**
 * `syncDust` — `spec/00016-dust-wallet-sync.md` §5.5, Story 4, FR-030.
 *
 * Builds a spend-ready `DustLocalState` for one DUST secret key from the shielded-monitor node's
 * public DUST routes, in seconds rather than the SDK's two hours, and PROVES it: the two Merkle
 * roots it computes locally must equal the roots the node reports for one mirror tip, or no state
 * is returned at all.
 *
 * ── The shape of the algorithm, and why it is in this order ──────────────────────────────────
 * 1. **tip** — the DUST parameters, so the local state is constructed with the chain's.
 * 2. **the wallet's own rows** — its initial UTxOs and its generation entries, by DUST public key.
 * 3. **the GENERATION tree first.** Not an optimisation: `successorUtxo` looks the spent UTxO's
 *    `backingNight` up in `night_indices`, which only `insertGenerationInfo(…, initialNonce)`
 *    fills (`ledger/src/dust.rs` 1499 and 1549). Step 5 cannot run before this.
 * 4/5. **follow the spend chains.** A DUST UTxO carries no ciphertext; its successor's nonce is
 *    `hash(backingNight, seq+1, sk)` and its value depends on the fee, so a successor can only be
 *    computed AFTER its predecessor's spend row is known. One round trip per generation of the
 *    chain, which is why `timing.rounds` is the number of fee spends plus one.
 * 6. **the COMMITMENT tree**, once the node's trees have caught up with every row its table
 *    already showed us: a commitment that is in the table but not yet in the mirror would be an
 *    own leaf past the tree's end (`NonLinearInsertion`).
 * 7/8. **converge** — bring BOTH trees to one mirror tip and compare both roots there. A state
 *    whose two trees sit at different chain positions is not a snapshot of anything, and
 *    `walletBalance` would price a UTxO from one position with a generation entry from another.
 * 9. **confirm** — ask once more whether the live UTxOs are still unspent. Lookups read the
 *    table, which is never behind the trees, so one confirming round settles it.
 *
 * ── Fetch-then-apply, everywhere ────────────────────────────────────────────────────────────
 * §5.5 step 7 says: if the mirror advanced between the tip read and the segments response,
 * request the trailing range and apply it. This implementation detects the same condition one
 * step earlier — a segments response reports its own `firstFree`, so a mismatch with the tip's is
 * visible BEFORE anything is applied — and re-fetches instead, on the same budget of three
 * attempts. Every phase fetches everything it needs, checks the pieces agree on one `atEventId`,
 * and only then touches the WASM; a tree cannot be un-inserted, so a half-applied phase would
 * have to be thrown away anyway.
 *
 * ── Restarts ────────────────────────────────────────────────────────────────────────────────
 * When the chain moves under the client in a way that invalidates work already applied — a new
 * initial UTxO for this wallet, or a live UTxO spent while the state was being built — the whole
 * of steps 2–9 runs again on a fresh state, at most `maxRestarts` times (3, spec §5.5). Re-walking
 * a 100-spend chain costs 100 round trips of a few milliseconds each; a partially rebuilt tree
 * that nobody can un-insert costs correctness.
 *
 * ── Custody (SC-006) ────────────────────────────────────────────────────────────────────────
 * The secret key reaches exactly two ledger calls — `dustNullifier` and `successorUtxo` — and is
 * never serialized, logged or returned. Nullifiers go to the node (the leak the owner accepted,
 * Q-2) and are never logged here. `logger`, when given, receives phase lines carrying counts,
 * event ids and milliseconds only.
 */

export interface DustSyncOptions {
  /** The loaded `@midnight-ntwrk/ledger-v8` module — see `ledger.ts` for why it is injected. */
  readonly ledger: LedgerLike;
  /** The wallet's DUST secret key. Never leaves this process. */
  readonly secretKey: DustSecretKeyLike;
  /** Balancer base URL. */
  readonly baseUrl: string;
  readonly net: string;
  /** Client-side delay before every request (spec §7's simulated RTT). */
  readonly rttDelayMs?: number;
  /** Page size for `initial-utxos` / `generation` (≤ 1 000, the node's cap). */
  readonly pageLimit?: number;
  /** How long step 6 may wait for the mirror to catch up with the table (FR-030: 60 s). */
  readonly maxLagMs?: number;
  /** How many times the whole build may restart because the chain moved (§5.5 7–9: 3). */
  readonly maxRestarts?: number;
  /**
   * Prune worthless UTxOs at this instant, exactly as the SDK does — see the note in the body.
   * Omitted, the state keeps every UTxO the chain ever gave this wallet, including ones whose
   * value is permanently 0.
   */
  readonly processTtlsAt?: Date;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** Injected in tests so a lag wait does not cost wall-clock seconds. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Phase lines: counts and milliseconds, never a key or a nullifier. */
  readonly logger?: (line: string) => void;
}

export interface DustSyncResult {
  /** The caller owns it, including calling `free()` on it. */
  readonly state: DustLocalStateLike;
  readonly timing: DustSyncTiming;
  readonly stats: DustSyncStats;
  /** The mirror tip both roots were proved against. */
  readonly provedAt: { readonly atEventId: string; readonly atHeight: string };
  /** The proved roots, as decimal strings; `null` for a tree with no leaves. */
  readonly roots: { readonly commitment: string | null; readonly generation: string | null };
}

const nowMs = (): number => Number(process.hrtime.bigint()) / 1e6;
const compareBigInt = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

interface FrontierEntry {
  readonly qdo: DustQdo;
  readonly nullifier: bigint;
}

/** Everything one tree needs, fetched at ONE mirror tip and applied to nothing yet. */
interface TreeFill {
  readonly tree: Tree;
  readonly atEventId: string;
  readonly atHeight: string;
  readonly firstFree: bigint;
  readonly root: string | null;
  readonly segments: readonly { readonly range: Range; readonly update: Uint8Array }[];
}

type Tree = "commitment" | "generation";

export async function syncDust(options: DustSyncOptions): Promise<DustSyncResult> {
  const { ledger } = options;
  assertLedgerSurface(ledger);
  const sk = options.secretKey;
  const net = options.net;
  const pageLimit = options.pageLimit ?? 1_000;
  const maxLagMs = options.maxLagMs ?? 60_000;
  const maxRestarts = options.maxRestarts ?? 3;
  const sleep = options.sleep ?? delay;
  const log = options.logger ?? ((): void => undefined);
  const http = new DustHttpClient({
    baseUrl: options.baseUrl,
    ...(options.rttDelayMs === undefined ? {} : { rttDelayMs: options.rttDelayMs }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });

  const owner = sk.publicKey.toString(10);
  const t0 = nowMs();
  let restarts = 0;
  let rounds = 0;
  let spendsFollowed = 0;
  let segmentsC = 0;
  let segmentsG = 0;
  const timing = { tipMs: 0, initialMs: 0, generationMs: 0, chainMs: 0, commitmentMs: 0, consistencyMs: 0 };

  let state: DustLocalStateLike | undefined;
  /** Replaces the state and frees the one it supersedes: every `DustLocalState` method returns a
   *  NEW handle, and wasm-bindgen handles are not collected promptly (Phase 2's D2.5b). */
  const swap = (next: DustLocalStateLike): void => {
    const previous = state;
    state = next;
    if (previous !== undefined) previous.free();
  };
  const requireState = (): DustLocalStateLike => {
    /* c8 ignore next */
    if (state === undefined) throw new DustSyncError("DUST_SYNC_INVALID_INPUT", "no state");
    return state;
  };
  const dropState = (): void => {
    state?.free();
    state = undefined;
  };

  /** Spends one unit of the restart budget, or throws FR-030's give-up. */
  const spendRestartBudget = (why: string): void => {
    restarts += 1;
    if (restarts > maxRestarts) {
      throw new DustSyncError("DUST_SYNC_RESTART_LIMIT", `gave up after ${maxRestarts} restart(s): ${why}`, {
        restarts,
      });
    }
    log(`restart ${restarts}/${maxRestarts}: ${why}`);
  };

  // ── step 1: the tip, and the parameters the local state is constructed with ────────────────
  const tipStart = nowMs();
  const firstTip = await http.get<DustTipResponse>("tip", { net });
  timing.tipMs = nowMs() - tipStart;
  const params = new ledger.DustParameters(
    toBigInt(firstTip.params.nightDustRatio, "params.nightDustRatio"),
    toBigInt(firstTip.params.generationDecayRate, "params.generationDecayRate"),
    toBigInt(firstTip.params.dustGracePeriodSeconds, "params.dustGracePeriodSeconds"),
  );
  log(`tip atEventId=${firstTip.atEventId} height=${firstTip.atHeight} in ${timing.tipMs.toFixed(1)} ms`);

  try {
    for (;;) {
      dropState();
      state = new ledger.DustLocalState(params);

      // ── step 2: the wallet's own rows ────────────────────────────────────────────────────
      const initialStart = nowMs();
      const initial = await fetchInitialUtxos();
      const generation = await fetchGeneration();
      timing.initialMs += nowMs() - initialStart;
      log(`own rows: ${initial.length} initial UTxO(s), ${generation.length} generation entr(ies)`);

      /** The highest event id of anything the TABLE has already shown us. The mirror's trees must
       *  reach it before an own leaf can be inserted — step 6's wait condition. The spec writes it
       *  as the highest SPEND event id; an initial UTxO's own row can equally be ahead of the
       *  mirror (`initial-utxos` reads the table too) and its leaf is just as unusable until the
       *  trees catch up, so both are tracked. */
      let maxRelevantEventId = initial.reduce(
        (max, item) => maxBigInt(max, toBigInt(item.eventId, "initial.eventId")),
        0n,
      );

      // ── step 3: the generation tree ──────────────────────────────────────────────────────
      const generationStart = nowMs();
      const ownGeneration = new Map<bigint, DustGenerationValue>();
      for (const entry of generation) {
        ownGeneration.set(
          toBigInt(entry.generationIndex, "generation.generationIndex"),
          generationFromWire(entry),
        );
      }
      const generationIndices = [...ownGeneration.keys()].sort(compareBigInt);
      const generationFill = await fetchTree("generation", generationIndices);
      applyTree("generation", generationFill, generationIndices, (index) => {
        const entry = ownGeneration.get(index);
        /* c8 ignore next */
        if (entry === undefined) throw new DustSyncError("DUST_SYNC_INVALID_INPUT", "missing generation entry");
        // `initialNonce` is what puts the entry into `night_indices`; without it `successorUtxo`
        // cannot find the backing NIGHT and `walletBalance` counts the UTxO as nothing.
        return (current) => current.insertGenerationInfo(index, entry, entry.nonce);
      });
      segmentsG += generationFill.segments.length;
      assertRoot("generation", generationFill);
      let localGenerationFirstFree = generationFill.firstFree;
      timing.generationMs += nowMs() - generationStart;
      log(
        `generation tree: ${generationIndices.length} own, ${generationFill.segments.length} segment(s), ` +
          `root ok at atEventId=${generationFill.atEventId}`,
      );

      // ── steps 4 and 5: the frontier, and following it ────────────────────────────────────
      const chainStart = nowMs();
      const frontier: FrontierEntry[] = initial.map((item) => {
        const qdo = qdoFromWire(item.output);
        return { qdo, nullifier: ledger.dustNullifier(qdo, sk) };
      });
      const followed = await follow(frontier, maxRelevantEventId);
      const live = followed.live;
      maxRelevantEventId = followed.maxRelevantEventId;
      timing.chainMs += nowMs() - chainStart;
      log(`chain: ${rounds} round(s), ${spendsFollowed} spend(s) followed, ${live.length} live UTxO(s)`);

      // ── step 6: the commitment tree ──────────────────────────────────────────────────────
      const commitmentStart = nowMs();
      const byIndex = new Map<bigint, FrontierEntry>();
      for (const entry of live) byIndex.set(entry.qdo.mtIndex, entry);
      const liveIndices = [...byIndex.keys()].sort(compareBigInt);
      const commitmentFill = await fetchTree("commitment", liveIndices, maxRelevantEventId);
      applyTree("commitment", commitmentFill, liveIndices, (index) => {
        const entry = byIndex.get(index);
        /* c8 ignore next */
        if (entry === undefined) throw new DustSyncError("DUST_SYNC_INVALID_INPUT", "missing live UTxO");
        // `own_qdo = true`: a wallet keeps its own leaf uncollapsed, which is what lets it prove
        // membership when it spends (spec §5.5 step 6).
        return (current) => current.insertCommitment(index, entry.qdo, true);
      });
      segmentsC += commitmentFill.segments.length;
      assertRoot("commitment", commitmentFill);
      for (const entry of live) swap(requireState().addUtxo(entry.nullifier, entry.qdo, null));
      let localCommitmentFirstFree = commitmentFill.firstFree;
      timing.commitmentMs += nowMs() - commitmentStart;
      log(
        `commitment tree: ${liveIndices.length} own, ${commitmentFill.segments.length} segment(s), ` +
          `root ok at atEventId=${commitmentFill.atEventId}`,
      );

      // ── steps 7–9: converge both trees onto one tip, then confirm ────────────────────────
      const consistencyStart = nowMs();
      const converged = await converge(initial, localCommitmentFirstFree, localGenerationFirstFree);
      if (converged === "restart") {
        timing.consistencyMs += nowMs() - consistencyStart;
        continue;
      }
      localCommitmentFirstFree = converged.commitmentFirstFree;
      localGenerationFirstFree = converged.generationFirstFree;

      // Step 9. NOT counted as a `round`: `timing.rounds` is the spend chain's own depth, which
      // Story 4 scenario 1 pins at "spends + 1", and a confirmation is not a generation of it.
      // It is counted in `stats.requests` like every other request.
      const confirmed = await lookup(live.map((entry) => entry.nullifier));
      const spentMeanwhile = confirmed.results.filter((result) => result.spend !== null).length;
      timing.consistencyMs += nowMs() - consistencyStart;
      if (spentMeanwhile > 0) {
        spendRestartBudget(`${spentMeanwhile} live UTxO(s) were spent while the state was being built`);
        continue;
      }

      /**
       * ── The SDK's own last step, which §5.5 does not mention ─────────────────────────────
       * `CoreWallet.applyEventsWithChanges` passes a timestamp, and the ledger's
       * `process_ttls(time)` DROPS every UTxO whose updated value is 0 at that time
       * (`ledger/src/dust.rs` 1938–1959). A DUST UTxO reaches 0 as soon as its backing NIGHT is
       * spent and its decay finishes — which on this workload is most of them, because a transfer
       * spends the NIGHT that backs the DUST it paid with.
       *
       * Measured on the devnet golden run (2026-09-15, wallet W100, 100 self-transfers): the SDK's
       * own state held **2** UTxOs and this client's held **107**, of which **105 had value 0** —
       * with IDENTICAL commitment and generation roots and an IDENTICAL `walletBalance`. The
       * difference was entirely worthless entries the SDK had pruned and this client had not. So
       * a client that wants to hand a wallet the state the SDK would have built must prune too,
       * and `processTtls` is a standard 8.1.0 member (it is in the published declarations).
       *
       * It touches only `dust_utxos`, never the trees, so it runs AFTER both roots are proved and
       * cannot invalidate them.
       */
      if (options.processTtlsAt !== undefined) {
        const before = requireState().utxos.length;
        swap(requireState().processTtls(options.processTtlsAt));
        const after = requireState().utxos.length;
        if (after !== before) log(`processTtls dropped ${before - after} worthless UTxO(s) of ${before}`);
      }

      // ── step 10: the result ──────────────────────────────────────────────────────────────
      const finalState = requireState();
      state = undefined; // handed to the caller, who owns `free()`
      const totalMs = nowMs() - t0;
      const result: DustSyncResult = {
        state: finalState,
        timing: { ...timing, rounds, totalMs } satisfies DustSyncTiming,
        stats: {
          initialUtxos: initial.length,
          spendsFollowed,
          liveUtxos: live.length,
          segmentsC,
          segmentsG,
          requests: http.requests,
          bytesIn: http.bytesIn,
          atEventId: converged.atEventId,
          atHeight: converged.atHeight,
          restarts,
        },
        provedAt: { atEventId: converged.atEventId, atHeight: converged.atHeight },
        roots: { commitment: converged.commitmentRoot, generation: converged.generationRoot },
      };
      log(`done in ${totalMs.toFixed(1)} ms, ${http.requests} request(s), ${http.bytesIn} byte(s) in`);
      return result;
    }
  } catch (error) {
    dropState();
    throw error;
  }

  // ── helpers, closed over the state and the counters ─────────────────────────────────────────

  async function fetchInitialUtxos(): Promise<DustInitialUtxoItem[]> {
    const items: DustInitialUtxoItem[] = [];
    let afterId: string | null = "0";
    while (afterId !== null) {
      const page: DustInitialUtxosResponse = await http.get<DustInitialUtxosResponse>("initial-utxos", {
        net,
        owner,
        afterId,
        limit: String(pageLimit),
      });
      items.push(...page.items);
      afterId = page.nextAfterId;
    }
    return items;
  }

  async function fetchGeneration(): Promise<DustGenerationItem[]> {
    const items: DustGenerationItem[] = [];
    let afterIndex: string | null = "0";
    while (afterIndex !== null) {
      const page: DustGenerationResponse = await http.get<DustGenerationResponse>("generation", {
        net,
        owner,
        afterIndex,
        limit: String(pageLimit),
      });
      items.push(...page.items);
      afterIndex = page.nextAfterIndex;
    }
    return items;
  }

  /**
   * Everything needed to fill one tree, at ONE mirror tip, with nothing applied yet.
   *
   * `minEventId` is step 6's wait condition: the mirror must have folded every row the table
   * already showed. It waits up to `maxLagMs` and then reports `DUST_SYNC_INDEX_LAG` (FR-030).
   */
  async function fetchTree(tree: Tree, ownIndices: readonly bigint[], minEventId = 0n): Promise<TreeFill> {
    const waitUntil = nowMs() + maxLagMs;
    for (let attempt = 0; ; attempt += 1) {
      const tip = await http.get<DustTipResponse>("tip", { net });
      if (toBigInt(tip.atEventId, "tip.atEventId") < minEventId) {
        if (nowMs() > waitUntil) {
          throw new DustSyncError(
            "DUST_SYNC_INDEX_LAG",
            "the node's DUST trees stayed behind rows its own table already returned",
            { atEventId: tip.atEventId, needed: minEventId.toString(10) },
          );
        }
        log(`the mirror is at ${tip.atEventId}, waiting for ${minEventId.toString(10)}`);
        await sleep(1_000);
        continue;
      }
      const firstFree = toBigInt(
        tree === "commitment" ? tip.commitmentFirstFree : tip.generationFirstFree,
        "tip.firstFree",
      );
      const tipRoot = tree === "commitment" ? tip.commitmentRoot : tip.generationRoot;
      const ranges = gapRanges(ownIndices, firstFree);
      if (ranges.length === 0) {
        // Every leaf of the tree is one of ours, or the tree is empty. Nothing to cut, so the
        // tip's own root is what the rebuilt tree is compared against.
        return { tree, atEventId: tip.atEventId, atHeight: tip.atHeight, firstFree, root: tipRoot, segments: [] };
      }
      const segments: { range: Range; update: Uint8Array }[] = [];
      let last: DustSegmentsResponse | undefined;
      let straddled = false;
      for (const part of chunk(ranges, MAX_RANGES_PER_REQUEST)) {
        const response = await http.get<DustSegmentsResponse>("segments", { net, tree, ranges: rangesParam(part) });
        if (last !== undefined && response.atEventId !== last.atEventId) {
          // Two requests of one phase landed on different mirror tips — the balancer may even
          // have sent them to different nodes. Nothing is applied; re-fetch the whole phase.
          straddled = true;
          break;
        }
        if (response.segments.length !== part.length) {
          throw new DustSyncError("DUST_SYNC_HTTP", "segments returned a different number of ranges", { tree });
        }
        for (const [index, segment] of response.segments.entries()) {
          const requested = part[index];
          /* c8 ignore next */
          if (requested === undefined) continue;
          if (segment.start !== requested.start.toString(10) || segment.end !== requested.end.toString(10)) {
            throw new DustSyncError("DUST_SYNC_HTTP", "segments came back in a different order than requested", {
              tree,
            });
          }
          segments.push({ range: requested, update: bytesFromHex(segment.update, "segments.update") });
        }
        last = response;
      }
      if (!straddled && last !== undefined && toBigInt(last.firstFree, "segments.firstFree") === firstFree) {
        return {
          tree,
          atEventId: last.atEventId,
          atHeight: last.atHeight,
          firstFree,
          root: last.root,
          segments,
        };
      }
      // The mirror advanced between the tip read and the cuts (spec §5.5 step 7).
      if (attempt >= maxRestarts) {
        throw new DustSyncError(
          "DUST_SYNC_RESTART_LIMIT",
          `the node's ${tree} tree advanced under every attempt to cut it`,
          { tree, attempts: attempt + 1 },
        );
      }
      log(`the ${tree} tree advanced while its segments were being cut; re-fetching`);
    }
  }

  /**
   * Walks a filled tree ascending: a collapsed update per gap, the caller's own insert per own
   * index. The ledger insists on strict linearity, so this order IS the correctness.
   */
  function applyTree(
    tree: Tree,
    fill: TreeFill,
    ownIndices: readonly bigint[],
    ownInsert: (index: bigint) => (current: DustLocalStateLike) => DustLocalStateLike,
  ): void {
    const gaps = fill.segments;
    let gapIndex = 0;
    let next = 0n;
    for (const index of ownIndices) {
      while (next < index) {
        const gap = gaps[gapIndex];
        /* c8 ignore next */
        if (gap === undefined) throw new DustSyncError("DUST_SYNC_HTTP", `missing a ${tree} segment`, { tree });
        applyUpdate(tree, gap.update, `${tree} [${gap.range.start}-${gap.range.end}]`);
        next = gap.range.end + 1n;
        gapIndex += 1;
      }
      try {
        swap(ownInsert(index)(requireState()));
      } catch (error) {
        throw asNonLinear(error, `${tree} index ${index.toString(10)}`);
      }
      next = index + 1n;
    }
    for (; gapIndex < gaps.length; gapIndex += 1) {
      const gap = gaps[gapIndex];
      /* c8 ignore next */
      if (gap === undefined) continue;
      applyUpdate(tree, gap.update, `${tree} [${gap.range.start}-${gap.range.end}]`);
    }
  }

  function applyUpdate(tree: Tree, raw: Uint8Array, where: string): void {
    const current = requireState();
    const update = ledger.DustStateMerkleTreeCollapsedUpdate.deserialize(raw);
    try {
      swap(
        tree === "commitment"
          ? current.applyCommitmentCollapsedUpdate(update)
          : current.applyGenerationCollapsedUpdate(update),
      );
    } catch (error) {
      throw asNonLinear(error, where);
    } finally {
      // A collapsed update is a WASM handle; a 256-segment response would otherwise hold 256
      // collapsed subtrees alive until a collection this process cannot schedule.
      update.free();
    }
  }

  /**
   * FR-030's hard stop: a root that does not match means the Merkle paths are wrong, so no state
   * is returned. An empty tree (`firstFree = 0`, devnet at genesis) reports `root: null` and is
   * treated as equal — there is no leaf to be wrong about.
   */
  function assertRoot(tree: Tree, fill: TreeFill): void {
    if (fill.firstFree === 0n) return;
    const current = requireState();
    const local = String(tree === "commitment" ? current.commitmentTreeRoot() : current.generatingTreeRoot());
    if (fill.root === null || local !== fill.root) {
      throw new DustSyncError("DUST_SYNC_ROOT_MISMATCH", `the rebuilt ${tree} tree has a different root`, {
        tree,
        atEventId: fill.atEventId,
      });
    }
  }

  async function lookup(nullifiers: readonly bigint[]): Promise<DustLookupResponse> {
    if (nullifiers.length === 0) {
      // The node refuses an empty list (FR-015), and a wallet with no live UTxOs has nothing to
      // confirm. Answer it here rather than sending a request that must be refused.
      return { indexHeight: "0", indexEventId: "0", results: [] };
    }
    const results: DustLookupResponse["results"][number][] = [];
    let last: DustLookupResponse | undefined;
    for (const part of chunk([...nullifiers], MAX_NULLIFIERS_PER_REQUEST)) {
      const response = await http.post<DustLookupResponse>("lookup", {
        net,
        nullifiers: part.map((nullifier) => nullifier.toString(10)),
      });
      if (response.results.length !== part.length) {
        throw new DustSyncError("DUST_SYNC_HTTP", "lookup answered a different number of results");
      }
      for (const [index, result] of response.results.entries()) {
        const asked = part[index];
        /* c8 ignore next */
        if (asked === undefined) continue;
        if (result.nullifier !== asked.toString(10)) {
          throw new DustSyncError("DUST_SYNC_HTTP", "lookup answered out of request order");
        }
        results.push(result);
      }
      last = response;
    }
    /* c8 ignore next */
    if (last === undefined) throw new DustSyncError("DUST_SYNC_HTTP", "lookup answered nothing");
    return { indexHeight: last.indexHeight, indexEventId: last.indexEventId, results };
  }

  /** §5.5 step 5: one round per generation of the spend chain. */
  async function follow(
    start: readonly FrontierEntry[],
    startMaxEventId: bigint,
  ): Promise<{ live: FrontierEntry[]; maxRelevantEventId: bigint }> {
    let frontier = [...start];
    const live: FrontierEntry[] = [];
    let maxRelevantEventId = startMaxEventId;
    while (frontier.length > 0) {
      const next: FrontierEntry[] = [];
      const response = await lookup(frontier.map((entry) => entry.nullifier));
      rounds += 1;
      for (const [index, result] of response.results.entries()) {
        const entry = frontier[index];
        /* c8 ignore next */
        if (entry === undefined) continue;
        if (result.spend === null) {
          live.push(entry);
          continue;
        }
        spendsFollowed += 1;
        const spend = result.spend;
        maxRelevantEventId = maxBigInt(maxRelevantEventId, toBigInt(spend.eventId, "spend.eventId"));
        let successor: DustQdo;
        try {
          successor = requireState().successorUtxo(
            entry.qdo,
            dateFromSeconds(spend.declaredTime, "spend.declaredTime"),
            toBigInt(spend.vFee, "spend.vFee"),
            toBigInt(spend.commitmentIndex, "spend.commitmentIndex"),
            sk,
          );
        } catch (error) {
          throw asNonLinear(error, `the successor of a spend at event ${spend.eventId}`);
        }
        next.push({ qdo: successor, nullifier: ledger.dustNullifier(successor, sk) });
      }
      frontier = next;
    }
    return { live, maxRelevantEventId };
  }

  /**
   * §5.5 steps 7–8, generalised: bring BOTH trees to one mirror tip and compare both roots there.
   *
   * The trailing ranges are pure gaps — every own leaf is already in — UNLESS a new initial UTxO
   * arrived for this wallet, which is checked first and restarts from step 2 (the spec's own
   * instruction), or one of our live UTxOs was spent, which step 9 catches straight afterwards.
   */
  async function converge(
    initial: readonly DustInitialUtxoItem[],
    commitmentFirstFreeLocal: bigint,
    generationFirstFreeLocal: bigint,
  ): Promise<
    | "restart"
    | {
        atEventId: string;
        atHeight: string;
        commitmentRoot: string | null;
        generationRoot: string | null;
        commitmentFirstFree: bigint;
        generationFirstFree: bigint;
      }
  > {
    const lastSeenId = initial.reduce(
      (max, item) => maxBigInt(max, toBigInt(item.eventId, "initial.eventId")),
      0n,
    );
    const fresh = await http.get<DustInitialUtxosResponse>("initial-utxos", {
      net,
      owner,
      afterId: lastSeenId.toString(10),
      limit: "1",
    });
    if (fresh.items.length > 0) {
      spendRestartBudget("a new initial UTxO arrived for this wallet while the state was being built");
      return "restart";
    }

    let commitmentLocal = commitmentFirstFreeLocal;
    let generationLocal = generationFirstFreeLocal;
    for (let attempt = 0; ; attempt += 1) {
      const tip = await http.get<DustTipResponse>("tip", { net });
      const commitmentFirstFree = toBigInt(tip.commitmentFirstFree, "tip.commitmentFirstFree");
      const generationFirstFree = toBigInt(tip.generationFirstFree, "tip.generationFirstFree");
      const wanted: { tree: Tree; from: bigint; to: bigint }[] = [];
      if (commitmentFirstFree > commitmentLocal) {
        wanted.push({ tree: "commitment", from: commitmentLocal, to: commitmentFirstFree - 1n });
      }
      if (generationFirstFree > generationLocal) {
        wanted.push({ tree: "generation", from: generationLocal, to: generationFirstFree - 1n });
      }
      const fetched: { tree: Tree; raw: Uint8Array }[] = [];
      let straddled = false;
      for (const item of wanted) {
        const response = await http.get<DustSegmentsResponse>("segments", {
          net,
          tree: item.tree,
          ranges: `${item.from.toString(10)}-${item.to.toString(10)}`,
        });
        if (response.atEventId !== tip.atEventId) {
          straddled = true;
          break;
        }
        const segment = response.segments[0];
        /* c8 ignore next */
        if (segment === undefined) throw new DustSyncError("DUST_SYNC_HTTP", "segments returned nothing");
        fetched.push({ tree: item.tree, raw: bytesFromHex(segment.update, "segments.update") });
      }
      if (straddled) {
        if (attempt >= maxRestarts) {
          throw new DustSyncError("DUST_SYNC_RESTART_LIMIT", "the mirror advanced under every convergence attempt");
        }
        log("the mirror advanced while the trees were being converged; re-fetching");
        continue;
      }
      for (const item of fetched) {
        applyUpdate(item.tree, item.raw, `${item.tree} trailing range`);
        if (item.tree === "commitment") {
          commitmentLocal = commitmentFirstFree;
          segmentsC += 1;
        } else {
          generationLocal = generationFirstFree;
          segmentsG += 1;
        }
      }
      const proved = requireState();
      const commitmentRoot = commitmentFirstFree === 0n ? null : String(proved.commitmentTreeRoot());
      const generationRoot = generationFirstFree === 0n ? null : String(proved.generatingTreeRoot());
      if (commitmentRoot !== tip.commitmentRoot || generationRoot !== tip.generationRoot) {
        throw new DustSyncError("DUST_SYNC_ROOT_MISMATCH", "the converged trees do not match the node's roots", {
          atEventId: tip.atEventId,
        });
      }
      return {
        atEventId: tip.atEventId,
        atHeight: tip.atHeight,
        commitmentRoot,
        generationRoot,
        commitmentFirstFree: commitmentLocal,
        generationFirstFree: generationLocal,
      };
    }
  }
}

function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
