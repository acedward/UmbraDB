import { describe, expect, it } from "vitest";
import {
  BodyTooLargeError, DEFAULT_LEVEL1_LIMITS, TransportError, compilerProblem, fileUrl, levelOne, type Level1Result,
} from "../interface/level1.js";
import {
  MemoryTransport, clone, commitmentOf, compiler033, loadFixtureBundle, payloadFor, sha256Hex, tamperedFile, verdict,
  withFiles, withPackage, wrongHash, type Bundle,
} from "./helpers/pi-fixture.js";

/**
 * Project 00024-02 task C3 — [B] Level 1 (spec US1 scenario 3, FR-011; plan task C3) on the bundle
 * the patched reference tools built (`fixtures/interfaces/pi-fixture/`), served by an in-memory
 * transport that records every request. Where the reference verifier reached a conclusion on the
 * same bytes (`reference-verdicts.json`), this Level 1 reaches the same one (audit F4: parity on
 * L1/L2/L3 conclusions); transport and limit outcomes are this indexer's policy and are asserted
 * against the spec on their own.
 */

const BASE = "http://bundles.test/pi-fixture/";
const URL = `${BASE}index.json`;

function serve(bundle: Bundle): MemoryTransport {
  return new MemoryTransport(bundle, BASE);
}

async function run(bundle: Bundle, opts: { commitment?: Buffer; transport?: MemoryTransport; limits?: typeof DEFAULT_LEVEL1_LIMITS } = {}) {
  const transport = opts.transport ?? serve(bundle);
  const result = await levelOne({ url: URL, commitment: opts.commitment ?? commitmentOf(bundle) }, transport, opts.limits);
  return { result, transport };
}

const reason = (r: Level1Result): string => (r.outcome === "passed" ? "" : r.reason);

describe("[B] Level 1 (C3)", () => {
  it("[[interface-level1]] Level 1: hash before any other request, entries give the commitment, listed files only, sizes and sha256, compiler vs package.json", async () => {
    const bundle = loadFixtureBundle();
    const committed = commitmentOf(bundle);

    // --- the valid bundle passes, exactly as the reference verifier concluded ------------------
    const ok = await run(bundle);
    expect(verdict("valid").l1).toMatchObject({ ok: true, hashOk: true, indexOk: true, filesOk: true, compilerOk: true });
    expect(ok.result.outcome).toBe("passed");
    expect(ok.result.steps).toEqual({ hashOk: true, indexOk: true, filesOk: true, compilerOk: true });
    if (ok.result.outcome !== "passed") throw new Error("unreachable");
    expect(ok.result.computed).toBe(committed.toString("hex"));
    expect(ok.result.index).toMatchObject({ url: URL, files: 10, hash: committed.toString("hex"), compiler: { name: "compactc", version: "0.34.0" } });
    expect(ok.result.index.sha256).toBe(sha256Hex(bundle.get("index.json")!));
    // Every listed file, and nothing else — not even index.json among the files; one request each.
    const listed = [...bundle.keys()].filter((p) => p !== "index.json").sort();
    expect([...ok.result.files.keys()].sort()).toEqual(listed);
    expect(ok.result.requests).toBe(1 + listed.length);
    expect(ok.transport.requests.map((r) => r.url)).toEqual([URL, ...ok.result.entries.map((f) => fileUrl(URL, f.path))]);
    // Each file is fetched under its DECLARED size as cap; the index under the index limit.
    expect(ok.transport.requests[0]!.cap).toBe(DEFAULT_LEVEL1_LIMITS.maxIndexBytes);
    for (const [i, f] of ok.result.entries.entries()) expect(ok.transport.requests[i + 1]!.cap).toBe(f.size);
    // Unlisted files on the host are never requested.
    const noisy = serve(new Map([...bundle, ["node_modules/evil/index.js", Buffer.from("x")], ["index.html", Buffer.from("<p>")]]));
    const withNoise = await run(bundle, { transport: noisy });
    expect(withNoise.result.outcome).toBe("passed");
    expect(noisy.requests.some((r) => r.url.includes("node_modules") || r.url.endsWith("index.html"))).toBe(false);

    // --- wrong hash: failed at L1 with NO second request (US1 scenario 3) ----------------------
    const wrong = wrongHash(bundle);
    expect(sha256Hex(wrong.get("index.json")!)).toBe(verdict("wrong-hash").indexSha256);
    expect(verdict("wrong-hash").l1).toMatchObject({ ok: false, hashOk: false });
    const bad = await run(wrong, { commitment: committed });
    expect(bad.result.outcome).toBe("failed");
    expect(bad.result.steps).toEqual({ hashOk: false });
    expect(reason(bad.result)).toMatch(/hash .* is not the event's commitment/);
    expect(bad.transport.requests).toHaveLength(1);
    expect(bad.transport.requests[0]!.url).toBe(URL);
    // The event commits to something else entirely: the same.
    const other = await run(bundle, { commitment: Buffer.alloc(32, 0x42) });
    expect(other.result.outcome).toBe("failed");
    expect(other.transport.requests).toHaveLength(1);

    // --- entries that do not give the hash (hash copied from the event, one sha256 changed) -----
    const index = JSON.parse(bundle.get("index.json")!.toString("utf8"));
    index.files[0].sha256 = "00".repeat(32);
    const forged = clone(bundle);
    forged.set("index.json", Buffer.from(JSON.stringify(index)));
    const forgedRun = await run(forged, { commitment: committed });
    expect(forgedRun.result.outcome).toBe("failed");
    expect(forgedRun.result.steps).toEqual({ hashOk: true, indexOk: false });
    expect(reason(forgedRun.result)).toMatch(/entries give [0-9a-f]{64}, not its hash/);
    expect(forgedRun.transport.requests).toHaveLength(1);

    // --- a tampered listed file: failed, naming it — as the reference concluded ----------------
    const tampered = await run(tamperedFile(bundle));
    expect(verdict("tampered-file").l1).toMatchObject({ ok: false, hashOk: true, indexOk: true, file: "out/contract/index.js" });
    expect(tampered.result.outcome).toBe("failed");
    expect(tampered.result).toMatchObject({ file: "out/contract/index.js", steps: { hashOk: true, indexOk: true } });
    expect(reason(tampered.result)).toMatch(/out\/contract\/index\.js: sha256 [0-9a-f]{64} does not match its index entry/);

    // --- sizes: a shorter body, and a body longer than declared, both fail on that file --------
    const short = serve(bundle);
    short.overrides.set(`${BASE}README.md`, bundle.get("README.md")!.subarray(0, 10));
    const shortRun = await run(bundle, { transport: short });
    expect(shortRun.result).toMatchObject({ outcome: "failed", file: "README.md" });
    expect(reason(shortRun.result)).toMatch(/README\.md: 10 bytes, index\.json says 2804/);
    const long = serve(bundle);
    long.overrides.set(`${BASE}README.md`, Buffer.concat([bundle.get("README.md")!, Buffer.from("x")]));
    const longRun = await run(bundle, { transport: long });
    expect(longRun.result).toMatchObject({ outcome: "failed", file: "README.md" });
    expect(reason(longRun.result)).toMatch(/serves more than the 2804 bytes index\.json declares/);

    // --- index.json that is not an index: failed, nothing else requested ------------------------
    for (const body of ["not json", "[]", '{"bundle":"v1"}', "\u{feff}{}"]) {
      const t = serve(bundle);
      t.overrides.set(URL, Buffer.from(body));
      const r = await run(bundle, { transport: t });
      expect(r.result.outcome, body).toBe("failed");
      expect(r.result, body).toMatchObject({ file: "index.json" });
      expect(t.requests, body).toHaveLength(1);
    }

    // --- compiler: index.json's (not committed) against the committed package.json -------------
    // A coherent bundle naming 0.33.0 passes Level 1 (the reference agrees); Level 3 decides later.
    const old = compiler033(bundle);
    expect(sha256Hex(old.get("index.json")!)).toBe(verdict("compiler-0.33.0").indexSha256);
    expect(verdict("compiler-0.33.0").l1.ok).toBe(true);
    expect((await run(old)).result.outcome).toBe("passed");
    // index.json says 0.34.0 but the committed package.json pins 0.33.0: failed at the last step.
    const mismatch = clone(old);
    const idx = JSON.parse(mismatch.get("index.json")!.toString("utf8"));
    idx.compiler.version = "0.34.0";
    mismatch.set("index.json", Buffer.from(`${JSON.stringify(idx, null, 2)}\n`));
    const mm = await run(mismatch);
    expect(mm.result).toMatchObject({ outcome: "failed", steps: { hashOk: true, indexOk: true, filesOk: true, compilerOk: false } });
    expect(reason(mm.result)).toMatch(/index\.json names compiler compactc 0\.34\.0, but the bundle's package\.json pins compactc 0\.33\.0/);
    // No package.json listed, or one that names no compiler: failed.
    const noPkg = new Map([...bundle].filter(([p]) => p !== "package.json"));
    const noPkgIndex = JSON.parse(bundle.get("index.json")!.toString("utf8"));
    noPkgIndex.files = noPkgIndex.files.filter((f: { path: string }) => f.path !== "package.json");
    expect(compilerProblem(noPkgIndex.compiler, noPkg)).toMatch(/package\.json is not listed/);
    expect(compilerProblem(idx.compiler, new Map([["package.json", Buffer.from('{"compact":{}}')]]))).toMatch(/does not name the compiler \(package\.json compact\.compiler is missing/);
    expect(compilerProblem(idx.compiler, new Map([["package.json", Buffer.from("{nope")]]))).toMatch(/does not name the compiler \(not JSON/);
    // (The reference writer cannot even write index.json for such a bundle: compilerOf refuses.)
    expect(() => withPackage(bundle, (pkg) => { delete pkg.compact.compiler; })).toThrow(/compact\.compiler is missing/);

    // --- this indexer's limits: unchecked, never failed, and nothing past index.json requested --
    const limited = async (limits: Partial<typeof DEFAULT_LEVEL1_LIMITS>) => run(bundle, { limits: { ...DEFAULT_LEVEL1_LIMITS, ...limits } });
    const tinyIndex = await limited({ maxIndexBytes: 100 });
    expect(tinyIndex.result).toMatchObject({ outcome: "unchecked", file: "index.json" });
    expect(reason(tinyIndex.result)).toMatch(/larger than the 100-byte limit/);
    const fewFiles = await limited({ maxFiles: 5 });
    expect(fewFiles.result).toMatchObject({ outcome: "unchecked", computed: committed.toString("hex") });
    expect(reason(fewFiles.result)).toMatch(/lists 10 files, over the 5-file limit/);
    expect(fewFiles.transport.requests).toHaveLength(1);
    const smallFile = await limited({ maxFileBytes: 10_000 });
    expect(smallFile.result).toMatchObject({ outcome: "unchecked", file: "out/contract/index.js" });
    expect(reason(smallFile.result)).toMatch(/declared as 23322 bytes, over the 10000-byte per-file limit/);
    expect(smallFile.transport.requests).toHaveLength(1);
    const smallBundle = await limited({ maxBundleBytes: 30_000 });
    expect(smallBundle.result.outcome).toBe("unchecked");
    expect(reason(smallBundle.result)).toMatch(/over the 30000-byte bundle limit/);
    expect(smallBundle.transport.requests).toHaveLength(1);
    // The hash is still compared first: a wrong hash is failed even when a limit would stop it.
    expect((await run(wrong, { commitment: committed, limits: { ...DEFAULT_LEVEL1_LIMITS, maxFiles: 1 } })).result.outcome).toBe("failed");

    // --- the transport's own answers pass through: unreachable / unchecked / unfetchable ---------
    // A listed file the host does not serve: the host did not deliver — unreachable (C9, owner Q25),
    // naming the file, after the index checks passed; never failed.
    const missing = serve(new Map([...bundle].filter(([p]) => p !== "out/keys/read.verifier")));
    const missingRun = await run(bundle, { transport: missing });
    expect(missingRun.result).toMatchObject({ outcome: "unreachable", file: "out/keys/read.verifier", steps: { hashOk: true, indexOk: true } });
    expect(missingRun.result.steps.filesOk).toBeUndefined();
    expect(reason(missingRun.result)).toMatch(/HTTP 404/);
    // index.json itself not delivered (a refused connection): unreachable, nothing else requested.
    const down = serve(bundle);
    down.overrides.set(URL, new TransportError("unreachable", `could not fetch ${URL}: ECONNREFUSED`));
    const downRun = await run(bundle, { transport: down });
    expect(downRun.result).toMatchObject({ outcome: "unreachable", file: "index.json", requests: 1, steps: {} });
    expect(down.requests).toHaveLength(1);
    const slow = serve(bundle);
    slow.overrides.set(`${BASE}out/contract/index.js`, new TransportError("unchecked", "the 120000 ms deadline was reached"));
    expect((await run(bundle, { transport: slow })).result).toMatchObject({ outcome: "unchecked", file: "out/contract/index.js" });
    const refused = serve(bundle);
    refused.overrides.set(URL, new TransportError("unfetchable", "127.0.0.1 is a loopback address"));
    expect((await run(bundle, { transport: refused })).result).toMatchObject({ outcome: "unfetchable", file: "index.json" });
    // Anything else a transport throws is a bug, not a verdict: it propagates.
    const broken = serve(bundle);
    broken.overrides.set(URL, new RangeError("boom"));
    await expect(run(bundle, { transport: broken })).rejects.toThrow(RangeError);
    expect(new BodyTooLargeError(5, "x").cap).toBe(5);
    expect(fileUrl(URL, "out/keys/a%3F.verifier")).toBe(`${BASE}out/keys/a%253F.verifier`);
  });
});
