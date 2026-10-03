import { readFileSync } from "node:fs";
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants, gunzipSync, gzipSync } from "node:zlib";
import type { ArchiveTape, TapeBlock } from "./fake-chain-server.js";
import { canonicalJson } from "./archive-digest.js";

/**
 * Compact on-disk form of a Stagenet archive tape (recorded fixtures for CI, target < 1 MB for 731
 * blocks).
 *
 * A tape (`record-tape.ts`) holds, per height, exactly what the two public endpoints answered:
 * `chain_getBlockHash`, `chain_getBlock` and the indexer's `block(offset:{height})`. The only large
 * redundancy in it is that every regular transaction appears TWICE: as the indexer's `raw` and again
 * inside the node extrinsic that carries it (the archive's CONTAINS cross-check depends on exactly
 * that). The compact form stores such an extrinsic as `{ tx, pre, post }` -- the bytes before and
 * after the index-`tx` transaction's `raw` -- and the whole JSON is compressed (gzip or brotli,
 * chosen by the file extension). Nothing else is derived or dropped: decoding gives back the
 * recorded responses value for value, which `encodeTape` checks before it returns.
 */

export const COMPACT_TAPE_FORMAT = "umbradb-stagenet-archive-tape/2";

/** A node extrinsic that contains the `raw` of the block's indexer transaction number `tx`. */
export interface ExtrinsicRef {
  tx: number;
  pre: string;
  post: string;
}

export interface CompactTapeBlock extends Omit<TapeBlock, "nodeBlock"> {
  nodeBlock: Omit<TapeBlock["nodeBlock"], "block"> & {
    block: Omit<TapeBlock["nodeBlock"]["block"], "extrinsics"> & { extrinsics: (string | ExtrinsicRef)[] };
  };
}

export interface CompactTape extends Omit<ArchiveTape, "blocks"> {
  format: typeof COMPACT_TAPE_FORMAT;
  blocks: CompactTapeBlock[];
  [extra: string]: unknown;
}

const noPrefix = (h: string): string => (h.startsWith("0x") ? h.slice(2) : h);

/** Smallest `raw` worth a reference (shorter strings could match by accident). */
const MIN_REF_HEX = 64;

export function encodeTape(tape: ArchiveTape & Record<string, unknown>): CompactTape {
  const blocks = tape.blocks.map((b): CompactTapeBlock => {
    const raws = b.indexerBlock.transactions.map((t) => noPrefix(t.raw).toLowerCase());
    const extrinsics = b.nodeBlock.block.extrinsics.map((e): string | ExtrinsicRef => {
      const lower = e.toLowerCase();
      for (let tx = 0; tx < raws.length; tx++) {
        const raw = raws[tx]!;
        if (raw.length < MIN_REF_HEX) continue;
        const at = lower.indexOf(raw);
        // Only when the case of the stored text is exactly what decoding will rebuild.
        if (at >= 2 && e.slice(at, at + raw.length) === noPrefix(b.indexerBlock.transactions[tx]!.raw)) {
          return { tx, pre: e.slice(0, at), post: e.slice(at + raw.length) };
        }
      }
      return e;
    });
    return { ...b, nodeBlock: { ...b.nodeBlock, block: { ...b.nodeBlock.block, extrinsics } } };
  });
  const compact = { ...tape, format: COMPACT_TAPE_FORMAT, blocks } as CompactTape;
  const back = decodeTape(compact);
  if (canonicalJson(back) !== canonicalJson({ ...tape, format: COMPACT_TAPE_FORMAT })) {
    throw new Error("compact tape does not decode back to the recorded tape");
  }
  return compact;
}

export function decodeTape(compact: CompactTape): ArchiveTape & Record<string, unknown> {
  if (compact.format !== COMPACT_TAPE_FORMAT) throw new Error(`unknown tape format ${String(compact.format)}`);
  const blocks = compact.blocks.map((b): TapeBlock => {
    const txs = b.indexerBlock.transactions;
    const extrinsics = b.nodeBlock.block.extrinsics.map((e) => {
      if (typeof e === "string") return e;
      const tx = txs[e.tx];
      if (tx === undefined) throw new Error(`block ${b.height}: extrinsic refers to missing transaction ${e.tx}`);
      return e.pre + noPrefix(tx.raw) + e.post;
    });
    return { ...b, nodeBlock: { ...b.nodeBlock, block: { ...b.nodeBlock.block, extrinsics } } };
  });
  return { ...compact, blocks };
}

/** Compression by extension: `.gz` gzip (level 9), `.br` brotli (quality 11, 16 MiB window). */
export function compressFor(path: string, text: string): Buffer {
  const data = Buffer.from(text, "utf8");
  if (path.endsWith(".gz")) return gzipSync(data, { level: 9 });
  if (path.endsWith(".br")) {
    return brotliCompressSync(data, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: data.length,
      },
    });
  }
  return data;
}

export function decompressFor(path: string, data: Buffer): string {
  if (path.endsWith(".gz")) return gunzipSync(data).toString("utf8");
  if (path.endsWith(".br")) return brotliDecompressSync(data).toString("utf8");
  return data.toString("utf8");
}

/** Reads a tape file: a plain `*.tape.json` or a compact `*.tape.json.{gz,br}`. */
export function readTapeFile(path: string): ArchiveTape & Record<string, unknown> {
  const parsed = JSON.parse(decompressFor(path, readFileSync(path))) as (ArchiveTape | CompactTape) & Record<string, unknown>;
  return parsed.format === COMPACT_TAPE_FORMAT
    ? decodeTape(parsed as CompactTape)
    : parsed as ArchiveTape & Record<string, unknown>;
}

/** Reads any JSON fixture file of this folder, compressed or not. */
export function readJsonFile<T>(path: string): T {
  return JSON.parse(decompressFor(path, readFileSync(path))) as T;
}

/** A tape restricted to `heights` (taken from one or more tapes of the same network). */
export function sliceTapes(tapes: readonly ArchiveTape[], heights: readonly number[], comment = ""): ArchiveTape {
  const byHeight = new Map<number, TapeBlock>();
  for (const t of tapes) for (const b of t.blocks) byHeight.set(b.height, b);
  const first = tapes[0];
  if (first === undefined) throw new Error("sliceTapes needs at least one tape");
  const blocks = heights.map((h) => {
    const b = byHeight.get(h);
    if (b === undefined) throw new Error(`no recorded block at height ${h}`);
    return b;
  });
  return { ...first, $comment: comment, heights: [...heights], blocks } as ArchiveTape;
}

/** `714501,714557-714559` -> sorted unique heights (inclusive ranges, at most 2 001 per range). */
export function parseHeights(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",").map((p) => p.trim()).filter((p) => p !== "")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (m === null) throw new Error(`bad height spec ${JSON.stringify(part)}`);
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (hi < lo || hi - lo > 2_000) throw new Error(`bad or too large range ${part}`);
    for (let h = lo; h <= hi; h++) out.add(h);
  }
  return [...out].sort((a, b) => a - b);
}
