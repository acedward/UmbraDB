import { createHash } from "node:crypto";
import { jubjub, jubjub_findGroupHash } from "@noble/curves/misc.js";

/**
 * Project 00024-02 task C3 — [B]'s bundle commitment (`ecmh-jubjub-grouphash`) and its `index.json`
 * rules, ported from the reference module the MIP names ("The pinned reference module defines the
 * profile and contains its implementation details": `src/hash.mjs` of
 * `acedward/public-interfaces-for-compact-contracts`, unchanged from `1879be5` to PR #6 `1cf9477`).
 * Provenance and every difference: `./SOURCE.md`. [B]'s own vectors (`test/hash.test.mjs`) are
 * `[[interface-commitment-vectors]]`; its index table is `[[interface-index-rules]]`.
 *
 * ```
 *   P(path, file) = FindGroupHash(sha256(utf8(path)) ‖ sha256(file), "COC_B_v1")   (Sapling GroupHash, BLAKE2s)
 *   C             = O + P(entry_1) + … + P(entry_n)                              (Jubjub, O = identity)
 *   commitment    = C.toBytes()   32 bytes: y little-endian, top bit = x mod 2   (Zcash repr_J)
 * ```
 * Addition is commutative, so the order of entries does not matter; a repeated entry counts (a
 * multiset), which is why an index listing a path twice is refused. `index.json` itself is never
 * listed, so neither its `hash` nor its `compiler` is covered by the commitment — Level 1 checks
 * both and trusts neither (`level1.ts`).
 *
 * Nothing here reads a file or the network: every function takes bytes or parsed JSON.
 */

/** The index document's name at the bundle root. It never lists itself. */
export const INDEX_FILE = "index.json";
/** The two format tags every `[v1]` index carries. */
export const INDEX_FORMAT = Object.freeze({ bundle: "v1", commitment: "ecmh-jubjub-grouphash" });
/** BLAKE2s personalization of the entry hash: exactly 8 ASCII bytes. */
export const PERSONALIZATION = "COC_B_v1";
/** The only compiler an index names: the one whose output Level 3 reproduces. */
export const COMPILER_NAME = "compactc";

const PERS_BYTES = new TextEncoder().encode(PERSONALIZATION);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export const sha256 = (bytes: Uint8Array): Buffer => createHash("sha256").update(bytes).digest();
export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** A point of the Jubjub curve (noble's Edwards point). */
export type JubjubPoint = ReturnType<typeof jubjub_findGroupHash>;

/** The identity: the commitment to an empty set of files. */
export const IDENTITY: JubjubPoint = jubjub.Point.ZERO;

/** P(path, file): the curve point of one index entry. */
export function entryPoint(path: string, sha256hex: string): JubjubPoint {
  if (typeof path !== "string") throw new TypeError("entry path must be a string");
  if (!SHA256_HEX.test(sha256hex)) {
    throw new TypeError(`entry sha256 must be 64 lowercase hex digits, got ${JSON.stringify(sha256hex)}`);
  }
  const message = Buffer.concat([sha256(Buffer.from(path, "utf8")), Buffer.from(sha256hex, "hex")]);
  return jubjub_findGroupHash(Uint8Array.from(message), PERS_BYTES);
}

/** C over `[path, sha256hex]` entries, as a curve point. */
export function commitmentPoint(entries: readonly (readonly [string, string])[]): JubjubPoint {
  let c = IDENTITY;
  for (const [path, sha] of entries) c = c.add(entryPoint(path, sha));
  return c;
}

/** C with one more entry. */
export const addEntry = (c: JubjubPoint, path: string, sha256hex: string): JubjubPoint => c.add(entryPoint(path, sha256hex));

/** C with one entry taken out: C + (−P(entry)). */
export const removeEntry = (c: JubjubPoint, path: string, sha256hex: string): JubjubPoint =>
  c.add(entryPoint(path, sha256hex).negate());

/** The 32-byte encoding: little-endian y, top bit = x mod 2 (Zcash `repr_J`). */
export const encodePoint = (point: JubjubPoint): Buffer => Buffer.from(point.toBytes());

// ── index.json ──────────────────────────────────────────────────────────────────────────────

export interface IndexFile {
  path: string;
  sha256: string;
  size: number;
}

export interface CompilerId {
  name: string;
  version: string;
  flags?: string[];
}

export interface BundleIndex {
  bundle: string;
  commitment: string;
  hash: string;
  compiler: CompilerId;
  files: IndexFile[];
}

/** An index that breaks the format or the path rules. Level 1 fails on it. */
export class IndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexError";
  }
}

/**
 * Why `path` may not appear in an index, or null. A relative `/`-separated path whose segments are
 * printable ASCII (0x21–0x7e), with no empty, `.` or `..` segment, no backslash, no `node_modules`
 * segment, and never `index.json` itself.
 */
export function pathProblem(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) return "is not a non-empty string";
  if (path.startsWith("/")) return "is absolute (leading /)";
  if (path.includes("\\")) return "contains a backslash";
  for (const seg of path.split("/")) {
    if (seg === "") return "has an empty segment";
    if (seg === "." || seg === "..") return `has a '${seg}' segment`;
    if (seg === "node_modules") return "has a node_modules segment";
    if (!/^[\x21-\x7e]+$/.test(seg)) return "has a character outside printable ASCII (0x21-0x7e)";
  }
  if (path === INDEX_FILE) return "is index.json itself";
  return null;
}

/**
 * A value for an error message: JSON, cut at 80 characters. The value comes from an untrusted
 * `index.json`: `JSON.stringify` recurses, so a deeply nested value (which `JSON.parse` accepts) would
 * overflow the stack and turn a clean Level 1 failure into a crash — it is described by its type
 * instead (the 01-D audit's F2 class). [B]'s reference has no such guard.
 */
const show = (v: unknown): string => {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = Array.isArray(v) ? "[an array too deeply nested to show]" : `[${typeof v} too deeply nested to show]`;
  }
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new IndexError(`${where} has unknown field(s) ${extra.map(show).join(", ")}`);
}

/** `compiler`: exactly `name` ("compactc"), `version` (x.y.z) and, only when recorded, `flags`. */
function validateCompiler(c: unknown): void {
  if (!isObject(c)) {
    throw new IndexError(`index.json "compiler" is not an object { name, version[, flags] } (it is ${c === undefined ? "missing" : show(c)})`);
  }
  onlyKeys(c, ["name", "version", "flags"], 'index.json "compiler"');
  if (c.name !== COMPILER_NAME) throw new IndexError(`index.json "compiler".name is ${show(c.name)}, expected "${COMPILER_NAME}"`);
  if (typeof c.version !== "string" || !VERSION.test(c.version)) {
    throw new IndexError(`index.json "compiler".version is ${show(c.version)}, expected a version x.y.z`);
  }
  if (c.flags !== undefined && (!Array.isArray(c.flags) || c.flags.length === 0 || c.flags.some((f) => typeof f !== "string"))) {
    throw new IndexError(`index.json "compiler".flags is ${show(c.flags)}, expected a non-empty array of strings (present only when the bundle records flags)`);
  }
}

/**
 * Checks a parsed index against the format and the path rules; returns it typed, or throws
 * {@link IndexError} naming the first problem. The FORM of `hash` and `compiler` only: whether
 * `hash` is the commitment and the chain's, and whether `compiler` matches the bundle's
 * `package.json`, Level 1 decides. The format sets no limit on the number of entries — the caller's
 * caps do (`level1.ts`).
 */
export function validateIndex(index: unknown): BundleIndex {
  if (!isObject(index)) throw new IndexError("index.json is not a JSON object");
  onlyKeys(index, ["bundle", "commitment", "hash", "compiler", "files"], "index.json");
  for (const [k, want] of Object.entries(INDEX_FORMAT)) {
    if (index[k] !== want) throw new IndexError(`index.json "${k}" is ${show(index[k])}, expected "${want}"`);
  }
  if (typeof index.hash !== "string" || !SHA256_HEX.test(index.hash)) {
    throw new IndexError(`index.json "hash" is ${index.hash === undefined ? "missing" : show(index.hash)}, expected 64 lowercase hex digits (the commitment)`);
  }
  validateCompiler(index.compiler);
  if (!Array.isArray(index.files)) throw new IndexError('index.json "files" is not an array');

  const seen = new Set<string>();
  index.files.forEach((f: unknown, i: number) => {
    const where = `files[${i}]`;
    if (!isObject(f)) throw new IndexError(`${where} is not an object`);
    onlyKeys(f, ["path", "sha256", "size"], where);
    const problem = pathProblem(f.path);
    if (problem !== null) throw new IndexError(`${where}.path ${show(f.path)} ${problem}`);
    const path = f.path as string;
    if (seen.has(path)) throw new IndexError(`${where}.path ${show(path)} is listed twice`);
    if (typeof f.sha256 !== "string" || !SHA256_HEX.test(f.sha256)) {
      throw new IndexError(`${where}.sha256 for ${path} is not 64 lowercase hex digits`);
    }
    if (!Number.isSafeInteger(f.size) || (f.size as number) < 0) {
      throw new IndexError(`${where}.size for ${path} is not a non-negative integer`);
    }
    seen.add(path);
  });
  // A directory tree cannot hold `a` as a file and `a/b` beneath it.
  for (const p of seen) {
    const parts = p.split("/");
    for (let k = 1; k < parts.length; k++) {
      const dir = parts.slice(0, k).join("/");
      if (seen.has(dir)) throw new IndexError(`${show(dir)} is listed as a file and as the directory of ${show(p)}`);
    }
  }
  return index as unknown as BundleIndex;
}

/**
 * The `compiler` a bundle's parsed `package.json` implies: compactc, the version `compact.compiler`
 * pins, and `compact.flags` when it records any. Throws {@link IndexError} when it does not say.
 */
export function compilerOf(pkg: unknown): CompilerId {
  const c = isObject(pkg) ? pkg.compact : undefined;
  if (!isObject(c)) throw new IndexError('package.json has no "compact" object');
  if (typeof c.compiler !== "string" || c.compiler === "") {
    throw new IndexError(`package.json compact.compiler is ${c.compiler === undefined ? "missing" : show(c.compiler)}, expected the compiler version`);
  }
  if (c.flags !== undefined && (!Array.isArray(c.flags) || c.flags.some((f) => typeof f !== "string"))) {
    throw new IndexError(`package.json compact.flags is ${show(c.flags)}, expected an array of strings`);
  }
  const flags = c.flags as string[] | undefined;
  return { name: COMPILER_NAME, version: c.compiler, ...(flags !== undefined && flags.length > 0 ? { flags: [...flags] } : {}) };
}

/** `compactc 0.34.0`, then any flags: how reports name a compiler. */
export const compilerText = (c: CompilerId): string => [c.name, c.version, ...(c.flags ?? [])].join(" ");

/** Whether two `compiler` values name the same compiler, version and flags (none recorded = no flags). */
export const sameCompiler = (a: CompilerId, b: CompilerId): boolean =>
  JSON.stringify([a.name, a.version, a.flags ?? []]) === JSON.stringify([b.name, b.version, b.flags ?? []]);

/** `[path, sha256hex]` for every entry of a validated index. */
export const indexEntries = (index: BundleIndex): [string, string][] => index.files.map((f) => [f.path, f.sha256]);

/** The 32-byte commitment a validated index's entries produce. */
export const indexCommitment = (index: BundleIndex): Buffer => encodePoint(commitmentPoint(indexEntries(index)));

/**
 * The index a publisher writes for a bundle held in memory (path → bytes), exactly as the
 * reference writer does (`src/hash.mjs` `buildIndex` + `writeIndex`): every file but `index.json`,
 * sorted by path (code-unit order), `hash` = the commitment, `compiler` from the bundle's own
 * `package.json`, fields in the order bundle, commitment, hash, compiler, files, serialized
 * `JSON.stringify(index, null, 2) + "\n"`. Used by the tests to derive bundle variants whose bytes
 * must equal the reference tool's; never by verification.
 */
export function buildIndexBytes(files: ReadonlyMap<string, Uint8Array>): { index: BundleIndex; bytes: Buffer } {
  const paths = [...files.keys()].filter((p) => p !== INDEX_FILE).sort();
  const entries: IndexFile[] = paths.map((p) => {
    const problem = pathProblem(p);
    if (problem !== null) throw new IndexError(`cannot publish ${show(p)}: its path ${problem}`);
    const body = files.get(p)!;
    return { path: p, sha256: sha256Hex(body), size: body.byteLength };
  });
  const pkgBytes = files.get("package.json");
  if (pkgBytes === undefined) throw new IndexError("cannot write index.json: the bundle has no package.json; it names the compiler");
  const hash = encodePoint(commitmentPoint(entries.map((f) => [f.path, f.sha256] as const))).toString("hex");
  const index = validateIndex({
    ...INDEX_FORMAT, hash, compiler: compilerOf(JSON.parse(Buffer.from(pkgBytes).toString("utf8"))), files: entries,
  });
  return { index, bytes: Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf8") };
}
