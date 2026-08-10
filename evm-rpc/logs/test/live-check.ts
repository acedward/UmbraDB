/**
 * Live verification against the Part A stack. Everything here needs real services, which is why it
 * is a script rather than a vitest case (the automated suites use `fake-indexer.ts`).
 *
 *   set -a; source ../stack/STACK.env; set +a
 *   npx tsx evm-rpc/logs/test/live-check.ts [--migrate] [--watch <unprefixed-contract-hex>]
 *
 * Phases, each reported PASS/FAIL/SKIP:
 *   1. indexer schema — `contractEvents` and `ContractEventFilter` exist with the fields Part C
 *      codes against;
 *   2. query document — the REAL indexer accepts `ingest.ts`'s selection set, every inline fragment
 *      and field name validated against the live schema rather than against the snapshot;
 *   3. migration — `evm_rpc.logs` / `log_cursors` apply alongside A1/A2's existing tables
 *      (`--migrate`; otherwise the tables are only checked for presence);
 *   4. subscription — `graphql-transport-ws` handshake against the real indexer: subprotocol
 *      negotiated, `connection_ack` received, `subscribe` accepted with no GraphQL error;
 *   5. eth_getLogs — served from the live database;
 *   6. eth_subscribe — the WS server binds and answers a real client.
 *
 * Phase 4 is the one thing `fake-indexer.ts` cannot establish: that the wire format Part C speaks is
 * the one the indexer actually speaks.
 *
 * NOT covered without Part D (or the `compact-end-2-end/dapps/events` emitter) deployed: real events
 * flowing end to end. Until a contract emits, there is nothing to map. Run `verify-parity.ts` then.
 */

import { createClient } from "../../../src/postgres/client.js";
import { runMigrations } from "../../../src/postgres/migrate.js";
import { evmRpcMigrations } from "../../../src/postgres/migrations/evm_rpc/index.js";
import { CONTRACT_EVENTS_SUBSCRIPTION } from "../ingest.js";
import { runSubscription } from "../graphql-ws.js";
import { getLogs } from "../get-logs.js";
import { createSubscribeServer } from "../subscribe.js";
import { readCursor } from "../store.js";

const results: Array<{ phase: string; status: "PASS" | "FAIL" | "SKIP"; detail: string }> = [];
const record = (phase: string, status: "PASS" | "FAIL" | "SKIP", detail: string): void => {
  results.push({ phase, status, detail });
  console.log(`[${status}] ${phase} — ${detail}`);
};

const argv = process.argv.slice(2);
const shouldMigrate = argv.includes("--migrate");
const watchIndex = argv.indexOf("--watch");
/** Any address works for phases 1-4: an address with no events still proves the wire format. */
const watchAddress =
  watchIndex >= 0 && argv[watchIndex + 1] !== undefined ? argv[watchIndex + 1]! : "00".repeat(32);

const indexerHttp = process.env.INDEXER_URL ?? "http://127.0.0.1:10001/api/v4/graphql";
const indexerWs = process.env.INDEXER_WS ?? "ws://127.0.0.1:10001/api/v4/graphql/ws";
const pgUrl = process.env.ARCHIVE_PG ?? process.env.PG_URL;
const schema = process.env.EVM_RPC_SCHEMA ?? "evm_rpc";
const wsPort = Number(process.env.EVM_RPC_WS_PORT ?? "10021");

async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(indexerHttp, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as { data?: T; errors?: unknown[] };
  if (body.errors !== undefined && body.errors.length > 0) {
    throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
  }
  if (body.data === undefined) throw new Error("no data");
  return body.data;
}

async function main(): Promise<void> {
  console.log(`live-check: indexer ${indexerHttp}\n            ws       ${indexerWs}\n`);

  // --- phase 1: schema shape ------------------------------------------------------------------
  try {
    const data = await graphql<{
      sub: { fields: { name: string }[] } | null;
      filter: { inputFields: { name: string }[] } | null;
    }>(`{
      sub: __type(name: "Subscription") { fields { name } }
      filter: __type(name: "ContractEventFilter") { inputFields { name } }
    }`);
    const hasSubscription = data.sub?.fields.some((f) => f.name === "contractEvents") === true;
    const filterFields = new Set(data.filter?.inputFields.map((f) => f.name) ?? []);
    const required = ["contractAddress", "types", "fieldPrefixes", "fromBlock", "toBlock", "transactionHash"];
    const missing = required.filter((f) => !filterFields.has(f));
    if (hasSubscription && missing.length === 0) {
      record("1 indexer schema", "PASS", "contractEvents subscription + full ContractEventFilter present");
    } else {
      record(
        "1 indexer schema",
        "FAIL",
        `contractEvents=${String(hasSubscription)}, missing filter fields: ${missing.join(", ") || "none"}`,
      );
    }
  } catch (error) {
    record("1 indexer schema", "FAIL", error instanceof Error ? error.message : String(error));
  }

  // --- phase 2: the real indexer accepts our selection set ------------------------------------
  // The subscription document is reused verbatim with `subscription` swapped for `query`, so what is
  // validated is exactly the field set the ingester sends.
  try {
    const asQuery = CONTRACT_EVENTS_SUBSCRIPTION.replace(
      /^subscription IngestContractEvents\(\$filter: ContractEventFilter!, \$id: Int\)/,
      "query IngestContractEventsAsQuery($filter: ContractEventFilter!, $limit: Int)",
    ).replace("contractEvents(filter: $filter, id: $id)", "contractEvents(filter: $filter, limit: $limit)");
    const data = await graphql<{ contractEvents: unknown[] }>(asQuery, {
      filter: { contractAddress: watchAddress },
      limit: 1,
    });
    record(
      "2 query document",
      "PASS",
      `the live indexer accepted every field and inline fragment (${data.contractEvents.length} event(s) for the probe address)`,
    );
  } catch (error) {
    record("2 query document", "FAIL", error instanceof Error ? error.message : String(error));
  }

  if (pgUrl === undefined) {
    record("3 migration", "SKIP", "no ARCHIVE_PG / PG_URL in the environment");
    record("5 eth_getLogs", "SKIP", "needs a database");
  }

  const sql = pgUrl === undefined ? undefined : createClient({ connectionString: pgUrl, schema });

  try {
    // --- phase 3: migration ---------------------------------------------------------------------
    if (sql !== undefined) {
      try {
        if (shouldMigrate) {
          await runMigrations(sql, { schema, migrations: evmRpcMigrations });
        }
        const tables = await sql<{ table_name: string }[]>`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = ${schema} AND table_name IN ('logs', 'log_cursors', 'address_map')
          ORDER BY table_name
        `;
        const names = tables.map((t) => t.table_name);
        const applied = await sql<{ name: string }[]>`
          SELECT name FROM ${sql(schema)}._migrations ORDER BY name
        `;
        if (names.includes("logs") && names.includes("log_cursors") && names.includes("address_map")) {
          record(
            "3 migration",
            "PASS",
            `logs + log_cursors live alongside A1/A2's tables; applied: ${applied.map((a) => a.name).join(", ")}`,
          );
        } else {
          record("3 migration", "FAIL", `present: ${names.join(", ") || "none"} (re-run with --migrate)`);
        }
      } catch (error) {
        record("3 migration", "FAIL", error instanceof Error ? error.message : String(error));
      }
    }

    // --- phase 4: the real graphql-transport-ws handshake --------------------------------------
    try {
      let connected = false;
      let failure: Error | undefined;
      const handle = runSubscription({
        url: indexerWs,
        request: () => ({
          query: CONTRACT_EVENTS_SUBSCRIPTION,
          operationName: "IngestContractEvents",
          variables: { filter: { contractAddress: watchAddress }, id: 0 },
        }),
        onConnected: () => {
          connected = true;
        },
        onData: () => {},
        onError: (error) => {
          failure ??= error;
        },
        // One attempt only: a reconnect loop would mask a rejection as a retry.
        reconnectDelayMs: () => 1_000_000,
        ackTimeoutMs: 10_000,
      });
      // Give the ack + subscribe round trip time to land, and any GraphQL error time to arrive.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      handle.stop();
      await handle.done.catch(() => {});

      if (connected && failure === undefined) {
        record(
          "4 subscription",
          "PASS",
          "graphql-transport-ws negotiated, connection_ack received, subscribe accepted with no error",
        );
      } else {
        record(
          "4 subscription",
          "FAIL",
          `connected=${String(connected)}${failure === undefined ? "" : `, error: ${failure.message}`}`,
        );
      }
    } catch (error) {
      record("4 subscription", "FAIL", error instanceof Error ? error.message : String(error));
    }

    // --- phase 5: eth_getLogs off the live database --------------------------------------------
    if (sql !== undefined) {
      try {
        const logs = await getLogs({ sql, schema }, [{ fromBlock: "earliest" }]);
        const cursor = await readCursor(sql, schema, Uint8Array.from(Buffer.from(watchAddress, "hex")));
        record(
          "5 eth_getLogs",
          "PASS",
          `served ${logs.length} log(s) from the live database; cursor for the probe address: ${String(cursor)}`,
        );
      } catch (error) {
        record("5 eth_getLogs", "FAIL", error instanceof Error ? error.message : String(error));
      }
    }

    // --- phase 6: the eth_subscribe WS server binds and answers --------------------------------
    try {
      const server = createSubscribeServer({
        port: wsPort,
        sql,
        schema,
        blockPollMs: 500,
      });
      const bound = await server.listen();
      try {
        const socket = new WebSocket(`ws://127.0.0.1:${bound}`);
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener("open", () => resolve());
          socket.addEventListener("error", () => reject(new Error("client could not connect")));
        });
        const reply = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("no eth_subscribe reply")), 5_000);
          socket.addEventListener("message", (event) => {
            clearTimeout(timer);
            resolve(String((event as MessageEvent).data));
          });
          socket.send(
            JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["logs", {}] }),
          );
        });
        const parsed = JSON.parse(reply) as { result?: string };
        socket.close();
        record(
          "6 eth_subscribe",
          parsed.result === undefined ? "FAIL" : "PASS",
          `bound on ${bound}; eth_subscribe returned ${String(parsed.result)}`,
        );
      } finally {
        await server.close();
      }
    } catch (error) {
      record("6 eth_subscribe", "FAIL", error instanceof Error ? error.message : String(error));
    }
  } finally {
    await sql?.end({ timeout: 5 });
  }

  const failed = results.filter((r) => r.status === "FAIL");
  console.log(
    `\nlive-check: ${results.filter((r) => r.status === "PASS").length} passed, ` +
      `${failed.length} failed, ${results.filter((r) => r.status === "SKIP").length} skipped`,
  );
  if (failed.length > 0) process.exit(1);
}

void main().catch((error: unknown) => {
  console.error(`live-check: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
