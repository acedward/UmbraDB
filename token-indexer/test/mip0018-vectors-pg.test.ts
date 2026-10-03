/**
 * MIP-0018 vector conformance through UmbraDB's POSTGRES adapter: the vendored runner core, unchanged, drives every
 * vector — the 59 reference normative + 43 informative vectors and UmbraDB's own 8 (MIP `274a84f`, per-key tombstones)
 * — through the production write path (`fields.ts`) into a fresh `mip0018` schema per request, and reads the state back
 * with the read helpers the API serves (`metadata.ts`). The responses must equal the pure adapter's, request by request
 * (S4 rollback, S7 independence and S9 groups included), and no check may pass as "not applicable".
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { loadVectors, requestFor, runVectors, type Json, type LoadedVector } from "../vendor/mip0018/vectors/tools/runner-core.ts";
import { UMBRADB_VECTORS_DIR, VENDORED_VECTORS_DIR, vectorSets } from "../mip0018/run-vectors.ts";
import { handleRequest } from "../mip0018/vector-adapter.ts";
import { createPgVectorConsumer } from "../mip0018/vector-adapter-pg.ts";

const failures = (report: Awaited<ReturnType<typeof runVectors>>): string[] =>
  report.results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.failures.join("; ")}`);

describe("MIP-0018 vectors through the Postgres adapter", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema: "mip0018_vec" });
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  it("[[mip0018.vectors.pg-adapter]] 59/59 reference normative + 43/43 informative + 8/8 UmbraDB versions through Postgres, no check not applicable, every response equal to the pure adapter's", async () => {
    const pg = createPgVectorConsumer({ sql, schemaPrefix: "vec_pg" });
    const sets = vectorSets();
    const referenceVectors = loadVectors({ dir: VENDORED_VECTORS_DIR, only: sets.reference.map((v) => v.id) });
    const ownVectors = loadVectors({ dir: UMBRADB_VECTORS_DIR });

    const responses = new Map<string, Json>(); // every Postgres answer, compared with the pure adapter's below
    const consumer = async (req: Json): Promise<Json> => {
      const res = await pg.handle(req);
      responses.set(String(req.id), JSON.parse(JSON.stringify(res)) as Json);
      return res;
    };
    const reference = await runVectors(referenceVectors, consumer);
    expect(failures(reference)).toEqual([]);
    expect(reference.normative).toEqual({ passed: 59, total: 59 });
    expect(reference.informative).toEqual({ passed: 43, total: 43 });
    expect(reference.notApplicable).toEqual({});
    const own = await runVectors(ownVectors, consumer);
    expect(failures(own)).toEqual([]);
    expect(own.normative).toEqual({ passed: 8, total: 8 });
    expect(own.notApplicable).toEqual({});
    expect(pg.schemasCreated).toBe(110); // a fresh schema per request
    const left = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name LIKE 'vec_pg_%'`;
    expect(left[0]!.n).toBe(0); // each dropped after its request

    // Same answer as the pure adapter, request by request. The only allowed difference: a decode `offset`
    // (informative) the Postgres path cannot reproduce from the stored bytes (a payload longer than 256 bytes is
    // stored empty, INF-ZEXT-7).
    const differences: string[] = [];
    const withoutOffset: string[] = [];
    for (const v of [...referenceVectors, ...ownVectors] as LoadedVector[]) {
      const want = handleRequest(JSON.parse(JSON.stringify(requestFor(v))));
      const got = responses.get(v.entry.id)!;
      if (want.offset !== undefined && got.offset === undefined) {
        withoutOffset.push(v.entry.id);
        delete want.offset;
      }
      if (JSON.stringify(got) !== JSON.stringify(want)) differences.push(`${v.entry.id}: pure ${JSON.stringify(want)} vs pg ${JSON.stringify(got)}`);
    }
    expect(differences).toEqual([]);
    expect(withoutOffset).toEqual(["INF-ZEXT-7"]);
    expect(responses.size).toBe(110);
  }, 600_000);

  it("[[mip0018.vectors.pg-runner-cli]] the vendored runner CLI drives the Postgres adapter process over both sets and exits 0, with every check applicable", () => {
    const run = spawnSync(
      process.execPath,
      [join(UMBRADB_VECTORS_DIR, "..", "run-vectors.ts"), "--consumer", `${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(join(UMBRADB_VECTORS_DIR, "..", "vector-adapter-pg.ts"))}`, "--timeout", "60000"],
      { encoding: "utf8", timeout: 900_000, env: { ...process.env, PG_URL: container.getConnectionUri(), MIP0018_VECTOR_SCHEMA_PREFIX: "vec_cli" } },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("normative: 59/59 passed; informative: 43/43 passed");
    expect(run.stdout).toContain("normative: 8/8 passed");
    expect(run.stdout).not.toMatch(/^\s*n\/a:/m);
    expect(run.stdout).not.toContain("FAIL");
  }, 910_000); // a fresh migrated schema per request: generous budgets for a loaded host

  it("the Postgres adapter answers malformed requests per request, never by exiting", async () => {
    const pg = createPgVectorConsumer({ sql, schemaPrefix: "vec_bad" });
    expect(await pg.handle({ id: "x", op: "nope" })).toEqual({ id: "x", error: "unknown op nope" });
    expect(await pg.handle({ id: "y", op: "decode", type: "Misc", name_hex: "zz", payload_hex: "" })).toMatchObject({ id: "y", error: expect.any(String) });
    expect(await pg.handle([1])).toMatchObject({ id: null, error: "request is not a JSON object" });
    // Events out of chain order are refused by the write path, as by the pure module.
    const step = (block: number) => ({ op: "apply", network: "n", block, tx: 0, event: 0, contractAddress: "aa".repeat(32), type: "Misc", name_hex: "00", payload_hex: "00" });
    expect(await pg.handle({ id: "z", op: "state", steps: [step(2), step(1)] })).toMatchObject({ id: "z", error: expect.stringContaining("does not follow") });
    expect(handleRequest({ id: "z", op: "state", steps: [step(2), step(1)] })).toMatchObject({ id: "z", error: expect.stringContaining("does not follow") });
  }, 60_000);
});
