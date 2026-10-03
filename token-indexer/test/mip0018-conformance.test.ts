/**
 * The MIP-0018 conformance table (project 00026, sub-plan D4; spec SC-006): `token-indexer/CONFORMANCE.md` maps every
 * MUST/SHOULD of the final MIP (`274a84f`) to UmbraDB tests or "not applicable". This file keeps the table honest:
 *
 * - `[[mip0018.conformance.table]]` — the rows are exactly the MIP's requirements (a SHA-256 of the extracted list),
 *   every row is resolved, and every test id, vector and path the table cites exists;
 * - `[[mip0018.conformance.no-network-no-code]]` — the static half of C-024 / C-031: the indexer's runtime code and the
 *   vendored codec contain no network client, no dynamic code and no child process (so no URI is ever fetched and no
 *   `standards` identifier can make it run code).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;
const DOC = readFileSync(join(ROOT, "token-indexer/CONFORMANCE.md"), "utf8");

/**
 * SHA-256 of the MIP's requirement list, `JSON.stringify([[id, section, level, text], …])` with Markdown links reduced
 * to their text, `\|` unescaped and whitespace collapsed. Computed from the pinned MIP text
 * (`mip-0018-on-chain-token-metadata.md` @ `274a84f221bcfc17e4b73e2c8b32fd8c028ea092`, SHA-256 `e64fe142…058d8b`) with
 * the reference implementation's extraction rule (`midnight-experiments/mip-0018` `tools/lib/requirements.mjs` @
 * `daec1f1`: every sentence or table row containing MUST or SHOULD outside code blocks, RFC 2119 boilerplate excluded,
 * numbered C-001…). 36 rows. Re-pin the MIP → recompute this value and the table.
 */
const REQUIREMENTS_SHA256 = "c5795004bb00485a677fc65512b9c18aeba0df9fdc4827aab6f33bcd79de1270";
const REQUIREMENT_ROWS = 36;

/**
 * Pending ids (sub-plan D4 drafts): none. The table was finalized after sub-plan C merged (project 00026); a future
 * draft row may again cite a not-yet-written test as `[[id]]`† and list it here, and the check below fails as soon as
 * that test exists.
 */
const PENDING_AFTER_C_MERGE: string[] = [];

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
];
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const violations = (src: string): string[] => FORBIDDEN.filter(([, re]) => re.test(stripComments(src))).map(([what]) => what);

describe("MIP-0018 conformance table (00026 D4)", () => {
  it("[[mip0018.conformance.table]] CONFORMANCE.md lists exactly the 36 MUST/SHOULD requirements of MIP 274a84f, each covered by existing tests or not applicable with a reason; every cited test id, vector and path exists; sub-plan C's ids stay pending until C merges", () => {
    const rs = rows();
    expect(rs.map((r) => r.id)).toEqual(Array.from({ length: REQUIREMENT_ROWS }, (_, i) => `C-${String(i + 1).padStart(3, "0")}`));
    const list = rs.map((r) => [r.id, normalize(r.section), r.level, normalize(unlink(r.text))]);
    expect(createHash("sha256").update(JSON.stringify(list)).digest("hex")).toBe(REQUIREMENTS_SHA256);
    expect(DOC).toContain("274a84f221bcfc17e4b73e2c8b32fd8c028ea092");
    expect(DOC).toContain("e64fe1429b9f7589077f1323572cf5c3ffa90c7c96690242a9e76d2658058d8b");

    // Every row resolved; the summary line says the same.
    for (const r of rs) {
      expect(["covered", "not applicable"], r.id).toContain(r.status);
      if (r.status === "covered") expect(/\[\[[a-z0-9.-]+\]\]/.test(r.evidence) || r.vectors !== "—", `${r.id} cites a test or vector`).toBe(true);
      else expect(r.evidence.length, `${r.id} gives a reason`).toBeGreaterThan(20);
      expect(["MUST", "SHOULD", "MUST/SHOULD"], r.id).toContain(r.level);
    }
    const covered = rs.filter((r) => r.status === "covered").length;
    expect(DOC).toContain(`**${covered} covered, ${rs.length - covered} not applicable**`);

    // Test ids: in the required manifest or a `[[id]]` token of a test file — or, while this is a draft, pending (†).
    const manifest = JSON.parse(readFileSync(join(ROOT, "test/integration/required-tests.manifest.json"), "utf8")) as { required: Array<{ id: string }> };
    const known = new Set(manifest.required.map((r) => r.id));
    for (const f of walk(".", [".test.ts"])) for (const m of readFileSync(join(ROOT, f), "utf8").matchAll(/\[\[([a-z0-9.:-]+)\]\]/g)) known.add(m[1]!);
    const cited = new Set([...DOC.matchAll(/\[\[([a-z0-9.-]+)\]\]/g)].map((m) => m[1]!));
    const marked = new Set([...DOC.matchAll(/\[\[([a-z0-9.-]+)\]\]`†/g)].map((m) => m[1]!));
    expect([...marked].sort()).toEqual([...PENDING_AFTER_C_MERGE].sort());
    for (const id of PENDING_AFTER_C_MERGE)
      expect(known.has(id), `${id} is present now: finalize CONFORMANCE.md (drop † and the Pending row) and empty PENDING_AFTER_C_MERGE`).toBe(false);
    const missing = [...cited].filter((id) => !known.has(id) && !marked.has(id));
    expect(missing).toEqual([]);
    expect(cited.size).toBeGreaterThan(40);
    // A pending id is always written with its † (never cited unmarked elsewhere in the table).
    for (const id of PENDING_AFTER_C_MERGE)
      expect(DOC.split(`[[${id}]]`).length - 1, id).toBe(DOC.split(`[[${id}]]\`†`).length - 1);

    // Vectors: vendored ids, and `*` = UmbraDB's own 274a84f version.
    const vendored = new Set((JSON.parse(readFileSync(join(ROOT, "token-indexer/vendor/mip0018/vectors/manifest.json"), "utf8")) as { vectors: Array<{ id: string }> }).vectors.map((v) => v.id));
    const own = new Set((JSON.parse(readFileSync(join(ROOT, "token-indexer/mip0018/vectors-umbradb/manifest.json"), "utf8")) as { vectors: Array<{ id: string }> }).vectors.map((v) => v.id));
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

  it("[[mip0018.conformance.no-network-no-code]] the indexer's runtime code and the vendored codec contain no network client, no dynamic code and no child process (C-024, C-031: no URI is fetched, no identifier runs code); the check catches each forbidden form", () => {
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
    // codec. The browser page's own script (`ui/page.js`) is checked by the page guard of sub-plan C.
    const devOnly = new Set(["token-indexer/mip0018/run-vectors.ts", "token-indexer/mip0018/vector-adapter.ts", "token-indexer/mip0018/vector-adapter-pg.ts"]);
    const files = [...walk("token-indexer/mip0018", [".ts"]).filter((f) => !devOnly.has(f) && !f.startsWith("token-indexer/mip0018/vectors-umbradb/")),
      ...walk("token-indexer/vendor/mip0018/codec/src", [".ts"])];
    for (const f of ["scan.ts", "applied-parts.ts", "state.ts", "fields.ts", "metadata.ts", "tokens.ts", "activity.ts"]) expect(files).toContain(`token-indexer/mip0018/${f}`);
    expect(files.filter((f) => f.startsWith("token-indexer/vendor/")).length).toBeGreaterThanOrEqual(8);
    const found = Object.fromEntries(files.map((f): [string, string[]] => [f, violations(readFileSync(join(ROOT, f), "utf8"))]).filter(([, v]) => v.length > 0));
    expect(found).toEqual({});
  }, 60_000);
});
