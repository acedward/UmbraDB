import {
  INDEX_FILE, IndexError, compilerOf, compilerText, indexCommitment, sameCompiler, sha256Hex, validateIndex,
  type BundleIndex,
} from "./commitment.js";

/**
 * Project 00024-02 task C3 — [B] **Level 1**: "the committed bundle file set, file identities, and
 * actual contents match the selected on-chain publication commitment" (MIP-SPEC-DRAFT.md, levels
 * table; consumer steps 2–3). A port of the reference verifier's `levelOne` (`src/verify.mjs` +
 * `src/fetch.mjs` at PR #6 `1cf9477`; provenance `./SOURCE.md`) over an injected transport, in the
 * reference's order:
 *
 *  1. obtain `index.json` from the event URL, parse it, validate it ({@link validateIndex});
 *  2. compare its `hash` with the event's commitment — on a mismatch this is not the index the
 *     contract committed to and **nothing else is requested** (spec US1 scenario 3);
 *  3. recompute the commitment from the entries; it must equal the hash (the hash is not covered);
 *  4. (this indexer's caps: file count, each declared size, the declared total — `unchecked`, never
 *     `failed`, and still nothing requested);
 *  5. obtain each LISTED file — never anything else — and check its size and sha256;
 *  6. require `index.json`'s `compiler` to match the committed `package.json`.
 *
 * ── Four kinds of "not passed" (spec US1 scenarios 3, 5, 6; FR-011; owner Q25) ─────────────────
 *  - `failed`      the bytes were obtained and do not match: a broken index, a wrong hash, an entry
 *                  set that does not give the commitment, a file with other bytes or another size
 *                  (including a body LONGER than its entry declares), a compiler mismatch;
 *  - `unchecked`   a local limit stopped the check before a conclusion (a cap, the deadline) — "a
 *                  bundle stopped by a local limit has not been checked, so report it as unchecked,
 *                  never as invalid" ([B] `src/fetch.mjs` SIZING_GUIDANCE);
 *  - `unfetchable` POLICY: the transport must not obtain the bytes (a non-http(s) URL, a private,
 *                  loopback or link-local destination) — spec US1 scenario 5;
 *  - `unreachable` DELIVERY: the host did not deliver the bytes (a name that does not resolve, a
 *                  refused or reset connection, a non-2xx answer — a listed file missing included —,
 *                  too many redirects, an unexpected `Content-Encoding`). Owner decision Q25 (UC-13):
 *                  delivery is the client's concern BEFORE the [B] levels, so no level is claimed and
 *                  the drain retries with exponential backoff; a later delivery starts at Level 1.
 * [B]'s reference reports every transport problem as a Level 1 failure; the split is this indexer's
 * policy (audit F4: policies are asserted against the spec, not compared with the reference).
 *
 * Nothing from the bundle is executed or imported here: bytes are hashed, `index.json` and
 * `package.json` are parsed as JSON data.
 */

/** Why the transport produced no bytes: a policy refusal (`unfetchable`), a local limit
 *  (`unchecked`), or a host that did not deliver (`unreachable`, owner Q25). */
export type TransportFailure = "unfetchable" | "unchecked" | "unreachable";

/** The transport could not (or must not) deliver a body. */
export class TransportError extends Error {
  constructor(readonly kind: TransportFailure, message: string) {
    super(message);
    this.name = "TransportError";
  }
}

/** The body exceeds the cap the caller gave (announced by the server, or counted while reading). */
export class BodyTooLargeError extends Error {
  constructor(readonly cap: number, message: string) {
    super(message);
    this.name = "BodyTooLargeError";
  }
}

/** How Level 1 obtains bytes. `get` returns at most `cap` bytes of body or throws one of the two
 *  errors above. The guarded HTTP transport is `fetch-guard.ts`; tests use in-memory ones. */
export interface BundleTransport {
  get(url: string, cap: number): Promise<Buffer>;
}

/** Local caps: generous upper bounds ([B] SIZING_GUIDANCE's "very high estimates"), not formats. */
export interface Level1Limits {
  /** `index.json` itself. */
  maxIndexBytes: number;
  /** Entries in `index.json`. */
  maxFiles: number;
  /** The largest single listed file (normally `out/contract/index.js`). */
  maxFileBytes: number;
  /** `index.json` plus every listed file. */
  maxBundleBytes: number;
}

export const DEFAULT_LEVEL1_LIMITS: Level1Limits = Object.freeze({
  maxIndexBytes: 256 * 1024,
  maxFiles: 1000,
  maxFileBytes: 8 * 1024 * 1024,
  maxBundleBytes: 16 * 1024 * 1024,
});

/** The steps Level 1 reached, in order, as the reference reports them. */
export interface Level1Steps {
  hashOk?: boolean;
  indexOk?: boolean;
  filesOk?: boolean;
  compilerOk?: boolean;
}

export interface IndexSummary {
  url: string;
  bytes: number;
  sha256: string;
  files: number;
  hash: string;
  compiler: BundleIndex["compiler"];
}

interface Level1Common {
  steps: Level1Steps;
  /** Requests made (index included). */
  requests: number;
  /** Body bytes obtained (index included). */
  bytes: number;
  index?: IndexSummary;
}

export interface Level1Passed extends Level1Common {
  outcome: "passed";
  index: IndexSummary;
  entries: BundleIndex["files"];
  /** Every listed file, checked: path → bytes. Nothing else. */
  files: Map<string, Buffer>;
  /** The recomputed commitment (equal to the event's). */
  computed: string;
}

export interface Level1NotPassed extends Level1Common {
  outcome: "failed" | "unchecked" | "unfetchable" | "unreachable";
  reason: string;
  /** The file at fault, when there is one. */
  file?: string;
  computed?: string;
}

export type Level1Result = Level1Passed | Level1NotPassed;

/**
 * The URL of a listed file: its path, each segment percent-encoded, resolved against the index
 * URL ([B] `fileUrl`). Encoding keeps `?`, `#`, `%` and `:` in a name from becoming a query, a
 * fragment, an escaped `..` or a scheme; the prefix check keeps the result inside the index's
 * directory. Returns null when it would not.
 */
export function fileUrl(indexUrl: string, path: string): string | null {
  const base = new URL(indexUrl);
  const url = new URL(path.split("/").map(encodeURIComponent).join("/"), base);
  const root = new URL("./", base);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) return null;
  return url.href;
}

/**
 * Why `index.json`'s `compiler` does not match the committed `package.json`, or null ([B]
 * `compilerProblem`). A `package.json` the index does not list is not part of the bundle.
 */
export function compilerProblem(compiler: BundleIndex["compiler"], files: ReadonlyMap<string, Buffer>): string | null {
  const unchecked = "so index.json's compiler cannot be checked against it";
  const pkg = files.get("package.json");
  if (pkg === undefined) return `package.json is not listed in index.json, ${unchecked}`;
  let pinned;
  try {
    pinned = compilerOf(JSON.parse(pkg.toString("utf8")));
  } catch (error) {
    const why = error instanceof SyntaxError ? `not JSON: ${error.message}` : (error as Error).message;
    return `the bundle's package.json does not name the compiler (${why}), ${unchecked}`;
  }
  if (sameCompiler(compiler, pinned)) return null;
  return `index.json names compiler ${compilerText(compiler)}, but the bundle's package.json pins ${compilerText(pinned)}`;
}

/** Runs Level 1 for one publication. Never throws for a check that does not pass. */
export async function levelOne(
  input: { url: string; commitment: Uint8Array },
  transport: BundleTransport,
  limits: Level1Limits = DEFAULT_LEVEL1_LIMITS,
): Promise<Level1Result> {
  const steps: Level1Steps = {};
  const common: Level1Common = { steps, requests: 0, bytes: 0 };
  const committed = Buffer.from(input.commitment).toString("hex");
  const stop = (outcome: Level1NotPassed["outcome"], reason: string, extra: Partial<Level1NotPassed> = {}): Level1NotPassed =>
    ({ ...common, outcome, reason, ...extra });

  // 1. index.json — capped by its own limit and by the whole bundle's.
  const indexCap = Math.min(limits.maxIndexBytes, limits.maxBundleBytes);
  let raw: Buffer;
  common.requests++;
  try {
    raw = await transport.get(input.url, indexCap);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return stop("unchecked", `${INDEX_FILE} is larger than the ${indexCap}-byte limit (${error.message}); nothing else was fetched`, { file: INDEX_FILE });
    }
    if (error instanceof TransportError) return stop(error.kind, `${INDEX_FILE}: ${error.message}`, { file: INDEX_FILE });
    throw error;
  }
  common.bytes += raw.length;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    return stop("failed", `index.json is not valid JSON: ${(error as Error).message}`, { file: INDEX_FILE });
  }
  let index: BundleIndex;
  try {
    index = validateIndex(parsed);
  } catch (error) {
    if (error instanceof IndexError) return stop("failed", error.message, { file: INDEX_FILE });
    throw error;
  }
  const summary: IndexSummary = {
    url: input.url, bytes: raw.length, sha256: sha256Hex(raw), files: index.files.length,
    hash: index.hash, compiler: index.compiler,
  };
  common.index = summary;

  // 2. hash before anything else is requested.
  steps.hashOk = index.hash === committed;
  if (!steps.hashOk) {
    return stop("failed", `index.json's hash ${index.hash} is not the event's commitment: this is not the index the contract committed to`, { file: INDEX_FILE });
  }

  // 3. the entries must give the commitment (`hash` itself is not covered by it). The
  //    index is at most `maxIndexBytes`, so its entry count — and this group hashing, ~0.35 ms per
  //    entry — is bounded before any cap below.
  const computed = indexCommitment(index).toString("hex");
  steps.indexOk = computed === committed;
  if (!steps.indexOk) {
    return stop("failed", `index.json's entries give ${computed}, not its hash (the event's commitment): this is not the index the contract committed to`, { file: INDEX_FILE, computed });
  }

  // 4. this indexer's caps — still nothing requested.
  if (index.files.length > limits.maxFiles) {
    return stop("unchecked", `index.json lists ${index.files.length} files, over the ${limits.maxFiles}-file limit; nothing else was fetched`, { computed });
  }
  const oversize = index.files.find((f) => f.size > limits.maxFileBytes);
  if (oversize !== undefined) {
    return stop("unchecked", `${oversize.path} is declared as ${oversize.size} bytes, over the ${limits.maxFileBytes}-byte per-file limit; nothing else was fetched`, { file: oversize.path, computed });
  }
  const declared = index.files.reduce((n, f) => n + f.size, 0);
  if (raw.length + declared > limits.maxBundleBytes) {
    return stop("unchecked", `index.json declares ${declared} bytes of files (${raw.length + declared} with the index), over the ${limits.maxBundleBytes}-byte bundle limit; nothing else was fetched`, { computed });
  }

  // 5. every listed file, and only those.
  const files = new Map<string, Buffer>();
  for (const f of index.files) {
    const url = fileUrl(input.url, f.path);
    if (url === null) return stop("failed", `${f.path}: resolves outside the bundle's directory`, { file: f.path, computed });
    let body: Buffer;
    common.requests++;
    try {
      body = await transport.get(url, f.size);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return stop("failed", `${f.path}: the host serves more than the ${f.size} bytes index.json declares`, { file: f.path, computed });
      }
      if (error instanceof TransportError) return stop(error.kind, `${f.path}: ${error.message}`, { file: f.path, computed });
      throw error;
    }
    common.bytes += body.length;
    if (body.length !== f.size) return stop("failed", `${f.path}: ${body.length} bytes, index.json says ${f.size}`, { file: f.path, computed });
    const got = sha256Hex(body);
    if (got !== f.sha256) return stop("failed", `${f.path}: sha256 ${got} does not match its index entry ${f.sha256}`, { file: f.path, computed });
    files.set(f.path, body);
  }
  steps.filesOk = true;

  // 6. index.json's compiler (not covered by the commitment) against the committed package.json.
  const problem = compilerProblem(index.compiler, files);
  steps.compilerOk = problem === null;
  if (problem !== null) return stop("failed", problem, { file: INDEX_FILE, computed });

  return { ...common, outcome: "passed", index: summary, entries: index.files, files, computed };
}
