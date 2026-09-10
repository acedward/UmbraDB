import { loadLedgerV8 } from "../chain-archive-sync/tx-replay-decoder.js";
import { decodeBech32m, encodeBech32m } from "./bech32m.js";
import { InvalidViewingKeyError } from "./errors.js";
import { assertNetworkId, monitorFingerprint } from "./fingerprint.js";

/**
 * Viewing-key intake (organizer spec FR-001/FR-002/FR-023).
 *
 * Three steps, in this order, reproducing the reference indexer's own sequence
 * (`indexer-api/src/infra/api/v4/viewing_key.rs:39-48` → `v4.rs:190-204` → `v4.rs:149-158`):
 *
 *   1. Bech32m-decode the submitted string.
 *   2. Require the human-readable part the deployment network implies.
 *   3. Prove the payload really is an encryption secret key by handing it to the ledger's own
 *      `EncryptionSecretKey.deserialize`, require the payload to be that key's CANONICAL
 *      encoding, then clear and free the handle immediately.
 *
 * Step 3's canonical-encoding requirement is one step more than the reference indexer does, and
 * it is there because of something measured against the vendored build rather than assumed:
 * `EncryptionSecretKey.deserialize` reads a SCALE-style compact length prefix followed by that
 * many bytes and silently ignores every byte after them. `<key>` and `<key> || 0xAA` therefore
 * name the same key while hashing to different fingerprints, which would let one wallet be
 * registered arbitrarily many times and defeat organizer spec FR-004's idempotency. Requiring
 * `serialize(deserialize(payload)) == payload` makes the accepted set exactly the canonical
 * encodings. Both real-world vectors — the reference indexer's committed 32-byte one and the
 * 33-byte output of `ZswapSecretKeys.fromSeed` — round-trip unchanged.
 *
 * Every failure at every step raises the SAME {@link InvalidViewingKeyError} with the same
 * message (organizer spec FR-001: "any failure yields one generic client error"), so a caller
 * cannot use the error to learn whether the checksum, the network or the payload was wrong. The
 * discriminating `rejection` field is diagnostic-only and contains nothing derived from the
 * input.
 *
 * The WASM is loaded through `chain-archive-sync/tx-replay-decoder.ts`'s existing `loadLedgerV8()`
 * rather than a second loader: it already resolves the vendored `@midnight-ntwrk/ledger-v8`
 * build, honours the `MIDNIGHT_LEDGER_WASM` test override, and refuses to silently fall back to a
 * different build. Both modules live outside `src/`, so this import is clear of
 * `test/postgres/no-chain-sync-import-guard.test.ts`, which governs `src/` only.
 *
 * Owner decision Q1: ledger v8 only. There is no v9 lane and no adapter layer in this project.
 */

/** The identifier recorded on every monitor and association as the ledger build that produced
 *  the relevance verdict (organizer spec FR-009's provenance). Pinned to the vendored build PR #1
 *  already depends on (`vendor/ledger-v8-syshash/PROVENANCE.md`). */
export const LEDGER_BUILD_ID = "ledger-v8@8.1.0-syshash.4";

/** The Bech32m human-readable prefix for a shielded encryption secret key
 *  (`AddressType::hrp_prefix`, `indexer-api/src/infra/api/v4.rs:160-166`). */
export const SHIELD_ESK_HRP_PREFIX = "mn_shield-esk";

/** What every redacting path renders instead of the key. */
export const REDACTED = "[ShieldedViewingKey redacted]";

/**
 * The human-readable part a viewing key must carry on `net`.
 *
 * Reproduces `AddressType::hrp` (`indexer-api/src/infra/api/v4.rs:149-158`) exactly, including
 * its case-insensitive comparison against `mainnet`: the bare prefix on mainnet, `<prefix>_<net>`
 * everywhere else. The acceptance network for this project is `undeployed` (owner Q7).
 *
 * The returned HRP is lowercased, because {@link decodeBech32m} lowercases before returning and
 * the comparison in {@link parseViewingKey} is then exact. A network id containing uppercase
 * would otherwise produce an HRP that can never match anything.
 */
export function hrpForNetwork(net: string): string {
  assertNetworkId(net);
  if (net.toLowerCase() === "mainnet") return SHIELD_ESK_HRP_PREFIX;
  return `${SHIELD_ESK_HRP_PREFIX}_${net.toLowerCase()}`;
}

/**
 * A validated shielded viewing key, held in memory.
 *
 * The serialized bytes live in a `#private` field and every implicit stringification path is
 * overridden to render {@link REDACTED}: `toString`, `toJSON` (so `JSON.stringify` of any object
 * containing one is safe), and Node's `util.inspect` custom hook (so `console.log`, `%s`, `%o`
 * and an unhandled-rejection dump are safe). Reading the bytes requires the deliberately
 * unwieldy {@link yesIKnowTheSecurityImplicationsOfThis_serialized} — the naming convention the
 * ledger WASM itself uses for exactly this hazard
 * (`vendor/ledger-v8-syshash/midnight_ledger_wasm.d.ts:360,365`), adopted here so the hazard is
 * visible at the call site rather than in a doc comment.
 *
 * Organizer spec FR-023 and SC-004: no viewing key may appear in logs, metrics or error bodies.
 */
export class ShieldedViewingKey {
  readonly #serialized: Uint8Array;
  /** The network this key was validated for. Not secret. */
  readonly net: string;
  /** The 32-byte registration fingerprint (organizer spec FR-003). Never returned to callers by
   *  the store; exposed here because the store needs it to write the row. */
  readonly fingerprint: Buffer;

  constructor(net: string, serialized: Uint8Array) {
    assertNetworkId(net);
    if (serialized.length === 0) throw new Error("ShieldedViewingKey: empty serialized key");
    // Copy: the caller's buffer may be a view into a larger, reused allocation.
    this.#serialized = Uint8Array.from(serialized);
    this.net = net;
    this.fingerprint = monitorFingerprint(net, this.#serialized);
    Object.freeze(this);
  }

  /** The serialized key bytes. Every call site of this method is a place a viewing key can
   *  escape; there are exactly two in this repository (the store's `register`, which writes the
   *  column, and the tests). */
  yesIKnowTheSecurityImplicationsOfThis_serialized(): Uint8Array {
    return Uint8Array.from(this.#serialized);
  }

  /** The number of bytes in the serialized key. Safe to log: a length is not key material, and
   *  it is occasionally the only useful diagnostic. */
  get serializedLength(): number {
    return this.#serialized.length;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  /** Node's `util.inspect` hook — this is what `console.log` and format specifiers use. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED;
  }
}

/** The subset of the ledger WASM surface this module uses
 *  (`vendor/ledger-v8-syshash/midnight_ledger_wasm.d.ts:355-366`). */
interface LedgerKeyApi {
  EncryptionSecretKey: {
    deserialize(raw: Uint8Array): {
      yesIKnowTheSecurityImplicationsOfThis_serialize(): Uint8Array;
      clear?(): void;
      free?(): void;
    };
  };
}

/** Loads and caches the vendored ledger v8 module. Cached because intake may run per request and
 *  the WASM instantiation is not free; the module is stateless with respect to keys. */
let ledgerModule: Promise<LedgerKeyApi> | undefined;

function ledger(): Promise<LedgerKeyApi> {
  ledgerModule ??= loadLedgerV8() as Promise<LedgerKeyApi>;
  return ledgerModule;
}

/**
 * Decodes, network-checks and ledger-validates a submitted viewing key.
 *
 * On success the returned {@link ShieldedViewingKey} holds the serialized bytes and the ledger
 * handle used for validation has already been cleared and freed — the handle's only purpose was
 * to prove the bytes deserialize, so keeping it alive would be secret material held for no
 * reason. `clear()` is the ledger's own zeroising call; `free()` is wasm-bindgen's deallocator,
 * and it runs in a `finally` so the handle cannot leak if `clear()` throws.
 *
 * @throws InvalidViewingKeyError for every failure, with one identical message.
 */
export async function parseViewingKey(encoded: unknown, net: string): Promise<ShieldedViewingKey> {
  assertNetworkId(net);
  if (typeof encoded !== "string") throw new InvalidViewingKeyError("not-a-string");

  let hrp: string;
  let data: Uint8Array;
  try {
    ({ hrp, data } = decodeBech32m(encoded));
  } catch {
    // The underlying Bech32mError is deliberately NOT chained: `cause` travels with a thrown
    // error into logs, and an error type that carries a decode failure is one refactor away from
    // carrying the input that caused it.
    throw new InvalidViewingKeyError("bech32m");
  }

  if (hrp !== hrpForNetwork(net)) throw new InvalidViewingKeyError("network-hrp");

  let mod: LedgerKeyApi;
  try {
    mod = await ledger();
  } catch {
    // A missing or unloadable ledger artifact is an operator fault, not a bad key — but the
    // caller still gets the one generic error, because distinguishing them would tell an
    // untrusted caller about the deployment. The `rejection` discriminant is what an operator
    // reads instead.
    throw new InvalidViewingKeyError("ledger-unavailable");
  }

  let handle: ReturnType<LedgerKeyApi["EncryptionSecretKey"]["deserialize"]>;
  try {
    handle = mod.EncryptionSecretKey.deserialize(data);
  } catch {
    throw new InvalidViewingKeyError("ledger-rejected");
  }

  // ── Canonical-encoding check (see the module note on trailing-byte malleability) ──────────
  // Measured against the vendored build, not assumed: `EncryptionSecretKey.deserialize` reads a
  // SCALE-style compact length prefix followed by exactly that many bytes and IGNORES anything
  // after them. So `<key>` and `<key> || 0xAA…` both deserialize to the same key while being
  // different byte strings — which would give one key two fingerprints and break idempotent
  // registration (organizer spec FR-004), letting the same wallet be registered arbitrarily many
  // times. Requiring the payload to equal the ledger's own re-serialization closes that: the
  // accepted set becomes exactly the canonical encodings. Both real vectors round-trip
  // unchanged (the reference indexer's, 32 bytes; and `ZswapSecretKeys.fromSeed`'s, 33 bytes).
  let canonical: Uint8Array;
  try {
    canonical = handle.yesIKnowTheSecurityImplicationsOfThis_serialize();
  } finally {
    try {
      handle.clear?.();
    } finally {
      handle.free?.();
    }
  }
  if (canonical.length !== data.length || !canonical.every((b, i) => b === data[i])) {
    throw new InvalidViewingKeyError("non-canonical");
  }

  return new ShieldedViewingKey(net, canonical);
}

/**
 * Re-encodes serialized key bytes as the Bech32m string a deployment on `net` would accept.
 *
 * Test and harness support only — the intake path never encodes. It exists so key vectors can be
 * built from `ZswapSecretKeys.fromSeed(seed).encryptionSecretKey
 * .yesIKnowTheSecurityImplicationsOfThis_serialize()` without duplicating the HRP rule, which is
 * the one place a test could silently diverge from production behaviour.
 */
export function encodeViewingKey(serialized: Uint8Array, net: string): string {
  return encodeBech32m(hrpForNetwork(net), serialized);
}
