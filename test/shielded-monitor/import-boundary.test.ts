import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **Owner Rule B as an import graph** (organizer spec FR-025; sub-plan 00009-08).
 *
 * `schema-isolation.integration.test.ts` already proves Rule B at RUNTIME, with a PostgreSQL role
 * that cannot write to the archive, and with a literal scan that forbids the string
 * `chain_archive` in project B's source. Both stay. This suite adds the third thing 00009-08 needs
 * and neither of those gives: **no module under `shielded-monitor/` can reach project A's storage
 * adapter at all, by any chain of static imports.**
 *
 * Why that is the property worth checking rather than "B does not import X directly": a one-line
 * re-export anywhere in between would satisfy a direct-import check while leaving the archive's
 * schema-shaped SQL — and its `postgres` connection — one `import` away from every B module. The
 * walk below follows relative imports transitively from every B file and fails on the first path
 * that reaches a banned module, printing the path.
 *
 * ── What this does NOT prove, stated plainly ────────────────────────────────────────────────
 * `shielded-monitor/archive-source.ts` reaches `PgArchiveReadContract` through a DYNAMIC
 * `await import(...)`, deliberately, so that the single-host deployment this repository already
 * ships keeps working (organizer question Q24). A dynamic import is invisible to a static walk, so
 * this suite does not show that module is unloadable — it shows that no B module *statically*
 * depends on A's storage, which is what makes the dependency exactly as conditional as the mode
 * that needs it. The complementary claim — that with `ARCHIVE_URL` set the loader is never called
 * at all — is proved by `archive-source.test.ts` with a spy loader. Neither test is sufficient
 * alone; the pair is the argument.
 *
 * `src/postgres/client.ts` and `src/postgres/migrate.ts` are NOT banned. They are how project B
 * talks to **its own** database, which Rule B requires it to own and to keep restorable by itself.
 * Banning them would forbid B from having storage at all (Q24 option B).
 */

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Project A's storage modules: the archive's own adapter, its lineage and its rollover.
 *
 * Every one of these carries archive schema knowledge and a write path into `chain_archive`.
 * Reaching any of them from B is the thing FR-025 forbids.
 */
const BANNED = [
  "src/postgres/archive-read-contract.ts",
  "src/postgres/chain-archive-store.ts",
  "src/postgres/chain-archive-rollover.ts",
  "src/postgres/migrations/chain_archive/index.ts",
  "chain-archive-sync/sync-service.ts",
  "chain-archive-sync/bootstrap.ts",
] as const;

/** Every `from "…"` / `import("…")` / `require("…")` specifier in a source file, comments stripped
 *  so a path named in prose is not mistaken for a dependency. */
export function staticImportSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const specifiers: string[] = [];
  // `from "x"` covers `import … from` and `export … from`; `import "x"` covers side-effect
  // imports; `import("x")` is listed too so the walk can REPORT dynamic imports separately rather
  // than pretend they do not exist.
  for (const match of code.matchAll(/\bfrom\s*["']([^"']+)["']/g)) specifiers.push(match[1]!);
  for (const match of code.matchAll(/\bimport\s*["']([^"']+)["']/g)) specifiers.push(match[1]!);
  return specifiers;
}

export function dynamicImportSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return [...code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!);
}

function walkTsFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((p) => p.endsWith(".ts"))
    .map((rel) => path.join(dir, rel));
}

/** Resolves a relative specifier the way NodeNext does for this repository: `./x.js` → `./x.ts`. */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined; // a package, not a repo module
  const target = path.resolve(path.dirname(fromFile), specifier.replace(/\.js$/, ".ts"));
  return existsSync(target) ? target : undefined;
}

export interface ReachResult {
  /** Banned module → the import path that reached it, repo-relative. */
  readonly violations: Map<string, string[]>;
  /** Every repo file reachable statically from the entry points. */
  readonly reached: Set<string>;
}

/**
 * Breadth-first over static imports.
 *
 * `readFile` is injected so the same walk can run over the REAL tree and over the real tree with
 * one file's bytes replaced — which is what makes the positive control below a control and not a
 * second, differently-written checker.
 */
export function reachStatically(
  entryFiles: readonly string[],
  readFile: (file: string) => string,
): ReachResult {
  const reached = new Set<string>();
  const violations = new Map<string, string[]>();
  const queue: { file: string; path: string[] }[] = entryFiles.map((file) => ({ file, path: [file] }));

  while (queue.length > 0) {
    const { file, path: trail } = queue.shift()!;
    if (reached.has(file)) continue;
    reached.add(file);
    const relative = path.relative(repoRoot, file);
    if ((BANNED as readonly string[]).includes(relative) && !violations.has(relative)) {
      violations.set(relative, trail.map((f) => path.relative(repoRoot, f)));
      continue;
    }
    for (const specifier of staticImportSpecifiers(readFile(file))) {
      const target = resolveRelative(file, specifier);
      if (target !== undefined) queue.push({ file: target, path: [...trail, target] });
    }
  }
  return { violations, reached };
}

const productionFiles = walkTsFiles(path.join(repoRoot, "shielded-monitor"));
const realRead = (file: string): string => readFileSync(file, "utf8");

describe("project B never statically reaches project A's storage (owner Rule B / FR-025)", () => {
  it("the walk is not vacuous: it visits every B module and follows imports out of the directory", () => {
    expect(productionFiles.length).toBeGreaterThan(15);
    const { reached } = reachStatically(productionFiles, realRead);
    // It really does leave `shielded-monitor/` — B legitimately imports the read-contract
    // INTERFACE, its own database client and the ledger decoder.
    expect([...reached].some((f) => f.includes(path.join("src", "interfaces", "archive-read-contract")))).toBe(true);
    expect([...reached].some((f) => f.includes(path.join("src", "postgres", "client")))).toBe(true);
    expect(reached.size).toBeGreaterThan(productionFiles.length);
  });

  it("no import path from shielded-monitor/** reaches an archive storage module", () => {
    const { violations } = reachStatically(productionFiles, realRead);
    expect(
      [...violations.entries()].map(([banned, trail]) => `${banned} via ${trail.join(" -> ")}`),
    ).toStrictEqual([]);
  });

  it("POSITIVE CONTROL: a planted direct import is caught", () => {
    const planted = path.join(repoRoot, "shielded-monitor", "scanner.ts");
    const read = (file: string): string =>
      file === planted
        ? `import { PgArchiveReadContract } from "../src/postgres/archive-read-contract.js";\n${realRead(file)}`
        : realRead(file);
    const { violations } = reachStatically(productionFiles, read);
    expect(violations.has("src/postgres/archive-read-contract.ts")).toBe(true);
  });

  it("POSITIVE CONTROL: a planted import hidden one module DEEP is caught (the direct-import check that would miss it)", () => {
    // The whole reason the walk is transitive. `wake.ts` imports `archive-conventions.ts`, a
    // dependency-free constants module; give THAT one an archive-storage import and no
    // direct-import check over `shielded-monitor/**` would notice.
    const hop = path.join(repoRoot, "src", "postgres", "archive-conventions.ts");
    const read = (file: string): string =>
      file === hop
        ? `import { PgChainArchiveStore } from "./chain-archive-store.js";\n${realRead(file)}`
        : realRead(file);
    const { violations } = reachStatically(productionFiles, read);
    expect(violations.get("src/postgres/chain-archive-store.ts")).toBeDefined();
    expect(violations.get("src/postgres/chain-archive-store.ts")!.join(" -> ")).toContain("archive-conventions.ts");
  });

  it("the ONE dynamic import into project A is in archive-source.ts, and nowhere else", () => {
    // Stated as a pin rather than left implicit: the dynamic import is the documented escape
    // hatch for the single-host mode (Q24), and a second one appearing elsewhere would be a new,
    // undocumented path into A's storage that the static walk above is blind to by construction.
    const dynamic = productionFiles
      .flatMap((file) => dynamicImportSpecifiers(realRead(file)).map((s) => ({ file: path.relative(repoRoot, file), s })))
      .filter(({ s }) => s.includes("src/postgres/") || s.includes("chain-archive-sync/"));
    expect(dynamic).toStrictEqual([
      { file: "shielded-monitor/archive-source.ts", s: "../src/postgres/archive-read-contract.js" },
    ]);
  });
});
