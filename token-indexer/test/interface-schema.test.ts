import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapTokenIndexSchema } from "../bootstrap.js";

/**
 * Project 00024-02 task C1 — migration 006's three public-interface tables hold what the spec
 * needs and refuse what they must (plan `plans/00024-02-public-interface.md`, spec FR-010/FR-011b).
 *
 * The constraints that matter most are the ones that must NOT fire on untrusted input: a package of
 * the reader's largest size (1 024 parts) and a URL of any length or encoding are stored, because a
 * refused INSERT would roll back the scan batch on every retry (the 01-D audit's stall class). The
 * ones that MUST fire keep a result internally consistent (verified ⇒ L1 and L2 passed; failed ⇒ the
 * failed level; a limit or failure ⇒ a reason).
 */
const NET = "undeployed";

describe("migration 006 — public-interface tables", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  const schema = "token_pi_schema";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await bootstrapTokenIndexSchema(sql, { schema, net: NET });
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  let nextId = 100;
  async function insertPublication(fields: {
    parts?: number; url?: string | null; urlError?: string | null; urlBytes?: Buffer; payload?: Buffer;
    address?: Buffer; partIds?: number[];
  } = {}): Promise<number> {
    const id = nextId++;
    const parts = fields.parts ?? 1;
    await sql`
      INSERT INTO ${sql(schema)}.public_interface_events
        (net, event_id, part_event_ids, parts, segment, phase, address, tx_hash, block_height,
         tx_position, payload, commitment, url_bytes, url, url_error)
      VALUES (${NET}, ${id}, ${`{${(fields.partIds ?? Array.from({ length: parts }, (_v, i) => id + i)).join(",")}}`}::bigint[],
              ${parts}, 3, 'guaranteed', ${fields.address ?? Buffer.alloc(32, 1)}, ${Buffer.alloc(32, 2)}, 10, 0,
              ${fields.payload ?? Buffer.alloc(256 * parts)}, ${Buffer.alloc(32, 5)},
              ${fields.urlBytes ?? Buffer.from(fields.url ?? "")},
              ${fields.url === undefined ? "https://b.example/index.json" : fields.url},
              ${fields.urlError ?? null})
    `;
    return id;
  }

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("the statement was accepted");
  }

  it("stores the largest package the reader forms (1 024 parts) and a URL that is not text", async () => {
    // 1 024 parts: a 262 144-byte payload and a 262 112-byte URL — no index covers either.
    const url = `https://b.example/${"x".repeat(262_112 - 18)}`;
    const id = await insertPublication({ parts: 1024, url, urlBytes: Buffer.from(url) });
    const rows = await sql<{ n: number; len: number }[]>`
      SELECT parts AS n, octet_length(url_bytes) AS len FROM ${sql(schema)}.public_interface_events
      WHERE net = ${NET} AND event_id = ${id}
    `;
    expect(rows[0]).toEqual({ n: 1024, len: 262_112 });
    // Bytes that are not UTF-8 (or hold U+0000, which `text` cannot store) keep only the bytea.
    await insertPublication({ url: null, urlError: "url_not_utf8", urlBytes: Buffer.from([0xff, 0xfe, 0x00, 0x41]) });
    await insertPublication({ url: null, urlError: "url_empty", urlBytes: Buffer.alloc(0) });
  });

  it("refuses an inconsistent publication or result", async () => {
    expect(await refused(() => insertPublication({ parts: 2, payload: Buffer.alloc(256) }))).toMatch(/pie_payload_is_parts/);
    expect(await refused(() => insertPublication({ partIds: [1] }))).toMatch(/pie_part_ids_match/);
    expect(await refused(() => insertPublication({ url: null }))).toMatch(/pie_url_or_error/);
    expect(await refused(() => insertPublication({ url: "https://b.example/", urlError: "url_empty" }))).toMatch(/pie_url_or_error/);
    expect(await refused(() => insertPublication({ url: null, urlError: "because" }))).toMatch(/pie_url_error_known/);
    expect(await refused(() => insertPublication({ parts: 1025, payload: Buffer.alloc(256 * 1025) }))).toMatch(/parts_check/);

    const id = await insertPublication();
    const update = (set: Record<string, unknown>) => sql`
      UPDATE ${sql(schema)}.public_interface_events SET ${sql(set)} WHERE net = ${NET} AND event_id = ${id}
    `;
    expect(await refused(() => update({ status: "verified", level: 1, l1: "passed", l2: "not_run" }))).toMatch(/pie_verified_level/);
    expect(await refused(() => update({ status: "failed", reason: "x" }))).toMatch(/pie_failed_has_level/);
    expect(await refused(() => update({ failed_level: 1 }))).toMatch(/pie_failed_level_only_when_failed/);
    expect(await refused(() => update({ status: "unchecked" }))).toMatch(/pie_reason_when_not_ok/);
    // `unreachable` (C9, owner Q25): a reason is required, and it never names a failed level.
    expect(await refused(() => update({ status: "unreachable" }))).toMatch(/pie_reason_when_not_ok/);
    expect(await refused(() => update({ status: "unreachable", reason: "HTTP 404", failed_level: 1 }))).toMatch(/pie_failed_level_only_when_failed/);
    await update({ status: "unreachable", level: 0, l1: "not_run", l2: "not_run", l3: "not_run", reason: "the host did not deliver: index.json: HTTP 404" });
    await update({ status: "pending", level: 0, l1: null, l2: null, l3: null, reason: null });
    expect(await refused(() => update({ status: "historical" }))).toMatch(/status_check/);
    expect(await refused(() => update({ l3: "skipped" }))).toMatch(/l3_check/);
    expect(await refused(() => update({ verified_until: new Date() }))).toMatch(/pie_until_after_verified/);
    // A consistent verified result, with L3 tried and not run.
    await update({ status: "verified", level: 2, l1: "passed", l2: "passed", l3: "not_run", l3_reason: "compiler 0.33.0 unavailable" });
    // A failed result, then marked stale by a maintenance update: its last result stays.
    await update({ status: "failed", level: 0, l1: "failed", l2: "not_run", l3: "not_run", l3_reason: null, failed_level: 1, reason: "hash" });
    await update({ status: "stale" });

    // The current pointer must name a stored publication; a check must name one too.
    expect(await refused(() => sql`
      INSERT INTO ${sql(schema)}.public_interfaces (net, address, event_id, block_height, tx_position)
      VALUES (${NET}, ${Buffer.alloc(32, 9)}, 999999, 1, 0)
    `)).toMatch(/foreign key/);
    expect(await refused(() => sql`
      INSERT INTO ${sql(schema)}.public_interface_checks
        (net, event_id, check_no, checked_at, trigger, status, level, l1, l2, l3)
      VALUES (${NET}, ${id}, 1, now(), 'initial', 'pending', 0, 'not_run', 'not_run', 'not_run')
    `)).toMatch(/status_check/);
    await sql`
      INSERT INTO ${sql(schema)}.public_interface_checks
        (net, event_id, check_no, checked_at, trigger, status, level, l1, l2, l3, reason)
      VALUES (${NET}, ${id}, 1, now(), 'retry', 'unreachable', 0, 'not_run', 'not_run', 'not_run', 'HTTP 503')
    `;
  });
});
