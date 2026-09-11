import { createECDH, createHmac } from "node:crypto";

/**
 * Hierarchical-deterministic derivation of a Midnight role key (organizer sub-plan 00009-06;
 * `openspec/changes/00009-06-dashboard/design.md` §4).
 *
 * ── What scheme this is, and how that was established ───────────────────────────────────────
 * **Standard BIP-0032 over secp256k1**, path `m/44'/2400'/<account>'/<role>/<index>`. That is not
 * inferred from the shape of the path; it was read off two independent implementations:
 *
 * 1. The reference indexer's own derivation
 *    (`resources/midnight-indexer-v4.4.0-rc.3/indexer-common/src/domain/ledger/transaction.rs:497-512`)
 *    uses `bip32::{DerivationPath, XPrv}` — the RustCrypto `bip32` crate, pinned at `0.5` in that
 *    workspace's `Cargo.toml:53` — whose `XPrv` is BIP-0032 over secp256k1.
 * 2. The **real Midnight wallet**, `@midnightntwrk/wallet-sdk-hd@3.0.3`, is
 *    `HDKey.fromMasterSeed(seed).derive("m/44'/2400'/<account>'/<role>/<index>")` over
 *    `@scure/bip32@2.4.0`, with `PURPOSE = 44`, `COIN_TYPE = 2400` and `Roles.Zswap = 3`. The SDK
 *    was read and executed **out of tree**, in a one-off container, exactly as 00009-05 did for
 *    the live shielded transfer; this repository gains no dependency from it.
 *
 * Three key vectors captured from that SDK are committed in
 * `test/shielded-monitor/fixtures/wallet-sdk-hd-vectors.json`, and `test/shielded-monitor/hd.test.ts`
 * asserts this module reproduces every one of them — plus all six nodes of **BIP-0032 official
 * test vector 1**, which is what distinguishes "this is BIP32" from "this happens to agree with
 * one wallet on three inputs".
 *
 * ── Why it is implemented here rather than taken from a package ──────────────────────────────
 * `design/design.md` §7's dependency-minimalism rule. The whole of BIP-0032's private derivation
 * is three primitives Node already ships: HMAC-SHA512 (`node:crypto`), a secp256k1 public key from
 * a private scalar (`createECDH`, which is OpenSSL's), and one modular addition (`BigInt`). Adding
 * a dependency — and its supply-chain review, its pinning, its `SECURITY.md` row — to avoid
 * ~60 lines of code with an official test vector is the wrong trade in this repository.
 *
 * ── What this module is NOT ─────────────────────────────────────────────────────────────────
 * There is no BIP-0039 here: no wordlist, no mnemonic, no PBKDF2. `@midnightntwrk/wallet-sdk-hd`
 * contains no `mnemonicToSeed` either — its `generateRandomSeed` hands `HDWallet.fromSeed` a raw
 * 32-byte seed — so a mnemonic conversion would be a step no Midnight component performs, with no
 * ground truth to test it against. Recorded as organizer question Q21.
 *
 * There is also no public (neutered) derivation and no extended-key serialization: nothing in this
 * repository needs an `xpub`, and code that exists only to be untested is a liability.
 */

/** The order of the secp256k1 group. `CKDpriv` is defined modulo this. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** BIP-0032's hardened-child offset; indices at or above it derive from the private key. */
export const HARDENED_OFFSET = 0x80000000;

/** BIP-0044 purpose, and Midnight's registered coin type (SLIP-0044 `2400`). Both from
 *  `@midnightntwrk/wallet-sdk-hd`'s `HDWallet.js`. */
export const MIDNIGHT_PURPOSE = 44;
export const MIDNIGHT_COIN_TYPE = 2400;

/** The roles `@midnightntwrk/wallet-sdk-hd` defines. Only `Zswap` is used here — it is the role
 *  whose key becomes the shielded encryption secret key this service registers — but the whole
 *  enumeration is written out because a wrong role silently yields a valid key for the wrong
 *  purpose, which is exactly the failure a named constant prevents. */
export const MIDNIGHT_ROLES = {
  NightExternal: 0,
  NightInternal: 1,
  Dust: 2,
  Zswap: 3,
  Metadata: 4,
} as const;

export class HdDerivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HdDerivationError";
  }
}

/** A BIP-0032 extended private key: the 32-byte scalar and its 32-byte chain code. Exported
 *  because the chain code is half of what the official test vector pins, and a derivation checked
 *  only on its key bytes would pass with a broken chain code right up until the next child. */
export interface HdNode {
  readonly key: Buffer;
  readonly chainCode: Buffer;
}

/** The compressed secp256k1 public key of a private scalar, via OpenSSL. Needed only by the
 *  NON-hardened steps of the path (`…/<role>/<index>`), which hash the parent's public key. */
function publicKey(key: Buffer): Buffer {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(key);
  return ecdh.getPublicKey(null, "compressed");
}

function toKey(scalar: bigint): Buffer {
  return Buffer.from(scalar.toString(16).padStart(64, "0"), "hex");
}

/**
 * BIP-0032 master key generation.
 *
 * The seed length bounds are the specification's (16–64 bytes). They are enforced rather than
 * assumed because a short seed is the one input that produces a perfectly valid-looking key with
 * far less entropy than the caller believes it has.
 */
function master(seed: Uint8Array): HdNode {
  if (seed.length < 16 || seed.length > 64) {
    throw new HdDerivationError(`seed must be 16..64 bytes, got ${seed.length}`);
  }
  const I = createHmac("sha512", Buffer.from("Bitcoin seed", "utf8")).update(seed).digest();
  const key = I.subarray(0, 32);
  const scalar = BigInt(`0x${key.toString("hex")}`);
  // Astronomically improbable, and the specification still says what to do: this seed is invalid.
  // Silently continuing would produce a key outside the group.
  if (scalar === 0n || scalar >= SECP256K1_N) throw new HdDerivationError("seed produced an invalid master key");
  return { key: Buffer.from(key), chainCode: Buffer.from(I.subarray(32)) };
}

/**
 * BIP-0032 `CKDpriv`.
 *
 * The hardened/non-hardened split is the whole of the function's subtlety: a hardened child hashes
 * `0x00 || kpar || index`, a normal child hashes `serP(point(kpar)) || index`. Getting that
 * backwards produces a derivation that is self-consistent and wrong — which is why this module's
 * test walks the official vector's path, whose five steps include both kinds in both orders.
 */
function ckdPriv(parent: HdNode, index: number): HdNode {
  if (!Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) {
    throw new HdDerivationError(`child index out of range: ${index}`);
  }
  const data = Buffer.alloc(37);
  if (index >= HARDENED_OFFSET) {
    data[0] = 0;
    parent.key.copy(data, 1);
  } else {
    publicKey(parent.key).copy(data, 0);
  }
  data.writeUInt32BE(index >>> 0, 33);

  const I = createHmac("sha512", parent.chainCode).update(data).digest();
  const left = BigInt(`0x${I.subarray(0, 32).toString("hex")}`);
  // The specification's "in case parse256(IL) >= n or ki = 0, proceed with the next value for i".
  // This module does not silently skip: the caller asked for a specific path, and quietly handing
  // back a different child would be worse than an error nobody will ever see.
  if (left >= SECP256K1_N) throw new HdDerivationError(`invalid child at index ${index}`);
  const childScalar = (left + BigInt(`0x${parent.key.toString("hex")}`)) % SECP256K1_N;
  if (childScalar === 0n) throw new HdDerivationError(`invalid child at index ${index}`);
  return { key: toKey(childScalar), chainCode: Buffer.from(I.subarray(32)) };
}

/** Derives the extended private key at a path given as raw child indices (hardened ones already
 *  carry {@link HARDENED_OFFSET}). */
export function deriveNode(seed: Uint8Array, path: readonly number[]): HdNode {
  let node = master(seed);
  for (const index of path) node = ckdPriv(node, index);
  return node;
}

/** The private key at a path. What every caller in this repository actually wants. */
export function derivePrivateKey(seed: Uint8Array, path: readonly number[]): Buffer {
  return deriveNode(seed, path).key;
}

export interface MidnightRolePathOptions {
  /** BIP-0044 account, hardened. Default 0 — the account a wallet opens with. */
  readonly account?: number;
  /** Role. Default {@link MIDNIGHT_ROLES.Zswap}, the shielded role this service registers. */
  readonly role?: number;
  /** Address index within the role. Default 0. */
  readonly index?: number;
}

/** The path components of `m/44'/2400'/<account>'/<role>/<index>`, for display and for derivation. */
export function midnightRolePath(options: MidnightRolePathOptions = {}): {
  readonly text: string;
  readonly components: readonly number[];
} {
  const account = options.account ?? 0;
  const role = options.role ?? MIDNIGHT_ROLES.Zswap;
  const index = options.index ?? 0;
  for (const [name, value] of [["account", account], ["role", role], ["index", index]] as const) {
    // The same bound `@midnightntwrk/wallet-sdk-hd` checks before calling into `@scure/bip32`.
    if (!Number.isSafeInteger(value) || value < 0 || value >= HARDENED_OFFSET) {
      throw new HdDerivationError(`${name} must be an integer in [0, 2^31), got ${value}`);
    }
  }
  return {
    text: `m/${MIDNIGHT_PURPOSE}'/${MIDNIGHT_COIN_TYPE}'/${account}'/${role}/${index}`,
    components: [
      MIDNIGHT_PURPOSE + HARDENED_OFFSET,
      MIDNIGHT_COIN_TYPE + HARDENED_OFFSET,
      account + HARDENED_OFFSET,
      role,
      index,
    ],
  };
}

/**
 * The 32-byte role seed a Midnight wallet would hand `ZswapSecretKeys.fromSeed`.
 *
 * This is the single function the `--hd` mode of `umbradb-shielded-monitor-derive-key` calls, and
 * the one the wallet-SDK vectors pin.
 */
export function deriveMidnightRoleSeed(seed: Uint8Array, options: MidnightRolePathOptions = {}): Buffer {
  return derivePrivateKey(seed, midnightRolePath(options).components);
}
