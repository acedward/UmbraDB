import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CompactTypeUnsignedInteger } from "@midnight-ntwrk/compact-runtime";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapTokenIndexSchema } from "../bootstrap.js";
import { pad32, tokenColorHex } from "../color.js";
import type { ObservedMint } from "../ingest/decode.js";
import { applyMetadataEvent, applyMint, type RawContractEvent } from "../ingest/fold.js";
import {
  LEGACY_EVENT_NAME, MIP_0018_EVENT_NAME, integerOfValue, isTokenMetadataName, nameHexOf,
  nameVariantOf, parseTokenMetadata, type NameVariant, type ProjectionError, type RejectReason,
} from "../ingest/payload.js";

/**
 * The golden corpora produced by the REAL COMPILED reference contracts, executed in the Compact
 * simulator in process.
 *
 * Nothing here is hand-written, and there are **two** corpora, because there are two event names and
 * two validators (owner decision Q27):
 *
 *  - `fixtures/contracts/` — **MIP-0018 on UC-1** (project 00024-01), from the generated MIP-18 set
 *    of `acedward/mip-0018-midnight-contracts` @ `cb6c675`: 86 `mip-0018:token-metadata[v1]` events
 *    forming **82 [Y] packages** (one declaration each; 79 × 1 part, 2 × 2, 1 × 3), 16 mints, 15
 *    colour vectors, 17 expected rows, 40 awkward packages.
 *  - `fixtures/contracts-legacy/` — the **superseded PR #315 draft** (`acedward/mip-erc7496-midnight-
 *    contracts`): 69 `mip-xxxx:token-metadata[v1]` events and the rest of that set, frozen. This is
 *    what the Stagenet reference set actually emits, and it is not being redeployed.
 *
 * Each `SOURCE.md` pins its repository, branch and commit, and tabulates the differences. Every one
 * of this file's four governed ids runs over BOTH, which is what makes the pair a regression test
 * for "two names, two validators" rather than two unrelated fixtures: the same eleven reference rows
 * (the standard's corpus is their `…18` variant), the same 17 token rows, two transports.
 *
 * So this is the test that decides whether this indexer and those contracts actually agree —
 * `payload-0018.test.ts` and `payload.test.ts` prove the parser's own rules for each name, this
 * proves the parser reads what the contracts really emit. (`multipart-golden.test.ts` puts the same
 * MIP-0018 corpus through the [Y] reader part by part; here each package is read as the contracts
 * recorded it merged.)
 *
 * The simulator has no chain, so a corpus carries no block heights, transaction hashes or indexer
 * event ids; this test supplies them (emission order → event id → synthetic height; the standard's
 * corpus records a per-call `txStandIn`). Everything that matters — the bytes, the domain
 * separators, the colours, the amounts — is the contracts'.
 */

const read = <T>(dir: string, file: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${dir}/${file}`, import.meta.url), "utf8")) as T;

/** The variant a fixture's own recorded event NAME names (MIP §8: the name is the version). Throws
 *  for a name this consumer does not recognise, so a corpus regenerated under a third name cannot
 *  quietly be validated under the wrong rules. */
function variantOfFixture(eventName: string): NameVariant {
  const variant = nameVariantOf(Buffer.from(pad32(eventName)).toString("hex"));
  if (variant === undefined) {
    throw new Error(`fixture event name ${eventName} is recognised by neither validator`);
  }
  return variant;
}

/** The corpus records `keyHex` as the RAW 32-byte field; MIP §5.1 makes the key's identity the same
 *  bytes with their trailing NULs trimmed, which is what this indexer stores. Same key, two
 *  spellings — this is the conversion, and it is also a small proof that the trimming rule is the
 *  only difference between them. */
function trimmedKeyHex(paddedHex: string): string {
  const bytes = Buffer.from(paddedHex, "hex");
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return bytes.subarray(0, end).toString("hex");
}

/** One recorded declaration's decoded fields — a draft-name EVENT, or a MIP-0018 PACKAGE. */
interface FixtureFields {
  row: string; step: number;
  contractAddress: string; eventName: string; payloadHex: string;
  domainSepHex: string; domainSepText: string; kind: number;
  keyText: string | null; keyHex: string; valType: number; len: number;
  valueHex: string; valueText: string | null;
}
/** The draft corpus: one event = one declaration (the draft name is not opted into [Y]). */
interface FixtureEvent extends FixtureFields { eventId: number; op: string }
/** The standard's corpus since UC-1: the events as a chain delivers them (256 bytes each) … */
interface FixturePart {
  eventId: number; row: string; step: number; contractAddress: string; txStandIn: string;
  segmentStandIn: number; packageId: number; part: number; parts: number; eventName: string;
  payloadHex: string;
}
/** … and the [Y] packages they form, each ONE declaration (`payloadHex` = `256·parts` bytes). */
interface FixturePackage extends FixtureFields {
  packageId: number; circuit: string; txStandIn: string; segmentStandIn: number;
  parts: number; eventIds: number[]; payloadSha256: string;
}
/**
 * One declaration, whichever corpus it came from: the merged payload, its parts as the chain
 * delivered them and their emission-order ids. A draft-name declaration is one event, so its only
 * part is its payload.
 */
interface Declaration extends FixtureFields {
  /** Emission-order id of the declaration's FIRST part (P1: a package is positioned by it). */
  id: number;
  partEventIds: number[];
  partPayloadsHex: string[];
  /** The per-call transaction stand-in, when the corpus records one. */
  txStandIn: string | undefined;
  payloadSha256: string | undefined;
}
interface FixtureMint {
  row: string; step: number; op: string; contractAddress: string;
  domainSepHex: string; kindByte: 0 | 1; kind: string; amount: string; colorHex: string;
}
interface FixtureColorVector {
  row: string; contractAddress: string; domainSepHex: string; domainSepText: string;
  colorHex: string; source: string;
}
interface FixtureTrait { valType: number; valLen: number; valueHex: string; text: string | null; parts?: number }
interface FixtureExpectedToken {
  row: string; contractAddress: string; domainSepHex: string; domainSepText: string;
  kind: number; privacy: string; storage: string; colorHex: string | null;
  traits: Record<string, FixtureTrait>;
  name?: string; symbol?: string; decimals?: number; tokenUri?: string; metadata?: unknown;
  mintCount: number; totalMinted: string; status: string;
}
interface FixtureNegative {
  why: string; mipSection: string; expect: "ignored" | "rejected" | "applied";
  reason?: RejectReason; projectionFails?: boolean;
  contractAddress: string; eventName: string; payloadHex: string;
  /** The standard's corpus records every negative as a package: its part count and the parts. */
  parts?: number; partPayloadsHex?: string[];
  kind: number; keyHex: string; keyText: string | null; valType: number; len: number;
}

interface Corpus {
  /** The variant every declaration in this corpus carries — asserted per declaration, not assumed. */
  variant: NameVariant;
  /** The event name string, for the label and for the per-declaration assertion. */
  eventName: string;
  /** The directory under `fixtures/`, and the Postgres schema its fold replay uses. */
  dir: string;
  schema: string;
  /** The reference rows' variant suffix (`LSUN18`, `"Ledger Sun · MIP-18"`), so the two corpora's
   *  rows can be matched to each other; empty for the draft corpus. */
  rowSuffix: string;
  nameSuffix: string;
  /** The corpus's own counts, pinned so a silently shrunk corpus fails rather than passes: chain
   *  events, and the declarations they form (equal under the draft name — one event each). */
  eventCount: number;
  declarationCount: number;
  /** `[row, key, value length, parts]` of every declaration longer than one part, in emission order. */
  longDeclarations: [string, string, number, number][];
  /** The `val-type`s the contracts exercise under this name — 5 (Null) exists only under 0018. */
  valTypes: number[];
  /** The transport reject reasons the negatives cover — `key_pointer_invalid` is 0018-only. */
  rejectReasons: RejectReason[];
  /** How this corpus's SNEB publishes its document, which is the multipart rule made concrete. */
  snebMetadataKeys: string[];
  /** `events.json` as recorded (its `events` are the chain's events: parts, under the standard). */
  eventsFile: { count: number; events: unknown[] };
  declarations: Declaration[];
  mints: { count: number; mints: FixtureMint[] };
  colorVectors: { count: number; vectors: FixtureColorVector[] };
  expectedTokens: {
    count: number; identities: number; addressDomainPairs: number;
    statusCounts: Record<string, number>; tokens: FixtureExpectedToken[];
  };
  negatives: { count: number; outcomes: Record<string, number>; payloads: FixtureNegative[] };
}

/** The declarations of a corpus file: the standard's `packages` (with their parts looked up among
 *  the `events`), or the draft's `events` one by one. */
function declarationsOf(file: {
  count: number; events: (FixtureEvent | FixturePart)[]; packages?: FixturePackage[];
}): Declaration[] {
  if (file.packages === undefined) {
    return (file.events as FixtureEvent[]).map((e) => ({
      ...e, id: e.eventId, partEventIds: [e.eventId], partPayloadsHex: [e.payloadHex],
      txStandIn: undefined, payloadSha256: undefined,
    }));
  }
  const parts = new Map((file.events as FixturePart[]).map((e) => [e.eventId, e]));
  return file.packages.map((p) => ({
    ...p,
    id: p.eventIds[0]!,
    partEventIds: p.eventIds,
    partPayloadsHex: p.eventIds.map((id) => {
      const part = parts.get(id);
      if (part === undefined) throw new Error(`package ${p.packageId}: event ${id} is not in the corpus`);
      return part.payloadHex;
    }),
    txStandIn: p.txStandIn,
    payloadSha256: p.payloadSha256,
  }));
}

function corpus(
  spec: Omit<Corpus, "eventsFile" | "declarations" | "mints" | "colorVectors" | "expectedTokens" | "negatives">,
): Corpus {
  const eventsFile = read<{ count: number; events: (FixtureEvent | FixturePart)[]; packages?: FixturePackage[] }>(
    spec.dir, "events.json");
  return {
    ...spec,
    eventsFile,
    declarations: declarationsOf(eventsFile),
    mints: read(spec.dir, "mints.json"),
    colorVectors: read(spec.dir, "color-vectors.json"),
    expectedTokens: read(spec.dir, "expected-tokens.json"),
    negatives: read(spec.dir, "negative-payloads.json"),
  };
}

/** A row id without the corpus's variant suffix — the reference row both corpora share. */
const baseRow = (c: Pick<Corpus, "rowSuffix">, row: string): string =>
  c.rowSuffix !== "" && row.endsWith(c.rowSuffix) ? row.slice(0, -c.rowSuffix.length) : row;

/**
 * The two corpora, with the handful of numbers that DIFFER stated here rather than read out of the
 * fixtures — a count taken from the file it is checking proves nothing, and the whole value of
 * keeping both corpora is that these differences are the final text's changes made concrete.
 */
const CORPORA = [
  corpus({
    variant: "mip-0018", eventName: MIP_0018_EVENT_NAME,
    dir: "contracts", schema: "token_contract_fixtures",
    rowSuffix: "18", nameSuffix: " · MIP-18",
    // 86 events → 82 packages: one declaration per circuit call, a long value in several parts.
    eventCount: 86,
    declarationCount: 82,
    longDeclarations: [
      ["LMOON18", "description", 377, 2],
      ["SNEB18", "metadata", 677, 3],
      ["CNST18", "metadata", 279, 2],
    ],
    // 5 is Null: LMOON18 clears its `description` with one before declaring a long one.
    valTypes: [1, 2, 3, 4, 5],
    rejectReasons: [
      "kind_unknown", "key_empty", "key_pointer_invalid", "val_type_reserved", "val_len_beyond_package",
      "val_type_rule",
    ],
    // ONE complete JSON value under `metadata` (677 bytes, 3 parts), plus a pointer key that is
    // just a key.
    snebMetadataKeys: ["metadata", "/metadata/description"],
  }),
  corpus({
    variant: "legacy-mip-xxxx", eventName: LEGACY_EVENT_NAME,
    dir: "contracts-legacy", schema: "token_contract_fixtures_legacy",
    rowSuffix: "", nameSuffix: "",
    eventCount: 69,
    declarationCount: 69,
    longDeclarations: [],
    valTypes: [1, 2, 3, 4],
    rejectReasons: [
      "kind_unknown", "key_empty", "val_type_reserved", "val_len_too_long", "val_type_rule",
    ],
    // A six-part document of JSON fragments — the draft's Appendix A convention.
    snebMetadataKeys: ["metadata/0", "metadata/1", "metadata/2", "metadata/3", "metadata/4", "metadata/5"],
  }),
] as const;

const NET = "stagenet";

describe("the compiled reference contracts' recorded corpus", () => {
  it("[[token-contract-golden]] parses every emitted declaration of BOTH corpora byte for byte, exactly as the contracts recorded them — a MIP-0018 declaration being one [Y] package of 256·k bytes", () => {
    for (const c of CORPORA) {
      goldenCorpus(c);
    }
    // The two corpora really are two transports of the same eleven reference rows: the same token
    // rows over the same identities, from different bytes under different rules.
    const [final, legacy] = CORPORA;
    expect(final.declarationCount).not.toBe(legacy.declarationCount);
    expect(final.expectedTokens.count).toBe(legacy.expectedTokens.count);
    expect(final.expectedTokens.identities).toBe(legacy.expectedTokens.identities);
    expect(final.expectedTokens.addressDomainPairs).toBe(legacy.expectedTokens.addressDomainPairs);
    expect(final.expectedTokens.statusCounts).toEqual(legacy.expectedTokens.statusCounts);
    const rowsOf = (c: Corpus): string[] =>
      c.expectedTokens.tokens.map((t) => `${baseRow(c, t.row)}/${t.kind}/${t.status}`).sort();
    expect(rowsOf(final)).toEqual(rowsOf(legacy));
    // …and the same colour vectors per reference row. Their BYTES differ: a colour is a function of
    // `(domainSep, address)`, and the MIP-18 variant changed both (`umbra:lsun18`, a new address);
    // `[[token-contract-colors]]` reproduces every one of them from those two inputs alone.
    const colourRows = (c: Corpus): string[] => c.colorVectors.vectors.map((v) => baseRow(c, v.row)).sort();
    expect(colourRows(final)).toEqual(colourRows(legacy));
  });

  function goldenCorpus(c: Corpus): void {
    expect(c.declarations, c.dir).toHaveLength(c.declarationCount);
    expect(c.eventsFile.events, `${c.dir} event count`).toHaveLength(c.eventCount);
    expect(c.eventsFile.count, `${c.dir} event count`).toBe(c.eventCount);
    // Every chain event belongs to exactly one declaration, in emission order.
    expect(c.declarations.flatMap((d) => d.partEventIds), c.dir)
      .toEqual([...c.eventsFile.events.keys()]);
    for (const e of c.declarations) {
      const label = `${e.row}#${e.id} (${e.keyText})`;
      // MIP §1/§8: the name is the version, and every declaration of a corpus carries exactly one name.
      expect(e.eventName, `${label} event name`).toBe(c.eventName);
      expect(variantOfFixture(e.eventName), `${label} variant`).toBe(c.variant);
      expect(isTokenMetadataName(nameHexOf(c.variant))).toBe(true);

      // The declaration's bytes are its parts, concatenated in emission order, every byte kept
      // ([Y] §4) — 256 bytes per part, and a draft-name declaration is one part.
      const bytes = Buffer.from(e.payloadHex, "hex");
      expect(bytes, `${label} payload width`).toHaveLength(256 * e.partPayloadsHex.length);
      for (const part of e.partPayloadsHex) expect(part.length, `${label} part width`).toBe(512);
      expect(e.partPayloadsHex.join(""), `${label} = its parts`).toBe(e.payloadHex);
      if (e.payloadSha256 !== undefined) {
        expect(createHash("sha256").update(bytes).digest("hex"), `${label} SHA-256`).toBe(e.payloadSha256);
      }
      const parsed = parseTokenMetadata(new Uint8Array(bytes), variantOfFixture(e.eventName));
      expect(parsed.applied, `${label} was rejected: ${parsed.rejectReason}`).toBe(true);
      expect(parsed.parts, `${label} parts`).toBe(e.partPayloadsHex.length);
      expect(Buffer.from(parsed.domainSep).toString("hex")).toBe(e.domainSepHex);
      expect(parsed.kindByte).toBe(e.kind);
      expect(parsed.keyText ?? null).toBe(e.keyText);
      expect(parsed.keyHex).toBe(trimmedKeyHex(e.keyHex));
      expect(e.keyHex.length, `${label} key field width`).toBe(64);
      expect(parsed.valType).toBe(e.valType);
      expect(parsed.valLen).toBe(e.len);
      expect(Buffer.from(parsed.valueBytes).toString("hex")).toBe(e.valueHex);
      // The corpus renders `valueText` as "these bytes decoded as UTF-8 if they can be", whatever
      // the type; this consumer renders text only for the TEXTUAL types (MIP §5.2: "render unknown
      // keys according to their val-type"), so an integer has no text and a number instead.
      if (e.valType === 1 || e.valType === 3 || e.valType === 4) {
        if (e.valueText !== null) expect(parsed.valueText).toBe(e.valueText);
      } else {
        expect(parsed.valueText, `${label} type ${e.valType} has no text`).toBeUndefined();
        if (e.valType === 2) {
          // The number, computed INDEPENDENTLY of `integerOfValue` so this is a real cross-check
          // rather than a function agreeing with itself. Under MIP-0018 the independent authority
          // is the runtime the MIP names (`@midnight-ntwrk/compact-runtime` 0.19.0, whose
          // `Uint<8·N>` is little-endian); under the draft it is the plain big-endian reading of
          // the recorded hex.
          const expectedNumber = c.variant === "mip-0018"
            ? new CompactTypeUnsignedInteger((1n << BigInt(8 * e.len)) - 1n, e.len)
              .fromValue([Buffer.from(e.valueHex, "hex")] as never).toString(10)
            : BigInt(`0x${e.valueHex === "" ? "0" : e.valueHex}`).toString(10);
          expect(integerOfValue(parsed.valueBytes, c.variant), label).toBe(expectedNumber);
        }
      }
      // The domain separator's readable text is what the contract's own matrix says it is.
      expect(Buffer.from(e.domainSepHex, "hex").toString("utf8").replace(/\0+$/, "")).toBe(e.domainSepText);
      // Everything the contracts emit follows Appendix A, so nothing here should be flagged.
      expect(parsed.projectionError, label).toBeUndefined();
    }

    // The declarations that need more than one part — the reason the standard's corpus exists in
    // this shape (spec 00024 US3: a ~700-byte document in 3 parts, a ~400-byte description in 2).
    expect(c.declarations.filter((d) => d.partPayloadsHex.length > 1)
      .map((d) => [d.row, d.keyText, d.len, d.partPayloadsHex.length]), `${c.dir} long declarations`)
      .toEqual(c.longDeclarations);

    // The corpus really does exercise the kind bytes the templates use and every value type this
    // name has — which is where Null shows up under the standard and nowhere else.
    expect(new Set(c.declarations.map((e) => e.kind)), c.dir).toEqual(new Set([0, 1, 2]));
    expect([...new Set(c.declarations.map((e) => e.valType))].sort((a, b) => a - b), c.dir)
      .toEqual(c.valTypes);
    // How this corpus's SNEB publishes its document — one complete value under the standard (a
    // long one is a [Y] package since UC-1, never `metadata/<n>` keys), six fragments under the draft.
    const keys = new Set(c.declarations.map((e) => e.keyText));
    for (const key of c.snebMetadataKeys) expect(keys.has(key), `${c.dir} ${key}`).toBe(true);
    expect(keys.has("tokenUri"), c.dir).toBe(true);
    // The types the contracts emit each projected key with. `decimals` is where the widths differ:
    // one big-endian byte under the draft, a little-endian `Uint<128>` under the standard.
    const typeOf = (key: string): number[] =>
      [...new Set(c.declarations.filter((e) => e.keyText === key).map((e) => e.valType))];
    expect(typeOf("name"), c.dir).toEqual([1]);
    expect(typeOf("symbol"), c.dir).toEqual([1]);
    expect(typeOf("decimals"), c.dir).toEqual([2]);
    expect(typeOf("tokenUri"), c.dir).toEqual([4]);
    const decimalsLens = [...new Set(c.declarations.filter((e) => e.keyText === "decimals").map((e) => e.len))];
    expect(decimalsLens, `${c.dir} decimals width`).toEqual([c.variant === "mip-0018" ? 16 : 1]);
    if (c.variant === "mip-0018") {
      // Appendix A's own example, emitted by a real contract: 6 as `Uint<128>`.
      const six = c.declarations.find((e) => e.keyText === "decimals" && e.valueHex.startsWith("06"));
      expect(six, "a contract emitting decimals = 6").toBeDefined();
      expect(six!.valueHex).toBe("06000000000000000000000000000000");
      expect(integerOfValue(new Uint8Array(Buffer.from(six!.valueHex, "hex")), "mip-0018")).toBe("6");
      // …and a Null, which only this name has.
      const nulled = c.declarations.filter((e) => e.valType === 5);
      expect(nulled.length, "the corpus must exercise Null").toBeGreaterThan(0);
      for (const n of nulled) {
        expect(n.len, `${n.row} Null val-len`).toBe(0);
        expect(n.valueHex, `${n.row} Null bytes`).toBe("");
        expect(parseTokenMetadata(new Uint8Array(Buffer.from(n.payloadHex, "hex")), "mip-0018").clears)
          .toBe(true);
      }
      // A `/metadata/` pointer key, accepted as an ordinary trait and NOT as an assembly rule.
      const pointer = c.declarations.filter((e) => (e.keyText ?? "").startsWith("/metadata/"));
      expect(pointer.length, "the corpus must exercise a pointer key").toBeGreaterThan(0);
      // The MIP-18 set's own key: every contract that declares anything says where its source is
      // (val-type 4, one part) — owner Q19 (b): "where possible", so SGHOST18 declares nothing.
      const repos = c.declarations.filter((e) => e.keyText === "repository");
      expect(repos.length, "a repository declaration per described row").toBeGreaterThan(0);
      for (const r of repos) {
        expect(r.valType, `${r.row} repository val-type`).toBe(4);
        expect(r.valueText, `${r.row} repository`).toBe(
          `https://github.com/acedward/mip-0018-midnight-contracts/blob/main/contracts/generated/${r.row}.compact`);
      }
      expect(c.declarations.filter((e) => e.row === "SGHOST18"), "SGHOST18 declares nothing").toEqual([]);
    } else {
      expect(typeOf("metadata/0"), c.dir).toEqual([3]);
    }
  }

  it("[[token-contract-negatives]] every deliberately awkward payload of BOTH corpora lands where the MIP says: ignored, rejected with its reason, or applied (with or without a projection failure)", () => {
    for (const c of CORPORA) negativesCorpus(c);
    // The standard's corpus is strictly the more demanding one, and one of its extra reject
    // reasons is a rule that did not exist before: a `/metadata/` key that is not a pointer.
    const [final, legacy] = CORPORA;
    expect(final.negatives.count).toBeGreaterThan(legacy.negatives.count);
    expect(final.rejectReasons).toContain("key_pointer_invalid");
    expect(legacy.rejectReasons).not.toContain("key_pointer_invalid");
    // …and UC-1's own cases are multi-part packages, which the draft cannot express at all.
    expect(final.negatives.payloads.filter((n) => (n.parts ?? 1) > 1).length).toBeGreaterThan(0);
    expect(legacy.negatives.payloads.filter((n) => (n.parts ?? 1) > 1)).toEqual([]);
  });

  function negativesCorpus(c: Corpus): void {
    expect(c.negatives.payloads, c.dir).toHaveLength(c.negatives.count);
    const seen: Record<string, number> = { ignored: 0, rejected: 0, applied: 0 };

    for (const n of c.negatives.payloads) {
      seen[n.expect] = (seen[n.expect] ?? 0) + 1;
      const label = `${c.dir}: ${n.why} (MIP §${n.mipSection})`;
      // A negative is a package too: its bytes are its parts in order, 256 bytes each.
      const parts = n.partPayloadsHex ?? [n.payloadHex];
      expect(parts, label).toHaveLength(n.parts ?? 1);
      expect(parts.join(""), `${label}: the package is its parts`).toBe(n.payloadHex);
      expect(n.payloadHex.length, `${label}: 256 bytes per part`).toBe(512 * parts.length);

      if (n.expect === "ignored") {
        // MIP §1: "Events of another type or name … MUST be ignored by a v1 consumer." The corpus
        // records the STANDARD's verdict, and this consumer diverges from it in exactly one place,
        // deliberately — so the two cases are asserted apart rather than lumped together.
        const hex = Buffer.from(pad32(n.eventName)).toString("hex");
        if (n.eventName === LEGACY_EVENT_NAME) {
          // Owner decision Q27: the Stagenet reference set is deployed under the draft name and is
          // NOT being redeployed, so THIS consumer recognises it — under the draft's own rules —
          // for demonstrative purposes. A conforming MIP-0018 consumer ignores it, which is what
          // the corpus says, and the divergence is stated here rather than hidden in a skip.
          expect(nameVariantOf(hex), label).toBe("legacy-mip-xxxx");
          expect(isTokenMetadataName(hex), label).toBe(true);
          const parsed = parseTokenMetadata(
            new Uint8Array(Buffer.from(n.payloadHex, "hex")), "legacy-mip-xxxx",
          );
          // …and the bytes really are valid under those rules, which is the whole point of keeping
          // the path: an ignored event here would still be a displayable one there.
          expect(parsed.applied, `${label} under the draft's own rules`).toBe(true);
          continue;
        }
        // The pre-MIP name project 00020 shipped: ignored by both validators, so its bytes are
        // never looked at at all and the NAME is the only assertion that matters.
        expect(n.eventName, label).toBe("TokenMetadata");
        expect(nameVariantOf(hex), label).toBeUndefined();
        expect(isTokenMetadataName(hex), label).toBe(false);
        continue;
      }

      const parsed = parseTokenMetadata(
        new Uint8Array(Buffer.from(n.payloadHex, "hex")), variantOfFixture(n.eventName),
      );
      if (n.expect === "rejected") {
        expect(parsed.applied, `${label} should be rejected`).toBe(false);
        expect(parsed.rejectReason, label).toBe(n.reason);
        continue;
      }

      // "applied": the event counts as a declaration whatever our projections think of it (MIP
      // §5.2 — a transport-valid declaration is accepted even if its key is unknown).
      expect(parsed.applied, `${label} should be applied: ${parsed.rejectReason}`).toBe(true);
      expect(parsed.rejectReason, label).toBeUndefined();
      if (n.projectionFails === true) {
        expect(parsed.projectionError, `${label} should fail its projection`).toBeDefined();
      } else {
        expect(parsed.projectionError, `${label} should project cleanly`).toBeUndefined();
      }
    }

    // The corpus covers every reject reason this name's transport defines, and both halves of the
    // "applied" case.
    expect(seen, c.dir).toEqual(c.negatives.outcomes);
    const reasons = new Set(c.negatives.payloads.filter((n) => n.expect === "rejected").map((n) => n.reason));
    expect(reasons, `${c.dir} reject reasons`).toEqual(new Set<RejectReason>(c.rejectReasons));
    const projectionErrors = new Set<ProjectionError | undefined>(
      c.negatives.payloads
        .filter((n) => n.expect === "applied" && n.projectionFails === true)
        .map((n) => parseTokenMetadata(
          new Uint8Array(Buffer.from(n.payloadHex, "hex")), variantOfFixture(n.eventName),
        ).projectionError),
    );
    expect(projectionErrors.size, c.dir).toBeGreaterThanOrEqual(4);
    expect(projectionErrors.has("val_type_mismatch"), c.dir).toBe(true);
  }

  it("[[token-contract-colors]] every colour the contracts' own tokenColor() produced is reproduced from the domain separator and the address alone — under both names, because a colour is not part of what the standard changed", () => {
    for (const c of CORPORA) {
      expect(c.colorVectors.vectors, c.dir).toHaveLength(c.colorVectors.count);
      for (const v of c.colorVectors.vectors) {
        expect(tokenColorHex(v.domainSepHex, v.contractAddress), `${c.dir} ${v.row} (${v.domainSepText})`)
          .toBe(v.colorHex);
      }
      // And the colour each minted coin actually carried.
      for (const m of c.mints.mints) {
        expect(tokenColorHex(m.domainSepHex, m.contractAddress), `${c.dir} ${m.row} mint`).toBe(m.colorHex);
        // A mint is native by definition (MIP §6.3), so its kind byte is 0 or 1 and nothing else.
        expect([0, 1], c.dir).toContain(m.kindByte);
      }
      // A ledger row still has a DERIVABLE colour — it is simply not stored, because MIP §3 forbids
      // presenting one for a ledger kind. The corpus says so explicitly.
      const ledgerVectors = c.colorVectors.vectors.filter((v) => v.source.includes("no colour exists"));
      expect(ledgerVectors.length, c.dir).toBeGreaterThan(0);
      for (const v of ledgerVectors) {
        const rows = c.expectedTokens.tokens.filter(
          (t) => t.domainSepHex === v.domainSepHex && t.contractAddress === v.contractAddress && t.storage === "ledger");
        expect(rows.length, `${c.dir} ${v.row} must have a ledger row`).toBeGreaterThan(0);
        for (const row of rows) expect(row.colorHex, `${c.dir} ${v.row} must store no colour`).toBeNull();
      }
    }
  });

  describe("replayed through the fold", () => {
    let container: StartedPostgreSqlContainer;
    /** One container, one client per corpus: each corpus replays into its OWN schema, so the two
     *  transports never share a row — and the gate's container pressure does not change (issue
     *  00018), because a schema is free and a Testcontainers Postgres is not. */
    const clients = new Map<string, UmbraDBSql>();

    beforeAll(async () => {
      container = await new PostgreSqlContainer("postgres:17-alpine").start();
      for (const c of CORPORA) {
        const sql = createClient({ connectionString: container.getConnectionUri(), schema: c.schema });
        clients.set(c.dir, sql);
        await bootstrapTokenIndexSchema(sql, { schema: c.schema, net: NET });

        // Mints first, then events in emission order — and the expected rows must come out the same
        // either way, because `recomputeToken` derives status from the evidence rather than from the
        // order it arrived in. (`status-rules.test.ts` proves the order-independence directly.)
        for (const [index, m] of c.mints.mints.entries()) {
          const observed: ObservedMint = {
            segment: 0, callIndex: index, address: m.contractAddress, domainSep: m.domainSepHex,
            kind: m.kindByte, amount: BigInt(m.amount), entryPoint: m.op, section: "guaranteed",
          };
          await sql.begin(async (tx) => applyMint(tx, c.schema, NET, observed, {
            txHash: (m.contractAddress.slice(-56) + index.toString(16).padStart(8, "0")),
            blockHeight: 1_000 + index, txPosition: 0,
          }));
        }
        for (const e of [...c.declarations].sort((a, b) => a.id - b.id)) {
          const mip0018 = variantOfFixture(e.eventName) === "mip-0018";
          const event: RawContractEvent = {
            eventId: e.id + 1, // the indexer's ids are positive; a package's id is its first part's (P1)
            contractAddress: e.contractAddress,
            // The standard's corpus records a transaction stand-in per circuit call; the draft's
            // does not, so one is made from the address and the event id.
            txHash: e.txStandIn ?? (e.contractAddress.slice(-56) + e.id.toString(16).padStart(8, "0")),
            blockHeight: 2_000 + e.id,
            // The declaration's OWN recorded name, so the fold picks the validator the chain would.
            nameHex: nameHexOf(variantOfFixture(e.eventName)),
            // Under the standard's name every declaration is a [Y] package (migration 005): the
            // merged `256·k` bytes, every part's id, and — the simulator runs each circuit call as
            // one guaranteed intent — segment 1, phase guaranteed.
            payloadHex: e.payloadHex,
            ...(mip0018
              ? { partEventIds: e.partEventIds.map((id) => id + 1), segment: 1, phase: "guaranteed" as const }
              : {}),
          };
          await sql.begin(async (tx) => applyMetadataEvent(tx, c.schema, NET, event));
        }
      }
    }, 300_000);

    afterAll(async () => {
      for (const sql of clients.values()) await sql.end({ timeout: 5 });
      await container?.stop();
    }, 60_000);

    it("[[token-contract-rows]] produces exactly the 17 rows the contracts expect from EITHER corpus — the standard's replayed as [Y] packages — over 17 identities and MIP §7.2's three states", async () => {
      for (const c of CORPORA) await rowsCorpus(c);
      // The point of keeping both: the deployed draft-name set and the regenerated standard set
      // fold to the same table. Two transports, one token list.
      // (The standard's rows are the reference rows' `…18` variant: the symbol carries the suffix.)
      const [final, legacy] = CORPORA;
      const shape = async (c: Corpus): Promise<string[]> => {
        const sql = clients.get(c.dir)!;
        const rows = await sql<{ symbol: string | null; kind: number; status: string; decimals: number | null }[]>`
          SELECT symbol, kind, status, decimals FROM ${sql(c.schema)}.tokens
          WHERE net = ${NET} AND status <> 'builtin'
        `;
        return rows.map((r) => JSON.stringify([r.symbol === null ? null : baseRow(c, r.symbol), r.kind, r.status, r.decimals]))
          .sort();
      };
      expect(await shape(final)).toEqual(await shape(legacy));
    }, 240_000);

    async function rowsCorpus(c: Corpus): Promise<void> {
      const sql = clients.get(c.dir)!;
      const schema = c.schema;
      const expectedTokens = c.expectedTokens;
      const rows = await sql<{
        address: Buffer; domain_sep: Buffer; kind: number; privacy: string; storage: string;
        color: Buffer | null; name: string | null; symbol: string | null; decimals: number | null;
        token_uri: string | null; metadata: unknown; status: string; mint_count: string; total_minted: string;
      }[]>`
        SELECT address, domain_sep, kind, privacy, storage, color, name, symbol, decimals, token_uri,
               metadata, status, mint_count::text, total_minted::text
        FROM ${sql(schema)}.tokens WHERE net = ${NET} AND status <> 'builtin'
      `;
      expect(rows).toHaveLength(expectedTokens.count);
      expect(expectedTokens.count).toBe(17);
      expect(expectedTokens.identities).toBe(17);

      for (const want of expectedTokens.tokens) {
        const got = rows.find((r) =>
          r.address.toString("hex") === want.contractAddress
          && r.domain_sep.toString("hex") === want.domainSepHex
          && r.kind === want.kind);
        expect(got, `${want.row} / ${want.domainSepText} / kind ${want.kind}`).toBeDefined();
        const label = `${want.row} (${want.domainSepText}, kind ${want.kind})`;
        expect(got!.status, `${label} status`).toBe(want.status);
        expect(got!.privacy, `${label} privacy`).toBe(want.privacy);
        expect(got!.storage, `${label} storage`).toBe(want.storage);
        expect(got!.color === null ? null : got!.color.toString("hex"), `${label} colour`).toBe(want.colorHex);
        expect(got!.name, `${label} name`).toBe(want.name ?? null);
        expect(got!.symbol, `${label} symbol`).toBe(want.symbol ?? null);
        expect(got!.decimals, `${label} decimals`).toBe(want.decimals ?? null);
        expect(got!.token_uri, `${label} tokenUri`).toBe(want.tokenUri ?? null);
        // A JSON-object `metadata` is projected whole — for the standard's corpus from ONE
        // multi-part declaration (SNEB18: 677 bytes in 3 parts, CNST18 Orion: 279 bytes in 2).
        if (want.metadata !== undefined) expect(got!.metadata, `${label} metadata`).toEqual(want.metadata);
        expect(Number(got!.mint_count), `${label} mintCount`).toBe(want.mintCount);
        expect(got!.total_minted, `${label} totalMinted`).toBe(want.totalMinted);

        // Every trait the contracts recorded is stored with the bytes AND the type they recorded.
        const kv = await sql<{
          key_text: string | null; key_hex: string; val_type: number; val_len: number;
          value: Buffer; projection_error: string | null;
        }[]>`
          SELECT key_text, key_hex, val_type, val_len, value, projection_error
          FROM ${sql(schema)}.token_metadata_kv
          WHERE net = ${NET} AND address = ${got!.address} AND domain_sep = ${got!.domain_sep}
            AND kind = ${want.kind}
        `;
        const stored = new Map(kv.map((k) => [k.key_text ?? `hex:${k.key_hex}`, k]));
        for (const [key, trait] of Object.entries(want.traits)) {
          const row = stored.get(key);
          expect(row, `${label} trait ${key}`).toBeDefined();
          expect(row!.val_type, `${label} trait ${key} val-type`).toBe(trait.valType);
          expect(row!.val_len, `${label} trait ${key} val-len`).toBe(trait.valLen);
          expect(row!.value.toString("hex"), `${label} trait ${key} bytes`).toBe(trait.valueHex);
          // Nothing the reference contracts emit breaks Appendix A.
          expect(row!.projection_error, `${label} trait ${key} projection`).toBeNull();
        }
      }

      // MIP §7.2's three states, and only those three, are what the corpus covers.
      expect(new Set(rows.map((r) => r.status))).toEqual(new Set(["observed", "declared", "described"]));
      const statusCounts: Record<string, number> = {};
      for (const r of rows) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
      expect(statusCounts).toEqual(expectedTokens.statusCounts);
      // Every row is a distinct identity, and the corpus's own count of shared pairs holds.
      const identities = new Set(rows.map((r) => `${r.address.toString("hex")}/${r.domain_sep.toString("hex")}/${r.kind}`));
      expect(identities.size).toBe(expectedTokens.identities);
      const pairs = new Set(rows.map((r) => `${r.address.toString("hex")}/${r.domain_sep.toString("hex")}`));
      expect(pairs.size).toBe(expectedTokens.addressDomainPairs);

      // The two shapes the standard is most likely to get wrong:
      //  - "Ledger Liar" declares kind 2 (unshielded LEDGER) and mints kind 0 (unshielded NATIVE).
      //    MIP §6.3 makes those two tokens: an observed row with no name and a declared row with
      //    one. Nothing is flagged, and the mint is never hidden.
      const liar = expectedTokens.tokens.filter((t) => baseRow(c, t.row) === "LLIAR");
      expect(liar.map((t) => [t.kind, t.status, t.name ?? null])).toEqual([
        [0, "observed", null],
        [2, "declared", `Ledger Liar${c.nameSuffix}`],
      ]);
      const liarRows = rows.filter((r) => r.address.toString("hex") === liar[0]!.contractAddress);
      expect(liarRows).toHaveLength(2);
      expect(liarRows.find((r) => r.kind === 0)!.color).not.toBeNull();
      expect(liarRows.find((r) => r.kind === 2)!.color).toBeNull();
      //  - "Dual Aurora" mints the SAME domain separator both shielded and unshielded: two rows,
      //    one 32-byte colour, both described.
      const dual = expectedTokens.tokens.filter((t) => baseRow(c, t.row) === "DAUR");
      expect(dual).toHaveLength(2);
      expect(dual[0]!.colorHex).toBe(dual[1]!.colorHex);
      expect(new Set(dual.map((t) => t.kind))).toEqual(new Set([0, 1]));

      // SNEB's document projects from EITHER corpus, by two different routes: one complete JSON
      // value under the standard, a six-part assembly under the draft (MIP-0018 §5.4 defines no
      // reassembly at all — see `[[token-0018-no-multipart]]`).
      const sneb = rows.find((r) => r.symbol === `SNEB${c.rowSuffix}`)!;
      expect(sneb.metadata, `${c.dir} SNEB metadata`).not.toBeNull();
      expect(typeof sneb.metadata, c.dir).toBe("object");
      const snebKeys = await sql<{ key_text: string; val_type: number }[]>`
        SELECT key_text, val_type FROM ${sql(schema)}.token_metadata_kv
        WHERE net = ${NET} AND address = ${sneb.address} AND domain_sep = ${sneb.domain_sep}
          AND kind = ${sneb.kind} AND key_text LIKE '%metadata%' ORDER BY key_text`;
      expect(snebKeys.map((k) => k.key_text).sort(), `${c.dir} SNEB metadata keys`)
        .toEqual([...c.snebMetadataKeys].sort());

      // Every kv row carries the variant of the event that set it, and one corpus is one name.
      const variants = await sql<{ name_variant: string; n: string }[]>`
        SELECT name_variant, count(*)::text AS n FROM ${sql(schema)}.token_metadata_kv
        WHERE net = ${NET} GROUP BY name_variant`;
      expect(variants.map((v) => v.name_variant), `${c.dir} kv variants`).toEqual([c.variant]);

      if (c.variant === "mip-0018") {
        // The corpus's Null: LMOON18 declares a short `description`, clears it with a Null, then
        // declares a 377-byte one in two parts. History keeps all three packages in emission order
        // (every one applied), and the CURRENT value — the one `expected-tokens.json` lists and the
        // trait loop above matched byte for byte — is the last. (A Null that stays current is a
        // tombstone: `[[token-0018-null-clears]]` in `status-rules.test.ts`.)
        const lmoon = expectedTokens.tokens.find((t) => t.row === "LMOON18")!;
        const history = await sql<{ val_type: number; val_len: number; parts: number; applied: boolean }[]>`
          SELECT val_type, val_len, parts, applied FROM ${sql(schema)}.token_metadata_events
          WHERE net = ${NET} AND address = ${Buffer.from(lmoon.contractAddress, "hex")}
            AND key_text = 'description' ORDER BY block_height, tx_position, event_id`;
        expect(history, "LMOON18 description history").toEqual([
          { val_type: 1, val_len: 52, parts: 1, applied: true },
          { val_type: 5, val_len: 0, parts: 1, applied: true },
          { val_type: 1, val_len: 377, parts: 2, applied: true },
        ]);
        expect(lmoon.traits.description!.valLen).toBe(377);
        // Every stored package keeps its part count: the three long declarations, and nothing else.
        const long = await sql<{ key_text: string; val_len: number; parts: number }[]>`
          SELECT key_text, val_len, parts FROM ${sql(schema)}.token_metadata_events
          WHERE net = ${NET} AND parts > 1 ORDER BY event_id`;
        expect(long.map((l) => [l.key_text, l.val_len, l.parts]))
          .toEqual(c.longDeclarations.map(([, key, len, parts]) => [key, len, parts]));
      }

      // Zero rejected events in the whole corpus (SC-101): everything the contracts emit is valid
      // under the name they emit it with, which is the claim this whole pair of corpora makes.
      const rejected = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM ${sql(schema)}.token_metadata_events
        WHERE net = ${NET} AND NOT applied`;
      expect(rejected[0]!.n, c.dir).toBe("0");
    }
  });
});
