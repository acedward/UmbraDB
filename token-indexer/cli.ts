/**
 * Project 00020 — the token indexer's CLI (spec §6.6).
 *
 * ```
 * npm run token-indexer -- migrate                       apply the token_index lineage + seeds
 * npm run token-indexer -- status                        print cursors, counters and the archive tip
 * npm run token-indexer -- rebuild                       drop this net's derived rows and re-seed
 * npm run token-indexer -- derive-color <address> <domainSep>
 *                                                        debug: the colour of one (address, domainSep)
 * ```
 *
 * `backfill-results` (spec FR-002) and `serve` (spec §5/§6.6) are added by this sub-plan's
 * Phases 2 and 6 respectively; every command is dispatched from `runCli` so the tests drive the
 * same code path the binary does.
 *
 * Environment: see `token-indexer/config.ts`. `derive-color` needs no database at all.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "../src/postgres/client.js";
import { jsonLog } from "../wallet-monitor/log.js";
import { bootstrapTokenIndexSchema, rebuildTokenIndex } from "./bootstrap.js";
import { loadConfig, type TokenIndexerConfig } from "./config.js";
import { tokenColorHex } from "./color.js";
import { readStatus } from "./ingest/store.js";

const USAGE = [
  "usage: token-indexer <command>",
  "",
  "  migrate                              apply the token_index lineage and seed NIGHT/DUST",
  "  status                               print cursors, counters and the archive tip",
  "  rebuild                              delete this net's derived rows and re-seed the built-ins",
  "  derive-color <addressHex> <domainSepHex>",
  "",
].join("\n");

/** One client, one schema — `search_path` is set to the token schema so an unqualified name in a
 *  future query cannot silently resolve against `public`. Every statement in this project is
 *  schema-qualified anyway. */
function openClient(config: TokenIndexerConfig) {
  return createClient({ connectionString: config.pgUrl, schema: config.schema });
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }

  if (command === "derive-color") {
    const [address, domainSep] = rest;
    if (address === undefined || domainSep === undefined) {
      process.stderr.write("derive-color needs <addressHex> <domainSepHex>\n");
      return 1;
    }
    process.stdout.write(`${tokenColorHex(domainSep, address)}\n`);
    return 0;
  }

  const config = loadConfig();

  switch (command) {
    case "migrate": {
      const sql = openClient(config);
      try {
        await bootstrapTokenIndexSchema(sql, { schema: config.schema, net: config.net });
        jsonLog("token-indexer", "migrated", { schema: config.schema, net: config.net });
      } finally {
        await sql.end({ timeout: 5 });
      }
      return 0;
    }
    case "status": {
      const sql = openClient(config);
      try {
        const status = await readStatus(sql, config);
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      } finally {
        await sql.end({ timeout: 5 });
      }
      return 0;
    }
    case "rebuild": {
      const sql = openClient(config);
      try {
        await rebuildTokenIndex(sql, { schema: config.schema, net: config.net });
        jsonLog("token-indexer", "rebuilt", { schema: config.schema, net: config.net });
      } finally {
        await sql.end({ timeout: 5 });
      }
      return 0;
    }
    default:
      process.stderr.write(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
      return 1;
  }
}

/* c8 ignore start — the process entry point; every branch above is exercised through `runCli`. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      jsonLog("token-indexer", "fatal", { error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    },
  );
}
/* c8 ignore stop */
