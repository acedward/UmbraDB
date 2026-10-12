/**
 * The static build's local server, `npm run serve:browser` (`token-indexer/dev/serve-browser.ts`), which serves a build
 * folder the way a static host must (`token-indexer/browser/README.md`, "Static hosting"). A folder holding one file of
 * every kind the build writes, with the `_headers` text the build writes (`build-csp.ts`), served on 127.0.0.1 at a
 * free port:
 *
 * - `[[browser.deploy.serve]]` — every file answers 200 with its bytes, the content type of its kind (`.wasm`
 *   `application/wasm`, the gzip tapes `application/gzip` with no `Content-Encoding` even when the client accepts
 *   gzip, …), `no-store`, and every header of `_headers` with its exact value; `HEAD` the same headers and no body; `/`
 *   is `index.html`; a missing file, a path that leaves the folder (raw `..` or encoded), a malformed escape and a
 *   `POST` answer 404; a folder without `_headers` is refused, naming `npm run build:browser`.
 * - `[[browser.deploy.serve-cli]]` — `npm run serve:browser` runs this file: started as a process with `--port 0` it
 *   prints the address and the explorer's and status page's URLs, serves the folder with its headers and exits 0 on
 *   SIGTERM; a bad `--port` exits 2 and a folder without `_headers` exits 1, each with a message.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentSecurityPolicy, headersFile, securityHeaders } from "../browser/build-csp.ts";
import { CONTENT_TYPES, parseHeadersFile, type ServedSite, serveBrowserBuild } from "../dev/serve-browser.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(ROOT, "token-indexer/dev/serve-browser.ts");

/** The site: path → [bytes, content type]. */
const FILES: Record<string, [Uint8Array, string]> = {
  "index.html": [new TextEncoder().encode("<!doctype html><title>explorer</title>"), "text/html; charset=utf-8"],
  "system.html": [new TextEncoder().encode("<!doctype html><title>system</title>"), "text/html; charset=utf-8"],
  "engine.html": [new TextEncoder().encode("<!doctype html><title>engine</title>"), "text/html; charset=utf-8"],
  "assets/worker-abc.js": [new TextEncoder().encode("export {};\n"), "text/javascript"],
  "assets/pages-abc.css": [new TextEncoder().encode("body{}\n"), "text/css"],
  "assets/pglite-abc.wasm": [Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), "application/wasm"],
  "assets/pglite-abc.data": [Uint8Array.from([1, 2, 3, 4]), "application/octet-stream"],
  "assets/stagenet-715402-715433.tape.json-abc.gz": [new Uint8Array(gzipSync(Buffer.from('{"tape":true}'))), "application/gzip"],
  "assets/Outfit-Variable-latin-abc.woff2": [Uint8Array.from([0x77, 0x4f, 0x46, 0x32]), "font/woff2"],
  "assets/favicon-abc.ico": [Uint8Array.from([0, 0, 1, 0]), "image/x-icon"],
  "snapshots/index.json": [new TextEncoder().encode('{"snapshots":[]}\n'), "application/json"],
  "snapshots/umbradb-stagenet-1-2.snapshot.tar": [new Uint8Array(1024), "application/x-tar"],
  "THIRD-PARTY-NOTICES.txt": [new TextEncoder().encode("Notices of the works in this site\n"), "text/plain; charset=utf-8"],
};

const HEADERS_TEXT = headersFile(securityHeaders(contentSecurityPolicy({ connectSrc: ["https://rpc.example.test", "https://indexer.example.test"], scriptHashes: [], styleHashes: [] }, "header")));

/** A build-like folder inside a parent that also holds a file the server must never serve. */
function makeSite(withHeaders = true): { parent: string; dir: string } {
  const parent = mkdtempSync(join(tmpdir(), "umbradb-deploy-"));
  const dir = join(parent, "site");
  for (const [path, [bytes]] of Object.entries(FILES)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
  if (withHeaders) writeFileSync(join(dir, "_headers"), HEADERS_TEXT);
  writeFileSync(join(parent, "secret.txt"), "outside the site");
  return { parent, dir };
}

/** A raw request (the path is sent as written, `..` included). */
function raw(origin: string, path: string, method = "GET", headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  const u = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const expectedHeaders = parseHeadersFile(HEADERS_TEXT)[0]!.headers;

describe("the static build's local server", () => {
  const cleanup: string[] = [];
  let site: ServedSite;
  let paths: { parent: string; dir: string };

  beforeAll(async () => {
    paths = makeSite();
    cleanup.push(paths.parent);
    site = await serveBrowserBuild({ dir: paths.dir, port: 0 });
  });

  afterAll(async () => {
    await site?.close();
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  });

  it("[[browser.deploy.serve]] every file of the build with its bytes, its kind's content type (application/wasm; gzip tapes without Content-Encoding), no-store and every _headers header; HEAD; / is index.html; outside paths, missing files, bad escapes and POST are 404; a folder without _headers is refused", async () => {
    expect(site.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(expectedHeaders.map(([n]) => n)).toEqual(["Content-Security-Policy", "Cross-Origin-Opener-Policy", "Cross-Origin-Embedder-Policy", "Cross-Origin-Resource-Policy", "Referrer-Policy", "X-Content-Type-Options", "X-Frame-Options"]);
    // Every kind of file the build writes has its type in the table.
    for (const [path, [, type]] of Object.entries(FILES)) expect(CONTENT_TYPES[path.slice(path.lastIndexOf("."))], path).toBe(type);

    for (const [path, [bytes, type]] of Object.entries(FILES)) {
      const r = await raw(site.origin, `/${path}`, "GET", { "accept-encoding": "gzip, deflate, br" });
      expect(r.status, path).toBe(200);
      expect(new Uint8Array(r.body), path).toEqual(bytes);
      expect(r.headers["content-type"], path).toBe(type);
      expect(r.headers["content-encoding"], path).toBeUndefined();
      expect(r.headers["content-length"], path).toBe(String(bytes.length));
      expect(r.headers["cache-control"], path).toBe("no-store");
      for (const [name, value] of expectedHeaders) expect(r.headers[name.toLowerCase()], `${path} ${name}`).toBe(value);

      const h = await raw(site.origin, `/${path}`, "HEAD");
      expect(h.status, path).toBe(200);
      expect(h.body.length, path).toBe(0);
      expect(h.headers["content-type"], path).toBe(type);
      for (const [name, value] of expectedHeaders) expect(h.headers[name.toLowerCase()], `HEAD ${path} ${name}`).toBe(value);
    }

    const root = await raw(site.origin, "/");
    expect(root.status).toBe(200);
    expect(root.body.toString()).toBe(new TextDecoder().decode(FILES["index.html"]![0]));
    expect(root.headers["content-security-policy"]).toBe(expectedHeaders[0]![1]);

    for (const path of ["/nope.html", "/assets/", "/../secret.txt", "/assets/../../secret.txt", "/%2e%2e/secret.txt", "/assets/%2e%2e%2f%2e%2e%2fsecret.txt", "/%E0%A4%A"]) {
      const r = await raw(site.origin, path);
      expect(r.status, path).toBe(404);
      expect(r.body.toString(), path).not.toContain("outside the site");
    }
    expect((await raw(site.origin, "/index.html", "POST")).status).toBe(404);

    const bare = makeSite(false);
    cleanup.push(bare.parent);
    await expect(serveBrowserBuild({ dir: bare.dir, port: 0 })).rejects.toThrow(/_headers is missing: serve the folder npm run build:browser writes/);
  });

  it("[[browser.deploy.serve-cli]] npm run serve:browser runs this file: with --port 0 it prints the address and the pages, serves the folder with its headers and exits 0 on SIGTERM; a bad --port exits 2, a folder without _headers exits 1", async () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["serve:browser"]).toBe("tsx token-indexer/dev/serve-browser.ts");

    const run = (args: string[]): { child: ChildProcess; out: () => string; exit: Promise<number | null> } => {
      const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout!.on("data", (b: Buffer) => { out += b.toString(); });
      child.stderr!.on("data", (b: Buffer) => { out += b.toString(); });
      return { child, out: () => out, exit: new Promise((r) => child.once("exit", (code) => r(code))) };
    };

    const served = run(["--dir", paths.dir, "--port", "0"]);
    const end = Date.now() + 30_000;
    let origin: string | undefined;
    while (origin === undefined) {
      origin = /at (http:\/\/127\.0\.0\.1:\d+)\//.exec(served.out())?.[1];
      if (origin === undefined && Date.now() > end) throw new Error(`no address printed: ${served.out()}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    await expect.poll(() => served.out()).toContain("system.html");
    expect(served.out()).toContain(`serving ${paths.dir} at ${origin}/ with the 7 headers of its _headers file`);
    expect(served.out()).toContain(`indexer:            ${origin}/ (overview, token explorer, database)`);
    expect(served.out()).toContain(`system status page: ${origin}/system.html`);
    const page = await raw(origin, "/");
    expect(page.status).toBe(200);
    expect(page.headers["cross-origin-embedder-policy"]).toBe("require-corp");
    const wasm = await raw(origin, "/assets/pglite-abc.wasm");
    expect(wasm.headers["content-type"]).toBe("application/wasm");
    served.child.kill("SIGTERM");
    expect(await served.exit).toBe(0);

    const badPort = run(["--dir", paths.dir, "--port", "nope"]);
    expect(await badPort.exit).toBe(2);
    expect(badPort.out()).toContain('--port "nope" is not a port');

    const bare = makeSite(false);
    cleanup.push(bare.parent);
    const noHeaders = run(["--dir", bare.dir, "--port", "0"]);
    expect(await noHeaders.exit).toBe(1);
    expect(noHeaders.out()).toContain("_headers is missing: serve the folder npm run build:browser writes");
  }, 60_000);
});
