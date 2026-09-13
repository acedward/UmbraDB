import { afterEach, describe, expect, it } from "vitest";
import {
  ArchiveDiscontinuityError,
  type ArchiveBlockPage,
  type ArchiveIdentity,
  type ArchiveReadContract,
} from "../../src/interfaces/archive-read-contract.js";
import { BlobIntegrityError } from "../../src/interfaces/chain-archive-store.js";
import { loadArchiveReadApiConfig } from "../../archive-read-api/config.js";
import { parseProgressPayload, type ArchiveProgressEvents } from "../../archive-read-api/events.js";
import { createArchiveReadApi, silentLogger } from "../../archive-read-api/server.js";
import {
  ArchiveHttpError,
  ArchiveUnreachableError,
  HttpArchiveReadContract,
} from "../../shielded-monitor/archive-http-client.js";

/**
 * The archive read API and project B's client, over a REAL HTTP socket, with the archive itself
 * stubbed.
 *
 * Stubbing the archive rather than the transport is the point: what is under test here is the
 * boundary 00009-08 adds — routing, query parsing, the page cap, error mapping, the SSE stream and
 * the client that reads all of it. The PostgreSQL implementation behind it is already covered by
 * `test/postgres/archive-read-contract.property.test.ts`, and the two are compared end to end
 * against a real database in `archive-read-api.integration.test.ts`.
 */

const hex32 = (seed: number): string => seed.toString(16).padStart(64, "0");

class StubArchive implements ArchiveReadContract {
  readonly calls: { net: string; afterHeight: number; maxBlocks: number }[] = [];
  private readonly identity: ArchiveIdentity | undefined;
  constructor(
    private readonly heights: number[],
    opts: { identity?: ArchiveIdentity | null; failWith?: Error } = {},
  ) {
    // `null` means "the archive cannot yet name itself"; omitted means the default identity. A
    // plain optional would collapse the two, and the 404 path is exactly what this distinguishes.
    this.identity = opts.identity === null
      ? undefined
      : opts.identity ?? { net: "undeployed", genesisHash: hex32(1), archiveInstanceId: "f".repeat(32) };
    this.failWith = opts.failWith;
  }
  private readonly failWith: Error | undefined;

  async readBlocksSince(net: string, afterHeight: number, maxBlocks: number): Promise<ArchiveBlockPage> {
    this.calls.push({ net, afterHeight, maxBlocks });
    if (this.failWith !== undefined) throw this.failWith;
    const selected = this.heights.filter((h) => h > afterHeight).slice(0, maxBlocks);
    const top = this.heights[this.heights.length - 1];
    return {
      blocks: selected.map((height) => ({
        net,
        height,
        hash: hex32(height + 1),
        parentHash: hex32(height),
        timestampMs: 1_754_395_200_000 + height * 6_000,
        transactions: [{
          txHash: hex32(5000 + height),
          position: 0,
          kind: "regular" as const,
          protocolVersion: 1_000_000,
          rawBytes: Uint8Array.from([height, 0xde, 0xad, 0xbe, 0xef]),
        }],
      })),
      ...(top === undefined ? {} : { sourceTip: { height: top, hash: hex32(top + 1) } }),
    };
  }

  async getArchiveIdentity(): Promise<ArchiveIdentity | undefined> {
    return this.identity;
  }
}

const started: { close: () => Promise<void> }[] = [];

async function serve(
  archive: ArchiveReadContract,
  env: NodeJS.ProcessEnv = {},
  events?: ArchiveProgressEvents,
): Promise<{ base: string; client: HttpArchiveReadContract }> {
  const api = createArchiveReadApi({
    archive,
    config: loadArchiveReadApiConfig({ ARCHIVE_READ_PORT: "0", ...env }),
    ...(events === undefined ? {} : { events }),
    logger: silentLogger(),
  });
  const address = await api.listen();
  started.push(api);
  const base = `http://127.0.0.1:${address.port}`;
  return { base, client: new HttpArchiveReadContract(base) };
}

afterEach(async () => {
  while (started.length > 0) await started.pop()!.close();
});

describe("archive read API over HTTP", () => {
  it("serves a page the client decodes identically to what the archive returned", async () => {
    const archive = new StubArchive([0, 1, 2, 3]);
    const { client } = await serve(archive);
    const direct = await archive.readBlocksSince("undeployed", 0, 2);
    const overHttp = await client.readBlocksSince("undeployed", 0, 2);
    expect(overHttp).toStrictEqual(direct);
    // Not a vacuous comparison: the page really carries bytes and a tip.
    expect(overHttp.blocks[0]!.transactions[0]!.rawBytes.length).toBe(5);
    expect(overHttp.sourceTip).toStrictEqual({ height: 3, hash: hex32(4) });
  });

  it("serves the identity, and answers 404 -> undefined when the archive cannot yet name itself", async () => {
    const { client } = await serve(new StubArchive([0]));
    expect(await client.getArchiveIdentity("undeployed")).toStrictEqual({
      net: "undeployed", genesisHash: hex32(1), archiveInstanceId: "f".repeat(32),
    });
    const silent = await serve(new StubArchive([], { identity: null }));
    expect(await silent.client.getArchiveIdentity("undeployed")).toBeUndefined();
  });

  it("CLAMPS an oversized `max` to the page cap instead of refusing the request", async () => {
    // A short page is legal by contract (a page never splits a block), and the client resumes
    // from the last returned height, so clamping is correct where refusing would only be noisy.
    const archive = new StubArchive([1, 2, 3, 4, 5, 6]);
    const { base } = await serve(archive, { ARCHIVE_READ_MAX_BLOCKS: "2" });
    const body = await (await fetch(`${base}/v1/archive/blocks?after=0&max=100`)).json() as { blocks: unknown[] };
    expect(body.blocks.length).toBe(2);
    expect(archive.calls.at(-1)!.maxBlocks).toBe(2);
  });

  it("defaults `after` to -1 (from genesis) and `net` to the deployment's network", async () => {
    const archive = new StubArchive([0, 1]);
    const { base } = await serve(archive, { NET: "undeployed" });
    await fetch(`${base}/v1/archive/blocks`);
    expect(archive.calls.at(-1)).toStrictEqual({ net: "undeployed", afterHeight: -1, maxBlocks: 64 });
  });

  it("reports the tip without returning any block rows", async () => {
    const archive = new StubArchive([0, 1, 2]);
    const { base } = await serve(archive);
    const body = await (await fetch(`${base}/v1/archive/tip`)).json() as { sourceTip: { height: number } | null };
    expect(body.sourceTip?.height).toBe(2);
    expect(archive.calls.at(-1)!.afterHeight).toBe(Number.MAX_SAFE_INTEGER - 1);
  });

  it.each([
    ["?after=banana", "after must be a decimal integer"],
    ["?after=-5", "after must be >= -1"],
    ["?max=0", "max must be >= 1"],
    ["?net=not%20a%20net", "net must match"],
  ])("refuses %s with a typed 400", async (query, message) => {
    const { base } = await serve(new StubArchive([1]));
    const response = await fetch(`${base}/v1/archive/blocks${query}`);
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.message).toContain(message);
  });

  it("maps an archive discontinuity to 409 ARCHIVE_DISCONTINUITY, not to a retryable 500", async () => {
    const err = new ArchiveDiscontinuityError("undeployed", 7, hex32(6), hex32(66));
    const { base, client } = await serve(new StubArchive([1], { failWith: err }));
    expect((await fetch(`${base}/v1/archive/blocks`)).status).toBe(409);
    await expect(client.readBlocksSince("undeployed", -1, 4)).rejects.toMatchObject({
      code: "ARCHIVE_HTTP_ERROR", status: 409, serverCode: "ARCHIVE_DISCONTINUITY",
    });
  });

  it("maps a blob-integrity refusal to 409 BLOB_INTEGRITY", async () => {
    const err = new BlobIntegrityError(hex32(3), hex32(4));
    const { base } = await serve(new StubArchive([1], { failWith: err }));
    const response = await fetch(`${base}/v1/archive/blocks`);
    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("BLOB_INTEGRITY");
  });

  it("answers 404 for an unknown route and 405 with an Allow header for a write attempt", async () => {
    const { base } = await serve(new StubArchive([1]));
    expect((await fetch(`${base}/v1/archive/nope`)).status).toBe(404);
    const write = await fetch(`${base}/v1/archive/blocks`, { method: "POST" });
    expect(write.status).toBe(405);
    expect(write.headers.get("allow")).toBe("GET");
  });

  it("answers /v1/health with the wire version", async () => {
    const { base } = await serve(new StubArchive([1]));
    const body = await (await fetch(`${base}/v1/health`)).json() as { status: string; wireVersion: number };
    expect(body.status).toBe("ok");
    expect(body.wireVersion).toBe(1);
  });

  it("tells a client that the server is unreachable, distinctly from a server that refused", async () => {
    const client = new HttpArchiveReadContract("http://127.0.0.1:1", { requestTimeoutMs: 2_000 });
    await expect(client.readBlocksSince("undeployed", -1, 1)).rejects.toBeInstanceOf(ArchiveUnreachableError);
  });

  it("refuses a base URL carrying a query string, where a path would silently be dropped", () => {
    expect(() => new HttpArchiveReadContract("http://host:8790/?x=1")).toThrow(/bare base URL/);
  });

  it("throws ArchiveHttpError, not a parse error, when the server answers non-JSON", async () => {
    const client = new HttpArchiveReadContract("http://archive.invalid", {
      fetch: async () => new Response("<html>proxy error</html>", { status: 200 }),
    });
    await expect(client.readBlocksSince("undeployed", -1, 1)).rejects.toBeInstanceOf(ArchiveHttpError);
  });
});

describe("archive read API progress stream (SSE)", () => {
  /** A hand-driven event source, so the test controls exactly when a height is published. */
  function manualEvents(): ArchiveProgressEvents & { publish: (net: string, height: number) => void } {
    const listeners = new Set<(e: { net: string; height: number }) => void>();
    return {
      publish: (net, height) => { for (const l of listeners) l({ net, height }); },
      subscribe: async (listener) => {
        listeners.add(listener);
        return { close: async () => { listeners.delete(listener); } };
      },
    };
  }

  it("delivers a committed height to a subscriber, and filters other networks out", async () => {
    const events = manualEvents();
    const { base } = await serve(new StubArchive([1]), { ARCHIVE_READ_HEARTBEAT_MS: "1000" }, events);
    const response = await fetch(`${base}/v1/archive/events?net=undeployed`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    // `retry:` first, so a client reconnects on the server's schedule.
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain("retry:");

    // Published AFTER the subscription is attached; the server attaches it inside the request.
    await new Promise((r) => setTimeout(r, 50));
    events.publish("other-net", 41);
    events.publish("undeployed", 42);

    let seen = "";
    while (!seen.includes("progress")) seen += decoder.decode((await reader.read()).value);
    expect(seen).toContain('"height":42');
    expect(seen).not.toContain("41");
    await reader.cancel();
  });

  it("emits a heartbeat comment on an idle stream, so an intermediary cannot reap a live connection", async () => {
    const { base } = await serve(new StubArchive([1]), { ARCHIVE_READ_HEARTBEAT_MS: "1000" }, manualEvents());
    const response = await fetch(`${base}/v1/archive/events`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes(": heartbeat")) seen += decoder.decode((await reader.read()).value);
    expect(seen).toContain(": heartbeat");
    await reader.cancel();
  });

  it("keeps the stream open, marked degraded, when the event source cannot be subscribed", async () => {
    const broken: ArchiveProgressEvents = {
      subscribe: async () => { throw new Error("LISTEN refused"); },
    };
    const { base } = await serve(new StubArchive([1]), { ARCHIVE_READ_HEARTBEAT_MS: "1000" }, broken);
    const response = await fetch(`${base}/v1/archive/events`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("degraded")) seen += decoder.decode((await reader.read()).value);
    expect(seen).toContain("LISTEN refused");
    await reader.cancel();
  });
});

describe("archive progress payload parsing", () => {
  it("reads the writer's `<net>:<height>` payload", () => {
    expect(parseProgressPayload("undeployed:42")).toStrictEqual({ net: "undeployed", height: 42 });
  });

  it("tolerates a net containing a colon by splitting on the LAST one", () => {
    expect(parseProgressPayload("a:b:7")).toStrictEqual({ net: "a:b", height: 7 });
  });

  it.each(["", "nocolon", ":5", "undeployed:", "undeployed:-1", "undeployed:abc"])(
    "returns undefined for the malformed payload %j rather than throwing",
    (payload) => { expect(parseProgressPayload(payload)).toBeUndefined(); },
  );
});

describe("archive read API configuration", () => {
  it("defaults to loopback, port 8790 and a 64-block page", () => {
    const config = loadArchiveReadApiConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8790);
    expect(config.maxBlocksPerPage).toBe(64);
    expect(config.schema).toBe("chain_archive");
  });

  it.each([
    ["ARCHIVE_READ_PORT", "70000"],
    ["ARCHIVE_READ_PORT", "eight"],
    ["ARCHIVE_READ_MAX_BLOCKS", "0"],
    ["ARCHIVE_READ_HEARTBEAT_MS", "10"],
    ["NET", "not a net"],
  ])("refuses %s=%j at boot, naming the variable", (variable, value) => {
    expect(() => loadArchiveReadApiConfig({ [variable]: value })).toThrow(new RegExp(variable));
  });
});
