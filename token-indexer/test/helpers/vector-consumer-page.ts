/**
 * The vector consumer test page (`fixtures/vector-consumer/`) for the Chrome tests: built with Vite into
 * `<site>/vector-consumer/` beside the browser engine's static build, under the same node-free guard as that build
 * (`token-indexer/browser/build-guard.ts`), so one static server serves both.
 */
import { join } from "node:path";
import { nodeFreeBundle } from "../../browser/build-guard.ts";
import { REPO_ROOT } from "./engine-site.ts";

const FIXTURE = join(REPO_ROOT, "token-indexer/test/fixtures/vector-consumer");

/** The page's path under the site's origin. */
export const VECTOR_CONSUMER_PAGE = "/vector-consumer/index.html";

/** Builds the page into `<siteDir>/vector-consumer/`. */
export async function buildVectorConsumerPage(siteDir: string): Promise<void> {
  const { build } = await import("vite");
  await build({
    logLevel: "silent",
    configFile: false,
    root: FIXTURE,
    base: "./",
    publicDir: false,
    plugins: [nodeFreeBundle(REPO_ROOT)],
    worker: { format: "es", plugins: () => [nodeFreeBundle(REPO_ROOT)] },
    optimizeDeps: { exclude: ["@electric-sql/pglite"] },
    build: {
      outDir: join(siteDir, "vector-consumer"),
      emptyOutDir: true,
      target: "esnext",
      sourcemap: false,
      assetsInlineLimit: 0,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 20_000,
    },
  });
}
