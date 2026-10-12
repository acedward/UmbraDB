/**
 * The page's side of snapshots: saving an exported snapshot file as a download, and fetching a snapshot the static
 * build publishes (`snapshots/index.json`, same origin) to import it. The engine's client does the rest
 * (`client.export()`, `client.import(blob)`; a `File` the user picks is a `Blob`). No markup is built from text: the
 * download link is an element whose `href` is a `blob:` URL of the file.
 */
import {
  PUBLISHED_INDEX_PATH,
  type PublishedSnapshotIndex,
  PublishedSnapshotIndexSchema,
  sha256Hex,
} from "./snapshot.ts";

/** Saves `snapshot.file` under `snapshot.name` through a download link. */
export function saveSnapshotFile(snapshot: { file: Blob; name: string }, doc: Document = document): void {
  const url = URL.createObjectURL(snapshot.file);
  const a = doc.createElement("a");
  a.href = url;
  a.download = snapshot.name;
  a.rel = "noopener";
  a.hidden = true;
  doc.body.append(a);
  try {
    a.click();
  } finally {
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/** The build's published snapshots, or `null` when it publishes none (no index). `base`: the page's URL. */
export async function publishedSnapshots(base: string | URL, fetchImpl: typeof fetch = (i, o) => fetch(i, o)): Promise<PublishedSnapshotIndex | null> {
  const res = await fetchImpl(new URL(PUBLISHED_INDEX_PATH, base));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${PUBLISHED_INDEX_PATH}: HTTP ${res.status}`);
  return PublishedSnapshotIndexSchema.parse(await res.json());
}

/** Fetches the published snapshot `name` and checks its size and SHA-256 against the index; resolves with the file. */
export async function fetchPublishedSnapshot(name: string, base: string | URL, fetchImpl: typeof fetch = (i, o) => fetch(i, o)): Promise<File> {
  const index = await publishedSnapshots(base, fetchImpl);
  const entry = index?.snapshots.find((s) => s.name === name);
  if (entry === undefined) throw new Error(`this build publishes no snapshot named ${JSON.stringify(name)}`);
  const url = new URL(entry.file, new URL(PUBLISHED_INDEX_PATH, base));
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${entry.file}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length !== entry.bytes) throw new Error(`${entry.file}: ${bytes.length} bytes, the index says ${entry.bytes}`);
  const digest = await sha256Hex(bytes);
  if (digest !== entry.sha256) throw new Error(`${entry.file}: SHA-256 ${digest}, the index says ${entry.sha256}`);
  return new File([bytes as Uint8Array<ArrayBuffer>], entry.file, { type: "application/x-tar" });
}
