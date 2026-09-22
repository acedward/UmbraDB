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
 * The golden corpora produced by the REAL COMPILED reference contracts of
 * `acedward/mip-erc7496-midnight-contracts`, executed in the Compact simulator in process.
 *
 * Nothing here is hand-written, and there are now **two** corpora, because there are two event
 * names and two validators (owner decision Q27):
 *
 *  - `fixtures/contracts/` — **MIP-0018**, the standard: 66 `mip-0018:token-metadata[v1]` events,
 *    16 mints, 15 colour vectors, 17 expected rows, 32 awkward payloads. Re-pinned on that
 *    repository's `main` @ `7d9f659`.
 *  - `fixtures/contracts-legacy/` — the **superseded PR #315 draft**: 69
 *    `mip-xxxx:token-metadata[v1]` events and the rest of that set, frozen. This is what the
 *    Stagenet reference set actually emits, and it is not being redeployed.
 *
 * Each `SOURCE.md` pins its repository, branch and commit, and tabulates the differences. Every one
 * of this file's four governed ids runs over BOTH, which is what makes the pair a regression test
 * for "two names, two validators" rather than two unrelated fixtures: the same eleven contracts,
 * the same 17 rows, two transports.
 *
 * So this is the test that decides whether this indexer and those contracts actually agree —
 * `payload-0018.test.ts` and `payload.test.ts` prove the parser's own rules for each name, this
 * proves the parser reads what the contracts really emit.
 *
 * The simulator has no chain, so a corpus carries no block heights, transaction hashes or indexer
 * event ids; this test supplies them (emission order → event id → synthetic height). Everything
 * that matters — the bytes, the domain separators, the colours, the amounts — is the contracts'.
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

interface FixtureEvent {
  row: string; eventId: number; step: number; op: string;
  contractAddress: string; eventName: string; payloadHex: string;
  domainSepHex: string; domainSepText: string; kind: number;
  keyText: string | null; keyHex: string; valType: number; len: number;
  valueHex: string; valueText: string | null;
}
interface FixtureMint {
  row: string; step: number; op: string; contractAddress: string;
  domainSepHex: string; kindByte: 0 | 1; kind: string; amount: string; colorHex: string;
}
interface FixtureColorVector {
  row: string; contractAddress: string; domainSepHex: string; domainSepText: string;
  colorHex: string; source: string;
}
interface FixtureTrait { valType: number; valLen: number; valueHex: string; text: string | null }
interface FixtureExpectedToken {
  row: string; contractAddress: string; domainSepHex: string; domainSepText: string;
  kind: number; privacy: string; storage: string; colorHex: string | null;
  traits: Record<string, FixtureTrait>;
  name?: string; symbol?: string; decimals?: number; tokenUri?: string;
  mintCount: number; totalMinted: string; status: string;
}
interface FixtureNegative {
  why: string; mipSection: string; expect: "ignored" | "rejected" | "applied";
  reason?: RejectReason; projectionFails?: boolean;
  contractAddress: string; eventName: string; payloadHex: string;
  kind: number; keyHex: string; keyText: string | null; valType: number; len: number;
}

interface Corpus {
  /** The variant every event in this corpus carries — asserted per event, not assumed. */
  variant: NameVariant;
  /** The event name string, for the label and for the per-event assertion. */
  eventName: string;
  /** The directory under `fixtures/`, and the Postgres schema its fold replay uses. */
  dir: string;
  schema: string;
  /** The corpus's own event count, pinned so a silently shrunk corpus fails rather than passes. */
  eventCount: number;
  /** The `val-type`s the contracts exercise under this name — 5 (Null) exists only under 0018. */
  valTypes: number[];
  /** The transport reject reasons the negatives cover — `key_pointer_invalid` is 0018-only. */
  rejectReasons: RejectReason[];
  /** How this corpus's SNEB publishes its document, which is the multipart rule made concrete. */
  snebMetadataKeys: string[];
  events: { count: number; events: FixtureEvent[] };
  mints: { count: number; mints: FixtureMint[] };
  colorVectors: { count: number; vectors: FixtureColorVector[] };
  expectedTokens: {
    count: number; identities: number; addressDomainPairs: number;
    statusCounts: Record<string, number>; tokens: FixtureExpectedToken[];
  };
  negatives: { count: number; outcomes: Record<string, number>; payloads: FixtureNegative[] };
}

function corpus(
  spec: Pick<Corpus, "variant" | "eventName" | "dir" | "schema" | "eventCount" | "valTypes"
  | "rejectReasons" | "snebMetadataKeys">,
): Corpus {
  return {
    ...spec,
    events: read(spec.dir, "events.json"),
    mints: read(spec.dir, "mints.json"),
    colorVectors: read(spec.dir, "color-vectors.json"),
    expectedTokens: read(spec.dir, "expected-tokens.json"),
    negatives: read(spec.dir, "negative-payloads.json"),
  };
}

/**
 * The two corpora, with the handful of numbers that DIFFER stated here rather than read out of the
 * fixtures — a count taken from the file it is checking proves nothing, and the whole value of
 * keeping both corpora is that these differences are the final text's changes made concrete.
 */
const CORPORA: readonly Corpus[] = [
  corpus({
    variant: "mip-0018", eventName: MIP_0018_EVENT_NAME,
    dir: "contracts", schema: "token_contract_fixtures",
    eventCount: 66,
    // 5 is Null: LMOON clears its `description` with one.
    valTypes: [1, 2, 3, 4, 5],
    rejectReasons: [
      "kind_unknown", "key_empty", "key_pointer_invalid", "val_type_reserved", "val_len_too_long",
      "val_type_rule",
    ],
    // ONE complete JSON value (§5.4 defines no reassembly), plus a pointer key that is just a key.
    snebMetadataKeys: ["metadata", "/metadata/description"],
  }),
  corpus({
    variant: "legacy-mip-xxxx", eventName: LEGACY_EVENT_NAME,
    dir: "contracts-legacy", schema: "token_contract_fixtures_legacy",
    eventCount: 69,
    valTypes: [1, 2, 3, 4],
    rejectReasons: [
      "kind_unknown", "key_empty", "val_type_reserved", "val_len_too_long", "val_type_rule",
    ],
    // A six-part document of JSON fragments — the draft's Appendix A convention.
    snebMetadataKeys: ["metadata/0", "metadata/1", "metadata/2", "metadata/3", "metadata/4", "metadata/5"],
  }),
];

const NET = "stagenet";

describe("the compiled reference contracts' recorded corpus", () => {
  it("[[token-contract-golden]] parses every emitted payload of BOTH corpora byte for byte, exactly as the contracts recorded them", () => {
    for (const c of CORPORA) {
      goldenCorpus(c);
    }
    // The two corpora really are two transports of the same eleven contracts: the same rows over
    // the same identities, from different bytes under different rules.
    const [final, legacy] = CORPORA;
    expect(final!.events.count).not.toBe(legacy!.events.count);
    expect(final!.expectedTokens.count).toBe(legacy!.expectedTokens.count);
    expect(final!.expectedTokens.identities).toBe(legacy!.expectedTokens.identities);
    expect(final!.expectedTokens.addressDomainPairs).toBe(legacy!.expectedTokens.addressDomainPairs);
    expect(final!.expectedTokens.statusCounts).toEqual(legacy!.expectedTokens.statusCounts);
    // …and the colours are identical, because a colour is a function of `(domainSep, address)` and
    // neither of those is in the part of the payload the standard changed.
    expect(final!.colorVectors.vectors.map((v) => v.colorHex))
      .toEqual(legacy!.colorVectors.vectors.map((v) => v.colorHex));
  });

  function goldenCorpus(c: Corpus): void {
    expect(c.events.events, c.dir).toHaveLength(c.events.count);
    expect(c.events.count, `${c.dir} event count`).toBe(c.eventCount);
    for (const e of c.events.events) {
      // MIP §1/§8: the name is the version, and every event of a corpus carries exactly one name.
      expect(e.eventName, `${e.row}#${e.eventId} event name`).toBe(c.eventName);
      expect(variantOfFixture(e.eventName), `${e.row}#${e.eventId} variant`).toBe(c.variant);
      expect(isTokenMetadataName(nameHexOf(c.variant))).toBe(true);

      const bytes = Buffer.from(e.payloadHex, "hex");
      expect(bytes, `${e.row}#${e.eventId} payload width`).toHaveLength(256);
      const parsed = parseTokenMetadata(new Uint8Array(bytes), variantOfFixture(e.eventName));
      expect(parsed.applied, `${e.row}#${e.eventId} (${e.keyText}) was rejected: ${parsed.rejectReason}`).toBe(true);
      expect(Buffer.from(parsed.domainSep).toString("hex")).toBe(e.domainSepHex);
      expect(parsed.kindByte).toBe(e.kind);
      expect(parsed.keyText ?? null).toBe(e.keyText);
      expect(parsed.keyHex).toBe(trimmedKeyHex(e.keyHex));
      expect(e.keyHex.length, `${e.row}#${e.eventId} key field width`).toBe(64);
      expect(parsed.valType).toBe(e.valType);
      expect(parsed.valLen).toBe(e.len);
      expect(Buffer.from(parsed.valueBytes).toString("hex")).toBe(e.valueHex);
      // The corpus renders `valueText` as "these bytes decoded as UTF-8 if they can be", whatever
      // the type; this consumer renders text only for the TEXTUAL types (MIP §5.2: "render unknown
      // keys according to their val-type"), so an integer has no text and a number instead.
      if (e.valType === 1 || e.valType === 3 || e.valType === 4) {
        if (e.valueText !== null) expect(parsed.valueText).toBe(e.valueText);
      } else {
        expect(parsed.valueText, `${e.row}#${e.eventId} type ${e.valType} has no text`).toBeUndefined();
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
          expect(integerOfValue(parsed.valueBytes, c.variant), `${e.row}#${e.eventId} ${e.keyText}`)
            .toBe(expectedNumber);
        }
      }
      // The domain separator's readable text is what the contract's own matrix says it is.
      expect(Buffer.from(e.domainSepHex, "hex").toString("utf8").replace(/\0+$/, "")).toBe(e.domainSepText);
      // Everything the contracts emit follows Appendix A, so nothing here should be flagged.
      expect(parsed.projectionError, `${e.row}#${e.eventId} (${e.keyText})`).toBeUndefined();
    }

    // The corpus really does exercise the kind bytes the templates use and every value type this
    // name has — which is where Null shows up under the standard and nowhere else.
    expect(new Set(c.events.events.map((e) => e.kind)), c.dir).toEqual(new Set([0, 1, 2]));
    expect([...new Set(c.events.events.map((e) => e.valType))].sort((a, b) => a - b), c.dir)
      .toEqual(c.valTypes);
    // How this corpus's SNEB publishes its document — one complete value under the standard, six
    // fragments under the draft (MIP-0018 §5.4 defines no reassembly at all).
    const keys = new Set(c.events.events.map((e) => e.keyText));
    for (const key of c.snebMetadataKeys) expect(keys.has(key), `${c.dir} ${key}`).toBe(true);
    expect(keys.has("tokenUri"), c.dir).toBe(true);
    // The types the contracts emit each projected key with. `decimals` is where the widths differ:
    // one big-endian byte under the draft, a little-endian `Uint<128>` under the standard.
    const typeOf = (key: string): number[] =>
      [...new Set(c.events.events.filter((e) => e.keyText === key).map((e) => e.valType))];
    expect(typeOf("name"), c.dir).toEqual([1]);
    expect(typeOf("symbol"), c.dir).toEqual([1]);
    expect(typeOf("decimals"), c.dir).toEqual([2]);
    expect(typeOf("tokenUri"), c.dir).toEqual([4]);
    const decimalsLens = [...new Set(c.events.events.filter((e) => e.keyText === "decimals").map((e) => e.len))];
    expect(decimalsLens, `${c.dir} decimals width`).toEqual([c.variant === "mip-0018" ? 16 : 1]);
    if (c.variant === "mip-0018") {
      // Appendix A's own example, emitted by a real contract: 6 as `Uint<128>`.
      const six = c.events.events.find((e) => e.keyText === "decimals" && e.valueHex.startsWith("06"));
      expect(six, "a contract emitting decimals = 6").toBeDefined();
      expect(six!.valueHex).toBe("06000000000000000000000000000000");
      expect(integerOfValue(new Uint8Array(Buffer.from(six!.valueHex, "hex")), "mip-0018")).toBe("6");
      // …and a Null, which only this name has.
      const nulled = c.events.events.filter((e) => e.valType === 5);
      expect(nulled.length, "the corpus must exercise Null").toBeGreaterThan(0);
      for (const n of nulled) {
        expect(n.len, `${n.row} Null val-len`).toBe(0);
        expect(n.valueHex, `${n.row} Null bytes`).toBe("");
        expect(parseTokenMetadata(new Uint8Array(Buffer.from(n.payloadHex, "hex")), "mip-0018").clears)
          .toBe(true);
      }
      // A `/metadata/` pointer key, accepted as an ordinary trait and NOT as an assembly rule.
      const pointer = c.events.events.filter((e) => (e.keyText ?? "").startsWith("/metadata/"));
      expect(pointer.length, "the corpus must exercise a pointer key").toBeGreaterThan(0);
    } else {
      expect(typeOf("metadata/0"), c.dir).toEqual([3]);
    }
  }

  it("[[token-contract-negatives]] every deliberately awkward payload of BOTH corpora lands where the MIP says: ignored, rejected with its reason, or applied (with or without a projection failure)", () => {
    for (const c of CORPORA) negativesCorpus(c);
    // The standard's corpus is strictly the more demanding one, and one of its extra reject
    // reasons is a rule that did not exist before: a `/metadata/` key that is not a pointer.
    const [final, legacy] = CORPORA;
    expect(final!.negatives.count).toBeGreaterThan(legacy!.negatives.count);
    expect(final!.rejectReasons).toContain("key_pointer_invalid");
    expect(legacy!.rejectReasons).not.toContain("key_pointer_invalid");
  });

  function negativesCorpus(c: Corpus): void {
    expect(c.negatives.payloads, c.dir).toHaveLength(c.negatives.count);
    const seen: Record<string, number> = { ignored: 0, rejected: 0, applied: 0 };

    for (const n of c.negatives.payloads) {
      seen[n.expect] = (seen[n.expect] ?? 0) + 1;
      const label = `${c.dir}: ${n.why} (MIP §${n.mipSection})`;

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
        for (const e of [...c.events.events].sort((a, b) => a.eventId - b.eventId)) {
          const event: RawContractEvent = {
            eventId: e.eventId + 1, // the indexer's ids are positive
            contractAddress: e.contractAddress,
            txHash: (e.contractAddress.slice(-56) + e.eventId.toString(16).padStart(8, "0")),
            blockHeight: 2_000 + e.eventId,
            // The event's OWN recorded name, so the fold picks the validator the chain would.
            nameHex: nameHexOf(variantOfFixture(e.eventName)),
            payloadHex: e.payloadHex,
          };
          await sql.begin(async (tx) => applyMetadataEvent(tx, c.schema, NET, event));
        }
      }
    }, 300_000);

    afterAll(async () => {
      for (const sql of clients.values()) await sql.end({ timeout: 5 });
      await container?.stop();
    }, 60_000);

    it("[[token-contract-rows]] produces exactly the 17 rows the contracts expect from EITHER corpus, over 17 identities and MIP §7.2's three states", async () => {
      for (const c of CORPORA) await rowsCorpus(c);
      // The point of keeping both: the deployed draft-name set and the regenerated standard set
      // fold to the same table. Two transports, one token list.
      const [final, legacy] = CORPORA;
      const shape = async (c: Corpus): Promise<unknown[]> => {
        const sql = clients.get(c.dir)!;
        return sql<{ symbol: string | null; kind: number; status: string; decimals: number | null }[]>`
          SELECT symbol, kind, status, decimals FROM ${sql(c.schema)}.tokens
          WHERE net = ${NET} AND status <> 'builtin' ORDER BY symbol NULLS LAST, kind
        `;
      };
      expect(await shape(final!)).toEqual(await shape(legacy!));
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
      const liar = expectedTokens.tokens.filter((t) => t.row === "LLIAR");
      expect(liar.map((t) => [t.kind, t.status, t.name ?? null])).toEqual([
        [0, "observed", null],
        [2, "declared", "Ledger Liar"],
      ]);
      const liarRows = rows.filter((r) => r.address.toString("hex") === liar[0]!.contractAddress);
      expect(liarRows).toHaveLength(2);
      expect(liarRows.find((r) => r.kind === 0)!.color).not.toBeNull();
      expect(liarRows.find((r) => r.kind === 2)!.color).toBeNull();
      //  - "Dual Aurora" mints the SAME domain separator both shielded and unshielded: two rows,
      //    one 32-byte colour, both described.
      const dual = expectedTokens.tokens.filter((t) => t.row === "DAUR");
      expect(dual).toHaveLength(2);
      expect(dual[0]!.colorHex).toBe(dual[1]!.colorHex);
      expect(new Set(dual.map((t) => t.kind))).toEqual(new Set([0, 1]));

      // SNEB's document projects from EITHER corpus, by two different routes: one complete JSON
      // value under the standard, a six-part assembly under the draft (MIP-0018 §5.4 defines no
      // reassembly at all — see `[[token-0018-no-multipart]]`).
      const sneb = rows.find((r) => r.symbol === "SNEB")!;
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
        // The corpus's Null (LMOON clears `description`) survives the fold as a TOMBSTONE: the row
        // is there with `val_type 5` and no bytes, so "cleared on chain" stays distinguishable from
        // "never said", and the projected column it fed is empty. `expected-tokens.json` states
        // exactly this shape, and the trait loop above has already matched it byte for byte.
        const nulls = await sql<{ key_text: string; val_len: number; value: Buffer }[]>`
          SELECT key_text, val_len, value FROM ${sql(schema)}.token_metadata_kv
          WHERE net = ${NET} AND val_type = 5`;
        expect(nulls.length, "the corpus's Null must leave a tombstone").toBeGreaterThan(0);
        for (const n of nulls) {
          expect(n.val_len, `${n.key_text} tombstone val-len`).toBe(0);
          expect(n.value.length, `${n.key_text} tombstone bytes`).toBe(0);
        }
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
