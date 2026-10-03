/**
 * Runs the REFERENCE's own Stagenet-case comparison (`compareState` of midnight-experiments/mip-0018
 * `packages/midnight/src/expect-state.ts` — what its `list --expect` / `recheck` use) against UmbraDB's results.
 * Development only: that file is not vendored (only the codec, the vectors and the runner are), so it is imported from
 * a read-only clone of the reference given by `REFERENCE_DIR`.
 *
 *   PG_URL=… REFERENCE_DIR=/ref node --import tsx token-indexer/dev/reference-compare.ts \
 *     --archive live_range_r_archive --mip live_range_r_mip --u1-archive … --u1-mip … --cases token-indexer/test/fixtures/mip0018-cases --out FILE
 *
 * UmbraDB's state of each case contract is projected into the reference's expected-state shape (identities with
 * `visible`, `colored`, usable `common`, every field; symbol groups; classification counts) and compared twice:
 * (1) as the reference compares — every group, so UmbraDB's missing single-member groups show up (UmbraDB groups
 * only two or more members), and (2) with single-member groups removed from the expectation. C06 is compared
 * per step: the reference files (`78ecbb4`, identity-wide tombstones) and UmbraDB's per-key files.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { loadCaseIndex } from "../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import { eventCounts } from "../mip0018/events.ts";
import { listGroups, listIdentities } from "../mip0018/metadata.ts";
import { Mip0018Scanner } from "../mip0018/scan.ts";
import { COMMON_KEY_HEX, parseStandards } from "../mip0018/state.ts";

type Expected = { identities: Array<Record<string, unknown> & { domainSep: string; kind: number }>; groups: Array<{ symbol: string; members: Array<{ domainSep: string; kind: number }> }>; counts?: Record<string, number> };
type Compare = (observed: Expected, expected: Expected) => { ok: boolean; differences: string[] };

const NET = "stagenet";
const dec = new TextDecoder();

async function observed(sql: UmbraDBSql, schema: string, contract: string): Promise<Expected> {
  const ids = await listIdentities(sql, NET, { contractAddress: contract }, schema);
  return {
    identities: ids.map((i) => {
      const common: Record<string, unknown> = {};
      for (const [name, keyHex] of Object.entries(COMMON_KEY_HEX)) {
        const f = i.fields.get(keyHex);
        if (f === undefined || f.usable !== true) continue;
        if (name === "decimals") common.decimals = f.integer! <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(f.integer) : f.integer!.toString();
        else if (name === "standards") common.standards = parseStandards(f.value)!.join(" ");
        else common[name] = dec.decode(f.value);
      }
      return {
        domainSep: `0x${i.domainSep}`, kind: i.kind, visible: true, colored: i.kind !== 3, common,
        fields: Object.fromEntries([...i.fields].map(([k, f]) => [k, {
          key_text: dec.decode(Buffer.from(k, "hex")), valType: f.valType, value_hex: Buffer.from(f.value).toString("hex"),
          ...(f.usable === undefined ? {} : { usable: f.usable }),
        }])),
      };
    }),
    groups: (await listGroups(sql, NET, { contractAddress: contract }, schema)).map((g) => ({
      symbol: dec.decode(Buffer.from(g.symbol, "hex")), members: g.members.map((m) => ({ domainSep: `0x${m.domainSep}`, kind: m.kind })),
    })),
    counts: await eventCounts(sql, NET, contract, schema),
  };
}

const withoutSingleGroups = (e: Expected): Expected => ({ ...e, groups: e.groups.filter((g) => g.members.length >= 2) });

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2), strict: true,
    options: { archive: { type: "string" }, mip: { type: "string" }, "u1-archive": { type: "string" }, "u1-mip": { type: "string" }, cases: { type: "string" }, out: { type: "string" } },
  });
  const ref = process.env.REFERENCE_DIR;
  if (ref === undefined || process.env.PG_URL === undefined) throw new Error("PG_URL and REFERENCE_DIR are required");
  const { compareState } = (await import(pathToFileURL(join(ref, "packages/midnight/src/expect-state.ts")).href)) as { compareState: Compare };
  const casesDir = resolve(values.cases!);
  const readCase = (f: string): Expected => JSON.parse(readFileSync(join(casesDir, f), "utf8")) as Expected;
  const caseIndex = loadCaseIndex();
  const sql = createClient({ connectionString: process.env.PG_URL, schema: values.mip! });
  const results: Record<string, { raw: string[]; twoOrMore: string[] }> = {};
  const run = async (label: string, schema: string, contract: string, file: string): Promise<void> => {
    const obs = await observed(sql, schema, contract);
    const exp = readCase(file);
    results[label] = { raw: compareState(obs, exp).differences, twoOrMore: compareState(obs, withoutSingleGroups(exp)).differences };
  };
  try {
    for (const c of ["C01", "C02", "C03", "C04", "C05", "C07", "C08", "C10"]) await run(c, values.mip!, caseIndex.cases[c]!.contract!, `${c}/expected.json`);
    await run("C09 (C01's file, byte-identical)", values.mip!, caseIndex.cases.C09!.contract!, "C01/expected.json");
    await run("U1", values["u1-mip"]!, caseIndex.cases.U1!.contract!, "U1/expected.json");
    // C06 per step, in a fresh schema scanned step by step over the same archive.
    const stepSchema = `${values.mip!}_c06steps`;
    await sql`DROP SCHEMA IF EXISTS ${sql(stepSchema)} CASCADE`;
    const stepSql = createClient({ connectionString: process.env.PG_URL, schema: stepSchema });
    try {
      for (const s of caseIndex.cases.C06!.steps.filter((x) => x.expectedAfter !== undefined)) {
        const sc = new Mip0018Scanner({ sql: stepSql, network: NET, schema: stepSchema, archiveSchema: values.archive!, toHeight: s.height! });
        await sc.bootstrap();
        for (;;) {
          const r = await sc.scanOnce({ maxBlocks: 1_000 });
          if (r.scannedBlocks === 0 || r.reachedEnd) break;
        }
        const contract = caseIndex.cases.C06!.contract!;
        const obs = await observed(stepSql, stepSchema, contract);
        const reference = readCase(`C06/${s.expectedAfter!}`);
        results[`C06 ${s.id} vs reference (78ecbb4)`] = { raw: compareState(obs, reference).differences, twoOrMore: compareState(obs, withoutSingleGroups(reference)).differences };
        if (["withdraw", "withdraw-again", "revive"].includes(s.id)) {
          const own = readCase(`C06/umbradb-per-key/${s.expectedAfter!}`);
          results[`C06 ${s.id} vs UmbraDB per-key`] = { raw: compareState(obs, own).differences, twoOrMore: compareState(obs, withoutSingleGroups(own)).differences };
        }
      }
      await stepSql`DROP SCHEMA IF EXISTS ${stepSql(stepSchema)} CASCADE`;
    } finally {
      await stepSql.end({ timeout: 5 });
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  writeFileSync(values.out!, `${JSON.stringify(results, null, 2)}\n`);
  for (const [k, v] of Object.entries(results)) console.log(`${k}: raw ${v.raw.length === 0 ? "OK" : v.raw.join(" | ")} ; groups of 2+ ${v.twoOrMore.length === 0 ? "OK" : v.twoOrMore.join(" | ")}`);
}

if (process.argv[1]?.endsWith("reference-compare.ts")) await main();
