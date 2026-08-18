import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { PgChainArchiveStore } from "../../src/postgres/chain-archive-store.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import {
  decodeArchivedTransaction,
  isStandardTransaction,
  isSystemTransaction,
  ledgerV8EntryPath,
  loadLedgerV8,
  type DecodedArchivedTransaction,
} from "../../chain-archive-sync/tx-replay-decoder.js";

/**
 * AC-4 (replay-recoverability for every deferred data category, the hard gate --
 * `openspec/changes/full-chain-storage-acceptance-criteria/specs/full-chain-archive-
 * verification/spec.md`): an actual end-to-end test that reconstructs real zswap, unshielded-
 * UTXO, and dust events **using only archived raw transaction bytes** -- read back from a real
 * Postgres `chain_archive` schema (testcontainers) via `getBlob` (hash-verified, Postgres-only,
 * zero network) and decoded locally with the `@midnight-ntwrk/ledger-v8` WASM decoder -- then
 * checks every reconstructed value against what the indexer INDEPENDENTLY reports for the same
 * event (read from a real Midnight indexer's own SQLite storage, captured from a synced public
 * testnet -- the ground-truth side AC-4's scenarios explicitly call for, queried separately and
 * never used as an input to the reconstruction).
 *
 * The transaction bytes ingested here are REAL on-chain Midnight testnet payloads (the indexer's
 * `transactions.raw` column -- the same inner `send_mn_transaction` payload
 * `chain-archive-sync/sync-service.ts` archives as `tx_raw` blobs on a live sync), not
 * synthetic fixtures. The fixture transactions are selected by their properties, mirroring the
 * independent reviewer's own reproduction: the genesis bootstrap system transaction
 * (`DistributeReserve(1000000000000000)`, byte-identical to `design/full-chain-storage-
 * design.md` §3.2's captured devnet sample), a regular transaction carrying 28 zswap outputs
 * plus dust actions, and a regular transaction carrying three unshielded outputs plus a dust
 * spend.
 *
   * **Skip conditions (honest SKIP, never a silent vacuous pass -- same policy as the devnet
   * suite post-Finding-4)**: requires (a) the installed vendored ledger-v8 WASM bindings and
   * (b) the captured indexer SQLite database (`MIDNIGHT_INDEXER_SQLITE`, default
   * `~/midnight-testnet/indexer-data/indexer.sqlite`). A fresh clone supplies (a); CI does not
   * provision the external captured database, so this corpus suite reports SKIPPED there.
 *
 * ── CI STATUS: DOCUMENTED-MANUAL, deliberately (F7, final-review finding) ────────────────────
 * No workflow runs this suite, and none is expected to. That is a decision, not an oversight,
 * and it is recorded here so the next auditor does not have to re-derive it from the skip
 * conditions above.
 *
 * WHY NO CI PATH: the ground truth is a real Midnight indexer's own SQLite database captured
 * from a synced public testnet. It is multi-gigabyte, third-party, and not redistributable
 * through this repo; committing it is not an option, and re-syncing a public testnet indexer
 * inside a CI job to regenerate it would cost hours per run for a corpus that changes only when
 * the ledger codec does. The suite is therefore gated on the capture EXISTING, and reports
 * SKIPPED rather than passing vacuously when it does not.
 *
 * HOW TO RUN IT (the manual path this status refers to):
 *
 *   MIDNIGHT_INDEXER_SQLITE=/path/to/indexer.sqlite \
 *     npx vitest run test/integration/chain-archive-replay-decode.integration.test.ts
 *
 * WHAT COVERS THIS IN CI INSTEAD: nothing reconstructs zswap/unshielded/dust events from
 * archived bytes in CI -- that is the honest answer. The adjacent guarantees that DO run there
 * are the live 40-block parity gate (`chain-archive-parity.yml`) and the native-Rust ledger
 * oracles in `ledger-replay.test.ts`. Neither is a substitute for this suite's specific claim;
 * they bound the exposure rather than close it.
 */

const INDEXER_SQLITE_PATH =
  process.env.MIDNIGHT_INDEXER_SQLITE ??
  path.join(process.env.HOME ?? homedir(), "midnight-testnet", "indexer-data", "indexer.sqlite");

const LEDGER_AVAILABLE = ledgerV8EntryPath() !== undefined;
const GROUND_TRUTH_AVAILABLE = existsSync(INDEXER_SQLITE_PATH);

/** `design/full-chain-storage-design.md` §3.2's captured genesis system-transaction bytes
 *  (ASCII `midnight:system-transaction[v6]:` + payload) -- real on-chain bytes, documented in
 *  the design doc and independently decoded by review as `DistributeReserve(1000000000000000)`. */
const DESIGN_DOC_GENESIS_SYSTEM_TX_HEX =
  "6d69646e696768743a73797374656d2d7472616e73616374696f6e5b76365d3a050f0080c6a47e8d03";

const NET = "midnight_testnet_replay";
const SCHEMA = "chain_archive_replay_test";

interface SqliteTxRow {
  id: number;
  variant: string;
  hashHex: string;
  protocolVersion: number;
  raw: Uint8Array;
  blockHeight: number;
  blockHashHex: string;
  blockParentHashHex: string;
}

describe.skipIf(!LEDGER_AVAILABLE || !GROUND_TRUTH_AVAILABLE)(
  "AC-4: zswap/unshielded/dust events reconstructed purely from archived raw bytes match the indexer's independent report",
  () => {
    let container: StartedPostgreSqlContainer;
    let sql: UmbraDBSql;
    let store: PgChainArchiveStore;
    let db: DatabaseSync;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ledger: any;

    let systemTx: SqliteTxRow;
    let zswapTx: SqliteTxRow;
    let unshieldedDustTx: SqliteTxRow;

    function readTxRow(txId: number): SqliteTxRow {
      const row = db
        .prepare(
          "select t.id id, t.variant variant, hex(t.hash) hashHex, t.protocol_version pv, t.raw raw, " +
          "b.height bh, hex(b.hash) bHash, hex(b.parent_hash) bParent " +
          "from transactions t join blocks b on b.id = t.block_id where t.id = ?",
        )
        .get(txId) as {
          id: number; variant: string; hashHex: string; pv: number; raw: Uint8Array;
          bh: number; bHash: string; bParent: string;
        };
      expect(row).toBeDefined();
      return {
        id: row.id,
        variant: row.variant,
        hashHex: row.hashHex.toLowerCase(),
        protocolVersion: row.pv,
        raw: new Uint8Array(row.raw),
        blockHeight: row.bh,
        blockHashHex: row.bHash.toLowerCase(),
        blockParentHashHex: row.bParent.toLowerCase(),
      };
    }

    /** Reads back a fixture transaction's raw bytes USING ONLY THE ARCHIVE -- the AC-4
     *  "reconstruction step" input path: Postgres metadata lookup + hash-verified `getBlob`
     *  (AC-3's rehash-on-read), no node, no indexer, no network. */
    async function archivedRawBytes(txHashHex: string): Promise<Uint8Array> {
      const metas = await store.getTransactionsByHash(NET, txHashHex);
      expect(metas.length).toBeGreaterThanOrEqual(1);
      return store.getBlob(metas[0]!.rawBlobHash);
    }

    async function decodeFromArchive(tx: SqliteTxRow): Promise<DecodedArchivedTransaction> {
      return decodeArchivedTransaction(ledger, await archivedRawBytes(tx.hashHex));
    }

    beforeAll(async () => {
      ledger = await loadLedgerV8();
      db = new DatabaseSync(INDEXER_SQLITE_PATH, { readOnly: true });

      // Fixture selection BY PROPERTY, not hardcoded row ids: the genesis bootstrap system tx
      // (smallest System payload -- the design doc §3.2 sample), the regular tx carrying the
      // most ZswapOutput ledger events, and a regular tx that created unshielded UTXOs AND had
      // a dust spend processed.
      const sysId = (db
        .prepare("select id from transactions where variant = 'System' order by length(raw) asc limit 1")
        .get() as { id: number }).id;
      const zswapId = (db
        .prepare(
          "select transaction_id id from ledger_events where variant = 'ZswapOutput' " +
          "group by transaction_id order by count(*) desc limit 1",
        )
        .get() as { id: number }).id;
      const unshieldedId = (db
        .prepare(
          "select u.creating_transaction_id id from unshielded_utxos u " +
          "where u.creating_transaction_id in " +
          "(select transaction_id from ledger_events where variant = 'DustSpendProcessed') " +
          "group by u.creating_transaction_id order by count(*) desc, u.creating_transaction_id asc limit 1",
        )
        .get() as { id: number }).id;
      systemTx = readTxRow(sysId);
      zswapTx = readTxRow(zswapId);
      unshieldedDustTx = readTxRow(unshieldedId);

      container = await new PostgreSqlContainer("postgres:17-alpine").start();
      sql = createClient({ connectionString: container.getConnectionUri(), schema: SCHEMA });
      await bootstrapChainArchiveSchema(sql, SCHEMA);
      store = new PgChainArchiveStore(sql, SCHEMA);

      // Archive the fixture transactions' REAL raw bytes under their real block identities via
      // the normal ingestion write path (`putBlockBundle`). The indexer's SQLite schema does not
      // store the Substrate state/extrinsics roots, so those two block-METADATA columns get
      // documented placeholders -- they are not what AC-4 tests; the transaction raw bytes (the
      // replay substrate) and block heights/hashes are the real captured values.
      const placeholderRoot = (tag: string): string =>
        Buffer.from(tag.padEnd(32, "\0"), "latin1").toString("hex");
      const byBlock = new Map<string, SqliteTxRow[]>();
      for (const tx of [systemTx, zswapTx, unshieldedDustTx]) {
        const list = byBlock.get(tx.blockHashHex) ?? [];
        list.push(tx);
        byBlock.set(tx.blockHashHex, list);
      }
      for (const [blockHashHex, txs] of byBlock) {
        const first = txs[0]!;
        await store.putBlockBundle({
          block: {
            net: NET,
            blockHash: blockHashHex,
            height: first.blockHeight,
            parentHash: first.blockParentHashHex,
            stateRoot: placeholderRoot("state-root-not-under-test"),
            extrinsicsRoot: placeholderRoot("extr-root-not-under-test"),
            headerBytes: new TextEncoder().encode(`replay-test-header-${blockHashHex}`),
            isCanonical: true,
            status: "canonical",
            finalized: true,
          },
          transactions: txs.map((tx, position) => ({
            net: NET,
            txHash: tx.hashHex,
            blockHeight: tx.blockHeight,
            blockHash: blockHashHex,
            position,
            kind: tx.variant === "System" ? ("system" as const) : ("regular" as const),
            protocolVersion: tx.protocolVersion,
            rawBytes: tx.raw,
          })),
          bridgeObservations: [],
        });
      }
    }, 180_000);

    afterAll(async () => {
      db?.close();
      await sql?.end({ timeout: 5 });
      await container?.stop();
    });

    it("genesis system transaction: archived bytes decode to the real DistributeReserve bootstrap (design doc §3.2 sample decodes to DistributeReserve(1000000000000000))", async () => {
      // The design doc's own captured sample, decoded directly -- the independent reviewer's
      // exact reproduction: DistributeReserve(1000000000000000).
      const docSample = decodeArchivedTransaction(
        ledger, new Uint8Array(Buffer.from(DESIGN_DOC_GENESIS_SYSTEM_TX_HEX, "hex")),
      );
      expect(docSample.kind).toBe("system");
      expect(docSample.systemDescription).toMatch(/DistributeReserve\(\s*1000000000000000,?\s*\)/);

      // The archived-path version: same category of decode, but the bytes come exclusively from
      // the archive (Postgres getBlob, hash-verified) after real ingestion.
      const archived = await decodeFromArchive(systemTx);
      expect(archived.kind).toBe("system");
      expect(archived.systemDescription).toMatch(/DistributeReserve/);
    });

    it("zswap: every reconstructed ZswapOutput commitment matches the indexer's independently-recorded ZswapOutput ledger events for the same transaction", async () => {
      const decoded = await decodeFromArchive(zswapTx);
      expect(decoded.kind).toBe("standard");

      // Ledger-recomputed hash from the ARCHIVED bytes equals the indexer's independently
      // reported transaction hash -- the bytes decode to the transaction the indexer says it is.
      expect(decoded.transactionHash).toBe(zswapTx.hashHex);

      // Ground truth, queried SEPARATELY (never fed into the reconstruction): the indexer's own
      // recorded ZswapOutput ledger events for this transaction, parsed from its own storage.
      const eventRows = db
        .prepare("select raw from ledger_events where transaction_id = ? and variant = 'ZswapOutput'")
        .all(zswapTx.id) as { raw: Uint8Array }[];
      expect(eventRows.length).toBeGreaterThanOrEqual(1); // real data: 28 on this capture
      const indexerCommitments = eventRows.map((r) => {
        const ev = ledger.Event.deserialize(new Uint8Array(r.raw));
        expect(ev.content.tag).toBe("zswapOutput");
        // The event's own source hash also independently names this transaction.
        expect(String(ev.source.transactionHash)).toBe(zswapTx.hashHex);
        return String(ev.content.commitment);
      });

      const reconstructedCommitments = decoded.zswapOutputs.map((o) => o.commitment);
      expect(reconstructedCommitments.length).toBe(indexerCommitments.length);
      expect([...reconstructedCommitments].sort()).toEqual([...indexerCommitments].sort());

      // The same transaction also carries dust actions (the reviewer's observed shape: 28 zswap
      // outputs PLUS dust actions) -- the decode exposes them as structured records.
      expect(decoded.dustRegistrations.length).toBeGreaterThanOrEqual(1);
    });

    it("unshielded UTXOs: every reconstructed output's (owner, tokenType, value, intentHash, outputIndex) matches the indexer's independently-recorded unshielded_utxos rows", async () => {
      const decoded = await decodeFromArchive(unshieldedDustTx);
      expect(decoded.kind).toBe("standard");
      expect(decoded.transactionHash).toBe(unshieldedDustTx.hashHex);

      const utxoRows = db
        .prepare(
          "select hex(owner) owner, hex(token_type) tokenType, hex(value) valueHex, " +
          "output_index outputIndex, hex(intent_hash) intentHash " +
          "from unshielded_utxos where creating_transaction_id = ? order by output_index",
        )
        .all(unshieldedDustTx.id) as {
          owner: string; tokenType: string; valueHex: string; outputIndex: number; intentHash: string;
        }[];
      expect(utxoRows.length).toBeGreaterThanOrEqual(1); // real data: 3 on this capture

      expect(decoded.unshieldedOutputs.length).toBe(utxoRows.length);
      for (const row of utxoRows) {
        const match = decoded.unshieldedOutputs.find(
          (o) => o.intentHash === row.intentHash.toLowerCase() && o.outputIndex === row.outputIndex,
        );
        expect(match, `no reconstructed output for intent ${row.intentHash} #${row.outputIndex}`).toBeDefined();
        expect(match!.owner).toBe(row.owner.toLowerCase());
        expect(match!.tokenType).toBe(row.tokenType.toLowerCase());
        // The indexer stores value as a 16-byte big-endian blob.
        expect(match!.value).toBe(BigInt(`0x${row.valueHex}`));
      }
    });

    it("dust: the reconstructed dust spend's (vFee, nullifier, commitment) matches the indexer's independently-recorded DustSpendProcessed event", async () => {
      const decoded = await decodeFromArchive(unshieldedDustTx);

      const eventRows = db
        .prepare("select raw from ledger_events where transaction_id = ? and variant = 'DustSpendProcessed'")
        .all(unshieldedDustTx.id) as { raw: Uint8Array }[];
      expect(eventRows.length).toBeGreaterThanOrEqual(1);
      expect(decoded.dustSpends.length).toBe(eventRows.length);

      const indexerSpends = eventRows.map((r) => {
        const ev = ledger.Event.deserialize(new Uint8Array(r.raw));
        expect(ev.content.tag).toBe("dustSpendProcessed");
        expect(String(ev.source.transactionHash)).toBe(unshieldedDustTx.hashHex);
        return {
          vFee: BigInt(ev.content.vFee),
          nullifier: String(ev.content.nullifier),
          commitment: String(ev.content.commitment),
        };
      });
      for (const spend of decoded.dustSpends) {
        const match = indexerSpends.find((s) => s.nullifier === spend.oldNullifier);
        expect(match, `no indexer DustSpendProcessed event with nullifier ${spend.oldNullifier}`).toBeDefined();
        expect(spend.vFee).toBe(match!.vFee);
        expect(spend.newCommitment).toBe(match!.commitment);
      }
    });
  },
);

/**
 * When the ledger artifact or captured indexer DB is absent, the suite above is
 * SKIPPED -- this always-running companion asserts the decoder module itself still loads and
 * classifies correctly with zero external dependencies, so the file is never entirely inert.
 */
describe("tx-replay-decoder: dependency-free surface", () => {
  it("classifies the design doc's captured genesis sample as a system transaction by its self-tag", () => {
    const bytes = new Uint8Array(Buffer.from(DESIGN_DOC_GENESIS_SYSTEM_TX_HEX, "hex"));
    expect(Buffer.from(bytes.subarray(0, 32)).toString("latin1")).toBe("midnight:system-transaction[v6]:");
    expect(isSystemTransaction(bytes)).toBe(true);
    expect(isStandardTransaction(bytes)).toBe(false);
  });
});
