/**
 * UmbraDB's database MIP-0018 vector consumer, as a function: the runner contract of the vendored vectors answered
 * in-process through the REAL store, over any `Sql` (PostgreSQL through postgres.js, or the PGlite client, in Node or in
 * a browser worker): every request gets a fresh `mip0018` schema (the lineage's migrations), its events go through the
 * production write path (`fields.ts` `writeEvents`: event log + per-key latest-value rows, in a transaction), a rollback
 * through the production recompute (`removeEventsAbove`, the one `Mip0018Scanner.removeAbove` uses), and the answer is
 * read back with the read helpers the API serves (`metadata.ts` `listIdentities`, `listGroups`, `displayAmountOf`;
 * `events.ts` `listEvents`). Request parsing and the response shapes are the pure consumer's (`./vector-consumer.ts`).
 * Runtime-neutral (no `node:*`, no `Buffer`); the stdin/stdout process over it is `vector-adapter-pg.ts`.
 *
 * - `decode`: the event is written to the log of a fresh schema at (block 1, tx 0, event 0) of a placeholder contract
 *   and read back; the result and reason are the stored row's, the header and records of an accepted event are decoded
 *   by the codec from the STORED (zero-extended) bytes. `offset` (informative) is given when the stored bytes
 *   reproduce the stored reason (not for a payload longer than 256 bytes, which is stored empty).
 * - `state`: steps applied in order, one transaction per step; identities and groups read per network.
 */
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { mip0018Migrations } from "../../src/postgres/migrations/mip0018/index.js";
import { classifyEvent } from "../vendor/mip0018/codec/src/index.ts";
import { hexToBytes } from "./bytes.ts";
import { listEvents } from "./events.ts";
import { observedEventRow, removeEventsAbove, writeEvents } from "./fields.ts";
import { displayAmountOf, listGroups, listIdentities } from "./metadata.ts";
import { type IdentityState, type SymbolGroup, toHex } from "./state.ts";
import { decodeInput, decodeResponse, type Json, stateInput, stateResponse } from "./vector-consumer.ts";

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
    const again = classifyEvent({ type: e.eventType, name: hexToBytes(e.name), payload: hexToBytes(e.payload) });
    if (e.classification === "accept") {
      if (again.result !== "accept") throw new Error(`stored accepted event does not decode from its stored bytes (${again.result})`);
      if (again.header.kind !== e.kind || toHex(again.header.domainSep) !== e.domainSep)
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
