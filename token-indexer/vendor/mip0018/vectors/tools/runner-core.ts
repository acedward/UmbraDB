// Runner core: loads the vectors listed in manifest.json, turns each into a runner-protocol request, sends it to a
// consumer, compares the response and builds a report. Used by tools/run.ts (spawned consumer, any language) and by
// in-process tests (the reference consumer, rule mutations).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST_FILE, VECTORS_DIR } from './common.ts';
import { compareDecode, compareState, type Comparison } from './compare.ts';

export type Json = Record<string, unknown>;

export interface VectorEntry {
  id: string;
  kind: 'payload' | 'state';
  file: string;
  bin?: string;
  testId: string;
  normative: boolean;
}

export interface LoadedVector {
  entry: VectorEntry;
  data: Json;
}

export interface LoadOptions {
  dir?: string;
  /** Also load informative vectors (default true). */
  informative?: boolean;
  /** Restrict to these vector ids or MIP test ids. */
  only?: string[];
}

export function readManifest(dir: string = VECTORS_DIR): Json & { vectors: VectorEntry[] } {
  return JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')) as Json & { vectors: VectorEntry[] };
}

export function loadVectors(opts: LoadOptions = {}): LoadedVector[] {
  const dir = opts.dir ?? VECTORS_DIR;
  const manifest = readManifest(dir);
  const only = opts.only !== undefined && opts.only.length > 0 ? new Set(opts.only) : undefined;
  return manifest.vectors
    .filter((e) => (opts.informative ?? true) || e.normative)
    .filter((e) => only === undefined || only.has(e.id) || only.has(e.testId))
    .map((entry) => ({ entry, data: JSON.parse(readFileSync(join(dir, entry.file), 'utf8')) as Json }));
}

/** The runner-protocol request for one vector (see schema/runner.schema.json). */
export function requestFor(v: LoadedVector): Json {
  if (v.entry.kind === 'payload') {
    const ev = v.data.event as Json;
    return { id: v.entry.id, op: 'decode', type: ev.type, name_hex: ev.name_hex, payload_hex: ev.payload_hex };
  }
  const req: Json = { id: v.entry.id, op: 'state', steps: v.data.steps };
  const expect = v.data.expect as Json;
  if (Array.isArray(expect.display)) {
    req.display = (expect.display as Json[]).map((d) => ({
      network: d.network,
      contractAddress: d.contractAddress,
      domainSep: d.domainSep,
      kind: d.kind,
      raw: d.raw,
    }));
  }
  return req;
}

export type Consumer = (request: Json) => Promise<Json>;

export interface VectorResult extends Comparison {
  id: string;
  testId: string;
  normative: boolean;
  kind: 'payload' | 'state';
}

export interface Report {
  results: VectorResult[];
  normative: { passed: number; total: number };
  informative: { passed: number; total: number };
  /** Passed vectors with a check that did not apply to the consumer (no groups, no display), by vector id. */
  notApplicable: Record<string, string[]>;
}

export function check(v: LoadedVector, response: Json): Comparison {
  if (response.id !== undefined && response.id !== null && response.id !== v.entry.id) {
    return {
      ok: false,
      failures: [`response id ${String(response.id)} does not match request id ${v.entry.id}`],
      notes: [],
      notApplicable: [],
    };
  }
  const expect = v.data.expect as Json;
  return v.entry.kind === 'payload' ? compareDecode(expect, response) : compareState(expect, response);
}

export async function runVectors(vectors: LoadedVector[], consumer: Consumer): Promise<Report> {
  const results: VectorResult[] = [];
  for (const v of vectors) {
    let cmp: Comparison;
    try {
      cmp = check(v, await consumer(requestFor(v)));
    } catch (e) {
      cmp = { ok: false, failures: [`no response: ${(e as Error).message}`], notes: [], notApplicable: [] };
    }
    results.push({ id: v.entry.id, testId: v.entry.testId, normative: v.entry.normative, kind: v.entry.kind, ...cmp });
  }
  const tally = (normative: boolean) => {
    const rs = results.filter((r) => r.normative === normative);
    return { passed: rs.filter((r) => r.ok).length, total: rs.length };
  };
  const notApplicable: Record<string, string[]> = {};
  for (const r of results) if (r.ok && r.notApplicable.length > 0) notApplicable[r.id] = r.notApplicable;
  return { results, normative: tally(true), informative: tally(false), notApplicable };
}

export function formatReport(report: Report, opts: { notes?: boolean } = {}): string {
  const lines: string[] = [];
  for (const r of report.results) {
    const tag = r.ok ? 'PASS' : r.normative ? 'FAIL' : 'FAIL (informative)';
    lines.push(`${tag.padEnd(18)} ${r.id.padEnd(16)} [${r.testId}]`);
    for (const f of r.failures) lines.push(`    - ${f}`);
    for (const n of r.notApplicable) lines.push(`    n/a: ${n}`);
    if (opts.notes === true) for (const n of r.notes) lines.push(`    note: ${n}`);
  }
  lines.push('');
  lines.push('By MIP test id (normative):');
  const byTest = new Map<string, { passed: number; total: number; na: number }>();
  for (const r of report.results.filter((x) => x.normative)) {
    const t = byTest.get(r.testId) ?? { passed: 0, total: 0, na: 0 };
    t.total++;
    if (r.ok) t.passed++;
    if (r.ok && r.notApplicable.length > 0) t.na++;
    byTest.set(r.testId, t);
  }
  for (const [testId, t] of byTest)
    lines.push(
      `  ${testId.padEnd(8)} ${t.passed}/${t.total} ${t.passed === t.total ? 'ok' : 'FAILED'}${t.na > 0 ? ` (${t.na} with a check not applicable)` : ''}`,
    );
  const n = report.normative;
  const i = report.informative;
  lines.push('');
  lines.push(`normative: ${n.passed}/${n.total} passed${i.total > 0 ? `; informative: ${i.passed}/${i.total} passed` : ''}`);
  return lines.join('\n');
}
