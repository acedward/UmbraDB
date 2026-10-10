/**
 * The browser build for Chrome tests: `token-indexer/browser/vite.config.ts` built with Vite into a temporary folder,
 * the OPFS reader test page (`fixtures/opfs-reader/`) built beside it (`/reader/index.html`), and a static server for
 * both on 127.0.0.1 (random port at or above 10000) that also answers the chain's two endpoints (`/chain/rpc`,
 * `/chain/graphql`) from a recorded range.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { TapeReplay } from "../../../chain-archive-sync/tape-replay.js";

export const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CONFIG = join(ROOT, "token-indexer/browser/vite.config.ts");
const READER = join(ROOT, "token-indexer/test/fixtures/opfs-reader");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".wasm": "application/wasm", ".data": "application/octet-stream",
  ".gz": "application/gzip", ".json": "application/json", ".css": "text/css",
};

/** Builds the site and the reader page; `env` is set while the build's configuration loads. */
export async function buildSite(env: Record<string, string> = {}): Promise<{ dir: string; remove(): void }> {
  const { build } = await import("vite");
  const dir = mkdtempSync(join(tmpdir(), "umbradb-browser-site-"));
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    await build({ logLevel: "silent", configFile: CONFIG, build: { outDir: dir, emptyOutDir: true } });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  await build({
    logLevel: "silent",
    configFile: false,
    root: READER,
    base: "./",
    worker: { format: "es" },
    optimizeDeps: { exclude: ["@electric-sql/pglite"] },
    build: { outDir: join(dir, "reader"), emptyOutDir: true, target: "esnext", assetsInlineLimit: 0, reportCompressedSize: false, chunkSizeWarningLimit: 20_000 },
  });
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Serves `dir` and the chain endpoints of `chain` (when given). */
export async function serveSite(dir: string, chain?: TapeReplay): Promise<{ server: Server; origin: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/chain/") && chain !== undefined) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        void chain.answer(url.pathname.slice("/chain".length), Buffer.concat(chunks).toString("utf8")).then((a) => {
          res.writeHead(a.status, a.headers);
          res.end(a.body);
        });
      });
      return;
    }
    const file = normalize(join(dir, decodeURIComponent(url.pathname)));
    if (!file.startsWith(dir + sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-length": body.length, "cache-control": "no-store" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  });
  for (let attempt = 0; ; attempt++) {
    const port = 10_000 + Math.floor(Math.random() * 50_000);
    const ok = await new Promise<boolean>((done) => {
      server.once("error", () => done(false));
      server.listen(port, "127.0.0.1", () => done(true));
    });
    if (ok) return { server, origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
    if (attempt > 20) throw new Error("no free port at or above 10000 on 127.0.0.1");
  }
}
