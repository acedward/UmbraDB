import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { pathProblem, sha256Hex } from "./commitment.js";

/**
 * Project 00024-02 task C6 — [B] **Level 3, tried** (spec FR-013, Q7, Q13): "Trusted compilation
 * exactly reproduces the keys, generated `.js` including its operation instructions, and supporting
 * artifacts used for the named operations." A port of the reference verifier's `levelThree`
 * (`src/verify.mjs` @ PR #6 `1cf9477`; `./SOURCE.md`) under this indexer's policy:
 *
 *  - **The exact compiler the bundle names** (`package.json` `compact.compiler`, equal to
 *    `index.json`'s `compiler` — Level 1 checked it): `COMPACT_BIN compile +<version> …`, the Compact
 *    CLI's own version selection. If that version is not installed — probed with
 *    `compile +<version> --version`, which never downloads — Level 3 is `not_run` with the reason
 *    (e.g. "compiler 0.33.0 unavailable"). The reference instead compiles with whatever is installed
 *    and reports `versionMismatch`; the difference is policy (audit F4).
 *  - **Never blocks** (FR-013): a deadline (process-group kill) → `not_run`; the compiler's own
 *    environment problems (its proving parameters unavailable, killed from outside) → `not_run`;
 *    only a result about the BUNDLE is `failed`. `not_run` and `failed` never discard the event.
 *  - **Only listed files are read** (FR-013): the Level 1–checked files are written into a fresh
 *    private directory (nothing else is in it), the compile runs there with `COMPACT_PATH` removed
 *    and `--trace-search`, and it is refused when the compiler read any file outside that directory
 *    or not listed in `index.json`, or — when a listed source imports or includes a file by name —
 *    printed no trace line at all (the reference's positive control).
 *  - **Compared byte for byte**: every shipped key reproduced, no key produced that is not shipped,
 *    `out/contract/index.js` and `out/compiler/contract-info.json` reproduced. The locally generated
 *    keys are returned per circuit (FR-013: "The generated keys, per circuit, are stored with the
 *    result").
 *  - **No bundle code is executed** (FR-013b): the compiler compiles the published Compact source;
 *    nothing from the bundle is imported or run.
 */

export interface Level3Options {
  /** The Compact CLI (`COMPACT_BIN`; the local stack's indexer container carries 0.34.0). */
  compactBin: string;
  /** The compile deadline (ms); keys are generated, so a large interface takes minutes. */
  deadlineMs: number;
  /** Where the private directories are made. Default: the OS temp directory. */
  tmpRoot?: string;
  /** The version probe's deadline (ms). */
  probeTimeoutMs?: number;
  /** stdout + stderr kept from the compiler; beyond it the search trace cannot be checked. */
  maxOutputBytes?: number;
}

export const DEFAULT_LEVEL3_OPTIONS: Level3Options = Object.freeze({
  compactBin: "compact",
  deadlineMs: 30 * 60_000,
  probeTimeoutMs: 30_000,
  maxOutputBytes: 16 * 1024 * 1024,
});

/** Compiler flags a bundle may ask Level 3 to pass ([B] `LEVEL3_FLAGS`); anything else is refused. */
export const LEVEL3_FLAGS: ReadonlySet<string> = new Set(["--feature-zkir-v3"]);

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export interface Level3Row {
  item: string;
  status: "OK" | "FAIL";
  reason?: string;
}

export interface Level3Result {
  outcome: "passed" | "failed" | "not_run";
  reason?: string;
  /** The compiler asked for (`compactc <version>` + flags) and what the probe reported. */
  compiler: { version: string | null; flags: string[]; installed: string | null };
  rows: Level3Row[];
  /** The keys the local compile generated, per circuit (sha256 of each `.verifier`). */
  generatedKeys: { circuit: string; sha256: string }[];
  durationMs: number;
}

// ── the search trace (ported from the reference) ─────────────────────────────────────────────

/** One line of `compactc --trace-search`: `looking for <path>.compact...found` (or `...not found`). */
const TRACE_LINE = /^looking for (.+\.compact)\.\.\.(found|not found)$/;

/**
 * Why the files the compiler read (its `--trace-search` output) are not all inside `root` and
 * listed; null when they are ([B] `searchTraceProblem`). Import names may hold any character, a line
 * break included, so every line mentioning `looking for` or ending in `found` must be one whole trace
 * line. A `...not found` line read nothing.
 */
export function searchTraceProblem(
  stderr: string, { root, listed, realpath = realpathSync }: { root: string; listed: readonly string[]; realpath?: (p: string) => string },
): string | null {
  let realRoot: string;
  try { realRoot = realpath(root); } catch { return `the bundle directory ${JSON.stringify(root)} cannot be resolved`; }
  const allowed = new Set(listed);
  for (const line of stderr.split("\n")) {
    const m = TRACE_LINE.exec(line);
    if (m === null) {
      if (line.includes("looking for") || line.endsWith("found")) {
        return `the compiler's search trace could not be read (${JSON.stringify(line.slice(0, 160))}); an import or include name in the published source may contain a line break`;
      }
      continue;
    }
    if (m[2] !== "found") continue;
    let real: string;
    try { real = realpath(resolve(root, m[1]!)); } catch { return `the recompile read ${JSON.stringify(m[1])}, which cannot be resolved`; }
    if (!real.startsWith(realRoot + sep)) return `the recompile read ${JSON.stringify(m[1])}, which is outside the bundle`;
    const rel = relative(realRoot, real).split(sep).join("/");
    if (!allowed.has(rel)) return `the recompile read ${JSON.stringify(rel)}, which is not listed in index.json, so it is not part of the committed bundle`;
  }
  return null;
}

const IDENTIFIER = /[\p{L}\p{Nl}_$][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}_$]*/uy;
const NUMERAL = /[0-9][0-9A-Za-z_.]*/y;

/**
 * The file named by the first quoted `import`/`include` of a Compact source, or null ([B]
 * `quotedDirective`): a string whose previous word is `import`, `include` or `from`, read the way
 * compactc's lexer reads comments and strings.
 */
export function quotedDirective(text: string): string | null {
  let word: string | null = null;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") { const end = text.indexOf("\n", i); i = end < 0 ? text.length : end; continue; }
    if (c === "/" && text[i + 1] === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      if (word === "import" || word === "include" || word === "from") return text.slice(i + 1, j);
      word = null;
      i = j + 1;
      continue;
    }
    IDENTIFIER.lastIndex = i;
    const id = IDENTIFIER.exec(text);
    if (id !== null) { word = id[0]; i = IDENTIFIER.lastIndex; continue; }
    NUMERAL.lastIndex = i;
    const numeral = NUMERAL.exec(text);
    if (numeral !== null) { word = numeral[0]; i = NUMERAL.lastIndex; continue; }
    i++;
  }
  return null;
}

/** The trace's positive control ([B] `traceControlProblem`): a listed source that imports by name
 *  makes the compiler look for a file, so at least one trace line must be there. */
export function traceControlProblem(stderr: string, files: ReadonlyMap<string, Buffer>, listed: readonly string[]): string | null {
  if (stderr.split("\n").some((line) => TRACE_LINE.test(line))) return null;
  for (const file of listed) {
    if (!file.endsWith(".compact")) continue;
    const body = files.get(file);
    const spec = body === undefined ? null : quotedDirective(body.toString("utf8"));
    if (body !== undefined && spec === null) continue;
    const shown = spec !== null && spec.length > 120 ? `${spec.slice(0, 117)}...` : spec;
    const what = spec === null ? `${JSON.stringify(file)} could not be read to rule out an import` : `${JSON.stringify(file)} imports or includes ${JSON.stringify(shown)}`;
    return `the compiler's search trace was not recognised: ${what}, but the compiler printed no "looking for <file>...found" line on stderr, so the files it read cannot be checked (compactc 0.30.0 to 0.34.0 print one line per lookup)`;
  }
  return null;
}

// ── running the compiler ─────────────────────────────────────────────────────────────────────

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  tooMuchOutput: boolean;
  spawnError?: NodeJS.ErrnoException;
}

/** Runs `bin args` in its own process group, with a deadline that kills the whole group. */
function run(bin: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let tooMuchOutput = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolvePromise({ code: null, signal: null, stdout: "", stderr: "", timedOut, tooMuchOutput, spawnError: error as NodeJS.ErrnoException });
      return;
    }
    const killGroup = (): void => {
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, opts.timeoutMs);
    const collect = (sink: Buffer[]) => (chunk: Buffer): void => {
      size += chunk.length;
      if (size > opts.maxOutputBytes) { tooMuchOutput = true; killGroup(); return; }
      sink.push(chunk);
    };
    child.stdout!.on("data", collect(out));
    child.stderr!.on("data", collect(err));
    let spawnError: NodeJS.ErrnoException | undefined;
    child.on("error", (error) => { spawnError = error as NodeJS.ErrnoException; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      killGroup(); // anything the compiler left behind in its group
      resolvePromise({
        code, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"),
        timedOut, tooMuchOutput, ...(spawnError === undefined ? {} : { spawnError }),
      });
    });
  });
}

/** Stderr that says the COMPILER's environment failed, not the bundle (it could not obtain its
 *  proving parameters, or the chosen version disappeared). */
const ENVIRONMENT_FAILURE = /couldn't find compiler|data provider|zk[-_ ]?params|public parameters|srs\.midnight|no space left on device|cannot allocate memory/i;

const firstLine = (text: string): string | undefined =>
  text.split("\n").map((l) => l.trim()).find((l) => l !== "" && !TRACE_LINE.test(l));

/** The Compact CLI's environment: the caller's, without `COMPACT_PATH` (it belongs to the consumer,
 *  not the bundle — an import must not resolve there). */
function compilerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.COMPACT_PATH;
  return env;
}

/**
 * Whether `compactBin` can run compactc `version` exactly — `compile +<version> --version` prints
 * the version — or why not. The CLI refuses a version that is not installed without downloading it.
 */
export async function compilerAvailable(compactBin: string, version: string, opts: Partial<Level3Options> = {}): Promise<{ ok: true; installed: string } | { ok: false; reason: string }> {
  const probe = await run(compactBin, ["compile", `+${version}`, "--version"], {
    env: compilerEnv(), timeoutMs: opts.probeTimeoutMs ?? DEFAULT_LEVEL3_OPTIONS.probeTimeoutMs!, maxOutputBytes: 64 * 1024,
  });
  if (probe.spawnError?.code === "ENOENT") return { ok: false, reason: `compiler ${version} unavailable: the Compact toolchain is not installed (${compactBin} not found)` };
  if (probe.spawnError !== undefined) return { ok: false, reason: `compiler ${version} unavailable: ${compactBin} cannot be run (${probe.spawnError.code ?? probe.spawnError.message})` };
  if (probe.timedOut) return { ok: false, reason: `compiler ${version} unavailable: ${compactBin} compile +${version} --version did not answer in time` };
  const answer = probe.stdout.trim();
  if (probe.code === 0 && answer === version) return { ok: true, installed: answer };
  const why = firstLine(probe.stderr) ?? (answer === "" ? `exit status ${String(probe.code)}` : `it reports ${JSON.stringify(answer.slice(0, 80))}`);
  return { ok: false, reason: `compiler ${version} unavailable (${compactBin} compile +${version}: ${why.slice(0, 200)})` };
}

// ── Level 3 ─────────────────────────────────────────────────────────────────────────────────

/**
 * Tries Level 3 on the Level 1/2-checked `files` (path → bytes; `listed` = the paths `index.json`
 * lists). Never throws for a check that does not pass; the private directories are always removed.
 */
export async function levelThree(
  files: ReadonlyMap<string, Buffer>, listed: readonly string[], options: Partial<Level3Options> = {},
): Promise<Level3Result> {
  const opts: Level3Options = { ...DEFAULT_LEVEL3_OPTIONS, ...options };
  const started = Date.now();
  const compiler: Level3Result["compiler"] = { version: null, flags: [], installed: null };
  const done = (outcome: Level3Result["outcome"], reason: string | undefined, rows: Level3Row[] = [], generatedKeys: Level3Result["generatedKeys"] = []): Level3Result =>
    ({ outcome, ...(reason === undefined ? {} : { reason }), compiler, rows, generatedKeys, durationMs: Date.now() - started });

  // --- what the bundle asks for (a bundle problem is `failed`) ------------------------------
  let pkg: { compact?: Record<string, unknown> };
  try {
    pkg = JSON.parse(files.get("package.json")?.toString("utf8") ?? "") as typeof pkg;
  } catch (error) {
    return done("failed", `bundle package.json is missing or not JSON (${(error as Error).message})`);
  }
  const pinned = pkg?.compact ?? {};
  const version = typeof pinned.compiler === "string" ? pinned.compiler : "";
  if (!VERSION.test(version)) return done("failed", `bundle package.json compact.compiler is ${JSON.stringify(pinned.compiler)}, not a version x.y.z`);
  compiler.version = version;
  const flags = pinned.flags ?? [];
  if (!Array.isArray(flags) || flags.some((f) => typeof f !== "string" || !LEVEL3_FLAGS.has(f))) {
    return done("failed", `bundle package.json asks for compiler flags this verifier does not pass: ${JSON.stringify(flags).slice(0, 200)}`);
  }
  compiler.flags = flags as string[];
  const source = pinned.interface;
  if (typeof source !== "string" || source.length === 0) return done("failed", "bundle package.json does not point at a published source (compact.interface)");
  // Resolved as the reference resolves it (`src/verify.mjs` levelThree: `resolve(root, interface)`,
  // inside the bundle, then relative to it and listed), so `src/./X.compact`, `./src/X.compact` and
  // `src/../src/X.compact` name the same listed file (audit 02 E2-F5). Nothing is rewritten: a
  // backslash is an ordinary character on POSIX, and an absolute path is outside any bundle.
  const BUNDLE = "/bundle";
  const resolved = posix.resolve(BUNDLE, source);
  if (posix.isAbsolute(source) || !resolved.startsWith(`${BUNDLE}/`)) {
    return done("failed", `compact.interface ${JSON.stringify(source.slice(0, 200))} resolves outside the bundle`);
  }
  const rel = posix.relative(BUNDLE, resolved);
  if (pathProblem(rel) !== null || !listed.includes(rel) || !files.has(rel)) {
    return done("failed", `compact.interface ${JSON.stringify(rel.slice(0, 200))} is not listed in index.json, so it is not part of the committed bundle`);
  }

  // --- the exact compiler, or not_run -----------------------------------------------------------
  const available = await compilerAvailable(opts.compactBin, version, opts);
  if (!available.ok) return done("not_run", available.reason);
  compiler.installed = available.installed;

  // --- the checked files, alone, in a private directory ------------------------------------------
  const tmpRoot = opts.tmpRoot ?? tmpdir();
  let root: string | undefined;
  let out: string | undefined;
  try {
    try {
      root = mkdtempSync(join(tmpRoot, "umbradb-l3-src-"));
      out = mkdtempSync(join(tmpRoot, "umbradb-l3-out-"));
      for (const path of listed) {
        const body = files.get(path);
        if (body === undefined) continue;
        const dest = join(root, ...path.split("/"));
        if (!dest.startsWith(root + sep)) return done("failed", `${path}: resolves outside the private directory`);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, body, { flag: "wx" });
      }
    } catch (error) {
      return done("not_run", `the bundle could not be written to a private directory (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`);
    }
    const src = join(root, ...rel.split("/"));

    // --- compile --------------------------------------------------------------------------------
    const compile = await run(opts.compactBin, ["compile", `+${version}`, "--trace-search", ...compiler.flags, src, out], {
      cwd: root, env: compilerEnv(), timeoutMs: opts.deadlineMs, maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_LEVEL3_OPTIONS.maxOutputBytes!,
    });
    if (compile.timedOut) return done("not_run", `the compile with compactc ${version} did not finish within ${opts.deadlineMs} ms`);
    if (compile.spawnError !== undefined) return done("not_run", `${opts.compactBin} cannot be run (${compile.spawnError.code ?? compile.spawnError.message})`);
    if (compile.tooMuchOutput) return done("failed", `the compiler printed more than ${opts.maxOutputBytes} bytes, so its search trace cannot be checked`);
    const confined = searchTraceProblem(compile.stderr, { root, listed });
    if (confined !== null) return done("failed", confined);
    if (compile.signal !== null) return done("not_run", `the compiler was stopped by ${compile.signal}`);
    if (compile.code !== 0) {
      const first = firstLine(compile.stderr) ?? `exit status ${String(compile.code)}`;
      if (ENVIRONMENT_FAILURE.test(compile.stderr)) return done("not_run", `the compiler's environment failed: ${first.slice(0, 300)}`);
      return done("failed", `recompile failed: ${first.slice(0, 300)}`);
    }
    const unrecognised = traceControlProblem(compile.stderr, files, listed);
    if (unrecognised !== null) return done("failed", unrecognised);

    // --- compare --------------------------------------------------------------------------------
    const rows: Level3Row[] = [];
    const shipped = [...files.keys()]
      .filter((p) => p.startsWith("out/keys/") && p.endsWith(".verifier") && !p.slice("out/keys/".length).includes("/"))
      .map((p) => p.slice("out/keys/".length, -".verifier".length))
      .sort();
    const producedDir = join(out, "keys");
    const produced = (() => {
      try { return readdirSync(producedDir).filter((f) => f.endsWith(".verifier")).map((f) => f.slice(0, -".verifier".length)).sort(); } catch { return []; }
    })();
    const readProduced = (p: string): Buffer | undefined => {
      try { return statSync(p).isFile() ? readFileSync(p) : undefined; } catch { return undefined; }
    };
    for (const name of shipped) {
      const item = `${name}.verifier`;
      const mine = readProduced(join(producedDir, item));
      if (mine === undefined) { rows.push({ item, status: "FAIL", reason: "not produced by the recompile" }); continue; }
      rows.push({ item, status: mine.equals(files.get(`out/keys/${item}`)!) ? "OK" : "FAIL" });
    }
    for (const name of produced) {
      if (!shipped.includes(name)) rows.push({ item: `${name}.verifier`, status: "FAIL", reason: "produced by the recompile but not shipped" });
    }
    for (const item of ["contract/index.js", "compiler/contract-info.json"]) {
      const theirs = files.get(`out/${item}`);
      if (theirs === undefined) { rows.push({ item, status: "FAIL", reason: `out/${item} is not in the bundle` }); continue; }
      const mine = readProduced(join(out, ...item.split("/")));
      if (mine === undefined) { rows.push({ item, status: "FAIL", reason: "not produced by the recompile" }); continue; }
      rows.push({ item, status: mine.equals(theirs) ? "OK" : "FAIL" });
    }
    const generatedKeys = produced.flatMap((name) => {
      const key = readProduced(join(producedDir, `${name}.verifier`));
      return key === undefined ? [] : [{ circuit: name, sha256: sha256Hex(key) }];
    });
    const failedRow = rows.find((r) => r.status === "FAIL");
    return done(
      failedRow === undefined ? "passed" : "failed",
      failedRow === undefined ? undefined : `the published source does not reproduce ${failedRow.item}${failedRow.reason === undefined ? "" : ` (${failedRow.reason})`}`,
      rows, generatedKeys,
    );
  } finally {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    if (out !== undefined) rmSync(out, { recursive: true, force: true });
  }
}
