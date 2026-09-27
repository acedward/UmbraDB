import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GuardedHttpTransport, checkUrl, classifyAddress, ipBytes, type FetchPolicy } from "../interface/fetch-guard.js";
import { BodyTooLargeError, TransportError, levelOne } from "../interface/level1.js";
import { startBundleHost, type BundleHost } from "./helpers/bundle-host.js";
import { commitmentOf, loadFixtureBundle } from "./helpers/pi-fixture.js";

/**
 * Project 00024-02 task C4 — the fetch guard (spec US1 scenarios 5–6, FR-011; audit F4: the
 * private-host refusal is tested with the bypass OFF, here, not in the integration run).
 * Everything goes over real TCP to a local host (`helpers/bundle-host.ts`).
 * Task C9 (owner Q25): every "the host did not deliver" case is `unreachable`; `unfetchable` is only
 * a policy refusal (scheme, private destination) and `unchecked` only the deadline.
 */

async function refusal(fn: () => Promise<unknown>): Promise<TransportError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof TransportError) return error;
    throw error;
  }
  throw new Error("the request was not refused");
}

describe("the fetch guard (C4)", () => {
  let host: BundleHost;
  const bundle = loadFixtureBundle();

  beforeAll(async () => {
    host = await startBundleHost();
    host.mount("/pi/", bundle);
  });
  afterAll(async () => { await host?.close(); });
  afterEach(() => {
    host.requests.length = 0;
    host.routes.clear();
  });

  const open = (policy: Partial<FetchPolicy> = {}): GuardedHttpTransport =>
    new GuardedHttpTransport({ allowPrivateHosts: true, ...policy });

  it("[[interface-fetch-guard]] http(s) only; private, loopback and link-local destinations refused after DNS (bypass OFF); ≤ 3 redirects, each re-checked; one deadline; size caps; identity bytes only; a host that does not deliver is unreachable", async () => {
    // --- destinations: the classifier -----------------------------------------------------------
    for (const [address, label] of [
      ["127.0.0.1", "loopback"], ["127.255.255.254", "loopback"], ["10.1.2.3", "private"], ["172.16.0.1", "private"],
      ["172.31.255.255", "private"], ["192.168.1.1", "private"], ["169.254.169.254", "link-local"], ["0.0.0.0", "unspecified"],
      ["100.64.0.1", "carrier-grade"], ["198.18.0.1", "benchmarking"], ["192.0.2.1", "documentation"], ["224.0.0.1", "multicast"],
      ["255.255.255.255", "reserved"], ["::1", "loopback"], ["::", "unspecified"], ["fe80::1", "link-local"],
      ["fd00::1", "unique-local"], ["fc12::1", "unique-local"], ["ff02::1", "multicast"], ["2001:db8::1", "documentation"],
      ["fec0::1", "site-local"], ["::ffff:127.0.0.1", "loopback"], ["::ffff:7f00:1", "loopback"], ["::ffff:10.0.0.1", "private"],
      ["64:ff9b::a9fe:a9fe", "link-local"], ["2002:c0a8:0101::1", "private"], ["::127.0.0.1", "IPv4-compatible"],
      ["fe80::1%eth0", "link-local"], ["localhost", "not an IP address"],
    ] as const) {
      expect(classifyAddress(address), address).toMatch(new RegExp(label));
    }
    for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"]) {
      expect(classifyAddress(address), address).toBeNull();
    }
    expect(Buffer.from(ipBytes("::ffff:1.2.3.4")!).toString("hex")).toBe("00000000000000000000ffff01020304");
    expect(ipBytes("not-an-ip")).toBeNull();

    // --- http(s) only ----------------------------------------------------------------------------
    for (const url of ["ftp://b.example/index.json", "file:///etc/passwd", "ipfs://bafy/index.json", "data:,{}", "javascript:alert(1)"]) {
      expect(() => checkUrl(url), url).toThrow(/URLs are not fetched \(only http and https\)/);
    }
    expect(() => checkUrl("not a url")).toThrow(/is not a URL/);
    const scheme = await refusal(() => new GuardedHttpTransport().get("file:///etc/passwd", 100));
    expect(scheme.kind).toBe("unfetchable");

    // --- bypass OFF: the local host is refused before any connection ------------------------------
    const guard = new GuardedHttpTransport(); // allowPrivateHosts: false — the production default
    const literal = await refusal(() => guard.get(`${host.origin}/pi/index.json`, 1000));
    expect(literal.kind).toBe("unfetchable");
    expect(literal.message).toMatch(/127\.0\.0\.1:\d+ is a loopback address; a verifier does not connect to it/);
    const named = await refusal(() => guard.get(`http://localhost:${host.port}/pi/index.json`, 1000));
    expect(named.message).toMatch(/localhost resolves to (127\.0\.0\.1|::1), a loopback address/);
    const v6 = await refusal(() => guard.get(`http://[::1]:${host.port}/pi/index.json`, 1000));
    expect(v6.message).toMatch(/is a loopback address/);
    expect(host.requests).toHaveLength(0); // nothing reached the host
    // A public-looking name that resolves to a private address — or to a public AND a private one —
    // is refused at connect time; no connection is attempted to either.
    const asked: string[] = [];
    const rebinding = new GuardedHttpTransport({
      resolve: async (name) => { asked.push(name); return name === "mixed.test" ? [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }] : [{ address: "10.1.2.3", family: 4 }]; },
    });
    expect(await refusal(() => rebinding.get("http://bundles.test/pi/index.json", 1000))).toMatchObject({ kind: "unfetchable", message: expect.stringMatching(/bundles\.test resolves to 10\.1\.2\.3, a private address/) });
    expect(await refusal(() => rebinding.get("https://mixed.test/pi/index.json", 1000))).toMatchObject({ kind: "unfetchable", message: expect.stringMatching(/mixed\.test resolves to 10\.0\.0\.7, a private address/) });
    expect(asked).toEqual(["bundles.test", "mixed.test"]);
    expect(named.kind).toBe("unfetchable");
    expect(v6.kind).toBe("unfetchable");
    // A name that does not resolve is NOT a policy refusal: the host did not deliver (C9, Q25).
    const nowhere = new GuardedHttpTransport({ resolve: async () => [] });
    expect(await refusal(() => nowhere.get("http://nowhere.test/", 10))).toMatchObject({ kind: "unreachable", message: expect.stringMatching(/ENOTFOUND/) });
    const failing = new GuardedHttpTransport({ resolve: async () => { throw Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" }); } });
    expect(await refusal(() => failing.get("http://flaky.test/", 10))).toMatchObject({ kind: "unreachable", message: expect.stringMatching(/EAI_AGAIN/) });
    // And through Level 1: the event URL on a loopback host is unfetchable, nothing fetched.
    const l1Refused = await levelOne({ url: `${host.origin}/pi/index.json`, commitment: commitmentOf(bundle) }, new GuardedHttpTransport());
    expect(l1Refused).toMatchObject({ outcome: "unfetchable", file: "index.json", requests: 1 });
    expect(host.requests).toHaveLength(0);

    // --- bypass ON (test-only flag): the same host is fetched, Level 1 passes over HTTP ------------
    const t = open();
    const l1 = await levelOne({ url: `${host.origin}/pi/index.json`, commitment: commitmentOf(bundle) }, t);
    expect(l1.outcome).toBe("passed");
    expect(host.requests.map((r) => r.path)).toEqual(["/pi/index.json", ...[...bundle.keys()].filter((p) => p !== "index.json").sort().map((p) => `/pi/${p}`)]);
    expect(host.requests.every((r) => r.headers["accept-encoding"] === "identity")).toBe(true);
    expect(t.requests).toBe(11);
    // …and a wrong hash stops after exactly ONE HTTP request.
    host.requests.length = 0;
    const wrong = await levelOne({ url: `${host.origin}/pi/index.json`, commitment: Buffer.alloc(32, 0x42) }, open());
    expect(wrong.outcome).toBe("failed");
    expect(host.requests.map((r) => r.path)).toEqual(["/pi/index.json"]);

    // --- redirects: at most 3, each hop re-checked ----------------------------------------------
    host.routes.set("/r1", { kind: "redirect", location: "/r2" });
    host.routes.set("/r2", { kind: "redirect", location: `${host.origin}/r3`, status: 301 });
    host.routes.set("/r3", { kind: "redirect", location: "/pi/README.md", status: 308 });
    const three = open();
    expect((await three.get(`${host.origin}/r1`, 10_000)).equals(bundle.get("README.md")!)).toBe(true);
    expect(three.redirects).toBe(3);
    host.routes.set("/r0", { kind: "redirect", location: "/r1", status: 307 });
    expect(await refusal(() => open().get(`${host.origin}/r0`, 10_000))).toMatchObject({ kind: "unreachable", message: expect.stringMatching(/more than 3 redirects/) });
    host.routes.set("/to-ftp", { kind: "redirect", location: "ftp://b.example/x" });
    expect(await refusal(() => open().get(`${host.origin}/to-ftp`, 10))).toMatchObject({ kind: "unfetchable", message: expect.stringMatching(/ftp: URLs are not fetched/) });
    host.routes.set("/nowhere", { kind: "redirect", location: "" });
    expect(await refusal(() => open().get(`${host.origin}/nowhere`, 10))).toMatchObject({ kind: "unreachable", message: expect.stringMatching(/without a Location/) });
    // With the bypass OFF, a hop to a private address is refused even when the first hop was allowed
    // (the classifier seam lets exactly 127.0.0.1 through; 127.0.0.2 is judged by the real one).
    host.routes.set("/to-private", { kind: "redirect", location: `http://127.0.0.2:${host.port}/pi/README.md` });
    const hop = new GuardedHttpTransport({ classify: (a) => (a === "127.0.0.1" ? null : classifyAddress(a)) });
    host.requests.length = 0;
    expect(await refusal(() => hop.get(`${host.origin}/to-private`, 10_000))).toMatchObject({ kind: "unfetchable", message: expect.stringMatching(/127\.0\.0\.2:\d+ is a loopback address/) });
    expect(host.requests.map((r) => r.path)).toEqual(["/to-private"]);

    // --- one deadline for the whole verification: unchecked ---------------------------------------
    host.routes.set("/stall", { kind: "stall" });
    const slow = open({ deadlineMs: 300 });
    const started = Date.now();
    const stalled = await refusal(() => slow.get(`${host.origin}/stall`, 10));
    expect(stalled.kind).toBe("unchecked");
    expect(stalled.message).toMatch(/the 300 ms deadline was reached/);
    expect(Date.now() - started).toBeLessThan(5_000);
    // Later requests of the same verification share the spent deadline.
    expect((await refusal(() => slow.get(`${host.origin}/pi/README.md`, 10_000))).kind).toBe("unchecked");

    // --- size caps: announced, and counted while reading (chunked) --------------------------------
    await expect(open().get(`${host.origin}/pi/README.md`, 100)).rejects.toBeInstanceOf(BodyTooLargeError);
    host.routes.set("/chunked", { kind: "body", body: Buffer.alloc(5_000, 0x61), chunked: true });
    await expect(open().get(`${host.origin}/chunked`, 4_999)).rejects.toThrow(/more than 4999 bytes; download aborted/);
    expect((await open().get(`${host.origin}/chunked`, 5_000))).toHaveLength(5_000);

    // --- identity bytes only; a host that does not deliver is unreachable (C9, owner Q25) --------
    host.routes.set("/gz", { kind: "body", body: Buffer.from("x"), headers: { "content-encoding": "gzip" } });
    expect(await refusal(() => open().get(`${host.origin}/gz`, 100))).toMatchObject({ kind: "unreachable", message: expect.stringMatching(/Content-Encoding "gzip"/) });
    host.routes.set("/boom", { kind: "status", status: 500 });
    expect(await refusal(() => open().get(`${host.origin}/boom`, 100))).toMatchObject({ kind: "unreachable", message: expect.stringMatching(/HTTP 500/) });
    host.routes.set("/gone", { kind: "status", status: 410 });
    expect(await refusal(() => open().get(`${host.origin}/gone`, 100))).toMatchObject({ kind: "unreachable", message: expect.stringMatching(/HTTP 410/) });
    host.routes.set("/info", { kind: "status", status: 204 });
    expect((await open().get(`${host.origin}/info`, 100))).toHaveLength(0); // 2xx: delivered (an empty body)
    expect(await refusal(() => open().get(`${host.origin}/missing`, 100))).toMatchObject({ kind: "unreachable", message: expect.stringMatching(/HTTP 404/) });
    host.routes.set("/reset", { kind: "reset" });
    expect(await refusal(() => open().get(`${host.origin}/reset`, 100))).toMatchObject({ kind: "unreachable", message: expect.stringMatching(/could not fetch .*(ECONNRESET|socket hang up)/) });
    const closed = await startBundleHost();
    const deadPort = closed.port;
    await closed.close();
    expect(await refusal(() => open().get(`http://127.0.0.1:${deadPort}/x`, 100))).toMatchObject({ kind: "unreachable", message: expect.stringMatching(/could not fetch .*ECONNREFUSED/) });
    // Through Level 1: a missing listed file is unreachable, naming the file (not failed, not a level).
    host.routes.set("/pi/out/keys/read.verifier", { kind: "status", status: 404 });
    const missing = await levelOne({ url: `${host.origin}/pi/index.json`, commitment: commitmentOf(bundle) }, open());
    expect(missing).toMatchObject({ outcome: "unreachable", file: "out/keys/read.verifier", steps: { hashOk: true, indexOk: true } });
  }, 60_000);
});
