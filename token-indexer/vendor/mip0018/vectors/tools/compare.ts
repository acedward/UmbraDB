// Compares a consumer's response with a vector's expectation (the rules documented in vectors/README.md).
//
// - Only properties present in `expect` are compared.
// - `reason` and `offset` of a decode result are informative: a difference is a note, never a failure.
// - Identities: a hidden identity with no fields is equivalent to an absent one (a consumer may delete instead of
//   hide). The remaining identities must match exactly as a set, keyed by (network, contractAddress, domainSep, kind).
// - Fields: valType and value_hex always; `usable` when the expectation has it. The four common keys (`name`,
//   `symbol`, `decimals`, `standards`) must be reported; any other key is optional (MIP "Consuming": "Indexers MAY
//   index only some tokens or keys") — a missing one is a note, a reported one must match. A reported key the
//   expectation does not have fails.
// - Groups (MIP Testing S9: "Grouping is a SHOULD, so two outcomes are valid: no groups at all, or exactly the
//   following groups"): only groups of two or more members are compared, on both sides. A consumer that reports no
//   such group (no `groups`, an empty list, or single-member groups only) passes, with the check marked not
//   applicable; otherwise its multi-member groups must equal the expected ones exactly, as a set of
//   (network, contractAddress, symbol_hex) → set of (domainSep, kind).
// - Display (MIP Testing S8: "A consumer that displays amounts …"): a consumer that omits `display` (or sends null)
//   does not display amounts and the check is marked not applicable; otherwise every expected entry must be present
//   (matched by identity + raw) with equal decimals and text.

export interface Comparison {
  ok: boolean;
  failures: string[];
  notes: string[];
  /** Checks of this vector that do not apply to the consumer (it does not group symbols / display amounts). */
  notApplicable: string[];
}

/** The MIP's common keys (Common fields): `name`, `symbol`, `decimals`, `standards`, as hex. */
export const COMMON_KEYS_HEX: ReadonlySet<string> = new Set(['6e616d65', '73796d626f6c', '646563696d616c73', '7374616e6461726473']);

type Json = Record<string, unknown>;

const lower = (v: unknown): unknown => (typeof v === 'string' ? v.toLowerCase() : v);

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function recordEnd(r: Json): number | undefined {
  if (typeof r.offset !== 'number' || typeof r.key_hex !== 'string' || typeof r.value_hex !== 'string') return undefined;
  return r.offset + 1 + r.key_hex.length / 2 + 2 + r.value_hex.length / 2;
}

export function compareDecode(expect: Json, got: Json): Comparison {
  const failures: string[] = [];
  const notes: string[] = [];
  if (typeof got.error === 'string') return { ok: false, failures: [`consumer error: ${got.error}`], notes, notApplicable: [] };
  if (got.result !== expect.result) {
    failures.push(`result: expected ${String(expect.result)}, got ${String(got.result)}`);
    return { ok: false, failures, notes, notApplicable: [] };
  }
  if (expect.reason !== undefined && got.reason !== expect.reason)
    notes.push(`reason (informative): expected ${String(expect.reason)}, got ${String(got.reason)}`);
  if (expect.offset !== undefined && got.offset !== expect.offset)
    notes.push(`offset (informative): expected ${String(expect.offset)}, got ${String(got.offset)}`);
  if (expect.header !== undefined) {
    const eh = expect.header as Json;
    const gh = isObj(got.header) ? got.header : {};
    if (lower(gh.domainSep) !== eh.domainSep)
      failures.push(`header.domainSep: expected ${String(eh.domainSep)}, got ${String(gh.domainSep)}`);
    if (gh.kind !== eh.kind) failures.push(`header.kind: expected ${String(eh.kind)}, got ${String(gh.kind)}`);
  }
  if (expect.records !== undefined) {
    const er = expect.records as Json[];
    const gr = Array.isArray(got.records) ? (got.records as Json[]) : [];
    if (gr.length !== er.length) failures.push(`records: expected ${er.length}, got ${gr.length}`);
    for (let i = 0; i < Math.min(er.length, gr.length); i++) {
      const e = er[i] as Json;
      const g = gr[i] as Json;
      for (const k of ['offset', 'key_hex', 'valType', 'value_hex'] as const) {
        if (lower(g[k]) !== e[k]) failures.push(`records[${i}].${k}: expected ${String(e[k])}, got ${String(g[k])}`);
      }
      if (e.decoded !== undefined && g.decoded !== e.decoded)
        failures.push(`records[${i}].decoded: expected ${String(e.decoded)}, got ${String(g.decoded)}`);
    }
  }
  if (expect.contentEnd !== undefined) {
    let end = got.contentEnd;
    if (end === undefined && Array.isArray(got.records) && got.records.length > 0)
      end = recordEnd(got.records[got.records.length - 1] as Json);
    if (end !== expect.contentEnd) failures.push(`contentEnd: expected ${String(expect.contentEnd)}, got ${String(end)}`);
  }
  return { ok: failures.length === 0, failures, notes, notApplicable: [] };
}

function identityKey(o: Json): string {
  return [o.network, lower(o.contractAddress), lower(o.domainSep), o.kind].join('|');
}

function isEmptyHidden(o: Json): boolean {
  return o.visible === false && (!isObj(o.fields) || Object.keys(o.fields).length === 0);
}

function compareIdentities(expected: Json[], got: unknown, failures: string[], notes: string[]): void {
  if (!Array.isArray(got)) {
    failures.push('identities: missing or not an array');
    return;
  }
  const exp = new Map<string, Json>();
  for (const e of expected) if (!isEmptyHidden(e)) exp.set(identityKey(e), e);
  const act = new Map<string, Json>();
  for (const g of got as Json[]) {
    if (!isObj(g)) {
      failures.push('identities: entry is not an object');
      continue;
    }
    if (isEmptyHidden(g)) continue;
    const k = identityKey(g);
    if (act.has(k)) failures.push(`identity ${k}: reported twice`);
    act.set(k, g);
  }
  for (const [k, e] of exp) {
    const g = act.get(k);
    if (g === undefined) {
      failures.push(
        `identity ${k}: expected ${e.visible === true ? 'visible' : 'hidden'} with ${Object.keys(e.fields as Json).length} field(s), not reported (or hidden and empty)`,
      );
      continue;
    }
    if (g.visible !== e.visible) failures.push(`identity ${k}: visible expected ${String(e.visible)}, got ${String(g.visible)}`);
    if (e.colored !== undefined && g.colored !== e.colored)
      failures.push(`identity ${k}: colored expected ${String(e.colored)}, got ${String(g.colored)}`);
    const ef = e.fields as Json;
    const gf = isObj(g.fields) ? g.fields : {};
    const gfLower = new Map(Object.entries(gf).map(([key, v]) => [key.toLowerCase(), v]));
    for (const [key, ev] of Object.entries(ef)) {
      const evo = ev as Json;
      const gv = gfLower.get(key);
      const label = evo.key_text !== undefined ? `${key} (${String(evo.key_text)})` : key;
      if (!isObj(gv)) {
        if (COMMON_KEYS_HEX.has(key)) failures.push(`identity ${k}: field ${label} missing`);
        else
          notes.push(
            `identity ${k}: field ${label} not reported (allowed: not a common key; "Indexers MAY index only some tokens or keys")`,
          );
        continue;
      }
      if (gv.valType !== evo.valType)
        failures.push(`identity ${k}: field ${label} valType expected ${String(evo.valType)}, got ${String(gv.valType)}`);
      if (lower(gv.value_hex) !== evo.value_hex)
        failures.push(`identity ${k}: field ${label} value expected ${String(evo.value_hex)}, got ${String(gv.value_hex)}`);
      if (evo.usable !== undefined && gv.usable !== evo.usable)
        failures.push(`identity ${k}: field ${label} usable expected ${String(evo.usable)}, got ${String(gv.usable)}`);
    }
    for (const key of gfLower.keys()) if (!(key in ef)) failures.push(`identity ${k}: unexpected field ${key}`);
  }
  for (const k of act.keys())
    if (!exp.has(k))
      failures.push(`identity ${k}: not expected (reported ${act.get(k)?.visible === true ? 'visible' : 'hidden with fields'})`);
}

/** Groups of two or more members: (network, contractAddress, symbol_hex) → sorted members. Duplicate keys fail. */
function multiMemberGroups(groups: Json[], failures: string[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const g of groups) {
    if (!isObj(g)) {
      failures?.push('groups: entry is not an object');
      continue;
    }
    const key = [g.network, lower(g.contractAddress), lower(g.symbol_hex)].join('|');
    const members = (Array.isArray(g.members) ? (g.members as Json[]) : [])
      .map((x) => `${String(lower(x.domainSep))}/${String(x.kind)}`)
      .sort();
    if (members.length < 2) continue; // a single-member group is not compared (S9: "no groups at all" is valid)
    if (m.has(key)) failures?.push(`group ${key}: reported twice`);
    m.set(key, members.join(','));
  }
  return m;
}

function compareGroups(expected: Json[], got: unknown, failures: string[], notApplicable: string[]): void {
  if (got !== undefined && got !== null && !Array.isArray(got)) {
    failures.push('groups: not an array');
    return;
  }
  const e = multiMemberGroups(expected, undefined);
  const g = multiMemberGroups((got ?? []) as Json[], failures);
  if (g.size === 0) {
    notApplicable.push(
      `groups: the consumer reports no group of two or more members — valid: "Grouping is a SHOULD, so two outcomes are valid: no groups at all, or exactly the following groups" (expected ${e.size} such group(s))`,
    );
    return;
  }
  for (const [k, members] of e) {
    const gm = g.get(k);
    if (gm === undefined) failures.push(`group ${k}: missing (expected members ${members})`);
    else if (gm !== members) failures.push(`group ${k}: members expected ${members}, got ${gm}`);
  }
  for (const [k, members] of g) if (!e.has(k)) failures.push(`group ${k}: not expected (members ${members})`);
}

function compareDisplay(expected: Json[], got: unknown, failures: string[], notApplicable: string[]): void {
  if (got === undefined || got === null) {
    notApplicable.push('display: not reported — the consumer does not display amounts (S8: "A consumer that displays amounts …")');
    return;
  }
  if (!Array.isArray(got)) {
    failures.push('display: not an array');
    return;
  }
  const list = got as Json[];
  for (const e of expected) {
    const k = `${identityKey(e)}|${String(e.raw)}`;
    const g = list.find((x) => isObj(x) && `${identityKey(x)}|${String(x.raw)}` === k);
    if (g === undefined) {
      failures.push(`display ${k}: missing`);
      continue;
    }
    if (g.decimals !== e.decimals) failures.push(`display ${k}: decimals expected ${String(e.decimals)}, got ${String(g.decimals)}`);
    if (g.text !== e.text) failures.push(`display ${k}: text expected ${JSON.stringify(e.text)}, got ${JSON.stringify(g.text)}`);
  }
}

export function compareState(expect: Json, got: Json): Comparison {
  const failures: string[] = [];
  const notes: string[] = [];
  const notApplicable: string[] = [];
  if (typeof got.error === 'string') return { ok: false, failures: [`consumer error: ${got.error}`], notes, notApplicable };
  compareIdentities(expect.identities as Json[], got.identities, failures, notes);
  if (expect.groups !== undefined) compareGroups(expect.groups as Json[], got.groups, failures, notApplicable);
  if (expect.display !== undefined) compareDisplay(expect.display as Json[], got.display, failures, notApplicable);
  return { ok: failures.length === 0, failures, notes, notApplicable };
}
