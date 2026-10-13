/**
 * Token images (MIP-0018 "Common fields": `image`, `image_sha256`; "Consuming": a URI from a value is fetched only with
 * the precautions applied to any remote content; "Security considerations": content whose SHA-256 differs from
 * `image_sha256` is never displayed, images are untrusted content and never run scripts): the background image fetcher
 * (`image-fetcher.ts`), the cache (`images.ts`, table `mip0018_images`), `GET /v1/images/{id}` and the `image` object
 * of the API.
 *
 * Never the internet: one local HTTP server on 127.0.0.1 (a random free port ≥ 10000) answers every request. The
 * resolver seam maps test host names to chosen addresses; the dialer seam connects the public test addresses — and
 * only those — to the local server and records every target it is given. The address policy is never a seam. One
 * Postgres 17 container (Testcontainers) for the file, a fresh schema per test.
 */
import { createHash, randomInt } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { runMigrations } from "../../src/postgres/migrate.js";
import { mip0018Migrations } from "../../src/postgres/migrations/mip0018/index.js";
import { createMip0018Api, listen } from "../mip0018/api.ts";
import { observedEventRow, writeEvents } from "../mip0018/fields.ts";
import {
  addressRefusal,
  connectTo,
  type Dialer,
  type DialTarget,
  type FetchDeps,
  fetchImage,
  ImageFetcher,
  type ImageFetcherConfig,
  parseIpv4,
  parseIpv6,
  RateLimiter,
  type ResolvedAddress,
  type Resolver,
  systemDialer,
} from "../mip0018/image-fetcher.ts";
import { claimDueImages, classifyContent, imageKeysOf, rasterType } from "../mip0018/images.ts";
import { serve } from "../mip0018/serve-cli.ts";
import { fieldUsable, IMAGE_KEY_HEX } from "../mip0018/state.ts";
import { checkValue, EVENT_NAME, encodePayload, type MetadataRecord, record } from "../vendor/mip0018/codec/src/index.ts";

const NET = "stagenet";
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Content ──────────────────────────────────────────────────────────────────────────────────────────────────────

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF test jpeg body")]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.from([1, 0, 1, 0]), Buffer.from("test gif body")]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([26, 0, 0, 0]), Buffer.from("WEBPVP8 test webp body")]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>');
const HTML = Buffer.from("<!doctype html><html><body><script>alert(1)</script></body></html>");
/** A distinct PNG per n (bytes after the image end change the hash, not the type). */
const pngN = (n: number): Buffer => Buffer.concat([PNG, Buffer.from(`#${n}`)]);

// ── Names and addresses ──────────────────────────────────────────────────────────────────────────────────────────

/** Public test addresses the dialer seam connects to the local server; never contacted for real. */
const PUBLIC_A = "93.184.215.14";
const PUBLIC_B = "93.184.215.15";
const PUBLIC_V6 = "2606:2800:21f:cb07:6820:80da:af6b:8b2c";
/** A public address whose connection never completes (connect timeout), and one that refuses connections. */
const PUBLIC_HANG = "93.184.215.16";
const PUBLIC_DOWN = "93.184.215.17";
const hostN = (n: number): string => `h${n}.test`;
const publicN = (n: number): string => `93.184.216.${n}`;
const TEST_PUBLIC = new Set([PUBLIC_A, PUBLIC_B, PUBLIC_V6, ...Array.from({ length: 20 }, (_, i) => publicN(i + 1))]);

const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });
const v6 = (address: string): ResolvedAddress => ({ address, family: 6 });
const NAMES: Record<string, ResolvedAddress[]> = {
  "img.test": [v4(PUBLIC_A)],
  "alias.test": [v4(PUBLIC_A)], // another name for img.test's address
  "cdn.test": [v4(PUBLIC_B)],
  "v6.test": [v6(PUBLIC_V6)],
  "hang.test": [v4(PUBLIC_HANG)],
  "down.test": [v4(PUBLIC_DOWN)],
  "localhost": [v4("127.0.0.1"), v6("::1")],
  "loop.test": [v4("127.0.0.1")],
  "private.test": [v4("10.1.2.3")],
  "private172.test": [v4("172.20.0.5")],
  "private192.test": [v4("192.168.1.10")],
  "metadata.test": [v4("169.254.169.254")],
  "cgnat.test": [v4("100.64.0.1")],
  "mixed.test": [v4(PUBLIC_A), v4("192.168.1.10")],
  "mixed6.test": [v6(PUBLIC_V6), v6("fd00::1")],
  "mapped.test": [v6("::ffff:127.0.0.1")],
  "mapped-hex.test": [v6("::ffff:a01:203")],
  "ula.test": [v6("fd00::1")],
  "linklocal6.test": [v6("fe80::1")],
  "loop6.test": [v6("::1")],
  "nat64.test": [v6("64:ff9b::a01:203")],
  "empty.test": [],
  ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [hostN(i + 1), [v4(publicN(i + 1))]])),
};

function makeResolver(): { resolver: Resolver; calls: string[] } {
  const calls: string[] = [];
  let rebind = 0;
  const resolver: Resolver = async (h) => {
    calls.push(h);
    if (h === "rebind.test") return rebind++ === 0 ? [v4(PUBLIC_A)] : [v4("127.0.0.1")];
    if (h === "dnshang.test") return new Promise<ResolvedAddress[]>(() => {});
    const a = NAMES[h];
    if (a === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${h}`), { code: "ENOTFOUND" });
    return a;
  };
  return { resolver, calls };
}

// ── The local test server ────────────────────────────────────────────────────────────────────────────────────────

interface Hit { host: string; path: string; at: number }
interface Local {
  port: number;
  hits: Hit[];
  /** Requests in progress now, and the most at once. */
  open: number;
  maxOpen: number;
  /** `host/path` of responses whose connection closed before the response was finished. */
  cut: string[];
  /** How long `/hold/*` waits before answering. */
  holdMs: number;
  server: Server;
}

function route(L: Local, host: string, target: string, req: IncomingMessage, res: ServerResponse): void {
  const path = target.replace(/\?.*$/, ""); // the query only tells test URLs apart
  const send = (status: number, body: Buffer, type: string, extra: Record<string, string> = {}): void => {
    res.writeHead(status, { "content-type": type, "content-length": String(body.length), "set-cookie": "session=abc", ...extra });
    res.end(body);
  };
  const redirect = (location: string, status = 302): void => {
    res.writeHead(status, { location, "content-length": "0" });
    res.end();
  };
  const r = /^\/r\/(\d+)$/.exec(path);
  if (r !== null) return Number(r[1]) > 0 ? redirect(`/r/${Number(r[1]) - 1}`) : send(200, PNG, "image/png");
  const p = /^\/p\/(\d+)$/.exec(path);
  if (p !== null) return send(200, pngN(Number(p[1])), "image/png");
  const hold = /^\/hold\/(\d+)$/.exec(path);
  if (hold !== null) {
    const t = setTimeout(() => send(200, pngN(100 + Number(hold[1])), "image/png"), L.holdMs);
    res.on("close", () => clearTimeout(t));
    return;
  }
  switch (path) {
    case "/ok.png": return send(200, PNG, "image/png");
    case "/ok.jpg": return send(200, JPEG, "image/jpeg");
    case "/ok.gif": return send(200, GIF, "image/gif");
    case "/ok.webp": return send(200, WEBP, "image/webp");
    case "/logo.svg": return send(200, SVG, "image/svg+xml");
    case "/svg-as-png": return send(200, SVG, "image/png");
    case "/page.html": return send(200, HTML, "text/html");
    case "/empty": return send(200, Buffer.alloc(0), "image/png");
    case "/missing": return send(404, Buffer.from("not found"), "text/plain");
    case "/secret": return send(200, Buffer.from("internal secret"), "text/plain");
    case "/to-loopback": return redirect(`http://127.0.0.1:${L.port}/secret`);
    case "/to-v6-loopback": return redirect(`http://[::1]:${L.port}/secret`);
    case "/to-private": return redirect("http://private.test/secret", 307);
    case "/to-metadata": return redirect("http://169.254.169.254/latest/meta-data/", 301);
    case "/to-ftp": return redirect("ftp://img.test/ok.png");
    case "/to-credentials": return redirect("http://user:pw@img.test/ok.png");
    case "/to-cdn": return redirect("https://cdn.test/ok.png", 308);
    case "/no-location": res.writeHead(302, { "content-length": "0" }); return void res.end();
    case "/gzip": return send(200, Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]), "image/png", { "content-encoding": "gzip" });
    case "/big-declared":
      res.writeHead(200, { "content-type": "image/png", "content-length": String(3 * 1024 * 1024) });
      res.write(PNG); // and never more: the client must cut on the declared length
      return;
    case "/big-chunked": {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(PNG);
      const t = setInterval(() => res.write(Buffer.alloc(16 * 1024, 0x41)), 2);
      res.on("close", () => clearInterval(t));
      return;
    }
    case "/exact": return send(200, Buffer.concat([PNG, Buffer.alloc(64 * 1024 - PNG.length, 0x42)]), "image/png");
    case "/over-by-one": return send(200, Buffer.concat([PNG, Buffer.alloc(64 * 1024 + 1 - PNG.length, 0x42)]), "image/png");
    case "/slow-head": return; // never answers
    case "/slow-body": {
      res.writeHead(200, { "content-type": "image/png", "content-length": "1000" });
      res.write(PNG.subarray(0, 8));
      const t = setInterval(() => res.write(Buffer.from([0x41])), 50);
      res.on("close", () => clearInterval(t));
      return;
    }
    case "/short":
      res.writeHead(200, { "content-type": "image/png", "content-length": "1000" });
      res.write(PNG);
      setTimeout(() => req.socket.destroy(), 20);
      return;
    default: return send(404, Buffer.from("no route"), "text/plain");
  }
}

async function startLocal(): Promise<Local> {
  const L: Local = { port: 0, hits: [], open: 0, maxOpen: 0, cut: [], holdMs: 0, server: undefined as unknown as Server };
  L.server = createServer((req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    const path = req.url ?? "/";
    L.hits.push({ host, path, at: Date.now() });
    L.open++;
    L.maxOpen = Math.max(L.maxOpen, L.open);
    let finished = false;
    res.on("finish", () => (finished = true));
    res.on("close", () => {
      L.open--;
      if (!finished) L.cut.push(`${host}${path}`);
    });
    // Every request the fetcher sends: no cookie, no credentials, no referrer, identity encoding.
    expect([req.method, req.headers.cookie, req.headers.authorization, req.headers.referer, req.headers["accept-encoding"]]).toEqual(["GET", undefined, undefined, undefined, "identity"]);
    route(L, host, path, req, res);
  });
  for (let i = 0; i < 30; i++) {
    const port = randomInt(10_000, 60_000);
    try {
      await new Promise<void>((resolve, reject) => {
        L.server.once("error", reject);
        L.server.listen(port, "127.0.0.1", () => {
          L.server.off("error", reject);
          resolve();
        });
      });
      L.port = port;
      return L;
    } catch (e) {
      if ((e as { code?: string }).code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error("no free port ≥ 10000 for the local test server");
}

/** The dialer seam: the public test addresses → the local server; records every target; never anything else. */
function makeDialer(L: Local): { dialer: Dialer; dials: DialTarget[] } {
  const dials: DialTarget[] = [];
  const dialer: Dialer = (t, signal) => {
    dials.push({ ...t });
    if (t.address === PUBLIC_HANG)
      return new Promise<Duplex>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    if (t.address === PUBLIC_DOWN) return Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    if (!TEST_PUBLIC.has(t.address)) return Promise.reject(new Error(`test dialer: ${t.address} is not a public test address`));
    return new Promise<Duplex>((resolve, reject) => {
      const s = connect(L.port, "127.0.0.1");
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
  };
  return { dialer, dials };
}

// ── Database ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface Db { sql: UmbraDBSql; schema: string; block: number }

const C = "c1".repeat(32);
const ds = (n: number): string => n.toString(16).padStart(64, "0");
const img = (url: string, hash?: Uint8Array): MetadataRecord[] => [record.uri("image", url), ...(hash === undefined ? [] : [record.bytes("image_sha256", hash)])];

interface Row {
  url: string; hash: string; status: string; reason: string | null; type: string | null; content: string | null;
  size: number | null; stored: boolean; attempts: number; nextInMs: number | null;
}

describe("MIP-0018 token images", () => {
  let container: StartedPostgreSqlContainer;
  let L: Local;
  const clients: UmbraDBSql[] = [];
  const servers: Server[] = [];
  let counter = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    L = await startLocal();
  }, 180_000);

  afterAll(async () => {
    for (const s of servers) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
    L?.server.closeAllConnections();
    await new Promise<void>((r) => (L === undefined ? r() : L.server.close(() => r())));
    for (const c of clients) await c.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  async function fresh(prefix: string): Promise<Db> {
    const schema = `${prefix}_img_${counter++}`;
    const sql = createClient({ connectionString: container.getConnectionUri(), schema });
    clients.push(sql);
    await runMigrations(sql, { schema, migrations: mip0018Migrations });
    return { sql, schema, block: 0 };
  }

  /** One accepted MIP-0018 event for the kind-3 identity (C, domainSep) carrying `records`. */
  async function publish(db: Db, domainSep: string, records: MetadataRecord[], kind = 3): Promise<void> {
    db.block++;
    const row = observedEventRow({
      network: NET, position: { block: db.block, tx: 0, event: 0 }, contractAddress: C, type: "Misc", name: EVENT_NAME,
      payload: encodePayload({ domainSep: Buffer.from(domainSep, "hex"), kind }, records),
    });
    expect([row.classification, row.reason]).toEqual(["accept", null]);
    await db.sql.begin((tx) => writeEvents(tx, db.schema, [row]));
  }

  function fetcherFor(db: Db, cfg: ImageFetcherConfig = {}) {
    const r = makeResolver();
    const d = makeDialer(L);
    const logs: string[] = [];
    const f = new ImageFetcher({
      sql: db.sql, network: NET, schema: db.schema, resolver: r.resolver, dialer: d.dialer,
      connectTimeoutMs: 500, responseTimeoutMs: 800, perHostIntervalMs: 0, idleMs: 20, log: (l) => logs.push(l), ...cfg,
    });
    return { f, logs, ...r, ...d };
  }

  /** Rounds until nothing is due (every discovered image checked). */
  async function drain(f: ImageFetcher, db: Db): Promise<void> {
    for (let i = 0; i < 60; i++) {
      await f.runOnce();
      const [n] = await db.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${db.sql(db.schema)}.mip0018_images WHERE status = 'pending' OR next_attempt_at <= now()`;
      if (n?.n === 0) return;
    }
    throw new Error("images still due after 60 rounds");
  }

  async function cache(db: Db): Promise<Row[]> {
    const rows = await db.sql<Array<{
      url: Buffer; image_sha256: Buffer; status: string; reason: string | null; content_type: string | null; content_sha256: Buffer | null;
      size: number | null; stored: boolean; attempts: number; next_in_ms: number | null;
    }>>`
      SELECT url, image_sha256, status, reason, content_type, content_sha256, size, bytes IS NOT NULL AS stored, attempts,
             (extract(epoch FROM (next_attempt_at - now())) * 1000)::float8 AS next_in_ms
      FROM ${db.sql(db.schema)}.mip0018_images ORDER BY url, image_sha256`;
    return rows.map((r) => ({
      url: Buffer.from(r.url).toString("latin1"), hash: Buffer.from(r.image_sha256).toString("hex"), status: r.status, reason: r.reason,
      type: r.content_type, content: r.content_sha256 === null ? null : Buffer.from(r.content_sha256).toString("hex"), size: r.size,
      stored: r.stored, attempts: r.attempts, nextInMs: r.next_in_ms,
    }));
  }
  const rowOf = (rows: Row[], url: string): Row => {
    const found = rows.filter((r) => r.url === url);
    expect(found, url).toHaveLength(1);
    return found[0]!;
  };

  function deps(o: Partial<FetchDeps> = {}): FetchDeps & { calls: string[]; dials: DialTarget[] } {
    const r = makeResolver();
    const d = makeDialer(L);
    return {
      maxBytes: 64 * 1024, connectTimeoutMs: 400, responseTimeoutMs: 500, maxRedirects: 3, perHostIntervalMs: 0,
      resolver: r.resolver, dialer: d.dialer, limiter: new RateLimiter(0), calls: r.calls, dials: d.dials, ...o,
    };
  }
  const never = new AbortController().signal;
  const secretHits = (): Hit[] => L.hits.filter((h) => h.path === "/secret");

  it("[[mip0018.images.address-policy]] the address policy refuses unspecified, loopback, private (RFC 1918, RFC 4193), shared/CGNAT, link-local, multicast, documentation, benchmarking, reserved and cloud-metadata addresses in IPv4 and IPv6, checks the IPv4 address inside IPv4-mapped, NAT64 and 6to4 addresses, refuses everything outside IPv6 global unicast and anything unparseable, and allows public unicast; the parsers read every RFC 4291 text form; raster types come from magic bytes only; the image keys follow the MIP's usability rules", () => {
    const refused: Array<[string, string]> = [
      ["0.0.0.0", "unspecified"], ["0.1.2.3", "unspecified"], ["10.0.0.1", "private"], ["10.255.255.255", "private"],
      ["172.16.0.1", "private"], ["172.31.255.255", "private"], ["192.168.0.1", "private"], ["127.0.0.1", "loopback"],
      ["127.255.255.254", "loopback"], ["169.254.0.1", "link-local"], ["169.254.169.254", "cloud-metadata"],
      ["100.100.100.200", "cloud-metadata"], ["192.0.0.192", "cloud-metadata"], ["168.63.129.16", "cloud-metadata"],
      ["100.64.0.1", "shared-cgnat"], ["100.127.255.255", "shared-cgnat"], ["192.0.0.8", "protocol-assignments"],
      ["192.0.2.1", "documentation"], ["198.51.100.7", "documentation"], ["203.0.113.9", "documentation"],
      ["198.18.0.1", "benchmarking"], ["198.19.255.255", "benchmarking"], ["192.88.99.1", "relay-anycast"],
      ["224.0.0.1", "multicast"], ["239.255.255.250", "multicast"], ["240.0.0.1", "reserved"], ["255.255.255.255", "reserved"],
      ["::", "unspecified"], ["::1", "loopback"], ["[::1]", "loopback"], ["fe80::1", "link-local"], ["fe80::1%eth0", "link-local"],
      ["fc00::1", "unique-local"], ["fd12:3456::1", "unique-local"], ["fd00:ec2::254", "cloud-metadata"], ["fec0::1", "site-local"],
      ["ff02::1", "multicast"], ["ff0e::1", "multicast"], ["::ffff:127.0.0.1", "loopback"], ["::ffff:7f00:1", "loopback"],
      ["::ffff:10.0.0.1", "private"], ["::ffff:169.254.169.254", "cloud-metadata"], ["64:ff9b::a00:1", "private"],
      ["64:ff9b::7f00:1", "loopback"], ["2002:7f00:1::1", "loopback"], ["2002:c0a8:101::1", "private"],
      ["::127.0.0.1", "ipv4-compatible"], ["::a00:1", "ipv4-compatible"], ["64:ff9b:1::1", "nat64-local"],
      ["100::1", "discard"], ["2001::1", "protocol-assignments"], ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "protocol-assignments"],
      ["2001:db8::1", "documentation"], ["3fff::1", "documentation"], ["4000::1", "reserved"], ["5f00::1", "reserved"],
      ["1::1", "reserved"], ["8000::1", "reserved"],
      ["localhost", "unparseable"], ["010.0.0.1", "unparseable"], ["1.2.3", "unparseable"], ["1.2.3.256", "unparseable"],
      ["0x7f.0.0.1", "unparseable"], ["2130706433", "unparseable"], ["1:2:3:4:5:6:7:8:9", "unparseable"], ["1::2::3", "unparseable"],
      ["::ffff:1.2.3", "unparseable"], ["1.2.3.4::", "unparseable"], ["", "unparseable"], ["gggg::1", "unparseable"],
    ];
    for (const [a, why] of refused) expect([a, addressRefusal(a)]).toEqual([a, why]);
    const allowed = [
      "93.184.215.14", "8.8.8.8", "1.1.1.1", "11.0.0.1", "172.15.255.255", "172.32.0.0", "100.63.255.255", "100.128.0.0",
      "169.253.255.255", "169.255.0.1", "192.0.1.1", "192.169.0.1", "198.17.255.255", "198.20.0.1", "223.255.255.255",
      "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", PUBLIC_V6, "::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808",
      "2002:808:808::1", "2001:200::1", "2620:4f:8000::1", "3ffe::1",
    ];
    for (const a of allowed) expect([a, addressRefusal(a)]).toEqual([a, undefined]);
    for (const n of [hostN(1), "img.test"]) expect(NAMES[n]!.every((x) => addressRefusal(x.address) === undefined)).toBe(true);
    for (const a of TEST_PUBLIC) expect(addressRefusal(a)).toBeUndefined();

    // Parsers: every text form of one address gives one number.
    expect(parseIpv4("192.168.1.1")).toBe(0xc0a80101);
    expect(parseIpv4("0.0.0.0")).toBe(0);
    expect(parseIpv4("255.255.255.255")).toBe(0xffffffff);
    const forms = ["2001:db8:0:0:0:0:2:1", "2001:db8::2:1", "2001:DB8::2:1", "2001:0db8:0000:0000:0000:0000:0002:0001", "[2001:db8::2:1]", "2001:db8::0.2.0.1"];
    for (const f of forms) expect([f, parseIpv6(f)]).toEqual([f, 0x20010db8000000000000000000020001n]);
    expect(parseIpv6("::")).toBe(0n);
    expect(parseIpv6("::ffff:1.2.3.4")).toBe(0xffff01020304n);
    for (const bad of ["1:2:3:4:5:6:7:8:9", ":::", "1::2::3", "12345::", "1:2:3:4:5:6:7::8", "::1.2.3.4:5"]) expect([bad, parseIpv6(bad)]).toEqual([bad, undefined]);

    // Raster types by magic bytes only.
    expect([PNG, JPEG, GIF, WEBP].map(rasterType)).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    expect(rasterType(Buffer.from("GIF87a...."))).toBe("image/gif");
    for (const b of [SVG, HTML, Buffer.alloc(0), PNG.subarray(0, 7), Buffer.from("RIFF\x00\x00\x00\x00WAVEfmt "), Buffer.from([0xff, 0xd8]), Buffer.from("<?xml version=\"1.0\"?><svg/>")])
      expect(rasterType(b)).toBeUndefined();
    // A hash that differs decides first (whatever the content); then the type; then verified / unverified.
    expect(classifyContent(PNG, createHash("sha256").update(PNG).digest())).toMatchObject({ status: "verified", contentType: "image/png", size: PNG.length });
    expect(classifyContent(PNG, null)).toMatchObject({ status: "unverified", contentType: "image/png" });
    expect(classifyContent(PNG, Buffer.alloc(32, 7))).toEqual({ status: "mismatch", contentSha256: Buffer.from(sha(PNG), "hex"), size: PNG.length });
    expect(classifyContent(HTML, Buffer.alloc(32, 7)).status).toBe("mismatch");
    expect(classifyContent(SVG, createHash("sha256").update(SVG).digest())).toEqual({ status: "not-image", contentSha256: Buffer.from(sha(SVG), "hex"), size: SVG.length });
    expect(classifyContent(HTML, null).status).toBe("not-image");

    // The image keys (MIP "Common fields"): `image` usable as a type-4 URI, `image_sha256` as exactly 32 type-0 bytes —
    // the state's usability rule (`fieldUsable`), the one the stored `usable` flag comes from.
    const uri = { valType: 4, value: Buffer.from("https://example.org/acme.png") };
    expect(imageKeysOf(uri, { valType: 0, value: Buffer.alloc(32, 1) })).toEqual({ url: Buffer.from("https://example.org/acme.png"), sha256: Buffer.alloc(32, 1) });
    expect(imageKeysOf(uri, undefined)).toEqual({ url: uri.value, sha256: null });
    expect(imageKeysOf(uri, { valType: 0, value: Buffer.alloc(31, 1) })?.sha256).toBeNull(); // S12: not 32 bytes → unusable
    expect(imageKeysOf(uri, { valType: 1, value: Buffer.alloc(32, 0x61) })?.sha256).toBeNull();
    expect(imageKeysOf({ valType: 1, value: uri.value }, undefined)).toBeUndefined(); // a string, not a URI
    expect(imageKeysOf(undefined, { valType: 0, value: Buffer.alloc(32) })).toBeUndefined();
    const hashes = [Buffer.alloc(32, 1), Buffer.alloc(31, 1), Buffer.alloc(33, 1), Buffer.alloc(0)];
    for (const [valType, value] of [[4, uri.value], [1, uri.value], [0, uri.value], [3, uri.value]] as const)
      expect(imageKeysOf({ valType, value }, undefined) !== undefined).toBe(fieldUsable(IMAGE_KEY_HEX.image, valType, value) === true);
    for (const value of hashes)
      for (const valType of [0, 1])
        expect(imageKeysOf(uri, { valType, value })?.sha256 !== null).toBe(fieldUsable(IMAGE_KEY_HEX.imageSha256, valType, value) === true);
    // A type-4 value that is not an ASCII RFC 3986 URI never reaches the fields: the codec rejects its event.
    expect(checkValue(4, Buffer.from("https://exämple.org/"))).toBe("invalid-uri");
    expect(checkValue(4, Buffer.from("https://example.org/a b"))).toBe("invalid-uri");

    // The rate limiter: one start per interval per key, a bounded wait.
    let now = 1_000;
    const lim = new RateLimiter(250, () => now);
    expect([lim.reserve(["a"], 500), lim.reserve(["a"], 500), lim.reserve(["a"], 500), lim.reserve(["a"], 500)]).toEqual([0, 250, 500, undefined]);
    expect(lim.readyIn(["a"])).toBe(750);
    expect(lim.reserve(["b"], 0)).toBe(0);
    expect(lim.reserve(["b", "a"], 500)).toBeUndefined(); // a key in common waits for the busiest one
    now += 750;
    expect(lim.reserve(["a", "c"], 0)).toBe(0);
  }, 30_000);

  it("[[mip0018.images.statuses]] the background fetcher checks every image an identity names: verified (image_sha256 set and equal: PNG), unverified (no usable image_sha256, or one of 31 bytes: JPEG, WebP over IPv6), mismatch (hash differs, even for a raster), not-image (SVG, SVG served as image/png, HTML, an empty body, even when its hash matches), unreachable (404, unknown name, refused connection) retried with doubling back-off; bytes are stored only for verified and unverified rasters; a verified image is final and the others are checked again later; a failed re-check keeps the earlier result; an unusable image, and an identity that no longer exists, name nothing; the table refuses stored bytes for any other status", async () => {
    const db = await fresh("st");
    const seed: Array<[number, MetadataRecord[]]> = [
      [1, img("http://img.test/ok.png", createHash("sha256").update(PNG).digest())],
      [2, img("http://img.test/ok.jpg")],
      [3, img("http://img.test/ok.jpg?h31", Buffer.alloc(31, 9))],
      [4, img("http://v6.test/ok.webp")],
      [5, img("http://img.test/ok.gif", Buffer.alloc(32, 7))],
      [6, img("http://img.test/page.html?with-hash", Buffer.alloc(32, 7))],
      [7, img("http://img.test/logo.svg")],
      [8, img("http://img.test/svg-as-png")],
      [9, img("http://img.test/page.html")],
      [10, img("http://img.test/empty")],
      [11, img("http://img.test/logo.svg?hash-matches", createHash("sha256").update(SVG).digest())],
      [12, img("http://img.test/missing")],
      [13, img("http://nowhere.test/ok.png")],
      [14, img("http://down.test/ok.png")],
      [15, [record.utf8("image", "http://img.test/ok.png?as-text")]],
      [16, [record.utf8("name", "No image")]],
      [19, img("http://img.test/ok.png?withdrawn")],
    ];
    for (const [n, recs] of seed) await publish(db, ds(n), recs);
    // An identity that no longer exists names no image: its image deleted by a Null record (it had no other field).
    await publish(db, ds(19), [record.tombstone("image")]);
    // Two identities naming the same image share one cache row; the same URL with another hash is another row.
    await publish(db, ds(17), img("http://img.test/ok.jpg"));
    await publish(db, ds(18), img("http://img.test/ok.png", Buffer.alloc(32, 7)));

    const { f, dials } = fetcherFor(db, { retryBaseMs: 60_000, retryMaxMs: 3_600_000, recheckMs: 86_400_000 });
    await drain(f, db);
    const rows = await cache(db);
    expect(rows.map((r) => r.url).filter((u) => u.includes("as-text") || u.includes("withdrawn"))).toEqual([]);
    expect(rows).toHaveLength(15); // 14 named images (two identities share ok.jpg) + ok.png with a second hash

    const verified = rows.filter((r) => r.url === "http://img.test/ok.png" && r.hash === sha(PNG))[0]!;
    expect(verified).toMatchObject({ status: "verified", type: "image/png", content: sha(PNG), size: PNG.length, stored: true, reason: null, attempts: 0, nextInMs: null });
    expect(rowOf(rows, "http://img.test/ok.jpg")).toMatchObject({ status: "unverified", hash: "", type: "image/jpeg", content: sha(JPEG), stored: true });
    expect(rowOf(rows, "http://img.test/ok.jpg?h31")).toMatchObject({ status: "unverified", hash: "", type: "image/jpeg", stored: true });
    expect(rowOf(rows, "http://v6.test/ok.webp")).toMatchObject({ status: "unverified", type: "image/webp", content: sha(WEBP), stored: true });
    expect(dials.filter((d) => d.hostname === "v6.test").map((d) => [d.address, d.family, d.port, d.tls])).toEqual([[PUBLIC_V6, 6, 80, false]]);
    expect(rowOf(rows, "http://img.test/ok.gif")).toMatchObject({ status: "mismatch", hash: "07".repeat(32), content: sha(GIF), type: null, stored: false });
    expect(rows.filter((r) => r.url === "http://img.test/ok.png" && r.hash === "07".repeat(32))[0]).toMatchObject({ status: "mismatch", content: sha(PNG), stored: false });
    expect(rowOf(rows, "http://img.test/page.html?with-hash")).toMatchObject({ status: "mismatch", stored: false });
    for (const u of ["http://img.test/logo.svg", "http://img.test/svg-as-png", "http://img.test/page.html", "http://img.test/empty", "http://img.test/logo.svg?hash-matches"])
      expect(rowOf(rows, u), u).toMatchObject({ status: "not-image", type: null, stored: false });
    expect(rowOf(rows, "http://img.test/logo.svg?hash-matches").content).toBe(sha(SVG));
    expect(rowOf(rows, "http://img.test/empty")).toMatchObject({ size: 0, content: sha(Buffer.alloc(0)) });
    for (const [u, reason] of [["http://img.test/missing", "http-404"], ["http://nowhere.test/ok.png", "dns"], ["http://down.test/ok.png", "connect"]] as const)
      expect(rowOf(rows, u), u).toMatchObject({ status: "unreachable", reason, attempts: 1, stored: false, content: null });

    // Schedule: verified final; unverified / mismatch / not-image re-checked after recheckMs; unreachable after the
    // back-off (1 × base after the first failure).
    for (const r of rows) {
      if (r.status === "verified") {
        expect(r.nextInMs).toBeNull();
      } else if (r.status === "unreachable") {
        expect(r.nextInMs!).toBeGreaterThan(55_000);
        expect(r.nextInMs!).toBeLessThanOrEqual(60_000);
      } else {
        expect(r.nextInMs!).toBeGreaterThan(86_000_000);
      }
    }
    // A second failure doubles the delay; the reason stays the latest.
    await db.sql`UPDATE ${db.sql(db.schema)}.mip0018_images SET next_attempt_at = now() WHERE status = 'unreachable'`;
    await f.runOnce();
    for (const r of (await cache(db)).filter((x) => x.status === "unreachable")) {
      expect(r.attempts, r.url).toBe(2);
      expect(r.nextInMs!).toBeGreaterThan(115_000);
      expect(r.nextInMs!).toBeLessThanOrEqual(120_000);
    }
    // A re-check that fails keeps the earlier result (bytes and status) and backs off.
    await db.sql`UPDATE ${db.sql(db.schema)}.mip0018_images SET url = convert_to('http://img.test/missing?was-ok', 'UTF8')
                 WHERE status = 'unreachable' AND url = convert_to('http://img.test/missing', 'UTF8')`;
    await db.sql`UPDATE ${db.sql(db.schema)}.mip0018_images SET url = convert_to('http://img.test/missing', 'UTF8'), next_attempt_at = now()
                 WHERE url = convert_to('http://img.test/ok.jpg', 'UTF8')`;
    await f.runOnce();
    expect(rowOf(await cache(db), "http://img.test/missing")).toMatchObject({ status: "unverified", type: "image/jpeg", stored: true, attempts: 1 });

    // The table holds bytes only for verified / unverified rows, and only bytes that hash to content_sha256.
    const t = db.sql`${db.sql(db.schema)}.mip0018_images`;
    const base = { url: Buffer.from("http://x.test/a"), image_sha256: Buffer.alloc(32, 7), status: "mismatch", content_sha256: Buffer.from(sha(PNG), "hex"), size: PNG.length, checked_at: new Date() };
    await expect(db.sql`INSERT INTO ${t} ${db.sql({ ...base, bytes: PNG, content_type: "image/png" })}`).rejects.toMatchObject({ code: "23514" });
    await expect(db.sql`INSERT INTO ${t} ${db.sql({ ...base, status: "verified", bytes: PNG, content_type: "image/png" })}`).rejects.toMatchObject({ code: "23514" });
    await expect(db.sql`INSERT INTO ${t} ${db.sql({ ...base, image_sha256: Buffer.alloc(0), status: "unverified", bytes: GIF, content_type: "image/png" })}`).rejects.toMatchObject({ code: "23514" });
    await expect(db.sql`INSERT INTO ${t} ${db.sql({ ...base, image_sha256: Buffer.alloc(0), status: "unverified", bytes: SVG, content_sha256: Buffer.from(sha(SVG), "hex"), size: SVG.length, content_type: "image/svg+xml" })}`).rejects.toMatchObject({ code: "23514" });
    await expect(db.sql`INSERT INTO ${t} ${db.sql({ ...base, status: "unreachable" })}`).rejects.toMatchObject({ code: "23514" });
    await db.sql`INSERT INTO ${t} ${db.sql(base)}`;
  }, 120_000);

  it("[[mip0018.images.ssrf]] nothing private is ever contacted: IP-literal and named loopback, private, link-local, CGNAT, cloud-metadata, IPv6 loopback/ULA/link-local and IPv4-mapped/NAT64 targets are refused before any connection (a host with one refused address among public ones too); a redirect from an allowed host to 127.0.0.1, ::1, a private name or a metadata address is refused after the hop; other schemes, user names and passwords are refused, also as redirect targets; at most 3 redirects, relative ones included; the connection goes to the address checked once (a second DNS answer cannot change it); the production dialer refuses a private address and connects only to the address it is given, TLS included", async () => {
    const before = secretHits().length;
    const d = deps();
    const refusedUrls = [
      `http://127.0.0.1:${L.port}/secret`, `http://[::1]:${L.port}/secret`, `http://localhost:${L.port}/secret`, `http://0x7f.1:${L.port}/secret`,
      `http://2130706433:${L.port}/secret`, `http://[::ffff:127.0.0.1]:${L.port}/secret`, "http://loop.test/secret", "http://loop6.test/secret",
      "http://private.test/secret", "http://private172.test/secret", "http://private192.test/secret", "http://metadata.test/latest/meta-data/",
      "http://169.254.169.254/latest/meta-data/", "http://cgnat.test/secret", "http://mapped.test/secret", "http://mapped-hex.test/secret",
      "http://ula.test/secret", "http://linklocal6.test/secret", "http://nat64.test/secret", "http://mixed.test/secret", "http://mixed6.test/secret",
      "https://private.test/secret", "http://[fd00:ec2::254]/latest/meta-data/",
    ];
    for (const u of refusedUrls) expect([u, await fetchImage(u, d, never)]).toEqual([u, { ok: false, reason: "address-refused" }]);
    expect(d.dials).toEqual([]); // refused before any connection

    // Redirects from an allowed host to a refused target: the first hop is fetched, the target never.
    for (const p of ["/to-loopback", "/to-v6-loopback", "/to-private", "/to-metadata"])
      expect([p, await fetchImage(`http://img.test${p}`, d, never)]).toEqual([p, { ok: false, reason: "address-refused" }]);
    expect(L.hits.filter((h) => h.path.startsWith("/to-")).length).toBeGreaterThanOrEqual(4);
    expect(d.dials.map((x) => x.address)).toEqual([PUBLIC_A, PUBLIC_A, PUBLIC_A, PUBLIC_A]);

    // Schemes and credentials, first URL or redirect target.
    for (const [u, reason] of [
      ["ftp://img.test/ok.png", "scheme"], ["file:///etc/passwd", "scheme"], ["data:image/png;base64,iVBORw0KGgo=", "scheme"],
      ["gopher://img.test/", "scheme"], ["http://user:pw@img.test/ok.png", "credentials"], ["http://user@img.test/ok.png", "credentials"],
      ["http://img.test/to-ftp", "scheme"], ["http://img.test/to-credentials", "credentials"], ["not a url", "bad-url"],
      ["http://img.test/no-location", "redirect-location"],
    ] as const) expect([u, await fetchImage(u, d, never)]).toEqual([u, { ok: false, reason }]);

    // Redirect limit: 3 are followed (relative locations resolve against the current URL), the 4th is refused.
    expect(await fetchImage("http://img.test/r/3", d, never)).toEqual({ ok: true, bytes: PNG });
    expect(await fetchImage("http://img.test/r/4", d, never)).toEqual({ ok: false, reason: "too-many-redirects" });
    expect(L.hits.filter((h) => h.path === "/r/0").length).toBeGreaterThanOrEqual(1);
    // An https redirect to another allowed host: dialed on 443 with TLS, by the checked address.
    const before443 = d.dials.length;
    expect(await fetchImage("http://img.test/to-cdn", d, never)).toEqual({ ok: true, bytes: PNG });
    expect(d.dials.slice(before443).map((x) => [x.hostname, x.address, x.port, x.tls])).toEqual([["img.test", PUBLIC_A, 80, false], ["cdn.test", PUBLIC_B, 443, true]]);

    // DNS rebinding: one fetch resolves its name once and connects to that checked address, even though the next
    // answer is 127.0.0.1; the next fetch sees the new answer and is refused.
    const r = deps();
    expect(await fetchImage("http://rebind.test/ok.png", r, never)).toEqual({ ok: true, bytes: PNG });
    expect(r.calls.filter((h) => h === "rebind.test")).toHaveLength(1);
    expect(r.dials.map((x) => [x.hostname, x.address])).toEqual([["rebind.test", PUBLIC_A]]);
    expect(await fetchImage("http://rebind.test/secret", r, never)).toEqual({ ok: false, reason: "address-refused" });
    expect(r.dials).toHaveLength(1);
    expect(await fetchImage("http://empty.test/ok.png", r, never)).toEqual({ ok: false, reason: "dns" });

    // Through the worker: a refused image is recorded unreachable (address-refused) and retried with back-off.
    const db = await fresh("ssrf");
    await publish(db, ds(1), img(`http://127.0.0.1:${L.port}/secret`));
    await publish(db, ds(2), img("http://img.test/to-loopback"));
    const w = fetcherFor(db);
    await drain(w.f, db);
    for (const row of await cache(db)) expect(row).toMatchObject({ status: "unreachable", reason: "address-refused", attempts: 1 });
    expect(w.dials.every((x) => addressRefusal(x.address) === undefined)).toBe(true);
    expect(secretHits().length).toBe(before); // the local server never saw a request for /secret

    // The production dialer: checks the address again, connects to exactly the address given (never a name).
    await expect(systemDialer({ address: "127.0.0.1", family: 4, port: L.port, hostname: "img.test", tls: false }, never)).rejects.toThrow(/address refused: loopback/);
    await expect(systemDialer({ address: "10.0.0.1", family: 4, port: 80, hostname: "img.test", tls: true }, never)).rejects.toThrow(/address refused: private/);
    const s = await connectTo({ address: "127.0.0.1", family: 4, port: L.port, hostname: "img.test", tls: false }, never);
    s.destroy();
    // TLS is really negotiated: against the plain-HTTP test server the handshake fails.
    await expect(connectTo({ address: "127.0.0.1", family: 4, port: L.port, hostname: "img.test", tls: true }, never)).rejects.toThrow();
    const aborted = new AbortController();
    aborted.abort();
    await expect(connectTo({ address: "127.0.0.1", family: 4, port: L.port, hostname: "img.test", tls: false }, aborted.signal)).rejects.toThrow(/aborted/);
  }, 120_000);

  it("[[mip0018.images.caps]] oversize and slow answers are cut: a declared Content-Length above the cap is refused at the headers and a longer body is cut at the cap (exactly the cap is kept), the server sees the connection closed; an answer whose headers or body do not finish within the response timeout is cut; a connection or a name lookup that does not finish within the connect timeout is abandoned; a short body and an encoded (gzip) answer yield no content", async () => {
    const d = deps({ maxBytes: 64 * 1024, responseTimeoutMs: 500, connectTimeoutMs: 400 });
    expect(await fetchImage("http://img.test/big-declared", d, never)).toEqual({ ok: false, reason: "too-large" });
    let t0 = Date.now();
    expect(await fetchImage("http://img.test/big-chunked", d, never)).toEqual({ ok: false, reason: "too-large" });
    expect(Date.now() - t0).toBeLessThan(500); // cut by size, not by the timeout
    const exact = await fetchImage("http://img.test/exact", d, never);
    expect(exact.ok && exact.bytes.length).toBe(64 * 1024);
    expect(await fetchImage("http://img.test/over-by-one", d, never)).toEqual({ ok: false, reason: "too-large" });
    for (const [path, ms] of [["/slow-head", 500], ["/slow-body", 500]] as const) {
      t0 = Date.now();
      expect([path, await fetchImage(`http://img.test${path}`, d, never)]).toEqual([path, { ok: false, reason: "timeout" }]);
      const took = Date.now() - t0;
      expect(took, path).toBeGreaterThanOrEqual(ms - 20);
      expect(took, path).toBeLessThan(ms + 2_000);
    }
    for (const [host, ms] of [["hang.test", 400], ["dnshang.test", 400]] as const) {
      t0 = Date.now();
      expect([host, await fetchImage(`http://${host}/ok.png`, d, never)]).toEqual([host, { ok: false, reason: "timeout" }]);
      expect(Date.now() - t0).toBeLessThan(ms + 2_000);
    }
    expect(await fetchImage("http://img.test/short", d, never)).toEqual({ ok: false, reason: "incomplete" });
    expect(await fetchImage("http://img.test/gzip", d, never)).toEqual({ ok: false, reason: "content-encoding" });
    for (let i = 0; i < 100 && L.open > 0; i++) await sleep(20);
    for (const p of ["/big-declared", "/big-chunked", "/slow-head", "/slow-body"]) expect(L.cut, p).toContain(`img.test${p}`);
    expect(L.open).toBe(0);

    // Through the worker with the default 2 MiB cap: the 3 MiB declaration is recorded as unreachable (too-large).
    const db = await fresh("caps");
    await publish(db, ds(1), img("http://img.test/big-declared"));
    await publish(db, ds(2), img("http://img.test/slow-head"));
    const w = fetcherFor(db, { responseTimeoutMs: 300 });
    await drain(w.f, db);
    const rows = await cache(db);
    expect(rowOf(rows, "http://img.test/big-declared")).toMatchObject({ status: "unreachable", reason: "too-large" });
    expect(rowOf(rows, "http://img.test/slow-head")).toMatchObject({ status: "unreachable", reason: "timeout" });
  }, 120_000);

  it("[[mip0018.images.limits]] the per-host and per-address rate limit spaces requests to one host (and to other names of its address) by the interval, a busy host's images wait for their turn and are never counted as failures; the global concurrency limit holds the number of requests in progress at exactly its value", async () => {
    // Rate: 3 images on img.test and 2 on alias.test (same address), interval 250 ms, 5 slots.
    const db = await fresh("rate");
    const paths = [1, 2, 3].map((n) => `http://img.test/p/${n}`).concat([4, 5].map((n) => `http://alias.test/p/${n}`));
    for (const [i, u] of paths.entries()) await publish(db, ds(i + 1), img(u));
    const start = L.hits.length;
    const w = fetcherFor(db, { perHostIntervalMs: 250, maxConcurrent: 5, idleMs: 20 });
    w.f.start();
    try {
      for (let i = 0; i < 300; i++) {
        const rows = await cache(db);
        if (rows.length === 5 && rows.every((r) => r.status === "unverified")) break;
        await sleep(20);
      }
    } finally {
      await w.f.stop();
    }
    const rows = await cache(db);
    expect(rows.map((r) => [r.status, r.attempts])).toEqual(paths.map(() => ["unverified", 0]));
    const hits = L.hits.slice(start).filter((h) => h.path.startsWith("/p/")).sort((a, b) => a.at - b.at);
    expect(hits).toHaveLength(5);
    for (let i = 1; i < hits.length; i++) expect(hits[i]!.at - hits[i - 1]!.at, JSON.stringify(hits)).toBeGreaterThanOrEqual(235);

    // Concurrency: 6 images on 6 hosts, each answered after 300 ms, 2 slots.
    const db2 = await fresh("conc");
    for (let n = 1; n <= 6; n++) await publish(db2, ds(n), img(`http://${hostN(n)}/hold/${n}`));
    L.holdMs = 300;
    L.maxOpen = 0;
    const c = fetcherFor(db2, { maxConcurrent: 2, idleMs: 20 });
    c.f.start();
    try {
      for (let i = 0; i < 300; i++) {
        const r2 = await cache(db2);
        if (r2.length === 6 && r2.every((r) => r.status === "unverified")) break;
        await sleep(20);
      }
    } finally {
      await c.f.stop();
      L.holdMs = 0;
    }
    expect((await cache(db2)).map((r) => r.status)).toEqual(Array(6).fill("unverified"));
    expect(L.maxOpen).toBe(2);
  }, 120_000);

  it("[[mip0018.images.resume]] a restart resumes pending fetches: stopping the fetcher mid-fetch gives its rows back unchecked and due at once; a fetcher that dies holds its claimed rows only until the lease ends, then another fetcher checks them; two fetchers never claim one row", async () => {
    const db = await fresh("resume");
    for (let n = 1; n <= 3; n++) await publish(db, ds(n), img(`http://${hostN(n)}/hold/${n}`));
    L.holdMs = 10_000;
    const a = fetcherFor(db, { maxConcurrent: 3, responseTimeoutMs: 20_000 });
    a.f.start();
    try {
      for (let i = 0; i < 250 && L.open < 3; i++) await sleep(20);
      expect(L.open).toBe(3);
    } finally {
      await a.f.stop();
    }
    for (let i = 0; i < 100 && L.open > 0; i++) await sleep(20);
    expect(L.open).toBe(0);
    let rows = await cache(db);
    expect(rows.map((r) => r.status)).toEqual(["pending", "pending", "pending"]);
    for (const r of rows) expect(r.nextInMs!).toBeLessThanOrEqual(0);
    L.holdMs = 0;

    // A fetcher that claims and dies: its lease keeps the rows from others until it ends.
    const claimed = await claimDueImages(db.sql, db.schema, { limit: 10, leaseMs: 600 });
    expect(claimed).toHaveLength(3);
    expect(await claimDueImages(db.sql, db.schema, { limit: 10, leaseMs: 600 })).toEqual([]); // nobody else gets them
    const b = fetcherFor(db);
    const hits = L.hits.length;
    await b.f.runOnce();
    expect(L.hits.length).toBe(hits);
    expect((await cache(db)).map((r) => r.status)).toEqual(["pending", "pending", "pending"]);
    await sleep(650);
    await drain(b.f, db);
    rows = await cache(db);
    expect(rows.map((r) => [r.status, r.content])).toEqual([1, 2, 3].map((n) => ["unverified", sha(pngN(100 + n))]));
  }, 120_000);

  it("[[mip0018.images.endpoint]] GET /v1/images/{id} serves only verified and unverified raster bytes by their SHA-256, with the detected Content-Type, nosniff, a sandbox CSP and an immutable Cache-Control (HEAD: headers only); mismatch and not-image content, unknown ids and stored bytes whose type no longer matches are 404, a malformed id 400; token list, contract and identity JSON carry image { url (text), status, imageUrl (same-origin, only when displayable) } — pending until checked, null without a usable image; serve() runs the fetcher with the scan loop (never with --api-only or --no-image-fetch)", async () => {
    const db = await fresh("api");
    const cases: Array<[number, MetadataRecord[]]> = [
      [1, img("http://img.test/ok.png", createHash("sha256").update(PNG).digest())],
      [2, img("http://img.test/ok.jpg")],
      [3, img("http://img.test/ok.gif", Buffer.alloc(32, 7))],
      [4, img("http://img.test/logo.svg")],
      [5, img("http://img.test/missing")],
      [6, [record.utf8("image", "http://img.test/ok.png")]],
      [7, [record.utf8("name", "No image")]],
    ];
    for (const [n, recs] of cases) await publish(db, ds(n), recs);
    const w = fetcherFor(db);
    await drain(w.f, db);
    await publish(db, ds(8), img("http://img.test/later.png")); // described after the last round: not checked yet

    const server = createMip0018Api({ sql: db.sql, network: NET, schema: db.schema, log: () => {} });
    servers.push(server);
    const base = `http://127.0.0.1:${await listen(server, 0)}`;
    const get = async (path: string, init?: RequestInit) => {
      const r = await fetch(base + path, init);
      return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
    };
    const json = async (path: string) => {
      const r = await get(path);
      expect(r.status, path).toBe(200);
      expect(/^[\x20-\x7e]*$/.test(r.body.toString("latin1"))).toBe(true);
      return JSON.parse(r.body.toString("utf8")) as { items: Array<{ domainSep: string; image: unknown }> } & Record<string, unknown>;
    };
    const png = `/v1/images/${sha(PNG)}`;
    const jpg = `/v1/images/${sha(JPEG)}`;
    const expected: Record<number, unknown> = {
      1: { url: "http://img.test/ok.png", status: "verified", imageUrl: png },
      2: { url: "http://img.test/ok.jpg", status: "unverified", imageUrl: jpg },
      3: { url: "http://img.test/ok.gif", status: "mismatch", imageUrl: null },
      4: { url: "http://img.test/logo.svg", status: "not-image", imageUrl: null },
      5: { url: "http://img.test/missing", status: "unreachable", imageUrl: null },
      6: null,
      7: null,
      8: { url: "http://img.test/later.png", status: "pending", imageUrl: null },
    };
    const list = await json("/v1/tokens");
    expect(Object.fromEntries(list.items.map((i) => [parseInt(i.domainSep, 16), i.image]))).toEqual(expected);
    const contract = await json(`/v1/contracts/${C}/tokens`);
    expect(Object.fromEntries(contract.items.map((i) => [parseInt(i.domainSep, 16), i.image]))).toEqual(expected);
    for (const [n, image] of Object.entries(expected))
      expect((await json(`/v1/identities/${C}/${ds(Number(n))}/3`)).image, n).toEqual(image);

    // The image bytes: same origin, raster type from the bytes, no sniffing, no script, cacheable.
    for (const [path, bytes, type] of [[png, PNG, "image/png"], [jpg, JPEG, "image/jpeg"], [png.toUpperCase().replace("/V1/IMAGES/", "/v1/images/"), PNG, "image/png"]] as const) {
      const r = await get(path);
      expect([r.status, r.headers.get("content-type"), r.headers.get("x-content-type-options"), r.headers.get("content-security-policy"),
        r.headers.get("cache-control"), r.headers.get("content-length"), r.headers.get("cross-origin-resource-policy")]).toEqual(
        [200, type, "nosniff", "sandbox; default-src 'none'", "public, max-age=31536000, immutable", String(bytes.length), "same-origin"]);
      expect(r.body.equals(bytes)).toBe(true);
    }
    const head = await get(png, { method: "HEAD" });
    expect([head.status, head.headers.get("content-type"), head.headers.get("content-length"), head.body.length]).toEqual([200, "image/png", String(PNG.length), 0]);
    for (const id of [sha(GIF), sha(SVG), sha(Buffer.from("no such image"))]) {
      const r = await get(`/v1/images/${id}`);
      expect([r.status, JSON.parse(r.body.toString()).error.code, r.headers.get("content-type")]).toEqual([404, "NOT_FOUND", "application/json; charset=utf-8"]);
    }
    for (const bad of ["/v1/images/xyz", `/v1/images/${sha(PNG)}00`, `/v1/images/${sha(PNG)}?x=1`]) expect((await get(bad)).status, bad).toBe(400);
    expect((await get(`/v1/images/${sha(PNG)}/x`)).status).toBe(404);
    expect((await get(png, { method: "POST" })).status).toBe(405);
    // Defence in depth: stored bytes whose magic bytes no longer match the stored type are not served.
    await db.sql`UPDATE ${db.sql(db.schema)}.mip0018_images SET content_type = 'image/gif' WHERE content_sha256 = ${Buffer.from(sha(JPEG), "hex")}`;
    expect((await get(jpg)).status).toBe(404);

    // serve(): the fetcher runs with the scan loop; the token list then shows the checked image.
    const sdb = await fresh("serve");
    const archive = `${sdb.schema}_archive`;
    await bootstrapChainArchiveSchema(sdb.sql, archive);
    await publish(sdb, ds(1), img("http://img.test/ok.png", createHash("sha256").update(PNG).digest()));
    const seams = (() => {
      const r = makeResolver();
      const d = makeDialer(L);
      return { resolver: r.resolver, dialer: d.dialer, dials: d.dials };
    })();
    const logs: string[] = [];
    const h = await serve({
      sql: sdb.sql, network: NET, schema: sdb.schema, archiveSchema: archive, port: 0, scanIdleMs: 50, log: (l) => logs.push(l),
      imageFetch: { resolver: seams.resolver, dialer: seams.dialer, idleMs: 20, perHostIntervalMs: 0 },
    });
    try {
      const sbase = `http://127.0.0.1:${h.port}`;
      let items: Array<{ source: string; symbol: string | null; image: { status: string; imageUrl: string | null } | null }> = [];
      for (let i = 0; i < 200; i++) {
        items = ((await (await fetch(`${sbase}/v1/tokens`)).json()) as { items: typeof items }).items;
        if (items.some((t) => t.image?.status === "verified")) break;
        await sleep(25);
      }
      expect(items.map((t) => [t.source, t.symbol ?? null, t.image])).toEqual([
        ["builtin", "NIGHT", null], ["builtin", "DUST", null],
        ["identity", null, { url: "http://img.test/ok.png", status: "verified", imageUrl: png }],
      ]);
      expect(Buffer.from(await (await fetch(sbase + png)).arrayBuffer()).equals(PNG)).toBe(true);
      expect(JSON.parse(logs.find((l) => l.includes('"listening"'))!)).toMatchObject({ scanner: "following", images: "on" });
      expect(logs.some((l) => JSON.parse(l).event === "image")).toBe(true);
      expect(seams.dials.map((x) => x.address)).toEqual([PUBLIC_A]);
    } finally {
      await h.stop();
    }
    // --api-only and --no-image-fetch: no fetcher, nothing fetched.
    await publish(sdb, ds(2), img("http://img.test/ok.jpg"));
    for (const variant of ["api-only", "no-image-fetch"] as const) {
      const quiet = makeDialer(L);
      const qlogs: string[] = [];
      const seamsOnly: ImageFetcherConfig = { dialer: quiet.dialer, resolver: makeResolver().resolver, idleMs: 20 };
      const q = await serve({
        sql: sdb.sql, network: NET, schema: sdb.schema, archiveSchema: archive, port: 0, scanIdleMs: 50, log: (l) => qlogs.push(l),
        ...(variant === "api-only" ? { apiOnly: true, imageFetch: seamsOnly } : { imageFetch: false }),
      });
      try {
        await sleep(300);
        expect(JSON.parse(qlogs.find((l) => l.includes('"listening"'))!).images).toBe("off");
        const t = ((await (await fetch(`http://127.0.0.1:${q.port}/v1/identities/${C}/${ds(2)}/3`)).json()) as { image: unknown });
        expect(t.image).toEqual({ url: "http://img.test/ok.jpg", status: "pending", imageUrl: null });
        expect(quiet.dials).toEqual([]);
      } finally {
        await q.stop();
      }
    }
  }, 180_000);
});
