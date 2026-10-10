#!/usr/bin/env node
/**
 * UmbraDB's Postgres MIP-0018 vector adapter: the runner contract of the vendored vectors over stdin/stdout, answered
 * through the REAL store by the database consumer of `./vector-consumer-pg.ts` (`createPgVectorConsumer`: a fresh
 * `mip0018` schema per request, the production write path and the read helpers the API serves). Request parsing and
 * the response shapes are the pure adapter's (`vector-adapter.ts`), so the two adapters differ only in where the state
 * lives.
 *
 *   PG_URL=postgres://… node token-indexer/mip0018/run-vectors.ts --consumer "node --import tsx token-indexer/mip0018/vector-adapter-pg.ts"
 *   node token-indexer/mip0018/run-vectors.ts --consumer "node --import tsx token-indexer/mip0018/vector-adapter-pg.ts --pglite"
 *
 * (`--pglite`: the process answers from its own in-memory PGlite database, through the PGlite client with its
 * defaults, `src/postgres/pglite-sql.ts`.)
 *
 * (`--import tsx`: like `chain-archive-sync/sync-cli.ts`, this file imports `src/` modules by their `.js` names.)
 */
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createClient } from "../../src/postgres/client.js";
import { openPgliteClient } from "../../src/postgres/pglite-sql.js";
import { createPgVectorConsumer } from "./vector-consumer-pg.ts";

export {
  createPgVectorConsumer,
  DECODE_CONTRACT,
  DECODE_NETWORK,
  type PgVectorConsumer,
  type PgVectorConsumerOptions,
} from "./vector-consumer-pg.ts";

/**
 * Runner-contract process: `PG_URL` (or the PG* variables) names the database, or `--pglite` opens an in-memory PGlite
 * database for the process; one JSON request per stdin line, one JSON response per stdout line, strictly in order.
 */
export async function main(env: NodeJS.ProcessEnv = process.env, args: readonly string[] = process.argv.slice(2)): Promise<void> {
  for (const a of args) if (a !== "--pglite") throw new Error(`unknown argument ${a} (usage: vector-adapter-pg.ts [--pglite])`);
  // stdout carries ONLY the protocol's JSON lines: anything logged (e.g. a server NOTICE) goes to stderr.
  console.log = console.error;
  console.info = console.error;
  const sql = args.includes("--pglite")
    ? await openPgliteClient({ schema: "mip0018_vec" })
    : createClient({ ...(env.PG_URL === undefined ? {} : { connectionString: env.PG_URL }), schema: "mip0018_vec" });
  const consumer = createPgVectorConsumer({ sql, schemaPrefix: env.MIP0018_VECTOR_SCHEMA_PREFIX ?? `mip0018_vec_${process.pid}` });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      let req: unknown;
      try {
        req = JSON.parse(line);
      } catch (e) {
        process.stdout.write(`${JSON.stringify({ id: null, error: `invalid JSON: ${(e as Error).message}` })}\n`);
        continue;
      }
      process.stdout.write(`${JSON.stringify(await consumer.handle(req))}\n`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: unknown) => {
    console.error(`vector-adapter-pg: ${(e as Error).message}`);
    process.exitCode = 2;
  });
}
