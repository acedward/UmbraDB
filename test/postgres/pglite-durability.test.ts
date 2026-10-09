/**
 * The durability probe on both backends. PostgreSQL keeps its rule (`fsync=off` is refused, with no override), also for
 * a client that claims the non-durable mode. A PGlite client is `non-durable` by default: PGlite's `fsync=off` is
 * accepted by that configuration (a `non-durable` warning), the migrations run, and `durabilityModeOf` reports the
 * mode. A `durable` PGlite client keeps the PostgreSQL rule.
 */
import { PGlite } from "@electric-sql/pglite";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { Mip0018Scanner } from "../../token-indexer/mip0018/scan.ts";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import {
  classifyNonDurableFsync,
  DurabilityContractError,
  durabilityModeOf,
  type DurabilityWarning,
  isPgliteServer,
  probeDurability,
} from "../../src/postgres/durability-probe.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { chainArchiveMigrations } from "../../src/postgres/migrations/chain_archive/index.js";
import { createPgliteClient, openPgliteClient } from "../../src/postgres/pglite-sql.js";

const SCHEMA = "durability_test";
const PGLITE_VERSION = "PostgreSQL 18.3 (PGlite 0.5.8) on wasm32-unknown-emscripten, compiled by emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 3.1.74 (1092ec30a3fb1d46b1782ff1b4db5094d3d06ae5), 32-bit";
const POSTGRES_VERSION = "PostgreSQL 17.6 on aarch64-unknown-linux-musl, compiled by gcc (Alpine 14.2.0) 14.2.0, 64-bit";

async function migrated(sql: UmbraDBSql, schema = SCHEMA): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`select to_regclass(${`${schema}._migrations`}) is not null as exists`;
  return rows[0]!.exists;
}

/** A postgres.js client that carries the PGlite client's non-durable marker. */
function claimingNonDurable(sql: UmbraDBSql): UmbraDBSql {
  Object.defineProperty(sql, "umbradbDurability", { value: "non-durable" });
  return sql;
}

describe("durability modes: PostgreSQL refuses fsync=off, a non-durable PGlite client accepts it by configuration", () => {
  it("classifiers: PGlite is recognized by its version string; fsync=off in the non-durable mode is a warning on PGlite and a violation elsewhere", () => {
    expect(isPgliteServer(PGLITE_VERSION)).toBe(true);
    for (const v of [POSTGRES_VERSION, "PostgreSQL 18.3 on wasm32-unknown-emscripten", "(PGlite 0.5.8)", "", "PostgreSQL 17 (PGlite) x"])
      expect(isPgliteServer(v), v).toBe(false);
    expect(classifyNonDurableFsync("on", PGLITE_VERSION)).toBeNull();
    expect(classifyNonDurableFsync("on", POSTGRES_VERSION)).toBeNull();
    expect(classifyNonDurableFsync("off", PGLITE_VERSION)).toMatchObject({ warning: { kind: "non-durable", setting: "fsync", value: "off" } });
    expect(classifyNonDurableFsync("off", POSTGRES_VERSION)).toMatchObject({ violation: { setting: "durability", value: "non-durable" } });
    expect(durabilityModeOf(undefined)).toBe("durable");
    expect(durabilityModeOf(() => undefined)).toBe("durable");
    expect(durabilityModeOf(Object.assign(() => undefined, { umbradbDurability: "fast" }))).toBe("durable");
  });

  describe("PGlite", () => {
    let fsyncOff: PGlite;
    let fsyncOn: PGlite;

    beforeAll(async () => {
      fsyncOff = await PGlite.create();
      fsyncOn = await PGlite.create({ startParams: PGlite.defaultStartParams.filter((p) => p !== "-F") });
    }, 60_000);

    afterAll(async () => {
      await fsyncOff?.close();
      await fsyncOn?.close();
    });

    it("a client is non-durable by default: fsync=off is accepted as a non-durable warning, the chain-archive and MIP-0018 migrations run", async () => {
      const sql = createPgliteClient({ pglite: fsyncOff, schema: SCHEMA });
      expect(durabilityModeOf(sql)).toBe("non-durable");
      expect((await sql<{ v: string }[]>`select current_setting('fsync') as v`)[0]!.v).toBe("off");
      const warnings = await probeDurability(sql);
      expect(warnings).toEqual([expect.objectContaining({ kind: "non-durable", setting: "fsync", value: "off" })]);
      expect(warnings[0]!.message).toMatch(/accepted by configuration/);
      const surfaced: DurabilityWarning[] = [];
      await runMigrations(sql, { schema: SCHEMA, migrations: chainArchiveMigrations, onDurabilityWarning: (w) => surfaced.push(...w) });
      expect(surfaced.map((w) => w.kind)).toEqual(["non-durable"]);
      expect(await migrated(sql)).toBe(true);
      // The archive and the scan bootstrap (each runs the probe) on the same database.
      await bootstrapChainArchiveSchema(sql, "chain_archive");
      await new Mip0018Scanner({ sql, network: "stagenet", schema: "mip0018", archiveSchema: "chain_archive" }).bootstrap();
      expect(await migrated(sql, "mip0018")).toBe(true);
    }, 60_000);

    it("a durable client keeps the PostgreSQL rule: fsync=off is refused before any migration runs", async () => {
      const sql = createPgliteClient({ pglite: fsyncOff, schema: "durable_refused", durability: "durable" });
      expect(durabilityModeOf(sql)).toBe("durable");
      const refused = await probeDurability(sql).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(DurabilityContractError);
      expect((refused as DurabilityContractError).violations.map((v) => `${v.setting}=${v.value}`)).toEqual(["fsync=off"]);
      await expect(runMigrations(sql, { schema: "durable_refused", migrations: chainArchiveMigrations })).rejects.toBeInstanceOf(DurabilityContractError);
      expect(await migrated(sql, "durable_refused")).toBe(false);
    }, 60_000);

    it("with fsync on, both modes pass with no warning and the probe sends the same statements as on PostgreSQL", async () => {
      for (const durability of ["durable", "non-durable"] as const) {
        const texts: string[] = [];
        const sql = createPgliteClient({ pglite: fsyncOn, schema: SCHEMA, durability, debug: (_c, text) => texts.push(text) });
        expect(await probeDurability(sql)).toEqual([]);
        expect(texts.filter((t) => /version\(\)/.test(t))).toEqual([]);
      }
    });

    it("openPgliteClient: non-durable by default (PGlite's fsync=off); a durable client's database starts with fsync on; a bad mode is refused", async () => {
      const nonDurable = await openPgliteClient({ schema: SCHEMA });
      const durable = await openPgliteClient({ schema: SCHEMA, durability: "durable" });
      try {
        expect([durabilityModeOf(nonDurable), durabilityModeOf(durable)]).toEqual(["non-durable", "durable"]);
        expect((await nonDurable<{ v: string }[]>`select current_setting('fsync') as v`)[0]!.v).toBe("off");
        expect((await durable<{ v: string }[]>`select current_setting('fsync') as v`)[0]!.v).toBe("on");
        await runMigrations(durable, { schema: SCHEMA, migrations: chainArchiveMigrations });
        await runMigrations(nonDurable, { schema: SCHEMA, migrations: chainArchiveMigrations });
        expect([await migrated(durable), await migrated(nonDurable)]).toEqual([true, true]);
      } finally {
        await nonDurable.end();
        await durable.end();
      }
      await expect(openPgliteClient({ durability: "fast" as never })).rejects.toThrow(RangeError);
      expect(() => createPgliteClient({ pglite: fsyncOn, durability: "fast" as never })).toThrow(/durability must be/);
    }, 60_000);
  });

  describe("PostgreSQL 17", () => {
    let healthy: StartedPostgreSqlContainer;
    let fsyncOff: StartedPostgreSqlContainer;

    beforeAll(async () => {
      [healthy, fsyncOff] = await Promise.all([
        new PostgreSqlContainer("postgres:17-alpine").start(),
        new PostgreSqlContainer("postgres:17-alpine").withCommand(["postgres", "-c", "fsync=off"]).start(),
      ]);
    }, 240_000);

    afterAll(async () => {
      await Promise.all([healthy?.stop(), fsyncOff?.stop()]);
    });

    it("a PostgreSQL client is durable; fsync=off is refused, also for a client that claims the non-durable mode (the server is not PGlite)", async () => {
      const plain = createClient({ connectionString: fsyncOff.getConnectionUri(), schema: SCHEMA });
      const claiming = claimingNonDurable(createClient({ connectionString: fsyncOff.getConnectionUri(), schema: SCHEMA }));
      try {
        expect([durabilityModeOf(plain), durabilityModeOf(claiming)]).toEqual(["durable", "non-durable"]);
        const a = await probeDurability(plain).catch((e: unknown) => e);
        expect((a as DurabilityContractError).violations.map((v) => v.setting)).toEqual(["fsync"]);
        const b = await probeDurability(claiming).catch((e: unknown) => e);
        expect(b).toBeInstanceOf(DurabilityContractError);
        expect((b as DurabilityContractError).violations.map((v) => `${v.setting}=${v.value}`)).toEqual(["fsync=off", "durability=non-durable"]);
        await expect(runMigrations(claiming, { schema: SCHEMA })).rejects.toBeInstanceOf(DurabilityContractError);
        expect(await migrated(plain)).toBe(false);
      } finally {
        await plain.end({ timeout: 5 });
        await claiming.end({ timeout: 5 });
      }
    }, 60_000);

    it("on a healthy server a client claiming the non-durable mode has nothing to accept: no warning, migrations run", async () => {
      const claiming = claimingNonDurable(createClient({ connectionString: healthy.getConnectionUri(), schema: SCHEMA }));
      try {
        expect(await probeDurability(claiming)).toEqual([]);
        await runMigrations(claiming, { schema: SCHEMA, migrations: chainArchiveMigrations });
        expect(await migrated(claiming)).toBe(true);
      } finally {
        await claiming.end({ timeout: 5 });
      }
    }, 60_000);
  });
});
