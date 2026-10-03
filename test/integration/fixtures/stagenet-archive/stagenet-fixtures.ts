import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ArchiveDigest } from "./archive-digest.js";
import type { ArchiveTape } from "./fake-chain-server.js";
import { parseHeights, readJsonFile, readTapeFile, sliceTapes } from "./tape-codec.js";

/**
 * The recorded Stagenet fixtures of project 00026 (sub-plan D1; spec FR-041/FR-042, Q11: CI replays
 * recorded fixtures, development syncs live `--from/--to` ranges). Everything is described by
 * `manifest.json` in this folder, written by `record-tape.ts --pack` from one polite live capture:
 *
 * - one compact tape per contiguous range (`stagenet-<from>-<to>.tape.json.gz`): every answer the
 *   archive sync read from the node RPC and the indexer GraphQL for every height of the range;
 * - `stagenet-contract-events.json.gz`: the indexer's `contractEvents` (all types, in the indexer's
 *   order) for every (transaction, called contract) pair of those blocks -- the test-only
 *   cross-check of the raw-transaction event decoding (Q4 (c));
 * - `case-index.json`: which transactions and heights belong to the reference cases C01–C10, IDX
 *   and U1 (read-only from `midnight-experiments/mip-0018`);
 * - per range, the digest of the archive a LIVE sync of that range produced at capture time
 *   (`archive-digest.ts`), which a replay of the tape must reproduce exactly.
 */

export const FIXTURE_MANIFEST_FORMAT = "umbradb-stagenet-fixtures/1";
export const CONTRACT_EVENTS_FORMAT = "umbradb-stagenet-contract-events/1";
export const CASE_INDEX_FORMAT = "umbradb-stagenet-case-index/1";

export interface FixtureFile {
  path: string;
  bytes: number;
  sha256: string;
  role: "tape" | "contract-events" | "case-index";
}

export interface RangeFixture {
  /** `idx` (714485–715183, the reference IDX scan range) or `u1` (715402–715433, U1's scan range). */
  name: string;
  from: number;
  to: number;
  file: string;
  blocks: number;
  transactions: number;
  /** Transaction results as the indexer reported them (`SUCCESS`: n, ...). */
  results: Record<string, number>;
  /** (transaction, called contract) pairs of the range, each with a `contractEvents` capture. */
  callPairs: number;
  liveSync: {
    net: string;
    schema: string;
    concurrency: number;
    minIntervalMs: { node: number; indexer: number };
    batches: number;
    elapsedMs: number;
    retries: number;
    throttled: number;
    /** The digest of the archive the live sync wrote (wall-clock columns excluded). */
    archiveDigest: ArchiveDigest;
  };
  /** Endpoint requests the live sync made for this range, by operation (failed attempts included). */
  requests: Record<string, number>;
}

export interface FixtureManifest {
  format: typeof FIXTURE_MANIFEST_FORMAT;
  $comment: string;
  network: "stagenet";
  genesisHash: string;
  nodeUrl: string;
  indexerUrl: string;
  recordedAt: string;
  finalizedHeightAtRecording: number;
  indexerTipAtRecording: number;
  recorder: string;
  ledgerV9: string;
  queries: { indexerBlockSha256: string; contractEventsSha256: string };
  ranges: RangeFixture[];
  contractEvents: {
    file: string;
    pairs: number;
    events: number;
    byType: Record<string, number>;
    requests: number;
  };
  caseIndex: { file: string };
  /** Former A2 tape names, now served as slices of the range tapes (`loadTape`). */
  aliases: Record<string, { heights: string; comment: string }>;
  files: FixtureFile[];
  totalBytes: number;
  /** Sub-plan D1's size target for all fixture files together. */
  sizeTargetBytes: number;
  totalRequests: number;
}

/** One `contractEvents` element exactly as the indexer served it (fields per event type). */
export interface RecordedContractEvent {
  __typename: string;
  id: number;
  raw: string;
  protocolVersion: number;
  version: number;
  contractAddress: string;
  transactionId: number;
  transaction: { hash: string; block: { height: number; hash: string } };
  name?: string;
  payload?: string;
  [field: string]: unknown;
}

export interface ContractEventsPair {
  height: number;
  blockHash: string;
  txHash: string;
  /** Position of the transaction in the indexer's block. */
  txPosition: number;
  contractAddress: string;
  /** `ContractCall` actions of the transaction on this contract (decoded from `raw`). */
  callActions: number;
  /** Pages requested (the last one empty). */
  pages: number;
  events: RecordedContractEvent[];
}

export interface ContractEventsFixture {
  format: typeof CONTRACT_EVENTS_FORMAT;
  $comment: string;
  indexerUrl: string;
  recordedAt: string;
  query: string;
  querySha256: string;
  pageSize: number;
  pairs: ContractEventsPair[];
}

export interface CaseIndexStep {
  id: string;
  kind: string;
  circuit?: string;
  /** The reference record's state (`completed`, `pending` = refused before submission, `failed`). */
  state: string;
  txHash?: string;
  height?: number;
  blockHash?: string;
  status?: string;
  /** Where the block is recorded (`idx` / `u1`); absent when the step has no transaction in a block. */
  range?: string;
  /** Position of the transaction in its block (indexer order). */
  txPosition?: number;
  /** Event ids the reference observed through the indexer for this step. */
  observedEventIds?: number[];
  /** The reference expectation for the state right after this step (C06), if any. */
  expectedAfter?: string;
}

export interface CaseIndexEntry {
  title: string;
  contract?: string;
  dependsOn?: string[];
  /** The scan range of IDX / U1 (inclusive). */
  scanRange?: { from: number; to: number; range: string };
  steps: CaseIndexStep[];
  /** Heights of this case's transactions in the recorded ranges, ascending. */
  heights: number[];
  /** Case-level expectation file(s) of the reference case folder. */
  expected: string[];
}

export interface CaseIndex {
  format: typeof CASE_INDEX_FORMAT;
  $comment: string;
  source: {
    repository: string;
    commit: string;
    path: string;
    /** SHA-256 of each reference file the index was built from. */
    files: { path: string; sha256: string }[];
  };
  cases: Record<string, CaseIndexEntry>;
  /** Recorded transactions that belong to no case (other Stagenet users), by range. */
  otherTransactions: { range: string; height: number; txHash: string; txPosition: number; calls: string[] }[];
}

export const fixturePath = (name: string): string => fileURLToPath(new URL(`./${name}`, import.meta.url));

let manifestCache: FixtureManifest | undefined;
const tapeCache = new Map<string, ArchiveTape>();

export function loadManifest(): FixtureManifest {
  manifestCache ??= readJsonFile<FixtureManifest>(fixturePath("manifest.json"));
  return manifestCache;
}

/** The full tape of one recorded range (`idx` / `u1`). */
export function loadRangeTape(name: string): ArchiveTape {
  const cached = tapeCache.get(name);
  if (cached !== undefined) return cached;
  const range = loadManifest().ranges.find((r) => r.name === name);
  if (range === undefined) throw new Error(`no recorded range ${name} in manifest.json`);
  const tape = readTapeFile(fixturePath(range.file));
  tapeCache.set(name, tape);
  return tape;
}

/**
 * A tape by file name: an existing file of this folder (plain A2 tape or compact tape), else one of
 * the manifest's aliases (the former A2 tapes `c04-714637-714663.tape.json` and
 * `cases-sparse.tape.json`), served as a slice of the recorded ranges.
 */
export function loadTapeByName(fileName: string): ArchiveTape {
  const path = fixturePath(fileName);
  if (existsSync(path)) return readTapeFile(path);
  const manifest = loadManifest();
  const alias = manifest.aliases[fileName];
  if (alias === undefined) throw new Error(`no tape file ${fileName} and no alias for it in manifest.json`);
  return sliceTapes(manifest.ranges.map((r) => loadRangeTape(r.name)), parseHeights(alias.heights), alias.comment);
}

export function loadContractEvents(): ContractEventsFixture {
  return readJsonFile<ContractEventsFixture>(fixturePath(loadManifest().contractEvents.file));
}

export function loadCaseIndex(): CaseIndex {
  return readJsonFile<CaseIndex>(fixturePath(loadManifest().caseIndex.file));
}
