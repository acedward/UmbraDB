import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * **"Project B has no database" as an import graph** (organizer spec FR-025; sub-plan 00009-08 v2;
 * owner questions Q24 and Q25).
 *
 * `schema-isolation.integration.test.ts` proves Rule B at RUNTIME with a restricted PostgreSQL
 * role, and with a literal scan that forbids the string `chain_archive` in project B's source.
 * Both stay. This suite proves the structural half, and under v2 it proves the STRONGEST form of
 * it: **no module under `shielded-monitor/` can reach `postgres`, or anything under
 * `src/postgres/`, by any chain of imports — static or dynamic.**
 *
 * ── Why the rule got stricter ───────────────────────────────────────────────────────────────
 * Q24 (v1) could only ban project A's *storage adapters*, because project B owned a PostgreSQL of
 * its own and therefore legitimately imported `src/postgres/client` and `src/postgres/migrate`.
 * The owner's Q25 decision removes B's database entirely: it reads and writes through
 * `STORAGE_URL`, so there is nothing left for it to open a connection with, and the ban can be
 * the simple, total one — no driver, no client, no migration runner, no archive adapter, no
 * schema-shaped SQL anywhere in B's import closure.
 *
 * Why a transitive walk rather than "B does not import X directly": a one-line re-export anywhere
 * in between would satisfy a direct-import check while leaving a `postgres` connection one
 * `import` away from every B module. The walk follows relative imports from every B file and
 * fails on the first path that reaches a banned module, printing the path.
 *
 * ── Dynamic imports are covered too, now ────────────────────────────────────────────────────
 * Under Q24 the one dynamic `await import("../src/postgres/archive-read-contract.js")` in
 * `archive-source.ts` was the documented escape hatch for the single-host mode, and this suite
 * had to say plainly that a static walk could not see it. That mode is gone, and with it the
 * dynamic import: the last case below asserts that **no** B module carries a dynamic import into
 * `src/postgres/` or `chain-archive-sync/` at all, so the static walk has no blind spot left.
 *
 * ── What it still does not prove ────────────────────────────────────────────────────────────
 * That the code is absent from the IMAGE. `dist-cli/` ships `src/postgres/**` because the storage
 * API needs it, and a TEE build that wanted B's image to contain none of it would build a
 * separate image. What this proves is the property a deployment depends on: a B process loads no
 * database code and holds no credential — and `no-database.ts` refuses to start if one is in its
 * environment anyway.
 */

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Project A's storage modules: the archive's own adapter, its lineage and its rollover.
 *
 * Every one of these carries archive schema knowledge and a write path into `chain_archive`.
 * Reaching any of them from B is the thing FR-025 forbids.
 */
const BANNED_PREFIXES = ["src/postgres/", "storage-api/"] as const;

/**
 * Individual A-side modules that are not under a banned prefix.
 *
 * `chain-archive-sync/` as a whole is NOT banned, and deliberately: two modules in it
 * (`extrinsic-decoder.ts`, `tx-replay-decoder.ts`) are pure ledger decoders with no database in
 * their import closure, and project B's `offers.ts` and `derive-key-cli.ts` legitimately use
 * them. What is banned is the part of that directory that opens and writes a database.
 */
const BANNED_FILES = ["chain-archive-sync/sync-service.ts", "chain-archive-sync/bootstrap.ts"] as const;

/** Package specifiers project B may not import, at any depth. `postgres` is the driver itself:
 *  reaching it would mean B can open a connection, which is precisely what Q25 removes. */
const BANNED_PACKAGES = ["postgres"] as const;

/**
 * The ONE waived directory (`spec/00016-dust-wallet-sync.md` §1 "The waiver", FR-017; owner
 * decision 2026-09-15).
 *
 * The TEE-side node's DUST wallet-sync module opens a second, read-only connection to the archive
 * database. The owner accepted that for this experiment, with its consequence written down: the
 * database can see which nullifiers a wallet asks about. A later project replaces the query with
 * an enclave-side copy and deletes this constant.
 *
 * What "waived" means here is narrow, and deliberately not "skip these files": a banned module
 * reached THROUGH a waived file is recorded as WAIVED and allowed; every other path to the same
 * banned module is still a violation. So `shielded-monitor/node/dust/db.ts` may import `postgres`,
 * and `scanner.ts` still may not — including via a re-export it adds inside the waived directory,
 * because the trail is what is inspected, not the endpoint.
 *
 * The waived set is then ASSERTED below, exactly, rather than merely tolerated: if this directory
 * ever reaches a third banned module, the suite says which one instead of passing.
 */
const WAIVED_PREFIXES = ["shielded-monitor/node/dust/"] as const;

/** The only B files outside the waived directory that may import it (plan 00016 D2.5a). */
const PERMITTED_DUST_IMPORTERS = [
  "shielded-monitor/node-cli.ts",
  "shielded-monitor/node/monitor-node.ts",
  "shielded-monitor/api/server.ts",
] as const;

function isWaived(relative: string): boolean {
  return WAIVED_PREFIXES.some((prefix) => relative.startsWith(prefix));
}

function bannedReason(relative: string): string | undefined {
  const prefix = BANNED_PREFIXES.find((p) => relative.startsWith(p));
  if (prefix !== undefined) return `under ${prefix}`;
  return (BANNED_FILES as readonly string[]).includes(relative) ? "an archive writer" : undefined;
}

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
  /** Banned module → the import path that reached it THROUGH a waived file (00016 FR-017).
   *  Allowed, and asserted to be exactly the expected set. */
  readonly waived: Map<string, string[]>;
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
  const waived = new Map<string, string[]>();
  const queue: { file: string; path: string[] }[] = entryFiles.map((file) => ({ file, path: [file] }));

  /** A reach is waived when the trail that produced it PASSED THROUGH a waived file — not when
   *  the banned module itself happens to be listed somewhere. That is what confines the waiver to
   *  one directory rather than to one dependency. */
  const record = (key: string, trail: readonly string[]): void => {
    const relativeTrail = trail.map((f) => path.relative(repoRoot, f));
    const target = relativeTrail.some(isWaived) ? waived : violations;
    if (!target.has(key)) target.set(key, relativeTrail);
  };

  while (queue.length > 0) {
    const { file, path: trail } = queue.shift()!;
    if (reached.has(file)) continue;
    reached.add(file);
    const relative = path.relative(repoRoot, file);
    if (bannedReason(relative) !== undefined) {
      record(relative, trail);
      continue;
    }
    for (const specifier of staticImportSpecifiers(readFile(file))) {
      if ((BANNED_PACKAGES as readonly string[]).includes(specifier)) {
        record(`package:${specifier}`, [...trail, file]);
        continue;
      }
      const target = resolveRelative(file, specifier);
      if (target !== undefined) queue.push({ file: target, path: [...trail, target] });
    }
  }
  return { violations, waived, reached };
}

const productionFiles = walkTsFiles(path.join(repoRoot, "shielded-monitor"));
const realRead = (file: string): string => readFileSync(file, "utf8");

describe("project B reaches no database at all (owner Rule B / FR-025, question Q25)", () => {
  it("the walk is not vacuous: it visits every B module and follows imports out of the directory", () => {
    expect(productionFiles.length).toBeGreaterThan(15);
    const { reached } = reachStatically(productionFiles, realRead);
    // It really does leave `shielded-monitor/` — B legitimately imports the read-contract
    // INTERFACE, the shared wire codecs and the ledger decoder. What it may not reach is storage.
    expect([...reached].some((f) => f.includes(path.join("src", "interfaces", "archive-read-contract")))).toBe(true);
    expect([...reached].some((f) => f.includes(path.join("src", "interfaces", "archive-read-wire")))).toBe(true);
    expect(reached.size).toBeGreaterThan(productionFiles.length);
  });

  it("[[shielded-monitor.import-boundary.no-database-in-project-b]] no import path from shielded-monitor/** reaches postgres, src/postgres/** or the storage API", () => {
    const { violations } = reachStatically(productionFiles, realRead);
    expect(
      [...violations.entries()].map(([banned, trail]) => `${banned} via ${trail.join(" -> ")}`),
    ).toStrictEqual([]);
  });

  it("the 00016 waiver reaches exactly `postgres` and the archive-conventions module", () => {
    // The waiver is asserted, not merely tolerated. These two are what spec 00016 D2.2 says the
    // DUST module needs: the driver, to open its own read-only connection, and A's published
    // schema-name constant, which exists precisely so a consumer never types `chain_archive`
    // itself (`schema-isolation.integration.test.ts` still forbids that literal, unwaived).
    const { waived } = reachStatically(productionFiles, realRead);
    expect([...waived.keys()].sort()).toStrictEqual([
      "package:postgres",
      "src/postgres/archive-conventions.ts",
    ]);
    // And each really did come through the waived directory.
    for (const trail of waived.values()) {
      expect(trail.some((file) => file.startsWith("shielded-monitor/node/dust/"))).toBe(true);
    }
  });

  it("only three B files outside the waived directory import it", () => {
    // The containment that makes the waiver a waiver. Database code reaches the rest of B only by
    // someone importing this directory from it, so the import edges INTO it are the thing to pin —
    // and they are three: the CLI that builds the module, the node that owns its lifecycle, and
    // the API that dispatches its routes.
    const importers = productionFiles
      .map((file) => path.relative(repoRoot, file))
      .filter((relative) => !isWaived(relative))
      .filter((relative) => {
        const source = realRead(path.join(repoRoot, relative));
        return [...staticImportSpecifiers(source), ...dynamicImportSpecifiers(source)].some((specifier) => {
          const target = resolveRelative(path.join(repoRoot, relative), specifier);
          return target !== undefined && isWaived(path.relative(repoRoot, target));
        });
      })
      .sort();
    for (const importer of importers) {
      expect(PERMITTED_DUST_IMPORTERS as readonly string[], `${importer} imports the waived directory`)
        .toContain(importer);
    }
    // Not vacuous: the module is actually wired in somewhere.
    expect(importers.length).toBeGreaterThan(0);
  });

  it("POSITIVE CONTROL: the waiver does NOT cover a B file outside the directory", () => {
    // The strongest thing to get wrong here would be a waiver that skips files rather than trails:
    // then `scanner.ts` could import `postgres` and the walk would call it waived because the DUST
    // directory is allowed to. It is the trail that is inspected, so this is still a violation.
    const planted = path.join(repoRoot, "shielded-monitor", "scanner.ts");
    const read = (file: string): string =>
      file === planted ? `import postgres from "postgres";\n${realRead(file)}` : realRead(file);
    const { violations, waived } = reachStatically(productionFiles, read);
    expect(violations.has("package:postgres")).toBe(true);
    expect(violations.get("package:postgres")!.some((f) => f.startsWith("shielded-monitor/node/dust/"))).toBe(false);
    // And the waived reach is still recorded separately, so one does not mask the other.
    expect(waived.has("package:postgres")).toBe(true);
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

  it("POSITIVE CONTROL: a planted import of the DRIVER itself is caught (Q25's tightening)", () => {
    // The v1 guard would have allowed this: `postgres` is not an archive storage module, and B
    // owned a database of its own. Under Q25 it is the single most important thing to forbid.
    const planted = path.join(repoRoot, "shielded-monitor", "node", "monitor-node.ts");
    const read = (file: string): string =>
      file === planted ? `import postgres from "postgres";\n${realRead(file)}` : realRead(file);
    const { violations } = reachStatically(productionFiles, read);
    expect(violations.has("package:postgres")).toBe(true);
  });

  it("POSITIVE CONTROL: a planted import of B's own former client is caught (`src/postgres/client`)", () => {
    // Also allowed under Q24 — it was how B opened its own database — and banned under Q25,
    // because B has no database to open.
    const planted = path.join(repoRoot, "shielded-monitor", "store.ts");
    const read = (file: string): string =>
      file === planted
        ? `import { createClient } from "../src/postgres/client.js";\n${realRead(file)}`
        : realRead(file);
    const { violations } = reachStatically(productionFiles, read);
    expect(violations.has("src/postgres/client.ts")).toBe(true);
  });

  it("POSITIVE CONTROL: a planted import of the A-side storage API is caught", () => {
    const planted = path.join(repoRoot, "shielded-monitor", "api", "server.ts");
    const read = (file: string): string =>
      file === planted
        ? `import { PgShieldedMonitorStore } from "../../storage-api/monitor-store-pg.js";\n${realRead(file)}`
        : realRead(file);
    const { violations } = reachStatically(productionFiles, read);
    expect(violations.has("storage-api/monitor-store-pg.ts")).toBe(true);
  });

  it("POSITIVE CONTROL: a planted import hidden one module DEEP is caught (the direct-import check that would miss it)", () => {
    // The whole reason the walk is transitive. `wake.ts` imports
    // `src/interfaces/archive-read-wire.ts`, a codec with no storage in it; give THAT one an
    // archive-storage import and no direct-import check over `shielded-monitor/**` would notice.
    const hop = path.join(repoRoot, "src", "interfaces", "archive-read-wire.ts");
    const read = (file: string): string =>
      file === hop
        ? `import { PgChainArchiveStore } from "../postgres/chain-archive-store.js";\n${realRead(file)}`
        : realRead(file);
    const { violations } = reachStatically(productionFiles, read);
    expect(violations.get("src/postgres/chain-archive-store.ts")).toBeDefined();
    expect(violations.get("src/postgres/chain-archive-store.ts")!.join(" -> ")).toContain("archive-read-wire.ts");
  });

  it("there is NO dynamic import into project A left — the static walk has no blind spot", () => {
    // Under Q24 there was exactly one, in `archive-source.ts`, and it was the documented escape
    // hatch for the single-host mode. Q25 removed that mode, so the exception is gone and the
    // static walk above is now a complete argument rather than half of one.
    const dynamic = productionFiles
      .flatMap((file) => dynamicImportSpecifiers(realRead(file)).map((s) => ({ file: path.relative(repoRoot, file), s })))
      .filter(({ s }) => s.includes("src/postgres/") || s.includes("chain-archive-sync/") || s.includes("storage-api/") || s === "postgres");
    // The 00016 waiver does not extend to dynamic imports either: the DUST module's database
    // access is a STATIC import the walk above can see and account for, which is the only shape in
    // which "exactly these two modules" is a checkable claim.
    expect(dynamic).toStrictEqual([]);
  });
});
