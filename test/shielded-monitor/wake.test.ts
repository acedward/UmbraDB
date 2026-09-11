import { describe, expect, it, vi } from "vitest";
import { NO_WAKE, pgListenWake, readEventStream, sseWake } from "../../shielded-monitor/wake.js";

/**
 * The wake-up sources (organizer sub-plan 00009-08).
 *
 * Everything here is an OPTIMISATION: a missed wake-up costs promptness, never correctness,
 * because `SCAN_POLL_MS` still fires and the scheduler re-reads coverage from its own schema. That
 * is exactly why these need their own tests — a broken wake-up source produces no failure anyone
 * would notice, only a tail that is quietly seconds behind, forever.
 */

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("SSE frame reading", () => {
  it("wakes on a progress event for this net", async () => {
    const onWake = vi.fn();
    await readEventStream(
      streamOf('event: progress\ndata: {"net":"undeployed","height":7}\n\n'),
      "undeployed",
      onWake,
    );
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("reassembles a frame split across chunk boundaries", async () => {
    // The failure this catches is the classic one: a reader that parses each chunk independently
    // works in every test with short payloads and drops events the moment a page is big enough to
    // be split by the kernel.
    const onWake = vi.fn();
    await readEventStream(
      streamOf("event: progr", 'ess\ndata: {"net":"undeployed",', '"height":7}\n', "\n"),
      "undeployed",
      onWake,
    );
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("handles several frames in one chunk, and CRLF line endings", async () => {
    const onWake = vi.fn();
    await readEventStream(
      streamOf(
        'event: progress\r\ndata: {"net":"undeployed","height":1}\r\n\r\n' +
          'event: progress\ndata: {"net":"undeployed","height":2}\n\n',
      ),
      "undeployed",
      onWake,
    );
    expect(onWake).toHaveBeenCalledTimes(2);
  });

  it("ignores heartbeat comments, other networks, other event types and unreadable payloads", async () => {
    const onWake = vi.fn();
    await readEventStream(
      streamOf(
        ": heartbeat 123\n\n" +
          "retry: 2000\n\n" +
          'event: progress\ndata: {"net":"other","height":9}\n\n' +
          'event: degraded\ndata: {"reason":"LISTEN refused"}\n\n' +
          "event: progress\ndata: not json at all\n\n" +
          'event: progress\ndata: {"net":"undeployed","height":-4}\n\n',
      ),
      "undeployed",
      onWake,
    );
    // A stream of garbage must not spin the scheduler: not one of those is a wake.
    expect(onWake).not.toHaveBeenCalled();
  });

  it("stops reading once the subscription is closed", async () => {
    const onWake = vi.fn();
    await readEventStream(
      streamOf('event: progress\ndata: {"net":"undeployed","height":1}\n\n'),
      "undeployed",
      onWake,
      () => true,
    );
    expect(onWake).not.toHaveBeenCalled();
  });
});

describe("sseWake", () => {
  it("reconnects after the stream ends, and stops when closed", async () => {
    let connections = 0;
    const fakeFetch = vi.fn(async (url: string) => {
      connections += 1;
      expect(url).toContain("/v1/archive/events?net=undeployed");
      return new Response(
        streamOf(`event: progress\ndata: {"net":"undeployed","height":${connections}}\n\n`),
        { status: 200 },
      );
    });
    const onWake = vi.fn();
    const source = sseWake("http://archive:8790", { fetch: fakeFetch as never, reconnectDelayMs: 5, maxReconnectDelayMs: 5 });
    const subscription = await source.subscribe("undeployed", onWake);
    await vi.waitFor(() => { expect(connections).toBeGreaterThanOrEqual(2); }, { timeout: 3_000 });
    await subscription.close();
    const seen = connections;
    await new Promise((r) => setTimeout(r, 50));
    expect(connections).toBe(seen); // no reconnect after close
    expect(onWake.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps retrying — and logs — when the stream is unavailable, instead of giving up", async () => {
    // A source that gave up would turn a transient outage into a permanently laggy tail, with the
    // scanner still reporting itself healthy because polling covers it.
    const lines: string[] = [];
    let attempts = 0;
    const fakeFetch = vi.fn(async () => {
      attempts += 1;
      throw new Error("ECONNREFUSED");
    });
    const source = sseWake("http://archive:8790", {
      fetch: fakeFetch as never, reconnectDelayMs: 5, maxReconnectDelayMs: 5,
      logger: (line) => lines.push(line),
    });
    const subscription = await source.subscribe("undeployed", () => undefined);
    await vi.waitFor(() => { expect(attempts).toBeGreaterThanOrEqual(3); }, { timeout: 3_000 });
    await subscription.close();
    expect(lines.some((l) => l.includes("polling continues meanwhile"))).toBe(true);
  });

  it("treats a non-200 as a failed connection rather than an empty stream", async () => {
    let attempts = 0;
    const fakeFetch = vi.fn(async () => {
      attempts += 1;
      return new Response("nope", { status: 503 });
    });
    const source = sseWake("http://archive:8790", {
      fetch: fakeFetch as never, reconnectDelayMs: 5, maxReconnectDelayMs: 5,
    });
    const subscription = await source.subscribe("undeployed", () => undefined);
    await vi.waitFor(() => { expect(attempts).toBeGreaterThanOrEqual(2); }, { timeout: 3_000 });
    await subscription.close();
  });
});

describe("pgListenWake", () => {
  it("wakes only for this net's notifications and unlistens on close", async () => {
    let payloadHandler: ((payload: string) => void) | undefined;
    let unlistened = 0;
    const sql = {
      listen: async (_channel: string, handler: (payload: string) => void) => {
        payloadHandler = handler;
        return { unlisten: async () => { unlistened += 1; } };
      },
    };
    const onWake = vi.fn();
    const subscription = await pgListenWake(sql).subscribe("undeployed", onWake);
    payloadHandler!("other:9");
    expect(onWake).not.toHaveBeenCalled();
    payloadHandler!("undeployed:9");
    expect(onWake).toHaveBeenCalledTimes(1);
    await subscription.close();
    expect(unlistened).toBe(1);
  });

  it("names the channel it listens on, for the boot banner", () => {
    expect(pgListenWake({ listen: async () => ({ unlisten: async () => undefined }) }).describe)
      .toBe("LISTEN chain_archive_progress");
  });
});

describe("NO_WAKE", () => {
  it("is a correct implementation: polling alone, and closing it is a no-op", async () => {
    expect(NO_WAKE.describe).toBe("polling only");
    const subscription = await NO_WAKE.subscribe("undeployed", () => { throw new Error("must never fire"); });
    await subscription.close();
  });
});
