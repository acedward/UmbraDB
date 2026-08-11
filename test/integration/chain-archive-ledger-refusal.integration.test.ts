import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { ChainArchiveSyncService } from "../../chain-archive-sync/sync-service.js";
import { metadataRpcResult } from "./fake-node-metadata.js";

/**
 * The archive must REFUSE, not silently omit, when the loaded ledger cannot hash a system
 * transaction. Every terminal insert is `ON CONFLICT DO NOTHING`, so an archive written without
 * its system transactions cannot be repaired by re-ingesting later -- silence here is permanent
 * data loss.
 *
 * This test exists because vendoring the patched ledger (`vendor/ledger-v8-syshash`) made that
 * guarantee untestable by accident. The refusal case used to be reached by simply NOT having the
 * export -- the sibling suite gates it as `it.skipIf(haveSystemHash)`. Now the capable build is
 * the repo's own dependency, so that condition is never true from a fresh clone and the refusal
 * path would silently stop being exercised: coverage lost without a single test turning red.
 *
 * So the condition is CONSTRUCTED rather than waited for. `ledger-v8-stock` is the published
 * 8.0.3, pinned exactly (a range could drift onto a version that has the export and quietly
 * neuter this test), and `MIDNIGHT_LEDGER_WASM` points ingest at it for the duration. That
 * override is precisely the test-only escape hatch it was kept for.
 *
 * Uses a fake node rather than the compose stack: the refusal is a property of the ledger and the
 * payload, not of any live chain, so it should be enforceable in CI without services.
 */
const NET = "ledger_refusal";
const require_ = createRequire(import.meta.url);

/** SCALE compact-u32, the four-mode encoding used for both the envelope and the payload length. */
function compactU32Hex(value: number): string {
  if (value < 64) return (value << 2).toString(16).padStart(2, "0");
  if (value < 2 ** 14) {
    const v = (value << 2) | 0b01;
    return (v & 0xff).toString(16).padStart(2, "0") + ((v >> 8) & 0xff).toString(16).padStart(2, "0");
  }
  const v = (value << 2) | 0b10;
  return [0, 8, 16, 24].map((s) => ((v >>> s) & 0xff).toString(16).padStart(2, "0")).join("");
}

/** A bare extrinsic dispatching `pallet_midnight_system::send_mn_system_transaction`
 *  (pallet 6, call 0 on node 1.0.x) carrying `payloadHex` as its single `Vec<u8>` argument. */
function bareSystemExtrinsicHex(payloadHex: string): string {
  const inner = "05" + "06" + "00" + compactU32Hex(payloadHex.length / 2) + payloadHex;
  return compactU32Hex(inner.length / 2) + inner;
}

/** A REAL serialized system transaction, from the same ground-truth fixture the vendored-build
 *  vectors use -- genesis position 0 of a 1.0.0 devnet, as archived by midnight-indexer 4.3.2.
 *  It must be real: the refusal happens while hashing a successfully deserialized system
 *  transaction, so synthetic bytes would fail earlier and prove something else. */
const REAL_SYSTEM_TX_HEX = readFileSync(
  new URL("../fixtures/ledger-vectors/genesis-system-tx-hashes.txt", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")[0]!
  .trim()
  .split(/\s+/)[3]!;

/** The genuine MNSV consensus digest captured from a live devnet, carrying protocol 1_000_000. */
const MNSV_DIGEST_V1 = "0x044d4e53561040420f00";
const GENESIS_HASH = `0x${"a0".repeat(32)}`;

function fakeNodeFetch(): typeof fetch {
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
    // Node-only ingest resolves the block's runtime metadata before it can classify anything, so
    // a fake node must answer these or the service refuses for the wrong reason entirely.
    const meta = metadataRpcResult(body.method);
    if (meta !== undefined) return reply(meta);
    switch (body.method) {
      case "chain_getBlockHash":
        return reply(GENESIS_HASH);
      case "chain_getFinalizedHead":
        return reply(GENESIS_HASH);
      case "chain_getHeader":
        return reply(header);
      case "chain_getBlock":
        return reply({ block: { header, extrinsics: [bareSystemExtrinsicHex(REAL_SYSTEM_TX_HEX)] } });
      case "state_getStorageAt":
        // No events: this chain's only system transaction is extrinsic-borne, which is the case
        // under test. An empty event list keeps the event-borne guard out of the picture.
        return reply("0x00");
      case "state_call":
        return reply("0x0a000000");
      default:
        return reply(null);
    }
  }) as typeof fetch;
}

describe("ingest refuses when the ledger cannot hash a system transaction", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let stockEntry: string;
  let previousOverride: string | undefined;

  beforeAll(async () => {
    // Resolve the BARE specifier, exactly as `ledgerV8EntryPath()` does for the real dependency:
    // the package's `exports` map exposes only the root, whose `node` condition already points at
    // `midnight_ledger_wasm_fs.js`. Asking for that subpath directly is refused with
    // ERR_PACKAGE_PATH_NOT_EXPORTED.
    stockEntry = require_.resolve("ledger-v8-stock");
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  it("the stock ledger genuinely lacks the export (the premise of this test)", async () => {
    // Asserted rather than assumed. If a future 8.0.3 somehow gained the export, the refusal test
    // below would pass for the wrong reason -- it would simply never reach the refusal.
    const stock: any = await import(stockEntry);
    expect(typeof stock.SystemTransaction?.prototype?.transactionHash).not.toBe("function");
  }, 60_000);

  it("refuses the block and writes nothing", async () => {
    const schema = "ledger_refusal";
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await bootstrapChainArchiveSchema(sql, schema);

    previousOverride = process.env.MIDNIGHT_LEDGER_WASM;
    process.env.MIDNIGHT_LEDGER_WASM = stockEntry;
    try {
      const service = new ChainArchiveSyncService({
        sql, net: NET, schema,
        node: { url: "http://fake-node", fetchImpl: fakeNodeFetch() },
      });
      await expect(service.syncOnce({ maxBlocks: 1 })).rejects.toThrow(
        /exposes no SystemTransaction\.transactionHash/,
      );
    } finally {
      if (previousOverride === undefined) delete process.env.MIDNIGHT_LEDGER_WASM;
      else process.env.MIDNIGHT_LEDGER_WASM = previousOverride;
    }

    // Refusing is only half the guarantee: it must also leave no partial state. A block row
    // without its transactions would be indistinguishable from a complete one on re-ingest,
    // and `ON CONFLICT DO NOTHING` would never repair it.
    const [blocks] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.blocks WHERE net = ${NET}
    `;
    const [txs] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.transactions WHERE net = ${NET}
    `;
    expect(blocks!.n, "no block row").toBe(0);
    expect(txs!.n, "no transaction row").toBe(0);
  }, 180_000);
});
