import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndexBytes } from "../../interface/commitment.js";
import { BodyTooLargeError, TransportError, type BundleTransport } from "../../interface/level1.js";

/**
 * Project 00024-02 — the synthetic FULL-source bundle `fixtures/interfaces/pi-fixture/` (built by the
 * patched reference tools, see its SOURCE.md), held in memory, and its variants derived EXACTLY as
 * the builder derived them — so each recorded reference verdict (`reference-verdicts.json`) applies
 * to byte-identical inputs, which the tests check through `indexSha256`.
 */

const DIR = fileURLToPath(new URL("../fixtures/interfaces/pi-fixture/", import.meta.url));

export type Bundle = Map<string, Buffer>;

function walk(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, root));
    else out.push(p.slice(root.length + 1).split("\\").join("/"));
  }
  return out.sort();
}

/** The published bundle: every file under `bundle/`, index.json included. */
export function loadFixtureBundle(): Bundle {
  const root = join(DIR, "bundle");
  return new Map(walk(root).map((p) => [p, readFileSync(join(root, p))]));
}

export const fixtureText = (name: string): string => readFileSync(join(DIR, name), "utf8").trim();
export const fixtureHex = (name: string): Buffer => Buffer.from(fixtureText(name), "hex");

export interface ReferenceVerdict {
  label: string;
  indexSha256: string;
  indexHash: string;
  level: number;
  url: string;
  parts: number;
  l1: { ok: boolean; hashOk?: boolean; indexOk?: boolean; filesOk?: boolean; compilerOk?: boolean; file: string | null; reason: string | null };
  l2: { ok: boolean; wrapperOk: boolean; rows: { circuit: string; status: string; reason?: string }[] } | null;
  l3: { ok: boolean; rows: { item: string; status: string }[]; versionMismatch: boolean; error: string | null } | null;
  witnesses: string[];
}

export function referenceVerdicts(): { urls: { short: string; long: string }; verdicts: ReferenceVerdict[] } {
  return JSON.parse(fixtureText("reference-verdicts.json")) as { urls: { short: string; long: string }; verdicts: ReferenceVerdict[] };
}

export const verdict = (label: string): ReferenceVerdict => {
  const v = referenceVerdicts().verdicts.find((x) => x.label === label);
  if (v === undefined) throw new Error(`no reference verdict ${label}`);
  return v;
};

export const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
export const clone = (b: Bundle): Bundle => new Map([...b].map(([k, v]) => [k, Buffer.from(v)]));
export const commitmentOf = (b: Bundle): Buffer => Buffer.from(JSON.parse(b.get("index.json")!.toString("utf8")).hash, "hex");

/** `tampered-file`: byte 100 of `out/contract/index.js` flipped (size unchanged); index untouched. */
export function tamperedFile(base: Bundle): Bundle {
  const b = clone(base);
  const js = b.get("out/contract/index.js")!;
  js[100] = js[100]! ^ 0x01;
  return b;
}

/** `wrong-hash`: `hash` = SHA-256("not the commitment"), re-serialized as the reference writes. */
export function wrongHash(base: Bundle): Bundle {
  const b = clone(base);
  const index = JSON.parse(b.get("index.json")!.toString("utf8")) as Record<string, unknown>;
  index.hash = createHash("sha256").update("not the commitment").digest("hex");
  b.set("index.json", Buffer.from(`${JSON.stringify(index, null, 2)}\n`));
  return b;
}

/** Any `package.json` edit, then the index rebuilt the way the reference writer builds it. */
export function withPackage(base: Bundle, edit: (pkg: Record<string, any>) => void): Bundle { // eslint-disable-line @typescript-eslint/no-explicit-any
  const b = clone(base);
  const pkg = JSON.parse(b.get("package.json")!.toString("utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  edit(pkg);
  b.set("package.json", Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`));
  b.set("index.json", buildIndexBytes(b).bytes);
  return b;
}

/** `compiler-0.33.0`: package.json names compactc 0.33.0 (not installed); keys stay 0.34.0's. */
export const compiler033 = (base: Bundle): Bundle => withPackage(base, (pkg) => { pkg.compact.compiler = "0.33.0"; });

/** Replace (or add) files, then rebuild the index — a coherent bundle with other contents. */
export function withFiles(base: Bundle, files: Record<string, Buffer | null>): Bundle {
  const b = clone(base);
  for (const [p, v] of Object.entries(files)) {
    if (v === null) b.delete(p);
    else b.set(p, v);
  }
  b.set("index.json", buildIndexBytes(b).bytes);
  return b;
}

/** `[B]`'s pointer for a bundle: commitment ‖ utf8(url), zero padded to 256·k. */
export function payloadFor(b: Bundle, url: string): Buffer {
  const commitment = commitmentOf(b);
  const urlBytes = Buffer.from(url, "utf8");
  const parts = Math.max(1, Math.ceil((32 + urlBytes.length) / 256));
  const out = Buffer.alloc(256 * parts);
  commitment.copy(out, 0);
  urlBytes.copy(out, 32);
  return out;
}

/**
 * An in-memory transport over one bundle served at `base` (a directory URL ending in `/`): every
 * GET is recorded; a path the bundle does not hold is an `unfetchable` 404; `overrides` replace a
 * URL's answer with bytes or a thrown error.
 */
export class MemoryTransport implements BundleTransport {
  readonly requests: { url: string; cap: number }[] = [];
  readonly overrides = new Map<string, Buffer | Error>();

  constructor(private readonly bundle: Bundle, private readonly base: string) {}

  async get(url: string, cap: number): Promise<Buffer> {
    this.requests.push({ url, cap });
    const override = this.overrides.get(url);
    if (override instanceof Error) throw override;
    const body = override ?? (url.startsWith(this.base) ? this.bundle.get(decodeURIComponent(url.slice(this.base.length))) : undefined);
    if (body === undefined) throw new TransportError("unfetchable", `${url} returned HTTP 404`);
    if (body.length > cap) throw new BodyTooLargeError(cap, `more than ${cap} bytes`);
    return body;
  }
}
