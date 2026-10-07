/**
 * MIP-0018 vector conformance through UmbraDB's pure adapter: the vendored runner core, unchanged, over every vendored
 * vector — in process and through the real runner CLI and adapter process.
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { loadVectors, runVectors, type Json } from "../vendor/mip0018/vectors/tools/runner-core.ts";
import { handleRequest } from "../mip0018/vector-adapter.ts";
import { RUN_VECTORS, VENDORED_VECTORS_DIR } from "../mip0018/run-vectors.ts";

const pure = async (req: Json): Promise<Json> => handleRequest(JSON.parse(JSON.stringify(req)));

function failures(report: Awaited<ReturnType<typeof runVectors>>): string[] {
  return report.results.filter((r) => !r.ok).map((r) => `${r.id}: ${r.failures.join("; ")}`);
}

describe("MIP-0018 vectors through the pure adapter", () => {
  it("[[mip0018.vectors.pure-adapter]] 67/67 normative + 43/43 informative vendored vectors, with groups and display compared", async () => {
    const vectors = loadVectors({ dir: VENDORED_VECTORS_DIR });
    expect(vectors).toHaveLength(110);
    const report = await runVectors(vectors, pure);
    expect(failures(report)).toEqual([]);
    expect(report.normative).toEqual({ passed: 67, total: 67 });
    expect(report.informative).toEqual({ passed: 43, total: 43 });
    expect(report.notApplicable).toEqual({}); // every group and display check ran
    // Where kind 1 has no field left (S3c, S4b) or no symbol (S3d) there is no multi-member group: asserted on the
    // adapter's own answer, because these vectors carry no group expectation.
    const byId = new Map(vectors.map((v) => [v.entry.id, v]));
    for (const id of ["S3c", "S3d", "S4b"]) {
      const res = await pure({ id, op: "state", steps: byId.get(id)!.data.steps });
      expect(res.error, id).toBeUndefined();
      expect(((res.groups ?? []) as Json[]).filter((g) => Array.isArray(g.members) && (g.members as Json[]).length >= 2), id).toEqual([]);
    }
  }, 120_000);

  it("[[mip0018.vectors.no-not-applicable]] negative control: a consumer that reports no groups still passes the runner, but only with S9a–S9d marked not applicable — which the adapter tests refuse", async () => {
    const noGroups = async (req: Json): Promise<Json> => {
      const res = handleRequest(JSON.parse(JSON.stringify(req)));
      delete res.groups;
      return res;
    };
    const report = await runVectors(loadVectors({ dir: VENDORED_VECTORS_DIR }), noGroups);
    expect(report.normative).toEqual({ passed: 67, total: 67 }); // the runner alone cannot see it …
    expect(Object.keys(report.notApplicable).sort()).toEqual(["S9a", "S9b", "S9c", "S9d"]); // … the not-applicable guard does
  }, 120_000);

  it("[[mip0018.vectors.runner-cli]] the vendored runner CLI drives the adapter process over the vendored vectors and exits 0", () => {
    const run = spawnSync(process.execPath, [RUN_VECTORS], { encoding: "utf8", timeout: 120_000 });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("normative: 67/67 passed; informative: 43/43 passed");
    expect(run.stdout).not.toMatch(/^\s*n\/a:/m); // every group and display check ran
  }, 130_000);

  it("adapter errors are answered per request, never by exiting", () => {
    expect(handleRequest({ id: "x", op: "nope" })).toEqual({ id: "x", error: "unknown op nope" });
    expect(handleRequest({ id: "y", op: "decode", type: "Misc", name_hex: "zz", payload_hex: "" })).toMatchObject({ id: "y", error: expect.any(String) });
    expect(handleRequest([1])).toMatchObject({ id: null, error: "request is not a JSON object" });
  });
});
