import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadLedgerV8 } from "../../../chain-archive-sync/tx-replay-decoder.js";
import type { BlockBundle, TransactionRecord } from "../../../src/interfaces/chain-archive-store.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Builds the SC-001 fixture corpus described by `corpus.manifest.json`, using the vendored
 * ledger v8 WASM the archive itself uses.
 *
 * **Everything here is real ledger output.** The outputs are real `ZswapOutput.new(coin, segment,
 * coinPublicKey, encryptionPublicKey)` values encrypted to real `ZswapSecretKeys.fromSeed` keys,
 * the offers are real `ZswapOffer`s, and the transactions are real `Transaction` values. The
 * predicate under test is the ledger's own `EncryptionSecretKey.test(offer)`. Nothing is
 * hand-rolled or stubbed.
 *
 * **The marker question the plan asked us to settle, settled by measurement.** A transaction
 * straight out of `Transaction.fromParts` serializes with the self-tag
 * `midnight:transaction[v9](signature[v1],proof-preimage,embedded-fr[v1])`, which the archived
 * marker triple `("signature", "proof", "binding")` refuses. Calling `.mockProve()` on it yields
 * `midnight:transaction[v9](signature[v1],proof,pedersen-schnorr[v1])` -- byte-for-byte the same
 * self-tag a real archived on-chain transaction carries, and it round-trips through the archive
 * and back out through `extractOffers` unchanged. So **no fixture-only marker configuration flag
 * was needed, and none was added**: the scanner reads fixture bytes with exactly the markers it
 * reads chain bytes with, and a test that passed by relaxing the codec would not have proven the
 * production path.
 *
 * What `mockProve()` costs in fidelity, stated plainly: the zero-knowledge PROOFS are mock, so
 * these transactions would not verify on a chain. Nothing the relevance predicate reads is a
 * proof -- it trial-decrypts output ciphertexts -- so the predicate's inputs are genuine. The
 * end-to-end fidelity gap (a real proven transfer, produced by a wallet against a real node) is
 * what the live devnet fixture covers.
 *
 * **What could NOT be synthesized in archived form: a real reward-claim transaction.**
 * `Transaction.fromRewards(ClaimRewardsTransaction…)` produces bytes tagged
 * `(signature[v1],proof-preimage,pedersen-schnorr[v1])`; the transaction is already bound, so
 * `mockProve()` refuses it ("cannot prove bound transaction") and there is no path from here to
 * the `proof` marker an archived one would carry. The corpus therefore covers the reward-claim
 * case in two honest halves instead of pretending: (1) `relevance.test.ts` deserializes a real
 * `fromRewards` transaction with the markers its own bytes carry and asserts it holds NO zswap
 * offer at all -- the reason a reward claim can never be relevant; (2) the corpus carries an
 * archivable standard transaction with no offers, which is what the scanner sees for such a
 * transaction and which it must skip.
 */

export interface CorpusManifest {
  net: string;
  ledgerNetworkId: string;
  protocolVersion: number;
  keys: { id: string; seed: number; role: string }[];
  blocks: { height: number; note: string }[];
  transactions: CorpusTransactionSpec[];
}

export interface CorpusTransactionSpec {
  id: string;
  blockHeight: number;
  position: number;
  kind: "regular" | "system";
  shape: "standard" | "contract-owned" | "system-opaque" | "no-offers" | "rich";
  outputs: { section: "guaranteed" | "fallible"; segment: number; to: string; nonce: string }[];
  /** Per key id, the segment ids that must match. `[]` means "must not match". */
  expected: Record<string, number[]>;
  note?: string;
}

export interface BuiltTransaction {
  spec: CorpusTransactionSpec;
  txHash: string;
  rawBytes: Uint8Array;
}

export interface BuiltCorpus {
  manifest: CorpusManifest;
  /** Serialized encryption secret key per manifest key id — the bytes a monitor registers. */
  keyBytes: Map<string, Uint8Array>;
  transactions: BuiltTransaction[];
  /** One `BlockBundle` per manifest block, ready for `putBlockBundle` (Rule A shape). */
  bundles: BlockBundle[];
  /** Per key id, the transaction ids that must match, in `(height, position)` order. */
  expectedMatches: Map<string, CorpusTransactionSpec[]>;
}

const MANIFEST_URL = new URL("./corpus.manifest.json", import.meta.url);

export function readCorpusManifest(): CorpusManifest {
  return JSON.parse(readFileSync(MANIFEST_URL, "utf8")) as CorpusManifest;
}

/** The all-zero token type. Fixtures never need a specific token: the predicate reads the output
 *  CIPHERTEXT, not the coin's denomination. */
const TOKEN_TYPE = "0".repeat(64);

/** A deterministic 32-byte hex nonce from a short manifest tag, so a fixture's coin nonce is
 *  reproducible from the manifest alone. */
function nonceFor(tag: string): string {
  return createHash("sha256").update(`umbradb/shielded-monitor/fixture-nonce/${tag}`).digest("hex");
}

function blockHashFor(height: number): string {
  return createHash("sha256").update(`umbradb/shielded-monitor/fixture-block/${height}`).digest("hex");
}

/**
 * The transaction hash for a fixture whose bytes are NOT a real Midnight transaction — i.e. the
 * `system-opaque` shape, whose payload is a labelled string the standard codec is never handed.
 *
 * Every other shape is keyed on the hash the LEDGER computes from the bytes (see
 * `ledgerTxHash`), because that is what project A actually archives: `sync-service.ts` stores
 * `hexNoPrefix(decoded.transactionHash()).toLowerCase()` and refuses a block whose claimed hash
 * and payload disagree (audit A1). A corpus keyed on a synthetic digest modelled an archive this
 * repository never produces, and 00009-08's page-integrity check — which compares a page's
 * claimed `txHash` against the hash its bytes have — could not be exercised against it.
 */
function syntheticTxHashFor(id: string): string {
  return createHash("sha256").update(`umbradb/shielded-monitor/fixture-tx/${id}`).digest("hex");
}

/** The hash the vendored ledger computes for these bytes, lowercase hex with no `0x` — exactly
 *  what `chain-archive-sync` archives. */
function ledgerTxHash(l: any, rawBytes: Uint8Array): string {
  const tx = l.Transaction.deserialize("signature", "proof", "binding", rawBytes);
  const hash = String(tx.transactionHash());
  return (hash.startsWith("0x") ? hash.slice(2) : hash).toLowerCase();
}

const GENESIS_PARENT_HASH = "0".repeat(64);

/** Builds every transaction and block of the manifest. One ledger load for the whole corpus. */
export async function buildCorpus(manifest: CorpusManifest = readCorpusManifest()): Promise<BuiltCorpus> {
  const ledger: any = await loadLedgerV8();

  const keys = new Map<string, any>();
  const keyBytes = new Map<string, Uint8Array>();
  for (const key of manifest.keys) {
    const seed = new Uint8Array(32).fill(key.seed & 0xff);
    const secrets = ledger.ZswapSecretKeys.fromSeed(seed);
    keys.set(key.id, secrets);
    keyBytes.set(
      key.id,
      Uint8Array.from(secrets.encryptionSecretKey.yesIKnowTheSecurityImplicationsOfThis_serialize()),
    );
  }

  const makeOutput = (to: string, segment: number, nonceTag: string): any => {
    const secrets = keys.get(to);
    if (secrets === undefined) throw new Error(`fixture manifest names an unknown key id: ${to}`);
    const coin = { type: TOKEN_TYPE, nonce: nonceFor(nonceTag), value: 1000n };
    return ledger.ZswapOutput.new(coin, segment, secrets.coinPublicKey, secrets.encryptionPublicKey);
  };
  const offerOf = (output: any): any => ledger.ZswapOffer.fromOutput(output, TOKEN_TYPE, 1000n);

  const transactions: BuiltTransaction[] = [];
  for (const spec of manifest.transactions) {
    const rawBytes = buildOne(ledger, spec);
    transactions.push({
      spec,
      txHash: spec.shape === "system-opaque" ? syntheticTxHashFor(spec.id) : ledgerTxHash(ledger, rawBytes),
      rawBytes,
    });
  }

  function buildOne(l: any, spec: CorpusTransactionSpec): Uint8Array {
    if (spec.shape === "system-opaque") {
      // A system transaction's bytes are never handed to the standard codec (the scanner skips
      // on `kind`), so the corpus stores an opaque, clearly-labelled payload rather than a
      // synthesized system transaction. What is under test is that the scanner does not look.
      return new TextEncoder().encode(`midnight:system-transaction/fixture/${spec.id}`);
    }
    if (spec.shape === "no-offers") {
      return Uint8Array.from(
        l.Transaction.fromParts(manifest.ledgerNetworkId, undefined, undefined, undefined)
          .mockProve().serialize(),
      );
    }
    if (spec.shape === "contract-owned") {
      // A contract address is a raw 32-byte hex value at this API; the coin data goes to the
      // contract, so there is no user-key ciphertext for any `test(offer)` to decrypt.
      const contract = createHash("sha256").update(`umbradb/fixture-contract/${spec.id}`).digest("hex");
      const coin = { type: TOKEN_TYPE, nonce: nonceFor(`${spec.id}/contract`), value: 1000n };
      const offer = offerOf(l.ZswapOutput.newContractOwned(coin, 0, contract));
      return Uint8Array.from(
        l.Transaction.fromParts(manifest.ledgerNetworkId, offer, undefined, undefined)
          .mockProve().serialize(),
      );
    }

    if (spec.shape === "rich") {
      // 00009-07: a transaction that also carries a real spent INPUT and a real TRANSIENT, so the
      // detail extractor has nullifiers and transient coins to read rather than outputs alone.
      //
      // Both are CONTRACT-owned, and that is forced by the ledger, not chosen: building a
      // `ZswapInput` or a `ZswapTransient` from a user-owned output needs the coin secret key and
      // the WASM refuses it outright ("attempted to spend a user-owned output as contract
      // owned"). Two further measured facts are encoded here: an input needs a QUALIFIED coin
      // (`mt_index`), and the chain state must be rehashed with `postBlockUpdate` before the
      // spend, or the ledger answers "attempted to spend from a Merkle tree that was not
      // rehashed".
      const contract = createHash("sha256").update(`umbradb/fixture-contract/${spec.id}`).digest("hex");
      const spent = { type: TOKEN_TYPE, nonce: nonceFor(`${spec.id}/spent`), value: 1000n };
      const [chainState] = new l.ZswapChainState()
        .tryApply(l.ZswapOffer.fromOutput(l.ZswapOutput.newContractOwned(spent, 0, contract), TOKEN_TYPE, 1000n), undefined);
      const input = l.ZswapInput.newContractOwned(
        { ...spent, mt_index: 0n }, 0, contract, chainState.postBlockUpdate(new Date()),
      );
      let offer = l.ZswapOffer.fromInput(input, TOKEN_TYPE, 1000n);
      // The two outputs spend that input between them, so the offer's deltas balance and
      // `mockProve()` accepts it.
      const values = [600n, 400n];
      spec.outputs.forEach((out, index) => {
        const value = values[index] ?? 0n;
        const coin = { type: TOKEN_TYPE, nonce: nonceFor(`${spec.id}/${out.nonce}`), value };
        const secrets = keys.get(out.to);
        if (secrets === undefined) throw new Error(`fixture manifest names an unknown key id: ${out.to}`);
        const output = l.ZswapOutput.new(coin, 0, secrets.coinPublicKey, secrets.encryptionPublicKey);
        offer = offer.merge(l.ZswapOffer.fromOutput(output, TOKEN_TYPE, value));
      });
      const transientCoin = { type: TOKEN_TYPE, nonce: nonceFor(`${spec.id}/transient`), value: 50n };
      const transient = l.ZswapTransient.newFromContractOwnedOutput(
        { ...transientCoin, mt_index: 0n }, 0, l.ZswapOutput.newContractOwned(transientCoin, 0, contract),
      );
      // A transient is created AND spent in the same transaction, so it balances on its own and
      // needs no matching delta.
      offer = offer.merge(l.ZswapOffer.fromTransient(transient));
      return Uint8Array.from(
        l.Transaction.fromParts(manifest.ledgerNetworkId, offer, undefined, undefined)
          .mockProve().serialize(),
      );
    }

    // `shape: "standard"`. Guaranteed outputs are merged into one guaranteed offer; each fallible
    // segment gets its own offer, attached with the ledger's `SegmentSpecifier` so the segment id
    // the manifest names is the segment id the archive will report.
    let guaranteed: any;
    for (const out of spec.outputs.filter((o) => o.section === "guaranteed")) {
      const offer = offerOf(makeOutput(out.to, 0, `${spec.id}/${out.nonce}`));
      guaranteed = guaranteed === undefined ? offer : guaranteed.merge(offer);
    }
    let tx = l.Transaction.fromParts(manifest.ledgerNetworkId, guaranteed, undefined, undefined);
    const bySegment = new Map<number, any>();
    for (const out of spec.outputs.filter((o) => o.section === "fallible")) {
      const offer = offerOf(makeOutput(out.to, out.segment, `${spec.id}/${out.nonce}`));
      const existing = bySegment.get(out.segment);
      bySegment.set(out.segment, existing === undefined ? offer : existing.merge(offer));
    }
    for (const [segment, offer] of [...bySegment.entries()].sort((a, b) => a[0] - b[0])) {
      tx = tx.addZswapOffer({ tag: "specific", value: segment }, offer);
    }
    return Uint8Array.from(tx.mockProve().serialize());
  }

  // ── Blocks ────────────────────────────────────────────────────────────────────────────────
  const bundles: BlockBundle[] = manifest.blocks
    .slice()
    .sort((a, b) => a.height - b.height)
    .map((block) => {
      const blockHash = blockHashFor(block.height);
      const rows: TransactionRecord[] = transactions
        .filter((t) => t.spec.blockHeight === block.height)
        .sort((a, b) => a.spec.position - b.spec.position)
        .map((t) => ({
          net: manifest.net,
          txHash: t.txHash,
          blockHeight: block.height,
          blockHash,
          position: t.spec.position,
          kind: t.spec.kind,
          protocolVersion: manifest.protocolVersion,
          rawBytes: t.rawBytes,
        }));
      return {
        block: {
          net: manifest.net,
          blockHash,
          height: block.height,
          parentHash: block.height === 0 ? GENESIS_PARENT_HASH : blockHashFor(block.height - 1),
          stateRoot: createHash("sha256").update(`state/${block.height}`).digest("hex"),
          extrinsicsRoot: createHash("sha256").update(`extrinsics/${block.height}`).digest("hex"),
          headerBytes: new TextEncoder().encode(`fixture-header/${block.height}`),
          bodyBytes: new TextEncoder().encode(`fixture-body/${block.height}`),
          isCanonical: true,
          status: "canonical" as const,
          finalized: true,
          timestampMs: 1_754_395_200_000 + block.height * 6_000,
        },
        transactions: rows,
        bridgeObservations: [],
        // Rule A shape: the watermark advances inside the same transaction as the height.
        watermark: { key: `sync_cursor:${manifest.net}`, value: { height: block.height } },
        notifyChannel: "chain_archive_progress",
      } satisfies BlockBundle;
    });

  const expectedMatches = new Map<string, CorpusTransactionSpec[]>();
  for (const key of manifest.keys) {
    expectedMatches.set(
      key.id,
      manifest.transactions
        .filter((t) => (t.expected[key.id] ?? []).length > 0)
        .sort((a, b) => (a.blockHeight === b.blockHeight ? a.position - b.position : a.blockHeight - b.blockHeight)),
    );
  }

  return { manifest, keyBytes, transactions, bundles, expectedMatches };
}
