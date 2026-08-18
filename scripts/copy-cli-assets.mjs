#!/usr/bin/env node
/**
 * Copy the CLI's non-TypeScript runtime assets into `dist-cli`.
 *
 * `tsc` emits only compiled TypeScript, so the committed runtime-metadata captures
 * (`chain-archive-sync/metadata-captures/*.scale`, plus their `SHA256SUMS`) do not reach the
 * build output on their own. They are read at runtime via
 * `readFileSync(new URL("./<file>", import.meta.url))` -- i.e. resolved next to the MODULE -- so
 * without this step the built CLI throws ENOENT the moment it needs a capture, and only for
 * runtimes whose metadata it cannot fetch live. A packed artifact would look fine until exactly
 * the situation the captures exist for.
 */
import { cpSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(repoRoot, "chain-archive-sync", "metadata-captures");
const to = join(repoRoot, "dist-cli", "chain-archive-sync", "metadata-captures");

if (!existsSync(to)) {
  console.error(`copy-cli-assets: ${to} does not exist -- run \`tsc -p tsconfig.cli.json\` first.`);
  process.exit(1);
}

let copied = 0;
for (const name of readdirSync(from)) {
  if (name.endsWith(".ts")) continue; // compiled by tsc, not an asset
  cpSync(join(from, name), join(to, name), { recursive: true });
  copied += 1;
}

if (copied === 0) {
  console.error("copy-cli-assets: copied nothing; expected at least the .scale captures.");
  process.exit(1);
}
console.log(`copy-cli-assets: copied ${copied} runtime asset(s) into dist-cli.`);
