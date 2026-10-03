import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "./archive-digest.js";
import type { ArchiveTape } from "./fake-chain-server.js";
import {
  CASE_INDEX_FORMAT, type CaseIndex, type CaseIndexEntry, type CaseIndexStep, type ContractEventsPair,
} from "./stagenet-fixtures.js";

/**
 * Builds `case-index.json`: for each Stagenet case of the MIP-0018 reference
 * (`deployments/stagenet/cases/{C01…C10,IDX,U1}` of `midnight-experiments/mip-0018`, read-only),
 * which transactions it submitted, at which heights, where they sit in the recorded ranges, and
 * which reference expectation applies (C06 per step). Every transaction of a case is looked up in
 * the recorded tapes; a case transaction that is not recorded is an error. Transactions of the
 * ranges that belong to no case are listed separately (other Stagenet users -- e.g. the third-party
 * mint IDX counts as its sixth color).
 *
 * Runs only at pack time (the reference checkout is not available in CI); the result is committed
 * with the SHA-256 of every reference file it was built from.
 */

interface RecordStep {
  id: string;
  kind?: string;
  circuit?: string;
  state: string;
  tx?: { hash?: string };
  inclusion?: { height?: number; hash?: string; status?: string };
  observed?: { events?: { id: number }[] };
}

interface IndexSummary {
  fromHeight: number;
  lastBlock: { height: number; hash: string };
}

const noPrefix = (h: string): string => (h.startsWith("0x") ? h.slice(2) : h).toLowerCase();

export function buildCaseIndex(opts: {
  casesDir: string;
  repository: string;
  commit: string;
  /** Repository-relative path of `casesDir` (for provenance). */
  casesPath: string;
  ranges: { name: string; from: number; to: number; tape: ArchiveTape }[];
  callPairs: readonly ContractEventsPair[];
}): CaseIndex {
  const files: { path: string; sha256: string }[] = [];
  const readJson = <T>(caseId: string, file: string): T => {
    const text = readFileSync(join(opts.casesDir, caseId, file));
    files.push({ path: `${opts.casesPath}/${caseId}/${file}`, sha256: sha256Hex(text) });
    return JSON.parse(text.toString("utf8")) as T;
  };

  // Where every recorded transaction is: hash -> (range, height, block hash, position).
  const located = new Map<string, { range: string; height: number; blockHash: string; position: number }>();
  for (const r of opts.ranges) {
    for (const b of r.tape.blocks) {
      b.indexerBlock.transactions.forEach((t, position) => {
        located.set(noPrefix(t.hash), { range: r.name, height: b.height, blockHash: noPrefix(b.blockHash), position });
      });
    }
  }
  const rangeOf = (height: number): string | undefined => opts.ranges.find((r) => height >= r.from && height <= r.to)?.name;

  const caseIds = readdirSync(opts.casesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const cases: Record<string, CaseIndexEntry> = {};
  const claimed = new Set<string>();

  for (const id of caseIds) {
    const caseJson = readJson<{ title: string; dependsOn?: string[]; expected?: string }>(id, "case.json");
    const folderFiles = readdirSync(join(opts.casesDir, id)).sort();
    const entry: CaseIndexEntry = {
      title: caseJson.title,
      ...(caseJson.dependsOn === undefined ? {} : { dependsOn: caseJson.dependsOn }),
      steps: [],
      heights: [],
      expected: folderFiles.filter((f) => /^expected.*\.json$/.test(f)),
    };
    for (const f of entry.expected) readJson(id, f); // provenance hash of every expectation

    if (folderFiles.includes("index-summary.json")) {
      const summary = readJson<IndexSummary>(id, "index-summary.json");
      const range = opts.ranges.find((r) => r.from === summary.fromHeight && r.to === summary.lastBlock.height);
      if (range === undefined) {
        throw new Error(`${id}: scan range ${summary.fromHeight}-${summary.lastBlock.height} is not a recorded range`);
      }
      const last = range.tape.blocks.find((b) => b.height === summary.lastBlock.height);
      if (last === undefined || noPrefix(last.blockHash) !== noPrefix(summary.lastBlock.hash)) {
        throw new Error(`${id}: the scan's last block differs from the recorded one`);
      }
      entry.scanRange = { from: range.from, to: range.to, range: range.name };
    }

    if (folderFiles.includes("record.json")) {
      const record = readJson<{ contract?: { address?: string }; steps: RecordStep[] }>(id, "record.json");
      if (record.contract?.address !== undefined) entry.contract = noPrefix(record.contract.address);
      for (const s of record.steps) {
        const step: CaseIndexStep = { id: s.id, kind: s.kind ?? "unknown", state: s.state };
        if (s.circuit !== undefined) step.circuit = s.circuit;
        const height = s.inclusion?.height;
        if (s.tx?.hash !== undefined && height !== undefined) {
          const txHash = noPrefix(s.tx.hash);
          const at = located.get(txHash);
          if (at === undefined) throw new Error(`${id}/${s.id}: transaction ${txHash} at ${height} is not recorded`);
          if (at.height !== height || at.blockHash !== noPrefix(s.inclusion?.hash ?? "")) {
            throw new Error(`${id}/${s.id}: recorded at ${at.height}/${at.blockHash}, the reference says ${height}/${s.inclusion?.hash}`);
          }
          if (rangeOf(height) !== at.range) throw new Error(`${id}/${s.id}: height ${height} outside its range`);
          Object.assign(step, {
            txHash, height, blockHash: at.blockHash, status: s.inclusion?.status, range: at.range, txPosition: at.position,
          });
          claimed.add(txHash);
          entry.heights.push(height);
        } else if (s.tx?.hash !== undefined) {
          // Submitted but never included (e.g. U1's forced wrong-signer insert, rejected by the node).
          step.txHash = noPrefix(s.tx.hash);
          if (located.has(step.txHash)) throw new Error(`${id}/${s.id}: a never-included transaction is recorded`);
        }
        const ids = s.observed?.events?.map((e) => e.id);
        if (ids !== undefined && ids.length > 0) step.observedEventIds = ids;
        const after = `expected-after-${s.id}.json`;
        if (folderFiles.includes(after)) step.expectedAfter = after;
        entry.steps.push(step);
      }
    }
    entry.heights = [...new Set(entry.heights)].sort((a, b) => a - b);
    cases[id] = entry;
  }

  const callsOf = new Map<string, string[]>();
  for (const p of opts.callPairs) (callsOf.get(p.txHash) ?? callsOf.set(p.txHash, []).get(p.txHash)!).push(p.contractAddress);
  const otherTransactions: CaseIndex["otherTransactions"] = [];
  for (const r of opts.ranges) {
    for (const b of r.tape.blocks) {
      b.indexerBlock.transactions.forEach((t, txPosition) => {
        const txHash = noPrefix(t.hash);
        if (!claimed.has(txHash)) {
          otherTransactions.push({ range: r.name, height: b.height, txHash, txPosition, calls: callsOf.get(txHash) ?? [] });
        }
      });
    }
  }

  if (!existsSync(opts.casesDir)) throw new Error(`no cases dir ${opts.casesDir}`);
  return {
    format: CASE_INDEX_FORMAT,
    $comment:
      "Which recorded Stagenet transactions belong to the MIP-0018 reference cases. " +
      "Built by record-tape.ts --pack from the reference repository (read-only); every case transaction was " +
      "found in the recorded tapes at the reference's inclusion height and block hash.",
    source: { repository: opts.repository, commit: opts.commit, path: opts.casesPath, files },
    cases,
    otherTransactions,
  };
}
