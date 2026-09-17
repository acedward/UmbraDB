import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapTokenIndexSchema } from "../bootstrap.js";
import { pad32, tokenColorHex } from "../color.js";
import type { ObservedMint } from "../ingest/decode.js";
import { applyMetadataEvent, applyMint, type RawContractEvent } from "../ingest/fold.js";
import { TOKEN_METADATA_NAME_HEX } from "../ingest/payload.js";
import { metadataPayloadHex } from "./helpers/fake-ledger.js";

/**
 * Project 00020, sub-plan 01 Phase 5 — `[[token-status-rules]]`.
 *
 * Spec §6.2's table row by row, plus the parts of FR-017 that only show up when a mint and a
 * declaration meet: the arrival order must not matter, a declaration must never overwrite an
 * observed fact, and a contradicting declaration must be kept AND flagged rather than dropped.
 *
 * The fold is driven directly here rather than through the scanner: these are rules about evidence,
 * not about decoding, and `scan.test.ts` / `events.test.ts` already prove the paths that deliver it.
 */

const NET = "stagenet";
const KIND = { unshieldedNative: 0, shieldedNative: 1, unshieldedLedger: 2, shieldedLedger: 3 } as const;

describe("token status rules (spec §6.2, FR-017)", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  const schema = "token_status_rules";
  let nextEventId = 1;
  let nextAddress = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await bootstrapTokenIndexSchema(sql, { schema, net: NET });
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  /** A fresh contract address per scenario, so the scenarios never interfere. */
  function newAddress(): string {
    nextAddress += 1;
    return nextAddress.toString(16).padStart(64, "0");
  }

  const DOMAIN = Buffer.from(pad32("umbra:token")).toString("hex");

  async function mint(address: string, kind: "shielded" | "unshielded", amount: bigint, height: number): Promise<void> {
    const observed: ObservedMint = {
      segment: 0, callIndex: 0, address, domainSep: DOMAIN, kind, amount,
      entryPoint: "mint", section: "guaranteed",
    };
    // The transaction hash must be unique per (address, height): `token_mints` is keyed on it, so
    // two scenarios minting at the same height would otherwise collide and the second be a no-op.
    // NOTE the slice is from the END: these addresses are left-zero-padded, so their first 48
    // characters are identical and a prefix-based hash would collide across scenarios.
    const txHash = (address.slice(-48) + height.toString(16).padStart(16, "0"));
    await sql.begin(async (tx) => applyMint(tx, schema, NET, observed, {
      txHash, blockHeight: height, txPosition: 0,
    }));
  }

  async function emit(
    address: string, kindByte: number, key: string, value: string | Uint8Array, height: number,
    opts: { eventId?: number; len?: number; domainSep?: string } = {},
  ): Promise<{ applied: boolean; rejectReason: string | undefined }> {
    const event: RawContractEvent = {
      eventId: opts.eventId ?? nextEventId++,
      contractAddress: address,
      txHash: height.toString(16).padStart(64, "0"),
      blockHeight: height,
      nameHex: TOKEN_METADATA_NAME_HEX,
      payloadHex: metadataPayloadHex({ domainSep: opts.domainSep ?? DOMAIN, kindByte, key, value, len: opts.len }),
    };
    return sql.begin(async (tx) => applyMetadataEvent(tx, schema, NET, event));
  }

  async function row(address: string, kind: "shielded" | "unshielded"): Promise<{
    status: string; storage: string | null; color: string | null; name: string | null;
    symbol: string | null; decimals: number | null; tokenUri: string | null;
    metadata: unknown; mintCount: number; totalMinted: string;
  }> {
    const rows = await sql<{
      status: string; storage: string | null; color: Buffer | null; name: string | null;
      symbol: string | null; decimals: number | null; token_uri: string | null; metadata: unknown;
      mint_count: string; total_minted: string;
    }[]>`
      SELECT status, storage, color, name, symbol, decimals, token_uri, metadata, mint_count, total_minted
      FROM ${sql(schema)}.tokens
      WHERE net = ${NET} AND address = ${Buffer.from(address, "hex")}
        AND domain_sep = ${Buffer.from(DOMAIN, "hex")} AND kind = ${kind}
    `;
    expect(rows, `no row for ${address} / ${kind}`).toHaveLength(1);
    const r = rows[0]!;
    return {
      status: r.status, storage: r.storage, color: r.color === null ? null : r.color.toString("hex"),
      name: r.name, symbol: r.symbol, decimals: r.decimals, tokenUri: r.token_uri,
      metadata: r.metadata, mintCount: Number(r.mint_count), totalMinted: r.total_minted,
    };
  }

  it("[[token-status-rules]] mint only = observed; declaration only = declared; both agreeing = described", async () => {
    const observedOnly = newAddress();
    await mint(observedOnly, "shielded", 500n, 10);
    expect(await row(observedOnly, "shielded")).toMatchObject({
      status: "observed", storage: "native", name: null, mintCount: 1, totalMinted: "500",
      color: tokenColorHex(DOMAIN, observedOnly),
    });

    const declaredOnly = newAddress();
    expect(await emit(declaredOnly, KIND.shieldedNative, "name", "Unshielded Promise", 11)).toMatchObject({ applied: true });
    expect(await row(declaredOnly, "shielded")).toMatchObject({
      status: "declared", storage: "native", name: "Unshielded Promise", mintCount: 0,
      color: tokenColorHex(DOMAIN, declaredOnly),
    });

    const described = newAddress();
    await mint(described, "shielded", 5_000_000n, 12);
    await emit(described, KIND.shieldedNative, "name", "Shielded Star", 13);
    await emit(described, KIND.shieldedNative, "symbol", "SSTAR", 13);
    await emit(described, KIND.shieldedNative, "decimals", new Uint8Array([6]), 13);
    expect(await row(described, "shielded")).toMatchObject({
      status: "described", storage: "native", name: "Shielded Star", symbol: "SSTAR", decimals: 6,
      mintCount: 1, totalMinted: "5000000",
    });
  }, 120_000);

  it("[[token-status-inconsistent]] a declaration of LEDGER for a natively-minted token is inconsistent: the mint's facts stand, the claim is kept and shown", async () => {
    const liar = newAddress();
    await emit(liar, KIND.unshieldedLedger, "name", "Ledger Liar", 20);
    await emit(liar, KIND.unshieldedLedger, "symbol", "LLIAR", 20);
    // Declared-only so far: a ledger token, no colour, no mints.
    expect(await row(liar, "unshielded")).toMatchObject({
      status: "declared", storage: "ledger", color: null, name: "Ledger Liar", mintCount: 0,
    });

    await mint(liar, "unshielded", 42n, 21);
    const after = await row(liar, "unshielded");
    // Rule 2: the mint wins on storage and kind, unconditionally, and the colour is derivable again.
    expect(after).toMatchObject({
      status: "inconsistent", storage: "native", mintCount: 1, totalMinted: "42",
      name: "Ledger Liar", symbol: "LLIAR",
    });
    expect(after.color).toBe(tokenColorHex(DOMAIN, liar));

    // A later well-formed native declaration does not clear the contradiction: the ledger claim was
    // made and is still on the record.
    await emit(liar, KIND.unshieldedNative, "name", "Ledger Liar (renamed)", 22);
    expect(await row(liar, "unshielded")).toMatchObject({ status: "inconsistent", name: "Ledger Liar (renamed)" });
  }, 120_000);

  it("[[token-status-order]] the arrival order of a mint and its declaration is irrelevant", async () => {
    const mintFirst = newAddress();
    await mint(mintFirst, "shielded", 7n, 30);
    await emit(mintFirst, KIND.shieldedNative, "name", "Same", 31);
    await emit(mintFirst, KIND.shieldedNative, "decimals", new Uint8Array([9]), 31);

    const eventFirst = newAddress();
    await emit(eventFirst, KIND.shieldedNative, "name", "Same", 31);
    await emit(eventFirst, KIND.shieldedNative, "decimals", new Uint8Array([9]), 31);
    await mint(eventFirst, "shielded", 7n, 30);

    const a = await row(mintFirst, "shielded");
    const b = await row(eventFirst, "shielded");
    expect({ ...a, color: null }).toEqual({ ...b, color: null });
    expect(a.status).toBe("described");
  }, 120_000);

  it("[[token-status-dual-kind]] one colour, two kinds: bit 0 selects the row, so a declaration for the other kind is a different token and not a contradiction", async () => {
    const dual = newAddress();
    await mint(dual, "shielded", 1n, 40);
    await mint(dual, "unshielded", 2n, 40);
    await emit(dual, KIND.shieldedNative, "name", "Dual Aurora", 41);
    await emit(dual, KIND.unshieldedNative, "name", "Dual Aurora", 41);

    const shielded = await row(dual, "shielded");
    const unshielded = await row(dual, "unshielded");
    // The same 32 bytes, two rows, both clean — the ledger distinguishes them by tag, not by value.
    expect(shielded.color).toBe(unshielded.color);
    expect(shielded.color).toBe(tokenColorHex(DOMAIN, dual));
    expect(shielded.status).toBe("described");
    expect(unshielded.status).toBe("described");
    expect([shielded.totalMinted, unshielded.totalMinted]).toEqual(["1", "2"]);
  }, 120_000);

  it("[[token-status-last-write]] last write wins by (block height, event id), including two events in one transaction", async () => {
    const renamed = newAddress();
    await emit(renamed, KIND.shieldedNative, "name", "First", 50, { eventId: 900 });
    expect((await row(renamed, "shielded")).name).toBe("First");

    await emit(renamed, KIND.shieldedNative, "name", "Second", 51, { eventId: 901 });
    expect((await row(renamed, "shielded")).name).toBe("Second");

    // An older event delivered late must NOT win.
    await emit(renamed, KIND.shieldedNative, "name", "Stale", 49, { eventId: 899 });
    expect((await row(renamed, "shielded")).name).toBe("Second");

    // Two events in ONE transaction (same height): the higher indexer id is later in evaluation order.
    await emit(renamed, KIND.shieldedNative, "name", "SameBlockLow", 52, { eventId: 910 });
    await emit(renamed, KIND.shieldedNative, "name", "SameBlockHigh", 52, { eventId: 911 });
    expect((await row(renamed, "shielded")).name).toBe("SameBlockHigh");

    // The history is intact: every event is still stored.
    const history = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ${sql(schema)}.token_metadata_events
      WHERE net = ${NET} AND address = ${Buffer.from(renamed, "hex")}`;
    expect(history[0]!.n).toBe("5");
  }, 120_000);

  it("[[token-status-rejected]] a rejected event is stored with its reason and changes nothing about the token", async () => {
    const strict = newAddress();
    await emit(strict, KIND.shieldedNative, "name", "Good", 60);
    const before = await row(strict, "shielded");

    expect(await emit(strict, KIND.shieldedNative, "decimals", new Uint8Array([99]), 61))
      .toMatchObject({ applied: false, rejectReason: "decimals_range" });
    expect(await emit(strict, KIND.shieldedNative, "symbol", "S".repeat(33), 61))
      .toMatchObject({ applied: false, rejectReason: "symbol_too_long" });
    expect(await emit(strict, 0b0000_0100, "name", "ReservedBits", 61))
      .toMatchObject({ applied: false, rejectReason: "kind_reserved_bits" });

    expect(await row(strict, "shielded")).toEqual(before);
    const rejected = await sql<{ reject_reason: string; applied: boolean }[]>`
      SELECT reject_reason, applied FROM ${sql(schema)}.token_metadata_events
      WHERE net = ${NET} AND address = ${Buffer.from(strict, "hex")} AND NOT applied ORDER BY event_id`;
    expect(rejected.map((r) => r.reject_reason)).toEqual(["decimals_range", "symbol_too_long", "kind_reserved_bits"]);
  }, 120_000);

  it("[[token-status-metadata-parts]] a split metadata document projects only when every part is present, and tokenUri is projected as text", async () => {
    const split = newAddress();
    const document = JSON.stringify({ description: "A nebula", website: "https://example.test", image: "data:image/svg+xml,<svg/>" });
    const chunks: string[] = [];
    for (let i = 0; i < document.length; i += 40) chunks.push(document.slice(i, i + 40));
    expect(chunks.length).toBeGreaterThan(2);

    // Parts 1..n first: nothing may project while part 0 is missing.
    for (let i = 1; i < chunks.length; i++) {
      await emit(split, KIND.shieldedNative, `metadata/${i}`, chunks[i]!, 70 + i);
    }
    expect((await row(split, "shielded")).metadata).toBeNull();

    await emit(split, KIND.shieldedNative, "metadata/0", chunks[0]!, 70);
    expect((await row(split, "shielded")).metadata).toEqual(JSON.parse(document));

    await emit(split, KIND.shieldedNative, "tokenUri", "http://localhost:10020/constellations/orion", 80);
    expect((await row(split, "shielded")).tokenUri).toBe("http://localhost:10020/constellations/orion");

    // A later part that breaks the assembled JSON clears the projection rather than leaving a
    // stale value behind. Spec §4.2 allows either ("stays NULL (or its previous complete value)");
    // NULL is the one that is a pure function of the stored evidence, so `rebuild` reproduces it
    // exactly and the page never shows a document the contract has since invalidated. The parts
    // themselves are all still in `token_metadata_kv`, so nothing is lost.
    await emit(split, KIND.shieldedNative, `metadata/${chunks.length}`, "{{{", 90);
    expect((await row(split, "shielded")).metadata).toBeNull();

    // Repairing the offending part restores the document, without re-sending the others.
    await emit(split, KIND.shieldedNative, `metadata/${chunks.length}`, "", 91, { len: 0 });
    expect((await row(split, "shielded")).metadata).toEqual(JSON.parse(document));
  }, 120_000);

  it("[[token-status-builtin]] the built-in rows are never touched by the fold", async () => {
    const zero = "0".repeat(64);
    const before = await sql<{ symbol: string; status: string; decimals: number }[]>`
      SELECT symbol, status, decimals FROM ${sql(schema)}.tokens WHERE net = ${NET} AND status = 'builtin' ORDER BY symbol`;
    expect(before.map((r) => r.symbol)).toEqual(["DUST", "NIGHT"]);

    // An event that claims to describe NIGHT's key. It is stored (evidence), and the row does not move.
    await emit(zero, KIND.unshieldedNative, "name", "NotNight", 100, { domainSep: zero });
    const after = await sql<{ symbol: string; status: string; decimals: number }[]>`
      SELECT symbol, status, decimals FROM ${sql(schema)}.tokens WHERE net = ${NET} AND status = 'builtin' ORDER BY symbol`;
    expect(after).toEqual(before);
    const night = await sql<{ name: string; status: string }[]>`
      SELECT name, status FROM ${sql(schema)}.tokens
      WHERE net = ${NET} AND address = ${Buffer.from(zero, "hex")} AND domain_sep = ${Buffer.from(zero, "hex")}`;
    expect(night[0]).toEqual({ name: "NIGHT", status: "builtin" });
  }, 120_000);
});
