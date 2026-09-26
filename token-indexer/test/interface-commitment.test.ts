import { createHash, randomInt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { jubjub, jubjub_findGroupHash } from "@noble/curves/misc.js";
import {
  COMPILER_NAME, IDENTITY, INDEX_FORMAT, IndexError, PERSONALIZATION, addEntry, buildIndexBytes, commitmentPoint,
  compilerOf, compilerText, encodePoint, entryPoint, indexCommitment, indexEntries, pathProblem, removeEntry,
  sameCompiler, validateIndex, type BundleIndex,
} from "../interface/commitment.js";
import { commitmentOf, compiler033, loadFixtureBundle, sha256Hex, verdict } from "./helpers/pi-fixture.js";

/**
 * Project 00024-02 task C3 — the `ecmh-jubjub-grouphash` commitment and the `index.json` rules,
 * checked against [B]'s OWN vectors and table (`test/hash.test.mjs` of
 * `acedward/public-interfaces-for-compact-contracts` @ PR #6 `1cf9477`; every expected value below
 * is copied from it) and against bytes the reference TOOL wrote (`fixtures/interfaces/pi-fixture/`).
 */

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const enc = (pt: ReturnType<typeof entryPoint>): string => encodePoint(pt).toString("hex");
const shuffle = <T>(xs: readonly T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
};

/** [B]'s realistic entry set: the NFT example bundle's paths, made-up contents. */
const ENTRIES: [string, string][] = [
  "README.md", "package.json", "out/compiler/contract-info.json", "out/contract/index.d.ts", "out/contract/index.js",
  "out/contract/package.json", "out/keys/balanceOf.verifier", "out/keys/name.verifier", "out/keys/ownerOf.verifier",
  "out/keys/symbol.verifier", "out/keys/tokenURI.verifier", "src/compact/OffChainInterface.compact",
  "src/compact-examples/openzeppelin/NonFungibleTokenReadable.Interface.compact",
  "src/compact-examples/openzeppelin/NonFungibleTokenReadable.compact",
  "src/compact-examples/openzeppelin/vendor/token/NonFungibleToken.compact", "src/compact-examples/openzeppelin/vendor/utils/Utils.compact",
].map((p) => [p, sha(`contents of ${p}`)]);

describe("[B] commitment and index rules (C3)", () => {
  it("[[interface-commitment-vectors]] ecmh-jubjub-grouphash reproduces [B]'s vectors and the reference tool's bytes", () => {
    // --- the entry point: Zcash Sapling GroupHash on Jubjub ------------------------------------
    // Known answer: Zcash's spend-authorization generator.
    const g = jubjub_findGroupHash(new Uint8Array(0), new TextEncoder().encode("Zcash_G_"));
    expect(hex(g.toBytes())).toBe("30b5f2aaad325630bcdddbce4d67656d05fd1cc2d037bb5375b6e96d9e01a1d7");
    // FindGroupHash(sha256(path) ‖ sha256(file), "COC_B_v1"), by hand.
    expect(PERSONALIZATION).toBe("COC_B_v1");
    expect(Buffer.byteLength(PERSONALIZATION, "ascii")).toBe(8);
    const [path4, sha4] = ENTRIES[4]!;
    const message = Buffer.concat([createHash("sha256").update(path4, "utf8").digest(), Buffer.from(sha4, "hex")]);
    expect(message).toHaveLength(64);
    expect(entryPoint(path4, sha4).equals(jubjub_findGroupHash(Uint8Array.from(message), new TextEncoder().encode("COC_B_v1")))).toBe(true);
    // Deterministic, torsion-free, never the identity; depends on the path and the file separately.
    for (const [p, s] of ENTRIES) {
      const pt = entryPoint(p, s);
      expect(pt.equals(entryPoint(p, s))).toBe(true);
      expect(pt.isTorsionFree()).toBe(true);
      expect(pt.equals(IDENTITY)).toBe(false);
    }
    const [p0, s0] = ENTRIES[0]!;
    expect(entryPoint(p0, s0).equals(entryPoint(`${p0}x`, s0))).toBe(false);
    expect(entryPoint(p0, s0).equals(entryPoint(p0, sha("other")))).toBe(false);
    // A malformed file hash is refused rather than hashed.
    expect(() => entryPoint("a", "ABCD")).toThrow(/64 lowercase hex/);
    expect(() => entryPoint("a", sha("a").toUpperCase())).toThrow(/64 lowercase hex/);

    // --- the commitment: [B]'s pinned vector over a.txt and b.txt --------------------------------
    const ab: [string, string][] = [["a.txt", sha("a")], ["b.txt", sha("b")]];
    expect(ab[0]![1]).toBe("ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
    expect(ab[1]![1]).toBe("3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d");
    expect(enc(commitmentPoint(ab))).toBe("05b4ba14c6002f9df93c6267467e53c43b3320338b08ccae389a67add3a9f032");
    expect(enc(entryPoint(...ab[0]!))).toBe("121384346975cb046459197d60aff974ccd207da9364c67650e5ec7db7003401");
    expect(enc(entryPoint(...ab[1]!))).toBe("d464da7045b218972a8c990470cf4c5db11d0a5c4fdf48398fd76fe4dda691ef");
    // The empty set is the identity, encoded 01 then 31 zero bytes.
    expect(commitmentPoint([]).equals(jubjub.Point.ZERO)).toBe(true);
    expect(enc(commitmentPoint([]))).toBe(`01${"00".repeat(31)}`);
    // Order does not matter (50 random orders).
    const C = commitmentPoint(ENTRIES);
    const want = enc(C);
    let same = 0;
    for (let i = 0; i < 50; i++) if (enc(commitmentPoint(shuffle(ENTRIES))) === want) same++;
    expect(same).toBe(50);
    // Incremental: adding and removing one entry is one point addition.
    const extra: [string, string] = ["out/keys/newCircuit.verifier", sha("a new circuit key")];
    expect(addEntry(C, ...extra).equals(commitmentPoint([...ENTRIES, extra]))).toBe(true);
    expect(removeEntry(C, ...ENTRIES[3]!).equals(commitmentPoint(ENTRIES.filter((_, i) => i !== 3)))).toBe(true);
    expect(removeEntry(addEntry(C, ...extra), ...extra).equals(C)).toBe(true);
    // Any changed, renamed, added or dropped file changes it; a repeated entry counts (multiset).
    const flip = (s: string): string => s.slice(0, -1) + (s.at(-1) === "0" ? "1" : "0");
    for (let i = 0; i < ENTRIES.length; i++) {
      expect(enc(commitmentPoint(ENTRIES.map(([p, s], j) => (j === i ? [p, flip(s)] : [p, s]) as [string, string])))).not.toBe(want);
    }
    expect(enc(commitmentPoint(ENTRIES.map(([p, s], j) => (j === 0 ? ["README.txt", s] : [p, s]) as [string, string])))).not.toBe(want);
    expect(enc(commitmentPoint([...ENTRIES, ["index.html", sha("<html>")]]))).not.toBe(want);
    expect(enc(commitmentPoint(ENTRIES.slice(1)))).not.toBe(want);
    expect(enc(commitmentPoint([...ENTRIES, ENTRIES[0]!]))).not.toBe(want);
    // 32 bytes: little-endian y, top bit = x mod 2; decodable; a negation differs in that bit only.
    const bytes = encodePoint(C);
    expect(bytes).toHaveLength(32);
    const le = [...bytes].reverse().reduce((n, b) => (n << 8n) | BigInt(b), 0n);
    expect(le & ((1n << 255n) - 1n)).toBe(C.y);
    expect(le >> 255n).toBe(C.x & 1n);
    expect(jubjub.Point.fromBytes(bytes).equals(C)).toBe(true);
    const neg = encodePoint(C.negate());
    expect(neg.subarray(0, 31).equals(bytes.subarray(0, 31))).toBe(true);
    expect(neg[31]! ^ bytes[31]!).toBe(0x80);

    // --- against bytes the reference TOOL wrote (patched [B] tools, mip-public-interfaces c47e64e) --
    const bundle = loadFixtureBundle();
    const written = JSON.parse(bundle.get("index.json")!.toString("utf8")) as BundleIndex;
    expect(written.hash).toBe(verdict("valid").indexHash);
    expect(indexCommitment(validateIndex(written)).toString("hex")).toBe(written.hash);
    expect(commitmentOf(bundle).toString("hex")).toBe("bb0a01afa52f34f3ef21294ad1829ee6f4f8618294f5eb36481657740b0373d2");
    // This port's writer produces the reference writer's index.json byte for byte — for the bundle
    // as published and for the rebuilt compiler-0.33.0 variant.
    const rebuilt = buildIndexBytes(bundle);
    expect(sha256Hex(rebuilt.bytes)).toBe(verdict("valid").indexSha256);
    expect(rebuilt.bytes.equals(bundle.get("index.json")!)).toBe(true);
    expect(sha256Hex(compiler033(bundle).get("index.json")!)).toBe(verdict("compiler-0.33.0").indexSha256);
  });

  it("[[interface-index-rules]] index.json and path rules: [B]'s table, accepted and refused", () => {
    // --- path rules (deployer and consumer) ---------------------------------------------------
    for (const ok of ["README.md", "out/keys/tokenURI.verifier", "src/a-b_c.d~!$&()*+,;=@[]^{|}", "out/index.json", "a/b/c/d/e"]) {
      expect(pathProblem(ok), ok).toBeNull();
    }
    for (const [bad, why] of [
      ["", /non-empty/], ["/etc/passwd", /absolute/], ["a\\b", /backslash/], ["a//b", /empty segment/], ["a/", /empty segment/],
      ["./a", /'\.' segment/], ["a/./b", /'\.' segment/], ["../x", /'\.\.' segment/], ["a/../../x", /'\.\.' segment/],
      ["node_modules/x/index.js", /node_modules/], ["out/node_modules/x", /node_modules/], ["a b", /printable ASCII/],
      ["café.txt", /printable ASCII/], ["tab\there", /printable ASCII/], ["index.json", /index\.json itself/],
    ] as const) {
      expect(pathProblem(bad), JSON.stringify(bad)).toMatch(why);
    }
    expect(pathProblem(42)).toMatch(/non-empty string/);

    // --- index.json -------------------------------------------------------------------------
    const files: [string, string][] = [
      ["README.md", "hello\n"],
      ["package.json", '{ "compact": { "compiler": "0.34.0", "language": "0.26.0", "runtime": "0.19.0", "interface": "src/Thing.compact" } }\n'],
      ["out/keys/a.verifier", "AAAA"],
      ["out/contract/index.js", "export const x = 1;\n"],
      ["src/Thing.compact", "pragma language_version >= 0.23.0;\n"],
    ];
    const HASH = enc(commitmentPoint(files.map(([p, c]) => [p, sha(c)])));
    const good = (): Record<string, any> => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
      ...INDEX_FORMAT, hash: HASH, compiler: { name: "compactc", version: "0.34.0" },
      files: files.map(([path, c]) => ({ path, sha256: sha(c), size: Buffer.byteLength(c) })),
    });
    // The commitment does not depend on the order the index lists files in.
    const a = good();
    const reversed = { ...a, files: [...a.files].reverse() };
    expect(indexCommitment(validateIndex(a)).toString("hex")).toBe(HASH);
    expect(indexCommitment(validateIndex(a)).equals(indexCommitment(validateIndex(reversed)))).toBe(true);
    expect(indexEntries(validateIndex(reversed))[0]).toEqual([reversed.files[0].path, reversed.files[0].sha256]);
    // The writer lists every file but itself, sorted, with no runtime field.
    const built = buildIndexBytes(new Map(files.map(([p, c]) => [p, Buffer.from(c)])));
    expect(Object.keys(JSON.parse(built.bytes.toString("utf8")))).toEqual(["bundle", "commitment", "hash", "compiler", "files"]);
    expect(built.index.hash).toBe(HASH);
    expect(built.index.files.map((f) => f.path)).toEqual([...files.map(([p]) => p)].sort());
    expect(() => buildIndexBytes(new Map([["package.json", Buffer.from(files[1]![1])], ["with space.txt", Buffer.from("x")]]))).toThrow(/printable ASCII/);
    expect(() => buildIndexBytes(new Map([["README.md", Buffer.from("x")]]))).toThrow(/no package\.json/);

    const mutate = (fn: (i: Record<string, any>) => void): Record<string, any> => { const i = good(); fn(i); return i; }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const table: [string, unknown, RegExp][] = [
      ["not an object", [], /not a JSON object/],
      ["null", null, /not a JSON object/],
      ["wrong bundle tag", mutate((i) => { i.bundle = "v2"; }), /"bundle"/],
      ["wrong commitment tag", mutate((i) => { i.commitment = "ecmh-jubjub"; }), /"commitment"/],
      ["a runtime field (not part of this format)", mutate((i) => { i.runtime = "0.19.0"; }), /unknown field.*runtime/],
      ["no hash", mutate((i) => { delete i.hash; }), /"hash".*64 lowercase hex/],
      ["an uppercase hash", mutate((i) => { i.hash = i.hash.toUpperCase(); }), /"hash".*64 lowercase hex/],
      ["a short hash", mutate((i) => { i.hash = i.hash.slice(2); }), /"hash".*64 lowercase hex/],
      ["a 0x-prefixed hash", mutate((i) => { i.hash = `0x${i.hash.slice(2)}`; }), /"hash".*64 lowercase hex/],
      ["a hash given as bytes", mutate((i) => { i.hash = [...Buffer.from(i.hash, "hex")]; }), /"hash".*64 lowercase hex/],
      ["no compiler", mutate((i) => { delete i.compiler; }), /"compiler" is not an object/],
      ["a compiler given as a string", mutate((i) => { i.compiler = "compactc 0.34.0"; }), /"compiler" is not an object/],
      ["a compiler given as an array", mutate((i) => { i.compiler = ["compactc", "0.34.0"]; }), /"compiler" is not an object/],
      ["another compiler name", mutate((i) => { i.compiler.name = "compact"; }), /"compiler"\.name .*expected "compactc"/],
      ["a compiler without a name", mutate((i) => { delete i.compiler.name; }), /"compiler"\.name .*expected "compactc"/],
      ["a compiler without a version", mutate((i) => { delete i.compiler.version; }), /"compiler"\.version .*x\.y\.z/],
      ["a two-part version", mutate((i) => { i.compiler.version = "0.34"; }), /"compiler"\.version .*x\.y\.z/],
      ["a v-prefixed version", mutate((i) => { i.compiler.version = "v0.34.0"; }), /"compiler"\.version .*x\.y\.z/],
      ["a version with a suffix", mutate((i) => { i.compiler.version = "0.34.0 (compact 0.5.1)"; }), /"compiler"\.version .*x\.y\.z/],
      ["a version given as a number", mutate((i) => { i.compiler.version = 0.34; }), /"compiler"\.version .*x\.y\.z/],
      ["an unknown compiler field", mutate((i) => { i.compiler.language = "0.26.0"; }), /"compiler" has unknown field.*language/],
      ["compiler flags that are not an array", mutate((i) => { i.compiler.flags = "--feature-zkir-v3"; }), /"compiler"\.flags .*non-empty array of strings/],
      ["an empty flags array", mutate((i) => { i.compiler.flags = []; }), /"compiler"\.flags .*non-empty array of strings/],
      ["a flag that is not a string", mutate((i) => { i.compiler.flags = ["--feature-zkir-v3", 3]; }), /"compiler"\.flags .*non-empty array of strings/],
      ["files not an array", mutate((i) => { i.files = {}; }), /not an array/],
      ["an entry that is not an object", mutate((i) => { i.files.push("README.md"); }), /not an object/],
      ["an unknown entry field", mutate((i) => { i.files[0].mode = 0o644; }), /unknown field.*mode/],
      ["a ../ path", mutate((i) => { i.files[0].path = "../../etc/passwd"; }), /'\.\.' segment/],
      ["an absolute path", mutate((i) => { i.files[0].path = "/etc/passwd"; }), /absolute/],
      ["a node_modules path", mutate((i) => { i.files[0].path = "node_modules/@midnight-ntwrk/compact-runtime/index.js"; }), /node_modules/],
      ["index.json listed in itself", mutate((i) => { i.files[0].path = "index.json"; }), /index\.json itself/],
      ["a duplicate path", mutate((i) => { i.files.push({ ...i.files[0] }); }), /listed twice/],
      ["a file that is also a directory", mutate((i) => { i.files.push({ path: "README.md/x", sha256: sha("x"), size: 1 }); }), /as a file and as the directory/],
      ["an uppercase sha256", mutate((i) => { i.files[0].sha256 = i.files[0].sha256.toUpperCase(); }), /64 lowercase hex/],
      ["a short sha256", mutate((i) => { i.files[0].sha256 = "abcd"; }), /64 lowercase hex/],
      ["a negative size", mutate((i) => { i.files[0].size = -1; }), /non-negative integer/],
      ["a fractional size", mutate((i) => { i.files[0].size = 1.5; }), /non-negative integer/],
      ["a size given as a string", mutate((i) => { i.files[0].size = "6"; }), /non-negative integer/],
      ["a size beyond 2^53", mutate((i) => { i.files[0].size = 2 ** 53; }), /non-negative integer/],
    ];
    for (const [label, index, why] of table) {
      expect(() => validateIndex(index), label).toThrow(IndexError);
      expect(() => validateIndex(index), label).toThrow(why);
    }
    // A hostile, deeply nested value is refused with an IndexError — never a stack overflow.
    const deep = JSON.parse(`${"[".repeat(200_000)}${"]".repeat(200_000)}`);
    expect(() => validateIndex(mutate((i) => { i.bundle = deep; }))).toThrow(IndexError);
    expect(() => validateIndex(mutate((i) => { i.compiler.name = deep; }))).toThrow(/too deeply nested/);
    // Accepted: an empty file list (its commitment is the identity), recorded flags, and a hash that
    // does not match the entries (Level 1 compares it, not validation).
    const empty = validateIndex({ ...INDEX_FORMAT, hash: `01${"00".repeat(31)}`, compiler: { name: "compactc", version: "0.34.0" }, files: [] });
    expect(indexCommitment(empty).toString("hex")).toBe(`01${"00".repeat(31)}`);
    expect(() => validateIndex(mutate((i) => { i.compiler.flags = ["--feature-zkir-v3"]; }))).not.toThrow();
    expect(() => validateIndex(mutate((i) => { i.hash = "ab".repeat(32); }))).not.toThrow();

    // --- the compiler a package.json pins, and how two are compared ---------------------------
    expect(COMPILER_NAME).toBe("compactc");
    expect(compilerOf({ compact: { compiler: "0.34.0" } })).toEqual({ name: "compactc", version: "0.34.0" });
    expect(compilerOf({ compact: { compiler: "0.34.0", flags: [] } })).toEqual({ name: "compactc", version: "0.34.0" });
    expect(compilerOf({ compact: { compiler: "0.34.0", flags: ["--feature-zkir-v3"] } }))
      .toEqual({ name: "compactc", version: "0.34.0", flags: ["--feature-zkir-v3"] });
    expect(() => compilerOf({})).toThrow(/no "compact" object/);
    expect(() => compilerOf(null)).toThrow(/no "compact" object/);
    expect(() => compilerOf({ compact: {} })).toThrow(/compact\.compiler is missing/);
    expect(() => compilerOf({ compact: { compiler: "" } })).toThrow(/compact\.compiler/);
    expect(() => compilerOf({ compact: { compiler: "0.34.0", flags: "x" } })).toThrow(/compact\.flags/);
    expect(sameCompiler({ name: "compactc", version: "0.34.0" }, { name: "compactc", version: "0.34.0", flags: [] })).toBe(true);
    expect(sameCompiler({ name: "compactc", version: "0.34.0" }, { name: "compactc", version: "0.33.0" })).toBe(false);
    expect(sameCompiler({ name: "compactc", version: "0.34.0", flags: ["--feature-zkir-v3"] }, { name: "compactc", version: "0.34.0" })).toBe(false);
    expect(compilerText({ name: "compactc", version: "0.34.0", flags: ["--feature-zkir-v3"] })).toBe("compactc 0.34.0 --feature-zkir-v3");
  });
});
