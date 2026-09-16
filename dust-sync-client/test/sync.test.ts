/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DustSyncError } from "../src/errors.js";
import { syncDust } from "../src/sync.js";
import { FakeChain, FakeDustNode, loadLedger, makeWallet, type FakeWallet } from "./fake-node.js";

/**
 * `syncDust` against a chain built with the real ledger WASM
 * (`spec/00016-dust-wallet-sync.md` Story 4, §5.5, FR-030).
 *
 * Every case here is one of the spec's own: the Story 4 acceptance scenarios, the edge cases of
 * §2, and the two refusals FR-030 requires. What makes them worth running is that the fixture is a
 * real `DustLocalState` (see `fake-node.ts`) — the root comparisons are the same arithmetic the
 * devnet run makes, at a scale that fits in a unit test.
 */

const NET = "undeployed";

let ledger: any;
let params: any;

beforeAll(async () => {
  ledger = await loadLedger();
  params = ledger.LedgerParameters.initialParameters().dust;
}, 120_000);

/** A chain with `foreign` other-wallet UTxOs, then `own` for the wallet, then `spends` fee spends
 *  of the wallet's first UTxO, with a foreign leaf interleaved between each. */
function buildChain(options: {
  wallet: FakeWallet;
  stranger: FakeWallet;
  foreignBefore: number;
  own: number;
  spends: number;
  foreignAfter?: number;
}): FakeChain {
  const chain = new FakeChain(ledger, params);
  for (let i = 0; i < options.foreignBefore; i += 1) chain.addInitialUtxo(options.stranger, 5_000_000n);
  for (let i = 0; i < options.own; i += 1) chain.addInitialUtxo(options.wallet, 7_000_000n + BigInt(i));
  const first = chain.initial.find((row) => row.qdo.owner === options.wallet.publicKey);
  for (let i = 0; i < options.spends; i += 1) {
    if (i % 2 === 1) chain.addInitialUtxo(options.stranger, 1_000_000n);
    chain.addSpend(options.wallet, first?.qdo.backingNight ?? "", 100n + BigInt(i), 1_757_100_000 + i * 60);
  }
  for (let i = 0; i < (options.foreignAfter ?? 0); i += 1) chain.addInitialUtxo(options.stranger, 2_000_000n);
  return chain;
}

describe("syncDust rebuilds a wallet's DUST state from the node's public routes", () => {
  it("follows a 5-spend chain in 6 rounds and ends on the last spend's commitment", async () => {
    const wallet = makeWallet(ledger);
    const stranger = makeWallet(ledger);
    const chain = buildChain({ wallet, stranger, foreignBefore: 3, own: 3, spends: 5, foreignAfter: 2 });
    const node = new FakeDustNode(chain, { net: NET });
    try {
      const result = await syncDust({
        ledger,
        secretKey: wallet.sk,
        baseUrl: "http://node.invalid",
        net: NET,
        fetchImpl: node.fetchImpl,
      });
      try {
        // Story 4 scenario 1: one round per generation of the chain, plus the round that finds
        // the last successor unspent. Three own UTxOs are asked about together in round 1.
        expect(result.timing.rounds).toBe(6);
        expect(result.stats.spendsFollowed).toBe(5);
        expect(result.stats.initialUtxos).toBe(3);
        expect(result.stats.liveUtxos).toBe(3);
        expect(result.stats.restarts).toBe(0);

        // The live UTxO of the spent chain is the LAST spend's commitment index.
        const lastSpend = chain.spends[chain.spends.length - 1];
        const live = [...result.state.utxos].map((utxo) => utxo.mtIndex.toString(10));
        expect(live).toContain(lastSpend?.commitmentIndex.toString(10));

        // The roots are the chain's own, at the tip the state was proved against.
        expect(result.roots.commitment).toBe(String(chain.state.commitmentTreeRoot()));
        expect(result.roots.generation).toBe(String(chain.state.generatingTreeRoot()));
        expect(result.provedAt.atEventId).toBe(chain.tableTipEventId.toString(10));

        // And the wallet's own balance agrees with the chain oracle's for the same instant.
        const at = new Date(1_757_200_000 * 1000);
        const walletTips = chain.initial
          .filter((row) => row.qdo.owner === wallet.publicKey)
          .map((row) => chain.tipOf(row.qdo.backingNight));
        let oracle = 0n;
        for (const tip of walletTips) {
          oracle += ledger.updatedValue(
            tip.ctime,
            tip.initialValue,
            chain.initial.find((row) => row.generation.nonce === tip.backingNight)?.generation,
            at,
            params,
          ) as bigint;
        }
        expect(result.state.walletBalance(at)).toBe(oracle);
      } finally {
        result.state.free();
      }
    } finally {
      chain.free();
    }
  }, 180_000);

  it("a wallet with no DUST rows gets an empty state, correct roots and no lookups", async () => {
    const wallet = makeWallet(ledger);
    const stranger = makeWallet(ledger);
    const chain = buildChain({ wallet, stranger, foreignBefore: 4, own: 0, spends: 0 });
    const node = new FakeDustNode(chain, { net: NET });
    try {
      const result = await syncDust({
        ledger,
        secretKey: wallet.sk,
        baseUrl: "http://node.invalid",
        net: NET,
        fetchImpl: node.fetchImpl,
      });
      try {
        expect(node.calls.lookup).toBe(0);
        expect(result.timing.rounds).toBe(0);
        expect(result.stats.liveUtxos).toBe(0);
        expect(result.state.utxos).toHaveLength(0);
        expect(result.roots.commitment).toBe(String(chain.state.commitmentTreeRoot()));
        expect(result.roots.generation).toBe(String(chain.state.generatingTreeRoot()));
        expect(result.state.walletBalance(new Date())).toBe(0n);
      } finally {
        result.state.free();
      }
    } finally {
      chain.free();
    }
  }, 120_000);

  it("an empty chain (firstFree 0, devnet at genesis) is a state with null roots", async () => {
    const wallet = makeWallet(ledger);
    const chain = new FakeChain(ledger, params);
    const node = new FakeDustNode(chain, { net: NET });
    try {
      const result = await syncDust({
        ledger,
        secretKey: wallet.sk,
        baseUrl: "http://node.invalid",
        net: NET,
        fetchImpl: node.fetchImpl,
      });
      try {
        expect(result.roots).toStrictEqual({ commitment: null, generation: null });
        expect(node.calls.segments).toBe(0);
        expect(node.calls.lookup).toBe(0);
      } finally {
        result.state.free();
      }
    } finally {
      chain.free();
    }
  }, 120_000);

  it("adjacent own leaves need no segment between them", async () => {
    const wallet = makeWallet(ledger);
    const stranger = makeWallet(ledger);
    const chain = new FakeChain(ledger, params);
    chain.addInitialUtxo(stranger, 1n);
    chain.addInitialUtxo(wallet, 2n);
    chain.addInitialUtxo(wallet, 3n); // adjacent to the previous one, in both trees
    chain.addInitialUtxo(stranger, 4n);
    const node = new FakeDustNode(chain, { net: NET });
    try {
      const result = await syncDust({
        ledger,
        secretKey: wallet.sk,
        baseUrl: "http://node.invalid",
        net: NET,
        fetchImpl: node.fetchImpl,
      });
      try {
        // [0-0] before the pair and [3-3] after it: two ranges, not three.
        expect(result.stats.segmentsC).toBe(2);
        expect(result.stats.segmentsG).toBe(2);
        expect(result.roots.commitment).toBe(String(chain.state.commitmentTreeRoot()));
      } finally {
        result.state.free();
      }
    } finally {
      chain.free();
    }
  }, 120_000);

  it("an own leaf that is the tree's last leaf gets no trailing segment", async () => {
    const wallet = makeWallet(ledger);
    const stranger = makeWallet(ledger);
    const chain = new FakeChain(ledger, params);
    chain.addInitialUtxo(stranger, 1n);
    chain.addInitialUtxo(wallet, 2n);
    const node = new FakeDustNode(chain, { net: NET });
    try {
      const result = await syncDust({
        ledger,
        secretKey: wallet.sk,
        baseUrl: "http://node.invalid",
        net: NET,
        fetchImpl: node.fetchImpl,
      });
      try {
        expect(result.stats.segmentsC).toBe(1);
        expect(result.roots.commitment).toBe(String(chain.state.commitmentTreeRoot()));
      } finally {
        result.state.free();
      }
    } finally {
      chain.free();
    }
  }, 120_000);

  it("two spends of one wallet in one block still need two rounds", async () => {
    const wallet = makeWallet(ledger);
    const stranger = makeWallet(ledger);
    const chain = new FakeChain(ledger, params);
    chain.addInitialUtxo(stranger, 1_000_000n);
    const own = chain.addInitialUtxo(wallet, 9_000_000n);
    // Same declared time: one block, two spends of the same chain.
    chain.addSpend(wallet, own.qdo.backingNight, 100n, 1_757_100_000);
    chain.addSpend(wallet, own.qdo.backingNight, 100n, 1_757_100_000);
    const node = new FakeDustNode(chain, { net: NET });
    try {
      const result = await syncDust({
        ledger,
        secretKey: wallet.sk,
        baseUrl: "http://node.invalid",
        net: NET,
        fetchImpl: node.fetchImpl,
      });
      try {
        // The second nullifier cannot be computed before the first spend row is known.
        expect(result.timing.rounds).toBe(3);
        expect(result.stats.spendsFollowed).toBe(2);
        expect(result.roots.commitment).toBe(String(chain.state.commitmentTreeRoot()));
      } finally {
        result.state.free();
      }
    } finally {
      chain.free();
    }
  }, 120_000);
});

describe("syncDust refuses rather than returning a state it cannot prove", () => {
  it("throws DUST_SYNC_ROOT_MISMATCH on a wrong commitment segment", async () => {
    const wallet = makeWallet(ledger);
    const stranger = makeWallet(ledger);
    const chain = buildChain({ wallet, stranger, foreignBefore: 3, own: 1, spends: 1, foreignAfter: 2 });
    const node = new FakeDustNode(chain, { net: NET, corruptSegment: { tree: "commitment", index: 0 } });
    try {
      await expect(
        syncDust({
          ledger,
          secretKey: wallet.sk,
          baseUrl: "http://node.invalid",
          net: NET,
          fetchImpl: node.fetchImpl,
        }),
      ).rejects.toMatchObject({ code: "DUST_SYNC_ROOT_MISMATCH" });
    } finally {
      chain.free();
    }
  }, 120_000);

  it("throws DUST_SYNC_ROOT_MISMATCH on a wrong generation segment", async () => {
    const wallet = makeWallet(ledger);
    const stranger = makeWallet(ledger);
    const chain = buildChain({ wallet, stranger, foreignBefore: 3, own: 1, spends: 0, foreignAfter: 2 });
    const node = new FakeDustNode(chain, { net: NET, corruptSegment: { tree: "generation", index: 0 } });
    try {
      await expect(
        syncDust({
          ledger,
          secretKey: wallet.sk,
          baseUrl: "http://node.invalid",
          net: NET,
          fetchImpl: node.fetchImpl,
        }),
      ).rejects.toMatchObject({ code: "DUST_SYNC_ROOT_MISMATCH" });
    } finally {
      chain.free();
    }
  }, 120_000);

  it("waits when the mirror is behind a row the table already returned, then proceeds", async () => {
    const wallet = makeWallet(ledger);
    const stranger = makeWallet(ledger);
    const chain = buildChain({ wallet, stranger, foreignBefore: 2, own: 1, spends: 2, foreignAfter: 1 });
    const node = new FakeDustNode(chain, { net: NET });
    // The mirror sits one event behind the LAST SPEND the table returned: exactly Story 3
    // scenario 1 — the row is answerable, its commitment is not yet in the trees.
    const lastSpend = chain.spends[chain.spends.length - 1];
    node.holdMirrorAt = (lastSpend?.eventId ?? 1n) - 1n;
    let slept = 0;
    try {
      const result = await syncDust({
        ledger,
        secretKey: wallet.sk,
        baseUrl: "http://node.invalid",
        net: NET,
        fetchImpl: node.fetchImpl,
        sleep: async () => {
          slept += 1;
          // The mirror catches up while the client waits.
          if (slept === 2) node.holdMirrorAt = undefined;
          await Promise.resolve();
        },
      });
      try {
        expect(slept).toBeGreaterThan(0);
        expect(result.roots.commitment).toBe(String(chain.state.commitmentTreeRoot()));
      } finally {
        result.state.free();
      }
    } finally {
      chain.free();
    }
  }, 120_000);

  it("throws DUST_SYNC_INDEX_LAG when the mirror never catches up", async () => {
    const wallet = makeWallet(ledger);
    const stranger = makeWallet(ledger);
    const chain = buildChain({ wallet, stranger, foreignBefore: 2, own: 1, spends: 2 });
    const node = new FakeDustNode(chain, { net: NET });
    const lastSpend = chain.spends[chain.spends.length - 1];
    node.holdMirrorAt = (lastSpend?.eventId ?? 1n) - 1n;
    try {
      await expect(
        syncDust({
          ledger,
          secretKey: wallet.sk,
          baseUrl: "http://node.invalid",
          net: NET,
          fetchImpl: node.fetchImpl,
          // A 1 ms budget with a no-op sleep: the wait loop runs, the deadline passes, and the
          // client reports the lag rather than hanging or inserting past the tree's end.
          maxLagMs: 1,
          sleep: async () => {
            await Promise.resolve();
          },
        }),
      ).rejects.toMatchObject({ code: "DUST_SYNC_INDEX_LAG" });
    } finally {
      chain.free();
    }
  }, 120_000);

  it("reports the node's error code when a route refuses", async () => {
    const wallet = makeWallet(ledger);
    const chain = new FakeChain(ledger, params);
    chain.addInitialUtxo(wallet, 1n);
    const node = new FakeDustNode(chain, { net: NET });
    const refusing: typeof fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/tip")) {
        return new Response(JSON.stringify({ error: { code: "DUST_NOT_READY", message: "replaying" } }), {
          status: 503,
        });
      }
      return await node.fetchImpl(input as any, init);
    }) as unknown as typeof fetch;
    try {
      await expect(
        syncDust({ ledger, secretKey: wallet.sk, baseUrl: "http://node.invalid", net: NET, fetchImpl: refusing }),
      ).rejects.toMatchObject({ code: "DUST_SYNC_HTTP", detail: { code: "DUST_NOT_READY" } });
    } finally {
      chain.free();
    }
  }, 120_000);

  it("refuses a base URL that is not http(s)", async () => {
    const wallet = makeWallet(ledger);
    await expect(
      syncDust({ ledger, secretKey: wallet.sk, baseUrl: "node.invalid", net: NET }),
    ).rejects.toBeInstanceOf(DustSyncError);
  });
});

afterAll(() => {
  params?.free?.();
});
