/**
 * The vector consumer's worker: opens a PGlite store on OPFS through the browser engine's own store module
 * (`token-indexer/browser/store.ts`: PGlite with its default start parameters, the PGlite client in the non-durable
 * mode) and answers runner-protocol requests with the database consumer (`createPgVectorConsumer`): a fresh `mip0018`
 * schema per request, the production write path and the read helpers the API serves.
 */
import { openStore } from "../../../browser/store.ts";
import { durabilityModeOf } from "../../../../src/postgres/durability-probe.js";
import { createPgVectorConsumer } from "../../../mip0018/vector-consumer-pg.ts";

const DATA_DIR = "opfs-ahp://umbradb-vector-consumer";
const SCHEMA_PREFIX = "vec_browser";

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<{ id: number; op: string; arg?: unknown }>) => void) | null;
  postMessage(message: unknown): void;
};

const ready = (async () => {
  const store = await openStore(DATA_DIR);
  const sql = store.mip0018;
  const [settings] = await sql<{ version: string; fsync: string }[]>`select version() as version, current_setting('fsync') as fsync`;
  const consumer = createPgVectorConsumer({ sql, schemaPrefix: SCHEMA_PREFIX });
  const info = { dataDir: store.dataDir, created: store.created, version: settings!.version, fsync: settings!.fsync, durability: durabilityModeOf(sql), schemaPrefix: SCHEMA_PREFIX };
  return { sql, consumer, info };
})();

scope.onmessage = async (e) => {
  const { id, op, arg } = e.data;
  try {
    const { sql, consumer, info } = await ready;
    let value: unknown;
    if (op === "info") value = info;
    else if (op === "handle") value = await consumer.handle(arg);
    else if (op === "created") value = consumer.schemasCreated;
    else if (op === "schemas") {
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from pg_namespace where starts_with(nspname, ${String(arg)})`;
      value = row!.n;
    } else throw new Error(`unknown op ${op}`);
    scope.postMessage({ id, ok: true, value });
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
