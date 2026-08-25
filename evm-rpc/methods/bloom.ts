/**
 * The receipt `logsBloom` — Ethereum's 2048-bit Bloom-9 filter over a receipt's log addresses and
 * topics, computed exactly as go-ethereum's `core/types/bloom9.go` does.
 *
 * WHY COMPUTE IT AT ALL. A receipt's bloom is not decoration: clients (and every "did my transfer
 * emit anything?" heuristic) test it before reading `logs`. A receipt that carries logs but a ZERO
 * bloom is worse than one that carries neither — it says, with the full authority of the filter,
 * that no log matches, and a client that trusts the bloom will skip logs that are right there. So
 * the bloom is filled from the same array in the same call; the two cannot disagree.
 *
 * THE ALGORITHM, since it is easy to get subtly wrong and impossible to notice:
 * for each item (the 20-byte address, then each 32-byte topic) take `keccak256(item)` and use
 * BYTE PAIRS 0-1, 2-3 and 4-5. Each pair's low 11 bits select one of the 2048 bits. Geth indexes
 * the 256-byte array from the END — `bloom[255 - bit/8] |= 1 << (bit % 8)` — which is what makes
 * the result match the value a real node puts in a receipt rather than a mirror image of it.
 *
 * Uses this repo's own keccak256 (`logs/keccak256.ts`, cross-checked against `ethers` in
 * `test/keccak256.test.ts`); Node's `sha3-256` is FIPS-202 and would silently produce a different,
 * wrong filter.
 */
import { keccak256 } from "../logs/keccak256.js";

const BLOOM_BYTES = 256;

/** The three (byteIndex, bitMask) pairs one item contributes. */
function bloomPositions(item: Uint8Array): [number, number][] {
  const digest = keccak256(item);
  const positions: [number, number][] = [];
  for (const pair of [0, 2, 4]) {
    const bit = ((digest[pair]! << 8) | digest[pair + 1]!) & 0x7ff;
    positions.push([BLOOM_BYTES - 1 - (bit >> 3), 1 << (bit & 0x7)]);
  }
  return positions;
}

function hexToBytes(value: string): Uint8Array {
  const raw = value.startsWith("0x") ? value.slice(2) : value;
  if (raw.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(raw)) {
    throw new Error("data source returned malformed hex while computing logsBloom");
  }
  return Uint8Array.from(Buffer.from(raw, "hex"));
}

/** The receipt's `logsBloom` over `logs`; `0x00…00` for an empty array, as Ethereum defines. */
export function logsBloom(logs: readonly { address: string; topics: readonly string[] }[]): string {
  const bloom = new Uint8Array(BLOOM_BYTES);
  for (const log of logs) {
    for (const item of [log.address, ...log.topics]) {
      for (const [index, mask] of bloomPositions(hexToBytes(item))) {
        bloom[index]! |= mask;
      }
    }
  }
  return `0x${Buffer.from(bloom).toString("hex")}`;
}
