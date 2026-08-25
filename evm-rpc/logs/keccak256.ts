/**
 * keccak256 (the pre-standardisation Keccak used by Ethereum), on Node built-ins only.
 *
 * WHY THIS FILE EXISTS AT ALL: Node's `crypto` exposes `sha3-256`, which is **not** keccak256.
 * FIPS-202 SHA3 appends the domain-separation suffix `0x06` before the `pad10*1` padding;
 * original Keccak appends `0x01`. Same permutation, same rate, different digest — so
 * `createHash("sha3-256")` silently produces the wrong topic0 for every EVM event signature.
 * There is no keccak256 in Node's stdlib, and Part C's "no heavy deps" constraint rules out
 * pulling a hashing package into the RUNTIME dependency set (`ethers` is a devDependency, used
 * in tests to cross-check this implementation — never imported by shipped code).
 *
 * Implemented with 64-bit lanes as `BigInt`, which is the shape the Keccak-f[1600] spec is
 * written in, so the code reads as the spec rather than as a hand-split 32-bit-pair
 * optimisation. Throughput is irrelevant here: the ingester hashes O(1) values per event
 * (an address mapping, an event name), not per byte of a large payload.
 *
 * Verified in `test/keccak256.test.ts` against (a) the published empty-string and "abc"
 * vectors, (b) `ethers.keccak256` over randomised inputs spanning every padding boundary
 * around the 136-byte rate, and (c) the ERC20 `Transfer(address,address,uint256)` signature
 * hash, which must equal the topic0 constant Part C's LOGMAP pins.
 */

const MASK64 = (1n << 64n) - 1n;

/** Keccak-f[1600] round constants (ι step), 24 rounds. */
const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/**
 * Rotation offsets for the ρ step, indexed `[x][y]` exactly as the reference `r[x][y]` table is
 * written, so it can be diffed against the spec by eye.
 */
const ROTATION_OFFSETS: readonly (readonly number[])[] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

/** Rate in bytes for keccak256: 200 - 2*32 = 136 (17 of the 25 lanes are absorbed). */
const RATE_BYTES = 136;
const RATE_LANES = RATE_BYTES / 8; // 17

function rotl64(value: bigint, shift: number): bigint {
  if (shift === 0) return value;
  const s = BigInt(shift);
  return ((value << s) | (value >> (64n - s))) & MASK64;
}

/** In-place Keccak-f[1600] permutation over 25 lanes, `state[x + 5*y]` = A[x][y]. */
function keccakF1600(state: bigint[]): void {
  const c = new Array<bigint>(5);
  const d = new Array<bigint>(5);
  const b = new Array<bigint>(25);

  for (let round = 0; round < 24; round++) {
    // θ
    for (let x = 0; x < 5; x++) {
      c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5]! ^ rotl64(c[(x + 1) % 5]!, 1);
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        state[x + 5 * y] = state[x + 5 * y]! ^ d[x]!;
      }
    }

    // ρ and π combined: B[y][(2x + 3y) mod 5] = rot(A[x][y], r[x][y])
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(state[x + 5 * y]!, ROTATION_OFFSETS[x]![y]!);
      }
    }

    // χ
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        state[x + 5 * y] =
          b[x + 5 * y]! ^ ((~b[((x + 1) % 5) + 5 * y]! & MASK64) & b[((x + 2) % 5) + 5 * y]!);
      }
    }

    // ι
    state[0] = state[0]! ^ ROUND_CONSTANTS[round]!;
  }
}

/**
 * keccak256 over `input`, returning the 32-byte digest.
 *
 * Padding is original-Keccak `pad10*1` with the `0x01` domain suffix (NOT SHA3's `0x06`) — the
 * one-byte difference that makes this Ethereum's hash rather than FIPS-202's.
 */
export function keccak256(input: Uint8Array): Uint8Array {
  const state = new Array<bigint>(25).fill(0n);

  // --- absorb full rate-sized blocks, then the padded final block ---
  const padded = new Uint8Array(Math.floor(input.length / RATE_BYTES) * RATE_BYTES + RATE_BYTES);
  padded.set(input);
  padded[input.length] = 0x01; // domain suffix + the leading 1 of pad10*1
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) | 0x80; // trailing 1
  // A message whose final block has exactly one free byte gets both bits in that byte (0x81),
  // which the `|=` above produces rather than overwriting — the classic off-by-one in hand-rolled
  // Keccak padding, covered by the rate-boundary cases in the test.

  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let lane = 0; lane < RATE_LANES; lane++) {
      // Each 8-byte group is a little-endian lane.
      let word = 0n;
      for (let byte = 7; byte >= 0; byte--) {
        word = (word << 8n) | BigInt(padded[offset + lane * 8 + byte]!);
      }
      state[lane] = state[lane]! ^ word;
    }
    keccakF1600(state);
  }

  // --- squeeze 32 bytes (lanes 0..3, little-endian); one squeeze, no further permutation ---
  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane++) {
    let word = state[lane]!;
    for (let byte = 0; byte < 8; byte++) {
      out[lane * 8 + byte] = Number(word & 0xffn);
      word >>= 8n;
    }
  }
  return out;
}

/** keccak256 of a UTF-8 string — the form event/function signature hashing needs. */
export function keccak256Utf8(text: string): Uint8Array {
  return keccak256(new TextEncoder().encode(text));
}
