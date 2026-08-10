import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";

/**
 * The event guard must catch a runtime-generated system transaction even when a FAILED direct
 * system call is present to mask it.
 *
 * This is the plan's §5.1 false negative, pinned as a test. The guard used to count occurrences of
 * the system-transaction self-tag in the raw events blob and refuse when that count exceeded the
 * archived count. Writing `S` for successful direct system extrinsics (archived AND evented), `F`
 * for valid direct system calls rejected before ledger execution (archived, no event), and `R` for
 * runtime-generated event-only ones, that compared `S + R > S + F` -- detecting an omission only
 * when `R > F`. One `F` plus one `R` gives equal counts: guard passes, `R` is omitted, watermark
 * advances, and `ON CONFLICT DO NOTHING` means it can never be repaired.
 *
 * The scenario below is exactly that shape: one system transaction archived from an extrinsic, and
 * one DIFFERENT tagged payload present only in the events blob. Counting sees 1 vs 1 and permits
 * it. Matching bytes sees an event payload corresponding to nothing archived, and refuses.
 *
 * A fake node is used deliberately: no reachable devnet produces runtime-generated system
 * transactions (v1.0.0 block rewards are zero and its reward pallet is disabled), so waiting for a
 * live specimen would leave this behaviour permanently unverified. The bytes are real -- both
 * payloads come from the same ground-truth fixture the ledger vectors use.
 */
const NET = "event_guard";

function compactU32Hex(value: number): string {
  if (value < 64) return (value << 2).toString(16).padStart(2, "0");
  if (value < 2 ** 14) {
    const v = (value << 2) | 0b01;
    return (v & 0xff).toString(16).padStart(2, "0") + ((v >> 8) & 0xff).toString(16).padStart(2, "0");
  }
  const v = (value << 2) | 0b10;
  return [0, 8, 16, 24].map((s) => ((v >>> s) & 0xff).toString(16).padStart(2, "0")).join("");
}

/** Bare `pallet_midnight_system::send_mn_system_transaction` (pallet 6, call 0 on node 1.0.x). */
function bareSystemExtrinsicHex(payloadHex: string): string {
  const inner = "05" + "06" + "00" + compactU32Hex(payloadHex.length / 2) + payloadHex;
  return compactU32Hex(inner.length / 2) + inner;
}

/** Two DIFFERENT real serialized system transactions, from the indexer ground-truth fixture. */
const FIXTURE = readFileSync(
  new URL("../fixtures/ledger-vectors/genesis-system-tx-hashes.txt", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map((l) => l.trim().split(/\s+/)[3]!);
const ARCHIVED_TX_HEX = FIXTURE[0]!;
const EVENT_ONLY_TX_HEX = FIXTURE[1]!;

const MNSV_DIGEST_V1 = "0x044d4e53561040420f00";
const BLOCK_HASH = `0x${"e0".repeat(32)}`;

/** A fake `System::Events` blob. Not a real SCALE event list -- the guard scans raw bytes for the
 *  self-tag rather than decoding, precisely because decoding needs metadata this build lacks, so
 *  embedding the payload in surrounding noise is a faithful stand-in for what it actually sees. */
function eventsBlobHex(payloadHexes: string[]): string {
  return "0x" + payloadHexes.map((p) => "aabbcc" + p).join("") + "ddee";
}

function fakeNodeFetch(eventPayloads: string[]): typeof fetch {
  const header = {
    parentHash: `0x${"00".repeat(32)}`,
    number: "0x0",
    stateRoot: `0x${"b0".repeat(32)}`,
    extrinsicsRoot: `0x${"c0".repeat(32)}`,
    digest: { logs: [MNSV_DIGEST_V1] },
  };
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    switch (body.method) {
      case "chain_getBlockHash":
      case "chain_getFinalizedHead":
        return reply(BLOCK_HASH);
      case "chain_getHeader":
        return reply(header);
      case "chain_getBlock":
        return reply({ block: { header, extrinsics: [bareSystemExtrinsicHex(ARCHIVED_TX_HEX)] } });
      // `state_getStorageAt`, not `state_getStorage` -- the guard reads storage AT a block hash.
      // Answering the wrong name returns null, which the guard reads as "this block has no events"
      // and skips, so the test would pass vacuously without ever exercising the guard.
      case "state_getStorageAt":
        return reply(eventsBlobHex(eventPayloads));
      case "state_call":
        return reply("0x0a000000");
      default:
        return reply(null);
    }
  }) as typeof fetch;
}

describe("event guard: a runtime-generated system transaction cannot hide behind a failed one", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let schemaCounter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  async function syncWith(eventPayloads: string[]) {
    const schema = `event_guard_${schemaCounter++}`;
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await bootstrapChainArchiveSchema(sql, schema);
    const service = new ChainArchiveSyncService({
      sql, net: NET, schema,
      node: { url: "http://fake-node", fetchImpl: fakeNodeFetch(eventPayloads) },
    });
    return { run: () => service.syncOnce({ maxBlocks: 1 }), schema };
  }

  it("refuses when an event payload matches nothing archived, at equal counts", async () => {
    // One archived (from the extrinsic), one event-only and DIFFERENT. Counts are 1 and 1, so the
    // previous count-based guard permitted this exact block.
    const { run, schema } = await syncWith([EVENT_ONLY_TX_HEX]);
    await expect(run()).rejects.toThrow(/matching none of the 1 archived/);

    // Refusal must leave nothing behind, or a later run would extend a silently incomplete archive.
    const [blocks] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.blocks WHERE net = ${NET}
    `;
    expect(blocks!.n, "no block row").toBe(0);
  }, 180_000);

  it("permits the block when the event payload IS the archived one", async () => {
    // The dual-source case: a successful direct system call appears in both the extrinsic and the
    // event. Nothing is missing, so the guard must stay silent -- otherwise it would refuse every
    // ordinary block carrying a successful system call, trading a silent omission for a stall.
    const { run, schema } = await syncWith([ARCHIVED_TX_HEX]);
    await expect(run()).resolves.toBeDefined();
    const [txs] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.transactions WHERE net = ${NET} AND kind = 'system'
    `;
    expect(txs!.n, "the archived system transaction is present").toBe(1);
  }, 180_000);
});
