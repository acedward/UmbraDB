/**
 * The browser engine's worker host (`token-indexer/browser/host.ts`) in Node, on an in-memory PGlite (`memory://`), for
 * what the sync adds to it; the same host runs in Chrome's worker on OPFS (`browser-sync.test.ts`).
 *
 * - `[[browser.host.digest]]` — `digest` gives the store's archive digest and the digest of every table of both
 *   schemas, read in one transaction; on the replayed U1 range the archive digest is the recorded live sync's.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkerHost, type WorkerHost, type WorkerHostOptions } from "../browser/host.ts";
import { type CapabilityReport, type DigestResult, type HostStatus, PROTOCOL_VERSION, type Response } from "../browser/protocol.ts";
import { loadTape } from "../browser/tapes.ts";

const U1 = { from: 715402, to: 715433 } as const;
const FAST = { sync: { idleMs: 100 }, scan: { idleMs: 100 } };

const SUPPORTED: CapabilityReport = {
  supported: true,
  message: "",
  missing: [],
  checks: { chromium: true, opfs: true, syncAccessHandle: true, webLocks: true, broadcastChannel: true, persistentStorage: true },
  browser: "Chromium 153",
};

const MANIFEST = JSON.parse(readFileSync(new URL("../../test/integration/fixtures/stagenet-archive/manifest.json", import.meta.url), "utf8")) as {
  ranges: Array<{ name: string; liveSync: { archiveDigest: DigestResult["archive"] } }>;
};

/** `fetch` for the tape catalog's `file:` URLs. */
const fileFetch: typeof fetch = (async (input: string | URL | Request) =>
  new Response(new Uint8Array(readFileSync(fileURLToPath(input instanceof Request ? input.url : String(input)))))) as typeof fetch;

const hosts: WorkerHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
});

function newHost(over: Partial<WorkerHostOptions> = {}): WorkerHost {
  const host = createWorkerHost({
    network: "stagenet",
    dataDir: "memory://",
    nodeUrl: "https://node.invalid/",
    indexerUrl: "https://indexer.invalid/",
    checkCapabilities: async () => SUPPORTED,
    loadTape: (range) => loadTape(range, fileFetch),
    log: () => {},
    ...over,
  });
  hosts.push(host);
  return host;
}

let nextId = 1;
async function result<T = unknown>(host: WorkerHost, type: string, params: Record<string, unknown> = {}): Promise<T> {
  const r: Response = await host.receive({ v: PROTOCOL_VERSION, id: nextId++, type, ...params });
  if (!r.ok) throw new Error(`${type}: ${r.error.code} ${r.error.message}`);
  return r.result as T;
}

async function until(host: WorkerHost, what: string, ok: (s: HostStatus) => boolean, timeoutMs = 60_000): Promise<HostStatus> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await result<HostStatus>(host, "status");
    if (ok(s)) return s;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(s.engine?.status ?? s.boot)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("browser engine host: sync", () => {
  it("[[browser.host.digest]] digest gives the archive digest and the digest of every table of both schemas in one transaction; the replayed U1 range gives the recorded live archive digest", async () => {
    const host = newHost();
    const empty = await result<DigestResult>(host, "digest");
    expect(empty.archive.tables.blocks).toMatchObject({ rows: 0 });
    expect(Object.keys(empty.tables.tables)).toHaveLength(37);
    expect(empty.elapsedMs).toBeGreaterThanOrEqual(0);

    await result(host, "start", { config: { source: { kind: "tape", range: "u1" }, startHeight: U1.from, endHeight: U1.to, ...FAST } });
    // While the engine runs, a digest is one consistent state: its archive rows agree with its own cursor.
    const during = await result<DigestResult>(host, "digest");
    expect(during.tables.tables["archive.blocks"]!.rows).toBe(during.archive.tables.blocks!.rows);
    await until(host, "U1 synced and scanned", (s) => s.engine!.status.sync.phase === "done" && s.cursors?.scan?.nextHeight === U1.to + 1);
    const done = await result<DigestResult>(host, "digest");
    expect(done.archive).toEqual(MANIFEST.ranges.find((r) => r.name === "u1")!.liveSync.archiveDigest);
    expect(done.tables.tables["archive.blocks"]).toMatchObject({ rows: U1.to - U1.from + 1 });
    expect(done.tables.sha256).toMatch(/^[0-9a-f]{64}$/);
    await result(host, "stop");
    expect(await result<DigestResult>(host, "digest")).toMatchObject({ archive: done.archive, tables: done.tables });
  }, 120_000);
});
