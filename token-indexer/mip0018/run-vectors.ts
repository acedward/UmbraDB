#!/usr/bin/env node
/**
 * UmbraDB's MIP-0018 conformance run: the vendored runner, unchanged, over the vendored vectors.
 *
 *   node token-indexer/mip0018/run-vectors.ts [--consumer "<cmd>"] [--normative-only] [--notes] [--timeout <ms>]
 *
 * The default consumer is the pure adapter (`./vector-adapter.ts`); the Postgres adapter is passed with `--consumer`.
 * Exit status: the vendored runner's (0 when every normative vector passes).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const VENDORED_VECTORS_DIR = join(HERE, "..", "vendor", "mip0018", "vectors");
export const RUNNER = join(VENDORED_VECTORS_DIR, "tools", "run.ts");
export const RUN_VECTORS = fileURLToPath(import.meta.url);
export const PURE_ADAPTER = join(HERE, "vector-adapter.ts");
export const PG_ADAPTER = join(HERE, "vector-adapter-pg.ts");

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
  console.log("\n== reference vectors (vendored)");
  const r = spawnSync(process.execPath, [RUNNER, "--consumer", consumer, ...pass], { stdio: "inherit" });
  return r.status ?? 2;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`run-vectors: ${(e as Error).message}`);
    process.exitCode = 2;
  }
}
