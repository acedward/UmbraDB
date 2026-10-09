import type { IndexerBlock } from "./indexer-client.js";
import type { SubstrateBlock } from "./node-rpc-client.js";

/**
 * A recorded archive tape and its file forms, for any runtime: no Node API, so the Node test suite and the browser
 * build read the same tapes with the same code.
 *
 * A tape holds, per height, exactly what the two public endpoints answered the archive sync: the node's
 * `chain_getBlockHash` and `chain_getBlock`, and the indexer's `block(offset: { height })`. The compact form
 * (`umbradb-stagenet-archive-tape/2`) removes the one large redundancy, that every regular transaction appears twice
 * (as the indexer's `raw`, and inside the node extrinsic that carries it): such an extrinsic is stored as
 * `{ tx, pre, post }`, the text before and after the index-`tx` transaction's `raw`. {@link decodeTape} gives back the
 * recorded answers value for value.
 *
 * A tape file is the JSON text of a plain or compact tape, compressed with brotli (`.br`), gzip (`.gz`) or not at
 * all. {@link readTape} decompresses with the platform's `DecompressionStream`: Node reads every form; Chrome has no
 * brotli in `DecompressionStream`, so a browser reads the gzip form.
 */

export interface TapeBlock {
  height: number;
  blockHash: string;
  nodeBlock: SubstrateBlock;
  indexerBlock: IndexerBlock;
}

export interface ArchiveTape {
  network: string;
  genesisHash: string;
  heights: number[];
  blocks: TapeBlock[];
}

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

/** The recorded tape of a compact tape: every extrinsic reference replaced by the text it stands for. */
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

/** A tape from its JSON text: a plain tape as it is, a compact tape decoded. */
export function parseTape(text: string): ArchiveTape & Record<string, unknown> {
  const parsed = JSON.parse(text) as (ArchiveTape | CompactTape) & Record<string, unknown>;
  return parsed.format === COMPACT_TAPE_FORMAT
    ? decodeTape(parsed as CompactTape)
    : parsed as ArchiveTape & Record<string, unknown>;
}

/** How a tape file is compressed. */
export type TapeCompression = "brotli" | "gzip" | "none";

/** The compression a file name says: `.br` brotli, `.gz` gzip, anything else none. */
export function tapeCompressionOf(fileName: string): TapeCompression {
  if (fileName.endsWith(".br")) return "brotli";
  if (fileName.endsWith(".gz")) return "gzip";
  return "none";
}

/** Whether this runtime's `DecompressionStream` reads `format` (Chrome: gzip only of the two; Node 24: both). */
export function supportsDecompression(format: Exclude<TapeCompression, "none">): boolean {
  try {
    new DecompressionStream(format as CompressionFormat);
    return true;
  } catch {
    return false;
  }
}

/** The bytes of a file decompressed as `compression` says, with the platform's `DecompressionStream`. */
export async function decompress(data: Uint8Array, compression: TapeCompression): Promise<Uint8Array> {
  if (compression === "none") return data;
  const input = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(new Uint8Array(data));
      controller.close();
    },
  });
  const reader = input.pipeThrough(new DecompressionStream(compression as CompressionFormat)).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** UTF-8 as the Node readers read a file: a byte-order mark is kept, an invalid sequence becomes U+FFFD. */
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** A tape from the bytes of a tape file (plain or compact JSON, compressed as `compression` says). */
export async function readTape(data: Uint8Array, compression: TapeCompression): Promise<ArchiveTape & Record<string, unknown>> {
  return parseTape(utf8.decode(await decompress(data, compression)));
}
