import { readFileSync, readdirSync } from "node:fs";
import { PgChainArchiveStore } from "../../../src/postgres/chain-archive-store.js";
import type { UmbraDBSql } from "../../../src/postgres/client.js";
import type { Hex32 } from "../../../src/interfaces/chain-archive-store.js";

/**
 * Loads the recorded Stagenet transactions in `token-indexer/test/fixtures/scan/` into a real
 * `chain_archive` schema, so the scanner is exercised against exactly the archive shape it reads in
 * production — the same store, the same blob indirection, the same partitioned tables.
 *
 * Every fixture is a real transaction fetched by hash from the public indexer on 2026-09-17: the
 * six `effectstream/mint-test-tokens` issuers' deploys (heights 360 721–360 737) and their mint
 * calls (364 875–364 934), each with its raw bytes, its `transactionResult` and the unshielded
 * outputs it created.
 *
 * The BLOCK around each transaction is synthesised (the archive needs a parent hash, a state root
 * and a body blob, none of which the fixture records and none of which the token scanner reads).
 * The transaction bytes — the only thing under test — are the chain's own.
 */

/** One unshielded UTXO as the indexer reports it. `owner` is **Bech32m** (`mn_addr_<net>1…`),
 *  which is what makes these fixtures a cross-check for the encoder the API ships (Q9). */
export interface FixtureUtxo {
  owner: string;
  tokenType: string;
  value: string;
  outputIndex: number;
  /** Absent on the 00020 fixtures, which were recorded before the field was wanted. */
  intentHash?: string;
}

export interface ScanFixture {
  label: string;
  net: string;
  blockHeight: number;
  blockHash: string;
  transaction: {
    __typename: string;
    id: number;
    hash: string;
    protocolVersion: number;
    raw: string;
    transactionResult: { status: string; segments: { id: number; success: boolean }[] | null } | null;
    /** The indexer's own `fee`, in SPECK. Recorded on the 00023 fixtures only. It is NOT the sum
     *  of the transaction's DUST `vFee` spends — see `decode.ts`'s `feeSpeck` and question Q15. */
    fee?: string | null;
  };
  contractActions: { __typename: string; address: string }[];
  unshieldedCreatedOutputs: FixtureUtxo[];
  /** Recorded on the 00023 fixtures only. */
  unshieldedSpentOutputs?: FixtureUtxo[];
}

const FIXTURE_DIR = new URL("../fixtures/scan/", import.meta.url);
/** Project 00023's own recorded transactions, kept in their own directory so the 00020 scan
 *  fixtures — whose count `[[token-scan-mints]]` pins at exactly twelve — stay untouched. */
const ACTIVITY_DIR = new URL("../fixtures/activity/", import.meta.url);

function loadFrom(dir: URL): ScanFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".raw.json"))
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")) as ScanFixture)
    .sort((a, b) => a.blockHeight - b.blockHeight);
}

export function loadScanFixtures(): ScanFixture[] {
  return loadFrom(FIXTURE_DIR);
}

export function loadScanFixture(label: string): ScanFixture {
  const found = loadScanFixtures().find((f) => f.label === label);
  if (found === undefined) throw new Error(`no scan fixture labelled ${label}`);
  return found;
}

/** The project-00023 activity fixtures, oldest block first. */
export function loadActivityFixtures(): ScanFixture[] {
  return loadFrom(ACTIVITY_DIR);
}

export function loadActivityFixture(label: string): ScanFixture {
  const found = loadActivityFixtures().find((f) => f.label === label);
  if (found === undefined) throw new Error(`no activity fixture labelled ${label}`);
  return found;
}

/** The archived `result` a fixture's recorded `transactionResult.status` maps to. */
export function fixtureResult(fixture: ScanFixture): "success" | "partial_success" | "failure" {
  const status = fixture.transaction.transactionResult?.status ?? "SUCCESS";
  return status === "PARTIAL_SUCCESS" ? "partial_success" : status === "FAILURE" ? "failure" : "success";
}

const pad32 = (n: number, tag: number): Hex32 =>
  (tag.toString(16).padStart(2, "0") + n.toString(16)).padStart(64, "0") as Hex32;

export interface SeedOptions {
  /** Override the archived result, to exercise the counting rules on real bytes. */
  resultOverride?: (fixture: ScanFixture) => {
    result: "success" | "partial_success" | "failure" | null;
    segments: { id: number; success: boolean }[] | null;
  };
  /** Mark the block non-canonical, so the scanner must skip it. */
  nonCanonical?: (fixture: ScanFixture) => boolean;
}

/** Writes one block per fixture, at the fixture's real height, containing that one transaction. */
export async function seedArchive(
  sql: UmbraDBSql, schema: string, net: string, fixtures: ScanFixture[], opts: SeedOptions = {},
): Promise<void> {
  const store = new PgChainArchiveStore(sql, schema);
  for (const fixture of fixtures.slice().sort((a, b) => a.blockHeight - b.blockHeight)) {
    const canonical = opts.nonCanonical?.(fixture) !== true;
    await store.putBlockBundle({
      block: {
        net,
        blockHash: fixture.blockHash as Hex32,
        height: fixture.blockHeight,
        parentHash: pad32(fixture.blockHeight - 1, 0xaa),
        stateRoot: pad32(fixture.blockHeight, 0xbb),
        extrinsicsRoot: pad32(fixture.blockHeight, 0xcc),
        headerBytes: Buffer.from(`header-${fixture.blockHeight}`),
        bodyBytes: Buffer.from(`body-${fixture.blockHeight}`),
        isCanonical: canonical,
        status: canonical ? "canonical" : "orphaned",
        finalized: canonical,
      },
      transactions: [{
        net,
        txHash: fixture.transaction.hash as Hex32,
        blockHeight: fixture.blockHeight,
        blockHash: fixture.blockHash as Hex32,
        position: 0,
        kind: "regular",
        protocolVersion: fixture.transaction.protocolVersion,
        rawBytes: Buffer.from(fixture.transaction.raw, "hex"),
      }],
      bridgeObservations: [],
    });

    const override = opts.resultOverride?.(fixture);
    const status = fixture.transaction.transactionResult?.status ?? "SUCCESS";
    const mapped = status === "PARTIAL_SUCCESS" ? "partial_success" : status === "FAILURE" ? "failure" : "success";
    const result = override === undefined ? mapped : override.result;
    const segments = override === undefined
      ? fixture.transaction.transactionResult?.segments ?? null
      : override.segments;
    await sql`
      UPDATE ${sql(schema)}.transactions
      SET result = ${result}, segments = ${segments === null ? null : sql.json(segments)}
      WHERE net = ${net} AND tx_hash = ${Buffer.from(fixture.transaction.hash, "hex")}
    `;
  }
}
