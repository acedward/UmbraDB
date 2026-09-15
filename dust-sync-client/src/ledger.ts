/**
 * The ledger surface this client uses — and the promise that it is the STANDARD one.
 *
 * ── Why this file exists ────────────────────────────────────────────────────────────────────
 * The node's mirror needs three exports that only exist on the owner's fork
 * (`replayRawEventsRetainingAll`, `collapsedCommitmentUpdate`, `collapsedGenerationUpdate`, plus
 * the two `firstFree` getters). A WALLET must need none of them: the whole point of
 * `spec/00016-dust-wallet-sync.md` §6's last line — *"the wallet side applies segments with the
 * standard 8.1.0 package"* — is that a real wallet can run this client against the package it
 * already ships, with no vendored build and no fork.
 *
 * In this repository `@midnight-ntwrk/ledger-v8` resolves to the vendored fork build, so a member
 * that exists only there would work here and fail in every wallet. {@link LEDGER_SURFACE} is the
 * list of members this client is allowed to touch, and
 * `dust-sync-client/test/published-surface.test.ts` checks every one of them against the
 * PUBLISHED 8.1.0 declaration file, copied out of the wallet SDK image. Adding a call to a fork
 * export therefore fails a test rather than shipping a client no wallet can use.
 *
 * ── Why the module is injected rather than imported ─────────────────────────────────────────
 * `chain-archive-sync/tx-replay-decoder.ts` loads the WASM through a computed `import(...)` so
 * `tsc` types it `any` and the repository typechecks without the artifact present; this client
 * follows the same convention one step further and takes the loaded module as a PARAMETER. The
 * unit tests then drive the real algorithm with the real WASM, a browser wallet passes its own
 * copy of the published package, and nothing in `src/` has a static dependency on a build.
 */

/** A `QualifiedDustOutput` as the WASM bindings exchange it (`ledger-wasm/src/conversions.rs`
 *  `PreQualifiedDustOutput`): magnitudes as `bigint`, `seq` as a number, `ctime` as a `Date`,
 *  `backingNight` as lowercase hex without `0x`. */
export interface DustQdo {
  readonly initialValue: bigint;
  readonly owner: bigint;
  readonly nonce: bigint;
  readonly seq: number;
  readonly ctime: Date;
  readonly backingNight: string;
  readonly mtIndex: bigint;
}

/** A `DustGenerationInfo` in the same exchange shape. `dtime` absent/undefined means "no end
 *  time" (the ledger's `Timestamp::MAX`). */
export interface DustGenerationValue {
  readonly value: bigint;
  readonly owner: bigint;
  readonly nonce: string;
  readonly dtime: Date | undefined;
}

/** A deserialized collapsed update. `free` is wasm-bindgen's, present on every build. */
export interface CollapsedUpdateLike {
  free(): void;
}

/** The subset of `DustLocalState` the client calls. Every method returns a NEW state — the type
 *  is immutable in the ledger and the client frees what it supersedes. */
export interface DustLocalStateLike {
  insertGenerationInfo(
    generationIndex: bigint,
    generation: DustGenerationValue,
    initialNonce?: string | null,
  ): DustLocalStateLike;
  applyGenerationCollapsedUpdate(update: CollapsedUpdateLike): DustLocalStateLike;
  generatingTreeRoot(): unknown;
  insertCommitment(commitmentIndex: bigint, qdo: DustQdo, ownQdo: boolean): DustLocalStateLike;
  applyCommitmentCollapsedUpdate(update: CollapsedUpdateLike): DustLocalStateLike;
  commitmentTreeRoot(): unknown;
  addUtxo(nullifier: bigint, utxo: DustQdo, pendingUntil?: Date | null): DustLocalStateLike;
  successorUtxo(
    utxo: DustQdo,
    now: Date,
    subtractFee: bigint,
    newCommitmentIndex: bigint,
    sk: DustSecretKeyLike,
  ): DustQdo;
  walletBalance(time: Date): bigint;
  serialize(): Uint8Array;
  readonly utxos: readonly DustQdo[];
  free(): void;
}

/** Opaque to this client: it is passed to `dustNullifier` and `successorUtxo` and never read. */
export interface DustSecretKeyLike {
  readonly publicKey: bigint;
}

/** The loaded `@midnight-ntwrk/ledger-v8` module, structurally. */
export interface LedgerLike {
  readonly DustLocalState: new (params: unknown) => DustLocalStateLike;
  readonly DustParameters: new (
    nightDustRatio: bigint,
    generationDecayRate: bigint,
    dustGracePeriodSeconds: bigint,
  ) => unknown;
  readonly DustStateMerkleTreeCollapsedUpdate: { deserialize(raw: Uint8Array): CollapsedUpdateLike };
  dustNullifier(utxo: DustQdo, sk: DustSecretKeyLike): bigint;
}

/**
 * Every member of the ledger this client touches, by owner.
 *
 * Checked against the published 8.1.0 declaration file by `test/published-surface.test.ts`. Keep
 * it in step with the code: a member used but not listed is a hole in that check, which is why
 * the test also asserts the list is non-empty for each class and why reviewers should treat an
 * edit here as an edit to the compatibility promise.
 */
export const LEDGER_SURFACE = {
  DustLocalState: [
    "insertGenerationInfo",
    "applyGenerationCollapsedUpdate",
    "generatingTreeRoot",
    "insertCommitment",
    "applyCommitmentCollapsedUpdate",
    "commitmentTreeRoot",
    "addUtxo",
    "successorUtxo",
    "walletBalance",
    "serialize",
    "utxos",
  ],
  DustParameters: ["constructor"],
  DustStateMerkleTreeCollapsedUpdate: ["deserialize"],
  DustSecretKey: ["fromSeed", "publicKey"],
  functions: ["dustNullifier"],
} as const;

/**
 * Members the client calls that the PUBLISHED declaration file does not declare.
 *
 * `free()` and `[Symbol.dispose]` are wasm-bindgen's own, emitted on every exported class of
 * every build of this package; the published `ledger-v8.d.ts` is a hand-curated façade that omits
 * them, while the generated `midnight_ledger_wasm.d.ts` (what the vendored build ships) declares
 * them. They are therefore NOT fork additions, and `published-surface.test.ts` proves it against a
 * second, independently published build (`ledger-v8-stock`, 8.0.3) rather than taking it on trust.
 */
export const WASM_BINDGEN_UNIVERSALS = ["free"] as const;

/**
 * Fails fast if the injected module is not a ledger build this client can use.
 *
 * A wallet that passes the wrong module would otherwise find out at the first `insertCommitment`,
 * halfway through a sync, with a `TypeError` that names nothing useful.
 */
export function assertLedgerSurface(ledger: unknown): asserts ledger is LedgerLike {
  const module = ledger as Record<string, unknown> | null;
  if (module === null || typeof module !== "object") {
    throw new TypeError("dust-sync-client: the ledger module must be the loaded @midnight-ntwrk/ledger-v8");
  }
  for (const name of ["DustLocalState", "DustParameters", "DustStateMerkleTreeCollapsedUpdate"]) {
    if (typeof module[name] !== "function") {
      throw new TypeError(`dust-sync-client: the ledger module has no ${name}`);
    }
  }
  for (const name of LEDGER_SURFACE.functions) {
    if (typeof module[name] !== "function") {
      throw new TypeError(`dust-sync-client: the ledger module has no ${name}()`);
    }
  }
}
