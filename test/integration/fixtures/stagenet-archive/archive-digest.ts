import { createHash } from "node:crypto";

/**
 * The archive digest (`chain-archive-sync/archive-digest.ts`, runtime-neutral) for the tests and fixture tools, plus
 * `sha256Hex` of a file's or a text's bytes.
 */
export { archiveDigest, type ArchiveDigest, canonicalJson, dumpArchive } from "../../../../chain-archive-sync/archive-digest.js";

export const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
