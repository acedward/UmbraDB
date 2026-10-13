/**
 * The MIP-0018 conformance table: `token-indexer/CONFORMANCE.md` maps every MUST/SHOULD of the pinned MIP-0018 text
 * (`main @ eb94bc1`, as merged from PR #372) to UmbraDB tests or "not applicable". This file keeps the table honest:
 *
 * - `[[mip0018.conformance.table]]` — the rows are exactly the MIP's requirements (a SHA-256 of the extracted list),
 *   every row is resolved, and every test id, vector and path the table cites exists;
 * - `[[mip0018.conformance.no-network-no-code]]` — the static half of C-027 / C-034: the indexer's runtime code and the
 *   vendored codec contain no network client, no dynamic code and no child process (so no `standards` identifier can
 *   make it run code), except ONE module: the background image fetcher (`image-fetcher.ts`), the only code that may
 *   resolve names and open connections, held to its own exact allowlist;
 * - `[[mip0018.conformance.fetcher-isolated]]` — the scan and the API never load the image fetcher (their import
 *   closures exclude it); only `serve` does.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;
const DOC = readFileSync(join(ROOT, "token-indexer/CONFORMANCE.md"), "utf8");

/** The pinned MIP text: `midnightntwrk/midnight-improvement-proposals` `mips/mip-0018-on-chain-token-metadata.md`. */
const MIP_COMMIT = "eb94bc182221cd937a84ed66a5f903b060f165ab";
const MIP_SHA256 = "8d4204e7aa24428faa44740ba99612f5556f628347c50e38903e4bea83f17245";

/**
 * SHA-256 of the MIP's requirement list, `JSON.stringify([[id, section, level, text], …])` with Markdown links reduced
 * to their text, `\|` unescaped and whitespace collapsed. Computed from the pinned MIP text ({@link MIP_COMMIT}, file
 * SHA-256 {@link MIP_SHA256}) with the reference implementation's extraction rule (`midnight-experiments/mip-0018`
 * `tools/lib/requirements.mjs` @ `e829579`: every sentence or table row containing MUST or SHOULD outside code blocks,
 * RFC 2119 boilerplate excluded, numbered C-001…). 40 rows. Re-pin the MIP → recompute this value and the table.
 */
const REQUIREMENTS_SHA256 = "de86b83bb1c84c39326207a45306a3d22c9349961038b781f90ec3c18fb01495";
const REQUIREMENT_ROWS = 40;

/**
 * Pending ids: a row may cite a test that does not exist yet as `[[id]]`† and list its id here; the check below fails as
 * soon as that test exists. None.
 */
const PENDING_IDS: string[] = [];

const normalize = (s: string): string => s.replace(/\\\|/g, "|").replace(/\s+/g, " ").trim();
const unlink = (s: string): string => s.replace(/\[([^\]]*)\]\([^)\s]*\)/g, "$1");

interface Row { id: string; section: string; level: string; text: string; vectors: string; evidence: string; status: string }

function rows(): Row[] {
  const out: Row[] = [];
  const lines = DOC.split("\n");
  const header = lines.findIndex((l) => l.startsWith("| ID | MIP section | Level |"));
  expect(header).toBeGreaterThan(0);
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim());
    expect(cells, line.slice(0, 40)).toHaveLength(7);
    const [id, section, level, text, vectors, evidence, status] = cells as [string, string, string, string, string, string, string];
    out.push({ id, section, level, text, vectors, evidence, status });
  }
  return out;
}

/** Every file under `dir` (relative to the repository root) ending in one of `exts`, outside generated folders. */
function walk(dir: string, exts: string[], out: string[] = []): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    if (["node_modules", ".git", "dist", "coverage", ".stryker-tmp"].includes(name)) continue;
    const p = join(abs, name);
    if (statSync(p).isDirectory()) walk(relative(ROOT, p), exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(relative(ROOT, p));
  }
  return out;
}

/** Forbidden forms for runtime code (comments stripped first): network clients, dynamic code, child processes. */
const FORBIDDEN: Array<[string, RegExp]> = [
  ["fetch call", /\bfetch\s*\(/],
  ["http(s) client call", /\b(?:http|https|http2)\s*\.\s*(?:request|get|connect)\s*\(/],
  ["client import from node:http", /import\s*\{[^}]*\b(?:request|get)\b[^}]*\}\s*from\s*["']node:http["']/],
  ["network / process / vm module", /^\s*import\s+(?!type\b)[^;]*from\s*["']node:(?:https|http2|net|tls|dgram|child_process|worker_threads|vm|cluster)["']/m],
  ["require", /\brequire\s*\(/],
  ["eval", /\beval\s*\(/],
  ["Function constructor", /\bnew\s+Function\s*\(/],
  ["dynamic import of a computed or package specifier", /\bimport\s*\(\s*(?!["']\.{1,2}\/)/],
  ["browser network API", /\b(?:WebSocket|XMLHttpRequest|EventSource)\b/],
  ["computed global access", /\bglobalThis\s*\[/],
];
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const violations = (src: string): string[] => FORBIDDEN.filter(([, re]) => re.test(stripComments(src))).map(([what]) => what);

/**
 * What the indexer's runtime may import — an ALLOWLIST, so a network client package (axios, undici, got, …) or a
 * process/socket module cannot slip past the denylist above. Exactly the modules the runtime uses (the test fails on an
 * unused entry too); type-only imports are erased and not counted; relative specifiers must stay in this repository and
 * outside `node_modules`; a dynamic import must be a relative string literal.
 */
const ALLOWED_MODULES = new Set(["node:crypto", "node:fs", "node:http", "node:util", "postgres", "zod", "@midnightntwrk/ledger-v9"]);

/** The one runtime module that may use the network: the background image fetcher of `serve`. */
const NETWORK_MODULE = "token-indexer/mip0018/image-fetcher.ts";
/** What the network module may load beyond {@link ALLOWED_MODULES}, exactly: name resolution, TCP, TLS. */
const NETWORK_MODULES = new Set(["node:dns/promises", "node:net", "node:tls"]);
/** The forbidden forms the network module contains (an HTTP client import, socket modules) — and no other. */
const NETWORK_FORMS = ["client import from node:http", "network / process / vm module"];
const allowlistOf = (file: string): ReadonlySet<string> => (file === NETWORK_MODULE ? new Set([...ALLOWED_MODULES, ...NETWORK_MODULES]) : ALLOWED_MODULES);

interface ImportUse { spec: string; typeOnly: boolean; dynamic: boolean }

/** Every module specifier a source file loads: static imports and re-exports, side-effect imports, dynamic imports. */
function importsOf(src: string): ImportUse[] {
  const code = stripComments(src);
  const out: ImportUse[] = [];
  for (const m of code.matchAll(/^\s*(import|export)\s+(type\s+)?(?:[^;"']*?\s+from\s+)?["']([^"']+)["']/gm)) out.push({ spec: m[3]!, typeOnly: m[2] !== undefined, dynamic: false });
  for (const m of code.matchAll(/\bimport\s*\(\s*([^)]*?)\s*\)/g)) {
    const lit = /^["']([^"']+)["']$/.exec(m[1]!);
    out.push({ spec: lit === null ? "<computed>" : lit[1]!, typeOnly: false, dynamic: true });
  }
  return out;
}

/**
 * Allowlist violations of a file at `file` (repository-relative), and the relative files it loads at run time. The
 * network module is held to its own allowlist ({@link allowlistOf}).
 */
function importCheck(src: string, file: string): { bad: string[]; local: string[]; used: string[] } {
  const allowed = allowlistOf(file);
  const bad: string[] = [];
  const local: string[] = [];
  const used: string[] = [];
  for (const u of importsOf(src)) {
    if (u.typeOnly) continue;
    if (u.spec.startsWith("./") || u.spec.startsWith("../")) {
      const target = relative(ROOT, resolve(ROOT, dirname(file), u.spec));
      if (target.startsWith("..") || target.split(sep).includes("node_modules")) bad.push(`${u.spec} (outside the repository's own code)`);
      else local.push(target);
    } else if (u.dynamic) {
      bad.push(`${u.spec} (dynamic import of a package or a computed specifier)`);
    } else if (allowed.has(u.spec)) {
      used.push(u.spec);
    } else {
      bad.push(`${u.spec} (not on the allowlist)`);
    }
  }
  return { bad, local, used };
}

/** A relative import's source file (`.js` specifiers name their `.ts` source). */
const sourceOf = (target: string): string | undefined =>
  [target, target.replace(/\.js$/, ".ts")].find((t) => existsSync(join(ROOT, t)) && statSync(join(ROOT, t)).isFile());

/** Every repository file `entry` loads at run time (static and dynamic relative imports), `entry` included. */
function closureOf(entry: string, read: (f: string) => string = (f) => readFileSync(join(ROOT, f), "utf8")): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const f = queue.shift()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const t of importCheck(read(f), f).local) {
      const src = sourceOf(t);
      if (src !== undefined) queue.push(src);
    }
  }
  return seen;
}

describe("MIP-0018 conformance table", () => {
  it("[[mip0018.conformance.table]] CONFORMANCE.md lists exactly the 40 MUST/SHOULD requirements of the pinned MIP-0018 text (main @ eb94bc1), each covered by existing tests or not applicable with a reason; every cited test id, vector and path exists", () => {
    const rs = rows();
    expect(rs.map((r) => r.id)).toEqual(Array.from({ length: REQUIREMENT_ROWS }, (_, i) => `C-${String(i + 1).padStart(3, "0")}`));
    const list = rs.map((r) => [r.id, normalize(r.section), r.level, normalize(unlink(r.text))]);
    expect(createHash("sha256").update(JSON.stringify(list)).digest("hex")).toBe(REQUIREMENTS_SHA256);
    expect(DOC).toContain(`midnight-improvement-proposals@${MIP_COMMIT}`);
    expect(DOC).toContain(MIP_SHA256);

    // Every row resolved; the summary line says the same.
    for (const r of rs) {
      expect(["covered", "not applicable"], r.id).toContain(r.status);
      if (r.status === "covered") expect(/\[\[[a-z0-9.-]+\]\]/.test(r.evidence) || r.vectors !== "—", `${r.id} cites a test or vector`).toBe(true);
      else expect(r.evidence.length, `${r.id} gives a reason`).toBeGreaterThan(20);
      expect(["MUST", "SHOULD", "MUST/SHOULD"], r.id).toContain(r.level);
    }
    const covered = rs.filter((r) => r.status === "covered").length;
    expect(DOC).toContain(`**${covered} covered, ${rs.length - covered} not applicable**`);

    // Test ids: in the required manifest or a `[[id]]` token of a test file — or pending (†).
    const manifest = JSON.parse(readFileSync(join(ROOT, "test/integration/required-tests.manifest.json"), "utf8")) as { required: Array<{ id: string }> };
    const known = new Set(manifest.required.map((r) => r.id));
    for (const f of walk(".", [".test.ts"])) for (const m of readFileSync(join(ROOT, f), "utf8").matchAll(/\[\[([a-z0-9.:-]+)\]\]/g)) known.add(m[1]!);
    const cited = new Set([...DOC.matchAll(/\[\[([a-z0-9.-]+)\]\]/g)].map((m) => m[1]!));
    const marked = new Set([...DOC.matchAll(/\[\[([a-z0-9.-]+)\]\]`†/g)].map((m) => m[1]!));
    expect([...marked].sort()).toEqual([...PENDING_IDS].sort());
    for (const id of PENDING_IDS)
      expect(known.has(id), `${id} exists: drop its † in CONFORMANCE.md and remove it from PENDING_IDS`).toBe(false);
    const missing = [...cited].filter((id) => !known.has(id) && !marked.has(id));
    expect(missing).toEqual([]);
    expect(cited.size).toBeGreaterThan(40);
    // A pending id is always written with its † (never cited unmarked elsewhere in the table).
    for (const id of PENDING_IDS)
      expect(DOC.split(`[[${id}]]`).length - 1, id).toBe(DOC.split(`[[${id}]]\`†`).length - 1);

    // Vectors: vendored ids, and `*` = UmbraDB's own version (`token-indexer/mip0018/vectors-umbradb/`, when present).
    const ids = (path: string): Set<string> => new Set((JSON.parse(readFileSync(join(ROOT, path), "utf8")) as { vectors: Array<{ id: string }> }).vectors.map((v) => v.id));
    const vendored = ids("token-indexer/vendor/mip0018/vectors/manifest.json");
    const ownManifest = "token-indexer/mip0018/vectors-umbradb/manifest.json";
    const own = existsSync(join(ROOT, ownManifest)) ? ids(ownManifest) : new Set<string>();
    let vectorCount = 0;
    for (const r of rs) {
      if (r.vectors === "—") continue;
      for (const v of r.vectors.split(",").map((x) => x.trim())) {
        vectorCount++;
        if (v.endsWith("*")) expect(own.has(v.slice(0, -1)), `${r.id}: ${v}`).toBe(true);
        else {
          expect(vendored.has(v), `${r.id}: ${v}`).toBe(true);
          expect(own.has(v), `${r.id}: ${v} has an UmbraDB version — cite it as ${v}*`).toBe(false);
        }
      }
    }
    expect(vectorCount).toBeGreaterThan(100);

    // Paths of this repository cited in backticks exist (paths of the MIP and reference repositories are not checked).
    let paths = 0;
    for (const m of DOC.matchAll(/`((?:token-indexer|test|chain-archive-sync|src)\/(?:[\w.-]+\/)*[\w.-]+\.(?:ts|md|json))`/g)) {
      paths++;
      expect(existsSync(join(ROOT, m[1]!)), m[1]).toBe(true);
    }
    expect(paths).toBeGreaterThan(3);
  }, 60_000);

  it("[[mip0018.conformance.no-network-no-code]] the indexer's runtime code and the vendored codec contain no network client, no dynamic code and no child process (C-027, C-034: no identifier makes it fetch or run code, and only the image fetcher fetches a URI); the check catches each forbidden form; every module the runtime loads, through its relative import closure, is on an exact allowlist (node:crypto, node:fs, node:http, node:util, postgres, zod, @midnightntwrk/ledger-v9) — package clients such as axios, undici or got and socket/process modules are refused; the one exception is the image fetcher, the only module allowed an HTTP client and name resolution, TCP and TLS (node:dns/promises, node:net, node:tls, exactly), still refused everything else; a network import anywhere else is refused", () => {
    // Positive controls: every forbidden form is caught, the allowed forms are not.
    const caught = [
      "await fetch(url)", "http.request(opts)", "https.get(u)", 'import { request } from "node:http";', 'import { spawn } from "node:child_process";',
      'import * as net from "node:net";', "const x = require('x')", "eval(code)", "new Function('return 1')", "await import(name)",
      'await import("pkg")', "new WebSocket(u)",
    ];
    for (const c of caught) expect(violations(c), c).not.toEqual([]);
    const allowed = [
      'import { createServer } from "node:http";', 'import type { AddressInfo } from "node:net";', 'const { Mip0018Scanner } = await import("./scan.ts");',
      "// never fetch( a URI", "/* eval( */ const a = 1;", 'const url = "https://example";',
    ];
    for (const a of allowed) expect(violations(a), a).toEqual([]);

    // Runtime code: everything under token-indexer/mip0018 except the vector tooling (adapters, generator, runner
    // wrapper — test-only programs that talk to the vendored runner over stdin/stdout or spawn it), plus the vendored
    // codec. The browser page's own script (`ui/page.js`) is checked by the page guard (`mip0018-ui-page.test.ts`).
    const devOnly = new Set(["token-indexer/mip0018/run-vectors.ts", "token-indexer/mip0018/vector-adapter.ts", "token-indexer/mip0018/vector-adapter-pg.ts"]);
    const files = [...walk("token-indexer/mip0018", [".ts"]).filter((f) => !devOnly.has(f) && !f.startsWith("token-indexer/mip0018/vectors-umbradb/")),
      ...walk("token-indexer/vendor/mip0018/codec/src", [".ts"])];
    for (const f of ["scan.ts", "applied-parts.ts", "state.ts", "fields.ts", "metadata.ts", "tokens.ts", "activity.ts"]) expect(files).toContain(`token-indexer/mip0018/${f}`);
    expect(files.filter((f) => f.startsWith("token-indexer/vendor/")).length).toBeGreaterThanOrEqual(8);
    const found = Object.fromEntries(files.map((f): [string, string[]] => [f, violations(readFileSync(join(ROOT, f), "utf8"))]).filter(([, v]) => v.length > 0));
    // Only the image fetcher holds network forms, and only an HTTP client import and socket modules (never fetch(),
    // require, eval, dynamic code or a browser API).
    expect(found).toEqual({ [NETWORK_MODULE]: NETWORK_FORMS });
    expect(files).toContain(NETWORK_MODULE);

    // The import allowlist. Negative controls: package network clients, socket and process modules,
    // dynamic package imports, a relative path into node_modules; positive controls: the forms the runtime uses.
    const notAllowed = [
      'import axios from "axios";', 'import { request } from "undici";', 'import got from "got";', 'import * as net from "node:net";',
      "const m = await import(name);", 'const u = await import("undici");', 'import { spawn } from "child_process";',
      'import "node:child_process";', 'export * from "undici";', 'import x from "../../node_modules/axios/index.js";',
      'import { connect } from "node:tls";', 'import ws from "ws";',
    ];
    for (const c of notAllowed) expect(importCheck(c, "token-indexer/mip0018/x.ts").bad, c).not.toEqual([]);
    expect(violations('const f = globalThis["fe" + "tch"]; await f(u);')).toEqual(["computed global access"]);
    const fine = [
      'import { createServer } from "node:http";', 'import type { AddressInfo } from "node:net";', 'import postgres from "postgres";',
      'import type { ISql } from "postgres";', 'import { z } from "zod";', 'const { Mip0018Scanner } = await import("./scan.ts");',
      'import { createClient } from "../../src/postgres/client.js";',
    ];
    for (const a of fine) expect(importCheck(a, "token-indexer/mip0018/x.ts").bad, a).toEqual([]);
    // The network module's own allowlist: name resolution, TCP and TLS there and nowhere else; everything else refused
    // there too.
    const network = ['import { lookup } from "node:dns/promises";', 'import { connect, isIP } from "node:net";', 'import { connect } from "node:tls";'];
    for (const n of network) {
      expect(importCheck(n, NETWORK_MODULE).bad, n).toEqual([]);
      expect(importCheck(n, "token-indexer/mip0018/x.ts").bad, n).not.toEqual([]);
      expect(importCheck(n, "token-indexer/mip0018/images.ts").bad, n).not.toEqual([]);
    }
    for (const c of [...notAllowed.filter((c) => !c.includes("node:net") && !c.includes("node:tls")), 'import { lookup } from "node:dns";', 'import * as vm from "node:vm";'])
      expect(importCheck(c, NETWORK_MODULE).bad, c).not.toEqual([]);

    // The runtime and every file of this repository it loads (its relative import closure, e.g. src/postgres/*).
    const seen = new Set<string>();
    const queue = [...files];
    const offending: Record<string, string[]> = {};
    const used = new Set<string>();
    const usedByNetwork = new Set<string>();
    while (queue.length > 0) {
      const f = queue.shift()!;
      if (seen.has(f)) continue;
      seen.add(f);
      const r = importCheck(readFileSync(join(ROOT, f), "utf8"), f);
      if (r.bad.length > 0) offending[f] = r.bad;
      for (const u of r.used) (f === NETWORK_MODULE ? usedByNetwork : used).add(u);
      for (const t of r.local) {
        const src = sourceOf(t);
        expect(src, `${f} imports ${t}`).toBeDefined();
        queue.push(src!);
      }
    }
    expect(offending).toEqual({});
    expect([...seen].filter((f) => f.startsWith("src/")).length).toBeGreaterThan(5); // the closure reaches the repository's own src/ code
    expect(seen.has("src/postgres/client.ts")).toBe(true);
    expect([...used].sort()).toEqual([...ALLOWED_MODULES].sort()); // no unused entry: the allowlist is exactly what runs
    expect([...usedByNetwork].filter((m) => !ALLOWED_MODULES.has(m)).sort()).toEqual([...NETWORK_MODULES].sort());
  }, 60_000);

  it("[[mip0018.conformance.fetcher-isolated]] the scan never loads the image fetcher and the API never fetches: the import closures of the scan (scan.ts, scan-cli.ts) and of the API (api.ts) exclude image-fetcher.ts, while serve-cli.ts loads it (positive control); a scan that imported it would be caught (negative control)", () => {
    for (const entry of ["token-indexer/mip0018/scan.ts", "token-indexer/mip0018/scan-cli.ts", "token-indexer/mip0018/api.ts", "token-indexer/mip0018/api-views.ts", "token-indexer/mip0018/images.ts"]) {
      const c = closureOf(entry);
      expect(c.size, entry).toBeGreaterThan(entry.endsWith("images.ts") ? 3 : 5);
      expect(c.has(NETWORK_MODULE), entry).toBe(false);
    }
    expect(closureOf("token-indexer/mip0018/scan.ts").has("token-indexer/mip0018/applied-parts.ts")).toBe(true);
    const serve = closureOf("token-indexer/mip0018/serve-cli.ts");
    expect(serve.has(NETWORK_MODULE)).toBe(true);
    expect(serve.has("token-indexer/mip0018/scan.ts")).toBe(true);
    // Negative control: the same walk over a scan that imports the fetcher (statically or dynamically) finds it.
    for (const line of ['import { ImageFetcher } from "./image-fetcher.ts";', 'const f = await import("./image-fetcher.ts");']) {
      const read = (f: string): string => {
        const src = readFileSync(join(ROOT, f), "utf8");
        return f === "token-indexer/mip0018/scan.ts" ? `${src}\n${line}\n` : src;
      };
      expect(closureOf("token-indexer/mip0018/scan.ts", read).has(NETWORK_MODULE), line).toBe(true);
    }
  }, 60_000);
});
