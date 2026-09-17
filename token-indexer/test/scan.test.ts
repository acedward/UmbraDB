import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { loadLedgerV9 } from "../../chain-archive-sync/tx-replay-decoder.js";
import { bootstrapTokenIndexSchema } from "../bootstrap.js";
import { tokenColorHex } from "../color.js";
import { countedEffects, type DecodedTransactionActions } from "../ingest/decode.js";
import type { EventSource, IndexerContractEvent } from "../ingest/events.js";
import { TokenScanner } from "../ingest/scan.js";
import { readDecodeCursor } from "../ingest/store.js";
import { loadScanFixture, loadScanFixtures, seedArchive } from "./helpers/archive-fixture.js";
import { seedEmptyBlock } from "./helpers/synthetic-archive.js";

/**
 * Project 00020, sub-plan 01 Phase 4 — `[[token-scan-mints]]`.
 *
 * The scanner runs against a REAL `chain_archive` schema holding REAL Stagenet transactions (the
 * six mint-test-tokens issuers' deploys and mint calls, recorded by hash on 2026-09-17), through the
 * real store and the real ledger-v9 WASM decoder. Only the event source is faked, and only because
 * these particular contracts emit nothing at all — which the test asserts, rather than assumes.
 */

const NET = "stagenet";

/** No contract in the fixture set emits, so any lookup at all would be a bug. */
class NeverCalledEventSource implements EventSource {
  calls = 0;
  async eventsFor(): Promise<IndexerContractEvent[]> {
    this.calls++;
    return [];
  }
}

describe("token scanner over recorded Stagenet transactions", () => {
  let container: StartedPostgreSqlContainer;
  let ledger: unknown;
  const open: UmbraDBSql[] = [];
  let counter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    ledger = await loadLedgerV9();
  }, 180_000);

  afterAll(async () => {
    while (open.length > 0) await open.pop()!.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  async function freshDb(): Promise<{ sql: UmbraDBSql; schema: string; archiveSchema: string }> {
    const id = counter++;
    const schema = `token_scan_${id}`;
    const archiveSchema = `arch_scan_${id}`;
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    open.push(sql);
    await bootstrapChainArchiveSchema(sql, archiveSchema);
    await bootstrapTokenIndexSchema(sql, { schema, net: NET });
    return { sql, schema, archiveSchema };
  }

  function scanner(
    db: { sql: UmbraDBSql; schema: string; archiveSchema: string },
    eventSource: EventSource,
    batchSize = 500,
  ): TokenScanner {
    return new TokenScanner({
      sql: db.sql, schema: db.schema, archiveSchema: db.archiveSchema, net: NET,
      eventSource, ledger, batchSize,
    });
  }

  it("[[token-scan-mints]] decodes every recorded deploy and mint into exact contract, token and mint rows, and a re-scan changes nothing", async () => {
    const db = await freshDb();
    const fixtures = loadScanFixtures();
    expect(fixtures).toHaveLength(12); // 6 deploys + 6 mint calls
    await seedArchive(db.sql, db.archiveSchema, NET, fixtures);

    const events = new NeverCalledEventSource();
    const outcome = await scanner(db, events).scanOnce();

    expect(outcome.transactionsScanned).toBe(12);
    expect(outcome.deploys).toBe(6);
    expect(outcome.calls).toBe(6);
    expect(outcome.mints).toBe(6);
    expect(outcome.skippedUnknownResult).toBe(0);
    expect(outcome.waitingForResult).toBeUndefined();
    // None of these contracts emits, so the scanner must not have asked the indexer anything.
    expect(outcome.lookups).toBe(0);
    expect(events.calls).toBe(0);

    // --- contracts: every issuer, with the deploy height the chain recorded ------------------
    const contracts = await db.sql<{ address: Buffer; deploy_height: string; last_call_height: string }[]>`
      SELECT address, deploy_height, last_call_height FROM ${db.sql(db.schema)}.contracts
      WHERE net = ${NET} ORDER BY deploy_height
    `;
    expect(contracts.map((c) => Number(c.deploy_height))).toEqual([360721, 360724, 360728, 360731, 360734, 360737]);
    expect(contracts.every((c) => Number(c.last_call_height) > 364000)).toBe(true);

    // --- tokens: one row per issuer, colour derived, storage native, status observed ---------
    const tokens = await db.sql<{
      address: Buffer; domain_sep: Buffer; kind: string; storage: string; color: Buffer | null;
      status: string; mint_count: string; total_minted: string; name: string | null;
      first_mint_height: string; last_mint_height: string;
    }[]>`
      SELECT address, domain_sep, kind, storage, color, status, mint_count, total_minted, name,
             first_mint_height, last_mint_height
      FROM ${db.sql(db.schema)}.tokens WHERE net = ${NET} AND status <> 'builtin'
      ORDER BY first_mint_height
    `;
    expect(tokens).toHaveLength(6);
    for (const row of tokens) {
      const address = row.address.toString("hex");
      const domainSep = row.domain_sep.toString("hex");
      expect(row.storage).toBe("native");
      expect(row.status).toBe("observed"); // nothing described itself
      expect(row.name).toBeNull();
      expect(Number(row.mint_count)).toBe(1);
      expect(row.color?.toString("hex")).toBe(tokenColorHex(domainSep, address));
      expect(row.first_mint_height).toBe(row.last_mint_height);
      // The domain separator really is the registry's published string, NUL-padded.
      expect(Buffer.from(domainSep, "hex").toString("utf8").replace(/\0+$/, ""))
        .toMatch(/^mint-test-tokens:(tw|utw)/);
    }
    // The two unshielded issuers' colours equal the token type of the UTXO their mint created.
    const unshieldedFixtures = fixtures.filter((f) => f.unshieldedCreatedOutputs.length > 0);
    expect(unshieldedFixtures).toHaveLength(2);
    for (const fixture of unshieldedFixtures) {
      const observed = fixture.unshieldedCreatedOutputs[0]!.tokenType;
      const match = tokens.find((t) => t.color?.toString("hex") === observed);
      expect(match, `no token row for observed token type ${observed}`).toBeDefined();
      expect(match!.kind).toBe("unshielded");
      expect(match!.total_minted).toBe(fixture.unshieldedCreatedOutputs[0]!.value);
    }
    expect(tokens.filter((t) => t.kind === "shielded")).toHaveLength(4);

    // --- mints: one row each, keyed by the real transaction ---------------------------------
    const mints = await db.sql<{ tx_hash: Buffer; amount: string; entry_point: string | null; segment: number }[]>`
      SELECT tx_hash, amount, entry_point, segment FROM ${db.sql(db.schema)}.token_mints
      WHERE net = ${NET} ORDER BY block_height
    `;
    expect(mints).toHaveLength(6);
    expect(mints.every((m) => m.entry_point === "mint")).toBe(true);
    expect(new Set(mints.map((m) => m.tx_hash.toString("hex"))).size).toBe(6);

    // --- cursor and idempotence --------------------------------------------------------------
    expect(await readDecodeCursor(db.sql, db.schema, NET)).toEqual({ height: 364934, position: 0 });
    const second = await scanner(db, events).scanOnce();
    expect(second).toMatchObject({ transactionsScanned: 0, mints: 0, atTip: true });
    const after = await db.sql<{ tokens: string; mints: string }[]>`
      SELECT (SELECT count(*)::text FROM ${db.sql(db.schema)}.tokens WHERE net = ${NET}) AS tokens,
             (SELECT count(*)::text FROM ${db.sql(db.schema)}.token_mints WHERE net = ${NET}) AS mints
    `;
    expect(after[0]).toEqual({ tokens: "8", mints: "6" }); // 6 + the two built-in seeds
  }, 300_000);

  it("[[token-scan-not-counted]] a FAILED transaction's mint is not counted, and a non-canonical block is not scanned at all", async () => {
    const db = await freshDb();
    const utwBtc = loadScanFixture("mint-utwBTC");
    const utwUsdc = loadScanFixture("mint-utwUSDC");
    await seedArchive(db.sql, db.archiveSchema, NET, [utwBtc, utwUsdc], {
      // The utwBTC mint is re-labelled as a failed transaction: real bytes, declared mint, no effect.
      resultOverride: (f) => f.label === "mint-utwBTC"
        ? { result: "failure", segments: null }
        : { result: "success", segments: null },
      nonCanonical: (f) => f.label === "mint-utwUSDC",
    });

    const outcome = await scanner(db, new NeverCalledEventSource()).scanOnce();
    expect(outcome.transactionsScanned).toBe(1); // only the failed one; the orphan is invisible
    expect(outcome.mints).toBe(0);
    // The contract is still recorded — it really was called, the call simply had no effect.
    const contracts = await db.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ${db.sql(db.schema)}.contracts WHERE net = ${NET}`;
    expect(contracts[0]!.n).toBe("1");
    const tokens = await db.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ${db.sql(db.schema)}.tokens WHERE net = ${NET} AND status <> 'builtin'`;
    expect(tokens[0]!.n).toBe("0");
  }, 180_000);

  it("[[token-scan-unknown-result]] a transaction whose archived result is unknown BLOCKS the cursor instead of being guessed at or skipped", async () => {
    const db = await freshDb();
    const fixture = loadScanFixture("mint-utwBTC");
    await seedArchive(db.sql, db.archiveSchema, NET, [fixture], {
      resultOverride: () => ({ result: null, segments: null }),
    });

    const scan = scanner(db, new NeverCalledEventSource());
    const outcome = await scan.scanOnce();
    expect(outcome.transactionsScanned).toBe(0);
    expect(outcome.mints).toBe(0);
    expect(outcome.waitingForResult).toEqual({ txHash: fixture.transaction.hash, blockHeight: fixture.blockHeight });
    expect(await readDecodeCursor(db.sql, db.schema, NET)).toEqual({ height: 0, position: -1 });

    // Once the result is backfilled, the same scanner counts it.
    await db.sql`
      UPDATE ${db.sql(db.archiveSchema)}.transactions SET result = 'success'
      WHERE net = ${NET} AND tx_hash = ${Buffer.from(fixture.transaction.hash, "hex")}
    `;
    const after = await scan.scanOnce();
    expect(after.transactionsScanned).toBe(1);
    expect(after.mints).toBe(1);
  }, 180_000);

  it("[[token-scan-atomic]] the batch is atomic: a failure inside it leaves no rows and does not move the cursor", async () => {
    const db = await freshDb();
    const fixtures = loadScanFixtures();
    await seedArchive(db.sql, db.archiveSchema, NET, fixtures);

    // A ledger stand-in that decodes the first few transactions and then throws, standing in for a
    // crash partway through a batch.
    let decoded = 0;
    const flaky = new Proxy(ledger as object, {
      get(target, prop, receiver) {
        if (prop === "Transaction") {
          return {
            deserialize: (...args: unknown[]) => {
              if (++decoded > 4) throw new Error("simulated crash mid-batch");
              return (Reflect.get(target, "Transaction", receiver) as { deserialize: (...a: unknown[]) => unknown })
                .deserialize(...args);
            },
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const scan = new TokenScanner({
      sql: db.sql, schema: db.schema, archiveSchema: db.archiveSchema, net: NET,
      eventSource: new NeverCalledEventSource(), ledger: flaky,
    });
    await expect(scan.scanOnce()).rejects.toThrow(/simulated crash mid-batch/);

    const state = await db.sql<{ contracts: string; mints: string; cursors: string }[]>`
      SELECT (SELECT count(*)::text FROM ${db.sql(db.schema)}.contracts WHERE net = ${NET}) AS contracts,
             (SELECT count(*)::text FROM ${db.sql(db.schema)}.token_mints WHERE net = ${NET}) AS mints,
             (SELECT count(*)::text FROM ${db.sql(db.schema)}.cursors WHERE net = ${NET}) AS cursors
    `;
    expect(state[0]).toEqual({ contracts: "0", mints: "0", cursors: "0" });

    // A clean scanner over the same archive produces the full result — nothing was lost.
    const clean = await scanner(db, new NeverCalledEventSource()).scanOnce();
    expect(clean.mints).toBe(6);
  }, 300_000);

  it("[[token-scan-idle-cursor]] the cursor walks over transaction-free blocks, so a quiet chain still shows the decoder keeping up", async () => {
    const db = await freshDb();
    // A quiet chain: blocks 1000-1004 with nothing in them at all.
    for (let h = 1000; h <= 1004; h++) await seedEmptyBlock(db.sql, db.archiveSchema, NET, h);

    const scan = scanner(db, new NeverCalledEventSource());
    const empty = await scan.scanOnce();
    expect(empty).toMatchObject({ transactionsScanned: 0, mints: 0, atTip: true });
    expect(empty.cursor).toEqual({ height: 1004, position: -1 });
    expect(await readDecodeCursor(db.sql, db.schema, NET)).toEqual({ height: 1004, position: -1 });

    // A transaction arriving in a LATER block is still picked up — the advance never runs ahead of
    // the archive, only up to the tip it read before proving the range was empty.
    const fixture = loadScanFixture("mint-utwBTC");
    await seedArchive(db.sql, db.archiveSchema, NET, [fixture]);
    const after = await scan.scanOnce();
    expect(after.mints).toBe(1);
    expect(after.cursor).toEqual({ height: fixture.blockHeight, position: 0 });

    // Idling again at the new tip is a no-op, not a rewind.
    const idle = await scan.scanOnce();
    expect(idle.cursor).toEqual({ height: fixture.blockHeight, position: 0 });
  }, 180_000);

  it("[[token-scan-counting-rule]] the FR-002 counting rule, exhaustively, on synthetic transcripts", () => {
    // No transaction in the recorded Stagenet set has a FALLIBLE mint (all six issuers mint in the
    // guaranteed transcript), and fabricating one would mean forging proven transaction bytes. The
    // rule is therefore proven here, directly, over the decoded shape the walk produces — and the
    // DB-level test above proves the real bytes flow through the same code path.
    const facts = (mints: Record<string, bigint>, logOps = 0): NonNullable<DecodedTransactionActions["actions"]>[number]["guaranteed"] => ({
      logOps, shieldedMints: new Map(), unshieldedMints: new Map(Object.entries(mints)),
    });
    const decoded: DecodedTransactionActions = {
      isSystem: false,
      actions: [{
        segment: 7, callIndex: 0, kind: "call", address: "aa".repeat(32), entryPoint: "mint",
        guaranteed: facts({ ["11".repeat(32)]: 100n }, 2),
        fallible: facts({ ["22".repeat(32)]: 200n }, 3),
      }],
    };

    const success = countedEffects(decoded, "success", null, "tx");
    expect(success.mints.map((m) => [m.section, m.amount])).toEqual([["guaranteed", 100n], ["fallible", 200n]]);
    expect(success.logOpsByAddress.get("aa".repeat(32))).toBe(5);

    const failure = countedEffects(decoded, "failure", null, "tx");
    expect(failure.mints).toHaveLength(0);
    expect(failure.logOpsByAddress.size).toBe(0);
    expect(failure.callAddresses.size).toBe(1); // the call still happened

    const partialOk = countedEffects(decoded, "partial_success", [{ id: 7, success: true }], "tx");
    expect(partialOk.mints.map((m) => m.section)).toEqual(["guaranteed", "fallible"]);

    const partialFailed = countedEffects(decoded, "partial_success", [{ id: 7, success: false }], "tx");
    expect(partialFailed.mints.map((m) => [m.section, m.amount])).toEqual([["guaranteed", 100n]]);
    expect(partialFailed.logOpsByAddress.get("aa".repeat(32))).toBe(2); // only the guaranteed logs

    // A segment the indexer did not list inside a PARTIAL_SUCCESS result did not succeed.
    const partialMissing = countedEffects(decoded, "partial_success", [{ id: 9, success: true }], "tx");
    expect(partialMissing.mints.map((m) => m.section)).toEqual(["guaranteed"]);

    // No segments at all for a PARTIAL_SUCCESS transaction is an explicit error, never a guess.
    expect(() => countedEffects(decoded, "partial_success", null, "deadbeef"))
      .toThrow(/deadbeef is partial_success but the archive has no segments/);
  });
});
