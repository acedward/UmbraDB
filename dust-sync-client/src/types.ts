/**
 * The wire shapes of `/v1/dust/*` as the node serves them (`spec/00016-dust-wallet-sync.md` §4,
 * §8) and the result shape `syncDust` returns (§5.5 step 10, FR-030).
 *
 * Everything the node sends is a STRING. Field elements and u64/u128 magnitudes are decimal
 * strings because they are `bigint` in the WASM bindings and `numeric(78)`/`bigint` in the
 * archive, and a JSON number cannot hold either; hashes and `InitialNonce`s are lowercase hex
 * without `0x`; timestamps are integer unix SECONDS (a JSON number). These types say so rather
 * than modelling the values as `bigint`, so that a response is typed as what actually arrived and
 * the one place that converts is `encode.ts`.
 */

/** `GET /v1/dust/tip`. */
export interface DustTipResponse {
  readonly net: string;
  readonly atHeight: string;
  readonly atEventId: string;
  readonly commitmentFirstFree: string;
  readonly generationFirstFree: string;
  readonly commitmentRoot: string | null;
  readonly generationRoot: string | null;
  readonly params: {
    readonly nightDustRatio: string;
    readonly generationDecayRate: string;
    readonly dustGracePeriodSeconds: string;
  };
}

/** `payload.output` of a `dustInitialUtxo` row: a `QualifiedDustOutput` in §4's encodings. */
export interface DustOutputWire {
  readonly initialValue: string;
  readonly owner: string;
  readonly nonce: string;
  readonly seq: string;
  readonly ctime: number;
  readonly backingNight: string;
  readonly mtIndex: string;
}

/** A generation entry, with `dtime` already merged to its LATEST value by the node (FR-016). */
export interface DustGenerationWire {
  readonly value: string;
  readonly owner: string;
  readonly nonce: string;
  readonly dtime: number | null;
  readonly generationIndex: string;
}

/** One item of `GET /v1/dust/initial-utxos`. */
export interface DustInitialUtxoItem {
  readonly eventId: string;
  readonly height: string;
  readonly txHash: string;
  readonly output: DustOutputWire;
  readonly generation: DustGenerationWire;
}

export interface DustInitialUtxosResponse {
  readonly atHeight: string;
  readonly atEventId: string;
  readonly items: readonly DustInitialUtxoItem[];
  readonly nextAfterId: string | null;
}

/** One item of `GET /v1/dust/generation` (no `generationIndex` merge needed — it is the key). */
export interface DustGenerationItem {
  readonly generationIndex: string;
  readonly value: string;
  readonly owner: string;
  readonly nonce: string;
  readonly dtime: number | null;
}

export interface DustGenerationResponse {
  readonly atHeight: string;
  readonly atEventId: string;
  readonly items: readonly DustGenerationItem[];
  readonly nextAfterIndex: string | null;
}

/** One cut of a tree: `update` is `DustStateMerkleTreeCollapsedUpdate.serialize()` as hex. */
export interface DustSegment {
  readonly start: string;
  readonly end: string;
  readonly update: string;
}

export interface DustSegmentsResponse {
  readonly atHeight: string;
  readonly atEventId: string;
  readonly tree: "commitment" | "generation";
  readonly firstFree: string;
  readonly root: string | null;
  readonly segments: readonly DustSegment[];
}

/** The public record of one DUST fee spend (spec §4 `SpendRecord`). */
export interface DustSpendRecord {
  readonly eventId: string;
  readonly height: string;
  readonly txHash: string;
  readonly nullifier: string;
  readonly commitment: string;
  readonly commitmentIndex: string;
  readonly vFee: string;
  readonly declaredTime: number;
  readonly blockTime: number;
}

export interface DustLookupResponse {
  readonly indexHeight: string;
  readonly indexEventId: string;
  readonly results: readonly { readonly nullifier: string; readonly spend: DustSpendRecord | null }[];
}

/** Wall-clock split of §5.5, in milliseconds (step 10). */
export interface DustSyncTiming {
  readonly tipMs: number;
  readonly initialMs: number;
  readonly generationMs: number;
  readonly chainMs: number;
  readonly rounds: number;
  readonly commitmentMs: number;
  readonly consistencyMs: number;
  readonly totalMs: number;
}

/** What the sync did, for the measurement CLI and for the Story 4 assertions. */
export interface DustSyncStats {
  readonly initialUtxos: number;
  readonly spendsFollowed: number;
  readonly liveUtxos: number;
  readonly segmentsC: number;
  readonly segmentsG: number;
  readonly requests: number;
  readonly bytesIn: number;
  /** The mirror tip the final state is consistent with — both roots were compared at it. */
  readonly atEventId: string;
  readonly atHeight: string;
  /** How many times the chain moved under the client and a phase was restarted (§5.5 7–9). */
  readonly restarts: number;
}
