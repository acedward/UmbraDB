/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from "vitest";
import { sdkWrapper } from "../src/wrapper.js";
import { loadLedger } from "./fake-node.js";

/**
 * The SDK hand-off wrapper (`spec/00016-dust-wallet-sync.md` §5.6, FR-032).
 *
 * What is checked here is the ENCODING — the shape
 * `@midnightntwrk/wallet-sdk-dust-wallet/dist/v1/Serialization.js` decodes, where every bigint is a
 * decimal string (`Schema.BigInt`) and the state is hex (`Schema.Uint8ArrayFromHex`). That the SDK
 * itself accepts it, and that the `appliedIndex` lands where `Sync.js` reads it, is proved against
 * the real SDK by `devnet/sdk/restore-smoke.ts` in the devnet run — a unit test cannot do that
 * without the wallet SDK, which this repository deliberately does not depend on.
 */

let ledger: any;

beforeAll(async () => {
  ledger = await loadLedger();
}, 120_000);

describe("the SDK wrapper", () => {
  it("encodes every bigint as a decimal string and the state as hex", () => {
    const state = new ledger.DustLocalState(ledger.LedgerParameters.initialParameters().dust);
    try {
      const wrapper = sdkWrapper(state, {
        publicKey: 1093n,
        networkId: "undeployed",
        protocolVersion: 0n,
        appliedIndex: 221n,
      });
      expect(wrapper.publicKey).toStrictEqual({ publicKey: "1093" });
      expect(wrapper.protocolVersion).toBe("0");
      expect(wrapper.offset).toBe("221");
      expect(wrapper.networkId).toBe("undeployed");
      expect(wrapper.state).toMatch(/^[0-9a-f]+$/);
      // The state round-trips through the ledger, which is what `Serialization.js` does with it.
      const restored = ledger.DustLocalState.deserialize(new Uint8Array(Buffer.from(wrapper.state, "hex")));
      expect(String(restored.commitmentTreeRoot())).toBe(String(state.commitmentTreeRoot()));
      restored.free();
    } finally {
      state.free();
    }
  }, 120_000);

  it("defaults the offset to 0 — replay history rather than risk skipping events", () => {
    const state = new ledger.DustLocalState(ledger.LedgerParameters.initialParameters().dust);
    try {
      // `Sync.js` resubscribes from `appliedIndex − 1` and drops updates at or below
      // `appliedIndex`. Too low replays (slow, correct); too high SKIPS (a silently wrong
      // balance). Our own event ids are NOT the indexer's — measured on the devnet: 211 of our
      // events matched the indexer's stream by content, its ids ran 1…241 with gaps, and the
      // difference was 29 in some places and 30 in others. So the default must be the safe one.
      expect(sdkWrapper(state, { publicKey: 1n, networkId: "preprod", protocolVersion: 0n }).offset).toBe("0");
    } finally {
      state.free();
    }
  }, 120_000);
});
