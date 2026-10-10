/**
 * The browser build: `npm run build:browser` writes the static site to `dist-browser/` (`npm run dev:browser` serves the
 * same configuration on 127.0.0.1). Pages: every `*.html` file in this directory (`index.html`, the indexer's main page:
 * the overview with its controls and modules, the token explorer and the database, `system.html`, the system status
 * page, and `engine.html`, the engine page). The engine runs in a dedicated module worker (`worker.ts`).
 *
 * - The chain (network and the node's and indexer's URLs) is fixed here, from `UMBRADB_BROWSER_NETWORK`,
 *   `UMBRADB_BROWSER_NODE_URL` and `UMBRADB_BROWSER_INDEXER_URL` (Stagenet when unset): defined in both bundles as
 *   `__UMBRADB_BROWSER_CHAIN__` (`config.ts`) and admitted in the pages' Content-Security-Policy.
 * - `build-csp.ts` gives every page a meta Content-Security-Policy with the SHA-256 of its inline blocks, writes
 *   `_headers` (the same policy and the cross-origin isolation headers for a static host) and makes `zod-jitless.ts` the
 *   first module of every page.
 * - `build-explorer.ts` puts the explorer `GET /ui` serves into `index.html`: its markup and wordmark, and its style's
 *   font as a file.
 *
 * - `build.target: "esnext"` and `worker.format: "es"`: Chrome runs ES modules and top-level await in a module worker,
 *   so no top-level-await plugin is used.
 * - `vite-plugin-wasm` loads ledger-v9's wasm-bindgen module (`import * as wasm from "…_bg.wasm"`), in the page and
 *   worker bundles alike: the dev server cannot load it without the plugin, and the build uses the same path. PGlite's
 *   assets (`new URL(…, import.meta.url)`) need no plugin.
 * - `keepNames` in the page and worker bundles: the minifier would otherwise rename ledger-v9's classes, whose names
 *   the scan stores (the worker also refuses to boot when they are renamed).
 * - `assetsInlineLimit: 0`: every asset (WASM, PGlite's data file, the tapes) is a file of its own, never a data URL.
 * - The node-free guard (`build-guard.ts`) fails the build if postgres.js or a Node built-in would be bundled.
 * - `build-notices.ts` writes `THIRD-PARTY-NOTICES.txt`: the licence of every package the bundles contain, PostgreSQL's
 *   (PGlite's database), the Outfit font's and UmbraDB's own, so the folder is published with its notices.
 * - `__UMBRADB_BUILD__` (`define`): the app commit (`UMBRADB_APP_COMMIT`, else `git rev-parse HEAD`, else `null`) and
 *   the installed PGlite and ledger-v9 versions, which the worker's system snapshot shows.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type PluginOption } from "vite";
import * as wasmPlugin from "vite-plugin-wasm";
import { browserChainFromEnv, chainOrigins, staticSecurity } from "./build-csp.ts";
import { explorerPage } from "./build-explorer.ts";
import { nodeFreeBundle } from "./build-guard.ts";
import { thirdPartyNotices } from "./build-notices.ts";

/** The plugin is the ES module's default export (its type declarations describe it as CommonJS). */
const wasm = (wasmPlugin as unknown as { default: () => PluginOption }).default;

const root = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const chain = browserChainFromEnv(process.env);
const pages = Object.fromEntries(readdirSync(root).filter((f) => f.endsWith(".html")).sort().map((f) => [f.slice(0, -".html".length), `${root}${f}`]));
/** zod and `zod-jitless.ts` in one chunk, so the JIT is off before any module of another chunk creates a schema. */
const zodChunk = { name: "zod", test: /[\\/]node_modules[\\/]zod[\\/]|[\\/]token-indexer[\\/]browser[\\/]zod-jitless\.ts$/ };
/**
 * The pages' own modules that two or more pages share (the engine client, the tabs, the protocol) in one chunk. Without
 * it the bundler puts its runtime helpers (the `keepNames` helper the zod chunk needs) in that shared chunk, which itself
 * imports the zod chunk: a cycle, and the first page to load fails before its first schema. With it the runtime has a
 * chunk of its own, imported by both.
 */
const sharedPageChunk = { name: "pages", test: (id: string) => !id.includes("node_modules"), minShareCount: 2 };

/** The installed version of a package, or `null`. */
function packageVersion(name: string): string | null {
  try {
    const v = (JSON.parse(readFileSync(`${repoRoot}node_modules/${name}/package.json`, "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The commit the build is made from, or `null` (a source tree without git history). */
function appCommit(): string | null {
  const given = process.env.UMBRADB_APP_COMMIT;
  if (given !== undefined && given !== "") return given;
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** The licence notices of the packages in the page and worker bundles (`build-notices.ts`). */
const notices = thirdPartyNotices(repoRoot);

const BUILD = { appCommit: appCommit(), pgliteVersion: packageVersion("@electric-sql/pglite"), ledgerVersion: packageVersion("@midnightntwrk/ledger-v9") };

export default defineConfig({
  root,
  base: "./",
  publicDir: false,
  define: { __UMBRADB_BROWSER_CHAIN__: JSON.stringify(chain), __UMBRADB_BUILD__: JSON.stringify(BUILD) },
  plugins: [nodeFreeBundle(repoRoot), wasm(), explorerPage(), staticSecurity({ connectSrc: chainOrigins(chain), prelude: `${root}zod-jitless.ts`, root }), notices.plugin(true)],
  worker: {
    format: "es",
    plugins: () => [nodeFreeBundle(repoRoot), wasm(), notices.plugin(false)],
    rolldownOptions: { output: { keepNames: true, codeSplitting: { groups: [zodChunk] } } },
  },
  build: {
    outDir: `${repoRoot}dist-browser`,
    emptyOutDir: true,
    target: "esnext",
    sourcemap: false,
    assetsInlineLimit: 0,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 20_000,
    rolldownOptions: {
      input: pages,
      output: { keepNames: true, codeSplitting: { groups: [zodChunk, sharedPageChunk] } },
    },
  },
  optimizeDeps: { exclude: ["@electric-sql/pglite"] },
  server: { host: "127.0.0.1" },
});
