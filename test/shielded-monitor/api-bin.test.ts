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
    ["umbradb-shielded-monitor-api", "shielded-monitor/api/server-cli.ts"],
    ["umbradb-shielded-monitor-client", "shielded-monitor/client/cli.ts"],
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

  it("does not declare a scanner bin it cannot emit", () => {
    // Phase 3 owns `umbradb-shielded-monitor` (the scanner). There is no scanner module on this
    // branch, so declaring the entry now would publish a package whose command does not exist.
    expect(pkg.bin["umbradb-shielded-monitor"]).toBeUndefined();
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
