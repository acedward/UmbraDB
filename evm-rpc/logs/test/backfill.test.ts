import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Interface } from "ethers";
import { createClient, type UmbraDBSql } from "../../../src/postgres/client.js";
import { runMigrations } from "../../../src/postgres/migrate.js";
import { evmRpcMigrations } from "../../../src/postgres/migrations/evm_rpc/index.js";
import {
  backfillGenesis,
  backfillWatched,
  foldTransferBalances,
  parseDeployment,
  type Deployment,
} from "../backfill.js";
import { startIngest } from "../ingest.js";
import { getLogs } from "../get-logs.js";
import { writeLogs, type SqlPool } from "../store.js";
import { defaultAddressMapper, toHex, type MidnightEvent } from "../event-map.js";
import type { WatchEntry } from "../config.js";
import { startFakeIndexer } from "./fake-indexer.js";

/**
 * C-G5. The headline check is the plan's: for a `deployment.json` with two genesis holders, the
 * balances folded out of the Transfer logs from block 0 equal the fixture's stated balances
 * EXACTLY — which is the property the whole ERC20-log-compatibility story rests on, and the one
 * that silently breaks if constructor-minted supply is left un-backfilled.
 */
describe("genesis backfill (C-G5)", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  const schema = "evm_rpc";
  const CONTRACT = "11".repeat(32);
  const ALICE = "a1".repeat(32);
  const BOB = "b0".repeat(32);
  const CAROL = "c2".repeat(32);

  const entry: WatchEntry = { address: CONTRACT, profile: "erc20" };
  const pool = (): SqlPool => sql as unknown as SqlPool;
  const contractEvm = () => defaultAddressMapper({ kind: "contract", hex: CONTRACT });
  const evm = (accountId: string) => toHex(defaultAddressMapper({ kind: "midnight", hex: accountId }));

  const DEPLOYMENT: Deployment = {
    contractAddress: CONTRACT,
    deployBlock: 5,
    genesisBalances: [
      { accountId: ALICE, amount: "1000000" },
      { accountId: BOB, amount: "250" },
    ],
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await runMigrations(sql, { schema, migrations: evmRpcMigrations });
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  const reset = async (): Promise<void> => {
    await sql`TRUNCATE ${sql(schema)}.logs, ${sql(schema)}.log_cursors`;
    await sql`TRUNCATE ${sql(schema)}.address_map CASCADE`;
  };

  it("folds logs-derived balances that equal the fixture's stated balances exactly", async () => {
    await reset();
    const result = await backfillGenesis(pool(), schema, entry, DEPLOYMENT);
    expect(result).toEqual({ holders: 2, inserted: 2, skipped: 0 });

    const balances = await foldTransferBalances(sql, schema, contractEvm());
    expect(balances.size).toBe(2);
    expect(balances.get(evm(ALICE))).toBe(1_000_000n);
    expect(balances.get(evm(BOB))).toBe(250n);
    // Total supply equals the sum of the stated balances — nothing invented, nothing lost.
    expect([...balances.values()].reduce((a, b) => a + b, 0n)).toBe(1_000_250n);
  });

  it("is idempotent — re-running inserts nothing and changes no balance", async () => {
    const before = await foldTransferBalances(sql, schema, contractEvm());
    const rerun = await backfillGenesis(pool(), schema, entry, DEPLOYMENT);
    expect(rerun).toEqual({ holders: 2, inserted: 0, skipped: 2 });
    const after = await foldTransferBalances(sql, schema, contractEvm());
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());

    const count = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(schema)}.logs`;
    expect(count[0]!.n).toBe(2);
  });

  it("emits mints ethers decodes as Transfer(from = address(0)), at the deploy block", async () => {
    const logs = await getLogs({ sql, schema }, [{ fromBlock: "earliest" }]);
    expect(logs).toHaveLength(2);
    const iface = new Interface([
      "event Transfer(address indexed from, address indexed to, uint256 value)",
    ]);
    const parsed = logs.map((log) => iface.parseLog({ topics: log.topics, data: log.data })!);
    expect(parsed.map((p) => p.name)).toEqual(["Transfer", "Transfer"]);
    expect(parsed.every((p) => p.args.from === "0x0000000000000000000000000000000000000000")).toBe(true);
    expect(parsed.map((p) => p.args.value)).toEqual([1_000_000n, 250n]);
    // Deploy block from the fixture, and distinct positions inside the one synthetic deploy tx.
    expect(logs.map((l) => l.blockNumber)).toEqual(["0x5", "0x5"]);
    expect(logs.map((l) => l.logIndex)).toEqual(["0x0", "0x1"]);
    // Negative source ids, so real (positive) event ids can never collide with them.
    const ids = await sql<{ source_event_id: bigint }[]>`
      SELECT source_event_id FROM ${sql(schema)}.logs ORDER BY log_index
    `;
    expect(ids.every((r) => r.source_event_id < 0n)).toBe(true);
  });

  it("composes with real ingested transfers: genesis + a transfer folds to the right balances", async () => {
    await reset();
    await backfillGenesis(pool(), schema, entry, DEPLOYMENT);

    // Alice sends 400 to Carol, ingested through the real path.
    const indexer = await startFakeIndexer();
    const handle = startIngest({
      sql: pool(),
      schema,
      indexerWs: indexer.url,
      contracts: [entry],
      idleFlushMs: 100,
      onError: () => {},
    });
    try {
      const txHash = "77".repeat(32);
      const transaction = {
        hash: txHash,
        block: { height: 9, hash: "bb".repeat(32), transactions: [{ hash: txHash }] },
      };
      const common = {
        contractAddress: CONTRACT,
        transactionId: 1,
        transaction,
        domainSep: "d5".repeat(32),
        tokenType: "77".repeat(32),
        amount: "400",
      };
      const events: MidnightEvent[] = [
        { __typename: "UnshieldedSpendEvent", id: 1, ...common, sender: { kind: "USER", userAddress: ALICE, contractAddress: null } },
        { __typename: "UnshieldedReceiveEvent", id: 2, ...common, recipient: { kind: "USER", userAddress: CAROL, contractAddress: null } },
      ];
      indexer.emit(...events);

      const deadline = Date.now() + 30_000;
      for (;;) {
        const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(schema)}.logs`;
        if (rows[0]!.n === 3) break;
        if (Date.now() > deadline) throw new Error(`expected 3 logs, saw ${rows[0]!.n}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      handle.stop();
      await handle.done.catch(() => {});
      await indexer.close();
    }

    const balances = await foldTransferBalances(sql, schema, contractEvm());
    expect(balances.get(evm(ALICE))).toBe(999_600n); // 1_000_000 - 400
    expect(balances.get(evm(BOB))).toBe(250n);
    expect(balances.get(evm(CAROL))).toBe(400n);
    // A transfer moves supply, never changes it.
    expect([...balances.values()].reduce((a, b) => a + b, 0n)).toBe(1_000_250n);
  }, 120_000);

  it("does not touch log_cursors — genesis rows sit outside the real event sequence", async () => {
    await reset();
    await backfillGenesis(pool(), schema, entry, DEPLOYMENT);
    const cursors = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(schema)}.log_cursors
    `;
    expect(cursors[0]!.n).toBe(0);
  });

  it("keeps two contracts' genesis rows in disjoint negative ranges", async () => {
    await reset();
    const other: WatchEntry = { address: "22".repeat(32), profile: "erc20" };
    await backfillGenesis(pool(), schema, entry, DEPLOYMENT);
    await backfillGenesis(pool(), schema, other, {
      ...DEPLOYMENT,
      contractAddress: other.address,
      genesisBalances: [{ accountId: CAROL, amount: "7" }],
    });
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ${sql(schema)}.logs`;
    expect(rows[0]!.n).toBe(3); // no id collision swallowed a row
    expect(await foldTransferBalances(sql, schema, contractEvm())).toHaveProperty("size", 2);
    const otherEvm = defaultAddressMapper({ kind: "contract", hex: other.address });
    const otherBalances = await foldTransferBalances(sql, schema, otherEvm);
    expect(otherBalances.get(evm(CAROL))).toBe(7n);
  });

  it("handles the erc721 profile by putting the tokenId in topic3", async () => {
    await reset();
    const nft: WatchEntry = { address: "33".repeat(32), profile: "erc721" };
    await backfillGenesis(pool(), schema, nft, {
      contractAddress: nft.address,
      deployBlock: 1,
      genesisBalances: [{ accountId: ALICE, amount: "42" }],
    });
    const logs = await getLogs({ sql, schema }, [{ fromBlock: "earliest" }]);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.topics).toHaveLength(4);
    expect(BigInt(logs[0]!.topics[3]!)).toBe(42n);
    expect(logs[0]!.data).toBe("0x");
  });

  it("skips a misc-profile contract with a warning rather than inventing ERC20 mints", async () => {
    await reset();
    const warnings: string[] = [];
    const result = await backfillGenesis(
      pool(),
      schema,
      { address: "44".repeat(32), profile: "misc" },
      DEPLOYMENT,
      { onWarning: (message) => warnings.push(message) },
    );
    expect(result).toEqual({ holders: 0, inserted: 0, skipped: 0 });
    expect(warnings.join(" ")).toMatch(/profile "misc"/);
  });

  it("rejects a deployment.json whose contractAddress disagrees with the watched address", async () => {
    await expect(
      backfillGenesis(pool(), schema, entry, { ...DEPLOYMENT, contractAddress: "99".repeat(32) }),
    ).rejects.toThrow(/does not match/);
  });

  it("parses a deployment.json file and drives the backfill from a watch entry", async () => {
    await reset();
    const dir = mkdtempSync(join(tmpdir(), "evm-logs-backfill-"));
    const path = join(dir, "deployment.json");
    writeFileSync(path, JSON.stringify(DEPLOYMENT), "utf8");

    expect(parseDeployment(JSON.stringify(DEPLOYMENT)).genesisBalances).toHaveLength(2);
    const results = await backfillWatched(pool(), schema, [{ ...entry, deploymentFile: path }]);
    expect(results.get(CONTRACT)).toEqual({ holders: 2, inserted: 2, skipped: 0 });
    // An entry without a deploymentFile is simply not backfilled.
    expect((await backfillWatched(pool(), schema, [entry])).size).toBe(0);
  });

  it("tolerates an absent genesisBalances and an empty holder list", async () => {
    await reset();
    expect(parseDeployment("{}").genesisBalances).toEqual([]);
    const result = await backfillGenesis(pool(), schema, entry, { genesisBalances: [] });
    expect(result).toEqual({ holders: 0, inserted: 0, skipped: 0 });
  });

  it("excludes burns from the folded balances via the address(0) sink", async () => {
    await reset();
    await backfillGenesis(pool(), schema, entry, DEPLOYMENT);
    // Bob burns his whole 250: Transfer(bob -> 0x0, 250).
    const to32 = new Uint8Array(32);
    const from32 = new Uint8Array(32);
    from32.set(defaultAddressMapper({ kind: "midnight", hex: BOB }), 12);
    const value = Uint8Array.from(Buffer.from((250n).toString(16).padStart(64, "0"), "hex"));
    await writeLogs(
      pool(),
      schema,
      [
        {
          address: contractEvm(),
          blockNumber: 11,
          blockHash: Uint8Array.from(Buffer.from("cc".repeat(32), "hex")),
          txHash: Uint8Array.from(Buffer.from("dd".repeat(32), "hex")),
          txIndex: 0,
          logIndex: 0,
          topics: [
            Uint8Array.from(Buffer.from("ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "hex")),
            from32,
            to32,
          ],
          data: value,
          sourceEventId: 5_000,
          removed: false,
        },
      ],
      { contractIdentity: { kind: "contract", hex: CONTRACT } },
    );
    const balances = await foldTransferBalances(sql, schema, contractEvm());
    expect(balances.get(evm(BOB))).toBe(0n);
    // address(0) never appears as a holder.
    expect(balances.has("0".repeat(40))).toBe(false);
  });
});
