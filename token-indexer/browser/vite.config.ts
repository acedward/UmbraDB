/**
 * The browser build: `npm run build:browser` writes the static site to `dist-browser/` (`npm run dev:browser` serves the
 * same configuration on 127.0.0.1). Pages: `engine.html` (the engine's status page). The engine runs in a dedicated
 * module worker (`worker.ts`).
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
 */
import { fileURLToPath } from "node:url";
import { defineConfig, type PluginOption } from "vite";
import * as wasmPlugin from "vite-plugin-wasm";
import { nodeFreeBundle } from "./build-guard.ts";

/** The plugin is the ES module's default export (its type declarations describe it as CommonJS). */
const wasm = (wasmPlugin as unknown as { default: () => PluginOption }).default;

const root = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root,
  base: "./",
  publicDir: false,
  plugins: [nodeFreeBundle(repoRoot), wasm()],
  worker: {
    format: "es",
    plugins: () => [nodeFreeBundle(repoRoot), wasm()],
    rolldownOptions: { output: { keepNames: true } },
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
      input: { engine: `${root}engine.html` },
      output: { keepNames: true },
    },
  },
  optimizeDeps: { exclude: ["@electric-sql/pglite"] },
  server: { host: "127.0.0.1" },
});
