/**
 * The licence notices the static build writes (`token-indexer/browser/build-notices.ts`).
 *
 * - `[[browser.build.notices]]` — the build's `THIRD-PARTY-NOTICES.txt` lists every package its page and worker modules
 *   contain, each with its version, licence and licence text (PGlite, ledger-v9 from its repository's licence, zod,
 *   `@noble/hashes`), every vendored work they contain (the MIP-0018 reference codec, with its `NOTICE` and licence),
 *   the PostgreSQL licence of PGlite's database, the Outfit font's SIL Open Font License, and UmbraDB's notice and
 *   licence; a package that ships no licence text and is not known fails the build.
 * - `[[browser.build.notices-rules]]` — module ids map to their package directories, or, outside `node_modules`, to the
 *   vendored work they belong to (the nearest directory below the repository root with a licence file); a module in a
 *   `vendor/` directory whose work has no licence file, or outside both the repository and `node_modules`, fails the
 *   build; a package without a licence text that is not known fails too.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NOTICES_FILE, noticesText, packageDirOf, vendoredWorkOf } from "../browser/build-notices.ts";
import { CONTENT_TYPES } from "../dev/serve-browser.ts";
import { buildEngineSite, NO_AUTO_START, REPO_ROOT } from "./helpers/engine-site.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The section titles of a notices text (the line after each rule). */
const titles = (text: string): string[] => [...text.matchAll(/^={80}\n(.+)\n={80}$/gm)].map((m) => m[1]!);

describe("licence notices of the static build", () => {
  it("[[browser.build.notices]] the build writes THIRD-PARTY-NOTICES.txt: every bundled package with its version, licence and text, every bundled vendored work with its NOTICE and licence, PostgreSQL's licence, the Outfit font's OFL and UmbraDB's notice and licence; an unknown package without a licence text fails the build", async () => {
    const out = await buildEngineSite(NO_AUTO_START);
    dirs.push(out);
    const text = readFileSync(join(out, NOTICES_FILE), "utf8");
    const version = (name: string): string => (JSON.parse(readFileSync(join(REPO_ROOT, "node_modules", name, "package.json"), "utf8")) as { version: string }).version;
    const sections = titles(text);
    expect(sections[0]).toBe("UmbraDB: NOTICE");
    expect(sections.at(-1)).toBe("UmbraDB: Apache License, Version 2.0");
    expect(sections).toEqual(expect.arrayContaining([
      `@electric-sql/pglite ${version("@electric-sql/pglite")}: Apache-2.0`,
      `@midnightntwrk/ledger-v9 ${version("@midnightntwrk/ledger-v9")}: Apache-2.0`,
      `zod ${version("zod")}: MIT`,
      `@noble/hashes ${version("@noble/hashes")}: MIT`,
      "PostgreSQL, in PGlite's database files (pglite.wasm, pglite.data, initdb.wasm): PostgreSQL Licence",
      "Outfit, the font of the explorer's style (assets/Outfit-Variable-latin-*.woff2): SIL Open Font License 1.1",
      "Vendored in token-indexer/vendor/mip0018: MIP-0018 reference implementation (midnight-experiments/mip-0018), Apache-2.0",
    ]));
    // The vendored codec (its modules are in the worker's and the page's bundles): its NOTICE and its licence.
    const vendored = text.slice(text.indexOf("Vendored in token-indexer/vendor/mip0018"));
    expect(vendored).toContain(readFileSync(join(REPO_ROOT, "token-indexer/vendor/mip0018/NOTICE"), "utf8").trim());
    expect(vendored).toContain(readFileSync(join(REPO_ROOT, "token-indexer/vendor/mip0018/LICENSE"), "utf8").trim());
    // The texts themselves, not only their titles.
    expect(text).toContain(readFileSync(join(REPO_ROOT, "node_modules/@electric-sql/pglite/LICENSE"), "utf8").trim());
    expect(text).toContain(readFileSync(join(REPO_ROOT, "node_modules/zod/LICENSE"), "utf8").trim());
    expect(text).toContain(readFileSync(join(REPO_ROOT, "token-indexer/mip0018/ui/fonts/OFL.txt"), "utf8").trim());
    expect(text).toContain("Portions Copyright (c) 1994, The Regents of the University of California");
    expect(text).toContain("(from https://github.com/midnightntwrk/midnight-ledger (LICENSE))");
    expect(text).toContain(readFileSync(join(REPO_ROOT, "NOTICE"), "utf8").trim());
    // Every package section names the package, its version and its licence.
    for (const s of sections.slice(1, -3).filter((x) => !x.startsWith("Vendored in "))) expect(s).toMatch(/^(@[a-z0-9-]+\/)?[a-z0-9.-]+ \S+: \S/);
    expect(CONTENT_TYPES[".txt"]).toBe("text/plain; charset=utf-8");
  }, 300_000);

  it("[[browser.build.notices-rules]] module ids map to their package directories or vendored works; a vendored module whose work has no licence file, a module outside the repository and node_modules, and a package that ships no licence text and is not known fail; one that ships it is listed with it", () => {
    expect(packageDirOf("/r/node_modules/zod/v4/core/core.js")).toBe("/r/node_modules/zod");
    expect(packageDirOf("/r/node_modules/@noble/hashes/sha2.js?x=1")).toBe("/r/node_modules/@noble/hashes");
    expect(packageDirOf("\0/r/node_modules/a/node_modules/@s/b/i.js")).toBe("/r/node_modules/a/node_modules/@s/b");
    expect(packageDirOf("/r/token-indexer/browser/host.ts")).toBeUndefined();
    const root = mkdtempSync(join(tmpdir(), "umbradb-notices-"));
    dirs.push(root);
    const pkg = (name: string, files: Record<string, string>): string => {
      const d = join(root, "node_modules", name);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "package.json"), JSON.stringify({ name, version: "1.2.3", license: "MIT" }));
      for (const [f, t] of Object.entries(files)) writeFileSync(join(d, f), t);
      return d;
    };
    const listed = pkg("listed-pkg", { "LICENSE.md": "MIT License text of listed-pkg" });
    const bare = pkg("bare-pkg", {});
    const text = noticesText(REPO_ROOT, [listed]);
    expect(titles(text)).toContain("listed-pkg 1.2.3: MIT");
    expect(text).toContain("MIT License text of listed-pkg");
    expect(() => noticesText(REPO_ROOT, [listed, bare])).toThrow("bare-pkg is in the browser build but ships no licence text and is not in KNOWN_LICENCES");

    // Modules outside node_modules: UmbraDB's own, or a vendored work (the nearest directory below the root with a
    // licence file).
    const repo = join(root, "repo");
    const file = (rel: string, text = "export {};\n"): string => {
      mkdirSync(join(repo, rel, ".."), { recursive: true });
      writeFileSync(join(repo, rel), text);
      return join(repo, rel);
    };
    file("LICENSE", "UmbraDB's licence");
    const own = file("token-indexer/browser/host.ts");
    const codec = file("token-indexer/vendor/lib/codec/src/index.ts");
    file("token-indexer/vendor/lib/LICENSE", "MIT License text of lib");
    file("token-indexer/vendor/lib/NOTICE", "lib, by its authors");
    const unlicensed = file("token-indexer/vendor/other/src/a.ts");
    expect(vendoredWorkOf(own, repo)).toBeUndefined();
    expect(vendoredWorkOf(`${codec}?worker`, repo)).toBe(join(repo, "token-indexer/vendor/lib"));
    expect(vendoredWorkOf("\0vite/preload-helper.js", repo)).toBeUndefined();
    expect(vendoredWorkOf(join(repo, "node_modules/zod/index.js"), repo)).toBeUndefined();
    expect(() => vendoredWorkOf(unlicensed, repo)).toThrow("token-indexer/vendor/other/src/a.ts is vendored code in the browser build but its work has no licence file");
    writeFileSync(join(root, "elsewhere.ts"), "export {};\n");
    expect(() => vendoredWorkOf(join(root, "elsewhere.ts"), repo)).toThrow(/is in the browser build but is neither in the repository nor in a package/);
    const withLib = noticesText(REPO_ROOT, [listed], [join(repo, "token-indexer/vendor/lib")], repo);
    expect(titles(withLib)).toContain("Vendored in token-indexer/vendor/lib: lib, by its authors, MIT");
    expect(withLib).toContain("MIT License text of lib");
  });
});
