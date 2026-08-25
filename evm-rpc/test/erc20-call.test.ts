import { describe, expect, it } from "vitest";
import type { SqlLike } from "../logs/address-map.js";
import { registerErc20Call, type TokenMeta } from "../methods/erc20-call.js";
import { JSON_RPC_ERRORS, MethodRegistry } from "../registry.js";
import { context } from "./helpers.js";

const TOKEN: TokenMeta = { evmAddr: "ee".repeat(20), name: "Midnight EVM Token", symbol: "MEVM", decimals: 0 };

/**
 * `eth_call`'s parameter handling and the constant-answer selectors are decided BEFORE any query,
 * so a stub that fails loudly is the right double: if a case below ever reaches the database, that
 * is the bug, not a missing fixture.
 */
const noSql = (() => { throw new Error("eth_call must not query for this case"); }) as unknown as SqlLike;

function methods(): MethodRegistry {
  const registry = new MethodRegistry();
  registerErc20Call({ registry, sql: noSql, schema: "evm_rpc", tokens: [TOKEN] });
  return registry;
}

describe("eth_call ERC20 views", () => {
  describe("arity guard (plan 00006 K3)", () => {
    it.each([
      ["no params", []],
      ["three params", [{ to: `0x${TOKEN.evmAddr}`, data: "0x313ce567" }, "latest", "extra"]],
    ])("rejects %s with -32602 instead of answering 0x", async (_name, params) => {
      await expect(methods().getMethod("eth_call")!(params, context()))
        .rejects.toMatchObject({ code: JSON_RPC_ERRORS.INVALID_PARAMS });
    });

    it.each([
      ["a by-name params object", { to: `0x${TOKEN.evmAddr}`, data: "0x313ce567" }],
      ["a params string", "0x313ce567"],
    ])("rejects %s — positional parameters only", async (_name, params) => {
      await expect(methods().getMethod("eth_call")!(params, context()))
        .rejects.toMatchObject({ code: JSON_RPC_ERRORS.INVALID_PARAMS });
    });

    it("still accepts the one- and two-parameter forms", async () => {
      const call = { to: `0x${TOKEN.evmAddr}`, data: "0x313ce567" };
      const decimals = `0x${"0".repeat(64)}`;
      await expect(methods().getMethod("eth_call")!([call], context())).resolves.toBe(decimals);
      await expect(methods().getMethod("eth_call")!([call, "latest"], context())).resolves.toBe(decimals);
    });
  });

  it("still answers 0x for a well-formed call this surface cannot execute", async () => {
    // The distinction the guard restores: a MALFORMED request is an error, an unexecutable one is
    // an empty return — the same thing an EVM node says for a call into nothing.
    const cases = [
      { to: `0x${TOKEN.evmAddr}`, data: "0xdeadbeef" }, // unknown selector
      { to: `0x${TOKEN.evmAddr}`, data: "0x31" }, // calldata shorter than a selector
      { to: `0x${"11".repeat(20)}`, data: "0x313ce567" }, // contract that is not watched
      {}, // neither `to` nor `data`
    ];
    for (const call of cases) {
      await expect(methods().getMethod("eth_call")!([call], context())).resolves.toBe("0x");
    }
  });

  it("answers the constant metadata selectors from the watch entry", async () => {
    const call = (data: string): unknown[] => [{ to: `0x${TOKEN.evmAddr}`, data }];
    const symbol = await methods().getMethod("eth_call")!(call("0x95d89b41"), context()) as string;
    expect(Buffer.from(symbol.slice(2 + 128, 2 + 128 + 8), "hex").toString("utf8")).toBe("MEVM");
    await expect(methods().getMethod("eth_call")!(call("0x313ce567"), context())).resolves.toBe(`0x${"0".repeat(64)}`);
  });
});
