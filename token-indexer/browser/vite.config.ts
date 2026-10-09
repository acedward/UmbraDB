/**
 * The browser build: `npm run build:browser` writes the static site to `dist-browser/` (`npm run dev:browser` serves the
 * same configuration on 127.0.0.1). Pages: `engine.html` (the engine's status page). The engine runs in a dedicated
 * module worker (`worker.ts`).
 *
 * - `build.target: "esnext"` and `worker.format: "es"`: Chrome runs ES modules, top-level await and WASM ES module
 *   imports in a module worker, so neither a top-level-await nor a WASM plugin is used (Vite bundles ledger-v9's
 *   wasm-bindgen module and PGlite's `new URL(…, import.meta.url)` assets by itself).
 * - `keepNames` in the page and worker bundles: the minifier would otherwise rename ledger-v9's classes, whose names
 *   the scan stores (the worker also refuses to boot when they are renamed).
 * - `assetsInlineLimit: 0`: every asset (WASM, PGlite's data file, the tapes) is a file of its own, never a data URL.
 * - The node-free guard (`build-guard.ts`) fails the build if postgres.js or a Node built-in would be bundled.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { nodeFreeBundle } from "./build-guard.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root,
  base: "./",
  publicDir: false,
  plugins: [nodeFreeBundle(repoRoot)],
  worker: {
    format: "es",
    plugins: () => [nodeFreeBundle(repoRoot)],
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
