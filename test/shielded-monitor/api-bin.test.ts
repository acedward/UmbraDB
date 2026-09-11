import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The two new CLI entry points are real (organizer spec FR-026: the API and the scanner must be
 * shippable CLI entry points of the same package).
 *
 * A `bin` entry pointing at a file the build never emits is a broken published package that
 * nothing else in this repository would catch: `npm run build` succeeds, `npm pack` succeeds, and
 * the failure appears only when a consumer runs the command. So rather than trusting the two
 * paths to agree by inspection, this test derives the expected output path from `tsconfig.cli.json`
 * (`rootDir` + `outDir` + the source file, `.ts` → `.js`) and asserts the `bin` target is exactly
 * that — and that the source file is inside an `include` pattern, which is what actually decides
 * whether `tsc` emits it at all.
 *
 * No Docker, no build required: the check is structural.
 */
describe("shielded-monitor CLI entry points (FR-026)", () => {
  const repoRoot = new URL("../../", import.meta.url);
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("package.json", repoRoot)), "utf8")) as {
    bin: Record<string, string>;
  };
  const cliTsconfig = JSON.parse(
    readFileSync(fileURLToPath(new URL("tsconfig.cli.json", repoRoot)), "utf8"),
  ) as { compilerOptions: { outDir: string; rootDir: string }; include: string[] };

  const entries: ReadonlyArray<readonly [string, string]> = [
    // 00009-05: the scanner bin joined the other two when Phase 3 merged with Phase 4. On
    // Phase 4's branch there was no scanner module, so the entry could not be declared; here it
    // is declared AND emitted, which is what the rule below actually asks for.
    ["umbradb-shielded-monitor", "shielded-monitor/scanner-cli.ts"],
    ["umbradb-shielded-monitor-api", "shielded-monitor/api/server-cli.ts"],
    ["umbradb-shielded-monitor-client", "shielded-monitor/client/cli.ts"],
    // 00009-06: `derive-viewing-key` is its own bin rather than a subcommand of the reference
    // client, because that client's import audit requires it to import nothing but Node built-ins
    // and this command must load the ledger WASM (organizer question Q20).
    ["umbradb-shielded-monitor-derive-key", "shielded-monitor/derive-key-cli.ts"],
  ];

  it.each(entries)("%s names the file tsc emits for %s", (binName, source) => {
    expect(pkg.bin[binName], `${binName} must be declared in package.json bin`).toBeDefined();

    // `rootDir: "."` + `outDir: "dist-cli"` means `a/b.ts` is emitted at `dist-cli/a/b.js`.
    expect(cliTsconfig.compilerOptions.rootDir).toBe(".");
    const expected = `${cliTsconfig.compilerOptions.outDir}/${source.replace(/\.ts$/, ".js")}`;
    expect(pkg.bin[binName]).toBe(expected);

    // The emit only happens if the source is covered by an `include` pattern; a `bin` path that
    // is arithmetically right but points into a directory tsc was never told to compile is the
    // exact failure this asserts against.
    const directory = source.slice(0, source.indexOf("/"));
    expect(
      cliTsconfig.include.some((pattern) => pattern.startsWith(`${directory}/`)),
      `tsconfig.cli.json must include ${directory}/** for ${binName} to be emitted`,
    ).toBe(true);

    // The source exists and declares itself runnable.
    const contents = readFileSync(fileURLToPath(new URL(source, repoRoot)), "utf8");
    expect(contents.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("declares no bin it cannot emit — EVERY entry, not only the ones listed above", () => {
    // The original form of this case (Phase 4) asserted the one bin that branch could not emit
    // was absent. The merge of Phases 1-4 makes that assertion false for the right reason — the
    // scanner exists now — so it is replaced by the GENERAL rule it was a special case of, which
    // also covers the two archive bins and any bin a future phase adds: a declared `bin` must
    // name `dist-cli/<source>.js` for a source file that exists, carries a shebang, and sits
    // under an `include` pattern of `tsconfig.cli.json`. A bin that cannot be emitted still
    // fails here; it simply no longer has to be named in advance.
    const outDir = cliTsconfig.compilerOptions.outDir;
    for (const [binName, target] of Object.entries(pkg.bin)) {
      expect(target.startsWith(`${outDir}/`), `${binName} must be emitted into ${outDir}/`).toBe(true);
      expect(target.endsWith(".js"), `${binName} must name a .js file`).toBe(true);
      const source = `${target.slice(outDir.length + 1, -".js".length)}.ts`;
      const directory = source.slice(0, source.indexOf("/"));
      expect(
        cliTsconfig.include.some((pattern) => pattern.startsWith(`${directory}/`)),
        `tsconfig.cli.json must include ${directory}/** for ${binName} to be emitted`,
      ).toBe(true);
      const contents = readFileSync(fileURLToPath(new URL(source, repoRoot)), "utf8");
      expect(contents.startsWith("#!/usr/bin/env node"), `${source} must be runnable`).toBe(true);
    }
    // Non-vacuity: the loop must actually have examined the six bins this package ships.
    // 5 -> 6 (00009-06): `umbradb-shielded-monitor-derive-key`. The pin is bumped deliberately,
    // which is the whole point of having one — an accidental bin still fails here.
    expect(Object.keys(pkg.bin).length).toBe(6);
  });

  it("leaves the published LIBRARY surface alone", () => {
    // `tsconfig.build.json` produces `dist/` and the frozen barrel that `test/api-surface/*`
    // pins. Only the CLI tsconfig gained the new directory; if this ever changes, the frozen
    // surface tests should be the ones consulted, not silently widened here.
    const buildTsconfig = JSON.parse(
      readFileSync(fileURLToPath(new URL("tsconfig.build.json", repoRoot)), "utf8"),
    ) as { include?: string[] };
    expect(buildTsconfig.include?.some((p) => p.includes("shielded-monitor")) ?? false).toBe(false);
  });
});
