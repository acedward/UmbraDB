/**
 * The runtime modules — what the engine, the archive sync, the MIP-0018 scan, the API and the migrations run — use no
 * Node API, so the same modules serve the Node build and the browser build. A static scan of the sources, three rules
 * per file:
 *
 * 1. no `node:*` or Node built-in module specifier (`fs`, `crypto`, …) in an import, a re-export, an `import()`, a
 *    `require()` or an import type;
 * 2. no identifier `Buffer` (value or type), and no `["Buffer"]` element access;
 * 3. no identifier whose every declaration is in `@types/node` (`process`, `require`, `setImmediate`, `NodeJS.*`, a
 *    `Buffer` method on a `Buffer`-typed value, …), resolved by the TypeScript checker. A global that a browser also
 *    has (`TextEncoder`, `fetch`, `setTimeout`, `console`) is declared by the DOM library too and passes.
 *
 * What is scanned: every module reached through value imports from {@link RUNTIME_ROOTS}, plus every module under
 * {@link RUNTIME_DIRS}, minus {@link NODE_ONLY} (Node tooling by design, which the runtime never imports). Modules in
 * {@link PENDING} still use a Node API and are allowed to; an entry fails the guard once its module no longer needs it.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Entry modules of the runtime: the engine and its system snapshot collector, the archive sync, the scan, the API, the
 * event listing, the migrations and the browser build's worker and pages.
 */
const RUNTIME_ROOTS = [
  "token-indexer/engine/engine.ts",
  "token-indexer/engine/system-collector.ts",
  "token-indexer/browser/worker.ts",
  "token-indexer/browser/engine-page.ts",
  "token-indexer/browser/explorer-page.ts",
  "token-indexer/browser/system-page.ts",
  "chain-archive-sync/sync-service.ts",
  "chain-archive-sync/bootstrap.ts",
  "chain-archive-sync/retry.ts",
  "token-indexer/mip0018/scan.ts",
  "token-indexer/mip0018/api.ts",
  "token-indexer/mip0018/api-views.ts",
  "token-indexer/mip0018/events.ts",
  "src/postgres/migrate.ts",
  "src/postgres/migrations/chain_archive/index.ts",
  "src/postgres/migrations/mip0018/index.ts",
];

/** Directories whose every module (tests and fixtures aside) is runtime code unless listed in {@link NODE_ONLY}. */
const RUNTIME_DIRS = ["chain-archive-sync", "token-indexer/browser", "token-indexer/engine", "token-indexer/mip0018"];

/** Node tooling inside {@link RUNTIME_DIRS}: never scanned, and never imported by a runtime module. */
const NODE_ONLY: Record<string, string> = {
  "chain-archive-sync/sync-cli.ts": "command-line entry point (arguments, signals, exit codes)",
  "chain-archive-sync/tx-replay-decoder.ts": "test-only decoder that loads a ledger build from a wallet checkout on disk",
  "token-indexer/browser/vite.config.ts": "the browser build's Vite configuration, run by Node",
  "token-indexer/browser/build-guard.ts": "a Vite plugin of the browser build, run by Node",
  "token-indexer/browser/build-csp.ts": "a Vite plugin of the browser build (the pages' security headers), run by Node",
  "token-indexer/browser/build-explorer.ts": "a Vite plugin of the browser build (the explorer page from the /ui page's markup), run by Node",
  "token-indexer/browser/build-notices.ts": "a Vite plugin of the browser build (the licence notices), run by Node",
  "token-indexer/mip0018/scan-cli.ts": "command-line entry point (arguments, signals, exit codes)",
  "token-indexer/mip0018/serve-cli.ts": "command-line entry point that starts the node:http server",
  "token-indexer/mip0018/api-node.ts": "serves the runtime-neutral API handler (api.ts) over node:http",
  "token-indexer/mip0018/run-vectors.ts": "starts the vendored vector runner as a child process",
  "token-indexer/mip0018/vector-adapter.ts": "vector consumer over stdin/stdout",
  "token-indexer/mip0018/vector-adapter-pg.ts": "vector consumer over stdin/stdout",
  "token-indexer/mip0018/vectors-umbradb/generate.ts": "writes the vector files to disk",
};

/** Runtime modules that use a Node API today, with the API. */
const PENDING: Record<string, string> = {
  "token-indexer/mip0018/ui/page.ts": "reads the page assets with readFileSync and hashes them for the CSP with node:crypto",
};

/** Modules the import walk must reach (a walk that stops early would scan nothing and pass). */
const MUST_REACH = [
  "src/postgres/chain-archive-store.ts",
  "src/postgres/bytes.ts",
  "src/postgres/durability-probe.ts",
  "chain-archive-sync/indexer-client.ts",
  "chain-archive-sync/node-rpc-client.ts",
  "token-indexer/mip0018/applied-parts.ts",
  "token-indexer/mip0018/activity.ts",
  "token-indexer/mip0018/fields.ts",
  "token-indexer/mip0018/metadata.ts",
  "token-indexer/mip0018/bytes.ts",
  "token-indexer/vendor/mip0018/codec/src/index.ts",
  "wallet-monitor/log.ts",
  "src/postgres/pglite-sql.ts",
  "src/postgres/schema-name.ts",
  "chain-archive-sync/archive-tape.ts",
  "chain-archive-sync/tape-replay.ts",
  "token-indexer/browser/host.ts",
  "token-indexer/browser/trusted-worker.ts",
  "token-indexer/browser/zod-jitless.ts",
  "token-indexer/browser/session.ts",
  "token-indexer/browser/host-system.ts",
  "token-indexer/browser/supervisor.ts",
  "token-indexer/engine/telemetry.ts",
  "token-indexer/browser/explorer-transport.ts",
  "token-indexer/mip0018/ui/page.js",
  "token-indexer/browser/snapshot.ts",
  "token-indexer/browser/snapshot-store.ts",
  "token-indexer/browser/store-identity.ts",
  "token-indexer/browser/snapshot-page.ts",
  "token-indexer/browser/system-model.ts",
  "token-indexer/browser/visible-text.ts",
];

const rel = (abs: string): string => path.relative(ROOT, abs).split(path.sep).join("/");

interface Specifier { spec: string; typeOnly: boolean; node: ts.Node }

/** Every module specifier of a file: imports, re-exports, `import x = require()`, `import()`, `require()`, import types. */
export function moduleSpecifiers(sf: ts.SourceFile): Specifier[] {
  const out: Specifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const c = node.importClause;
      const named = c?.namedBindings !== undefined && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements : undefined;
      const typeOnly = c !== undefined && (c.isTypeOnly || (c.name === undefined && named !== undefined && named.length > 0 && named.every((e) => e.isTypeOnly)));
      out.push({ spec: node.moduleSpecifier.text, typeOnly, node });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      const named = node.exportClause !== undefined && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : undefined;
      const typeOnly = node.isTypeOnly || (named !== undefined && named.length > 0 && named.every((e) => e.isTypeOnly));
      out.push({ spec: node.moduleSpecifier.text, typeOnly, node });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      out.push({ spec: node.moduleReference.expression.text, typeOnly: node.isTypeOnly, node });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      out.push({ spec: node.argument.literal.text, typeOnly: true, node });
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0]!)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isImport || isRequire) out.push({ spec: (node.arguments[0] as ts.StringLiteralLike).text, typeOnly: false, node });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const isNodeModule = (spec: string): boolean => spec.startsWith("node:") || builtinModules.includes(spec);

/** Where `@types/node` declares Node's API (the checker reports file names with `/` on every platform). */
const NODE_TYPES = "/node_modules/@types/node/";

/** Rule 1 and 2 (syntax only) and, given a checker, rule 3. Returns `line: what` strings. */
export function nodeApiUses(sf: ts.SourceFile, checker?: ts.TypeChecker): string[] {
  const out = new Set<string>();
  const at = (node: ts.Node, what: string): void => {
    out.add(`${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${what}`);
  };
  for (const s of moduleSpecifiers(sf)) if (isNodeModule(s.spec)) at(s.node, `imports ${s.spec}`);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (node.text === "Buffer") at(node, "uses Buffer");
      else if (checker !== undefined) {
        let symbol = checker.getSymbolAtLocation(node);
        if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        const decls = symbol?.declarations ?? [];
        if (decls.length > 0 && decls.every((d) => d.getSourceFile().fileName.includes(NODE_TYPES)))
          at(node, `uses ${node.text} (declared only by @types/node)`);
      }
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === "Buffer") {
      at(node, "uses Buffer");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...out];
}

const parse = (file: string): ts.SourceFile => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);

/** The absolute path a relative specifier names, as the bundler resolves it: a JavaScript file that exists is that file
 *  (the explorer script `ui/page.js`, beside the Node module `ui/page.ts`); otherwise `.js` → `.ts` as `NodeNext`
 *  resolves the sources. `undefined` when nothing matches. */
function resolveRelative(from: string, spec: string): string | undefined {
  const p = path.resolve(path.dirname(from), spec);
  const candidates = /\.(js|mjs)$/.test(p) && existsSync(p) ? [p] : [p.replace(/\.js$/, ".ts"), p, `${p}.ts`, path.join(p, "index.ts")];
  for (const c of candidates) if (existsSync(c) && !c.endsWith(path.sep)) return c;
  return undefined;
}

/** Modules reached from `roots` through value imports (type-only imports are erased and not followed). */
function runtimeClosure(roots: readonly string[]): { files: Set<string>; unresolved: string[] } {
  const files = new Set<string>();
  const unresolved: string[] = [];
  const queue = roots.map((r) => path.join(ROOT, r));
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const s of moduleSpecifiers(parse(file))) {
      if (s.typeOnly || !s.spec.startsWith(".")) continue;
      const target = resolveRelative(file, s.spec);
      if (target === undefined) unresolved.push(`${rel(file)} → ${s.spec}`);
      else queue.push(target);
    }
  }
  return { files, unresolved };
}

function moduleFiles(dir: string): string[] {
  return (readdirSync(path.join(ROOT, dir), { recursive: true }) as string[])
    .filter((f) => /\.(ts|js|mjs)$/.test(f) && !/\.test\.ts$/.test(f) && !f.split(path.sep).includes("fixtures"))
    .map((f) => path.join(ROOT, dir, f));
}

const closure = runtimeClosure(RUNTIME_ROOTS);
const scanned = [...new Set([...closure.files, ...RUNTIME_DIRS.flatMap(moduleFiles)])].filter((f) => !(rel(f) in NODE_ONLY)).sort();

/** The repository's compiler options (`tsconfig.json`), for a program that only binds and checks. */
const compilerOptions = (): ts.CompilerOptions => ({
  ...ts.parseJsonConfigFileContent(ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile).config, ts.sys, ROOT).options,
  allowJs: true,
  checkJs: false,
  noEmit: true,
});

let program: ts.Program | undefined;

/** Rules 1–3 for one scanned file (one program over every scanned file, built on first use). */
function usesOf(file: string): string[] {
  program ??= ts.createProgram(scanned, compilerOptions());
  const sf = program.getSourceFile(file);
  if (sf === undefined) throw new Error(`${rel(file)} is not in the checked program`);
  return nodeApiUses(sf, program.getTypeChecker());
}

describe("runtime modules use no Node API", () => {
  it("[[runtime.node-free.walk]] the import walk from the runtime entry modules resolves every relative import and reaches the core modules", () => {
    expect(closure.unresolved).toEqual([]);
    const reached = [...closure.files].map(rel);
    for (const m of MUST_REACH) expect(reached, m).toContain(m);
  });

  it("[[runtime.node-free.rules]] no runtime module imports a Node module or uses Buffer or another Node-only global (allow-list aside)", () => {
    expect(scanned.length).toBeGreaterThan(MUST_REACH.length);
    const found: string[] = [];
    for (const file of scanned) {
      if (rel(file) in PENDING) continue;
      for (const use of usesOf(file)) found.push(`${rel(file)}:${use}`);
    }
    expect(found).toEqual([]);
  }, 120_000);

  it("[[runtime.node-free.allow-list]] every allow-listed module is scanned and still uses a Node API (an entry it no longer needs fails here)", () => {
    const names = scanned.map(rel);
    for (const [m, why] of Object.entries(PENDING)) {
      expect(why.length).toBeGreaterThan(0);
      expect(names, `${m} is not a scanned runtime module`).toContain(m);
      expect(usesOf(path.join(ROOT, m)), `${m} no longer uses a Node API: remove it from PENDING`).not.toEqual([]);
    }
  }, 120_000);

  it("[[runtime.node-free.no-postgres-js]] the browser build's worker and pages never load the PostgreSQL client (postgres.js), not even through a dynamic import; the explorer page loads the explorer script, not the Node page module", () => {
    const browser = runtimeClosure(["token-indexer/browser/worker.ts", "token-indexer/browser/engine-page.ts", "token-indexer/browser/explorer-page.ts", "token-indexer/browser/system-page.ts"]);
    expect(browser.unresolved).toEqual([]);
    const reached = [...browser.files].map(rel);
    expect(reached).toContain("src/postgres/migrate.ts");
    expect(reached).toContain("token-indexer/mip0018/scan.ts");
    expect(reached).not.toContain("src/postgres/client.ts");
    expect(reached).toContain("token-indexer/mip0018/ui/page.js");
    expect(reached).not.toContain("token-indexer/mip0018/ui/page.ts");
  });

  it("[[runtime.node-free.tooling]] Node tooling exists and no runtime module imports it", () => {
    const reached = new Set([...closure.files].map(rel));
    for (const [m, why] of Object.entries(NODE_ONLY)) {
      expect(why.length).toBeGreaterThan(0);
      expect(existsSync(path.join(ROOT, m)), m).toBe(true);
      expect(reached.has(m), `${m} is imported by the runtime`).toBe(false);
    }
  });

  it("[[runtime.node-free.negative-control]] negative control: the rules flag every Node API shape and nothing in comments or strings", () => {
    const bad = [
      'import { readFileSync } from "node:fs";',
      'import path from "path";',
      'import type { Server } from "node:http";',
      'export * from "node:crypto";',
      'export { createHash } from "crypto";',
      'import os = require("os");',
      'const z = await import("node:zlib");',
      'const u = require("node:url");',
      'let t: import("node:net").Socket;',
      "const b = Buffer.from([1]);",
      "const c = (x: Uint8Array) => x as Buffer;",
      'const g = (globalThis as Record<string, unknown>)["Buffer"];',
      "const e = process.env.HOME;",
      "setImmediate(() => {});",
    ];
    const good = [
      "// Buffer and node:fs in a comment",
      "/** `Buffer#toString(\"hex\")`, `process.env` */",
      'const s = "a Buffer, node:fs, process";',
      "const enc = new TextEncoder().encode(\"x\");",
      "setTimeout(() => {}, 1);",
      "const h = { process: 1 }.process;",
    ];
    const dir = path.join(ROOT, "token-indexer", "test");
    const options = compilerOptions();
    const sources = new Map([...bad.map((l, i) => [path.join(dir, `__bad${i}.ts`), l] as const), ...good.map((l, i) => [path.join(dir, `__good${i}.ts`), l] as const)]);
    const host = ts.createCompilerHost(options);
    const read = host.readFile.bind(host);
    host.readFile = (f) => sources.get(path.resolve(f)) ?? read(f);
    const exists = host.fileExists.bind(host);
    host.fileExists = (f) => sources.has(path.resolve(f)) || exists(f);
    const getSf = host.getSourceFile.bind(host);
    host.getSourceFile = (f, v, ...rest) => {
      const text = sources.get(path.resolve(f));
      return text === undefined ? getSf(f, v, ...rest) : ts.createSourceFile(f, `export {};\n${text}`, v, true);
    };
    const p = ts.createProgram([...sources.keys()], options, host);
    const c = p.getTypeChecker();
    for (const [f, line] of sources) {
      const uses = nodeApiUses(p.getSourceFile(f)!, c);
      if (path.basename(f).startsWith("__bad")) expect(uses, line).not.toEqual([]);
      else expect(uses, line).toEqual([]);
    }
  }, 120_000);
});
