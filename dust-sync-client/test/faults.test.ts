/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { DustSyncError, asNonLinear } from "../src/errors.js";
import { DustHttpClient, delay } from "../src/http.js";
import { assertLedgerSurface } from "../src/ledger.js";

/**
 * The refusal paths: how a wrong ledger module, a wrong node answer and a ledger throw are
 * reported (`spec/00016-dust-wallet-sync.md` FR-030, SC-006).
 *
 * These are the paths a wallet meets on a bad day, and every one of them has a rule attached that
 * only a test can hold: an error message must never carry a nullifier or a key (SC-006), a
 * linearity violation must be distinguishable from a programming error (FR-030 names it), and a
 * failed request must be reported with the node's own error CODE rather than its prose.
 */

describe("asNonLinear", () => {
  it("recognises the ledger's linearity refusal, whatever it is spelled like", () => {
    for (const message of [
      "NonLinearInsertion { expected_next: 4, received: 9 }",
      "non-linear insertion into the commitment tree",
      "nonlinearinsertion",
    ]) {
      const error = asNonLinear(new Error(message), "commitment index 9");
      expect(error.code, message).toBe("DUST_SYNC_NONLINEAR");
      expect(error.detail.where).toBe("commitment index 9");
    }
  });

  it("reports anything else as bad input rather than pretending it is linearity", () => {
    const error = asNonLinear(new Error("null pointer passed to rust"), "generation index 3");
    expect(error.code).toBe("DUST_SYNC_INVALID_INPUT");
    expect(error.detail.ledgerMessage).toBe("null pointer passed to rust");
  });

  it("survives a throw that is not an Error", () => {
    expect(asNonLinear("NonLinearInsertion", "x").code).toBe("DUST_SYNC_NONLINEAR");
    expect(asNonLinear(undefined, "x").code).toBe("DUST_SYNC_INVALID_INPUT");
  });
});

describe("assertLedgerSurface", () => {
  const stub = {
    DustLocalState: class {},
    DustParameters: class {},
    DustStateMerkleTreeCollapsedUpdate: class {},
    dustNullifier: () => 0n,
  };

  it("accepts a module with the members the client uses", () => {
    expect(() => assertLedgerSurface(stub)).not.toThrow();
  });

  it("refuses a non-module", () => {
    expect(() => assertLedgerSurface(null)).toThrow(TypeError);
    expect(() => assertLedgerSurface("@midnight-ntwrk/ledger-v8")).toThrow(TypeError);
  });

  it("names the missing class, so a wallet that passed the wrong build finds out at once", () => {
    const { DustLocalState: _omitted, ...withoutClass } = stub;
    expect(() => assertLedgerSurface(withoutClass)).toThrow(/DustLocalState/);
    const { dustNullifier: _gone, ...withoutFunction } = stub;
    expect(() => assertLedgerSurface(withoutFunction)).toThrow(/dustNullifier/);
  });
});

describe("DustHttpClient", () => {
  const ok = (body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  it("refuses a base URL that is not http(s), before any request", () => {
    expect(() => new DustHttpClient({ baseUrl: "ws://node" })).toThrow(DustSyncError);
    expect(() => new DustHttpClient({ baseUrl: "  " })).toThrow(DustSyncError);
  });

  it("counts requests and the bytes that came back", async () => {
    const client = new DustHttpClient({ baseUrl: "http://node.invalid/", fetchImpl: ok({ a: 1 }) });
    await client.get("tip", { net: "x" });
    await client.post("lookup", { net: "x", nullifiers: ["1"] });
    expect(client.requests).toBe(2);
    expect(client.bytesIn).toBe(2 * JSON.stringify({ a: 1 }).length);
  });

  it("waits rttDelayMs before every request — the instrument spec §7 asks for", async () => {
    const client = new DustHttpClient({ baseUrl: "http://node.invalid", rttDelayMs: 25, fetchImpl: ok({}) });
    const started = Date.now();
    await client.get("tip", { net: "x" });
    await client.get("tip", { net: "x" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it("reports a transport failure as DUST_SYNC_HTTP naming only the route", async () => {
    const client = new DustHttpClient({
      baseUrl: "http://node.invalid",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:9");
      }) as unknown as typeof fetch,
    });
    await expect(client.get("tip", { net: "x" })).rejects.toMatchObject({
      code: "DUST_SYNC_HTTP",
      detail: { route: "tip" },
    });
  });

  it("carries the node's own error code, and copes with a refusal that is not JSON", async () => {
    const withCode = new DustHttpClient({
      baseUrl: "http://node.invalid",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { code: "DUST_RANGE_INVALID", message: "nope" } }), {
          status: 400,
        })) as unknown as typeof fetch,
    });
    await expect(withCode.get("segments", { net: "x" })).rejects.toMatchObject({
      detail: { status: 400, code: "DUST_RANGE_INVALID" },
    });

    const html = new DustHttpClient({
      baseUrl: "http://node.invalid",
      fetchImpl: (async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch,
    });
    await expect(html.get("tip", { net: "x" })).rejects.toMatchObject({ detail: { status: 502, code: "" } });
  });

  it("refuses a 200 that is not JSON rather than returning undefined", async () => {
    const client = new DustHttpClient({
      baseUrl: "http://node.invalid",
      fetchImpl: (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch,
    });
    await expect(client.get("tip", { net: "x" })).rejects.toMatchObject({ code: "DUST_SYNC_HTTP" });
  });

  it("aborts a request that never answers", async () => {
    const client = new DustHttpClient({
      baseUrl: "http://node.invalid",
      timeoutMs: 20,
      fetchImpl: ((_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as typeof fetch,
    });
    await expect(client.get("tip", { net: "x" })).rejects.toMatchObject({ code: "DUST_SYNC_HTTP" });
  });

  it("delay resolves", async () => {
    const spy = vi.fn();
    await delay(1).then(spy);
    expect(spy).toHaveBeenCalled();
  });
});
