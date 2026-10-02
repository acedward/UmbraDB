import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { loadLedgerV9 } from "../../chain-archive-sync/tx-replay-decoder.js";
import { bootstrapTokenIndexSchema } from "../bootstrap.js";
import { decodeTokenFlows, decodeTransactionActions } from "../ingest/decode.js";
import type { EventSource, IndexerContractEvent } from "../ingest/events.js";
import { TokenScanner } from "../ingest/scan.js";
import { readDecodeCursor } from "../ingest/store.js";
import { seedArchive, type ScanFixture } from "./helpers/archive-fixture.js";

/**
 * Project 00024-01, question Q21 — `[[token-scan-maintenance-actions]]`.
 *
 * A contract whose verifier keys do not fit one block is deployed in stages (spec 00024 Q20 (a)):
 * a `ContractDeploy` with some of its operations, then one ledger `MaintenanceUpdate` per missing
 * key (`VerifierKeyInsert`), signed by the contract's maintenance authority. The token indexer must
 * record the deploy and otherwise ignore the updates: they are not calls, carry no transcript and
 * emit nothing. `ingest/decode.ts` `classify` already says so, but until this test nothing
 * exercised that path — the fake ledger's `FakeMaintenanceUpdate` was unused and no fixture held a
 * real one — so a refactor that made `classify` throw on a maintenance action would have stayed
 * green here and stalled the scanner on the next staged deploy.
 *
 * The bytes are REAL: CNST18's staged deploy on the 00024 local chain (1 deploy + 28 inserts, run
 * 01-A6b), copied verbatim into `fixtures/maintenance/` (see its SOURCE.md). The scanner runs over a
 * real `chain_archive` schema through the real store and the real ledger-v9 WASM decoder; only the
 * event source is faked, and it must never be asked anything.
 */

const NET = "undeployed";
const FIXTURE_URL = new URL("./fixtures/maintenance/cnst18-staged-deploy.transactions.json", import.meta.url);
/** SHA-256 of the fixture file as copied from the run (fixtures/maintenance/SOURCE.md). */
const FIXTURE_SHA256 = "e1d37f9ae4ea0b7fd9eb62a1d495d61a30766db30726ffcefd7e3310aab0817c";
const CNST18 = "4846de74e8db124eff4fdff39e6abc764b5b5be621fdd6002e58377ef5a7af07";
const DEPLOY_HEIGHT = 326;
const LAST_HEIGHT = 410;
/** The compiled `.verifier` file is this tag followed by the key the ledger stores (`rawVk`). */
const VERIFIER_FILE_TAG = Buffer.from("midnight:verifier-key[v6]:", "utf8");

interface RecordedTransaction {
  kind: "deploy" | "insert";
  row: string;
  contract: string;
  txHash: string;
  blockHeight: number;
  blockHash: string;
  status: string;
  contractActions: { __typename: string; address: string }[];
  circuits: string[];
  verifierKeySha256: string | null;
  rawSha256: string;
  raw: string;
}

function loadRecorded(): { bytes: Buffer; transactions: RecordedTransaction[] } {
  const bytes = readFileSync(FIXTURE_URL);
  const parsed = JSON.parse(bytes.toString("utf8")) as { transactions: RecordedTransaction[] };
  return { bytes, transactions: parsed.transactions };
}

/** The recorded transaction in the archive-fixture shape `seedArchive` writes (one block each). */
function asScanFixture(t: RecordedTransaction, index: number): ScanFixture {
  return {
    label: t.kind === "deploy" ? "cnst18-deploy" : `cnst18-insert-${index}`,
    net: NET,
    blockHeight: t.blockHeight,
    blockHash: t.blockHash,
    transaction: {
      __typename: "RegularTransaction",
      id: index,
      hash: t.txHash,
      // Not recorded by the run; the local runtime's specVersion (P0.1). The scanner never reads it.
      protocolVersion: 2_000_000,
      raw: t.raw,
      transactionResult: { status: t.status, segments: null },
    },
    contractActions: t.contractActions,
    unshieldedCreatedOutputs: [],
  };
}

/** The fields of ledger-v9's `MaintenanceUpdate` / `VerifierKeyInsert` this test reads (`ledger-v9.d.ts`). */
interface LedgerMaintenanceUpdate {
  address: string;
  counter: bigint;
  signatures: unknown[];
  updates: { operation: string | Uint8Array; vk: { rawVk: Uint8Array } }[];
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** No transaction in the fixture calls a contract, so any lookup at all would be a bug. */
class NeverCalledEventSource implements EventSource {
  calls = 0;
  async eventsFor(): Promise<IndexerContractEvent[]> {
    this.calls++;
    return [];
  }
}

describe("maintenance updates (a staged deploy) through the decoder and the scanner", () => {
  let container: StartedPostgreSqlContainer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ledger: any;
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
    const schema = `token_maint_${id}`;
    const archiveSchema = `arch_maint_${id}`;
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    open.push(sql);
    await bootstrapChainArchiveSchema(sql, archiveSchema);
    await bootstrapTokenIndexSchema(sql, { schema, net: NET });
    return { sql, schema, archiveSchema };
  }

  async function tableCounts(sql: UmbraDBSql, schema: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const table of [
      "contracts", "pending_event_lookups", "token_mints", "token_metadata_events", "token_metadata_kv",
      "token_activity", "shielded_offers", "contract_calls",
    ]) {
      const rows = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM ${sql(schema)}.${sql(table)}`;
      out[table] = Number(rows[0]!.n);
    }
    const tokens = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ${sql(schema)}.tokens WHERE status <> 'builtin'
    `;
    out.tokens = Number(tokens[0]!.n);
    return out;
  }

  it("[[token-scan-maintenance-actions]] the 28 VerifierKeyInsert maintenance updates of a staged deploy decode as maintenance actions and scan to nothing — no call, no lookup, nothing pending, no error, the cursor past them", async () => {
    // ── the fixture is what it claims ──────────────────────────────────────────────────────────
    const { bytes, transactions } = loadRecorded();
    expect(sha256(bytes)).toBe(FIXTURE_SHA256);
    expect(transactions).toHaveLength(29);
    const [deploy, ...inserts] = transactions;
    expect(deploy!.kind).toBe("deploy");
    expect(inserts).toHaveLength(28);
    expect(inserts.every((t) => t.kind === "insert")).toBe(true);
    expect(transactions.map((t) => t.blockHeight)).toEqual(
      Array.from({ length: 29 }, (_, i) => DEPLOY_HEIGHT + 3 * i),
    );
    for (const t of transactions) {
      expect(t.contract).toBe(CNST18);
      expect(t.status).toBe("SUCCESS");
      // On this chain a transaction's hash is the SHA-256 of its raw bytes.
      expect(sha256(Buffer.from(t.raw, "hex"))).toBe(t.txHash);
    }
    // The inserted operations are exactly the ones the deploy did not carry.
    const deployed = new Set(deploy!.circuits);
    expect(deployed.size).toBe(11);
    const inserted = inserts.map((t) => t.circuits[0]!);
    expect(new Set(inserted).size).toBe(28);
    expect(inserted.filter((c) => deployed.has(c))).toEqual([]);

    // ── the real ledger's objects: one ContractDeploy, then 28 signed MaintenanceUpdates ─────────
    for (const [index, t] of transactions.entries()) {
      const raw = new Uint8Array(Buffer.from(t.raw, "hex"));
      const tx = ledger.Transaction.deserialize("signature", "proof", "binding", raw);
      const actions = [...(tx.intents ?? [])].flatMap(([, intent]: [unknown, { actions?: unknown[] }]) => intent.actions ?? []);
      expect(actions).toHaveLength(1);
      if (t.kind === "deploy") {
        expect(actions[0]).toBeInstanceOf(ledger.ContractDeploy);
        continue;
      }
      expect(actions[0]).toBeInstanceOf(ledger.MaintenanceUpdate);
      const update = actions[0] as LedgerMaintenanceUpdate;
      expect(String(update.address).toLowerCase()).toBe(CNST18); // `ContractAddress` is a hex string
      expect(update.counter).toBe(BigInt(index - 1)); // 0 … 27, one authority update after another
      expect(update.signatures.length).toBe(1);
      expect(update.updates).toHaveLength(1);
      const insert = update.updates[0]!;
      expect(insert).toBeInstanceOf(ledger.VerifierKeyInsert);
      const op = typeof insert.operation === "string" ? insert.operation : Buffer.from(insert.operation).toString("utf8");
      expect(op).toBe(t.circuits[0]);
      // The key on chain is the compiled key the deploy script recorded.
      expect(sha256(Buffer.concat([VERIFIER_FILE_TAG, Buffer.from(insert.vk.rawVk)]))).toBe(t.verifierKeySha256);
    }

    // ── the decoder: a deploy, then 28 maintenance actions with nothing in them ──────────────────
    for (const t of transactions) {
      const raw = new Uint8Array(Buffer.from(t.raw, "hex"));
      const decoded = decodeTransactionActions(ledger, raw);
      expect(decoded.isSystem).toBe(false);
      expect(decoded.actions).toHaveLength(1);
      const action = decoded.actions![0]!;
      expect(action.address).toBe(CNST18);
      expect(action.kind).toBe(t.kind === "deploy" ? "deploy" : "maintenance");
      expect(action.entryPoint).toBeUndefined();
      expect(action.guaranteed).toBeUndefined();
      expect(action.fallible).toBeUndefined();

      const flows = decodeTokenFlows(ledger, raw, "success", null, t.txHash);
      expect(flows.view.selfReportedTxHash).toBe(t.txHash);
      expect([...flows.deployAddresses]).toEqual(t.kind === "deploy" ? [CNST18] : []);
      expect([...flows.callAddresses]).toEqual([]);
      expect(flows.mints).toEqual([]);
      expect(flows.calls).toEqual([]);
      expect(flows.activity).toEqual([]);
      expect(flows.offers).toEqual([]);
      expect([...flows.logOpsByAddress]).toEqual([]);
      const viewActions = flows.view.intents.flatMap((intent) => intent.actions);
      expect(viewActions).toHaveLength(1);
      expect(viewActions[0]).toMatchObject({
        kind: t.kind === "deploy" ? "deploy" : "maintenance",
        address: CNST18, entryPoint: null, guaranteed: null, fallible: null,
      });
    }

    // ── the scanner over a real archive: one batch ──────────────────────────────────────────────
    const fixtures = transactions.map(asScanFixture);
    const one = await freshDb();
    await seedArchive(one.sql, one.archiveSchema, NET, fixtures);
    const events = new NeverCalledEventSource();
    const scanner = new TokenScanner({
      sql: one.sql, schema: one.schema, archiveSchema: one.archiveSchema, net: NET, eventSource: events, ledger,
    });
    const outcome = await scanner.scanOnce();
    expect(outcome).toMatchObject({
      transactionsScanned: 29, deploys: 1, calls: 0, mints: 0, lookups: 0, lookupsShort: 0,
      eventsApplied: 0, eventsRejected: 0, skippedUnknownResult: 0, activityRows: 0,
      shieldedOffers: 0, undisclosedShieldedOffers: 0, contractCalls: 0, seenTokens: 0,
      waitingForResult: undefined, atTip: true,
      cursor: { height: LAST_HEIGHT, position: 0 },
    });
    expect(events.calls).toBe(0);
    expect(await readDecodeCursor(one.sql, one.schema, NET)).toEqual({ height: LAST_HEIGHT, position: 0 });

    const contracts = await one.sql<{
      address: Buffer; deploy_tx_hash: Buffer | null; deploy_height: string | null;
      first_seen_height: string; last_call_height: string | null;
    }[]>`
      SELECT address, deploy_tx_hash, deploy_height::text, first_seen_height::text, last_call_height::text
      FROM ${one.sql(one.schema)}.contracts WHERE net = ${NET}
    `;
    expect(contracts).toHaveLength(1);
    expect(contracts[0]!.address.toString("hex")).toBe(CNST18);
    expect(contracts[0]!.deploy_tx_hash?.toString("hex")).toBe(deploy!.txHash);
    expect(contracts[0]!.deploy_height).toBe(String(DEPLOY_HEIGHT));
    expect(contracts[0]!.first_seen_height).toBe(String(DEPLOY_HEIGHT));
    // A maintenance update is not a call: the contract is still "deployed, never called".
    expect(contracts[0]!.last_call_height).toBeNull();

    const after = await tableCounts(one.sql, one.schema);
    expect(after).toEqual({
      contracts: 1, pending_event_lookups: 0, token_mints: 0, token_metadata_events: 0, token_metadata_kv: 0,
      token_activity: 0, shielded_offers: 0, contract_calls: 0, tokens: 0,
    });

    // A second pass over the same archive finds nothing new and changes nothing.
    const again = await scanner.scanOnce();
    expect(again).toMatchObject({ transactionsScanned: 0, deploys: 0, lookups: 0, atTip: true });
    expect(await tableCounts(one.sql, one.schema)).toEqual(after);
    expect(await readDecodeCursor(one.sql, one.schema, NET)).toEqual({ height: LAST_HEIGHT, position: 0 });

    // ── the same archive in batches of 5: the cursor walks through the updates batch by batch ────
    const small = await freshDb();
    await seedArchive(small.sql, small.archiveSchema, NET, fixtures);
    const smallEvents = new NeverCalledEventSource();
    const batched = new TokenScanner({
      sql: small.sql, schema: small.schema, archiveSchema: small.archiveSchema, net: NET,
      eventSource: smallEvents, ledger, batchSize: 5,
    });
    const cursors: number[] = [];
    let scanned = 0;
    for (let pass = 0; pass < 10; pass++) {
      const step = await batched.scanOnce();
      scanned += step.transactionsScanned;
      expect(step.lookups).toBe(0);
      expect(step.waitingForResult).toBeUndefined();
      cursors.push(step.cursor.height);
      if (step.atTip) break;
    }
    expect(scanned).toBe(29);
    // 29 transactions in batches of 5: five full batches, then a short one of 4 that reaches the tip.
    expect(cursors).toEqual([338, 353, 368, 383, 398, LAST_HEIGHT]);
    expect(smallEvents.calls).toBe(0);
    expect(await tableCounts(small.sql, small.schema)).toEqual(after);
  }, 180_000);
});
