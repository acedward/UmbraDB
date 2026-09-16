/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from "vitest";
import { syncDust } from "../src/sync.js";
import { FakeChain, FakeDustNode, loadLedger, makeWallet, type FakeWallet } from "./fake-node.js";

/**
 * What `syncDust` does when the node answers something it must not trust
 * (`spec/00016-dust-wallet-sync.md` §5.5 steps 7–9, FR-030).
 *
 * Each case wraps the honest fake node in a `fetch` that rewrites ONE thing, which is the only way
 * to reach these branches deterministically: a real mirror advances when it advances. The rewrites
 * are the situations the algorithm is written for — the mirror moving between the tip read and the
 * cuts, two requests of one phase landing on different tips, a new own row arriving mid-build, a
 * live UTxO being spent mid-build — plus the ones that would be a NODE BUG and must still not be
 * allowed to corrupt a wallet: segments out of order, a short segment list, a lookup answered in a
 * different order.
 */

const NET = "undeployed";
let ledger: any;
let params: any;

beforeAll(async () => {
  ledger = await loadLedger();
  params = ledger.LedgerParameters.initialParameters().dust;
}, 120_000);

function smallChain(wallet: FakeWallet, stranger: FakeWallet, spends = 1): FakeChain {
  const chain = new FakeChain(ledger, params);
  chain.addInitialUtxo(stranger, 1_000_000n);
  const own = chain.addInitialUtxo(wallet, 9_000_000n);
  chain.addInitialUtxo(stranger, 2_000_000n);
  for (let i = 0; i < spends; i += 1) {
    chain.addSpend(wallet, own.qdo.backingNight, 100n, 1_757_100_000 + i * 60);
  }
  chain.addInitialUtxo(stranger, 3_000_000n);
  return chain;
}

/** Wraps the node's `fetch`, letting a test rewrite one response body. */
function rewriting(
  node: FakeDustNode,
  rewrite: (route: string, body: any, callNumber: number) => any,
): typeof fetch {
  const counts = new Map<string, number>();
  return (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const route = url.pathname.replace(/^\/v1\/dust\//, "");
    const response = await node.fetchImpl(input as any, init);
    const body = await response.json();
    const count = (counts.get(route) ?? 0) + 1;
    counts.set(route, count);
    const rewritten = rewrite(route, body, count);
    return new Response(JSON.stringify(rewritten ?? body), { status: response.status });
  }) as unknown as typeof fetch;
}

async function run(chain: FakeChain, wallet: FakeWallet, fetchImpl: typeof fetch, options: any = {}) {
  return await syncDust({
    ledger,
    secretKey: wallet.sk,
    baseUrl: "http://node.invalid",
    net: NET,
    fetchImpl,
    sleep: async () => {
      await Promise.resolve();
    },
    ...options,
  });
}

describe("the chain moving under the client", () => {
  it("re-fetches when the segments response reports a firstFree the tip did not (§5.5 step 7)", async () => {
    const wallet = makeWallet(ledger);
    const chain = smallChain(wallet, makeWallet(ledger));
    const node = new FakeDustNode(chain, { net: NET });
    let rewrites = 0;
    // The FIRST commitment-segments answer claims the tree grew under the request. Nothing has
    // been applied at that point, so the client must simply ask again — and the second answer is
    // the honest one. (Counting per route would count the generation request too, which is the
    // one that comes first.)
    const fetchImpl = rewriting(node, (route, body) => {
      if (route === "segments" && body.tree === "commitment" && rewrites === 0) {
        rewrites += 1;
        return { ...body, firstFree: String(BigInt(body.firstFree) + 5n) };
      }
      return body;
    });
    try {
      const result = await run(chain, wallet, fetchImpl);
      try {
        expect(rewrites).toBe(1);
        expect(result.roots.commitment).toBe(String(chain.state.commitmentTreeRoot()));
      } finally {
        result.state.free();
      }
    } finally {
      chain.free();
    }
  }, 120_000);

  it("gives up with DUST_SYNC_RESTART_LIMIT when it never stops moving", async () => {
    const wallet = makeWallet(ledger);
    const chain = smallChain(wallet, makeWallet(ledger));
    const node = new FakeDustNode(chain, { net: NET });
    const fetchImpl = rewriting(node, (route, body) =>
      route === "segments" && body.tree === "commitment"
        ? { ...body, firstFree: String(BigInt(body.firstFree) + 5n) }
        : body,
    );
    try {
      await expect(run(chain, wallet, fetchImpl)).rejects.toMatchObject({ code: "DUST_SYNC_RESTART_LIMIT" });
    } finally {
      chain.free();
    }
  }, 120_000);

  it("restarts from step 2 when a new initial UTxO arrives for this wallet mid-build (§5.5 step 8)", async () => {
    const wallet = makeWallet(ledger);
    const chain = smallChain(wallet, makeWallet(ledger));
    const node = new FakeDustNode(chain, { net: NET });
    let injected = 0;
    // `converge` asks "is there anything after the last row I saw?" — answer yes, once.
    const fetchImpl = rewriting(node, (route, body, count) => {
      if (route === "initial-utxos" && body.items.length === 0 && injected === 0 && count > 1) {
        injected += 1;
        return { ...body, items: [{ eventId: "999999", height: "1", txHash: "ab", output: {}, generation: {} }] };
      }
      return body;
    });
    try {
      const result = await run(chain, wallet, fetchImpl);
      try {
        expect(injected).toBe(1);
        expect(result.stats.restarts).toBe(1);
        expect(result.roots.commitment).toBe(String(chain.state.commitmentTreeRoot()));
      } finally {
        result.state.free();
      }
    } finally {
      chain.free();
    }
  }, 120_000);

  it("restarts when a live UTxO turns out to have been spent (§5.5 step 9)", async () => {
    const wallet = makeWallet(ledger);
    const stranger = makeWallet(ledger);
    const chain = smallChain(wallet, stranger, 1);
    const node = new FakeDustNode(chain, { net: NET });
    let addedSpend = false;
    const answeredUnspent = new Set<string>();
    // Step 9's CONFIRMING lookup is the one that asks about a nullifier this run has already been
    // told is unspent. Answer that one by adding a spend for it first — exactly as if the wallet
    // had paid a fee while the state was being built. Injecting at the first unknown nullifier
    // instead would land inside step 5, which the chain-following loop absorbs without a restart.
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/lookup")) {
        const asked: string[] = JSON.parse(String(init?.body ?? "{}")).nullifiers ?? [];
        if (!addedSpend && asked.some((nullifier) => answeredUnspent.has(nullifier))) {
          addedSpend = true;
          const own = chain.initial.find((row) => row.qdo.owner === wallet.publicKey);
          chain.addSpend(wallet, own?.qdo.backingNight ?? "", 120n, 1_757_200_000);
        }
        const response = await node.fetchImpl(input as any, init);
        const body = await response.json();
        for (const result of body.results ?? []) {
          if (result.spend === null) answeredUnspent.add(result.nullifier);
        }
        return new Response(JSON.stringify(body), { status: response.status });
      }
      return await node.fetchImpl(input as any, init);
    }) as unknown as typeof fetch;
    try {
      const result = await run(chain, wallet, fetchImpl);
      try {
        expect(addedSpend).toBe(true);
        expect(result.stats.restarts).toBeGreaterThanOrEqual(1);
        expect(result.stats.spendsFollowed).toBeGreaterThanOrEqual(2);
        expect(result.roots.commitment).toBe(String(chain.state.commitmentTreeRoot()));
      } finally {
        result.state.free();
      }
    } finally {
      chain.free();
    }
  }, 120_000);
});

describe("a node that answers wrongly is refused, not trusted", () => {
  it("refuses segments that come back in a different order than requested", async () => {
    const wallet = makeWallet(ledger);
    const chain = smallChain(wallet, makeWallet(ledger));
    const node = new FakeDustNode(chain, { net: NET });
    const fetchImpl = rewriting(node, (route, body) =>
      route === "segments" && body.segments.length > 1
        ? { ...body, segments: [...body.segments].reverse() }
        : body,
    );
    try {
      await expect(run(chain, wallet, fetchImpl)).rejects.toMatchObject({ code: "DUST_SYNC_HTTP" });
    } finally {
      chain.free();
    }
  }, 120_000);

  it("refuses a segments answer that is short of the ranges asked for", async () => {
    const wallet = makeWallet(ledger);
    const chain = smallChain(wallet, makeWallet(ledger));
    const node = new FakeDustNode(chain, { net: NET });
    const fetchImpl = rewriting(node, (route, body) =>
      route === "segments" && body.segments.length > 1 ? { ...body, segments: body.segments.slice(1) } : body,
    );
    try {
      await expect(run(chain, wallet, fetchImpl)).rejects.toMatchObject({ code: "DUST_SYNC_HTTP" });
    } finally {
      chain.free();
    }
  }, 120_000);

  it("refuses a lookup answered out of request order, or with the wrong number of results", async () => {
    const wallet = makeWallet(ledger);
    const chain = smallChain(wallet, makeWallet(ledger));
    const node = new FakeDustNode(chain, { net: NET });
    const swapped = rewriting(node, (route, body) =>
      route === "lookup" ? { ...body, results: body.results.map((r: any) => ({ ...r, nullifier: "7" })) } : body,
    );
    try {
      await expect(run(chain, wallet, swapped)).rejects.toMatchObject({ code: "DUST_SYNC_HTTP" });
      const short = rewriting(node, (route, body) => (route === "lookup" ? { ...body, results: [] } : body));
      await expect(run(chain, wallet, short)).rejects.toMatchObject({ code: "DUST_SYNC_HTTP" });
    } finally {
      chain.free();
    }
  }, 120_000);

  it("refuses a tip whose numbers are not decimal", async () => {
    const wallet = makeWallet(ledger);
    const chain = smallChain(wallet, makeWallet(ledger));
    const node = new FakeDustNode(chain, { net: NET });
    const fetchImpl = rewriting(node, (route, body) =>
      route === "tip" ? { ...body, params: { ...body.params, nightDustRatio: "0x10" } } : body,
    );
    try {
      await expect(run(chain, wallet, fetchImpl)).rejects.toMatchObject({ code: "DUST_SYNC_HTTP" });
    } finally {
      chain.free();
    }
  }, 120_000);
});

describe("paging and pruning", () => {
  it("pages initial-utxos and generation until the cursor runs out", async () => {
    const wallet = makeWallet(ledger);
    const stranger = makeWallet(ledger);
    const chain = new FakeChain(ledger, params);
    chain.addInitialUtxo(stranger, 1n);
    for (let i = 0; i < 3; i += 1) chain.addInitialUtxo(wallet, 5_000_000n + BigInt(i));
    chain.addInitialUtxo(stranger, 2n);
    const node = new FakeDustNode(chain, { net: NET });
    try {
      const result = await run(chain, wallet, node.fetchImpl, { pageLimit: 1 });
      try {
        // 3 rows at one per page, plus the empty page that ends each cursor, plus `converge`'s
        // one-row probe.
        expect(node.calls["initial-utxos"]).toBeGreaterThanOrEqual(5);
        expect(node.calls.generation).toBeGreaterThanOrEqual(4);
        expect(result.stats.initialUtxos).toBe(3);
        expect(result.roots.commitment).toBe(String(chain.state.commitmentTreeRoot()));
      } finally {
        result.state.free();
      }
    } finally {
      chain.free();
    }
  }, 120_000);

  it("processTtlsAt keeps a UTxO that is still worth something, and touches no root", async () => {
    const wallet = makeWallet(ledger);
    const chain = smallChain(wallet, makeWallet(ledger), 0);
    const node = new FakeDustNode(chain, { net: NET });
    try {
      const result = await run(chain, wallet, node.fetchImpl, {
        processTtlsAt: new Date(1_757_200_000 * 1000),
      });
      try {
        expect(result.state.utxos).toHaveLength(1);
        expect(result.roots.commitment).toBe(String(chain.state.commitmentTreeRoot()));
        expect(result.roots.generation).toBe(String(chain.state.generatingTreeRoot()));
      } finally {
        result.state.free();
      }
    } finally {
      chain.free();
    }
  }, 120_000);
});
