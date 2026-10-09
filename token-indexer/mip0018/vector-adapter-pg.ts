#!/usr/bin/env node
/**
 * UmbraDB's Postgres MIP-0018 vector adapter: the runner contract of the vendored vectors answered through the REAL
 * store — every request gets a fresh `mip0018` schema (the lineage's migrations), its events go through the production
 * write path (`fields.ts` `writeEvents`: event log + per-key latest-value rows, in a transaction), a rollback through
 * the production recompute (`removeEventsAbove`, the one `Mip0018Scanner.removeAbove` uses), and the answer is read
 * back with the read helpers the API serves (`metadata.ts` `listIdentities`, `listGroups`, `displayAmountOf`;
 * `events.ts` `listEvents`). Request parsing and the response shapes are the pure adapter's (`vector-adapter.ts`), so
 * the two adapters differ only in where the state lives.
 *
 * - `decode`: the event is written to the log of a fresh schema at (block 1, tx 0, event 0) of a placeholder contract
 *   and read back; the result and reason are the stored row's, the header and records of an accepted event are decoded
 *   by the codec from the STORED (zero-extended) bytes. `offset` (informative) is given when the stored bytes
 *   reproduce the stored reason (not for a payload longer than 256 bytes, which is stored empty).
 * - `state`: steps applied in order, one transaction per step; identities and groups read per network.
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
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { openPgliteClient } from "../../src/postgres/pglite-sql.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { mip0018Migrations } from "../../src/postgres/migrations/mip0018/index.js";
import { classifyEvent } from "../vendor/mip0018/codec/src/index.ts";
import { listEvents } from "./events.ts";
import { observedEventRow, removeEventsAbove, writeEvents } from "./fields.ts";
import { displayAmountOf, listGroups, listIdentities } from "./metadata.ts";
import { type IdentityState, type SymbolGroup } from "./state.ts";
import { decodeInput, decodeResponse, type Json, stateInput, stateResponse } from "./vector-adapter.ts";

/** Network and contract of a `decode` request's event (the payload vectors carry neither). */
export const DECODE_NETWORK = "vectors";
export const DECODE_CONTRACT = "00".repeat(32);

export interface PgVectorConsumerOptions {
  sql: UmbraDBSql;
  /** Prefix of the per-request schemas (`<prefix>_<n>`; default `mip0018_vec`). */
  schemaPrefix?: string;
  /** Keep each request's schema instead of dropping it afterwards (debugging). */
  keepSchemas?: boolean;
}

export interface PgVectorConsumer {
  /** Answers one runner request; never throws (a failure is `{id, error}`). */
  handle(req: unknown): Promise<Json>;
  /** Fresh schemas created so far (one per request). */
  readonly schemasCreated: number;
}

export function createPgVectorConsumer(opts: PgVectorConsumerOptions): PgVectorConsumer {
  const { sql } = opts;
  const prefix = opts.schemaPrefix ?? "mip0018_vec";
  let n = 0;

  /** DROP SCHEMA without its NOTICEs (postgres.js prints notices on stdout, which carries the runner protocol). */
  async function dropSchema(schema: string): Promise<void> {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL client_min_messages = warning`;
      await tx`DROP SCHEMA IF EXISTS ${tx(schema)} CASCADE`;
    });
  }

  async function freshSchema(): Promise<string> {
    const schema = `${prefix}_${n++}`;
    await dropSchema(schema); // a leftover of an earlier run must not pass as "already migrated"
    await runMigrations(sql, { schema, migrations: mip0018Migrations });
    return schema;
  }

  async function decode(req: Json, schema: string): Promise<Json> {
    const input = decodeInput(req);
    const row = observedEventRow({ network: DECODE_NETWORK, position: { block: 1, tx: 0, event: 0 }, contractAddress: DECODE_CONTRACT, ...input });
    await sql.begin((tx) => writeEvents(tx, schema, [row]));
    const stored = await listEvents(sql, DECODE_NETWORK, {}, schema);
    if (stored.length !== 1) throw new Error(`expected one stored event, found ${stored.length}`);
    const e = stored[0]!;
    const again = classifyEvent({ type: e.eventType, name: Buffer.from(e.name, "hex"), payload: Buffer.from(e.payload, "hex") });
    if (e.classification === "accept") {
      if (again.result !== "accept") throw new Error(`stored accepted event does not decode from its stored bytes (${again.result})`);
      if (again.header.kind !== e.kind || Buffer.from(again.header.domainSep).toString("hex") !== e.domainSep)
        throw new Error("stored identity columns differ from the stored payload header");
      return decodeResponse(again);
    }
    if (e.classification === "ignore") return { result: "ignore", reason: e.reason };
    const out: Json = { result: "reject", reason: e.reason };
    if (again.result === "reject" && again.reason === e.reason) out.offset = again.offset;
    return out;
  }

  async function state(req: Json, schema: string): Promise<Json> {
    const { steps, display } = stateInput(req);
    const networks = new Set<string>();
    for (const step of steps) {
      if (step.op === "apply") {
        networks.add(step.event.network);
        const row = observedEventRow(step.event);
        await sql.begin((tx) => writeEvents(tx, schema, [row]));
      } else {
        networks.add(step.network);
        await sql.begin((tx) => removeEventsAbove(tx, schema, step.network, step.toBlock));
      }
    }
    const identities: IdentityState[] = [];
    const groups: SymbolGroup[] = [];
    for (const network of [...networks].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      identities.push(...(await listIdentities(sql, network, {}, schema)));
      groups.push(...(await listGroups(sql, network, {}, schema)));
    }
    const shown = display === undefined
      ? undefined
      : await Promise.all(display.map(async (d) => ({ ...d, shown: await displayAmountOf(sql, d.ref, BigInt(d.raw), schema) })));
    return stateResponse(identities, groups, shown);
  }

  return {
    get schemasCreated() {
      return n;
    },
    async handle(req: unknown): Promise<Json> {
      const id = typeof req === "object" && req !== null && !Array.isArray(req) ? (req as Json).id : undefined;
      let schema: string | undefined;
      try {
        if (typeof req !== "object" || req === null || Array.isArray(req)) throw new Error("request is not a JSON object");
        const r = req as Json;
        if (r.op !== "decode" && r.op !== "state") throw new Error(`unknown op ${String(r.op)}`);
        schema = await freshSchema();
        return { id, ...(r.op === "decode" ? await decode(r, schema) : await state(r, schema)) };
      } catch (e) {
        return { id: id ?? null, error: (e as Error).message };
      } finally {
        if (schema !== undefined && opts.keepSchemas !== true) await dropSchema(schema);
      }
    },
  };
}

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
