#!/usr/bin/env node
/**
 * UmbraDB's MIP-0018 conformance run: the vendored runner, unchanged, over
 *   1. the vendored vectors except the eight ids UmbraDB keeps its own versions of, and
 *   2. UmbraDB's own versions of those ids (`./vectors-umbradb`, MIP `274a84f`, per-key tombstones),
 * so each id is run exactly once, from UmbraDB's version when one exists.
 *
 *   node token-indexer/mip0018/run-vectors.ts [--consumer "<cmd>"] [--normative-only] [--notes] [--timeout <ms>]
 *
 * The default consumer is the pure adapter (`./vector-adapter.ts`); the Postgres adapter is passed with `--consumer`.
 * Exit status: 0 when both runs pass every normative vector, otherwise the larger runner exit status.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const VENDORED_VECTORS_DIR = join(HERE, "..", "vendor", "mip0018", "vectors");
export const UMBRADB_VECTORS_DIR = join(HERE, "vectors-umbradb");
export const RUNNER = join(VENDORED_VECTORS_DIR, "tools", "run.ts");
export const PURE_ADAPTER = join(HERE, "vector-adapter.ts");

interface ManifestEntry {
  id: string;
  normative: boolean;
}

function manifestIds(dir: string): ManifestEntry[] {
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { vectors: ManifestEntry[] };
  return m.vectors.map((v) => ({ id: v.id, normative: v.normative }));
}

/** The two selections: vendored ids minus UmbraDB's own ids, and UmbraDB's own ids. */
export function vectorSets(): { reference: ManifestEntry[]; overridden: string[]; umbradb: ManifestEntry[] } {
  const umbradb = manifestIds(UMBRADB_VECTORS_DIR);
  const own = new Set(umbradb.map((v) => v.id));
  const vendored = manifestIds(VENDORED_VECTORS_DIR);
  const missing = [...own].filter((id) => !vendored.some((v) => v.id === id));
  if (missing.length > 0) throw new Error(`UmbraDB vectors without a vendored counterpart: ${missing.join(", ")}`);
  return { reference: vendored.filter((v) => !own.has(v.id)), overridden: [...own], umbradb };
}

function main(argv: string[]): number {
  let consumer = `${JSON.stringify(process.execPath)} ${JSON.stringify(PURE_ADAPTER)}`;
  const pass: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--consumer") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--consumer needs a value");
      consumer = v;
    } else if (a === "--normative-only" || a === "--notes") pass.push(a);
    else if (a === "--timeout") {
      // Per-request timeout of the vendored runner (its default is 10 s). The Postgres adapter migrates a fresh
      // schema per request, which can exceed 10 s on a loaded host; a late reply then reads as "unexpected output".
      const v = argv[++i];
      if (v === undefined || !/^[1-9][0-9]*$/.test(v)) throw new Error("--timeout needs a positive integer (ms)");
      pass.push(a, v);
    } else throw new Error(`unknown argument: ${String(a)}`);
  }
  const sets = vectorSets();
  const runs: Array<{ label: string; args: string[] }> = [
    { label: `reference vectors (vendored), without ${sets.overridden.join(", ")}`, args: ["--only", sets.reference.map((v) => v.id).join(",")] },
    { label: "UmbraDB's own versions (MIP 274a84f)", args: ["--dir", UMBRADB_VECTORS_DIR] },
  ];
  let status = 0;
  for (const run of runs) {
    console.log(`\n== ${run.label}`);
    const r = spawnSync(process.execPath, [RUNNER, "--consumer", consumer, ...run.args, ...pass], { stdio: "inherit" });
    status = Math.max(status, r.status ?? 2);
  }
  return status;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`run-vectors: ${(e as Error).message}`);
    process.exitCode = 2;
  }
}
