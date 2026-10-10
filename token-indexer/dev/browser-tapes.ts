/**
 * Writes the gzip copies of the recorded Stagenet range tapes that a browser reads: Chrome's `DecompressionStream` has
 * no brotli, and the range tapes are brotli files. For each range of `test/integration/fixtures/stagenet-archive/
 * manifest.json`, the brotli tape is decompressed and compressed again with gzip (level 9), byte for byte the same
 * JSON text. `manifest.json` beside the copies records, per copy, its size and SHA-256, its source tape and the source's
 * SHA-256, and the size and SHA-256 of the JSON text both files decode to.
 *
 *   node --import tsx token-indexer/dev/browser-tapes.ts [--out token-indexer/browser/tapes]
 *
 * `test/integration/stagenet-browser-tapes.test.ts` checks the copies against that manifest and against their sources.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { brotliDecompressSync, gzipSync } from "node:zlib";
import { sha256Hex } from "../../test/integration/fixtures/stagenet-archive/archive-digest.js";
import { fixturePath, loadManifest } from "../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";

export const BROWSER_TAPES_FORMAT = "umbradb-stagenet-browser-tapes/1";

export interface BrowserTape {
  /** The fixture range (`idx`, `u1`). */
  range: string;
  /** The gzip copy, a file name in this folder. */
  path: string;
  bytes: number;
  sha256: string;
  /** The brotli tape it was made from, a file name in the fixture folder. */
  source: string;
  sourceSha256: string;
  /** The JSON text both files decode to. */
  json: { bytes: number; sha256: string };
}

export interface BrowserTapesManifest {
  format: typeof BROWSER_TAPES_FORMAT;
  $comment: string;
  /** The fixture manifest the sources are listed in (repository path). */
  sourceManifest: string;
  compression: string;
  tapes: BrowserTape[];
}

const REPO = resolve(new URL("../..", import.meta.url).pathname);

function main(): void {
  const { values } = parseArgs({ options: { out: { type: "string", default: "token-indexer/browser/tapes" } } });
  const out = resolve(REPO, values.out);
  mkdirSync(out, { recursive: true });
  const fixtures = loadManifest();
  const tapes = fixtures.ranges.map((range): BrowserTape => {
    const source = readFileSync(fixturePath(range.file));
    const listed = fixtures.files.find((f) => f.path === range.file);
    if (listed === undefined || listed.sha256 !== sha256Hex(source)) throw new Error(`${range.file} does not match the fixture manifest`);
    const json = brotliDecompressSync(source);
    const gz = gzipSync(json, { level: 9 });
    const path = range.file.replace(/\.br$/, ".gz");
    writeFileSync(join(out, path), gz);
    return {
      range: range.name, path, bytes: gz.length, sha256: sha256Hex(gz),
      source: range.file, sourceSha256: listed.sha256, json: { bytes: json.length, sha256: sha256Hex(json) },
    };
  });
  const manifest: BrowserTapesManifest = {
    format: BROWSER_TAPES_FORMAT,
    $comment: "gzip copies of the recorded Stagenet range tapes, for browsers (Chrome's DecompressionStream has no "
      + "brotli). Each copy decodes to exactly the JSON text of its brotli source in the fixture folder. Written by "
      + "token-indexer/dev/browser-tapes.ts; checked by test/integration/stagenet-browser-tapes.test.ts.",
    sourceManifest: relative(REPO, fixturePath("manifest.json")).split("\\").join("/"),
    compression: "gzip, level 9 (node:zlib)",
    tapes,
  };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const t of tapes) console.log(`${t.path}: ${t.bytes} bytes, sha256 ${t.sha256} (JSON ${t.json.bytes} bytes, sha256 ${t.json.sha256})`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();
