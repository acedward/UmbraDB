import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapTokenIndexSchema } from "../bootstrap.js";
import { pad32, tokenColorHex } from "../color.js";
import type { ObservedMint } from "../ingest/decode.js";
import { applyMetadataEvent, applyMint, type RawContractEvent } from "../ingest/fold.js";
import {
  LEGACY_EVENT_NAME, LEGACY_NAME_HEX, integerOfValue, isTokenMetadataName, nameVariantOf,
  parseTokenMetadata, type NameVariant, type ProjectionError, type RejectReason,
} from "../ingest/payload.js";

/**
 * Projects 00020/00021 — the golden corpus produced by the REAL COMPILED reference contracts
 * (`acedward/mip-erc7496-midnight-contracts`, branch `feat/00021-mip-315-alignment`; see
 * `fixtures/contracts/SOURCE.md` for the exact commit).
 *
 * Nothing here is hand-written: 69 `mip-xxxx:token-metadata[v1]` payloads, 16 mints, 15 colour
 * vectors, 17 expected rows and 22 deliberately awkward payloads come out of the compiled Compact
 * templates executed in the Compact simulator. That makes this the test that decides whether this
 * indexer and those contracts actually agree about MIP PR #315 — `payload.test.ts` proves the
 * parser's own rules, this proves the parser reads what the contracts really emit.
 *
 * The simulator has no chain, so the corpus carries no block heights, transaction hashes or indexer
 * event ids; this test supplies them (emission order → event id → synthetic height). Everything
 * that matters — the bytes, the domain separators, the colours, the amounts — is the contracts'.
 */

const DIR = new URL("./fixtures/contracts/", import.meta.url);
const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(file, DIR), "utf8")) as T;

/**
 * The event name the PINNED corpus was produced under.
 *
 * `fixtures/contracts/` came out of contracts compiled with the SUPERSEDED PR #315 draft name, and
 * those are the contracts deployed on Stagenet today (owner decisions Q27/Q28: kept for the
 * demonstration, not redeployed). `SOURCE.md` records the exact commit. Re-pinning this corpus on a
 * regenerated MIP-0018 one changes **this one line** — and nothing else, because the rules each
 * payload is judged under are read from that payload's own recorded event name by
 * {@link variantOfFixture}, exactly as the indexer reads them from the event on chain.
 */
const CORPUS_EVENT_NAME = LEGACY_EVENT_NAME;

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

const events = read<{ count: number; events: FixtureEvent[] }>("events.json");
const mints = read<{ count: number; mints: FixtureMint[] }>("mints.json");
const colorVectors = read<{ count: number; vectors: FixtureColorVector[] }>("color-vectors.json");
const expectedTokens = read<{
  count: number; identities: number; addressDomainPairs: number;
  statusCounts: Record<string, number>; tokens: FixtureExpectedToken[];
}>("expected-tokens.json");
const negatives = read<{
  count: number; outcomes: Record<string, number>; payloads: FixtureNegative[];
}>("negative-payloads.json");

const NET = "stagenet";

describe("the compiled reference contracts' recorded corpus", () => {
  it("[[token-contract-golden]] parses all 69 emitted payloads byte for byte, exactly as the contracts recorded them", () => {
    expect(events.events).toHaveLength(events.count);
    expect(events.count).toBe(69);
    for (const e of events.events) {
      // MIP §1: the name is the version, and every one of these carries THIS MIP's name.
      expect(e.eventName, `${e.row}#${e.eventId} event name`).toBe(CORPUS_EVENT_NAME);
      expect(isTokenMetadataName(Buffer.from(pad32(e.eventName)).toString("hex"))).toBe(true);

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
          expect(integerOfValue(parsed.valueBytes, variantOfFixture(e.eventName)))
            .toBe(BigInt(`0x${e.valueHex === "" ? "0" : e.valueHex}`).toString(10));
        }
      }
      // The domain separator's readable text is what the contract's own matrix says it is.
      expect(Buffer.from(e.domainSepHex, "hex").toString("utf8").replace(/\0+$/, "")).toBe(e.domainSepText);
      // Everything the contracts emit follows Appendix A, so nothing here should be flagged.
      expect(parsed.projectionError, `${e.row}#${e.eventId} (${e.keyText})`).toBeUndefined();
    }

    // The corpus really does exercise the kind bytes the templates use and every Appendix A type.
    expect(new Set(events.events.map((e) => e.kind))).toEqual(new Set([0, 1, 2]));
    expect(new Set(events.events.map((e) => e.valType))).toEqual(new Set([1, 2, 3, 4]));
    // …and both the whole-document and the split-document forms of `metadata`.
    const keys = new Set(events.events.map((e) => e.keyText));
    expect(keys.has("metadata")).toBe(true);
    expect(keys.has("metadata/5")).toBe(true);
    expect(keys.has("tokenUri")).toBe(true);
    // Appendix A's types, as the contracts emit them: name/symbol 1, decimals 2, metadata 3, uri 4.
    const typeOf = (key: string): number[] =>
      [...new Set(events.events.filter((e) => e.keyText === key).map((e) => e.valType))];
    expect(typeOf("name")).toEqual([1]);
    expect(typeOf("symbol")).toEqual([1]);
    expect(typeOf("decimals")).toEqual([2]);
    expect(typeOf("metadata")).toEqual([3]);
    expect(typeOf("tokenUri")).toEqual([4]);
  });

  it("[[token-contract-negatives]] every deliberately awkward payload lands where the MIP says: ignored, rejected with its reason, or applied (with or without a projection failure)", () => {
    expect(negatives.payloads).toHaveLength(negatives.count);
    const seen = { ignored: 0, rejected: 0, applied: 0 };

    for (const n of negatives.payloads) {
      seen[n.expect] += 1;
      const label = `${n.why} (MIP §${n.mipSection})`;

      if (n.expect === "ignored") {
        // MIP §1: an event of another name is not this consumer's business at all. It is not
        // stored, not rejected, and the bytes are never even looked at — which is why the only
        // assertion that matters here is about the NAME.
        expect(isTokenMetadataName(Buffer.from(pad32(n.eventName)).toString("hex")), label).toBe(false);
        expect(n.eventName).toBe("TokenMetadata"); // the 00020 name this project itself shipped
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

      // "applied": the event counts as a declaration whatever Appendix A thinks of it (MIP §5.3).
      expect(parsed.applied, `${label} should be applied: ${parsed.rejectReason}`).toBe(true);
      expect(parsed.rejectReason, label).toBeUndefined();
      if (n.projectionFails === true) {
        expect(parsed.projectionError, `${label} should fail its projection`).toBeDefined();
      } else {
        expect(parsed.projectionError, `${label} should project cleanly`).toBeUndefined();
      }
    }

    // The corpus covers every reject reason the MIP defines for the transport, and both halves of
    // the "applied" case.
    expect(seen).toEqual(negatives.outcomes);
    const reasons = new Set(negatives.payloads.filter((n) => n.expect === "rejected").map((n) => n.reason));
    expect(reasons).toEqual(new Set<RejectReason>([
      "kind_unknown", "key_empty", "val_type_reserved", "val_len_too_long", "val_type_rule",
    ]));
    const projectionErrors = new Set<ProjectionError | undefined>(
      negatives.payloads
        .filter((n) => n.expect === "applied" && n.projectionFails === true)
        .map((n) => parseTokenMetadata(
          new Uint8Array(Buffer.from(n.payloadHex, "hex")), variantOfFixture(n.eventName),
        ).projectionError),
    );
    expect(projectionErrors.size).toBeGreaterThanOrEqual(4);
    expect(projectionErrors.has("val_type_mismatch")).toBe(true);
  });

  it("[[token-contract-colors]] every colour the contracts' own tokenColor() produced is reproduced from the domain separator and the address alone", () => {
    expect(colorVectors.vectors).toHaveLength(colorVectors.count);
    for (const v of colorVectors.vectors) {
      expect(tokenColorHex(v.domainSepHex, v.contractAddress), `${v.row} (${v.domainSepText})`).toBe(v.colorHex);
    }
    // And the colour each minted coin actually carried.
    for (const m of mints.mints) {
      expect(tokenColorHex(m.domainSepHex, m.contractAddress), `${m.row} mint`).toBe(m.colorHex);
      // A mint is native by definition (MIP §6.3), so its kind byte is 0 or 1 and nothing else.
      expect([0, 1]).toContain(m.kindByte);
    }
    // A ledger row still has a DERIVABLE colour — it is simply not stored, because MIP §3 forbids
    // presenting one for a ledger kind. The corpus says so explicitly.
    const ledgerVectors = colorVectors.vectors.filter((v) => v.source.includes("no colour exists"));
    expect(ledgerVectors.length).toBeGreaterThan(0);
    for (const v of ledgerVectors) {
      const rows = expectedTokens.tokens.filter(
        (t) => t.domainSepHex === v.domainSepHex && t.contractAddress === v.contractAddress && t.storage === "ledger");
      expect(rows.length, `${v.row} must have a ledger row`).toBeGreaterThan(0);
      for (const row of rows) expect(row.colorHex, `${v.row} must store no colour`).toBeNull();
    }
  });

  describe("replayed through the fold", () => {
    let container: StartedPostgreSqlContainer;
    let sql: UmbraDBSql;
    const schema = "token_contract_fixtures";

    beforeAll(async () => {
      container = await new PostgreSqlContainer("postgres:17-alpine").start();
      sql = createClient({ connectionString: container.getConnectionUri(), schema });
      await bootstrapTokenIndexSchema(sql, { schema, net: NET });

      // Mints first, then events in emission order — and the expected rows must come out the same
      // either way, because `recomputeToken` derives status from the evidence rather than from the
      // order it arrived in. (`status-rules.test.ts` proves the order-independence directly.)
      for (const [index, m] of mints.mints.entries()) {
        const observed: ObservedMint = {
          segment: 0, callIndex: index, address: m.contractAddress, domainSep: m.domainSepHex,
          kind: m.kindByte, amount: BigInt(m.amount), entryPoint: m.op, section: "guaranteed",
        };
        await sql.begin(async (tx) => applyMint(tx, schema, NET, observed, {
          txHash: (m.contractAddress.slice(-56) + index.toString(16).padStart(8, "0")),
          blockHeight: 1_000 + index, txPosition: 0,
        }));
      }
      for (const e of [...events.events].sort((a, b) => a.eventId - b.eventId)) {
        const event: RawContractEvent = {
          eventId: e.eventId + 1, // the indexer's ids are positive
          contractAddress: e.contractAddress,
          txHash: (e.contractAddress.slice(-56) + e.eventId.toString(16).padStart(8, "0")),
          blockHeight: 2_000 + e.eventId,
          nameHex: LEGACY_NAME_HEX,
          payloadHex: e.payloadHex,
        };
        await sql.begin(async (tx) => applyMetadataEvent(tx, schema, NET, event));
      }
    }, 300_000);

    afterAll(async () => {
      await sql?.end({ timeout: 5 });
      await container?.stop();
    }, 60_000);

    it("[[token-contract-rows]] produces exactly the 17 rows the contracts expect, over 17 identities and MIP §7.2's three states", async () => {
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

      // The split document assembles: SNEB publishes `metadata/0 … metadata/5` and nothing else.
      const sneb = rows.find((r) => r.symbol === "SNEB")!;
      expect(sneb.metadata).not.toBeNull();
      expect(typeof sneb.metadata).toBe("object");

      // Zero rejected events in the whole corpus (SC-101): everything the contracts emit is valid.
      const rejected = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM ${sql(schema)}.token_metadata_events
        WHERE net = ${NET} AND NOT applied`;
      expect(rejected[0]!.n).toBe("0");
    }, 120_000);
  });
});
