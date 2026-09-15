/**
 * `dust-sync-client` — a wallet builds its DUST state from the shielded-monitor node
 * (`spec/00016-dust-wallet-sync.md` Story 4, FR-030…FR-032).
 *
 * Node today, structured so a browser wallet can embed it: nothing under `src/` opens a file,
 * reads an environment variable or imports a ledger build — the WASM module is a parameter and
 * `fetch` is injectable. The two Node-only pieces are kept apart on purpose: `keys.ts` (reads a
 * mode-600 seed file) and `cli.ts`.
 */
export { syncDust, type DustSyncOptions, type DustSyncResult } from "./sync.js";
export { DustSyncError, type DustSyncErrorCode } from "./errors.js";
export {
  LEDGER_SURFACE,
  WASM_BINDGEN_UNIVERSALS,
  assertLedgerSurface,
  type CollapsedUpdateLike,
  type DustGenerationValue,
  type DustLocalStateLike,
  type DustQdo,
  type DustSecretKeyLike,
  type LedgerLike,
} from "./ledger.js";
export {
  MAX_NULLIFIERS_PER_REQUEST,
  MAX_RANGES_PER_REQUEST,
  bytesFromHex,
  dateFromSeconds,
  gapRanges,
  generationFromWire,
  qdoFromWire,
  rangesParam,
  secondsFromDate,
  toBigInt,
  type Range,
} from "./encode.js";
export { DustHttpClient } from "./http.js";
export { DUST_KEY_PATH, dustSecretKeyFromSeed, readSeedFile, SeedFileError } from "./keys.js";
export { sdkWrapper, type DustSdkWrapper, type DustSdkWrapperOptions } from "./wrapper.js";
export type * from "./types.js";
