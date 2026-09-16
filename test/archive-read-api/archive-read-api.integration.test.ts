import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadArchiveReadApiConfig } from "../../archive-read-api/config.js";
import { pgArchiveProgressEvents } from "../../archive-read-api/events.js";
import { createArchiveReadApi, silentLogger, type ArchiveReadApi } from "../../archive-read-api/server.js";
import type { ArchiveBlockPage } from "../../src/interfaces/archive-read-contract.js";
import { HttpArchiveReadContract } from "../../shielded-monitor/archive-http-client.js";
import { sseWake } from "../../shielded-monitor/wake.js";
import { buildCorpus, type BuiltCorpus } from "../fixtures/shielded-monitor/build-corpus.js";
import {
  archiveCorpusBlocks,
  createWorldSchemas,
  destroyWorld,
  type ScannerWorld,
} from "../shielded-monitor/scanner-harness.js";

/**
 * **Contract parity across the process boundary** (organizer sub-plan 00009-08; `spec/00009`
 * US7, FR-025).
 *
 * The claim 00009-08 rests on is that `HttpArchiveReadContract` and `PgArchiveReadContract` are
 * the same contract — that moving project B into its own process changes the transport and
 * nothing else. This suite states that as an equality over a REAL archive, written by the
 * archive's own writer, for randomised `after`/`max`: the two implementations must return
 * structurally identical pages, byte for byte, including the tip, the block timestamps, the
 * replay outcomes and the absence of optional fields.
 *
 * It also exercises the one thing no unit test can: the SSE stream fed by the archive's real
 * `NOTIFY chain_archive_progress`, emitted inside the height's own transaction.
 */

describe("the archive read API serves the same contract as the in-process reader", () => {
  let container: StartedPostgreSqlContainer;
  let world: Omit<ScannerWorld, "corpus" | "monitors">;
  let corpus: BuiltCorpus;
  let api: ArchiveReadApi;
  let client: HttpArchiveReadContract;
  let net: string;
  /** The highest height archived so far; `appendEmptyBlock` walks it forward. Shared, because
   *  each SSE test needs a NEW committed height and heights must stay parent-linked. */
  let tipHeight: number;
  let tipHash: string;

  /** Commits one more empty block through the archive's REAL writer, so the notification under
   *  test is the one `putBlockBundle` emits inside the height's own transaction. */
  async function appendEmptyBlock(): Promise<number> {
    const height = tipHeight + 1;
    const blockHash = `${"a".repeat(58)}${height.toString(16).padStart(6, "0")}`;
    const template = corpus.bundles.at(-1)!;
    await world.archiveStore.putBlockBundle({
      ...template,
      block: { ...template.block, height, blockHash, parentHash: tipHash },
      transactions: [],
      bridgeObservations: [],
      watermark: { key: `sync_cursor:${net}`, value: { height } },
      notifyChannel: "chain_archive_progress",
    });
    tipHeight = height;
    tipHash = blockHash;
    return height;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    corpus = await buildCorpus();
    net = corpus.manifest.net;
    world = await createWorldSchemas(container, "arcapi", { net });
    await archiveCorpusBlocks(world, corpus);
    tipHeight = corpus.bundles.at(-1)!.block.height;
    tipHash = corpus.bundles.at(-1)!.block.blockHash;

    api = createArchiveReadApi({
      archive: world.archive,
      config: loadArchiveReadApiConfig({ ARCHIVE_READ_PORT: "0", NET: net, ARCHIVE_READ_HEARTBEAT_MS: "1000" }),
      events: pgArchiveProgressEvents(world.sql),
      logger: silentLogger(),
    });
    const address = await api.listen();
    client = new HttpArchiveReadContract(`http://127.0.0.1:${address.port}`);
  }, 240_000);

  afterAll(async () => {
    await api?.close();
    if (world !== undefined) await destroyWorld(world);
    await container?.stop();
  }, 120_000);

  it("returns pages identical to the in-process reader for random after/max (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -1, max: 6 }),
        fc.integer({ min: 1, max: 8 }),
        async (after, max) => {
          const [overHttp, inProcess] = await Promise.all([
            client.readBlocksSince(net, after, max),
            world.archive.readBlocksSince(net, after, max),
          ]);
          expect(normalizePage(overHttp)).toStrictEqual(normalizePage(inProcess));
        },
      ),
      { numRuns: 24 },
    );
  }, 120_000);

  it("documents the two REPRESENTATION differences the normaliser above erases", async () => {
    // Found by the property failing before the normaliser existed, and recorded rather than
    // hidden, because a consumer could notice either one:
    //
    //  1. the PostgreSQL reader hands back Node `Buffer`s (the driver's own `bytea` mapping) and
    //     the HTTP client hands back plain `Uint8Array`s. Both satisfy the contract's declared
    //     type, and every consumer in this repository treats them identically — but code that
    //     called a `Buffer`-only method (`toString("hex")`, `readUInt32BE`) would work in-process
    //     and throw over HTTP;
    //  2. the PostgreSQL reader sets `result: undefined` as an OWN property where the archive
    //     recorded no replay outcome; the wire omits the key. `tx.result === undefined` is true
    //     either way, `"result" in tx` is not.
    const [overHttp, inProcess] = await Promise.all([
      client.readBlocksSince(net, 0, 2),
      world.archive.readBlocksSince(net, 0, 2),
    ]);
    const httpTx = overHttp.blocks.flatMap((b) => b.transactions)[0]!;
    const pgTx = inProcess.blocks.flatMap((b) => b.transactions)[0]!;
    expect(Buffer.isBuffer(pgTx.rawBytes)).toBe(true);
    expect(Buffer.isBuffer(httpTx.rawBytes)).toBe(false);
    expect(httpTx.rawBytes).toBeInstanceOf(Uint8Array);
    expect("result" in pgTx).toBe(true);
    expect("result" in httpTx).toBe(false);
    expect(pgTx.result).toBeUndefined();
    expect(httpTx.result).toBeUndefined();
  });

  it("carries real raw bytes, real block timestamps and the corpus's own transaction hashes", async () => {
    // Non-vacuity for the property above: the pages it compares are not empty, and the fields
    // that would be easiest to drop silently are present and correct.
    const page = await client.readBlocksSince(net, -1, 64);
    expect(page.blocks.length).toBe(corpus.bundles.length);
    const withTx = page.blocks.find((b) => b.transactions.length > 0)!;
    expect(withTx.timestampMs).toBeGreaterThan(0);
    const expected = corpus.transactions.find((t) => t.spec.blockHeight === withTx.height && t.spec.position === 0)!;
    expect(withTx.transactions[0]!.txHash).toBe(expected.txHash);
    expect(Array.from(withTx.transactions[0]!.rawBytes)).toStrictEqual(Array.from(expected.rawBytes));
    expect(page.sourceTip?.height).toBe(corpus.bundles.at(-1)!.block.height);
  });

  it("reports the same archive identity as the in-process reader, and the same one across calls", async () => {
    const inProcess = await world.archive.getArchiveIdentity(net);
    expect(await client.getArchiveIdentity(net)).toStrictEqual(inProcess);
    expect(await client.getArchiveIdentity(net)).toStrictEqual(inProcess);
    expect(inProcess?.archiveInstanceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("answers `undefined` for a net this archive knows nothing about", async () => {
    expect(await client.getArchiveIdentity("some-other-net")).toBeUndefined();
    expect(await client.readBlocksSince("some-other-net", -1, 4)).toStrictEqual({ blocks: [] });
  });

  it("delivers a height committed by the archive's own writer to an SSE subscriber", async () => {
    // End to end: `putBlockBundle` NOTIFYs inside the height's transaction (00009-01), the read
    // API is LISTENing, and project B's SSE wake-up source receives it — the path that replaces
    // the `LISTEN` B can no longer do once A's database is a different server.
    let woken = 0;
    const subscription = await sseWake(client.baseUrl, { reconnectDelayMs: 20 })
      .subscribe(net, () => { woken += 1; });
    try {
      // The subscription must be attached before the notification: PostgreSQL queues nothing.
      await new Promise((r) => setTimeout(r, 300));
      await appendEmptyBlock();
      await waitUntil(() => woken > 0, 15_000);
      expect(woken).toBeGreaterThan(0);
    } finally {
      await subscription.close();
    }
  }, 60_000);

  it("a subscriber reconnects after the read API restarts under it", async () => {
    // The stream is allowed to drop — a server restart, a proxy idle timeout, a network blip.
    // What is NOT allowed is for the consumer to stop listening: a wake-up source that gave up
    // would leave a permanently laggy tail with nothing in the logs and a scanner still reporting
    // itself healthy, because polling covers it.
    const first = createArchiveReadApi({
      archive: world.archive,
      config: loadArchiveReadApiConfig({ ARCHIVE_READ_PORT: "0", NET: net, ARCHIVE_READ_HEARTBEAT_MS: "1000" }),
      events: pgArchiveProgressEvents(world.sql),
      logger: silentLogger(),
    });
    const address = await first.listen();
    const base = `http://127.0.0.1:${address.port}`;

    let woken = 0;
    const subscription = await sseWake(base, { reconnectDelayMs: 50, maxReconnectDelayMs: 200 })
      .subscribe(net, () => { woken += 1; });
    let second: ArchiveReadApi | undefined;
    try {
      await new Promise((r) => setTimeout(r, 300));
      await appendEmptyBlock();
      await waitUntil(() => woken >= 1, 15_000);

      // Restart: every open stream ends, and a NEW process takes the same port.
      await first.close();
      second = createArchiveReadApi({
        archive: world.archive,
        config: loadArchiveReadApiConfig({
          ARCHIVE_READ_PORT: String(address.port), NET: net, ARCHIVE_READ_HEARTBEAT_MS: "1000",
        }),
        events: pgArchiveProgressEvents(world.sql),
        logger: silentLogger(),
      });
      await second.listen();

      const before = woken;
      await waitUntil(async () => {
        // Published repeatedly: the reconnect may land after the first notification, and
        // PostgreSQL queues nothing for a listener that was not connected.
        await appendEmptyBlock();
        return woken > before;
      }, 20_000, 400);
      expect(woken).toBeGreaterThan(before);
    } finally {
      await subscription.close();
      await second?.close();
      await first.close();
    }
  }, 90_000);
});

/**
 * Compares two pages by VALUE, erasing the two representation differences documented above:
 * `Buffer` versus plain `Uint8Array`, and an own `result: undefined` key versus an absent one.
 * Everything else — every height, hash, position, protocol version, timestamp, byte and the tip —
 * still has to match exactly.
 */
function normalizePage(page: ArchiveBlockPage): unknown {
  return {
    blocks: page.blocks.map((block) => ({
      net: block.net,
      height: block.height,
      hash: block.hash,
      parentHash: block.parentHash,
      timestampMs: block.timestampMs ?? null,
      transactions: block.transactions.map((tx) => ({
        txHash: tx.txHash,
        position: tx.position,
        kind: tx.kind,
        protocolVersion: tx.protocolVersion,
        result: tx.result ?? null,
        rawBytes: Array.from(tx.rawBytes),
      })),
    })),
    sourceTip: page.sourceTip ?? null,
  };
}

/** A plain poll helper: these waits span real database work and a real reconnect backoff, and
 *  want a generous wall-clock bound rather than fake timers. */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
