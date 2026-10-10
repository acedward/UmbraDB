/**
 * The static build's security headers, made at build time (Node tooling: a Vite plugin and the helpers it uses).
 *
 * Every HTML page the build writes gets, as the first elements of its `<head>`, a
 * `<meta http-equiv="Content-Security-Policy">` and a `<meta name="referrer" content="no-referrer">`. The policy admits
 * the page's own inline `<script>` and `<style>` blocks by their SHA-256, computed from the bytes the build writes, so
 * an inline block without a hash cannot run. Next to the pages the build writes `_headers` (the static-host format read
 * by Netlify and Cloudflare Pages): the same policy as a header for every path, plus `frame-ancestors 'none'` (which a
 * meta element cannot carry), cross-origin isolation and the usual hardening headers. A page needs nothing to get
 * them: it only has to be one of the build's HTML inputs.
 *
 * The policy ({@link contentSecurityPolicy}): nothing loads unless named — scripts, styles, images, fonts and workers
 * from the site's own origin; WebAssembly compilation (`'wasm-unsafe-eval'`, no `'unsafe-eval'`); `connect-src` = the
 * site's origin plus the origins of the build's two chain endpoints ({@link browserChainFromEnv}); no plugins, base URL
 * or form targets; Trusted Types required for script sinks, with the one policy that creates the engine worker's URL
 * (`trusted-worker.ts`).
 *
 * The plugin also refuses, at build time, what such a policy would silently block in a page: inline event handler
 * attributes, `style` attributes and `javascript:` URLs. And it makes a module (zod without its JIT, see
 * `zod-jitless.ts`) the first module of every page's entry.
 */
import { createHash } from "node:crypto";
import type { Plugin } from "vite";
import { type BrowserChain, DEFAULT_BROWSER_CHAIN } from "./config.ts";
import { ENGINE_WORKER_POLICY } from "./trusted-worker.ts";

/** The chain the build is configured with: the environment's `UMBRADB_BROWSER_*` values over Stagenet's. */
export function browserChainFromEnv(env: Record<string, string | undefined>): BrowserChain {
  const pick = (name: string, fallback: string): string => {
    const v = env[name];
    return v === undefined || v === "" ? fallback : v;
  };
  const network = pick("UMBRADB_BROWSER_NETWORK", DEFAULT_BROWSER_CHAIN.network);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(network)) throw new Error(`UMBRADB_BROWSER_NETWORK: ${JSON.stringify(network)} is not a network id (lower-case letters, digits and "-")`);
  return {
    network,
    nodeUrl: endpointUrl("UMBRADB_BROWSER_NODE_URL", pick("UMBRADB_BROWSER_NODE_URL", DEFAULT_BROWSER_CHAIN.nodeUrl)),
    indexerUrl: endpointUrl("UMBRADB_BROWSER_INDEXER_URL", pick("UMBRADB_BROWSER_INDEXER_URL", DEFAULT_BROWSER_CHAIN.indexerUrl)),
  };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** An endpoint must be an absolute `https:` URL (`http:` only on a loopback host) without credentials. */
function endpointUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name}: ${JSON.stringify(value)} is not an absolute URL`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname)))
    throw new Error(`${name}: ${url.protocol}//${url.host} is not https (http is accepted only on a loopback host)`);
  if (url.username !== "" || url.password !== "") throw new Error(`${name}: the URL carries credentials`);
  return value;
}

/** The origins the pages and the worker may connect to besides their own: those of the chain's two endpoints. */
export function chainOrigins(chain: BrowserChain): string[] {
  return [...new Set([new URL(chain.nodeUrl).origin, new URL(chain.indexerUrl).origin])];
}

export interface PolicyParts {
  /** Origins `connect-src` admits besides `'self'`. */
  connectSrc: readonly string[];
  /** Hash sources (`'sha256-…'`) of admitted inline scripts and styles. */
  scriptHashes: readonly string[];
  styleHashes: readonly string[];
}

/**
 * The Content-Security-Policy. `meta` is the form a `<meta http-equiv>` element can carry (no `frame-ancestors`, which
 * browsers ignore there with a console warning); `header` adds it.
 */
export function contentSecurityPolicy(parts: PolicyParts, delivery: "meta" | "header"): string {
  const list = (...sources: readonly string[]): string => sources.join(" ");
  const directives = [
    "default-src 'none'",
    `script-src ${list("'self'", "'wasm-unsafe-eval'", ...parts.scriptHashes)}`,
    `style-src ${list("'self'", ...parts.styleHashes)}`,
    "img-src 'self'",
    "font-src 'self'",
    `connect-src ${list("'self'", ...parts.connectSrc)}`,
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    ...(delivery === "header" ? ["frame-ancestors 'none'"] : []),
    "require-trusted-types-for 'script'",
    `trusted-types ${ENGINE_WORKER_POLICY}`,
  ];
  return directives.join("; ");
}

/** The headers a static host should send with every file of the build (the pages, the worker's script, the assets). */
export function securityHeaders(csp: string): Array<[name: string, value: string]> {
  return [
    ["Content-Security-Policy", csp],
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Cross-Origin-Embedder-Policy", "require-corp"],
    ["Cross-Origin-Resource-Policy", "same-origin"],
    ["Referrer-Policy", "no-referrer"],
    ["X-Content-Type-Options", "nosniff"],
    ["X-Frame-Options", "DENY"],
  ];
}

/** `_headers` text: one rule for every path. */
export function headersFile(headers: ReadonlyArray<readonly [string, string]>): string {
  return [
    "# Security headers for every file of this static build; written by the build (token-indexer/browser/build-csp.ts).",
    "# Netlify and Cloudflare Pages read this file; other hosts must send the same headers (token-indexer/browser/README.md).",
    "/*",
    ...headers.map(([name, value]) => `  ${name}: ${value}`),
    "",
  ].join("\n");
}

/** A CSP hash source of a text: `'sha256-<base64 of its UTF-8 bytes' SHA-256>'`. */
export function hashSource(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const INLINE_STYLE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

/** The hash sources of a page's inline `<script>` (those without `src`) and `<style>` blocks. */
export function inlineHashes(html: string): { scripts: string[]; styles: string[] } {
  const scripts: string[] = [];
  for (const m of html.matchAll(INLINE_SCRIPT)) if (!/\ssrc\s*=/i.test(` ${m[1]}`) && m[2] !== "") scripts.push(hashSource(m[2]!));
  const styles = [...html.matchAll(INLINE_STYLE)].map((m) => hashSource(m[1]!));
  return { scripts: [...new Set(scripts)], styles: [...new Set(styles)] };
}

/** What a page holds that the policy would block without a sign: inline event handlers, `style` attributes, `javascript:` URLs. */
export function htmlProblems(html: string): string[] {
  const markup = html.replace(/<!--[\s\S]*?-->/g, "").replace(INLINE_SCRIPT, "<script>").replace(INLINE_STYLE, "<style>");
  const problems: string[] = [];
  for (const [tag] of markup.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const attrs = tag.replace(/^<[a-zA-Z][\w-]*/, "");
    const names = attrs.replace(/"[^"]*"|'[^']*'/g, '""');
    for (const [, name] of names.matchAll(/(?:^|\s)([^\s"'=<>/]+)\s*=/g)) {
      const n = name!.toLowerCase();
      if (n.startsWith("on")) problems.push(`an inline event handler (${n}) in ${tag}`);
      else if (n === "style") problems.push(`a style attribute in ${tag}`);
    }
    if (/=\s*["']?\s*javascript:/i.test(attrs)) problems.push(`a javascript: URL in ${tag}`);
  }
  return problems;
}

/** Inserts the policy's meta elements at the start of `<head>` (after a `<meta charset>` that opens it). */
export function withPolicyMeta(html: string, csp: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, "&quot;")}">\n  <meta name="referrer" content="no-referrer">`;
  const head = /<head\b[^>]*>(\s*<meta\s+charset\s*=[^>]*>)?/i.exec(html);
  if (head === null) throw new Error("the page has no <head>");
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}\n  ${meta}${html.slice(at)}`;
}

export interface StaticSecurityOptions {
  /** Origins `connect-src` admits besides `'self'` (see {@link chainOrigins}). */
  connectSrc: readonly string[];
  /** A module made the first module of every page's entry (a path inside the Vite root). */
  prelude?: string;
  /** The Vite root (to turn {@link prelude} into a root-relative URL). */
  root?: string;
}

/** The Vite plugin: the meta policy in every page, `_headers` beside them, the prelude module first in every page. */
export function staticSecurity(opts: StaticSecurityOptions): Plugin {
  for (const origin of opts.connectSrc) if (new URL(origin).origin !== origin) throw new Error(`connect-src: ${origin} is not an origin`);
  const prelude = opts.prelude === undefined ? undefined : preludeUrl(opts.prelude, opts.root);
  return {
    name: "umbradb-static-security",
    transformIndexHtml: {
      order: "pre",
      handler: () => (prelude === undefined ? [] : [{ tag: "script", attrs: { type: "module", src: prelude }, injectTo: "head-prepend" as const }]),
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const pages = Object.values(bundle).filter((item) => item.type === "asset" && item.fileName.endsWith(".html"));
        const scriptHashes = new Set<string>();
        const styleHashes = new Set<string>();
        for (const page of pages) {
          if (page.type !== "asset") continue;
          const html = typeof page.source === "string" ? page.source : new TextDecoder().decode(page.source);
          const problems = htmlProblems(html);
          if (problems.length > 0) this.error(`${page.fileName}: the Content-Security-Policy would block ${problems.join("; ")}`);
          const hashes = inlineHashes(html);
          hashes.scripts.forEach((h) => scriptHashes.add(h));
          hashes.styles.forEach((h) => styleHashes.add(h));
          page.source = withPolicyMeta(html, contentSecurityPolicy({ connectSrc: opts.connectSrc, scriptHashes: hashes.scripts, styleHashes: hashes.styles }, "meta"));
        }
        const csp = contentSecurityPolicy({ connectSrc: opts.connectSrc, scriptHashes: [...scriptHashes].sort(), styleHashes: [...styleHashes].sort() }, "header");
        this.emitFile({ type: "asset", fileName: "_headers", source: headersFile(securityHeaders(csp)) });
      },
    },
  };
}

function preludeUrl(file: string, root: string | undefined): string {
  if (root === undefined) throw new Error("staticSecurity: a prelude needs the Vite root");
  const normalized = (p: string): string => p.split("\\").join("/").replace(/\/+$/, "");
  const r = normalized(root);
  const f = normalized(file);
  if (!f.startsWith(`${r}/`)) throw new Error(`staticSecurity: the prelude ${file} is outside the Vite root ${root}`);
  return f.slice(r.length);
}
