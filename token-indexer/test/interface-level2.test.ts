import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as rt from "@midnight-ntwrk/compact-runtime";
import { describe, expect, it } from "vitest";
import {
  IndexerStateSource, MAX_CIRCUITS, MAX_STATE_RESPONSE_BYTES, StateUnavailableError, jsonDepth, levelTwo, providerOrigin, renderType, shippedKeys, wrapperBinding,
} from "../interface/level2.js";
import { clone, fixtureHex, loadFixtureBundle, sha256Hex, verdict, type Bundle } from "./helpers/pi-fixture.js";

/**
 * Project 00024-02 task C5 — [B] Level 2 (spec US1 scenario 4, FR-011; [B] consumer step 4) on the
 * reference-built bundle and its simulated deployed state. Where the reference verifier reached a
 * conclusion on the same inputs (`reference-verdicts.json`), this Level 2 reaches the same one, row
 * for row (audit F4).
 */

const filesOf = (b: Bundle): Map<string, Buffer> => new Map([...b].filter(([p]) => p !== "index.json"));
const rowsOf = (r: { rows: { circuit: string; status: string; reason?: string }[] }) =>
  r.rows.map((x) => ({ circuit: x.circuit, status: x.status, ...(x.reason === undefined ? {} : { reason: x.reason }) }));

function stateWith(keys: Record<string, Buffer>): Buffer {
  const state = new rt.ContractState();
  for (const [name, key] of Object.entries(keys)) {
    const op = new rt.ContractOperation();
    op.verifierKey = new Uint8Array(key);
    state.setOperation(name, op);
  }
  return Buffer.from(state.serialize());
}

describe("[B] Level 2 (C5)", () => {
  it("[[interface-level2]] Level 2: every shipped key byte-equals the same-named installed key; a missing name or key fails; published circuits on chain must ship keys; expectedVk read as text", async () => {
    const bundle = loadFixtureBundle();
    const files = filesOf(bundle);
    const state = fixtureHex("state.hex");
    const key = (name: string): Buffer => bundle.get(`out/keys/${name}.verifier`)!;

    // --- the valid bundle against its deployed state: passed, as the reference concluded --------
    const ok = levelTwo(files, state);
    expect(ok.outcome).toBe("passed");
    expect(ok.reason).toBeUndefined();
    expect(rowsOf(ok)).toEqual(rowsOf(verdict("valid").l2!));
    expect(rowsOf(ok)).toEqual([
      { circuit: "guardedIncrement", status: "OK" }, { circuit: "increment", status: "OK" }, { circuit: "read", status: "OK" },
    ]);
    expect(ok.rows.map((r) => r.keySha256)).toEqual(["guardedIncrement", "increment", "read"].map((n) => sha256Hex(key(n))));
    expect(ok.wrapper).toMatchObject({ ok: true, rows: [{ status: "OK" }, { status: "OK" }, { status: "OK" }] });
    expect(verdict("valid").l2!.wrapperOk).toBe(true);
    expect(ok.entryPoints).toEqual(["guardedIncrement", "increment", "read"]);
    expect(ok.witnesses).toEqual(["emitterSecret"]);
    // The published circuits, each with its argument and result types (US1 scenario 4); read's
    // result type is exact from contract-info's 20-digit maxval (2^64 − 1).
    expect(ok.circuits).toEqual([
      { name: "increment", pure: false, arguments: [], resultType: "[]", keySha256: sha256Hex(key("increment")), onChain: true, l2: "OK" },
      { name: "read", pure: false, arguments: [], resultType: "Uint<64>", keySha256: sha256Hex(key("read")), onChain: true, l2: "OK" },
      { name: "guardedIncrement", pure: false, arguments: [], resultType: "[]", keySha256: sha256Hex(key("guardedIncrement")), onChain: true, l2: "OK" },
    ]);

    // --- another key installed under the name: failed, exactly the reference's row -------------
    const wrong = levelTwo(files, fixtureHex("state-wrong-increment-key.hex"));
    expect(verdict("wrong-installed-key").l2!.ok).toBe(false);
    expect(rowsOf(wrong)).toEqual(rowsOf(verdict("wrong-installed-key").l2!));
    expect(wrong).toMatchObject({ outcome: "failed", reason: "vk increment: shipped key differs from the key on chain" });

    // --- a name the state does not install (missing name / missing key) ------------------------
    const noRead = levelTwo(files, stateWith({ guardedIncrement: key("guardedIncrement"), increment: key("increment") }));
    expect(noRead.outcome).toBe("failed");
    expect(noRead.rows.find((r) => r.circuit === "read")).toMatchObject({ status: "FAIL", reason: "no verifier key on chain for this entry point" });
    // An operation installed without a verifier key is a missing key too.
    const keyless = rt.ContractState.deserialize(Uint8Array.from(state));
    keyless.setOperation("read", new rt.ContractOperation());
    expect(levelTwo(files, Buffer.from(keyless.serialize())).rows.find((r) => r.circuit === "read")?.status).toBe("FAIL");

    // --- a published circuit that is on chain but ships no key: failed ------------------------
    const noKey = new Map(files);
    noKey.delete("out/keys/read.verifier");
    const unshipped = levelTwo(noKey, state);
    expect(unshipped.outcome).toBe("failed");
    expect(unshipped.rows.find((r) => r.circuit === "read")).toMatchObject({ status: "FAIL", reason: expect.stringMatching(/ships no verifier key for it/) });
    // …while a published circuit with no entry point on chain (a pure one, say) is no failure.
    const extraCircuit = clone(bundle);
    const info = JSON.parse(extraCircuit.get("out/compiler/contract-info.json")!.toString("utf8"));
    info.circuits.push({ name: "pureHelper", pure: true, arguments: [{ name: "x", type: { "type-name": "Field" } }], "result-type": { "type-name": "Boolean" } });
    extraCircuit.set("out/compiler/contract-info.json", Buffer.from(JSON.stringify(info)));
    const withPure = levelTwo(filesOf(extraCircuit), state);
    expect(withPure.outcome).toBe("passed");
    expect(withPure.circuits.at(-1)).toMatchObject({ name: "pureHelper", pure: true, arguments: [{ name: "x", type: "Field" }], resultType: "Boolean", keySha256: null, onChain: false, l2: null });

    // --- no key at all; a key that is a directory -----------------------------------------------
    const bare = new Map([...files].filter(([p]) => !p.startsWith("out/keys/")));
    expect(levelTwo(bare, state).rows[0]).toMatchObject({ circuit: "(none)", status: "FAIL" });
    const dir = new Map(files);
    dir.set("out/keys/extra.verifier/inner", Buffer.from("x"));
    expect(shippedKeys(dir).get("extra")).toEqual({ error: "out/keys/extra.verifier is not a regular file" });
    expect(levelTwo(dir, state).rows.find((r) => r.circuit === "extra")).toMatchObject({ status: "FAIL", reason: "out/keys/extra.verifier is not a regular file" });

    // --- contract-info.json: missing, not JSON, hostile nesting — failed, never a crash ---------
    for (const body of [undefined, Buffer.from("{nope"), Buffer.from(`{"circuits": ${"[".repeat(100_000)}${"]".repeat(100_000)}}`), Buffer.from("[]")]) {
      const f = new Map(files);
      if (body === undefined) f.delete("out/compiler/contract-info.json");
      else f.set("out/compiler/contract-info.json", body);
      const r = levelTwo(f, state);
      expect(r.outcome).toBe("failed");
      expect(r.rows.find((x) => x.circuit === "(contract-info)")?.reason).toMatch(/contract-info\.json (is missing or unreadable|is nested deeper than 64 levels)/);
    }
    expect(jsonDepth(JSON.parse("[[[[1]]]]"), 64)).toBe(4);
    // Too many circuits is a local limit: unchecked, not failed.
    const many = new Map(files);
    many.set("out/compiler/contract-info.json", Buffer.from(JSON.stringify({ circuits: Array.from({ length: MAX_CIRCUITS + 1 }, (_v, i) => ({ name: `c${i}` })) })));
    expect(levelTwo(many, state)).toMatchObject({ outcome: "unchecked", reason: expect.stringMatching(/10001 circuits, over the 10000-circuit limit/) });

    // --- the wrapper's expectedVk table, read as text --------------------------------------------
    const js = files.get("out/contract/index.js")!.toString("utf8");
    expect(js).toMatch(/export const expectedVk = \{/);
    const altered = new Map(files);
    altered.set("out/contract/index.js", Buffer.from(js.replace(sha256Hex(key("read")), "0".repeat(64))));
    const bound = levelTwo(altered, state);
    expect(bound.outcome).toBe("failed");
    expect(bound.wrapper.rows.find((r) => r.circuit === "read")).toMatchObject({ status: "FAIL", want: "0".repeat(64), got: sha256Hex(key("read")) });
    expect(bound.reason).toMatch(/wrapper expectedVk: read/);
    const twice = new Map(files);
    twice.set("out/contract/index.js", Buffer.from(`${js}\n// expectedVk\n`));
    expect(wrapperBinding(twice)).toMatchObject({ ok: false, error: expect.stringMatching(/not in the form the compiler emits/) });
    const none = new Map(files);
    none.set("out/contract/index.js", Buffer.from("export const x = 1;\n"));
    expect(wrapperBinding(none)).toMatchObject({ ok: true, skipped: true });
    const missingJs = new Map(files);
    missingJs.delete("out/contract/index.js");
    expect(wrapperBinding(missingJs)).toMatchObject({ ok: false, error: expect.stringMatching(/could not be read/) });

    // --- the provider's state: undecodable is unchecked (the provider's problem) ----------------
    expect(levelTwo(files, Buffer.from("not a state"))).toMatchObject({ outcome: "unchecked", reason: expect.stringMatching(/does not deserialize/) });

    // --- types are rendered depth-bounded, as data ----------------------------------------------
    let deepType: Record<string, unknown> = { "type-name": "Field" };
    for (let i = 0; i < 1000; i++) deepType = { "type-name": "Map", key: deepType, value: { "type-name": "Boolean" } };
    expect(renderType(deepType)).toMatch(/\.\.\./);
    expect(renderType({ "type-name": "Struct", name: "Maybe", elements: [{ name: "is_some", type: {} }, { name: "value", type: { "type-name": "Bytes", length: 32 } }] })).toBe("Maybe<Bytes<32>>");
    expect(renderType({ "type-name": "Uint", maxval: 99 }, (t) => BigInt(t.maxval as number))).toBe("Uint<0..100>");

    // --- the state source: the public indexer's contractAction(address) { state } ----------------
    let answer: unknown = { data: { contractAction: { address: "aa", state: state.toString("hex"), transaction: { hash: "ab".repeat(32), block: { height: 42 } } } } };
    let status = 200;
    let streamed = false;
    const requests: unknown[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += String(c); });
      req.on("end", () => {
        requests.push(JSON.parse(body));
        const text = typeof answer === "string" ? answer : JSON.stringify(answer);
        res.writeHead(status, { "content-type": "application/json" });
        if (!streamed) { res.end(text); return; }
        // No Content-Length: chunked, so the limit must be counted while reading.
        for (let i = 0; i < text.length; i += 500) res.write(text.slice(i, i + 500));
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v4/graphql`;
    try {
      const source = new IndexerStateSource({ url });
      expect(source.description).toBe(`indexer contractAction(address) at http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      // The description is stored in every verification record and served: the provider's ORIGIN only,
      // never a credential its URL may carry (audit 02 E2-F4).
      const keyed = new IndexerStateSource({ url: "https://user:hunter2@provider.example:8443/v3/SECRETKEY/graphql?api_key=SECRETQ#SECRETF" });
      expect(keyed.description).toBe("indexer contractAction(address) at https://provider.example:8443");
      for (const secret of ["hunter2", "user", "SECRETKEY", "SECRETQ", "SECRETF", "graphql"]) expect(keyed.description).not.toContain(secret);
      expect(providerOrigin("not a url")).toBe("an unparseable URL");
      expect(providerOrigin("file:///etc/indexer.sock")).toBe("a file: URL");
      const obs = await source.stateOf("cd".repeat(32));
      expect(obs).toEqual({ state, blockHeight: 42, txHash: "ab".repeat(32) });
      expect(requests[0]).toMatchObject({ variables: { address: "cd".repeat(32) } });
      expect(levelTwo(files, obs.state).outcome).toBe("passed");
      answer = { data: { contractAction: null } };
      await expect(source.stateOf("cd".repeat(32))).rejects.toThrow(StateUnavailableError);
      answer = { errors: [{ message: "boom" }] };
      await expect(source.stateOf("cd".repeat(32))).rejects.toThrow(/GraphQL error: boom/);
      answer = { data: { contractAction: { state: "zz" } } };
      await expect(source.stateOf("cd".repeat(32))).rejects.toThrow(/not hex/);
      answer = "not json";
      await expect(source.stateOf("cd".repeat(32))).rejects.toThrow(/not JSON/);
      status = 503;
      await expect(source.stateOf("cd".repeat(32))).rejects.toThrow(/HTTP 503/);
      // The response is read up to a byte limit, announced or counted (audit 02 E2-F8): beyond it the
      // state is unavailable (Level 2 not run, `unchecked`), never buffered whole.
      status = 200;
      answer = { data: { contractAction: { address: "aa", state: "ab".repeat(4_000), transaction: null } } };
      const capped = new IndexerStateSource({ url, maxResponseBytes: 1_000 });
      await expect(capped.stateOf("cd".repeat(32))).rejects.toThrow(/larger than the 1000-byte limit; Level 2 was not run/);
      streamed = true;
      await expect(capped.stateOf("cd".repeat(32))).rejects.toThrow(/larger than the 1000-byte limit; Level 2 was not run/);
      await expect(capped.stateOf("cd".repeat(32))).rejects.toThrow(StateUnavailableError);
      expect((await new IndexerStateSource({ url, maxResponseBytes: 100_000 }).stateOf("cd".repeat(32))).state.length).toBe(4_000);
      streamed = false;
      expect(MAX_STATE_RESPONSE_BYTES).toBe(64 * 1024 * 1024);
      await expect(new IndexerStateSource({ url: "http://127.0.0.1:1/x", timeoutMs: 2_000 }).stateOf("cd".repeat(32))).rejects.toThrow(/request failed/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});
