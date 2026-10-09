/**
 * `serve` of the MIP-0018 token indexer: the read-only JSON API (`api.ts`, contract `token-indexer/API.md`) over the
 * existing Postgres and — unless `--api-only` — the MIP-0018 scan loop following the chain archive's cursor, in one
 * process. Both run in the indexer engine (`../engine/engine.ts`); this file parses the arguments, opens the database,
 * serves the engine's API over `node:http` (`api-node.ts`, with the explorer page) and prints the engine's events.
 *
 *   PG_URL=postgres://… node --import tsx token-indexer/mip0018/serve-cli.ts --network stagenet
 *     [--host 127.0.0.1] [--port 10026] [--schema mip0018] [--archive-schema chain_archive] [--api-only]
 *     [--from <height>] [--scan-batch 100] [--scan-idle-ms 2000] [--genesis 0x…]
 *
 * The chain archive is filled by `chain-archive-sync/sync-cli.ts` (finalized blocks, `--from/--to` ranges or the
 * tip); `serve` scans what is archived and answers the API. The scan loop runs in the serving process by default, so
 * one command keeps the API current while the archive grows; the scan's cursor moves by compare-and-set, so a second
 * scanner of the same network (another `serve`, or `scan-cli.ts`) fails instead of interleaving. A scan error (an
 * undecodable transaction stops the scan at its block) is logged and retried with back-off while the API keeps
 * serving; `/v1/status` reports `scanner: stalled`. `--api-only` runs no scan and no migration (read-only; the schema
 * must exist). The API answers at most 8 requests at once (503 `BUSY` beyond), below the connection pool's 10, so API
 * load cannot take every connection from the scan loop of the same process; a public deployment can also serve from
 * `--api-only` replicas.
 *
 * | Flag | Environment | Default |
 * |---|---|---|
 * | — | `PG_URL` | *(required)* Postgres connection string |
 * | `--network` | `NET` | *(required)* network id of the archive and the scan (`stagenet`) |
 * | `--host` | `MIP0018_API_HOST` | `127.0.0.1` |
 * | `--port` | `MIP0018_API_PORT` | `10026` (`0` = any free port; the bound port is logged) |
 * | `--schema` | `MIP0018_SCHEMA` | `mip0018` |
 * | `--archive-schema` | `ARCHIVE_SCHEMA` | `chain_archive` |
 * | `--genesis` | `GENESIS_HASH` | the known network's genesis hash (Stagenet), else none |
 * | `--from` | `START_HEIGHT` | the archive's first height (first scan only) |
 * | `--scan-batch` | — | `100` blocks per scan step |
 * | `--scan-idle-ms` | — | `2000` (wait at the archive's tip; also the base of the error back-off, ×5 up to 60 s); 100 to 3 600 000 — below 100 ms the loop would poll the database and the log in a hot loop |
 *
 * Logs one JSON line per event on stdout (`listening`, `scan`, `scan-error`, `stopped`). SIGINT/SIGTERM stop the
 * loop and the server and exit 0.
 */
import type { Server } from "node:http";
import { parseArgs } from "node:util";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { createIndexerEngine, type EngineEvent, type IndexerEngine } from "../engine/engine.ts";
import { createMip0018Server, listen } from "./api-node.ts";
import type { ScannerState } from "./api-views.ts";
import { serveUi } from "./ui/page.ts";

export interface ServeOptions {
  sql: UmbraDBSql;
  network: string;
  host?: string;
  port?: number;
  schema?: string;
  archiveSchema?: string;
  genesisHash?: string | null;
  apiOnly?: boolean;
  fromHeight?: number;
  scanBatch?: number;
  scanIdleMs?: number;
  log?: (line: string) => void;
}

export interface ServeHandle {
  host: string;
  port: number;
  server: Server;
  /** The engine behind the server: the scan loop and the API handler the server answers with. */
  engine: IndexerEngine;
  scannerState(): ScannerState;
  stop(): Promise<void>;
}

/** Smallest `--scan-idle-ms` the CLI accepts (0 made the idle wait and the error back-off a hot loop). */
export const MIN_SCAN_IDLE_MS = 100;

/** The engine's events as `serve` prints them: `scan` and `scan-error` lines on `log`, the API's error lines on stderr. */
function serveLines(log: (line: string) => void, apiLog: (line: string) => void): (e: EngineEvent) => void {
  return (e) => {
    if (e.source === "scan" && e.event === "batch") {
      const r = e.fields;
      if (r.scannedBlocks > 0) log(JSON.stringify({ event: "scan", from: r.fromHeight, to: r.toHeight, transactions: r.transactions, mints: r.mints, events: r.events }));
    } else if (e.source === "scan" && e.event === "error") {
      log(JSON.stringify({ event: "scan-error", error: e.fields.error, failures: e.fields.failures }));
    } else if (e.source === "api" && e.event === "log") {
      apiLog(e.fields.line);
    }
  };
}

/** Starts the API (and the scan loop unless `apiOnly`); resolves once the port is bound. */
export async function serve(o: ServeOptions): Promise<ServeHandle> {
  // Programmatic callers (tests) may poll faster than the CLI's minimum, but never with a zero or negative wait.
  if (o.scanIdleMs !== undefined && (!Number.isSafeInteger(o.scanIdleMs) || o.scanIdleMs < 1))
    throw new RangeError(`scanIdleMs must be a positive integer of milliseconds, got ${o.scanIdleMs}`);
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const host = o.host ?? "127.0.0.1";
  const engine = createIndexerEngine({
    sql: o.sql, network: o.network,
    ...(o.schema === undefined ? {} : { schema: o.schema }),
    ...(o.archiveSchema === undefined ? {} : { archiveSchema: o.archiveSchema }),
    ...(o.genesisHash === undefined ? {} : { genesisHash: o.genesisHash }),
    ...(o.apiOnly === true ? {} : {
      scan: {
        ...(o.fromHeight === undefined ? {} : { fromHeight: o.fromHeight }),
        ...(o.scanBatch === undefined ? {} : { batch: o.scanBatch }),
        ...(o.scanIdleMs === undefined ? {} : { idleMs: o.scanIdleMs }),
      },
    }),
    onEvent: serveLines(log, (line) => process.stderr.write(`${line}\n`)),
  });
  await engine.start();

  const server = createMip0018Server(engine, serveUi); // the explorer page at /ui (it reads only this API)
  let port: number;
  try {
    port = await listen(server, o.port ?? 10026, host);
  } catch (e) {
    await engine.stop();
    throw e;
  }
  log(JSON.stringify({ event: "listening", host, port, scanner: engine.scannerState() }));
  return {
    host, port, server, engine,
    scannerState: () => engine.scannerState(),
    async stop() {
      const stopped = engine.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await stopped;
    },
  };
}

function intOption(raw: string | undefined, what: string, max = Number.MAX_SAFE_INTEGER, min = 0): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) > max || Number(raw) < min) throw new Error(`${what} must be an integer from ${min} to ${max}`);
  return Number(raw);
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      network: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      schema: { type: "string" },
      "archive-schema": { type: "string" },
      genesis: { type: "string" },
      from: { type: "string" },
      "api-only": { type: "boolean", default: false },
      "scan-batch": { type: "string" },
      "scan-idle-ms": { type: "string" },
    },
    strict: true,
  });
  const url = env.PG_URL;
  const network = values.network ?? env.NET;
  if (url === undefined || url === "" || network === undefined || network === "")
    throw new Error("usage: PG_URL=… serve-cli.ts --network <net> [--host H] [--port P] [--api-only] (see the file header)");
  const genesis = values.genesis ?? env.GENESIS_HASH;
  if (genesis !== undefined && !/^0x[0-9a-f]{64}$/.test(genesis)) throw new Error("--genesis must be 0x followed by 64 lowercase hex digits");
  const schema = values.schema ?? env.MIP0018_SCHEMA ?? "mip0018";
  const sql = createClient({ connectionString: url, schema });
  const from = intOption(values.from ?? env.START_HEIGHT, "--from");
  const batch = intOption(values["scan-batch"], "--scan-batch", 10_000);
  const idle = intOption(values["scan-idle-ms"], "--scan-idle-ms", 3_600_000, MIN_SCAN_IDLE_MS);
  let handle: ServeHandle | undefined;
  try {
    handle = await serve({
      sql, network, schema, log,
      host: values.host ?? env.MIP0018_API_HOST ?? "127.0.0.1",
      port: intOption(values.port ?? env.MIP0018_API_PORT, "--port", 65_535) ?? 10026,
      archiveSchema: values["archive-schema"] ?? env.ARCHIVE_SCHEMA ?? "chain_archive",
      apiOnly: values["api-only"],
      ...(genesis === undefined ? {} : { genesisHash: genesis }),
      ...(from === undefined ? {} : { fromHeight: from }),
      ...(batch === undefined ? {} : { scanBatch: Math.max(1, batch) }),
      ...(idle === undefined ? {} : { scanIdleMs: idle }),
    });
    const h = handle;
    await new Promise<void>((resolve) => {
      const stop = (): void => resolve();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      h.server.once("close", stop);
    });
    await handle.stop();
    log(JSON.stringify({ event: "stopped" }));
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1]?.endsWith("serve-cli.ts")) {
  process.exitCode = await main(process.argv.slice(2));
}
