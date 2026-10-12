import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decompress, readTape, supportsDecompression, tapeCompressionOf } from "../../chain-archive-sync/archive-tape.js";
import { BROWSER_TAPES_FORMAT, type BrowserTapesManifest } from "../../token-indexer/dev/browser-tapes.js";
import { sha256Hex } from "./fixtures/stagenet-archive/archive-digest.js";
import { fixturePath, loadManifest, loadRangeTape } from "./fixtures/stagenet-archive/stagenet-fixtures.js";

/**
 * The gzip copies of the recorded range tapes that a browser reads (`token-indexer/browser/tapes/`; Chrome's
 * `DecompressionStream` has no brotli) are what their manifest says, come from the fixture manifest's brotli tapes, and
 * decode to exactly the same JSON text, also through the runtime-neutral reader. No network, no database.
 */

const DIR = fileURLToPath(new URL("../../token-indexer/browser/tapes/", import.meta.url));

describe("browser copies of the recorded Stagenet tapes", () => {
  it("[[stagenet.fixtures.browser-tapes]] every gzip copy matches its manifest's SHA-256 and size, names its fixture source by the fixture manifest's SHA-256, and decodes to byte-identical JSON (node:zlib and DecompressionStream alike)", async () => {
    const m = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as BrowserTapesManifest;
    expect(m.format).toBe(BROWSER_TAPES_FORMAT);
    expect(m.sourceManifest).toBe("test/integration/fixtures/stagenet-archive/manifest.json");
    const fixtures = loadManifest();
    // One copy per recorded range, and nothing else in the folder.
    expect(m.tapes.map((t) => [t.range, t.source])).toEqual(fixtures.ranges.map((r) => [r.name, r.file]));
    expect(readdirSync(DIR).sort()).toEqual(["manifest.json", ...m.tapes.map((t) => t.path)].sort());
    expect(supportsDecompression("gzip")).toBe(true);

    for (const t of m.tapes) {
      expect(t.path).toBe(t.source.replace(/\.br$/, ".gz"));
      expect(tapeCompressionOf(t.path)).toBe("gzip");
      const gz = readFileSync(join(DIR, t.path));
      expect(gz.length, t.path).toBe(t.bytes);
      expect(sha256Hex(gz), t.path).toBe(t.sha256);

      const source = readFileSync(fixturePath(t.source));
      expect(sha256Hex(source), t.source).toBe(t.sourceSha256);
      expect(fixtures.files.find((f) => f.path === t.source)).toMatchObject({ sha256: t.sourceSha256, bytes: source.length, role: "tape" });

      const json = brotliDecompressSync(source);
      expect(json.length, t.source).toBe(t.json.bytes);
      expect(sha256Hex(json), t.source).toBe(t.json.sha256);
      expect(gunzipSync(gz).equals(json), t.path).toBe(true);
      const viaStream = await decompress(new Uint8Array(gz), "gzip");
      expect(sha256Hex(viaStream), t.path).toBe(t.json.sha256);
      expect(await readTape(new Uint8Array(gz), "gzip"), t.path).toEqual(loadRangeTape(t.range));
    }
  }, 60_000);
});
