/**
 * The licence notices of the static build: `THIRD-PARTY-NOTICES.txt` at the root of `dist-browser/`, so a host that
 * publishes the folder publishes them with the works they cover.
 *
 * - Every package whose code the page or worker bundles contain is listed, found from the bundled modules (a package
 *   added later is listed too), with its name, version, licence and the licence text it ships. A package that ships
 *   none is taken from {@link KNOWN_LICENCES} (its repository's licence); a package in neither fails the build, so
 *   nothing is published without its notice.
 * - PGlite's database (`pglite.wasm`, `pglite.data`, `initdb.wasm`) is PostgreSQL: its licence follows PGlite's
 *   (`notices/POSTGRES-LICENSE`, PGlite's own copy).
 * - The Outfit font the explorer's style uses, under the SIL Open Font License (`../mip0018/ui/fonts/OFL.txt`).
 * - UmbraDB's own licence and notice (the repository's `LICENSE` and `NOTICE`).
 *
 * One collector serves the page build and the worker builds (`plugin()` for each); the page build, whose bundle is
 * written after its workers', writes the file.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

export const NOTICES_FILE = "THIRD-PARTY-NOTICES.txt";

/** Licences of packages that ship no licence text, from their repositories. */
export const KNOWN_LICENCES: Readonly<Record<string, { licence: string; text: "apache-2.0"; source: string }>> = {
  "@midnightntwrk/ledger-v9": { licence: "Apache-2.0", text: "apache-2.0", source: "https://github.com/midnightntwrk/midnight-ledger (LICENSE)" },
};

const LICENCE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;
const RULE = "=".repeat(80);

/** The package directory (`…/node_modules/<name>` or `…/node_modules/@scope/<name>`) of a bundled module, if any. */
export function packageDirOf(moduleId: string): string | undefined {
  const id = moduleId.replace(/^\0/, "").replace(/\?.*$/, "").split(path.sep).join("/");
  const at = id.lastIndexOf("/node_modules/");
  if (at < 0) return undefined;
  const rest = id.slice(at + "/node_modules/".length).split("/");
  const name = rest[0]?.startsWith("@") ? rest.slice(0, 2).join("/") : rest[0];
  return name === undefined || name === "" ? undefined : `${id.slice(0, at)}/node_modules/${name}`;
}

interface PackageNotice {
  name: string;
  version: string;
  licence: string;
  texts: string[];
}

function packageNotice(dir: string, apache: string): PackageNotice {
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8")) as { name?: string; version?: string; license?: unknown };
  const name = pkg.name ?? path.basename(dir);
  const files = readdirSync(dir).filter((f) => LICENCE_FILE.test(f)).sort();
  const known = KNOWN_LICENCES[name];
  if (files.length === 0 && known === undefined)
    throw new Error(`${name} is in the browser build but ships no licence text and is not in KNOWN_LICENCES (build-notices.ts)`);
  const declared = typeof pkg.license === "string" ? pkg.license : known?.licence ?? "see the licence text";
  return {
    name,
    version: pkg.version ?? "unknown",
    licence: declared,
    texts: files.length > 0 ? files.map((f) => readFileSync(`${dir}/${f}`, "utf8").trim()) : [`(from ${known!.source})\n\n${apache}`],
  };
}

/** The text of `THIRD-PARTY-NOTICES.txt` for the packages in `packageDirs`. */
export function noticesText(repoRoot: string, packageDirs: Iterable<string>): string {
  const read = (p: string): string => readFileSync(path.join(repoRoot, p), "utf8").trim();
  const apache = read("LICENSE");
  const packages = [...new Set(packageDirs)].map((d) => packageNotice(d, apache)).sort((a, b) => a.name.localeCompare(b.name));
  const section = (title: string, body: string): string => `${RULE}\n${title}\n${RULE}\n\n${body}\n`;
  const parts = [
    "Notices of the works in this site",
    "",
    "This site is UmbraDB's MIP-0018 token indexer and explorer built to run in the browser. UmbraDB is licensed under",
    "the Apache License, Version 2.0 (its text is in the last section); its notice follows. The site also contains the",
    "works listed after it, each under its own licence.",
    "",
    section("UmbraDB: NOTICE", read("NOTICE")),
    ...packages.map((p) => section(`${p.name} ${p.version}: ${p.licence}`, p.texts.join("\n\n"))),
    section("PostgreSQL, in PGlite's database files (pglite.wasm, pglite.data, initdb.wasm): PostgreSQL Licence", read("token-indexer/browser/notices/POSTGRES-LICENSE")),
    section("Outfit, the font of the explorer's style (assets/Outfit-Variable-latin-*.woff2): SIL Open Font License 1.1", read("token-indexer/mip0018/ui/fonts/OFL.txt")),
    section("UmbraDB: Apache License, Version 2.0", apache),
  ];
  return `${parts.join("\n")}`;
}

/** The collector: `plugin()` for the page build and for each worker build; the page build writes the file. */
export function thirdPartyNotices(repoRoot: string): { plugin(writes: boolean): Plugin } {
  const packageDirs = new Set<string>();
  return {
    plugin(writes: boolean): Plugin {
      return {
        name: "umbradb-third-party-notices",
        generateBundle(_options, bundle) {
          for (const item of Object.values(bundle)) {
            if (item.type !== "chunk") continue;
            for (const id of item.moduleIds) {
              const dir = packageDirOf(id);
              if (dir !== undefined && existsSync(`${dir}/package.json`)) packageDirs.add(dir);
            }
          }
          if (writes) this.emitFile({ type: "asset", fileName: NOTICES_FILE, source: noticesText(repoRoot, packageDirs) });
        },
      };
    },
  };
}
