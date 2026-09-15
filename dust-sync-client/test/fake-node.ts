/* eslint-disable @typescript-eslint/no-explicit-any */
import { loadLedgerV8 } from "../../chain-archive-sync/tx-replay-decoder.js";

/**
 * A DUST chain and the node that serves it, built with the REAL ledger WASM.
 *
 * ── Why a real chain and not canned JSON ────────────────────────────────────────────────────
 * Everything this client does is Merkle arithmetic: cut a segment here, insert a leaf there,
 * compare a root. Canned responses would test the client's request shaping and nothing else —
 * the one property that matters (the rebuilt tree equals the chain's) would be asserted against
 * a string the test itself made up. So the fixture builds an actual `DustLocalState` the way the
 * chain builds one, cuts real collapsed updates out of it, and computes real successors and
 * nullifiers with the real key. If the client walks a tree in the wrong order or inserts the
 * wrong leaf, the root comparison fails here exactly as it would against a node.
 *
 * The state built here plays TWO roles at once, and can because both need the same thing:
 *   - the **mirror**: every leaf is inserted uncollapsed (`own_qdo = true`,
 *     `insertGenerationInfo` with the entry's nonce), which is what makes a tree cuttable — the
 *     same property the node's mirror gets from the fork's `replayRawEventsRetainingAll`;
 *   - the **chain oracle**: `successorUtxo` needs `night_indices`, which the generation inserts
 *     fill, so the successor QDOs here are the ones the chain would have produced.
 *
 * ── What it deliberately does NOT emulate ───────────────────────────────────────────────────
 * Paging (every page is answered in full), the 400s of §4 (`dust-wire.test.ts` in the node's own
 * suite owns those), and the mirror lagging the table — which the tests that need it inject with
 * {@link FakeDustNode.holdMirrorAt} rather than simulate.
 */

export interface FakeQdo {
  initialValue: bigint;
  owner: bigint;
  nonce: bigint;
  seq: number;
  ctime: Date;
  backingNight: string;
  mtIndex: bigint;
}

interface InitialRow {
  eventId: bigint;
  height: bigint;
  txHash: string;
  qdo: FakeQdo;
  generationIndex: bigint;
  generation: { value: bigint; owner: bigint; nonce: string; dtime: Date | undefined };
}

interface SpendRow {
  eventId: bigint;
  height: bigint;
  txHash: string;
  nullifier: bigint;
  commitment: bigint;
  commitmentIndex: bigint;
  vFee: bigint;
  declaredTime: number;
  blockTime: number;
}

/** A wallet whose chain the fixture follows. */
export interface FakeWallet {
  readonly sk: any;
  readonly publicKey: bigint;
}

const GENESIS_SECONDS = 1_757_000_000;

export class FakeChain {
  readonly initial: InitialRow[] = [];
  readonly spends: SpendRow[] = [];
  private commitmentNext = 0n;
  private generationNext = 0n;
  private eventId = 0n;
  /** Chain tips per wallet-owned initial UTxO, so a spend continues the right chain. */
  private readonly tips = new Map<string, FakeQdo>();
  state: any;

  constructor(
    readonly ledger: any,
    readonly params: any,
  ) {
    this.state = new ledger.DustLocalState(params);
  }

  get commitmentFirstFree(): bigint {
    return this.commitmentNext;
  }

  get generationFirstFree(): bigint {
    return this.generationNext;
  }

  get tableTipEventId(): bigint {
    return this.eventId;
  }

  private nextEvent(): { eventId: bigint; height: bigint; txHash: string } {
    this.eventId += 1n;
    return {
      eventId: this.eventId,
      height: 1_000n + this.eventId / 3n,
      txHash: this.eventId.toString(16).padStart(64, "0"),
    };
  }

  private swap(next: any): void {
    const previous = this.state;
    this.state = next;
    previous.free();
  }

  /** A `dustInitialUtxo`: one commitment leaf AND one generation entry, as the ledger emits it. */
  addInitialUtxo(wallet: FakeWallet, value: bigint, options: { dtime?: Date } = {}): InitialRow {
    const backingNight = (this.eventId + 1n).toString(16).padStart(64, "0");
    // A seq-0 nonce is `transient_hash(initial_nonce, 0, PUBLIC key)` (`ledger/src/dust.rs` 201),
    // and the WASM refuses `dustNonce(…, 0, sk)` for exactly that reason. No export computes it,
    // so the fixture uses an arbitrary field element, as the ledger's own Rust tests do
    // (`output_at`: `nonce: Fr::from(index + 7)`). Nothing here depends on the derivation: the
    // commitment and the nullifier are computed from the QDO by the ledger either way, and every
    // successor's nonce IS the real `dust_nonce(backing_night, seq+1, sk)`.
    const nonce = this.eventId * 1_000n + 7n;
    const qdo: FakeQdo = {
      initialValue: value,
      owner: wallet.publicKey,
      nonce,
      seq: 0,
      ctime: new Date(GENESIS_SECONDS * 1000),
      backingNight,
      mtIndex: this.commitmentNext,
    };
    const generation = {
      value,
      owner: wallet.publicKey,
      nonce: backingNight,
      dtime: options.dtime,
    };
    this.swap(this.state.insertCommitment(this.commitmentNext, qdo, true));
    this.swap(this.state.insertGenerationInfo(this.generationNext, generation, backingNight));
    const row: InitialRow = {
      ...this.nextEvent(),
      qdo,
      generationIndex: this.generationNext,
      generation,
    };
    this.commitmentNext += 1n;
    this.generationNext += 1n;
    this.initial.push(row);
    this.tips.set(backingNight, qdo);
    return row;
  }

  /** A `dustSpendProcessed`: the successor's commitment leaf, and the public spend row. */
  addSpend(wallet: FakeWallet, backingNight: string, vFee: bigint, atSeconds: number): SpendRow {
    const current = this.tips.get(backingNight);
    if (current === undefined) throw new Error("no chain tip for that backing NIGHT");
    const declared = new Date(atSeconds * 1000);
    const successor: FakeQdo = this.state.successorUtxo(
      current,
      declared,
      vFee,
      this.commitmentNext,
      wallet.sk,
    );
    const nullifier: bigint = this.ledger.dustNullifier(current, wallet.sk);
    const commitment: bigint = this.ledger.dustCommitment(successor);
    this.swap(this.state.insertCommitment(this.commitmentNext, successor, true));
    const row: SpendRow = {
      ...this.nextEvent(),
      nullifier,
      commitment,
      commitmentIndex: this.commitmentNext,
      vFee,
      declaredTime: atSeconds,
      blockTime: atSeconds + 2,
    };
    this.commitmentNext += 1n;
    this.spends.push(row);
    this.tips.set(backingNight, successor);
    return row;
  }

  /** The live UTxO of one chain, for a test's own expectations. */
  tipOf(backingNight: string): FakeQdo {
    const tip = this.tips.get(backingNight);
    if (tip === undefined) throw new Error("no chain tip for that backing NIGHT");
    return tip;
  }

  free(): void {
    this.state.free();
  }
}

export interface FakeNodeOptions {
  readonly net: string;
  /** Corrupt the nth segment of this tree, to prove the client refuses a wrong one. */
  readonly corruptSegment?: { tree: "commitment" | "generation"; index: number };
  /** Report this mirror tip instead of the table's, for the lag cases. */
  readonly mirrorEventId?: bigint;
}

/** Counts per route, so a test can assert the REQUEST PATTERN — "exactly 101 lookup rounds" is a
 *  claim about round trips, not about the answer. */
export interface FakeNodeCalls {
  tip: number;
  "initial-utxos": number;
  generation: number;
  segments: number;
  lookup: number;
  nullifiersAsked: number;
  maxNullifiersInOneRequest: number;
  maxRangesInOneRequest: number;
}

export class FakeDustNode {
  readonly calls: FakeNodeCalls = {
    tip: 0,
    "initial-utxos": 0,
    generation: 0,
    segments: 0,
    lookup: 0,
    nullifiersAsked: 0,
    maxNullifiersInOneRequest: 0,
    maxRangesInOneRequest: 0,
  };
  /** When set, `atEventId` is pinned here — the mirror "behind the table" of Story 3 scenario 1. */
  holdMirrorAt: bigint | undefined;
  /** Segments to answer wrongly (test double of Story 4 scenario 3). */
  corrupt: { tree: "commitment" | "generation"; index: number } | undefined;

  constructor(
    readonly chain: FakeChain,
    readonly options: FakeNodeOptions,
  ) {
    this.holdMirrorAt = options.mirrorEventId;
    this.corrupt = options.corruptSegment;
  }

  /** A `fetch` the client can be given. */
  get fetchImpl(): typeof fetch {
    return (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const route = url.pathname.replace(/^\/v1\/dust\//, "");
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      const answer = this.handle(route, url, body);
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  private at(): { atHeight: string; atEventId: string } {
    const eventId = this.holdMirrorAt ?? this.chain.tableTipEventId;
    return { atHeight: (1_000n + eventId / 3n).toString(10), atEventId: eventId.toString(10) };
  }

  handle(route: string, url: URL, body: unknown): { status: number; body: unknown } {
    switch (route) {
      case "tip":
        return this.tip();
      case "initial-utxos":
        return this.initialUtxos(url);
      case "generation":
        return this.generation(url);
      case "segments":
        return this.segments(url);
      case "lookup":
        return this.lookup(body);
      default:
        return { status: 404, body: { error: { code: "DUST_BAD_PARAM", message: "no such route" } } };
    }
  }

  private tip(): { status: number; body: unknown } {
    this.calls.tip += 1;
    const state = this.chain.state;
    return {
      status: 200,
      body: {
        net: this.options.net,
        ...this.at(),
        commitmentFirstFree: this.chain.commitmentFirstFree.toString(10),
        generationFirstFree: this.chain.generationFirstFree.toString(10),
        commitmentRoot: this.chain.commitmentFirstFree === 0n ? null : String(state.commitmentTreeRoot()),
        generationRoot: this.chain.generationFirstFree === 0n ? null : String(state.generatingTreeRoot()),
        params: {
          nightDustRatio: String(this.chain.params.nightDustRatio),
          generationDecayRate: String(this.chain.params.generationDecayRate),
          dustGracePeriodSeconds: String(this.chain.params.dustGracePeriodSeconds),
        },
      },
    };
  }

  private initialUtxos(url: URL): { status: number; body: unknown } {
    this.calls["initial-utxos"] += 1;
    const owner = url.searchParams.get("owner") ?? "";
    const afterId = BigInt(url.searchParams.get("afterId") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const rows = this.chain.initial
      .filter((row) => row.qdo.owner.toString(10) === owner && row.eventId > afterId)
      .slice(0, limit);
    return {
      status: 200,
      body: {
        ...this.at(),
        items: rows.map((row) => ({
          eventId: row.eventId.toString(10),
          height: row.height.toString(10),
          txHash: row.txHash,
          output: {
            initialValue: row.qdo.initialValue.toString(10),
            owner: row.qdo.owner.toString(10),
            nonce: row.qdo.nonce.toString(10),
            seq: String(row.qdo.seq),
            ctime: Math.floor(row.qdo.ctime.getTime() / 1000),
            backingNight: row.qdo.backingNight,
            mtIndex: row.qdo.mtIndex.toString(10),
          },
          generation: {
            value: row.generation.value.toString(10),
            owner: row.generation.owner.toString(10),
            nonce: row.generation.nonce,
            dtime: row.generation.dtime === undefined ? null : Math.floor(row.generation.dtime.getTime() / 1000),
            generationIndex: row.generationIndex.toString(10),
          },
        })),
        nextAfterId: rows.length === limit ? (rows[rows.length - 1]?.eventId.toString(10) ?? null) : null,
      },
    };
  }

  private generation(url: URL): { status: number; body: unknown } {
    this.calls.generation += 1;
    const owner = url.searchParams.get("owner") ?? "";
    const afterIndex = BigInt(url.searchParams.get("afterIndex") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const rows = this.chain.initial
      .filter((row) => row.generation.owner.toString(10) === owner && row.generationIndex > afterIndex)
      .slice(0, limit);
    return {
      status: 200,
      body: {
        ...this.at(),
        items: rows.map((row) => ({
          generationIndex: row.generationIndex.toString(10),
          value: row.generation.value.toString(10),
          owner: row.generation.owner.toString(10),
          nonce: row.generation.nonce,
          dtime: row.generation.dtime === undefined ? null : Math.floor(row.generation.dtime.getTime() / 1000),
        })),
        nextAfterIndex: rows.length === limit ? (rows[rows.length - 1]?.generationIndex.toString(10) ?? null) : null,
      },
    };
  }

  private segments(url: URL): { status: number; body: unknown } {
    this.calls.segments += 1;
    const tree = url.searchParams.get("tree") === "generation" ? "generation" : "commitment";
    const raw = url.searchParams.get("ranges") ?? "";
    const ranges = raw.split(",").map((part) => {
      const [start, end] = part.split("-");
      return { start: BigInt(start ?? "0"), end: BigInt(end ?? "0") };
    });
    if (ranges.length > this.calls.maxRangesInOneRequest) this.calls.maxRangesInOneRequest = ranges.length;
    const firstFree = tree === "commitment" ? this.chain.commitmentFirstFree : this.chain.generationFirstFree;
    for (const range of ranges) {
      if (range.end >= firstFree) {
        return {
          status: 400,
          body: { error: { code: "DUST_RANGE_INVALID", message: "past firstFree" } },
        };
      }
    }
    const state = this.chain.state;
    const segments = ranges.map((range, index) => {
      const update =
        tree === "commitment"
          ? state.collapsedCommitmentUpdate(range.start, range.end)
          : state.collapsedGenerationUpdate(range.start, range.end);
      let hex = Buffer.from(update.serialize() as Uint8Array).toString("hex");
      update.free();
      if (this.corrupt !== undefined && this.corrupt.tree === tree && this.corrupt.index === index) {
        // A wrong-but-well-formed segment: the SAME range, cut from a decoy tree of the same
        // shape whose leaves are different. It deserializes, it applies, and it advances the
        // receiver's `first_free` to exactly where the real one would — so every later insert
        // still lands linearly and ONLY the root comparison can catch it. (Serving a
        // different-width range instead would be caught one step earlier, by the ledger's own
        // linearity check, which would test the wrong thing.)
        const decoy = this.decoyFor(tree, firstFree);
        const wrong =
          tree === "commitment"
            ? decoy.collapsedCommitmentUpdate(range.start, range.end)
            : decoy.collapsedGenerationUpdate(range.start, range.end);
        hex = Buffer.from(wrong.serialize() as Uint8Array).toString("hex");
        wrong.free();
      }
      return { start: range.start.toString(10), end: range.end.toString(10), update: hex };
    });
    return {
      status: 200,
      body: {
        ...this.at(),
        tree,
        firstFree: firstFree.toString(10),
        root:
          firstFree === 0n
            ? null
            : String(tree === "commitment" ? state.commitmentTreeRoot() : state.generatingTreeRoot()),
        segments,
      },
    };
  }

  private decoyState: any;

  /** A tree of `firstFree` leaves that are NOT the chain's, for {@link corrupt}. Built once. */
  private decoyFor(tree: "commitment" | "generation", firstFree: bigint): any {
    if (this.decoyState !== undefined) return this.decoyState;
    const ledger = this.chain.ledger;
    let state = new ledger.DustLocalState(this.chain.params);
    const total = this.chain.commitmentFirstFree > this.chain.generationFirstFree
      ? this.chain.commitmentFirstFree
      : this.chain.generationFirstFree;
    for (let i = 0n; i < total; i += 1n) {
      const backingNight = (i + 9_000n).toString(16).padStart(64, "0");
      if (i < this.chain.commitmentFirstFree) {
        const next = state.insertCommitment(
          i,
          {
            initialValue: 12_345n + i,
            owner: 11n,
            nonce: 77n + i,
            seq: 0,
            ctime: new Date(GENESIS_SECONDS * 1000),
            backingNight,
            mtIndex: i,
          },
          true,
        );
        state.free();
        state = next;
      }
      if (i < this.chain.generationFirstFree) {
        const next = state.insertGenerationInfo(
          i,
          { value: 12_345n + i, owner: 11n, nonce: backingNight, dtime: undefined },
          backingNight,
        );
        state.free();
        state = next;
      }
    }
    void tree;
    void firstFree;
    this.decoyState = state;
    return state;
  }

  private lookup(body: unknown): { status: number; body: unknown } {
    this.calls.lookup += 1;
    const asked = (body as { nullifiers?: string[] }).nullifiers ?? [];
    this.calls.nullifiersAsked += asked.length;
    if (asked.length > this.calls.maxNullifiersInOneRequest) this.calls.maxNullifiersInOneRequest = asked.length;
    const spends = new Map(this.chain.spends.map((row) => [row.nullifier.toString(10), row]));
    const at = this.at();
    return {
      status: 200,
      body: {
        indexHeight: at.atHeight,
        indexEventId: at.atEventId,
        results: asked.map((nullifier) => {
          const row = spends.get(nullifier);
          return {
            nullifier,
            spend:
              row === undefined
                ? null
                : {
                    eventId: row.eventId.toString(10),
                    height: row.height.toString(10),
                    txHash: row.txHash,
                    nullifier: row.nullifier.toString(10),
                    commitment: row.commitment.toString(10),
                    commitmentIndex: row.commitmentIndex.toString(10),
                    vFee: row.vFee.toString(10),
                    declaredTime: row.declaredTime,
                    blockTime: row.blockTime,
                  },
          };
        }),
      },
    };
  }
}

/** The vendored ledger, loaded once per suite. */
export async function loadLedger(): Promise<any> {
  return await loadLedgerV8();
}

export function makeWallet(ledger: any, seed?: Uint8Array): FakeWallet {
  const sk = seed === undefined ? ledger.sampleDustSecretKey() : ledger.DustSecretKey.fromSeed(seed);
  return { sk, publicKey: sk.publicKey as bigint };
}
