/**
 * The copied Stagenet case expectations (`token-indexer/test/fixtures/mip0018-cases/`) and their provenance table,
 * `SOURCE.md`: every copy with the SHA-256 of its upstream bytes at the pinned reference commit, plus upstream files
 * that are compared but not copied (first column `—`).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CASES_DIR = new URL("../fixtures/mip0018-cases/", import.meta.url);
const CASES_PATH = fileURLToPath(CASES_DIR);

export interface CaseSourceRow {
  /** Path in the fixture folder, or `undefined` for an upstream file that is not copied. */
  path: string | undefined;
  upstream: string;
  sha256: string;
}

/** The pinned commit and the file rows of `SOURCE.md`. */
export function caseSource(): { commit: string; rows: CaseSourceRow[] } {
  const text = readFileSync(join(CASES_PATH, "SOURCE.md"), "utf8");
  const commit = /\| Pinned at \| \*\*`([0-9a-f]{40})`\*\* \|/.exec(text)?.[1];
  if (commit === undefined) throw new Error("SOURCE.md names no pinned commit");
  const rows: CaseSourceRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\| (?:`([^`]+)`|—) \| `([^`]+)` \| `([0-9a-f]{64})` \|$/.exec(line);
    if (m !== null) rows.push({ path: m[1], upstream: m[2] as string, sha256: m[3] as string });
  }
  return { commit, rows };
}

/** The upstream SHA-256 `SOURCE.md` records for a reference path (`deployments/stagenet/cases/…`). */
export function upstreamSha(upstream: string): string | undefined {
  return caseSource().rows.find((r) => r.upstream === upstream)?.sha256;
}

function jsonFilesBelow(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...jsonFilesBelow(abs));
    else if (name.endsWith(".json")) out.push(relative(CASES_PATH, abs).split(sep).join("/"));
  }
  return out;
}

/** Every problem with the copies (empty = each listed copy has its recorded bytes and no copy is unlisted). */
export function caseCopyProblems(): string[] {
  const problems: string[] = [];
  const { rows } = caseSource();
  const listed = new Set<string>();
  for (const r of rows) {
    if (r.path === undefined) continue;
    listed.add(r.path);
    if (r.upstream !== `deployments/stagenet/cases/${r.path}`) problems.push(`not its upstream path: ${r.path}`);
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(CASES_PATH, r.path));
    } catch {
      problems.push(`listed but missing: ${r.path}`);
      continue;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== r.sha256) problems.push(`hash mismatch: ${r.path}`);
  }
  for (const p of jsonFilesBelow(CASES_PATH)) if (!listed.has(p)) problems.push(`not listed in SOURCE.md: ${p}`);
  return problems;
}
