/**
 * MIP-0018 vector conformance through UmbraDB's pure adapter: the vendored runner core,
 * unchanged, over the vendored vectors minus the eight ids UmbraDB keeps its own versions of, then over those own
 * versions (MIP `274a84f`, per-key tombstones) — in process and through the real runner CLI and adapter process.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifySums } from "../vendor/mip0018/vectors/tools/common.ts";
import { loadVectors, runVectors, type Json } from "../vendor/mip0018/vectors/tools/runner-core.ts";
import { handleRequest } from "../mip0018/vector-adapter.ts";
import { UMBRADB_VECTORS_DIR, VENDORED_VECTORS_DIR, vectorSets } from "../mip0018/run-vectors.ts";

const OWN_IDS = ["S1a", "S3a", "S3b", "S3c", "S3d", "S4a", "S4b", "S9d"];
const pure = async (req: Json): Promise<Json> => handleRequest(JSON.parse(JSON.stringify(req)));

function failures(report: Awaited<ReturnType<typeof runVectors>>): string[] {
  return report.results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.failures.join("; ")}`);
}

describe("MIP-0018 vectors through the pure adapter", () => {
  it("[[mip0018.vectors.pure-adapter]] 59/59 reference normative + 43/43 informative + 8/8 UmbraDB versions, with groups and display compared", async () => {
    const sets = vectorSets();
    expect(sets.overridden.sort()).toEqual([...OWN_IDS].sort());
    const reference = await runVectors(loadVectors({ dir: VENDORED_VECTORS_DIR, only: sets.reference.map((v) => v.id) }), pure);
    expect(failures(reference)).toEqual([]);
    expect(reference.normative).toEqual({ passed: 59, total: 59 });
    expect(reference.informative).toEqual({ passed: 43, total: 43 });
    expect(reference.notApplicable).toEqual({});
    const own = await runVectors(loadVectors({ dir: UMBRADB_VECTORS_DIR }), pure);
    expect(failures(own)).toEqual([]);
    expect(own.normative).toEqual({ passed: 8, total: 8 });
    expect(own.notApplicable).toEqual({}); // S9d's group check must run, never pass as "not applicable"
    expect(own.results.map((r) => r.id).sort()).toEqual([...OWN_IDS].sort());
    // Where the 274a84f text implies a group the own vectors expect it (S3a, S3b, S4a: kinds 1 and 3
    // with "GLD"); where kind 1 has no fields (S3c, S4b) or no symbol (S3d) there is no group — asserted on the
    // adapter's own answer, because the vendored comparer marks an empty group list "not applicable".
    const vectors = loadVectors({ dir: UMBRADB_VECTORS_DIR });
    const byId = new Map(vectors.map((v) => [v.entry.id, v]));
    for (const id of ["S3a", "S3b", "S4a"]) expect(((byId.get(id)!.data.expect as Json).groups as Json[]).map((g) => g.symbol_text), id).toEqual(["GLD"]);
    for (const id of ["S3c", "S3d", "S4b"]) {
      const res = await pure({ id, op: "state", steps: byId.get(id)!.data.steps });
      expect(res.error, id).toBeUndefined();
      expect(((res.groups ?? []) as Json[]).filter((g) => Array.isArray(g.members) && (g.members as Json[]).length >= 2), id).toEqual([]);
      expect((byId.get(id)!.data.expect as Json).groups, id).toBeUndefined();
    }
  }, 120_000);

  it("[[mip0018.vectors.no-not-applicable]] negative control: a consumer that reports no groups still passes the runner, but only with S3a, S3b, S4a, S9d (and the vendored S9a–S9c) marked not applicable — which the adapter tests refuse", async () => {
    const noGroups = async (req: Json): Promise<Json> => {
      const res = handleRequest(JSON.parse(JSON.stringify(req)));
      delete res.groups;
      return res;
    };
    const own = await runVectors(loadVectors({ dir: UMBRADB_VECTORS_DIR }), noGroups);
    expect(own.normative).toEqual({ passed: 8, total: 8 }); // the runner alone cannot see it …
    expect(Object.keys(own.notApplicable).sort()).toEqual(["S3a", "S3b", "S4a", "S9d"]); // … the not-applicable guard does (S3a, S3b, S4a check groups too)
    const sets = vectorSets();
    const reference = await runVectors(loadVectors({ dir: VENDORED_VECTORS_DIR, only: sets.reference.map((v) => v.id) }), noGroups);
    expect(Object.keys(reference.notApplicable).sort()).toEqual(["S9a", "S9b", "S9c"]);
  }, 120_000);

  it("[[mip0018.vectors.own-versions-needed]] the vendored 78ecbb4 versions of exactly six of the eight ids fail under per-key tombstones", async () => {
    const report = await runVectors(loadVectors({ dir: VENDORED_VECTORS_DIR, only: OWN_IDS }), pure);
    expect(report.results.filter((r) => !r.ok).map((r) => r.id).sort()).toEqual(["S3a", "S3b", "S3c", "S3d", "S4b", "S9d"]);
  }, 120_000);

  it("[[mip0018.vectors.own-integrity]] UmbraDB's own vectors match their SHA256SUMS and their generator", () => {
    expect(verifySums(UMBRADB_VECTORS_DIR)).toEqual([]);
    const gen = spawnSync(process.execPath, [join(UMBRADB_VECTORS_DIR, "generate.ts"), "--check"], { encoding: "utf8" });
    expect(gen.stderr).toBe("");
    expect(gen.status).toBe(0);
  }, 120_000);

  it("[[mip0018.vectors.runner-cli]] the vendored runner CLI drives the adapter process over both sets and exits 0", () => {
    const run = spawnSync(process.execPath, [join(UMBRADB_VECTORS_DIR, "..", "run-vectors.ts")], { encoding: "utf8", timeout: 120_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("normative: 59/59 passed; informative: 43/43 passed");
    expect(run.stdout).toContain("normative: 8/8 passed");
    expect(run.stdout).not.toMatch(/^\s*n\/a:/m); // every group and display check ran
  }, 130_000);

  it("adapter errors are answered per request, never by exiting", () => {
    expect(handleRequest({ id: "x", op: "nope" })).toEqual({ id: "x", error: "unknown op nope" });
    expect(handleRequest({ id: "y", op: "decode", type: "Misc", name_hex: "zz", payload_hex: "" })).toMatchObject({ id: "y", error: expect.any(String) });
    expect(handleRequest([1])).toMatchObject({ id: null, error: "request is not a JSON object" });
  });
});
