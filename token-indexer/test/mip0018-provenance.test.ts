/**
 * Provenance of the vendored MIP-0018 reference files (`token-indexer/vendor/mip0018/`).
 *
 * `SOURCE.md` lists every vendored file with the SHA-256 of its upstream bytes at the pinned commit. This test
 * recomputes each hash and fails on a modified, missing or unlisted file, so a vendored file can only change through
 * a deliberate re-vendor that also updates `SOURCE.md`.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { verifySums } from "../vendor/mip0018/vectors/tools/common.ts";

const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "mip0018");
const PINNED_COMMIT = "daec1f19747b09f4e245885ab0dd9ecc789a82ce";

interface Row {
  path: string;
  upstream: string;
  sha256: string;
}

/** The `| \`path\` | \`upstream\` | \`sha256\` |` rows of SOURCE.md's file table. */
function parseSourceRows(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    const m = /^\| `([^`]+)` \| `([^`]+)` \| `([0-9a-f]{64})` \|$/.exec(line);
    if (m !== null) rows.push({ path: m[1] as string, upstream: m[2] as string, sha256: m[3] as string });
  }
  return rows;
}

function filesBelow(root: string, dir: string = root): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...filesBelow(root, abs));
    else out.push(relative(root, abs).split(sep).join("/"));
  }
  return out;
}

/** Every problem with the vendored tree at `dir` (empty = intact). */
function checkProvenance(dir: string): string[] {
  const problems: string[] = [];
  const rows = parseSourceRows(readFileSync(join(dir, "SOURCE.md"), "utf8"));
  if (rows.length === 0) return ["SOURCE.md lists no files"];
  const onDisk = new Set(filesBelow(dir).filter((p) => p !== "SOURCE.md"));
  const listed = new Set<string>();
  for (const row of rows) {
    if (listed.has(row.path)) problems.push(`listed twice: ${row.path}`);
    listed.add(row.path);
    if (!onDisk.has(row.path)) {
      problems.push(`listed but missing: ${row.path}`);
      continue;
    }
    const actual = createHash("sha256").update(readFileSync(join(dir, row.path))).digest("hex");
    if (actual !== row.sha256) problems.push(`hash mismatch: ${row.path}`);
  }
  for (const p of onDisk) if (!listed.has(p)) problems.push(`not listed in SOURCE.md: ${p}`);
  return problems;
}

describe("vendored MIP-0018 reference files", () => {
  const scratch: string[] = [];
  afterAll(() => {
    for (const d of scratch) rmSync(d, { recursive: true, force: true });
  }, 60_000);

  it("[[mip0018.vendor.provenance]] every vendored file equals its SHA-256 in SOURCE.md and none is unlisted", () => {
    const text = readFileSync(join(VENDOR_DIR, "SOURCE.md"), "utf8");
    expect(text).toContain(PINNED_COMMIT);
    expect(checkProvenance(VENDOR_DIR)).toEqual([]);
    const rows = parseSourceRows(text);
    expect(rows.some((r) => r.path === "codec/src/decode.ts")).toBe(true);
    expect(rows.some((r) => r.path === "LICENSE")).toBe(true);
    expect(rows.some((r) => r.path === "vectors/tools/run.ts")).toBe(true);
    expect(rows.some((r) => r.path === "vectors/manifest.json")).toBe(true);
  }, 60_000);

  it("[[mip0018.vendor.vector-sums]] the vendored vectors pass their own SHA256SUMS (as the runner checks before a run)", () => {
    expect(verifySums(join(VENDOR_DIR, "vectors"))).toEqual([]);
  }, 60_000);

  it("a single modified byte, a removed file and an unlisted file are each reported", () => {
    const copy = mkdtempSync(join(tmpdir(), "mip0018-provenance-"));
    scratch.push(copy);
    cpSync(VENDOR_DIR, copy, { recursive: true });
    const target = join(copy, "codec", "src", "decode.ts");
    const bytes = readFileSync(target);
    bytes[0] = (bytes[0] as number) ^ 0x01;
    writeFileSync(target, bytes);
    rmSync(join(copy, "NOTICE"));
    writeFileSync(join(copy, "codec", "src", "extra.ts"), "export {};\n");
    expect(checkProvenance(copy).sort()).toEqual(
      ["hash mismatch: codec/src/decode.ts", "listed but missing: NOTICE", "not listed in SOURCE.md: codec/src/extra.ts"].sort(),
    );
  }, 60_000);
});
