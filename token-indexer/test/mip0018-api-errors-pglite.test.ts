/**
 * The MIP-0018 API's answers, and its error answers in particular, on the PGlite client compared with postgres.js on
 * PostgreSQL 17 (Testcontainers): the same requests to the same (empty, migrated) index answer identically on both —
 * status, headers and body — including 503 `UNAVAILABLE` when the database cannot be read. Database failures only
 * PGlite has (a closed database, the wait for its single session) are answered 503 too, and the cause goes to the log
 * only.
 *
 * The PGlite database is in memory and started without PGlite's `-F` start parameter (`fsync=on`), so the migrations
 * run under the PostgreSQL durability rule on both backends.
 */
import { PGlite } from "@electric-sql/pglite";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { createPgliteClient } from "../../src/postgres/pglite-sql.js";
import { type ApiResponse, createMip0018Handler, type Mip0018HandlerOptions } from "../mip0018/api.ts";
import { Mip0018Scanner } from "../mip0018/scan.ts";

const NET = "stagenet";
const MIP = "api_mip";
const ARCHIVE = "api_arch";
const UNAVAILABLE = { error: { code: "UNAVAILABLE", message: "the index database cannot be read" } };
const X = "ab".repeat(32);
const D = "11".repeat(32);

/** Every request the error-envelope test of the PostgreSQL suite sends, plus the success routes of an empty index. */
const REQUESTS: Array<[string, string]> = [
  ...[
    "/v1/status", "/v1/tokens", "/v1/tokens?limit=1", `/v1/lookup/${X}?held=shielded`, `/v1/events?contract=${X}`,
    "/v1/tokens/xyz", `/v1/tokens/${"a".repeat(63)}`, `/v1/tokens/${"a".repeat(65)}`, `/v1/tokens/0x${"g".repeat(64)}`,
    `/v1/identities/${X}/${D}/0`, `/v1/identities/${X}/${D}/4`, `/v1/identities/${X}/${D}/x`, `/v1/identities/${X}/${"11".repeat(31)}/3`,
    `/v1/identities/abc/${D}/3`, "/v1/tokens/%E0%A4%A", "/v1/status?verbose=1", `/v1/tokens/${X}?limit=1`, "/v1/tokens?cursor=nope",
    "/", "/v1", "/v1/nope", "/v2/tokens", "/v1/tokens/", "//v1/tokens", `/v1/identities/${X}/${D}`, `/v1/identities/${X}/${D}/3`,
    `/v1/tokens/${X}`, `/v1/tokens/${X}/activity`, `/v1/contracts/${X}/tokens`, `/v1/contracts/${X}/activity`, `/v1/contracts/${X}`,
    "/ui", "/v1/events", `/v1/lookup/${X}?held=nowhere`,
  ].map((t): [string, string] => ["GET", t]),
  ["HEAD", "/v1/status"], ["HEAD", "/v1/nope"],
  ...["POST", "PUT", "DELETE", "PATCH", "OPTIONS"].map((m): [string, string] => [m, "/v1/tokens"]),
];

describe("MIP-0018 API on the PGlite client: the same answers and error answers as on PostgreSQL", () => {
  let container: StartedPostgreSqlContainer;
  let pglite: PGlite;
  const backends: Array<{ name: string; sql: UmbraDBSql }> = [];
  const extra: UmbraDBSql[] = [];

  const handler = (sql: UmbraDBSql, opts: Partial<Mip0018HandlerOptions> = {}) =>
    createMip0018Handler({ sql, network: NET, schema: MIP, archiveSchema: ARCHIVE, log: () => {}, ...opts });

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    pglite = await PGlite.create({ startParams: PGlite.defaultStartParams.filter((p) => p !== "-F") });
    backends.push(
      { name: "postgres", sql: createClient({ connectionString: container.getConnectionUri(), schema: MIP }) },
      { name: "pglite", sql: createPgliteClient({ pglite, schema: MIP }) },
    );
    for (const b of backends) {
      await bootstrapChainArchiveSchema(b.sql, ARCHIVE);
      await new Mip0018Scanner({ sql: b.sql, network: NET, schema: MIP, archiveSchema: ARCHIVE }).bootstrap();
    }
  }, 180_000);

  afterAll(async () => {
    for (const s of [...backends.map((b) => b.sql), ...extra]) await s.end({ timeout: 5 }).catch(() => undefined);
    await pglite?.close();
    await container?.stop();
  }, 60_000);

  it("every route and every error envelope (400, 404, 405, HEAD) answers identically on both backends", async () => {
    const [pg, lite] = backends.map((b) => handler(b.sql));
    const statuses = new Set<number>();
    for (const [method, target] of REQUESTS) {
      const a = await pg!.handle(method, target);
      const b = await lite!.handle(method, target);
      expect(b, `${method} ${target}`).toEqual(a);
      statuses.add(a.status);
    }
    expect([...statuses].sort()).toEqual([200, 400, 404, 405]);
  });

  it("a database that cannot be read answers 503 UNAVAILABLE identically on both backends, the cause in the log only: an ended client, a missing schema", async () => {
    const ended = [
      createClient({ connectionString: container.getConnectionUri(), schema: MIP }),
      createPgliteClient({ pglite, schema: MIP }),
    ];
    const answers: ApiResponse[][] = [];
    const logs: string[][] = [];
    for (const [i, b] of backends.entries()) {
      await ended[i]!.end();
      const log: string[] = [];
      logs.push(log);
      const endedApi = handler(ended[i]!, { log: (l) => log.push(l) });
      const missing = handler(b.sql, { schema: "no_such_schema", log: (l) => log.push(l) });
      answers.push([
        await endedApi.handle("GET", "/v1/tokens"),
        await endedApi.handle("HEAD", "/v1/status"),
        await missing.handle("GET", "/v1/tokens"),
        await missing.handle("GET", `/v1/tokens/${X}`),
      ]);
    }
    expect(answers[1]).toEqual(answers[0]);
    for (const r of answers[1]!) expect(r.status).toBe(503);
    expect(JSON.parse(answers[1]![0]!.body)).toEqual(UNAVAILABLE);
    expect(answers[1]!.some((r) => /relation|schema|select|no_such|PGlite|CONNECTION/i.test(r.body))).toBe(false);
    for (const log of logs) {
      expect(log).toHaveLength(4);
      for (const line of log) expect(JSON.parse(line)).toMatchObject({ event: "api-error", status: 503 });
    }
  });

  it("failures only PGlite has answer 503 UNAVAILABLE: a closed database, the single session held too long, PGlite's own error class; another error stays 500 INTERNAL", async () => {
    const log: string[] = [];
    const db = await PGlite.create({ startParams: PGlite.defaultStartParams.filter((p) => p !== "-F") });
    const onClosed = handler(createPgliteClient({ pglite: db, schema: MIP }), { log: (l) => log.push(l) });
    await db.close();
    const closed = await onClosed.handle("GET", "/v1/status");
    expect([closed.status, JSON.parse(closed.body)]).toEqual([503, UNAVAILABLE]);
    expect(log.at(-1)).toContain("CONNECTION_CLOSED");

    // Another client holds the session (a reservation that runs nothing): the API's statement gives up waiting.
    const holder = createPgliteClient({ pglite, schema: MIP });
    extra.push(holder);
    const reserved = await holder.reserve();
    try {
      const waiting = handler(createPgliteClient({ pglite, schema: MIP, deadlockTimeoutMs: 100 }), { log: (l) => log.push(l) });
      const busy = await waiting.handle("GET", "/v1/tokens");
      expect([busy.status, JSON.parse(busy.body)]).toEqual([503, UNAVAILABLE]);
      expect(log.at(-1)).toContain("PGLITE_SESSION_DEADLOCK");
    } finally {
      reserved.release();
    }

    const raw = handler(createPgliteClient({ pglite, schema: MIP, mapError: (e) => e }), { schema: "no_such_schema", log: (l) => log.push(l) });
    expect((await raw.handle("GET", "/v1/tokens")).status).toBe(503);

    const internal = handler(createPgliteClient({ pglite, schema: MIP, mapError: () => new TypeError("not a database error") }), {
      schema: "no_such_schema", log: (l) => log.push(l),
    });
    const r = await internal.handle("GET", "/v1/tokens");
    expect([r.status, JSON.parse(r.body)]).toEqual([500, { error: { code: "INTERNAL", message: "internal error" } }]);
    // The index still answers once the session is free.
    expect((await handler(backends[1]!.sql).handle("GET", "/v1/status")).status).toBe(200);
  });
});
