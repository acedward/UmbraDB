import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * Semantic replay-decoder for ARCHIVED raw Midnight transaction bytes -- the AC-4
 * (`openspec/changes/full-chain-storage-acceptance-criteria/specs/full-chain-archive-
 * verification/spec.md`, replay-recoverability hard gate) reconstruction capability: given
 * exactly the bytes the archive already stores as `tx_raw` blobs (`chain_blobs`, written by
 * `sync-service.ts` from the indexer's `Transaction.raw`, which is the inner
 * `pallet_midnight::send_mn_transaction` payload), reconstruct the deferred data categories --
 * zswap outputs/inputs, unshielded UTXO outputs, and dust actions -- as structured, queryable
 * field values, with zero node/indexer/network involvement in the decode itself.
 *
 * This is the DERIVED-ON-READ shape AC-4's own wording permits: the zswap/unshielded/dust
 * categories may stay "deferred, replay-recoverable" (no dedicated tables) *only* while an
 * actual end-to-end test proves reconstruction from archived bytes matches what the indexer
 * independently reports -- `test/integration/chain-archive-replay-decode.integration.test.ts`
 * is that proof, running this exact module against real archived testnet transactions and real
 * indexer-recorded ground truth. An earlier implementation round claimed this decode was
 * "genuinely blocked -- no JS/WASM decoder available"; that claim was WRONG (independent review
 * found the built `@midnight-ntwrk/ledger-v8` WASM package in the sibling `midnight-wallet`
 * checkout and decoded real transactions with it), and this module is the correction.
 *
 * **Dependency posture.** `@midnight-ntwrk/ledger-v8` IS a devDependency of this repo, pinned to
 * an exact version: node-only ingest hard-depends on it to classify and hash transactions, so
 * resolving it from an out-of-band checkout meant the feature could not run in CI or from a fresh
 * clone. (An earlier revision of this comment said it was deliberately not a dependency; that
 * described the pre-sprint-9 arrangement, when this module was only a test helper.)
 *
 * `loadLedgerV8` resolves it in three steps, in order: the `MIDNIGHT_LEDGER_WASM` override, then
 * this repo's own dependency, then the historical sibling-`midnight-wallet` checkout convention.
 * The override exists because no PUBLISHED build yet exposes
 * `SystemTransaction.transactionHash()`, which node-only ingest needs to archive system
 * transactions; it is deleted once that ships upstream.
 *
 * Loading still goes through a COMPUTED (non-literal) `import(...)` specifier, so `tsc` types the
 * call `Promise<any>` and this file typechecks without the WASM present.
 * `decodeArchivedTransaction` takes the loaded module as a parameter (never imports it), so
 * everything here stays unit-testable and side-effect-free.
 */

/** ASCII tag prefixes the on-wire payload is domain-separated with (design doc §3.2 -- the raw
 *  bytes are self-tagged, e.g. `midnight:system-transaction[v6]:` /
 *  `midnight:transaction[v9](signature[v1],proof,pedersen-schnorr...)`, confirmed against real
 *  devnet AND testnet bytes). */
export const SYSTEM_TX_TAG_PREFIX = "midnight:system-transaction";
export const STANDARD_TX_TAG_PREFIX = "midnight:transaction";

export interface DecodedZswapOutput {
  /** Which offer carried it: the transaction-level guaranteed offer, or a numbered fallible
   *  segment. */
  section: "guaranteed" | "fallible";
  segmentId: number | undefined;
  /** Coin commitment (hex) -- the field the indexer's own `ZswapOutput` ledger event reports. */
  commitment: string;
  /** Receiving contract address, when the recipient is a contract. */
  contractAddress: string | undefined;
}

export interface DecodedZswapInput {
  section: "guaranteed" | "fallible";
  segmentId: number | undefined;
  /** Spend nullifier (hex) -- the field the indexer's `ZswapInput` ledger event reports. */
  nullifier: string;
  contractAddress: string | undefined;
}

/**
 * **These are OFFERED outputs, not APPLIED ones.** They are read out of the transaction's own
 * intents, which describe what the transaction proposed to do -- not what the ledger did with it.
 * A transaction that failed, or whose fallible segment did not apply, still carries these.
 *
 * Any projection that persists created UTXOs must therefore derive them from the runtime's
 * `UnshieldedTokens` event (`midnight-node/pallets/midnight/src/lib.rs`), which the node emits
 * from the APPLICATION outcome, exactly as the reference indexer does. Using this field for that
 * purpose would persist outputs that never existed on chain. It is safe for what it is used for
 * today: describing a transaction's contents.
 */
export interface DecodedUnshieldedOutput {
  /** The intent segment that created this output. */
  segmentId: number;
  /** `Intent.intentHash(segmentId)` (hex) -- matches the indexer's
   *  `unshielded_utxos.intent_hash`. */
  intentHash: string;
  /** Position within the intent's (guaranteed ++ fallible) output list -- matches the indexer's
   *  `unshielded_utxos.output_index` (confirmed empirically: the indexer numbers outputs across
   *  the whole intent, guaranteed section first). */
  outputIndex: number;
  section: "guaranteed" | "fallible";
  /** Owner address (hex) -- `UserAddress`. */
  owner: string;
  /** Raw token type (hex, 32 bytes). */
  tokenType: string;
  value: bigint;
}

export interface DecodedDustSpend {
  segmentId: number;
  vFee: bigint;
  /** Matches the indexer's `DustSpendProcessed` event `nullifier`. */
  oldNullifier: string;
  /** Matches the indexer's `DustSpendProcessed` event `commitment`. */
  newCommitment: string;
}

export interface DecodedDustRegistration {
  segmentId: number;
  nightKey: string;
  dustAddress: string | undefined;
  allowFeePayment: bigint;
}

export interface DecodedArchivedTransaction {
  kind: "system" | "standard";
  /** Ledger-recomputed transaction hash (hex) for standard transactions -- recomputed from the
   *  archived bytes themselves via `Transaction.transactionHash()`, so a test can cross-check it
   *  against the indexer's independently-reported hash. `undefined` for system transactions
   *  (the ledger WASM API exposes no hash accessor on `SystemTransaction`). */
  transactionHash: string | undefined;
  /** `SystemTransaction.toString()` for system transactions (e.g. the genesis
   *  `DistributeReserve(...)` bootstrap) -- the WASM API's structured rendering. */
  systemDescription: string | undefined;
  zswapOutputs: DecodedZswapOutput[];
  zswapInputs: DecodedZswapInput[];
  unshieldedOutputs: DecodedUnshieldedOutput[];
  dustSpends: DecodedDustSpend[];
  dustRegistrations: DecodedDustRegistration[];
}

/** Normalizes a WASM-returned hex string to the archive's lowercase, unprefixed form. */
function hexNoPrefixLower(hex: string): string {
  return (hex.startsWith("0x") ? hex.slice(2) : hex).toLowerCase();
}

function tagOf(rawBytes: Uint8Array): string {
  return Buffer.from(rawBytes.subarray(0, STANDARD_TX_TAG_PREFIX.length + 8)).toString("latin1");
}

/** True if `rawBytes` is a self-tagged Midnight SYSTEM transaction payload. */
export function isSystemTransaction(rawBytes: Uint8Array): boolean {
  return tagOf(rawBytes).startsWith(SYSTEM_TX_TAG_PREFIX);
}

/** True if `rawBytes` is a self-tagged Midnight STANDARD (regular) transaction payload. */
export function isStandardTransaction(rawBytes: Uint8Array): boolean {
  const tag = tagOf(rawBytes);
  return tag.startsWith(STANDARD_TX_TAG_PREFIX) && !tag.startsWith(SYSTEM_TX_TAG_PREFIX);
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Decodes one archived `tx_raw` payload into structured zswap/unshielded/dust fields.
 *
 * @param ledger the loaded `@midnight-ntwrk/ledger-v8` module (from {@link loadLedgerV8}, or any
 *   equivalent build of the same package) -- injected, never imported, see the module doc.
 * @param rawBytes exactly the bytes the archive stores for the transaction (role `tx_raw`) --
 *   the self-tagged inner `send_mn_transaction` payload, NOT the outer Substrate extrinsic
 *   envelope (see `sync-service.ts`'s own byte-level finding on that distinction).
 * @throws if the bytes carry neither known tag, or the WASM deserializer rejects them.
 */
export function decodeArchivedTransaction(ledger: any, rawBytes: Uint8Array): DecodedArchivedTransaction {
  if (isSystemTransaction(rawBytes)) {
    const sysTx = ledger.SystemTransaction.deserialize(rawBytes);
    // FEATURE-DETECTED, not assumed. `transactionHash` exists on the Rust ledger type and is what
    // the reference indexer keys system transactions by, but the published wasm-bindgen wrapper
    // does not export it. A build that does (see MIDNIGHT_LEDGER_WASM in `ledgerV8EntryPath`)
    // yields the same hash the indexer records -- verified against five genesis system
    // transactions archived by midnight-indexer 4.3.2, all five matching.
    //
    // Left `undefined` when absent rather than substituted or computed locally: the hash is a
    // primary key other consumers join on, so a locally-invented one would produce rows that
    // silently fail to match anything.
    const systemHash =
      typeof sysTx.transactionHash === "function"
        ? hexNoPrefixLower(String(sysTx.transactionHash()))
        : undefined;
    return {
      kind: "system",
      transactionHash: systemHash,
      systemDescription: String(sysTx.toString()),
      zswapOutputs: [], zswapInputs: [], unshieldedOutputs: [], dustSpends: [], dustRegistrations: [],
    };
  }
  if (!isStandardTransaction(rawBytes)) {
    throw new Error(
      `decodeArchivedTransaction: bytes carry neither the "${SYSTEM_TX_TAG_PREFIX}" nor the ` +
      `"${STANDARD_TX_TAG_PREFIX}" self-tag (got: ${JSON.stringify(tagOf(rawBytes))}) -- not an ` +
      "archived pallet_midnight transaction payload",
    );
  }

  // Marker choice: archived on-chain transactions are signed, proven, and bound -- the
  // "(signature[v1],proof,pedersen-schnorr...)" parenthetical in the self-tag above says exactly
  // that -- so the concrete `Signaturish`/`Proofish`/`Bindingish` instances are
  // "signature"/"proof"/"binding" (verified against real testnet bytes, not assumed).
  const tx = ledger.Transaction.deserialize("signature", "proof", "binding", rawBytes);

  const zswapOutputs: DecodedZswapOutput[] = [];
  const zswapInputs: DecodedZswapInput[] = [];
  const collectOffer = (offer: any, section: "guaranteed" | "fallible", segmentId: number | undefined): void => {
    if (offer === undefined || offer === null) return;
    for (const out of offer.outputs) {
      zswapOutputs.push({
        section, segmentId,
        commitment: String(out.commitment),
        contractAddress: out.contractAddress === undefined ? undefined : String(out.contractAddress),
      });
    }
    for (const inp of offer.inputs) {
      zswapInputs.push({
        section, segmentId,
        nullifier: String(inp.nullifier),
        contractAddress: inp.contractAddress === undefined ? undefined : String(inp.contractAddress),
      });
    }
  };
  collectOffer(tx.guaranteedOffer, "guaranteed", undefined);
  if (tx.fallibleOffer !== undefined && tx.fallibleOffer !== null) {
    for (const [segmentId, offer] of tx.fallibleOffer) collectOffer(offer, "fallible", Number(segmentId));
  }

  const unshieldedOutputs: DecodedUnshieldedOutput[] = [];
  const dustSpends: DecodedDustSpend[] = [];
  const dustRegistrations: DecodedDustRegistration[] = [];
  if (tx.intents !== undefined && tx.intents !== null) {
    for (const [segmentIdRaw, intent] of tx.intents) {
      const segmentId = Number(segmentIdRaw);
      const intentHash = String(intent.intentHash(segmentId));
      // The indexer numbers `output_index` across the intent's full output list, guaranteed
      // section first, then fallible (confirmed empirically against real testnet rows) -- one
      // shared counter here reproduces that numbering.
      let outputIndex = 0;
      for (const section of ["guaranteed", "fallible"] as const) {
        const offer = section === "guaranteed" ? intent.guaranteedUnshieldedOffer : intent.fallibleUnshieldedOffer;
        if (offer === undefined || offer === null) continue;
        for (const out of offer.outputs) {
          unshieldedOutputs.push({
            segmentId, intentHash, outputIndex: outputIndex++, section,
            owner: String(out.owner),
            tokenType: String(out.type),
            value: BigInt(out.value),
          });
        }
      }
      const dust = intent.dustActions;
      if (dust !== undefined && dust !== null) {
        for (const spend of dust.spends) {
          dustSpends.push({
            segmentId,
            vFee: BigInt(spend.vFee),
            oldNullifier: String(spend.oldNullifier),
            newCommitment: String(spend.newCommitment),
          });
        }
        for (const reg of dust.registrations) {
          dustRegistrations.push({
            segmentId,
            nightKey: String(reg.nightKey),
            dustAddress: reg.dustAddress === undefined ? undefined : String(reg.dustAddress),
            allowFeePayment: BigInt(reg.allowFeePayment),
          });
        }
      }
    }
  }

  return {
    kind: "standard",
    transactionHash: String(tx.transactionHash()),
    systemDescription: undefined,
    zswapOutputs, zswapInputs, unshieldedOutputs, dustSpends, dustRegistrations,
  };
}

/**
 * Whether the ledger build that will actually be loaded exposes
 * `SystemTransaction.transactionHash()`.
 *
 * One source of truth for a capability that changes BEHAVIOUR, not just performance: with it,
 * node-only ingest archives system transactions; without it, ingest refuses rather than omitting
 * them. Tests gate on this so that "the export is absent" produces a visible SKIP of the ingest
 * path -- never a pass. A test that silently substitutes the refusal path for the ingest path can
 * be green in CI while never once exercising successful ingest.
 *
 * Probes the loaded module rather than inspecting configuration, because configuration can point
 * at a build that does not have it.
 */
export async function ledgerSupportsSystemTransactionHash(): Promise<boolean> {
  try {
    const ledger = await loadLedgerV8();
    const proto = ledger?.SystemTransaction?.prototype;
    return typeof proto?.transactionHash === "function";
  } catch {
    return false;
  }
}

/** Candidate roots for a BUILT sibling `midnight-wallet` checkout, in precedence order --
 *  `MIDNIGHT_WALLET_REPO` first (same override the wallet-sdk loader honors), then the two
 *  layouts real environments have used.
 *
 *  These are now a FALLBACK. The ledger is a declared devDependency of this repo (see
 *  `ledgerV8EntryPath`), so a fresh clone works with no sibling checkout at all; the candidates
 *  below are kept so existing developer setups and the pre-existing live-fixture convention
 *  continue to work unchanged. */
function midnightWalletRepoCandidates(): string[] {
  const home = process.env.HOME ?? homedir();
  const fromEnv = process.env.MIDNIGHT_WALLET_REPO;
  return [
    ...(fromEnv !== undefined ? [fromEnv] : []),
    path.join(home, "midnight", "midnight-wallet"),
    path.join(home, "repos", "midnight-wallet"),
  ];
}

/** Absolute path of the ledger-v8 Node entry (`midnight_ledger_wasm_fs.js`) in the first
 *  candidate checkout that actually has it, or `undefined` if none does -- the synchronous
 *  availability probe tests use to `describe.skipIf` honestly (reported as SKIPPED, never as a
 *  silent vacuous pass) in environments without the sibling checkout, e.g. CI. */
export function ledgerV8EntryPath(): string | undefined {
  // Explicit override, checked first. This is now a TEST-ONLY escape hatch, not the route to the
  // system-transaction hash export: the repo's own dependency is a vendored build that already
  // carries it (`vendor/ledger-v8-syshash`, see its PROVENANCE.md), so a fresh clone archives
  // system transactions with no configuration at all.
  //
  // It stays for two uses that are genuinely worth keeping: pointing tests at a DIFFERENT ledger
  // build (e.g. the stock published package, to exercise the refusal path that the vendored build
  // no longer triggers), and letting someone try a candidate build without reinstalling. Both are
  // deliberate acts; neither should be needed to run the suite normally.
  //
  // When the export ships upstream, the vendored directory is deleted, `package.json` moves back
  // to a published version, and this override keeps its remaining test-only role.
  const override = process.env.MIDNIGHT_LEDGER_WASM;
  if (override !== undefined && override !== "") {
    if (!existsSync(override)) {
      // Fail rather than fall back. Falling through to the stock package would silently swap the
      // ledger the operator selected for a different one, and since the two differ in whether
      // system transactions can be archived at all, that changes ingest behaviour without a word.
      throw new Error(
        `MIDNIGHT_LEDGER_WASM points at ${override}, which does not exist. Refusing to fall back ` +
          "to the published package, whose behaviour differs (it cannot hash system transactions).",
      );
    }
    return override;
  }

  // This repo's OWN dependency. Node-only ingest hard-depends on the ledger to classify and hash
  // transactions, so resolving it from an out-of-band sibling checkout meant the headline feature
  // could not run in CI or from a fresh clone -- which is why its regression tests could only ever
  // be skipped there (audit finding F6).
  //
  // That dependency is `file:vendor/ledger-v8-syshash`: a committed build carrying the
  // `SystemTransaction.transactionHash()` export the published package lacks. Vendored rather than
  // rebuilt on demand because the build is NOT bit-reproducible -- the same commit, `wasm-pack` and
  // `rustc` produce a different `.wasm` hash each time -- so these exact verified bytes cannot be
  // regenerated. What attests them is behavioural: they reproduce the five genesis system
  // transaction hashes `midnight-indexer 4.3.2` recorded. See vendor/ledger-v8-syshash/PROVENANCE.md.
  try {
    // Resolve the BARE specifier: the package's `exports` map exposes only the root, and its
    // `node` condition already points at `midnight_ledger_wasm_fs.js`. Asking for that subpath
    // directly is refused with ERR_PACKAGE_PATH_NOT_EXPORTED.
    const own = createRequire(import.meta.url).resolve("@midnight-ntwrk/ledger-v8");
    if (existsSync(own)) return own;
  } catch {
    // Not installed (e.g. a consumer of the published package, which does not ship this
    // directory at all) -- fall through to the sibling-checkout convention below.
  }
  for (const root of midnightWalletRepoCandidates()) {
    const entry = path.join(root, "node_modules", "@midnight-ntwrk", "ledger-v8", "midnight_ledger_wasm_fs.js");
    if (existsSync(entry)) return entry;
  }
  return undefined;
}

/**
 * Loads the `@midnight-ntwrk/ledger-v8` WASM module from the sibling checkout, via a computed
 * `import(...)` specifier (typed `Promise<any>` by design -- module doc above).
 */
export async function loadLedgerV8(): Promise<any> {
  const entry = ledgerV8EntryPath();
  if (entry === undefined) {
    throw new Error(
      "loadLedgerV8: no built midnight-wallet checkout found (looked for node_modules/" +
      "@midnight-ntwrk/ledger-v8/midnight_ledger_wasm_fs.js under: " +
      midnightWalletRepoCandidates().join(", ") + "); set MIDNIGHT_WALLET_REPO to a built checkout",
    );
  }
  return import(pathToFileURL(entry).href);
}
