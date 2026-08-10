/**
 * A standalone ingester process, for the C-G2 `kill -9` crash test.
 *
 * Spawned by `ingest-crash.test.ts` via `node --import tsx` so that `child.pid` IS this process
 * (no wrapping shell) and the parent's `SIGKILL` is therefore a genuine hard kill of a writer
 * mid-operation — the same primitive `test/postgres/setup.ts`'s `spawnCrashWorker` uses for the
 * durability suites, applied to Part C's write path.
 *
 * Mirrors that helper's sentinel convention so the parent can find its line amid tsx noise.
 */

import { createClient } from "../../../src/postgres/client.js";
import { startIngest } from "../ingest.js";
import type { SqlPool } from "../store.js";
import type { WatchEntry } from "../config.js";
import { CRASH_INGEST_COMMITTED, CRASH_INGEST_READY } from "./crash-sentinels.js";

async function main(): Promise<void> {
  const connectionString = process.env.CRASH_PG_URI;
  const schema = process.env.CRASH_SCHEMA;
  const indexerWs = process.env.CRASH_INDEXER_WS;
  const address = process.env.CRASH_CONTRACT;
  if (!connectionString || !schema || !indexerWs || !address) {
    throw new Error("crash-ingest-worker: CRASH_PG_URI/SCHEMA/INDEXER_WS/CONTRACT are all required");
  }

  const sql = createClient({ connectionString, schema, maxConnections: 2 });
  const entry: WatchEntry = { address, profile: "erc20" };

  const handle = startIngest({
    sql: sql as unknown as SqlPool,
    schema,
    indexerWs,
    contracts: [entry],
    idleFlushMs: Number(process.env.CRASH_IDLE_FLUSH_MS ?? "100"),
    // Every committed batch is announced so the parent can time its kill against real write
    // activity rather than a wall-clock guess.
    onCommitted: (rows) => {
      process.stdout.write(`${CRASH_INGEST_COMMITTED}${rows.length}\n`);
    },
    onConnected: () => {
      process.stdout.write(`${CRASH_INGEST_READY}{"ok":true}\n`);
    },
    onError: () => {
      /* transport drops are the parent's business, not a reason to exit */
    },
  });

  await handle.done;
}

void main().catch((error: unknown) => {
  process.stderr.write(`crash-ingest-worker: ${String(error)}\n`);
  process.exit(1);
});
