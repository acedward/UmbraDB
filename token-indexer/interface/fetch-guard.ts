import { promises as dns, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { BodyTooLargeError, TransportError, type BundleTransport } from "./level1.js";

/**
 * Project 00024-02 task C4 — the FETCH GUARD: how the indexer obtains a bundle it did not choose.
 *
 * Anyone able to call a contract's `publishBundle` chooses the URL, so an unattended verifier
 * fetches attacker-chosen hosts. [B] says so and leaves the defence to the verifier: "Such a
 * service should also refuse private and loopback destinations", "a slow host can stall a fetch
 * indefinitely (this tool sets no timeout…)" (`src/fetch.mjs` SIZING_GUIDANCE); the reference
 * implements neither (`fetch.mjs:119` follows any redirect to any host). Spec FR-011: "with a
 * deadline, size and count caps, only http(s), no private/loopback/link-local hosts (after DNS),
 * limited redirects; a limit → `unchecked`".
 *
 *  - **http(s) only**, for the event URL and for every redirect target. Anything else (`ipfs:`,
 *    `file:`, `data:` …) is `unfetchable` (spec US1 scenario 5; `ipfs://` is out of scope, §8).
 *  - **Destinations after DNS**: every address a host name resolves to is classified
 *    ({@link classifyAddress}); if ANY is loopback, private, link-local, unspecified, multicast,
 *    documentation, benchmarking or otherwise reserved — IPv4, IPv6, and IPv4 embedded in IPv6
 *    (mapped, NAT64, 6to4) — the request is refused before a connection is made: `unfetchable`.
 *    The check runs INSIDE the connection's own `lookup`, so the addresses checked are the addresses
 *    connected to — a name cannot resolve to a public address for the check and a private one for
 *    the connection (DNS rebinding). An IP-literal host (which skips `lookup`) is classified first.
 *    A test-only flag (`allowPrivateHosts`) lets the local stack's static server be used (spec §6.1);
 *    the refusal itself is tested with the flag OFF (audit F4).
 *  - **At most 3 redirects** (301/302/303/307/308), each hop re-checked (scheme and destination);
 *    more is `unreachable` (the host did not deliver).
 *  - **One deadline per verification**: every request of one bundle shares it; reaching it is
 *    `unchecked` — a local limit, never a verdict.
 *  - **Size caps** are enforced while reading (and from an announced `Content-Length`): the caller
 *    passes the cap (`level1.ts`), and exceeding it is {@link BodyTooLargeError}.
 *  - **Bytes as served**: `Accept-Encoding: identity`; a response with any other `Content-Encoding`
 *    is not the committed bytes (a transparently decompressed body would not be) — `unreachable`.
 *  - Any other transport problem (a host that does not resolve, refuses, resets or cuts the
 *    connection, fails TLS, answers a non-2xx status or a redirect without a usable `Location`) is
 *    `unreachable`: the host did not deliver — unavailable, not invalid, and not a policy refusal
 *    (owner decision Q25, UC-13: handled before the [B] levels, retried with exponential backoff).
 *
 * So `unfetchable` is only ever a POLICY refusal (scheme, destination), `unchecked` only a local
 * LIMIT (deadline; the size caps are raised as {@link BodyTooLargeError} and judged by Level 1), and
 * everything else the transport meets is `unreachable`.
 */

export interface FetchPolicy {
  /** TEST-ONLY: allow private/loopback/link-local destinations (the local stack's bundle server). */
  allowPrivateHosts: boolean;
  /** Redirects followed per request. */
  maxRedirects: number;
  /** One deadline for every request of one verification (ms). */
  deadlineMs: number;
  /** Test seam: the resolver. Default: every address `dns.lookup` returns. */
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
  /** Test seam: the destination classifier. Default {@link classifyAddress}. */
  classify?: (address: string) => string | null;
}

export const DEFAULT_FETCH_POLICY: FetchPolicy = Object.freeze({
  allowPrivateHosts: false,
  maxRedirects: 3,
  deadlineMs: 120_000,
});

const USER_AGENT = "umbradb-token-indexer (public-interface verifier; https://github.com/acedward/UmbraDB)";

// ── destinations ────────────────────────────────────────────────────────────────────────────

/** The 4 or 16 bytes of an IP address, or null when it is not one. */
export function ipBytes(address: string): Uint8Array | null {
  const family = isIP(address);
  if (family === 4) return Uint8Array.from(address.split(".").map(Number));
  if (family !== 6) return null;
  // `isIP` has validated the syntax. A trailing dotted quad (`::ffff:1.2.3.4`) becomes two groups.
  let text = address.split("%")[0]!.toLowerCase();
  const quad = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (quad !== null) {
    const [a, b, c, d] = quad.slice(2).map(Number) as [number, number, number, number];
    text = `${quad[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  const parse = (s: string): number[] => (s === "" ? [] : s.split(":").map((h) => parseInt(h, 16)));
  const left = parse(halves[0]!);
  const right = halves.length === 2 ? parse(halves[1]!) : [];
  const groups = halves.length === 2 ? [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right] : left;
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => { out[2 * i] = g >> 8; out[2 * i + 1] = g & 0xff; });
  return out;
}

const V4_RANGES: [number[], number, string][] = [
  [[0, 0, 0, 0], 8, "unspecified ('this network')"],
  [[10, 0, 0, 0], 8, "private"],
  [[100, 64, 0, 0], 10, "shared (carrier-grade NAT)"],
  [[127, 0, 0, 0], 8, "loopback"],
  [[169, 254, 0, 0], 16, "link-local"],
  [[172, 16, 0, 0], 12, "private"],
  [[192, 0, 0, 0], 24, "reserved (IETF protocol assignments)"],
  [[192, 0, 2, 0], 24, "documentation"],
  [[192, 88, 99, 0], 24, "reserved (6to4 relay anycast)"],
  [[192, 168, 0, 0], 16, "private"],
  [[198, 18, 0, 0], 15, "benchmarking"],
  [[198, 51, 100, 0], 24, "documentation"],
  [[203, 0, 113, 0], 24, "documentation"],
  [[224, 0, 0, 0], 4, "multicast"],
  [[240, 0, 0, 0], 4, "reserved"],
];

const V6_RANGES: [number[], number, string][] = [
  [[0, 0], 128, "unspecified"],
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128, "loopback"],
  [[0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48, "NAT64 local-use"],
  [[0x01, 0x00, 0, 0, 0, 0, 0, 0], 64, "discard-only"],
  [[0x20, 0x01, 0x0d, 0xb8], 32, "documentation"],
  [[0xfc], 7, "unique-local (private)"],
  [[0xfe, 0x80], 10, "link-local"],
  [[0xfe, 0xc0], 10, "site-local"],
  [[0xff], 8, "multicast"],
];

function inPrefix(bytes: Uint8Array, prefix: readonly number[], bits: number): boolean {
  for (let i = 0; i < bits; i++) {
    const byte = prefix[i >> 3] ?? 0;
    const bit = 7 - (i & 7);
    if (((bytes[i >> 3]! >> bit) & 1) !== ((byte >> bit) & 1)) return false;
  }
  return true;
}

/**
 * Why a verifier must not connect to `address` (e.g. "loopback", "private"), or null when it is a
 * public unicast address. IPv4 embedded in IPv6 (mapped `::ffff:0:0/96`, the NAT64 well-known
 * prefix `64:ff9b::/96`, 6to4 `2002::/16`, the deprecated IPv4-compatible `::/96`) is classified as
 * the IPv4 address it carries. A string that is not an IP address is refused too.
 */
export function classifyAddress(address: string): string | null {
  const bytes = ipBytes(address);
  if (bytes === null) return "not an IP address";
  if (bytes.length === 4) {
    for (const [prefix, bits, label] of V4_RANGES) if (inPrefix(bytes, prefix, bits)) return label;
    return null;
  }
  for (const [prefix, bits, label] of V6_RANGES) if (inPrefix(bytes, prefix, bits)) return label;
  const embedded = (from: number): string | null => classifyAddress(Array.from(bytes.subarray(from, from + 4)).join("."));
  if (inPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96)) return embedded(12);
  if (inPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) return embedded(12);
  if (inPrefix(bytes, [0x20, 0x02], 16)) return embedded(2);
  if (inPrefix(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 96)) return "reserved (IPv4-compatible)";
  return null;
}

/** The URL of a request, or an `unfetchable` {@link TransportError}: http(s) only. */
export function checkUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new TransportError("unfetchable", `${JSON.stringify(url.slice(0, 200))} is not a URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new TransportError("unfetchable", `${u.protocol} URLs are not fetched (only http and https)`);
  }
  return u;
}

/** A refused destination, raised inside the connection's `lookup`. */
class DestinationRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DestinationRefused";
  }
}

// ── the transport ───────────────────────────────────────────────────────────────────────────

/**
 * The guarded HTTP transport for ONE verification: its deadline starts when it is created and
 * covers every request made through it. Implements {@link BundleTransport}.
 */
export class GuardedHttpTransport implements BundleTransport {
  private readonly policy: FetchPolicy;
  private readonly signal: AbortSignal;
  private readonly startedAt = Date.now();
  /** Requests actually sent (redirect hops included), and redirects followed — for the report. */
  requests = 0;
  redirects = 0;

  constructor(policy: Partial<FetchPolicy> = {}, signal?: AbortSignal) {
    this.policy = { ...DEFAULT_FETCH_POLICY, ...policy };
    const deadline = AbortSignal.timeout(this.policy.deadlineMs);
    this.signal = signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
  }

  private deadlineError(): TransportError {
    return new TransportError("unchecked",
      `the ${this.policy.deadlineMs} ms deadline was reached after ${Date.now() - this.startedAt} ms; the bundle was not checked`);
  }

  async get(url: string, cap: number): Promise<Buffer> {
    let current = checkUrl(url);
    for (let hop = 0; ; hop++) {
      if (this.signal.aborted) throw this.deadlineError();
      const answer = await this.once(current, cap);
      if (answer.location === undefined) return answer.body!;
      if (hop >= this.policy.maxRedirects) {
        throw new TransportError("unreachable", `${url}: more than ${this.policy.maxRedirects} redirects`);
      }
      let next: URL;
      try {
        next = new URL(answer.location, current);
      } catch {
        throw new TransportError("unreachable", `${current.href} redirects to ${JSON.stringify(answer.location.slice(0, 200))}, which is not a URL`);
      }
      current = checkUrl(next.href);
      this.redirects++;
    }
  }

  private refuseReason(address: string): string | null {
    if (this.policy.allowPrivateHosts) return null;
    return (this.policy.classify ?? classifyAddress)(address);
  }

  private once(u: URL, cap: number): Promise<{ body?: Buffer; location?: string }> {
    const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
    if (isIP(host) !== 0) {
      const why = this.refuseReason(host);
      if (why !== null) {
        return Promise.reject(new TransportError("unfetchable", `${u.host} is a ${why} address; a verifier does not connect to it`));
      }
    }
    const resolve = this.policy.resolve ?? ((name: string) => dns.lookup(name, { all: true, verbatim: true }));
    const lookup = (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void): void => {
      resolve(hostname).then((addresses) => {
        if (addresses.length === 0) { callback(Object.assign(new Error(`${hostname} did not resolve`), { code: "ENOTFOUND" })); return; }
        for (const a of addresses) {
          const why = this.refuseReason(a.address);
          if (why !== null) {
            callback(new DestinationRefused(`${hostname} resolves to ${a.address}, a ${why} address; a verifier does not connect to it`));
            return;
          }
        }
        if (options.all === true) callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      }, (error: unknown) => callback(error));
    };

    return new Promise((resolvePromise, reject) => {
      const lib = u.protocol === "https:" ? https : http;
      let settled = false;
      const finish = (fn: () => void): void => { if (!settled) { settled = true; fn(); } };
      this.requests++;
      const req = lib.request({
        protocol: u.protocol, hostname: host, port: u.port === "" ? undefined : Number(u.port),
        path: `${u.pathname}${u.search}`, method: "GET", agent: false, signal: this.signal,
        headers: { "accept-encoding": "identity", accept: "*/*", "user-agent": USER_AGENT },
        lookup: lookup as never,
      }, (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          const location = res.headers.location;
          finish(() => (location === undefined || location === ""
            ? reject(new TransportError("unreachable", `${u.href} returned HTTP ${status} without a Location`))
            : resolvePromise({ location })));
          req.destroy();
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          finish(() => reject(new TransportError("unreachable", `${u.href} returned HTTP ${status}`)));
          req.destroy();
          return;
        }
        const encoding = res.headers["content-encoding"];
        if (encoding !== undefined && encoding.toLowerCase() !== "identity") {
          finish(() => reject(new TransportError("unreachable", `${u.href} sent Content-Encoding ${JSON.stringify(encoding)}; only the identity bytes can be checked`)));
          req.destroy();
          return;
        }
        const announced = Number(res.headers["content-length"]);
        if (res.headers["content-length"] !== undefined && Number.isFinite(announced) && announced > cap) {
          finish(() => reject(new BodyTooLargeError(cap, `the server announces ${announced} bytes, over the cap of ${cap}; not downloaded`)));
          req.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let n = 0;
        res.on("data", (chunk: Buffer) => {
          n += chunk.length;
          if (n > cap) {
            finish(() => reject(new BodyTooLargeError(cap, `more than ${cap} bytes; download aborted`)));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => finish(() => resolvePromise({ body: Buffer.concat(chunks) })));
        res.on("error", (error) => finish(() => reject(this.transportError(u, error))));
        res.on("aborted", () => finish(() => reject(this.transportError(u, new Error("the response was cut off")))));
      });
      req.on("error", (error) => finish(() => reject(this.transportError(u, error))));
      req.end();
    });
  }

  /** A failed request: the deadline (`unchecked`), a refused destination (`unfetchable`), or —
   *  anything else: DNS, refused/reset connection, TLS, a cut-off body — `unreachable` (owner Q25). */
  private transportError(u: URL, error: unknown): TransportError {
    if (this.signal.aborted) return this.deadlineError();
    if (error instanceof DestinationRefused) return new TransportError("unfetchable", error.message);
    const e = error as { code?: string; message?: string };
    return new TransportError("unreachable", `could not fetch ${u.href}: ${e.code ?? e.message ?? String(error)}`);
  }
}
