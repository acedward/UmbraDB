import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MonitorFencedError,
  MonitorNotFoundError,
  MonitorRevokedError,
} from "../../shielded-monitor/errors.js";
import type { ShieldedMonitorStore } from "../../shielded-monitor/store.js";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { association, fixtureViewingKey, freshStore, TEST_LEDGER_BUILD, TEST_MATCHING_RULE, uniqueSchema } from "../shielded-monitor/helpers.js";
import { startStorageApi, type StartedStorageApi } from "./helpers.js";

/**
 * **The substitutability property**: `HttpMonitorStore` and `PgShieldedMonitorStore` are the same
 * store (sub-plan 00009-08 v2; owner question Q25; `spec/00009` FR-025).
 *
 * Project B used to hold a PostgreSQL store and now holds an HTTP client. Everything above that
 * line — the scanner, the scheduler, the private API, the details backfill, the dashboard — is
 * unchanged, and is correct only if the two implementations are indistinguishable through the
 * interface they share. This suite is that claim, checked rather than asserted:
 *
 * - the SAME randomly generated command sequence is applied to both, on two schemas of one
 *   PostgreSQL, one directly and one through a real HTTP server;
 * - every return value and every thrown error is normalised (ids and timestamps dropped, bigints
 *   rendered, errors reduced to class + discriminants) and the two transcripts must be EQUAL;
 * - afterwards the two schemas' full observable state — monitors, associations, lifecycle logs,
 *   revocations — must be equal as well, so a difference that happened to produce the same
 *   return values still fails.
 *
 * The sequences are generated with `fast-check` and sampled with a FIXED seed, so the suite is
 * deterministic on CI and on a laptop while still covering command interleavings nobody would
 * have written by hand — including the ones that matter most here: an advance fenced by a
 * lifecycle transition that landed between the read and the write, a replayed advance, a revoke
 * followed by a read, and a delete followed by everything.
 *
 * What it deliberately does NOT do is compare ids or timestamps: the two sides register different
 * monitors and `now()` differs by milliseconds. Structure and values are the subject.
 */

type Command =
  | { kind: "get" }
  | { kind: "getIncludingRevoked" }
  | { kind: "getByFingerprint" }
  | { kind: "keyMaterial" }
  | { kind: "advance"; through: number; matches: number; withLease: boolean }
  | { kind: "advanceStaleEpoch"; through: number }
  | { kind: "readAssociations"; afterSeq: number; limit: number }
  | { kind: "readMissingDetails" }
  | { kind: "backfillDetails"; count: number }
  | { kind: "bindSource" }
  | { kind: "goLive" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "revoke" }
  | { kind: "delete" }
  | { kind: "markFailed" }
  | { kind: "markStaleSource" }
  | { kind: "lifecycle" }
  | { kind: "claimLease"; owner: string }
  | { kind: "releaseLease"; owner: string }
  | { kind: "readLease" };

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc.constant<Command>({ kind: "get" }),
  fc.constant<Command>({ kind: "getIncludingRevoked" }),
  fc.constant<Command>({ kind: "getByFingerprint" }),
  fc.constant<Command>({ kind: "keyMaterial" }),
  fc.record({
    kind: fc.constant<"advance">("advance"),
    through: fc.integer({ min: 1, max: 12 }),
    matches: fc.integer({ min: 0, max: 3 }),
    withLease: fc.boolean(),
  }),
  fc.record({ kind: fc.constant<"advanceStaleEpoch">("advanceStaleEpoch"), through: fc.integer({ min: 1, max: 12 }) }),
  fc.record({
    kind: fc.constant<"readAssociations">("readAssociations"),
    afterSeq: fc.integer({ min: 0, max: 4 }),
    limit: fc.integer({ min: 1, max: 10 }),
  }),
  fc.constant<Command>({ kind: "readMissingDetails" }),
  fc.record({ kind: fc.constant<"backfillDetails">("backfillDetails"), count: fc.integer({ min: 1, max: 3 }) }),
  fc.constant<Command>({ kind: "bindSource" }),
  fc.constant<Command>({ kind: "goLive" }),
  fc.constant<Command>({ kind: "pause" }),
  fc.constant<Command>({ kind: "resume" }),
  fc.constant<Command>({ kind: "revoke" }),
  fc.constant<Command>({ kind: "delete" }),
  fc.constant<Command>({ kind: "markFailed" }),
  fc.constant<Command>({ kind: "markStaleSource" }),
  fc.constant<Command>({ kind: "lifecycle" }),
  fc.record({ kind: fc.constant<"claimLease">("claimLease"), owner: fc.constantFrom("alpha", "beta") }),
  fc.record({ kind: fc.constant<"releaseLease">("releaseLease"), owner: fc.constantFrom("alpha", "beta") }),
  fc.constant<Command>({ kind: "readLease" }),
);

/** Renders anything, including bigints and bytes, as a stable string. */
function show(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "bigint") return `${v.toString()}n`;
    if (v instanceof Uint8Array) return `bytes:${Buffer.from(v).toString("hex")}`;
    return v;
  });
}

/** The fields two implementations must agree on. Ids and timestamps are excluded because the two
 *  sides register different monitors at different milliseconds; everything else is compared. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof Date) return "<date>";
  if (value instanceof Uint8Array) return `bytes:${Buffer.from(value).toString("hex")}`;
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === "id" || key === "monitorId" || key === "createdAt" || key === "updatedAt") continue;
      if (key === "at" || key === "claimedAt" || key === "expiresAt") continue;
      out[key] = normalize(v);
    }
    return out;
  }
  return value;
}

/** An error reduced to exactly what a caller may switch on. */
function describeError(err: unknown): string {
  if (err instanceof MonitorFencedError) {
    return `MonitorFencedError(${err.rejection}, epoch=${err.observed.epoch}, state=${err.observed.state})`;
  }
  if (err instanceof MonitorNotFoundError) return "MonitorNotFoundError";
  if (err instanceof MonitorRevokedError) return "MonitorRevokedError";
  if (err instanceof Error) return `${err.name}(${String((err as { code?: unknown }).code ?? "")})`;
  return `unknown(${String(err)})`;
}

interface World {
  readonly store: ShieldedMonitorStore;
  readonly monitorId: string;
  readonly fingerprint: Uint8Array;
}

/** Applies one command and returns its normalised transcript line. */
async function apply(world: World, command: Command): Promise<string> {
  const { store, monitorId } = world;
  const current = async (): Promise<bigint> => (await store.getIncludingRevoked(monitorId))?.epoch ?? 0n;
  try {
    switch (command.kind) {
      case "get":
        return show(normalize(await store.get(monitorId)));
      case "getIncludingRevoked":
        return show(normalize(await store.getIncludingRevoked(monitorId)));
      case "getByFingerprint":
        return show(normalize(await store.getByFingerprint("undeployed", world.fingerprint)));
      case "keyMaterial":
        return show(normalize(await store.getKeyMaterial(monitorId)));
      case "advance": {
        const epoch = await current();
        const through = BigInt(command.through);
        const associations = Array.from({ length: command.matches }, (_, i) => association(through, i));
        return show(
          normalize(
            await store.advance(monitorId, epoch, through, associations, {
              ...(command.withLease ? { lease: { owner: "alpha", ttlMs: 30_000 } } : {}),
            }),
          ),
        );
      }
      case "advanceStaleEpoch": {
        // A worker whose loaded epoch is behind: the fence must refuse identically on both sides
        // (organizer spec FR-012), with the same rejection and the same observed epoch/state.
        const epoch = (await current()) + 7n;
        return show(normalize(await store.advance(monitorId, epoch, BigInt(command.through), [])));
      }
      case "readAssociations":
        return show(
          normalize(await store.readAssociations(monitorId, BigInt(command.afterSeq), command.limit)),
        );
      case "readMissingDetails":
        return show(normalize(await store.readAssociationsMissingDetails(monitorId, 0n, 10)));
      case "backfillDetails": {
        const epoch = await current();
        const rows = await store.readAssociationsMissingDetails(monitorId, 0n, command.count);
        return show(
          normalize(
            await store.updateAssociationDetails(
              monitorId,
              epoch,
              rows.map((row) => ({
                seq: row.seq,
                details: { version: "test/v1", outputs: [], transients: [], contracts: [] } as never,
                blockTimestampMs: 1_700_000_000_000n,
              })),
            ),
          ),
        );
      }
      case "bindSource":
        return show(
          normalize(
            await store.bindArchiveSource(monitorId, await current(), {
              genesisHash: "genesis-1",
              instanceId: "instance-1",
            }),
          ),
        );
      case "goLive":
        return show(normalize(await store.goLive(monitorId, await current(), "parity")));
      case "pause":
        return show(normalize(await store.pause(monitorId, "parity")));
      case "resume":
        return show(normalize(await store.resume(monitorId, "parity")));
      case "revoke":
        return show(normalize(await store.revoke(monitorId, "parity")));
      case "delete":
        return show(normalize(await store.delete(monitorId, "parity")));
      case "markFailed":
        return show(
          normalize(
            await store.markFailed(monitorId, "parity", { code: "TEST", message: "parity" }, await current()),
          ),
        );
      case "markStaleSource":
        return show(
          normalize(
            await store.markStaleSource(monitorId, "parity", { code: "STALE", message: "parity" }, await current()),
          ),
        );
      case "lifecycle":
        return show(normalize(await store.listLifecycleEvents(monitorId)));
      case "claimLease":
        return show(normalize(await store.claimMonitorLease(monitorId, command.owner, 30_000)));
      case "releaseLease":
        return show(normalize(await store.releaseMonitorLease(monitorId, command.owner)));
      case "readLease": {
        const lease = await store.readMonitorLease(monitorId);
        return show(lease === undefined ? null : { owner: lease.owner, live: lease.expiresAt > lease.claimedAt });
      }
    }
  } catch (err) {
    return `THREW ${describeError(err)}`;
  }
}

describe("HttpMonitorStore and PgShieldedMonitorStore are the same store (FR-025, Q25)", () => {
  let container: StartedPostgreSqlContainer;
  let directSql: UmbraDBSql;
  let servedSql: UmbraDBSql;
  let direct: ShieldedMonitorStore;
  let served: StartedStorageApi;
  const directSchema = uniqueSchema("parity_direct");
  const servedSchema = uniqueSchema("parity_served");

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    const a = await freshStore(container, directSchema);
    const b = await freshStore(container, servedSchema);
    directSql = a.sql;
    servedSql = b.sql;
    direct = a.store;
    served = await startStorageApi(b.store, { config: { monitorSchema: servedSchema } });
  }, 240_000);

  afterAll(async () => {
    await served?.close();
    await directSql?.end({ timeout: 5 });
    await servedSql?.end({ timeout: 5 });
    await container?.stop();
  });

  // Sampled rather than driven by `fc.assert`, so each sequence gets its OWN monitor on both
  // sides and the (expensive) container is started once. The seed is fixed: a parity failure must
  // be reproducible from the test name alone.
  const sequences = fc.sample(fc.array(commandArb, { minLength: 8, maxLength: 22 }), {
    numRuns: 8,
    seed: 0x00009_08,
  });

  it.each(sequences.map((commands, index) => [index, commands] as const))(
    "sequence %i produces an identical transcript on both implementations",
    async (index, commands) => {
      const seed = 900 + index;
      const key = await fixtureViewingKey(seed);
      const registration = {
        key,
        net: "undeployed",
        requestedStartHeight: 0n,
        matchingRuleVersion: TEST_MATCHING_RULE,
        ledgerBuild: TEST_LEDGER_BUILD,
        actor: "parity",
      };
      const directMonitor = await direct.register(registration);
      const servedMonitor = await served.client.register(registration);
      // Registration itself is part of the property: the two sides must agree on everything but
      // the id, which is a UUID minted per row.
      expect(show(normalize(servedMonitor))).toBe(show(normalize(directMonitor)));

      const directWorld: World = { store: direct, monitorId: directMonitor.id, fingerprint: key.fingerprint };
      const servedWorld: World = { store: served.client, monitorId: servedMonitor.id, fingerprint: key.fingerprint };

      for (const [step, command] of commands.entries()) {
        const expected = await apply(directWorld, command);
        const actual = await apply(servedWorld, command);
        expect(actual, `step ${step}: ${JSON.stringify(command)}`).toBe(expected);
      }

      // Final state, independently of what the transcript happened to show.
      const finalDirect = await direct.getIncludingRevoked(directMonitor.id);
      const finalServed = await served.client.getIncludingRevoked(servedMonitor.id);
      expect(show(normalize(finalServed))).toBe(show(normalize(finalDirect)));
      expect(show(normalize(await served.client.listLifecycleEvents(servedMonitor.id)))).toBe(
        show(normalize(await direct.listLifecycleEvents(directMonitor.id))),
      );
      // Associations are read administratively (a revoked monitor refuses `readAssociations`), so
      // the comparison covers the sequences that ended in a refusal too.
      const directRows = await directSql`
        SELECT seq, block_height, position, encode(tx_hash, 'hex') AS tx, details IS NOT NULL AS has_details
          FROM ${directSql(directSchema)}.associations WHERE monitor_id = ${directMonitor.id} ORDER BY seq
      `;
      const servedRows = await servedSql`
        SELECT seq, block_height, position, encode(tx_hash, 'hex') AS tx, details IS NOT NULL AS has_details
          FROM ${servedSql(servedSchema)}.associations WHERE monitor_id = ${servedMonitor.id} ORDER BY seq
      `;
      expect(show([...servedRows])).toBe(show([...directRows]));
    },
    120_000,
  );

  it("[[storage-api.parity.http-store-matches-pg-store]] the global list surfaces agree once every sequence has run", async () => {
    const strip = (rows: readonly { id: string }[]): unknown =>
      normalize(rows.map((r) => ({ ...r, id: undefined })));
    expect(show(strip(await served.client.listAll(500)))).toBe(show(strip(await direct.listAll(500))));
    expect(show(strip(await served.client.listActive(500)))).toBe(show(strip(await direct.listActive(500))));
    const revocations = (rows: readonly { monitorId: string; epoch: string; at: string }[]): unknown =>
      rows.map((r) => ({ ...r, monitorId: "<id>", at: "<date>" }));
    expect(show(revocations(await served.client.listRevocations()))).toBe(
      show(revocations(await direct.listRevocations())),
    );
  }, 60_000);
});
