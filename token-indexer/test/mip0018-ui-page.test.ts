/**
 * The explorer page's build/test guard (project 00026, sub-plan C3; spec FR-030, FR-043; the PR #19 lesson "a backtick
 * in the inline page script broke the build"). No database and no browser: the served document is fetched over HTTP
 * from the real entry point (`serve()`), parsed, its CSP checked against the bytes it carries, its script compiled,
 * and the script and markup scanned for every way a value could become markup or a request could leave the origin.
 * The browser-level behaviour is `mip0018-ui-browser.test.ts`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { Script } from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { createMip0018Api, listen } from "../mip0018/api.ts";
import { serve, type ServeHandle } from "../mip0018/serve-cli.ts";
import { serveUi, sha256Source, UI_CSP, UI_HTML, UI_SCRIPT, UI_STYLE } from "../mip0018/ui/page.ts";

const REPO = new URL("../../", import.meta.url);
const UI_DIR = new URL("token-indexer/mip0018/ui/", REPO);
const read = (rel: string): Buffer => readFileSync(new URL(rel, UI_DIR));
const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
/** No query is made: the page routes never touch the database. */
const NO_SQL = {} as UmbraDBSql;

interface Resp { status: number; headers: Headers; body: Buffer }
async function get(base: string, path: string, method = "GET"): Promise<Resp> {
  const r = await fetch(base + path, { method, redirect: "manual" });
  return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
}

/** Tags of an HTML text (script and style contents removed), with their attributes. */
function tags(html: string): Array<{ name: string; end: boolean; self: boolean; attrs: Array<[string, string | null]> }> {
  const out: Array<{ name: string; end: boolean; self: boolean; attrs: Array<[string, string | null]> }> = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
  for (let m = re.exec(html); m !== null; m = re.exec(html)) {
    const attrs: Array<[string, string | null]> = [];
    const are = /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
    for (let a = are.exec(m[3]!); a !== null; a = are.exec(m[3]!)) attrs.push([a[1]!.toLowerCase(), a[2] === undefined ? null : a[2].replace(/^["']|["']$/g, "")]);
    out.push({ name: m[2]!.toLowerCase(), end: m[1] === "/", self: m[4] === "/", attrs });
  }
  return out;
}

describe("MIP-0018 explorer page: build/test guard (00026 C3)", () => {
  const servers: Server[] = [];
  const handles: ServeHandle[] = [];

  afterAll(async () => {
    for (const h of handles) await h.stop();
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  it("[[mip0018.ui.page-guard]] the served document parses: one inline script and one inline style whose SHA-256 are the CSP's, the script compiles, pure ASCII, no inline handler/style attribute/external reference, every id the script uses exists once, and the script has no markup sink, no other network client, no clock and only /v1 API paths", async () => {
    const h = await serve({ sql: NO_SQL, network: "stagenet", apiOnly: true, port: 0, log: () => {} });
    handles.push(h);
    const base = `http://127.0.0.1:${h.port}`;
    const r = await get(base, "/ui");
    expect(r.status).toBe(200);
    const html = r.body.toString("utf8");
    expect(html).toBe(UI_HTML);
    expect(html.startsWith("<!doctype html>\n<html lang=\"en\">")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    // Pure printable ASCII (+ newline): no encoding question, no raw bidi or invisible character in the document.
    expect(/^[\x20-\x7e\n]*$/.test(html)).toBe(true);

    // Exactly one script (inline, no src) and one style; their bytes are the files and their hashes are the CSP's.
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    const styles = [...html.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)];
    expect(scripts).toHaveLength(1);
    expect(styles).toHaveLength(1);
    expect(scripts[0]![1]).toBe("");
    expect(styles[0]![1]).toBe("");
    const script = scripts[0]![2]!;
    const style = styles[0]![2]!;
    expect(script).toBe(UI_SCRIPT);
    expect(style).toBe(UI_STYLE);
    expect(script).toBe(read("page.js").toString("utf8"));
    expect(style).toBe(read("page.css").toString("utf8"));
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toBe(UI_CSP);
    const directives = Object.fromEntries(csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1).join(" ")]));
    expect(directives).toEqual({
      "default-src": "'none'", "script-src": sha256Source(script), "style-src": sha256Source(style), "connect-src": "'self'",
      "img-src": "'self'", "font-src": "'self'", "object-src": "'none'", "base-uri": "'none'", "form-action": "'none'",
      "frame-ancestors": "'none'", "require-trusted-types-for": "'script'", "trusted-types": "'none'",
    });
    expect(directives["script-src"]).toBe(`'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`);
    // Nothing inside the script or style can end its element early or open a comment state.
    for (const block of [script, style]) expect(/<\/(script|style)|<!--|<script/i.test(block)).toBe(false);

    // The script compiles (the backtick class of bug: a broken script never reaches a browser).
    expect(() => new Script(script, { filename: "ui/page.js" })).not.toThrow();
    // A negative control: the same check catches a stray backtick.
    expect(() => new Script(`${script}\n\``, { filename: "broken.js" })).toThrow(SyntaxError);

    // The markup outside script/style: known elements, balanced, no handler/style attribute, no external reference.
    const markup = html.replace(/<script>[\s\S]*?<\/script>/, "<script></script>").replace(/<style>[\s\S]*?<\/style>/, "<style></style>");
    const VOID = new Set(["meta", "link"]);
    const ALLOWED = new Set(["html", "head", "meta", "title", "link", "style", "body", "header", "div", "svg", "g", "path", "span", "h1", "nav", "a", "button", "main", "footer", "script"]);
    const stack: string[] = [];
    const ids: string[] = [];
    const ts = tags(markup);
    expect(ts.length).toBeGreaterThan(20);
    for (const t of ts) {
      expect(ALLOWED.has(t.name), t.name).toBe(true);
      if (t.end) {
        expect(stack.pop(), `</${t.name}>`).toBe(t.name);
        continue;
      }
      for (const [name, value] of t.attrs) {
        expect(name.startsWith("on"), `${t.name} ${name}`).toBe(false);
        expect(name, t.name).not.toBe("style");
        expect(name, t.name).not.toBe("src");
        if (name === "id") ids.push(value!);
        if (name === "href") expect(["#/", "#/status", "/ui/favicon.ico"], `href ${value}`).toContain(value);
        if (value !== null) expect(/javascript:|data:|https?:|\/\//i.test(value), `${name}=${value}`).toBe(false);
      }
      if (!VOID.has(t.name) && !t.self) stack.push(t.name);
    }
    expect(stack).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
    const used = [...script.matchAll(/\bel\("([^"]+)"\)/g)].map((m) => m[1]!);
    expect(new Set(used)).toEqual(new Set(["now", "strip", "banner", "view", "nav-list", "nav-status"]));
    for (const id of used) expect(ids, id).toContain(id);

    // The script: values reach the document only as text; no other network client; no clock; only /v1 paths.
    const code = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"])\/\/[^\n]*/g, "$1");
    const forbidden: Array<[RegExp, string]> = [
      [/innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|DOMParser|srcdoc|document\.write/, "markup sink"],
      [/\beval\s*\(|new\s+Function|\bFunction\s*\(|set(Timeout|Interval)\s*\(\s*["'`]/, "code from a string"],
      [/XMLHttpRequest|WebSocket|EventSource|sendBeacon|\bimport\s*\(|window\.open|\.assign\(|\.replace\(\s*["']http|location\.href\s*=/, "another network or navigation path"],
      [/\bDate\b|toLocale|Intl\.|performance\.now/, "a clock (heights only)"],
      [/localStorage|sessionStorage|indexedDB|document\.cookie/, "storage"],
      [/setAttribute\(\s*["'](on|style|href|src)/i, "attribute sink"],
      [/\.style\./, "inline style"],
    ];
    for (const [re, what] of forbidden) expect(re.test(code), what).toBe(false);
    expect([...code.matchAll(/\bfetch\(/g)]).toHaveLength(1);
    expect([...code.matchAll(/\.href\s*=/g)]).toHaveLength(1); // link(): hash routes built from validated hex
    expect(code).toContain('var API = "/v1";');
    const firstSegments = [...code.matchAll(/apiPath\(\s*\[\s*"([a-z]+)"/g)].map((m) => m[1]!);
    expect(new Set(firstSegments)).toEqual(new Set(["status", "tokens", "identities", "contracts", "events"]));
    // The endpoints the header comment declares are the API's (API.md) plus the two pending activity endpoints.
    const declared = [...script.matchAll(/^ \*   GET (\/v1\/\S+)/gm)].map((m) => m[1]!.split("?")[0]!);
    expect(declared).toEqual(["/v1/status", "/v1/tokens", "/v1/tokens/{color}", "/v1/identities/{contract}/{domainSep}/{kind}", "/v1/contracts/{address}/tokens", "/v1/events", "/v1/tokens/{color}/activity", "/v1/contracts/{address}/activity"]);
    const apiMd = readFileSync(new URL("token-indexer/API.md", REPO), "utf8");
    for (const p of declared.filter((d) => !d.endsWith("/activity"))) expect(apiMd, p).toContain(`GET ${p}`);
    expect(apiMd).toContain("/v1/tokens/{color}/activity");
  });

  it("[[mip0018.ui.static-routes]] serve() answers /ui, /ui/, the font, the icon and / → /ui from the API's own server; HEAD gives headers only; other methods and unknown /ui paths fall through to the API (405/404); without the hook /ui stays a 404; the font and icon are #19's bytes and the font's licence is in NOTICE", async () => {
    const h = await serve({ sql: NO_SQL, network: "stagenet", apiOnly: true, port: 0, log: () => {} });
    handles.push(h);
    expect(h.host).toBe("127.0.0.1");
    const base = `http://127.0.0.1:${h.port}`;
    for (const p of ["/ui", "/ui/", "/ui?refresh=1000", "/ui#/status"]) {
      const r = await get(base, p);
      expect(r.status, p).toBe(200);
      expect(r.body.toString("utf8"), p).toBe(UI_HTML);
      expect(Object.fromEntries(["content-type", "x-content-type-options", "referrer-policy", "cache-control", "x-frame-options", "cross-origin-opener-policy"].map((k) => [k, r.headers.get(k)]))).toEqual({
        "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        "cache-control": "no-store", "x-frame-options": "DENY", "cross-origin-opener-policy": "same-origin",
      });
      expect(Number(r.headers.get("content-length"))).toBe(Buffer.byteLength(UI_HTML));
    }
    const head = await get(base, "/ui", "HEAD");
    expect([head.status, head.body.length, Number(head.headers.get("content-length"))]).toEqual([200, 0, Buffer.byteLength(UI_HTML)]);
    const font = await get(base, "/ui/outfit.woff2");
    expect([font.status, font.headers.get("content-type"), sha256(font.body)]).toEqual([200, "font/woff2", "92684e4acde79ef07758cd09380b7e01e9824d8b061eddeda046f78c166d7b12"]);
    for (const p of ["/ui/favicon.ico", "/favicon.ico"]) {
      const icon = await get(base, p);
      expect([icon.status, icon.headers.get("content-type"), sha256(icon.body)], p).toEqual([200, "image/x-icon", "b41509ad57381debefaba6fb3e2e478c1e38ea8afc5e6f11ecd1aeaba4e14c45"]);
    }
    const root = await get(base, "/");
    expect([root.status, root.headers.get("location")]).toEqual([302, "/ui"]);
    // Falls through to the API: its 405 for other methods, its 404 for unknown paths.
    const post = await get(base, "/ui", "POST");
    expect([post.status, post.headers.get("allow"), JSON.parse(post.body.toString()).error.code]).toEqual([405, "GET, HEAD", "METHOD_NOT_ALLOWED"]);
    for (const p of ["/ui/nope", "/ui/page.js", "/ui/fonts/OFL.txt", "/uix", "/ui/../ui/outfit.woff2x"]) {
      const r = await get(base, p);
      expect(r.status, p).toBe(404);
      expect(r.headers.get("content-type"), p).toBe("application/json; charset=utf-8");
    }
    // Without the hook (createMip0018Api alone) the page does not exist — C1's behaviour is unchanged.
    const bare = createMip0018Api({ sql: NO_SQL, network: "stagenet", log: () => {} });
    servers.push(bare);
    const bareBase = `http://127.0.0.1:${await listen(bare, 0)}`;
    for (const p of ["/ui", "/", "/ui/outfit.woff2"]) expect((await get(bareBase, p)).status, p).toBe(404);
    // serveUi leaves a request it does not own untouched.
    let touched = false;
    const fakeRes = new Proxy({}, { get: () => { touched = true; return () => {}; } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(serveUi({ method: "GET", url: "/v1/status" } as any, fakeRes as any)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(serveUi({ method: "DELETE", url: "/ui" } as any, fakeRes as any)).toBe(false);
    expect(touched).toBe(false);
    // Licence and provenance: the font is #19's file, its OFL text sits beside it, NOTICE names both.
    expect(sha256(read("fonts/Outfit-Variable-latin.woff2"))).toBe("92684e4acde79ef07758cd09380b7e01e9824d8b061eddeda046f78c166d7b12");
    expect(read("fonts/OFL.txt").toString("utf8")).toMatch(/^Copyright 2021 The Outfit Project Authors[\s\S]*SIL OPEN FONT LICENSE Version 1\.1/);
    const notice = readFileSync(new URL("NOTICE", REPO), "utf8");
    for (const s of ["Outfit", "SIL Open Font License, Version 1.1", "token-indexer/mip0018/ui/fonts/OFL.txt", "92684e4acde79ef07758cd09380b7e01e9824d8b061eddeda046f78c166d7b12", "11af38e66a917be3d2f2efbbadaa81b96bfbcdfd"])
      expect(notice).toContain(s);
  });
});
