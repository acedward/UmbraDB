/**
 * The recorded Stagenet ranges the worker replays offline: the gzip copies in `./tapes/` (Chrome's
 * `DecompressionStream` has no brotli), built into the static build as assets. Loading one fetches the asset from the
 * page's own origin, checks its SHA-256 against `./tapes/manifest.json`'s value (pinned here, and compared with the
 * manifest by the tests), decompresses it and parses it (`chain-archive-sync/archive-tape.ts`).
 */
import { type ArchiveTape, readTape } from "../../chain-archive-sync/archive-tape.js";
import { sha256Hex } from "../../src/postgres/bytes.js";
import type { TapeRange } from "./protocol.ts";

export interface TapeAsset {
  /** The file name in `./tapes/`. */
  file: string;
  /** SHA-256 of the gzip file, lower-case hex. */
  sha256: string;
  url: () => URL;
}

export const TAPE_ASSETS: Record<TapeRange, TapeAsset> = {
  idx: {
    file: "stagenet-714485-715183.tape.json.gz",
    sha256: "60b9681d9fb8991efe98ca3ae0aadfb9d809bab4f1710ab8579ce85384f268c1",
    url: () => new URL("./tapes/stagenet-714485-715183.tape.json.gz", import.meta.url),
  },
  u1: {
    file: "stagenet-715402-715433.tape.json.gz",
    sha256: "7c9beb9e3a2ee6aa0af652f1c7553d670faac9354670ff66c3cfd1c16f06898d",
    url: () => new URL("./tapes/stagenet-715402-715433.tape.json.gz", import.meta.url),
  },
};

/** Fetches, verifies and parses a recorded range. */
export async function loadTape(range: TapeRange, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<ArchiveTape> {
  const asset = TAPE_ASSETS[range];
  const res = await fetchImpl(asset.url());
  if (!res.ok) throw new Error(`tape ${asset.file}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const digest = sha256Hex(bytes);
  if (digest !== asset.sha256) throw new Error(`tape ${asset.file}: SHA-256 ${digest} is not the recorded ${asset.sha256}`);
  return readTape(bytes, "gzip");
}
