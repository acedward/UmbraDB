// Shared constants and file helpers for the vector tools.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the `vectors/` folder. */
export const VECTORS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The pinned MIP text every vector implements (Q12: link the PR, pin the commit and its SHA-256). */
export const MIP = {
  id: 'MIP-0018',
  repository: 'midnightntwrk/midnight-improvement-proposals',
  commit: '78ecbb4b1ba57371e84fe45f705991ab7b996a61',
  path: 'mips/mip-0018-on-chain-token-metadata.md',
  sha256: 'b9092746ecf5660496535688a2dea152eb23d932b6eeb6b5a182c23426eec1a1',
  url: 'https://github.com/midnightntwrk/midnight-improvement-proposals/blob/78ecbb4b1ba57371e84fe45f705991ab7b996a61/mips/mip-0018-on-chain-token-metadata.md',
  pr: 'https://github.com/midnightntwrk/midnight-improvement-proposals/pull/340',
} as const;

export const FORMAT = 'mip0018-vectors/1';

/** Folders (relative to VECTORS_DIR) whose files are covered by SHA256SUMS, plus the manifest. */
export const PINNED_ROOTS = ['schema', 'payload', 'state', 'informative'] as const;
export const SUMS_FILE = 'SHA256SUMS';
export const MANIFEST_FILE = 'manifest.json';

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Every file below `dir` (relative to VECTORS_DIR, POSIX separators), sorted. Missing folders yield nothing. */
export function listFiles(dir: string, base: string = VECTORS_DIR): string[] {
  const abs = join(base, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const rel = `${dir}/${name}`;
    const st = statSync(join(base, rel));
    if (st.isDirectory()) out.push(...listFiles(rel, base));
    else if (st.isFile()) out.push(rel);
  }
  return out.sort();
}

export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

export function relToVectors(absPath: string): string {
  return toPosix(relative(VECTORS_DIR, absPath));
}

/** Parses SHA256SUMS (`<64 hex>  <path>` per line, as written by `sha256sum`). */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m || m[1] === undefined || m[2] === undefined) throw new Error(`malformed SHA256SUMS line: ${line}`);
    out.set(m[2], m[1]);
  }
  return out;
}

/** Checks SHA256SUMS against the files on disk. Returns a list of problems (empty = intact). */
export function verifySums(base: string = VECTORS_DIR): string[] {
  const problems: string[] = [];
  let sums: Map<string, string>;
  try {
    sums = parseSums(readFileSync(join(base, SUMS_FILE), 'utf8'));
  } catch (e) {
    return [`cannot read ${SUMS_FILE}: ${(e as Error).message}`];
  }
  const onDisk = [...PINNED_ROOTS.flatMap((r) => listFiles(r, base)), MANIFEST_FILE];
  for (const rel of onDisk) {
    const expected = sums.get(rel);
    if (expected === undefined) {
      problems.push(`not listed in ${SUMS_FILE}: ${rel}`);
      continue;
    }
    let actual: string;
    try {
      actual = sha256Hex(readFileSync(join(base, rel)));
    } catch {
      problems.push(`missing file: ${rel}`);
      continue;
    }
    if (actual !== expected) problems.push(`hash mismatch: ${rel}`);
  }
  for (const rel of sums.keys()) if (!onDisk.includes(rel)) problems.push(`listed but missing: ${rel}`);
  return problems;
}
