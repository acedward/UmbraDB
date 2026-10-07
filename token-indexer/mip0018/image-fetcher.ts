/**
 * The background image fetcher of `serve` — the ONLY module of the token indexer that uses the network. It fetches
 * the `image` URL each token identity names, checks it against `image_sha256` and records the result in the image
 * cache (`images.ts`, table `mip0018_images`). The scan never loads this module and the API never fetches: the API
 * serves the cached result (MIP "Consuming": a URI from a value is fetched only with the precautions applied to any
 * remote content; "Security considerations": images are untrusted content).
 *
 * Precautions, on every request (the first and after every redirect):
 *
 * - `http:` and `https:` only; no user name or password in the URL; no cookies, no credentials, no `Referer`.
 * - The host name is resolved once and EVERY resolved address is checked (`addressRefusal`): unspecified, loopback,
 *   private (RFC 1918, RFC 4193), shared/CGNAT, link-local, multicast, documentation, benchmarking, reserved and
 *   cloud-metadata addresses are refused, IPv4 and IPv6 alike; an IPv4 address carried in IPv6 (IPv4-mapped, NAT64,
 *   6to4) is checked as that IPv4 address; outside 2000::/3 nothing is fetched. One refused address refuses the host.
 * - The connection goes to the address that was checked (the dialer gets the address, never the name), so a second
 *   DNS answer cannot change the target; TLS still verifies the certificate against the host name.
 * - At most 3 redirects; a redirect target is checked like the first URL.
 * - Size cap (2 MiB by default; a larger `Content-Length` or body is cut), a connect timeout (resolution, connection
 *   and TLS) and a response timeout (first byte to last byte), a per-host and per-address rate limit (one request per
 *   second by default) and a global concurrency limit (4 by default).
 * - Only a `200` answer is content; `Accept-Encoding: identity` and an encoded answer is refused (no decompression).
 *
 * Results (`images.ts` `classifyContent`): `verified`, `unverified`, `mismatch`, `not-image`; a request that yields
 * no content is `unreachable` with a reason word and is retried with back-off (1 minute doubling up to 24 hours); a
 * `verified` image is final, the other results are checked again after 24 hours. Rows are claimed with a lease, so
 * a restart (or a crash) resumes the pending work.
 *
 * Test seams: the resolver (`Resolver`) and the dialer (`Dialer`); the address policy is never a seam.
 */
import { lookup } from "node:dns/promises";
import { type IncomingMessage, request as httpRequest } from "node:http";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { checkServerIdentity, connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
import { MIP0018_SCHEMA } from "../../src/postgres/migrations/mip0018/index.js";
import type { Queryable } from "./fields.ts";
import {
  type ClaimedImage,
  claimDueImages,
  classifyContent,
  discoverImages,
  type ImageIdentity,
  type ImageSchedule,
  recordImageContent,
  recordImageFailure,
  releaseImage,
} from "./images.ts";

// ── Address policy ───────────────────────────────────────────────────────────────────────────────────────────────

const V4_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** A dotted-quad IPv4 address as a 32-bit number (no leading zeros, no other form), or `undefined`. */
export function parseIpv4(s: string): number | undefined {
  const m = V4_PATTERN.exec(s);
  if (m === null) return undefined;
  return ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0;
}

/** An IPv6 address (RFC 4291 text forms, optional brackets and zone) as a 128-bit number, or `undefined`. */
export function parseIpv6(input: string): bigint | undefined {
  let s = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (!/^[0-9A-Fa-f:.]+$/.test(s)) return undefined;
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const groups = (part: string, v4Allowed: boolean): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    const items = part.split(":");
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (it.includes(".")) {
        const v4 = i === items.length - 1 && v4Allowed ? parseIpv4(it) : undefined;
        if (v4 === undefined) return undefined;
        out.push(v4 >>> 16, v4 & 0xffff);
      } else if (/^[0-9A-Fa-f]{1,4}$/.test(it)) {
        out.push(parseInt(it, 16));
      } else {
        return undefined;
      }
    }
    return out;
  };
  const head = groups(halves[0]!, halves.length === 1);
  const tail = halves.length === 2 ? groups(halves[1]!, true) : [];
  if (head === undefined || tail === undefined) return undefined;
  let all: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return undefined;
    all = [...head, ...new Array<number>(fill).fill(0), ...tail];
  } else {
    if (head.length !== 8) return undefined;
    all = head;
  }
  return all.reduce((n, g) => (n << 16n) | BigInt(g), 0n);
}

const v4Range = (cidr: string, name: string): { base: number; mask: number; name: string } => {
  const [a, bits] = cidr.split("/") as [string, string];
  const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return { base: (parseIpv4(a)! & mask) >>> 0, mask, name };
};
const v6Range = (cidr: string, name: string): { base: bigint; mask: bigint; name: string } => {
  const [a, bits] = cidr.split("/") as [string, string];
  const all = (1n << 128n) - 1n;
  const mask = (all << BigInt(128 - Number(bits))) & all;
  return { base: parseIpv6(a)! & mask, mask, name };
};

/** IPv4 addresses that are never fetched (IANA special-purpose registry; cloud metadata endpoints first). */
const V4_REFUSED = [
  v4Range("169.254.169.254/32", "cloud-metadata"), // AWS, GCP, Azure, OpenStack, …
  v4Range("100.100.100.200/32", "cloud-metadata"), // Alibaba Cloud
  v4Range("192.0.0.192/32", "cloud-metadata"), // Oracle Cloud
  v4Range("168.63.129.16/32", "cloud-metadata"), // Azure host endpoint (a public-range address)
  v4Range("0.0.0.0/8", "unspecified"),
  v4Range("10.0.0.0/8", "private"),
  v4Range("100.64.0.0/10", "shared-cgnat"),
  v4Range("127.0.0.0/8", "loopback"),
  v4Range("169.254.0.0/16", "link-local"),
  v4Range("172.16.0.0/12", "private"),
  v4Range("192.0.0.0/24", "protocol-assignments"),
  v4Range("192.0.2.0/24", "documentation"),
  v4Range("192.88.99.0/24", "relay-anycast"),
  v4Range("192.168.0.0/16", "private"),
  v4Range("198.18.0.0/15", "benchmarking"),
  v4Range("198.51.100.0/24", "documentation"),
  v4Range("203.0.113.0/24", "documentation"),
  v4Range("224.0.0.0/4", "multicast"),
  v4Range("240.0.0.0/4", "reserved"), // includes 255.255.255.255
];

/** IPv6 addresses carrying an IPv4 address that decides: IPv4-mapped, NAT64 (well-known prefix), 6to4. */
const V6_MAPPED = v6Range("::ffff:0:0/96", "ipv4-mapped");
const V6_NAT64 = v6Range("64:ff9b::/96", "nat64");
const V6_6TO4 = v6Range("2002::/16", "6to4");
/** IPv6 addresses that are never fetched, inside and outside global unicast (2000::/3). */
const V6_REFUSED = [
  v6Range("fd00:ec2::254/128", "cloud-metadata"), // AWS
  v6Range("::/128", "unspecified"),
  v6Range("::1/128", "loopback"),
  v6Range("::/96", "ipv4-compatible"),
  v6Range("64:ff9b:1::/48", "nat64-local"),
  v6Range("100::/64", "discard"),
  v6Range("2001::/23", "protocol-assignments"), // includes Teredo 2001::/32
  v6Range("2001:db8::/32", "documentation"),
  v6Range("3fff::/20", "documentation"),
  v6Range("fc00::/7", "unique-local"),
  v6Range("fe80::/10", "link-local"),
  v6Range("fec0::/10", "site-local"),
  v6Range("ff00::/8", "multicast"),
];
const V6_GLOBAL_UNICAST = v6Range("2000::/3", "global-unicast");

function refusal4(n: number): string | undefined {
  return V4_REFUSED.find((r) => ((n & r.mask) >>> 0) === r.base)?.name;
}

function refusal6(n: bigint): string | undefined {
  const inRange = (r: { base: bigint; mask: bigint }): boolean => (n & r.mask) === r.base;
  if (inRange(V6_MAPPED) || inRange(V6_NAT64)) return refusal4(Number(n & 0xffffffffn));
  if (inRange(V6_6TO4)) return refusal4(Number((n >> 80n) & 0xffffffffn));
  const refused = V6_REFUSED.find(inRange);
  if (refused !== undefined) return refused.name;
  return inRange(V6_GLOBAL_UNICAST) ? undefined : "reserved";
}

/**
 * Why an address is never fetched (`private`, `loopback`, `link-local`, `cloud-metadata`, …), or `undefined` when it
 * may be: a public unicast address. Text that is not an IPv4 or IPv6 address is refused (`unparseable`).
 */
export function addressRefusal(address: string): string | undefined {
  const v4 = parseIpv4(address);
  if (v4 !== undefined) return refusal4(v4);
  const v6 = address.includes(":") ? parseIpv6(address) : undefined;
  if (v6 !== undefined) return refusal6(v6);
  return "unparseable";
}

// ── Seams: name resolution and connections ───────────────────────────────────────────────────────────────────────

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a host name to every address it has (the fetcher checks all of them). */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** The system resolver (`getaddrinfo`, as Node's own HTTP client would use), every address in its order. */
export const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, order: "verbatim" })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

/** Where a request connects: the checked address and port; `hostname` for TLS (SNI, certificate) and nothing else. */
export interface DialTarget {
  address: string;
  family: 4 | 6;
  port: number;
  hostname: string;
  tls: boolean;
}

/** Opens a connection to exactly `target.address` (never resolving a name); resolves once it is connected. */
export type Dialer = (target: DialTarget, signal: AbortSignal) => Promise<Duplex>;

/** TCP, or TLS with the certificate checked against the URL's host name, to the checked address. */
export const systemDialer: Dialer = (t, signal) =>
  new Promise<Duplex>((resolve, reject) => {
    const socket: Socket = t.tls
      ? tlsConnect({
          host: t.address, port: t.port, ALPNProtocols: ["http/1.1"],
          ...(isIP(t.hostname) === 0 ? { servername: t.hostname } : {}),
          checkServerIdentity: (_host, cert) => checkServerIdentity(t.hostname, cert),
        })
      : netConnect({ host: t.address, port: t.port, family: t.family });
    const fail = (e: unknown): void => {
      cleanup();
      socket.destroy();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const ok = (): void => {
      cleanup();
      resolve(socket);
    };
    const abort = (): void => fail(new Error("aborted"));
    function cleanup(): void {
      socket.off("error", fail);
      socket.off(t.tls ? "secureConnect" : "connect", ok);
      signal.removeEventListener("abort", abort);
    }
    socket.once("error", fail);
    socket.once(t.tls ? "secureConnect" : "connect", ok);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });

// ── Rate limit ───────────────────────────────────────────────────────────────────────────────────────────────────

/** At most one request start per `intervalMs` for each key (a host name, an address). */
export class RateLimiter {
  private readonly next = new Map<string, number>();

  constructor(private readonly intervalMs: number, private readonly now: () => number = () => Date.now()) {}

  /** How long until every key is free (0 = now). */
  readyIn(keys: readonly string[]): number {
    const t = this.now();
    return Math.max(0, ...keys.map((k) => (this.next.get(k) ?? 0) - t));
  }

  /**
   * Reserves the next start free for every key and returns the wait until it (0 = now), or `undefined` — nothing
   * reserved — when that wait is longer than `maxWaitMs`.
   */
  reserve(keys: readonly string[], maxWaitMs: number): number | undefined {
    const wait = this.readyIn(keys);
    if (wait > maxWaitMs) return undefined;
    const start = this.now() + wait;
    for (const k of keys) this.next.set(k, start + this.intervalMs);
    if (this.next.size > 10_000) for (const [k, v] of this.next) if (v <= start) this.next.delete(k);
    return wait;
  }
}

// ── One fetch ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The fetcher was stopped during a fetch: the row is given back unchecked. */
export class FetchStopped extends Error {
  override name = "FetchStopped";
}

export interface FetchLimits {
  /** Largest body kept (bytes). */
  maxBytes: number;
  /** Name resolution plus connection (and TLS) of one request. */
  connectTimeoutMs: number;
  /** From the request to the last byte of its answer. */
  responseTimeoutMs: number;
  maxRedirects: number;
  /** Per host name and per address: at most one request start in this interval. */
  perHostIntervalMs: number;
}

export interface FetchDeps extends FetchLimits {
  resolver: Resolver;
  dialer: Dialer;
  limiter: RateLimiter;
}

export type FetchOutcome = { ok: true; bytes: Buffer } | { ok: false; reason: string };

const USER_AGENT = "UmbraDB-token-indexer (MIP-0018 image check)";
const fail = (reason: string): FetchOutcome => ({ ok: false, reason });

/** Waits `ms` unless `signal` aborts first (then throws `FetchStopped`). */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new FetchStopped("stopped"));
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", stop, { once: true });
    function done(): void {
      signal.removeEventListener("abort", stop);
      resolve();
    }
    function stop(): void {
      clearTimeout(t);
      reject(new FetchStopped("stopped"));
    }
  });
}

/** Runs `work` with a deadline; `"timeout"` when it passes, `FetchStopped` when `stop` aborts. */
async function withDeadline<T>(ms: number, stop: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T | "timeout"> {
  const deadline = AbortSignal.timeout(ms);
  const signal = AbortSignal.any([stop, deadline]);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<"timeout">((resolve, reject) => {
    onAbort = () => (stop.aborted ? reject(new FetchStopped("stopped")) : resolve("timeout"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  const running = work(signal);
  try {
    return await Promise.race([running, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    running.then((v) => {
      if (signal.aborted && typeof (v as { destroy?: unknown })?.destroy === "function") (v as unknown as Duplex).destroy();
    }, () => {});
  }
}

type Hop = { kind: "body"; bytes: Buffer } | { kind: "redirect"; location: string } | { kind: "fail"; reason: string };
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** One GET over a connected socket; the socket is destroyed when it returns. */
function getOnce(url: URL, socket: Duplex, maxBytes: number, signal: AbortSignal): Promise<Hop> {
  return new Promise<Hop>((resolve) => {
    let settled = false;
    const done = (h: Hop): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      req.destroy();
      socket.destroy();
      resolve(h);
    };
    const onAbort = (): void => done({ kind: "fail", reason: "timeout" });
    const req = httpRequest({
      method: "GET",
      path: `${url.pathname}${url.search}`,
      setHost: false,
      headers: {
        host: url.host,
        accept: "image/png, image/jpeg, image/gif, image/webp",
        "accept-encoding": "identity",
        "user-agent": USER_AGENT,
        connection: "close",
      },
      createConnection: () => socket as Socket,
      maxHeaderSize: 16_384,
      insecureHTTPParser: false,
    });
    req.on("error", () => done({ kind: "fail", reason: "protocol" }));
    req.on("response", (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (REDIRECTS.has(status)) {
        const location = res.headers.location;
        return done(location === undefined || location === "" ? { kind: "fail", reason: "redirect-location" } : { kind: "redirect", location });
      }
      if (status !== 200) return done({ kind: "fail", reason: `http-${status}` });
      const encoding = res.headers["content-encoding"];
      if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") return done({ kind: "fail", reason: "content-encoding" });
      const length = res.headers["content-length"];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return done({ kind: "fail", reason: "too-large" });
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) return done({ kind: "fail", reason: "too-large" });
        chunks.push(c);
      });
      res.on("end", () => done(res.complete ? { kind: "body", bytes: Buffer.concat(chunks) } : { kind: "fail", reason: "incomplete" }));
      res.on("error", () => done({ kind: "fail", reason: "incomplete" }));
      res.on("close", () => done({ kind: "fail", reason: "incomplete" }));
    });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    req.end();
  });
}

/** Whether a URL may be requested at all: `http:`/`https:`, no user name or password. */
function urlRefusal(url: URL): string | undefined {
  if (url.protocol !== "http:" && url.protocol !== "https:") return "scheme";
  if (url.username !== "" || url.password !== "") return "credentials";
  if (url.hostname === "") return "bad-url";
  return undefined;
}

/**
 * Fetches `rawUrl` under every precaution of this module; follows at most `maxRedirects` redirects, each checked like
 * the first URL. Throws `FetchStopped` when `stop` aborts; every other failure is an outcome with a reason word.
 */
export async function fetchImage(rawUrl: string, d: FetchDeps, stop: AbortSignal): Promise<FetchOutcome> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail("bad-url");
  }
  for (let hop = 0; ; hop++) {
    const refused = urlRefusal(url);
    if (refused !== undefined) return fail(refused);
    const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    const tls = url.protocol === "https:";
    const port = url.port === "" ? (tls ? 443 : 80) : Number(url.port);

    // Resolve once; every address must be allowed; connect to the first one.
    let addresses: ResolvedAddress[];
    const literal = isIP(host);
    if (literal !== 0) {
      addresses = [{ address: host, family: literal === 6 ? 6 : 4 }];
    } else {
      let resolved: ResolvedAddress[] | "timeout";
      try {
        resolved = await withDeadline(d.connectTimeoutMs, stop, () => d.resolver(host));
      } catch (e) {
        if (e instanceof FetchStopped) throw e;
        return fail("dns");
      }
      if (resolved === "timeout") return fail("timeout");
      addresses = resolved;
    }
    if (addresses.length === 0) return fail("dns");
    if (addresses.some((a) => addressRefusal(a.address) !== undefined)) return fail("address-refused");
    const target = addresses[0]!;

    const wait = d.limiter.reserve([`host:${host.toLowerCase()}`, `address:${target.address.toLowerCase()}`], 2 * d.perHostIntervalMs);
    if (wait === undefined) return fail("rate-limited");
    if (wait > 0) await pause(wait, stop);

    let socket: Duplex | "timeout";
    try {
      socket = await withDeadline(d.connectTimeoutMs, stop, (signal) =>
        d.dialer({ address: target.address, family: target.family, port, hostname: host, tls }, signal));
    } catch (e) {
      if (e instanceof FetchStopped) throw e;
      return fail("connect");
    }
    if (socket === "timeout") return fail("timeout");

    const signal = AbortSignal.any([stop, AbortSignal.timeout(d.responseTimeoutMs)]);
    const result = await getOnce(url, socket, d.maxBytes, signal);
    if (stop.aborted) throw new FetchStopped("stopped");
    if (result.kind === "body") return { ok: true, bytes: result.bytes };
    if (result.kind === "fail") return fail(result.reason);
    if (hop >= d.maxRedirects) return fail("too-many-redirects");
    try {
      url = new URL(result.location, url);
    } catch {
      return fail("redirect-location");
    }
  }
}

// ── The background worker ────────────────────────────────────────────────────────────────────────────────────────

export const IMAGE_FETCH_DEFAULTS = {
  maxBytes: 2 * 1024 * 1024,
  connectTimeoutMs: 5_000,
  responseTimeoutMs: 15_000,
  maxRedirects: 3,
  perHostIntervalMs: 1_000,
  maxConcurrent: 4,
  recheckMs: 24 * 3_600_000,
  retryBaseMs: 60_000,
  retryMaxMs: 24 * 3_600_000,
  idleMs: 2_000,
  discoverBatch: 200,
} as const;

/** Largest `maxBytes` (the cache table holds at most 16 MiB per image). */
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/** Limits, schedule and seams of the fetcher; every field has a default (`IMAGE_FETCH_DEFAULTS`, the system seams). */
export interface ImageFetcherConfig extends Partial<FetchLimits>, Partial<ImageSchedule> {
  maxConcurrent?: number;
  /** Wait between rounds when nothing is due (a finished fetch starts the next round at once). */
  idleMs?: number;
  /** Identities read per discovery page. */
  discoverBatch?: number;
  /** How long a claimed row stays claimed (default: long enough for every hop of one fetch). */
  leaseMs?: number;
  resolver?: Resolver;
  dialer?: Dialer;
  log?: (line: string) => void;
}

export interface ImageFetcherOptions extends ImageFetcherConfig {
  sql: Queryable;
  network: string;
  schema?: string;
}

const positiveInt = (v: number, what: string, max = Number.MAX_SAFE_INTEGER, min = 1): number => {
  if (!Number.isSafeInteger(v) || v < min || v > max) throw new RangeError(`${what} must be an integer from ${min} to ${max}, got ${v}`);
  return v;
};

/**
 * The worker: each round reads one page of identities with an `image` (a rolling cursor, so every identity is seen
 * again), adds a `pending` row for each image not yet cached, claims due rows up to the free concurrency and fetches
 * them. `start` runs rounds until `stop`; `runOnce` runs one round and waits for its fetches (tests).
 */
export class ImageFetcher {
  private readonly sql: Queryable;
  private readonly network: string;
  private readonly schema: string;
  private readonly deps: FetchDeps;
  private readonly schedule: ImageSchedule;
  private readonly maxConcurrent: number;
  private readonly idleMs: number;
  private readonly discoverBatch: number;
  private readonly leaseMs: number;
  private readonly log: (line: string) => void;
  private readonly stopper = new AbortController();
  private readonly inFlight = new Set<Promise<void>>();
  private cursor: ImageIdentity | undefined;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  /** A fetch finished (a slot is free) since the last idle wait began: the next wait ends at once. */
  private woken = false;

  constructor(o: ImageFetcherOptions) {
    const d = IMAGE_FETCH_DEFAULTS;
    this.sql = o.sql;
    this.network = o.network;
    this.schema = o.schema ?? MIP0018_SCHEMA;
    this.deps = {
      maxBytes: positiveInt(o.maxBytes ?? d.maxBytes, "maxBytes", MAX_IMAGE_BYTES),
      connectTimeoutMs: positiveInt(o.connectTimeoutMs ?? d.connectTimeoutMs, "connectTimeoutMs"),
      responseTimeoutMs: positiveInt(o.responseTimeoutMs ?? d.responseTimeoutMs, "responseTimeoutMs"),
      maxRedirects: positiveInt(o.maxRedirects ?? d.maxRedirects, "maxRedirects", 10, 0),
      perHostIntervalMs: positiveInt(o.perHostIntervalMs ?? d.perHostIntervalMs, "perHostIntervalMs", 3_600_000, 0),
      resolver: o.resolver ?? systemResolver,
      dialer: o.dialer ?? systemDialer,
      limiter: new RateLimiter(o.perHostIntervalMs ?? d.perHostIntervalMs),
    };
    this.schedule = {
      recheckMs: positiveInt(o.recheckMs ?? d.recheckMs, "recheckMs"),
      retryBaseMs: positiveInt(o.retryBaseMs ?? d.retryBaseMs, "retryBaseMs"),
      retryMaxMs: positiveInt(o.retryMaxMs ?? d.retryMaxMs, "retryMaxMs"),
    };
    this.maxConcurrent = positiveInt(o.maxConcurrent ?? d.maxConcurrent, "maxConcurrent", 64);
    this.idleMs = positiveInt(o.idleMs ?? d.idleMs, "idleMs");
    this.discoverBatch = positiveInt(o.discoverBatch ?? d.discoverBatch, "discoverBatch", 10_000);
    const hop = this.deps.connectTimeoutMs * 2 + this.deps.responseTimeoutMs + 2 * this.deps.perHostIntervalMs;
    this.leaseMs = positiveInt(o.leaseMs ?? hop * (this.deps.maxRedirects + 1) + hop, "leaseMs");
    this.log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  }

  /** Starts the rounds in the background (once). */
  start(): void {
    if (this.loop !== undefined) return;
    this.loop = (async () => {
      let failures = 0;
      while (!this.stopper.signal.aborted) {
        try {
          await this.round();
          failures = 0;
          await this.idle(this.idleMs);
        } catch (e) {
          failures++;
          this.log(JSON.stringify({ event: "image-fetch-error", error: e instanceof Error ? e.message : String(e), failures }));
          await this.idle(Math.min(60_000, this.idleMs * 5 ** Math.min(failures - 1, 4)));
        }
      }
    })();
  }

  /** Stops the rounds; fetches in progress are abandoned and their rows are due again at once. */
  async stop(): Promise<void> {
    this.stopper.abort();
    this.notify();
    await this.loop;
    await Promise.allSettled([...this.inFlight]);
  }

  /** One round, then waits until the fetches it started are recorded. */
  async runOnce(): Promise<void> {
    await this.round();
    await Promise.allSettled([...this.inFlight]);
  }

  private notify(): void {
    this.woken = true;
    this.wake?.();
  }

  private idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopper.signal.aborted || this.woken) {
        this.woken = false;
        return resolve();
      }
      const t = setTimeout(done, ms);
      const self = this;
      this.wake = done;
      function done(): void {
        clearTimeout(t);
        self.wake = undefined;
        self.woken = false;
        resolve();
      }
    });
  }

  private async round(): Promise<void> {
    const found = await discoverImages(this.sql, this.network, this.schema, { ...(this.cursor === undefined ? {} : { after: this.cursor }), limit: this.discoverBatch });
    this.cursor = found.last;
    if (this.stopper.signal.aborted) return;
    const claimed = await claimDueImages(this.sql, this.schema, { limit: this.maxConcurrent - this.inFlight.size, leaseMs: this.leaseMs });
    for (const item of claimed) {
      const p: Promise<void> = this.check(item)
        .catch((e: unknown) => this.log(JSON.stringify({ event: "image-fetch-error", error: e instanceof Error ? e.message : String(e) })))
        .finally(() => {
          this.inFlight.delete(p);
          this.notify();
        });
      this.inFlight.add(p);
    }
  }

  private async check(item: ClaimedImage): Promise<void> {
    const url = item.url.toString("latin1");
    const host = hostKey(url);
    if (host !== undefined) {
      const wait = this.deps.limiter.readyIn([host]);
      if (wait > 2 * this.deps.perHostIntervalMs) return releaseImage(this.sql, this.schema, item, wait);
    }
    let out: FetchOutcome;
    try {
      out = await fetchImage(url, this.deps, this.stopper.signal);
    } catch (e) {
      if (e instanceof FetchStopped) return releaseImage(this.sql, this.schema, item, 0);
      throw e;
    }
    if (out.ok) {
      const r = classifyContent(out.bytes, item.imageSha256.length === 32 ? item.imageSha256 : null);
      await recordImageContent(this.sql, this.schema, item, r, this.schedule);
      this.log(JSON.stringify({ event: "image", status: r.status, size: r.size }));
    } else {
      await recordImageFailure(this.sql, this.schema, item, out.reason, this.schedule);
      this.log(JSON.stringify({ event: "image", status: "unreachable", reason: out.reason }));
    }
  }
}

/** The rate-limit key of a URL's host, or `undefined` when it is not an http(s) URL. */
function hostKey(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return `host:${(u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname).toLowerCase()}`;
  } catch {
    return undefined;
  }
}
