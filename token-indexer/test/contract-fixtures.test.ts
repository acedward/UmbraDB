import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapTokenIndexSchema } from "../bootstrap.js";
import { tokenColorHex } from "../color.js";
import type { ObservedMint } from "../ingest/decode.js";
import { applyMetadataEvent, applyMint, type RawContractEvent } from "../ingest/fold.js";
import { TOKEN_METADATA_NAME_HEX, parseTokenMetadata, type RejectReason } from "../ingest/payload.js";

/**
 * Project 00020 — the golden corpus produced by the REAL COMPILED reference contracts
 * (`acedward/mip-erc7496-midnight-contracts`, branch `feat/00020-02-initial`, see
 * `fixtures/contracts/SOURCE.md` for the exact commit).
 *
 * Nothing here is hand-written: 69 `TokenMetadata` payloads, 16 mints, 15 colour vectors and 16
 * expected rows come out of the compiled Compact templates executed in the Compact simulator. That
 * makes this the test that decides whether this indexer and that standard actually agree — the
 * hand-built payloads in `payload.test.ts` prove the parser's own rules, these prove the parser
 * reads what the contracts really emit.
 *
 * The simulator has no chain, so the corpus carries no block heights, transaction hashes or indexer
 * event ids; this test supplies them (emission order → event id → synthetic height). Everything
 * that matters — the bytes, the domain separators, the colours, the amounts — is the contracts'.
 */

const DIR = new URL("./fixtures/contracts/", import.meta.url);
const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(file, DIR), "utf8")) as T;

interface FixtureEvent {
  row: string; eventId: number; step: number; op: string;
  contractAddress: string; eventName: string; payloadHex: string;
  domainSepHex: string; domainSepText: string; kind: number;
  keyText: string; len: number; valueHex: string; valueText: string | null;
}
interface FixtureMint {
  row: string; step: number; op: string; contractAddress: string;
  domainSepHex: string; kind: "shielded" | "unshielded"; amount: string; colorHex: string;
}
interface FixtureColorVector {
  row: string; contractAddress: string; domainSepHex: string; domainSepText: string;
  colorHex: string; source: string;
}
interface FixtureExpectedToken {
  row: string; contractAddress: string; domainSepHex: string; domainSepText: string;
  kind: "shielded" | "unshielded"; declaredKindByte?: number; observedKind?: string;
  storage: string | null; colorHex: string | null; traits: Record<string, string>;
  name?: string; symbol?: string; decimals?: number; tokenUri?: string;
  mintCount: number; totalMinted: string; status: string;
}
interface FixtureNegative {
  why: string; contractAddress: string; eventName: string; payloadHex: string;
  kind: number; keyText: string; len: number;
}

const events = read<{ count: number; events: FixtureEvent[] }>("events.json");
const mints = read<{ count: number; mints: FixtureMint[] }>("mints.json");
const colorVectors = read<{ count: number; vectors: FixtureColorVector[] }>("color-vectors.json");
const expectedTokens = read<{ count: number; tokens: FixtureExpectedToken[] }>("expected-tokens.json");
const negatives = read<{ count: number; payloads: FixtureNegative[] }>("negative-payloads.json");

/** What each recorded negative payload must produce. `null` means "actually valid" — the corpus
 *  deliberately includes kind `0x03` (shielded LEDGER), which exercises both bits and is legal. */
const NEGATIVE_EXPECTATIONS: Record<string, RejectReason | null> = {
  "len above the 190-byte value field": "len_too_large",
  "decimals with a length other than 1": "decimals_len",
  "decimals above 36": "decimals_range",
  "a reserved kind bit is set": "kind_reserved_bits",
  "kind 0x03 — shielded ledger, valid but exercises both bits": null,
  "an empty name (len 0)": "name_empty",
  "a name that is not valid UTF-8": "name_not_utf8",
};

const NET = "stagenet";

describe("the compiled reference contracts' recorded corpus", () => {
  it("[[token-contract-golden]] parses all 69 emitted payloads byte for byte, exactly as the contracts recorded them", () => {
    expect(events.events).toHaveLength(events.count);
    expect(events.count).toBe(69);
    for (const e of events.events) {
      const bytes = Buffer.from(e.payloadHex, "hex");
      expect(bytes, `${e.row}#${e.eventId} payload width`).toHaveLength(256);
      const parsed = parseTokenMetadata(new Uint8Array(bytes));
      expect(parsed.applied, `${e.row}#${e.eventId} (${e.keyText}) was rejected: ${parsed.rejectReason}`).toBe(true);
      expect(Buffer.from(parsed.domainSep).toString("hex")).toBe(e.domainSepHex);
      expect(parsed.kindByte).toBe(e.kind);
      expect(parsed.keyText).toBe(e.keyText);
      expect(parsed.len).toBe(e.len);
      expect(Buffer.from(parsed.valueBytes).toString("hex")).toBe(e.valueHex);
      if (e.valueText !== null) expect(parsed.valueText).toBe(e.valueText);
      // The name every one of them was emitted under is this standard's, not another version's.
      expect(e.eventName).toBe("TokenMetadata");
      // The domain separator's readable text is what the contract's own matrix says it is.
      expect(Buffer.from(e.domainSepHex, "hex").toString("utf8").replace(/\0+$/, "")).toBe(e.domainSepText);
    }
    // The corpus really does exercise all three kind bytes the templates use.
    expect(new Set(events.events.map((e) => e.kind))).toEqual(new Set([0, 1, 2]));
    // …and both the whole-document and the split-document forms of `metadata`.
    const keys = new Set(events.events.map((e) => e.keyText));
    expect(keys.has("metadata")).toBe(true);
    expect(keys.has("metadata/5")).toBe(true);
    expect(keys.has("tokenUri")).toBe(true);
  });

  it("[[token-contract-negatives]] every deliberately malformed payload is rejected for the reason the contracts intended, and the deliberately valid one is accepted", () => {
    expect(negatives.payloads).toHaveLength(negatives.count);
    for (const n of negatives.payloads) {
      const expectation = NEGATIVE_EXPECTATIONS[n.why];
      expect(expectation, `no expectation recorded for ${JSON.stringify(n.why)}`).not.toBeUndefined();
      const parsed = parseTokenMetadata(new Uint8Array(Buffer.from(n.payloadHex, "hex")));
      if (expectation === null) {
        expect(parsed.applied, `${n.why} should be accepted`).toBe(true);
        expect(parsed.kind).toBe("shielded");
        expect(parsed.storage).toBe("ledger");
      } else {
        expect(parsed.applied, `${n.why} should be rejected`).toBe(false);
        expect(parsed.rejectReason, n.why).toBe(expectation);
      }
    }
  });

  it("[[token-contract-colors]] every colour the contracts' own tokenColor() produced is reproduced from the domain separator and the address alone", () => {
    expect(colorVectors.vectors).toHaveLength(colorVectors.count);
    for (const v of colorVectors.vectors) {
      expect(tokenColorHex(v.domainSepHex, v.contractAddress), `${v.row} (${v.domainSepText})`).toBe(v.colorHex);
    }
    // And the colour each minted coin actually carried.
    for (const m of mints.mints) {
      expect(tokenColorHex(m.domainSepHex, m.contractAddress), `${m.row} mint`).toBe(m.colorHex);
    }
    // A ledger row still has a DERIVABLE colour — it is simply not stored, because the token does
    // not live in the UTxO set. The corpus says so explicitly.
    const ledgerVectors = colorVectors.vectors.filter((v) => v.source.includes("no colour exists"));
    expect(ledgerVectors.length).toBeGreaterThan(0);
    for (const v of ledgerVectors) {
      const row = expectedTokens.tokens.find((t) => t.domainSepHex === v.domainSepHex);
      expect(row?.colorHex, `${v.row} must store no colour`).toBeNull();
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
          kind: m.kind, amount: BigInt(m.amount), entryPoint: m.op, section: "guaranteed",
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
          nameHex: TOKEN_METADATA_NAME_HEX,
          payloadHex: e.payloadHex,
        };
        await sql.begin(async (tx) => applyMetadataEvent(tx, schema, NET, event));
      }
    }, 300_000);

    afterAll(async () => {
      await sql?.end({ timeout: 5 });
      await container?.stop();
    }, 60_000);

    it("[[token-contract-rows]] produces exactly the 16 rows the contracts expect, across all four status values", async () => {
      const rows = await sql<{
        address: Buffer; domain_sep: Buffer; kind: string; storage: string | null; color: Buffer | null;
        name: string | null; symbol: string | null; decimals: number | null; token_uri: string | null;
        metadata: unknown; status: string; mint_count: string; total_minted: string;
      }[]>`
        SELECT address, domain_sep, kind, storage, color, name, symbol, decimals, token_uri,
               metadata, status, mint_count::text, total_minted::text
        FROM ${sql(schema)}.tokens WHERE net = ${NET} AND status <> 'builtin'
      `;
      expect(rows).toHaveLength(expectedTokens.count);
      expect(expectedTokens.count).toBe(16);

      for (const want of expectedTokens.tokens) {
        const got = rows.find((r) =>
          r.address.toString("hex") === want.contractAddress
          && r.domain_sep.toString("hex") === want.domainSepHex
          && r.kind === want.kind);
        expect(got, `${want.row} / ${want.domainSepText} / ${want.kind}`).toBeDefined();
        const label = `${want.row} (${want.domainSepText}, ${want.kind})`;
        expect(got!.status, `${label} status`).toBe(want.status);
        expect(got!.storage, `${label} storage`).toBe(want.storage);
        expect(got!.color === null ? null : got!.color.toString("hex"), `${label} colour`).toBe(want.colorHex);
        expect(got!.name, `${label} name`).toBe(want.name ?? null);
        expect(got!.symbol, `${label} symbol`).toBe(want.symbol ?? null);
        expect(got!.decimals, `${label} decimals`).toBe(want.decimals ?? null);
        expect(got!.token_uri, `${label} tokenUri`).toBe(want.tokenUri ?? null);
        expect(Number(got!.mint_count), `${label} mintCount`).toBe(want.mintCount);
        expect(got!.total_minted, `${label} totalMinted`).toBe(want.totalMinted);

        // Every trait the contracts recorded is stored with the value they recorded.
        const kv = await sql<{ key_text: string; value: Buffer; len: number }[]>`
          SELECT key_text, value, len FROM ${sql(schema)}.token_metadata_kv
          WHERE net = ${NET} AND address = ${got!.address} AND domain_sep = ${got!.domain_sep}
            AND kind = ${want.kind}
        `;
        const stored = new Map(kv.map((k) => [k.key_text, k.value.subarray(0, k.len).toString("utf8")]));
        for (const [key, value] of Object.entries(want.traits)) {
          expect(stored.get(key), `${label} trait ${key}`).toBe(value);
        }
      }

      // All four §6.2 states really are covered by the corpus, so this test cannot pass vacuously.
      expect(new Set(rows.map((r) => r.status)))
        .toEqual(new Set(["observed", "declared", "described", "inconsistent"]));

      // The two specific shapes the standard is most likely to get wrong:
      //  - "Ledger Liar" declares kind byte 2 (unshielded LEDGER) but mints unshielded natively.
      //    Bit 0 keys the row, bit 1 is the `storage` column, so both facts land on ONE row: the
      //    mint's `storage = native` stands and the row is flagged `inconsistent`.
      const liar = expectedTokens.tokens.find((t) => t.row === "LLIAR")!;
      expect(liar).toMatchObject({ kind: "unshielded", storage: "native", status: "inconsistent", declaredKindByte: 2 });
      expect(rows.filter((r) => r.address.toString("hex") === liar.contractAddress)).toHaveLength(1);
      //  - "Dual Aurora" mints the SAME domain separator both shielded and unshielded: two rows,
      //    one 32-byte colour, both clean.
      const dual = expectedTokens.tokens.filter((t) => t.row === "DAUR");
      expect(dual).toHaveLength(2);
      expect(dual[0]!.colorHex).toBe(dual[1]!.colorHex);
      expect(new Set(dual.map((t) => t.kind))).toEqual(new Set(["shielded", "unshielded"]));

      // The split document assembles: SNEB publishes `metadata/0 … metadata/5` and nothing else.
      const sneb = rows.find((r) => r.symbol === "SNEB")!;
      expect(sneb.metadata).not.toBeNull();
      expect(typeof sneb.metadata).toBe("object");
    }, 120_000);
  });
});
