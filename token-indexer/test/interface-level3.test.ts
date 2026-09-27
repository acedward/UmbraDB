import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_MODULES, compilerAvailable, directivesOf, levelThree, probeCompile, quotedDirective, quotedDirectives, reachableDirectiveProblem, searchTraceProblem, type Level3Options } from "../interface/level3.js";
import { clone, compiler033, loadFixtureBundle, sha256Hex, verdict, withFiles, withPackage, type Bundle } from "./helpers/pi-fixture.js";

/**
 * Project 00024-02 task C6 — [B] Level 3, TRIED with the exact compiler the bundle names (spec
 * FR-013, Q7, Q13, US1 scenario 4b).
 *
 * `[[interface-level3]]` drives the real Level 3 code against a STAND-IN for the Compact CLI
 * (`helpers/fake-compact.mjs`): CI has no Compact compiler, and the stand-in answers the two calls
 * Level 3 makes exactly as `compact` 0.2.0 does, writing a recorded compile's output. What is under
 * test is everything around the compiler: the exact-version probe and `not_run`, the private
 * directory holding only listed files, `COMPACT_PATH` removed, `--trace-search` confinement and its
 * positive control, the byte comparisons, the deadline, and failed-vs-not_run.
 *
 * The REAL compiler (host `compact` with 0.34.0) runs in the second, environment-gated suite — not
 * governed, skipped where the toolchain is absent (CI) — and in 02-D's local-chain run.
 */

const STAND_IN = fileURLToPath(new URL("./helpers/fake-compact.mjs", import.meta.url));
const listedOf = (b: Bundle): string[] => [...b.keys()].filter((p) => p !== "index.json").sort();
const filesOf = (b: Bundle): Map<string, Buffer> => new Map([...b].filter(([p]) => p !== "index.json"));

describe("[B] Level 3 with the stand-in compiler (C6)", () => {
  let scratch: string;
  let log: string;
  const saved = { ...process.env };

  beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "umbradb-l3-test-")); });
  afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_COMPACT_") || k === "COMPACT_PATH") delete process.env[k];
    Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([k]) => k.startsWith("FAKE_COMPACT_") || k === "COMPACT_PATH")));
  });

  /** A recorded compile's output tree for `bundle`, with optional changes. */
  function output(bundle: Bundle, change: (dir: string) => void = () => {}): string {
    const dir = mkdtempSync(join(scratch, "out-"));
    mkdirSync(join(dir, "keys"));
    mkdirSync(join(dir, "contract"));
    mkdirSync(join(dir, "compiler"));
    for (const [p, body] of bundle) {
      if (p.startsWith("out/keys/")) writeFileSync(join(dir, "keys", p.slice("out/keys/".length)), body);
    }
    writeFileSync(join(dir, "contract", "index.js"), bundle.get("out/contract/index.js")!);
    writeFileSync(join(dir, "compiler", "contract-info.json"), bundle.get("out/compiler/contract-info.json")!);
    change(dir);
    return dir;
  }

  /** Configures the stand-in for the next call — every earlier setting cleared first. */
  function useStandIn(env: Record<string, string>): void {
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_COMPACT_")) delete process.env[k];
    log = join(scratch, `log-${Math.random().toString(16).slice(2)}.jsonl`);
    Object.assign(process.env, { FAKE_COMPACT_LOG: log, ...env });
  }
  const calls = (): { args: string[]; cwd: string; compactPath: boolean; files: string[] }[] =>
    (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []).map((l) => JSON.parse(l));

  const opts = (o: Partial<Level3Options> = {}): Partial<Level3Options> => ({ compactBin: STAND_IN, deadlineMs: 20_000, tmpRoot: scratch, ...o });

  it("[[interface-level3]] Level 3 is tried with the exact compiler named: passed / failed / not_run with the reason; only listed files, COMPACT_PATH removed, trace confined; deadline; never executes the bundle", async () => {
    const bundle = loadFixtureBundle();
    const files = filesOf(bundle);
    const listed = listedOf(bundle);

    // --- passed: every shipped key, index.js and contract-info.json reproduced ------------------
    useStandIn({ FAKE_COMPACT_OUTPUT: output(bundle), COMPACT_PATH: "/somewhere/the/consumer/keeps/modules" });
    const ok = await levelThree(files, listed, opts());
    expect(verdict("valid").l3!.ok).toBe(true);
    expect(ok.outcome).toBe("passed");
    expect(ok.reason).toBeUndefined();
    expect(ok.compiler).toEqual({ version: "0.34.0", flags: [], installed: "0.34.0" });
    expect(ok.rows).toEqual([
      { item: "guardedIncrement.verifier", status: "OK" }, { item: "increment.verifier", status: "OK" },
      { item: "read.verifier", status: "OK" }, { item: "contract/index.js", status: "OK" }, { item: "compiler/contract-info.json", status: "OK" },
    ]);
    // The same rows the reference verifier compared (its items, its order).
    expect(ok.rows.map((r) => r.item)).toEqual(verdict("valid").l3!.rows.map((r) => r.item));
    expect(ok.generatedKeys).toEqual(["guardedIncrement", "increment", "read"].map((c) => ({ circuit: c, sha256: sha256Hex(bundle.get(`out/keys/${c}.verifier`)!) })));
    // Exactly two calls: the probe, then the compile — `+<version>`, `--trace-search`, the source,
    // in a private directory that holds the listed files and nothing else; COMPACT_PATH removed.
    const [probe, compile] = calls();
    expect(probe!.args).toEqual(["compile", "+0.34.0", "--version"]);
    expect(compile!.args.slice(0, 3)).toEqual(["compile", "+0.34.0", "--trace-search"]);
    expect(compile!.args[3]).toBe(join(compile!.cwd, "src", "PiFixture.compact"));
    expect(compile!.files).toEqual(listed);
    expect(compile!.compactPath).toBe(false);
    expect(probe!.compactPath).toBe(false);
    // The private directories are gone.
    expect(existsSync(compile!.cwd)).toBe(false);
    expect(existsSync(compile!.args[4]!)).toBe(false);

    // --- not_run: the named compiler is not installed (the reference would report versionMismatch) --
    useStandIn({ FAKE_COMPACT_OUTPUT: output(bundle) });
    const old = await levelThree(filesOf(compiler033(bundle)), listedOf(compiler033(bundle)), opts());
    expect(verdict("compiler-0.33.0").l3).toMatchObject({ ok: true, versionMismatch: true });
    expect(old.outcome).toBe("not_run");
    expect(old.reason).toMatch(/^compiler 0\.33\.0 unavailable \(.* compile \+0\.33\.0: Error: Failed to run compactc\)$/);
    expect(calls().map((c) => c.args)).toEqual([["compile", "+0.33.0", "--version"]]); // never compiled
    const missingBin = await levelThree(files, listed, opts({ compactBin: join(scratch, "no-such-compact") }));
    expect(missingBin).toMatchObject({ outcome: "not_run", reason: expect.stringMatching(/compiler 0\.34\.0 unavailable: the Compact toolchain is not installed/) });
    expect(await compilerAvailable(STAND_IN, "0.34.0")).toEqual({ ok: true, installed: "0.34.0" });

    // --- failed: the source does not reproduce what the bundle ships ------------------------------
    const forgedJs = output(bundle, (dir) => { writeFileSync(join(dir, "contract", "index.js"), "export const forged = true;\n"); });
    useStandIn({ FAKE_COMPACT_OUTPUT: forgedJs });
    const forged = await levelThree(files, listed, opts());
    expect(forged).toMatchObject({ outcome: "failed", reason: "the published source does not reproduce contract/index.js" });
    expect(forged.rows.find((r) => r.item === "contract/index.js")?.status).toBe("FAIL");
    useStandIn({ FAKE_COMPACT_OUTPUT: output(bundle, (dir) => { rmSync(join(dir, "keys", "read.verifier")); }) });
    expect((await levelThree(files, listed, opts())).rows.find((r) => r.item === "read.verifier")).toEqual({ item: "read.verifier", status: "FAIL", reason: "not produced by the recompile" });
    useStandIn({ FAKE_COMPACT_OUTPUT: output(bundle, (dir) => { writeFileSync(join(dir, "keys", "hidden.verifier"), "x"); }) });
    const extra = await levelThree(files, listed, opts());
    expect(extra.rows.find((r) => r.item === "hidden.verifier")).toEqual({ item: "hidden.verifier", status: "FAIL", reason: "produced by the recompile but not shipped" });
    expect(extra.generatedKeys.map((k) => k.circuit)).toContain("hidden");
    useStandIn({ FAKE_COMPACT_OUTPUT: output(bundle, (dir) => { writeFileSync(join(dir, "keys", "increment.verifier"), "another key"); }) });
    expect((await levelThree(files, listed, opts())).rows.find((r) => r.item === "increment.verifier")?.status).toBe("FAIL");
    useStandIn({ FAKE_COMPACT_OUTPUT: output(bundle, (dir) => { writeFileSync(join(dir, "compiler", "contract-info.json"), "{}"); }) });
    expect((await levelThree(files, listed, opts())).reason).toBe("the published source does not reproduce compiler/contract-info.json");
    // A source that does not compile is failed; the compiler's environment failing is not_run.
    useStandIn({ FAKE_COMPACT_EXIT: "255", FAKE_COMPACT_STDERR: "Exception: PiFixture.compact line 20 char 3: parse error" });
    expect(await levelThree(files, listed, opts())).toMatchObject({ outcome: "failed", reason: "recompile failed: Exception: PiFixture.compact line 20 char 3: parse error" });
    // Whose failure it is, a probe compile of a known-good contract decides (audit 02 E2-R2C) — never
    // the text: the probe fails too → the environment's (not_run); the probe compiles → the bundle's.
    const envDown = { FAKE_COMPACT_EXIT: "1", FAKE_COMPACT_STDERR: "error constructing midnight data provider fetcher: builder error", FAKE_COMPACT_PROBE_EXIT: "1", FAKE_COMPACT_PROBE_STDERR: "error constructing midnight data provider fetcher: builder error" };
    useStandIn(envDown);
    expect(await levelThree(files, listed, opts())).toMatchObject({ outcome: "not_run", reason: expect.stringMatching(/^the compiler's environment failed: error constructing midnight data provider .*\(a probe compile of a known-good contract failed too: error constructing/) });
    expect(calls().map((c) => c.args.at(-2)!.split("/").pop())).toEqual(["+0.34.0", "PiFixture.compact", "umbradb-l3-probe.compact"]); // version probe, compile, environment probe
    // A bundle that MENTIONS such a phrase (a README) does not turn a real environment failure into its own.
    const mentions = withFiles(bundle, { "README.md": Buffer.from(`${bundle.get("README.md")!.toString("utf8")}\nThe compiler uses a data provider and zk-params.\n`) });
    useStandIn(envDown);
    expect(await levelThree(filesOf(mentions), listedOf(mentions), opts())).toMatchObject({ outcome: "not_run" });
    // An environment failure worded like nothing known is still the environment's when the probe fails.
    useStandIn({ FAKE_COMPACT_EXIT: "1", FAKE_COMPACT_STDERR: "Error: something unexpected", FAKE_COMPACT_PROBE_EXIT: "1" });
    expect(await levelThree(files, listed, opts())).toMatchObject({ outcome: "not_run" });
    // The probe cannot even be prepared (E2-R3C: e.g. the disk the bundle's compile filled): Level 3 is
    // not_run — levelThree never throws, so the passed Levels 1-2 are kept — and nothing is left behind.
    expect(await probeCompile(STAND_IN, "0.34.0", [], { tmpRoot: join(scratch, "no-such-dir"), timeoutMs: 5_000 })).toMatchObject({ ok: false, reason: expect.stringMatching(/^the probe could not be prepared \(ENOENT\)$/) });
    // Anything unexpected inside Level 3 (here an injected probe that throws — deterministic under any
    // uid, release persona round 4) is Level 3's own not_run; levelThree never rejects.
    useStandIn({ FAKE_COMPACT_EXIT: "255", FAKE_COMPACT_STDERR: "Exception: out of space" });
    const thrown = await levelThree(files, listed, opts({ probe: async () => { throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" }); } }));
    expect(thrown).toMatchObject({ outcome: "not_run", reason: "Level 3 could not be completed (ENOSPC)" });
    // A diagnostic worded like an environment failure (a source file named zkparams, however its name
    // was spelled in package.json) is the bundle's when the probe compiles.
    useStandIn({ FAKE_COMPACT_EXIT: "255", FAKE_COMPACT_STDERR: "Exception: zkparams.compact line 1 char 1: parse error" });
    expect(await levelThree(files, listed, opts())).toMatchObject({ outcome: "failed", reason: "recompile failed: Exception: zkparams.compact line 1 char 1: parse error" });
    // …but only on text the bundle cannot have written (audit 02 E2-F7): a missing module whose NAME
    // holds such a phrase is echoed by the compiler — that is the bundle's failure, not the environment's.
    const echoed = withFiles(bundle, { "src/PiFixture.compact": Buffer.from(bundle.get("src/PiFixture.compact")!.toString("utf8")
      .replace("import CompactStandardLibrary;", 'import CompactStandardLibrary;\nimport "./data provider" prefix D_;')) });
    useStandIn({
      FAKE_COMPACT_TRACE: JSON.stringify(["looking for ./data provider.compact...not found"]),
      FAKE_COMPACT_EXIT: "255", FAKE_COMPACT_STDERR: 'Exception: PiFixture.compact line 10 char 1: failed to locate file "./data provider.compact"',
    });
    expect(await levelThree(filesOf(echoed), listedOf(echoed), opts())).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/^recompile failed: Exception: .*data provider/) });

    // --- only listed files are read: the search trace is confined, and it must be recognisable ----
    const outside = mkdtempSync(join(scratch, "outside-"));
    writeFileSync(join(outside, "Stolen.compact"), "module Stolen {}\n");
    useStandIn({ FAKE_COMPACT_OUTPUT: output(bundle), FAKE_COMPACT_TRACE: JSON.stringify([`looking for ${join(outside, "Stolen.compact")}...found`]) });
    expect((await levelThree(files, listed, opts())).reason).toMatch(/the recompile read ".*Stolen\.compact", which is outside the bundle/);
    useStandIn({ FAKE_COMPACT_OUTPUT: output(bundle), FAKE_COMPACT_TOUCH: "Unlisted.compact", FAKE_COMPACT_TRACE: JSON.stringify(["looking for Unlisted.compact...found"]) });
    expect((await levelThree(files, listed, opts())).reason).toBe('the recompile read "Unlisted.compact", which is not listed in index.json, so it is not part of the committed bundle');
    useStandIn({ FAKE_COMPACT_OUTPUT: output(bundle), FAKE_COMPACT_TRACE: JSON.stringify(["looking for Nope.compact...not found", "looking for src/PiFixture.compact...found"]) });
    expect((await levelThree(files, listed, opts())).outcome).toBe("passed");
    useStandIn({ FAKE_COMPACT_OUTPUT: output(bundle), FAKE_COMPACT_TRACE: JSON.stringify(["looking for Evil", ".compact...found"]) });
    expect((await levelThree(files, listed, opts())).reason).toMatch(/search trace could not be read/);
    // Positive control: a listed source imports by name, yet the compiler printed no trace line.
    const importing = withFiles(bundle, { "src/Other.compact": Buffer.from('pragma language_version >= 0.26.0;\nimport "./Lib";\n') });
    useStandIn({ FAKE_COMPACT_OUTPUT: output(importing) });
    expect((await levelThree(filesOf(importing), listedOf(importing), opts())).reason).toMatch(/search trace was not recognised: "src\/Other\.compact" imports or includes "\.\/Lib"/);
    expect(quotedDirective('// import "no"\n/* include "no" */ const s = "import"; import { a } from "yes";')).toBe("yes");
    expect(quotedDirective("import CompactStandardLibrary;")).toBeNull();
    expect(searchTraceProblem("", { root: join(scratch, "does-not-exist"), listed: [] })).toMatch(/cannot be resolved/);

    // --- the deadline: not_run, never blocking -----------------------------------------------------
    useStandIn({ FAKE_COMPACT_OUTPUT: output(bundle), FAKE_COMPACT_SLEEP_MS: "10000" });
    const started = Date.now();
    const slow = await levelThree(files, listed, opts({ deadlineMs: 400 }));
    expect(slow).toMatchObject({ outcome: "not_run", reason: "the compile with compactc 0.34.0 did not finish within 400 ms" });
    expect(Date.now() - started).toBeLessThan(5_000);
    // A compiler printing without bound is stopped: its trace cannot be checked.
    useStandIn({ FAKE_COMPACT_OUTPUT: output(bundle), FAKE_COMPACT_TRACE: JSON.stringify(Array.from({ length: 200 }, (_v, i) => `looking for Nope${i}.compact...not found`)) });
    expect((await levelThree(files, listed, opts({ maxOutputBytes: 1_000 }))).reason).toMatch(/printed more than 1000 bytes/);

    // --- what the bundle asks for: failed before any compiler runs ---------------------------------
    useStandIn({ FAKE_COMPACT_OUTPUT: output(bundle) });
    const skipZk = withPackage(bundle, (pkg) => { pkg.compact.flags = ["--skip-zk"]; });
    expect((await levelThree(filesOf(skipZk), listedOf(skipZk), opts())).reason).toMatch(/asks for compiler flags this verifier does not pass: \["--skip-zk"\]/);
    const notListed = withPackage(bundle, (pkg) => { pkg.compact.interface = "src/Elsewhere.compact"; });
    expect((await levelThree(filesOf(notListed), listedOf(notListed), opts())).reason).toMatch(/compact\.interface "src\/Elsewhere\.compact" is not listed/);
    const traversal = withPackage(bundle, (pkg) => { pkg.compact.interface = "../../etc/x.compact"; });
    expect((await levelThree(filesOf(traversal), listedOf(traversal), opts())).outcome).toBe("failed");
    const noInterface = withPackage(bundle, (pkg) => { delete pkg.compact.interface; });
    expect((await levelThree(filesOf(noInterface), listedOf(noInterface), opts())).reason).toMatch(/does not point at a published source/);
    const noPkg = clone(bundle);
    noPkg.delete("package.json");
    expect((await levelThree(filesOf(noPkg), listedOf(noPkg), opts())).reason).toMatch(/package\.json is missing or not JSON/);
    expect(calls()).toEqual([]); // none of those five reached the compiler
    // An allowed flag is passed through exactly.
    const v3 = withPackage(bundle, (pkg) => { pkg.compact.flags = ["--feature-zkir-v3"]; });
    useStandIn({ FAKE_COMPACT_OUTPUT: output(v3) });
    await levelThree(filesOf(v3), listedOf(v3), opts());
    expect(calls()[1]!.args.slice(0, 4)).toEqual(["compile", "+0.34.0", "--trace-search", "--feature-zkir-v3"]);

    // compact.interface is resolved as the reference resolves it (audit 02 E2-F5): equivalent
    // spellings of the listed source compile it; an absolute path or one leaving the bundle is refused
    // before the compiler runs, and nothing is rewritten (a backslash is an ordinary character).
    for (const spelling of ["src/./PiFixture.compact", "./src/PiFixture.compact", "src/../src/PiFixture.compact"]) {
      const alias = withPackage(bundle, (pkg) => { pkg.compact.interface = spelling; });
      useStandIn({ FAKE_COMPACT_OUTPUT: output(alias) });
      expect(await levelThree(filesOf(alias), listedOf(alias), opts()), spelling).toMatchObject({ outcome: "passed" });
      expect(calls()[1]!.args.at(-2)!.endsWith("/src/PiFixture.compact"), spelling).toBe(true);
    }
    useStandIn({ FAKE_COMPACT_OUTPUT: output(bundle) });
    for (const [spelling, why] of [
      ["/bundle/src/PiFixture.compact", /resolves outside the bundle/], ["src/../../PiFixture.compact", /resolves outside the bundle/],
      // Resolved against the REAL private directory, as the reference does (E2-R2D): leaving it and
      // naming a directory "bundle" does not come back in (the reference refuses this one too).
      ["../bundle/src/PiFixture.compact", /resolves outside the bundle/],
      ["src\\PiFixture.compact", /compact\.interface "src\\\\PiFixture\.compact" is not listed/],
    ] as const) {
      const alias = withPackage(bundle, (pkg) => { pkg.compact.interface = spelling; });
      expect((await levelThree(filesOf(alias), listedOf(alias), opts())).reason, spelling).toMatch(why);
    }
    expect(calls()).toEqual([]);

    // The read boundary BEFORE the compiler runs (audit 02 E2-F6): a listed source that names, by a
    // quoted import/include, a file that can only lie outside the bundle is refused, and the compiler
    // (which would read it with the indexer's permissions) is never started.
    const source = bundle.get("src/PiFixture.compact")!.toString("utf8");
    const withDirective = (line: string): Bundle =>
      withFiles(bundle, { "src/PiFixture.compact": Buffer.from(source.replace("import CompactStandardLibrary;", `import CompactStandardLibrary;\n${line}`)) });
    for (const line of [
      'include "/etc/umbradb-l3-outside";', 'import "../../../outside" prefix O_;', 'import "..\\/outside" prefix O_;',
      // E2-R2D: checked against the real directory, not a fictitious root it could re-enter.
      'import "../../bundle/Stolen" prefix S_;',
    ]) {
      const hostile = withDirective(line);
      expect((await levelThree(filesOf(hostile), listedOf(hostile), opts())).reason, line)
        .toMatch(/^"src\/PiFixture\.compact" imports or includes .*, which is outside the bundle; the compiler was not run$/);
    }
    expect(calls()).toEqual([]);
    // Not refused: a directive in a comment, a relative name inside the bundle (the private directory
    // holds only listed files, so the compiler finds nothing else there), and — E2-R2D — a listed
    // source the compile never reaches: the reference compiles such a bundle, and so does this.
    const commented = withDirective('// include "/etc/passwd";');
    expect(reachableDirectiveProblem(filesOf(commented), listedOf(commented), "/r", "src/PiFixture.compact")).toBeNull();
    expect(reachableDirectiveProblem(new Map([["src/a/B.compact", Buffer.from('import "../C";')]]), ["src/a/B.compact"], "/r", "src/a/B.compact")).toBeNull();
    const chain = new Map([["src/A.compact", Buffer.from('import "./sub/B";')], ["src/sub/B.compact", Buffer.from('include "../../../x";')]]);
    expect(reachableDirectiveProblem(chain, [...chain.keys()], "/r", "src/A.compact")).toMatch(/^"src\/sub\/B\.compact" imports or includes "\.\.\/\.\.\/\.\.\/x", which is outside the bundle/);
    // E2-R3F: an unquoted `import Evil;` names src/Evil.compact next to the importer, which is walked too.
    const viaUnquoted = new Map([["src/Main.compact", Buffer.from("import CompactStandardLibrary;\nimport Evil;\n")], ["src/Evil.compact", Buffer.from('import "/outside/Stolen" prefix S_;\n')]]);
    expect(reachableDirectiveProblem(viaUnquoted, [...viaUnquoted.keys()], "/r", "src/Main.compact")).toMatch(/^"src\/Evil\.compact" imports or includes "\/outside\/Stolen", which is outside the bundle/);
    expect(directivesOf("import Foo prefix F_; import { a } from \"b\"; import /* c */ Bar; x import; import\n  Baz;")).toEqual({ quoted: ["b"], unquoted: ["Foo", "Bar", "Baz"] });
    // E2-R4: a selective import from an unquoted module is followed too; a built-in never is.
    expect(directivesOf("import { marker } from Evil; import { x } from \"q\";")).toEqual({ quoted: ["q"], unquoted: ["Evil"] });
    const selective = new Map([["src/Main.compact", Buffer.from("import CompactStandardLibrary;\nimport { marker } from Evil;\n")], ["src/Evil.compact", Buffer.from('module Evil {\n  include "/outside/Stolen";\n  export circuit marker(): [] {}\n}\n')]]);
    expect(reachableDirectiveProblem(selective, [...selective.keys()], "/r", "src/Main.compact")).toMatch(/^"src\/Evil\.compact" imports or includes "\/outside\/Stolen", which is outside the bundle/);
    const shadow = new Map([["src/Main.compact", Buffer.from("import CompactStandardLibrary;\n")], ["src/CompactStandardLibrary.compact", Buffer.from('include "/outside/Unused";\n')]]);
    expect(reachableDirectiveProblem(shadow, [...shadow.keys()], "/r", "src/Main.compact")).toBeNull();
    expect([...BUILTIN_MODULES]).toEqual(["CompactStandardLibrary"]);
    // E2-R3B: a source repeating one import 600 000 times (7.8 MB, under the 8 MiB file cap) is walked
    // in linear time — each file visited once, each distinct name once.
    const repeated = new Map([["src/A.compact", Buffer.from('import "./B";\n'.repeat(600_000))], ["src/B.compact", Buffer.from("")]]);
    const t0 = Date.now();
    expect(reachableDirectiveProblem(repeated, [...repeated.keys()], "/r", "src/A.compact")).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_000);
    const unused = withFiles(bundle, { "src/Unused.compact": Buffer.from('import "/outside/Unused" prefix U_;\n') });
    // (A real compile prints a search-trace line for each file it opens, which satisfies the trace's
    // positive control; the stand-in is given one for the published source.)
    useStandIn({ FAKE_COMPACT_OUTPUT: output(unused), FAKE_COMPACT_TRACE: JSON.stringify(["looking for src/PiFixture.compact...found"]) });
    expect(await levelThree(filesOf(unused), listedOf(unused), opts())).toMatchObject({ outcome: "passed" });
    expect(quotedDirectives('import "a"; /* include "b" */ include "c"; export circuit f(): [] { "import"; }')).toEqual(["a", "c"]);
  }, 120_000);
});

const hostCompact = (() => {
  const r = spawnSync("compact", ["compile", "+0.34.0", "--version"], { encoding: "utf8", timeout: 20_000 });
  return r.status === 0 && r.stdout.trim() === "0.34.0";
})();

describe.skipIf(!hostCompact)("[B] Level 3 with the REAL compiler (host compact, compactc 0.34.0; environment-gated)", () => {
  it("reproduces the reference-built bundle exactly, reports not_run for 0.33.0, and fails a source that does not reproduce the wrapper", async () => {
    const bundle = loadFixtureBundle();
    const real = { compactBin: "compact", deadlineMs: 600_000 };
    const ok = await levelThree(filesOf(bundle), listedOf(bundle), real);
    expect(ok.outcome, ok.reason).toBe("passed");
    expect(ok.rows.every((r) => r.status === "OK")).toBe(true);
    expect(ok.generatedKeys).toEqual(["guardedIncrement", "increment", "read"].map((c) => ({ circuit: c, sha256: sha256Hex(bundle.get(`out/keys/${c}.verifier`)!) })));

    // The environment probe (E2-R2C) compiles with keys on the real toolchain.
    expect(await probeCompile("compact", "0.34.0", [], { timeoutMs: 120_000 })).toEqual({ ok: true });

    const old = await levelThree(filesOf(compiler033(bundle)), listedOf(compiler033(bundle)), real);
    expect(old).toMatchObject({ outcome: "not_run", reason: expect.stringMatching(/^compiler 0\.33\.0 unavailable \(compact compile \+0\.33\.0: Error: Failed to run compactc\)$/) });

    // Genuine keys beside a source that no longer produces the shipped wrapper ([B] Testing: "forged
    // or manually edited JavaScript or JSON do not pass Level 3") — here the source is edited, so the
    // regenerated index.js differs from the shipped one.
    const src = bundle.get("src/PiFixture.compact")!.toString("utf8").replace("caller is not the emitter", "caller is not the publisher");
    const edited = withFiles(bundle, { "src/PiFixture.compact": Buffer.from(src) });
    const bad = await levelThree(filesOf(edited), listedOf(edited), real);
    expect(bad.outcome).toBe("failed");
    expect(bad.rows.find((r) => r.item === "contract/index.js")?.status).toBe("FAIL");
  }, 900_000);
});
