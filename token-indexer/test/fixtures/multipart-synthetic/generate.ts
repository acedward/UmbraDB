import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pad32, tokenColorHex } from "../../../color.js";
import {
  MIP_0018_EVENT_NAME, encodeCompactUint, encodeTokenMetadataUc1, splitIntoParts,
} from "../../../ingest/payload.js";

/**
 * Project 00024-01 task B5 — a SYNTHETIC MIP-0018 corpus in the shape the contracts repository's
 * task 01-A5 will export (`fixtures/simulator/`: declarations grouped as packages with their
 * segment and ordered parts, `expected-tokens.json` with the long values), so
 * `[[multipart-0018-golden]]` has something to fold until that corpus exists.
 *
 * It is NOT contract output: every payload is built with this repository's own UC-1 encoder
 * (`encodeTokenMetadataUc1`, pinned independently against compact-runtime by
 * `[[multipart-0018-rules]]`), from the literal declaration table below. The expected rows are a
 * second, hand-written literal table — never computed from the first — so the test compares the
 * fold against an expectation stated separately. `SOURCE.md` says the same; the golden test also
 * checks that the committed JSON equals this generator's output byte for byte.
 *
 * The shape follows spec 00024 §6.A's long values: SNEB's ~700-byte `metadata` (3 parts), LMOON's
 * Null then ~400-byte `description` (2 parts), a CNST trait of ~300 bytes (2 parts) — plus, for
 * FR-009 (no 189-byte ceiling on a projection), a CNST `name` and `tokenUri` longer than one part.
 *
 * Run `npx tsx token-indexer/test/fixtures/multipart-synthetic/generate.ts --write` to rewrite
 * the JSON files.
 */

const addressOf = (row: string): string => createHash("sha256").update(`umbra:00024:${row}`).digest("hex");
const hexOf = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

interface Declaration {
  row: string;
  op: string;
  domainSep: string;
  kind: number;
  key: string;
  valType: number;
  value: string | Uint8Array;
}

const REPO = "https://github.com/acedward/mip-0018-midnight-contracts/blob/main/contracts/generated";
export const SNEB_METADATA = JSON.stringify({
  description: `A nebula of shielded dust, drawn in ${"many ".repeat(110)}layers.`.slice(0, 580),
  image: "https://example.test/sneb18.svg",
  attributes: [{ trait_type: "phase", value: "emission" }],
});
export const LMOON_DESCRIPTION = `Ledger Moon: ${"a pale ledger-kind moon over the local chain; ".repeat(9)}`.slice(0, 400);
export const CNST_LORE = `Orion: ${"seven stars in a constellation of shielded tokens, ".repeat(6)}`.slice(0, 300);
export const CNST_NAME = `Constellation Orion · MIP-18 · ${"a name longer than one part can hold, ".repeat(5)}`.slice(0, 200);
export const CNST_URI = `https://example.test/tokens/cnst18/orion/${"segment/".repeat(26)}token.json`;

const DECLARATIONS: Declaration[] = [
  // SNEB18 — shielded native; the ~700-byte metadata document is ONE declaration in 3 parts.
  { row: "SNEB18", op: "publishName", domainSep: "umbra:sneb18", kind: 1, key: "name", valType: 1, value: "Shielded Nebula · MIP-18" },
  { row: "SNEB18", op: "publishSymbol", domainSep: "umbra:sneb18", kind: 1, key: "symbol", valType: 1, value: "SNEB18" },
  { row: "SNEB18", op: "publishDecimals", domainSep: "umbra:sneb18", kind: 1, key: "decimals", valType: 2, value: encodeCompactUint(6, 16) },
  { row: "SNEB18", op: "publishMetadata", domainSep: "umbra:sneb18", kind: 1, key: "metadata", valType: 3, value: SNEB_METADATA },
  { row: "SNEB18", op: "publishRepository", domainSep: "umbra:sneb18", kind: 1, key: "repository", valType: 4, value: `${REPO}/SNEB18.compact` },
  // LMOON18 — unshielded ledger; a short description, a Null, then a 400-byte one (2 parts).
  { row: "LMOON18", op: "publishName", domainSep: "umbra:lmoon18", kind: 2, key: "name", valType: 1, value: "Ledger Moon · MIP-18" },
  { row: "LMOON18", op: "publishSymbol", domainSep: "umbra:lmoon18", kind: 2, key: "symbol", valType: 1, value: "LMOON18" },
  { row: "LMOON18", op: "publishDecimals", domainSep: "umbra:lmoon18", kind: 2, key: "decimals", valType: 2, value: encodeCompactUint(9, 16) },
  { row: "LMOON18", op: "publishDescription", domainSep: "umbra:lmoon18", kind: 2, key: "description", valType: 1, value: "A short first description." },
  { row: "LMOON18", op: "clearDescription", domainSep: "umbra:lmoon18", kind: 2, key: "description", valType: 5, value: new Uint8Array(0) },
  { row: "LMOON18", op: "publishLongDescription", domainSep: "umbra:lmoon18", kind: 2, key: "description", valType: 1, value: LMOON_DESCRIPTION },
  { row: "LMOON18", op: "publishRepository", domainSep: "umbra:lmoon18", kind: 2, key: "repository", valType: 4, value: `${REPO}/LMOON18.compact` },
  // CNST18 — shielded native collection member; a 300-byte trait, and a name and tokenUri that
  // each need two parts (no 189-byte ceiling on the projection, FR-009).
  { row: "CNST18", op: "publishName", domainSep: "umbra:cnst18:orion", kind: 1, key: "name", valType: 1, value: CNST_NAME },
  { row: "CNST18", op: "publishSymbol", domainSep: "umbra:cnst18:orion", kind: 1, key: "symbol", valType: 1, value: "ORION18" },
  { row: "CNST18", op: "publishLore", domainSep: "umbra:cnst18:orion", kind: 1, key: "lore", valType: 1, value: CNST_LORE },
  { row: "CNST18", op: "publishTokenUri", domainSep: "umbra:cnst18:orion", kind: 1, key: "tokenUri", valType: 4, value: CNST_URI },
];

const MINTS = [
  { row: "SNEB18", op: "mint", domainSep: "umbra:sneb18", kindByte: 1, amount: "1000000" },
];

export interface SyntheticCorpus {
  packages: unknown;
  mints: unknown;
  expectedTokens: unknown;
}

export function buildSyntheticCorpus(): SyntheticCorpus {
  let eventId = 0;
  const packages = DECLARATIONS.map((d, index) => {
    const domainSep = pad32(d.domainSep);
    const value = typeof d.value === "string" ? new TextEncoder().encode(d.value) : d.value;
    const payload = encodeTokenMetadataUc1({ domainSep, kindByte: d.kind, key: d.key, valType: d.valType, value });
    const parts = splitIntoParts(payload).map((p) => ({ eventId: eventId++, payloadHex: hexOf(p) }));
    return {
      row: d.row, step: index, op: d.op, contractAddress: addressOf(d.row), eventName: MIP_0018_EVENT_NAME,
      // One declaration per circuit call, one call per intent (UC-1, spec FR-019): intent = step + 1.
      segment: index + 1, phase: "guaranteed", parts,
      payloadHex: hexOf(payload), payloadSha256: sha(payload),
      domainSepHex: hexOf(domainSep), domainSepText: d.domainSep, kind: d.kind, keyText: d.key,
      valType: d.valType, len: value.length, valueSha256: sha(value),
    };
  });

  const mints = MINTS.map((m) => ({
    row: m.row, op: m.op, contractAddress: addressOf(m.row), domainSepHex: hexOf(pad32(m.domainSep)),
    kindByte: m.kindByte, amount: m.amount, colorHex: tokenColorHex(hexOf(pad32(m.domainSep)), addressOf(m.row)),
  }));

  // ── the expected rows: a separate, literal table ─────────────────────────────────────────────
  const text = (s: string) => ({ valType: 1, valLen: Buffer.byteLength(s), valueHex: Buffer.from(s).toString("hex"), text: s });
  const uri = (s: string) => ({ ...text(s), valType: 4 });
  const json = (s: string) => ({ ...text(s), valType: 3 });
  const int = (b: Uint8Array) => ({ valType: 2, valLen: b.length, valueHex: hexOf(b), text: null });
  const expectedTokens = [
    {
      row: "SNEB18", contractAddress: addressOf("SNEB18"), domainSepHex: hexOf(pad32("umbra:sneb18")), kind: 1,
      privacy: "shielded", storage: "native",
      colorHex: tokenColorHex(hexOf(pad32("umbra:sneb18")), addressOf("SNEB18")),
      name: "Shielded Nebula · MIP-18", symbol: "SNEB18", decimals: 6, tokenUri: null,
      metadata: JSON.parse(SNEB_METADATA),
      traits: {
        name: text("Shielded Nebula · MIP-18"), symbol: text("SNEB18"), decimals: int(encodeCompactUint(6, 16)),
        metadata: json(SNEB_METADATA), repository: uri(`${REPO}/SNEB18.compact`),
      },
      mintCount: 1, totalMinted: "1000000", status: "described",
    },
    {
      row: "LMOON18", contractAddress: addressOf("LMOON18"), domainSepHex: hexOf(pad32("umbra:lmoon18")), kind: 2,
      privacy: "unshielded", storage: "ledger", colorHex: null,
      name: "Ledger Moon · MIP-18", symbol: "LMOON18", decimals: 9, tokenUri: null, metadata: null,
      traits: {
        name: text("Ledger Moon · MIP-18"), symbol: text("LMOON18"), decimals: int(encodeCompactUint(9, 16)),
        // The Null in between is history; the 400-byte value after it is the current one.
        description: text(LMOON_DESCRIPTION), repository: uri(`${REPO}/LMOON18.compact`),
      },
      mintCount: 0, totalMinted: "0", status: "declared",
    },
    {
      row: "CNST18", contractAddress: addressOf("CNST18"), domainSepHex: hexOf(pad32("umbra:cnst18:orion")), kind: 1,
      privacy: "shielded", storage: "native",
      colorHex: tokenColorHex(hexOf(pad32("umbra:cnst18:orion")), addressOf("CNST18")),
      name: CNST_NAME, symbol: "ORION18", decimals: null, tokenUri: CNST_URI, metadata: null,
      traits: { name: text(CNST_NAME), symbol: text("ORION18"), lore: text(CNST_LORE), tokenUri: uri(CNST_URI) },
      mintCount: 0, totalMinted: "0", status: "declared",
    },
  ];

  const note = "SYNTHETIC (UmbraDB project 00024-01 task B5): built with this repository's UC-1 encoder from a literal declaration table, in the shape 01-A5's simulator corpus will have, until that corpus is re-pinned. Not contract output. Contract addresses are sha256(\"umbra:00024:<row>\"); there are no block heights or transaction hashes; eventId is the emission order across the whole corpus; every declaration is one call in its own intent (segment = step + 1), guaranteed.";
  return {
    packages: { standard: "MIP-0018 amended in place by UC-1 (2-byte little-endian val-len at 66, value from 68), following [Y] mip-xxxx:multi-part[v1]", note, count: packages.length, packages },
    mints: { note, count: mints.length, mints },
    expectedTokens: { note, count: expectedTokens.length, tokens: expectedTokens },
  };
}

export const FILES = { packages: "packages.json", mints: "mints.json", expectedTokens: "expected-tokens.json" } as const;

export function render(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

if (process.argv.includes("--write") && process.argv[1] === fileURLToPath(import.meta.url)) {
  const corpus = buildSyntheticCorpus();
  for (const [key, file] of Object.entries(FILES)) {
    writeFileSync(new URL(file, import.meta.url), render(corpus[key as keyof SyntheticCorpus]));
  }
  console.log("wrote", Object.values(FILES).join(", "));
}
