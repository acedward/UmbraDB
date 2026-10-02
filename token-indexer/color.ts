import { CompactTypeBytes, CompactTypeVector, persistentCommit } from "@midnight-ntwrk/compact-runtime";

/**
 * Project 00020 — deriving a contract-minted token's COLOUR (its 32-byte token type) locally,
 * from public data only (spec §6.4, FR-003).
 *
 * The rule the chain uses (`coin-structure/src/contract.rs:57-70`, and the Compact standard
 * library's `tokenType` at `standard-library.compact:121`):
 *
 * ```
 * color = persistentCommit(Vector<2, Bytes<32>>([domainSep, contractAddress]),
 *                          pad(32, "midnight:derive_token"))
 * ```
 *
 * The same 32 bytes serve as a `ShieldedTokenType` or an `UnshieldedTokenType` — the ledger
 * distinguishes those by TAG, not by value, which is why one colour can legitimately belong to two
 * rows of `token_index.tokens` differing only in `kind`.
 *
 * Because the derivation needs nothing but the domain separator and the emitting contract's
 * address — both public in the transaction — no contract can ever describe another contract's
 * token: a claim about `(address, domainSep)` is only believed when it came from `address` itself.
 *
 * ── Implementation choice (spec §6.4's VERIFY) ─────────────────────────────────────────────────
 * `@midnight-ntwrk/compact-runtime@0.19.0` — the runtime paired with compactc 0.34.0 and
 * ledger-v9, i.e. the exact pin the tokens already deployed on Stagenet were built with. It
 * installs and typechecks cleanly under this repo's Node ≥ 24 / TS 5.9 setup (verified
 * 2026-09-17), so the ledger-v9 `persistentCommit(align, val, opening)` fallback the spec allows
 * was not needed.
 *
 * **Verified against the live chain before a line of scanner code existed** (runner C, 2026-09-17):
 * the Stagenet transaction `9cb9a8d1b660dc7df2c0d4fd572d71a7b3cdef86450fe164a3b2d0545bae20bc`
 * (height 364 934) is a `mint` call on contract `2e962ef4…b59e` whose transcript declares
 * `unshieldedMints = { 6d696e742d746573742d746f6b656e733a757477425443…00 : 100000000 }`, and the
 * UTXO it created carries `tokenType = 84392e97f3eb35ba7e41a575b6b77bb33e9025b39eee7bf9bc78fd17d059e575`.
 * This function reproduces exactly those bytes from the domain separator and the address alone.
 * That vector, and its five siblings, are pinned in `test/fixtures/color-vectors.json`.
 */

/** The domain-separation opening the chain uses, as `pad(32, …)`. */
export const DERIVE_TOKEN_OPENING = "midnight:derive_token";

/** `Vector<2, Bytes<32>>` — built once; the runtime types are immutable descriptors. */
const VECTOR_2_BYTES_32 = new CompactTypeVector<Uint8Array>(2, new CompactTypeBytes(32));

/**
 * Compact's `pad(n, s)`: the UTF-8 bytes of `s`, NUL-filled to `n` bytes.
 * Throws if `s` does not fit — silently truncating a domain separator would derive a wrong,
 * plausible-looking colour.
 */
export function pad(n: number, s: string): Uint8Array {
  const encoded = new TextEncoder().encode(s);
  if (encoded.length > n) {
    throw new Error(`pad(${n}, ${JSON.stringify(s)}): ${encoded.length} bytes do not fit`);
  }
  const out = new Uint8Array(n);
  out.set(encoded, 0);
  return out;
}

/** `pad(32, s)`. */
export function pad32(s: string): Uint8Array {
  return pad(32, s);
}

function assert32(name: string, value: Uint8Array): Uint8Array {
  if (value.length !== 32) {
    throw new Error(`${name} must be exactly 32 bytes, got ${value.length}`);
  }
  return value;
}

/**
 * The colour of the token `domainSep` minted by the contract at `address`.
 *
 * @param domainSep exactly the 32 bytes passed to `mintShieldedToken` / `mintUnshieldedToken` —
 *   i.e. the key of the transcript's mint map, decoded from hex.
 * @param address the emitting contract's 32-byte address.
 */
export function tokenColor(domainSep: Uint8Array, address: Uint8Array): Uint8Array {
  return persistentCommit(
    VECTOR_2_BYTES_32,
    [assert32("domainSep", domainSep), assert32("address", address)],
    pad32(DERIVE_TOKEN_OPENING),
  );
}

/** Hex-in, hex-out convenience for the CLI, the API and the fixtures. Lowercase, unprefixed —
 *  the form the indexer serves and this repo stores. */
export function tokenColorHex(domainSepHex: string, addressHex: string): string {
  return Buffer.from(
    tokenColor(hexToBytes(domainSepHex, "domainSep"), hexToBytes(addressHex, "address")),
  ).toString("hex");
}

/** Strict unprefixed-hex decoder — `Buffer.from(s, "hex")` silently truncates at the first
 *  non-hex character, which would turn a typo into a wrong colour instead of an error. */
export function hexToBytes(hex: string, what: string): Uint8Array {
  const value = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) {
    throw new Error(`${what}: not valid unprefixed hex: ${JSON.stringify(hex)}`);
  }
  return new Uint8Array(Buffer.from(value, "hex"));
}

/** The NIGHT token type: 32 zero bytes. Not derived — it is the ledger's definition
 *  (`coin-structure/src/coin.rs:556`, and `nativeToken().raw` in ledger-v9). */
export const NIGHT_COLOR_HEX = "0".repeat(64);
