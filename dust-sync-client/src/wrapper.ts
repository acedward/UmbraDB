import type { DustLocalStateLike } from "./ledger.js";

/**
 * The SDK's serialized DUST wallet, so a state this client built in seconds can be handed to
 * `DustWallet.restore` (`spec/00016-dust-wallet-sync.md` §5.6, FR-032, plan D3.4).
 *
 * ── The shape, read from the SDK ────────────────────────────────────────────────────────────
 * `@midnightntwrk/wallet-sdk-dust-wallet/dist/v1/Serialization.js` encodes a snapshot with
 * `effect`'s `Schema`: `publicKey.publicKey` and `protocolVersion` and `offset` through
 * `Schema.BigInt` (a DECIMAL STRING), `state` through `Schema.Uint8ArrayFromHex` composed with
 * `DustLocalState.deserialize` (so: HEX of `state.serialize()`), `networkId` a plain string.
 * `DustWallet(config).restore(json)` then calls
 * `CoreWallet.restore(state, publicKey, [], { appliedIndex: offset ?? 0n, … }, protocolVersion,
 * networkId)`.
 *
 * ── `offset` is the dangerous field ─────────────────────────────────────────────────────────
 * It is the INDEXER's `dustLedgerEvents.id` of the last event the state has applied. `Sync.js`
 * resubscribes from `appliedIndex − 1` (inclusive) and `applyUpdate` drops every update with
 * `id ≤ appliedIndex`. So an offset that is too LOW makes the SDK replay history — slow, but
 * correct — while an offset that is too HIGH makes it SKIP events, which is silent corruption of
 * a wallet's balance.
 *
 * Our event ids are the archive's own dense per-net sequence. They are ids of the same events in
 * the same order, but equality with the indexer's numbering is a claim about two independent
 * systems, so this module will not assume it: `offset` must be supplied by a caller that has
 * MEASURED the mapping (`dust-sync-client/devnet/sdk/indexer-event-ids.ts` compares the two at
 * block boundaries), and `0n` — replay everything, always correct — is the default.
 */

export interface DustSdkWrapper {
  readonly publicKey: { readonly publicKey: string };
  readonly state: string;
  readonly protocolVersion: string;
  readonly networkId: string;
  readonly offset?: string;
}

export interface DustSdkWrapperOptions {
  /** The wallet's DUST public key. */
  readonly publicKey: bigint;
  /** The SDK's `networkId` — `undeployed`, `preprod`, … (NOT our archive `net`, though the two
   *  happen to spell devnet and preprod the same way). */
  readonly networkId: string;
  /**
   * The SDK's protocol version for this chain. `ProtocolVersion.MinSupportedVersion` is `0n`
   * (`@midnightntwrk/wallet-sdk-abstractions/dist/ProtocolVersion.js:52`), which is what a fresh
   * wallet starts at; when a real SDK snapshot of the same chain is available, take ITS value —
   * the indexer reports a `protocolVersion` per event and the SDK carries it forward.
   */
  readonly protocolVersion: bigint;
  /**
   * The INDEXER's `dustLedgerEvents.id` of the last applied event, or `0n` to make the SDK replay
   * from the start. Never pass an id that has not been proved to be the indexer's numbering.
   */
  readonly appliedIndex?: bigint;
}

export function sdkWrapper(state: DustLocalStateLike, options: DustSdkWrapperOptions): DustSdkWrapper {
  const serialized = state.serialize();
  return {
    publicKey: { publicKey: options.publicKey.toString(10) },
    state: Buffer.from(serialized).toString("hex"),
    protocolVersion: options.protocolVersion.toString(10),
    networkId: options.networkId,
    offset: (options.appliedIndex ?? 0n).toString(10),
  };
}
