import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapTokenIndexSchema } from "../bootstrap.js";
import { pad32, tokenColorHex } from "../color.js";
import type { ObservedMint } from "../ingest/decode.js";
import { applyMetadataEvent, applyMint, type RawContractEvent } from "../ingest/fold.js";
import {
  LEGACY_NAME_HEX, MIP_0018_NAME_HEX, encodeCompactUint, encodeInteger,
} from "../ingest/payload.js";
import { metadataPayloadHex } from "./helpers/fake-ledger.js";

/**
 * The fold's rules — MIP §7.2's three states row by row, plus the parts of §4/§6.3 that only show
 * up when a mint and a declaration meet: the arrival order must not matter, a declaration must
 * never touch a row that is not its own kind, and a contract that describes one kind while minting
 * another must produce TWO rows rather than one flagged one.
 *
 * Written by project 00021 (Phase A task A5) against MIP PR #315; extended by project 00023 Phase F
 * with the three fold rules the FINAL MIP-0018 text changed — Null clearing a key, the absence of
 * any multipart convention, and an integer width the draft could not carry. **The `emit` helper
 * defaults to the SUPERSEDED draft name**, because that is what the contracts deployed on Stagenet
 * emit and what every test written before Phase F asserts; `emit0018` is the standard's name, and
 * the three F1.5 tests at the end of this file use it.
 *
 * The fold is driven directly here rather than through the scanner: these are rules about evidence,
 * not about decoding, and `scan.test.ts` / `events.test.ts` already prove the paths that deliver it.
 */

const NET = "stagenet";
/** MIP §3's four values. */
const KIND = { unshieldedNative: 0, shieldedNative: 1, unshieldedLedger: 2, shieldedLedger: 3 } as const;

describe("token status rules (MIP §4, §6.3, §7.2)", () => {
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

  async function mint(address: string, kind: 0 | 1, amount: bigint, height: number): Promise<void> {
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
    address: string, kindByte: number, key: string | Uint8Array, value: string | Uint8Array, height: number,
    opts: { eventId?: number; valType?: number; valLen?: number; domainSep?: string; nameHex?: string } = {},
  ): Promise<{ applied: boolean; rejectReason: string | undefined; projectionError: string | undefined }> {
    const event: RawContractEvent = {
      eventId: opts.eventId ?? nextEventId++,
      contractAddress: address,
      txHash: height.toString(16).padStart(64, "0"),
      blockHeight: height,
      nameHex: opts.nameHex ?? LEGACY_NAME_HEX,
      payloadHex: metadataPayloadHex({
        domainSep: opts.domainSep ?? DOMAIN, kindByte, key, value,
        valType: opts.valType, valLen: opts.valLen,
      }),
      // Under the standard's name a declaration is a [Y] package and carries its evidence
      // (migration 005); these hand-built ones are one-part guaranteed packages in intent 1.
      ...(opts.nameHex === MIP_0018_NAME_HEX ? { segment: 1, phase: "guaranteed" as const } : {}),
    };
    return sql.begin(async (tx) => applyMetadataEvent(tx, schema, NET, event));
  }

  /** The same emission under the FINAL standard's event name. Everything else is identical: the
   *  256-byte layout is the one thing the two names share, so only the rules change. */
  async function emit0018(
    address: string, kindByte: number, key: string | Uint8Array, value: string | Uint8Array, height: number,
    opts: { eventId?: number; valType?: number; valLen?: number; domainSep?: string } = {},
  ): Promise<{ applied: boolean; rejectReason: string | undefined; projectionError: string | undefined }> {
    return emit(address, kindByte, key, value, height, { ...opts, nameHex: MIP_0018_NAME_HEX });
  }

  /** One kv row as the fold left it, by key text — including a Null tombstone, which is what makes
   *  "the row is still there and the column is empty" a thing this file can assert. */
  async function kv(address: string, keyText: string): Promise<{
    name_variant: string; val_type: number; val_len: number; value_hex: string;
    projection_error: string | null; updated_event_id: string;
  } | undefined> {
    const rows = await sql<{
      name_variant: string; val_type: number; val_len: number; value: Buffer;
      projection_error: string | null; updated_event_id: string;
    }[]>`
      SELECT name_variant, val_type, val_len, value, projection_error, updated_event_id::text
      FROM ${sql(schema)}.token_metadata_kv
      WHERE net = ${NET} AND address = ${Buffer.from(address, "hex")} AND key_text = ${keyText}
    `;
    const r = rows[0];
    if (r === undefined) return undefined;
    return {
      name_variant: r.name_variant, val_type: r.val_type, val_len: r.val_len,
      value_hex: r.value.toString("hex"), projection_error: r.projection_error,
      updated_event_id: r.updated_event_id,
    };
  }

  interface Row {
    status: string; kind: number; privacy: string; storage: string; color: string | null;
    name: string | null; symbol: string | null; decimals: number | null; tokenUri: string | null;
    metadata: unknown; mintCount: number; totalMinted: string;
  }

  async function row(address: string, kind: number, domainSep = DOMAIN): Promise<Row> {
    const rows = await sql<{
      status: string; kind: number; privacy: string; storage: string; color: Buffer | null;
      name: string | null; symbol: string | null; decimals: number | null; token_uri: string | null;
      metadata: unknown; mint_count: string; total_minted: string;
    }[]>`
      SELECT status, kind, privacy, storage, color, name, symbol, decimals, token_uri, metadata,
             mint_count, total_minted
      FROM ${sql(schema)}.tokens
      WHERE net = ${NET} AND address = ${Buffer.from(address, "hex")}
        AND domain_sep = ${Buffer.from(domainSep, "hex")} AND kind = ${kind}
    `;
    expect(rows, `no row for ${address} / kind ${kind}`).toHaveLength(1);
    const r = rows[0]!;
    return {
      status: r.status, kind: r.kind, privacy: r.privacy, storage: r.storage,
      color: r.color === null ? null : r.color.toString("hex"),
      name: r.name, symbol: r.symbol, decimals: r.decimals, tokenUri: r.token_uri,
      metadata: r.metadata, mintCount: Number(r.mint_count), totalMinted: r.total_minted,
    };
  }

  async function rowsOf(address: string): Promise<{ kind: number; status: string; name: string | null }[]> {
    return sql<{ kind: number; status: string; name: string | null }[]>`
      SELECT kind, status, name FROM ${sql(schema)}.tokens
      WHERE net = ${NET} AND address = ${Buffer.from(address, "hex")} ORDER BY kind
    `;
  }

  it("[[token-status-rules]] mint only = observed; declaration only = declared; both = described", async () => {
    const observedOnly = newAddress();
    await mint(observedOnly, KIND.shieldedNative, 500n, 10);
    expect(await row(observedOnly, KIND.shieldedNative)).toMatchObject({
      status: "observed", privacy: "shielded", storage: "native", name: null,
      mintCount: 1, totalMinted: "500", color: tokenColorHex(DOMAIN, observedOnly),
    });

    const declaredOnly = newAddress();
    expect(await emit(declaredOnly, KIND.shieldedNative, "name", "Unminted Promise", 11)).toMatchObject({ applied: true });
    expect(await row(declaredOnly, KIND.shieldedNative)).toMatchObject({
      status: "declared", privacy: "shielded", storage: "native", name: "Unminted Promise", mintCount: 0,
      color: tokenColorHex(DOMAIN, declaredOnly),
    });

    // A LEDGER declaration can never be corroborated (MIP §7.2): no mint exists for it, ever, and
    // it has no colour at all (MIP §3).
    const ledger = newAddress();
    await emit(ledger, KIND.unshieldedLedger, "name", "Ledger Sun", 12);
    expect(await row(ledger, KIND.unshieldedLedger)).toMatchObject({
      status: "declared", privacy: "unshielded", storage: "ledger", color: null, name: "Ledger Sun",
    });
    // Kind 3 is legal and purely informative.
    const shieldedLedger = newAddress();
    await emit(shieldedLedger, KIND.shieldedLedger, "name", "Confidential Book", 12);
    expect(await row(shieldedLedger, KIND.shieldedLedger)).toMatchObject({
      status: "declared", privacy: "shielded", storage: "ledger", color: null,
    });

    const described = newAddress();
    await mint(described, KIND.shieldedNative, 5_000_000n, 12);
    await emit(described, KIND.shieldedNative, "name", "Shielded Star", 13);
    await emit(described, KIND.shieldedNative, "symbol", "SSTAR", 13);
    await emit(described, KIND.shieldedNative, "decimals", encodeInteger(6), 13, { valType: 2 });
    expect(await row(described, KIND.shieldedNative)).toMatchObject({
      status: "described", storage: "native", name: "Shielded Star", symbol: "SSTAR", decimals: 6,
      mintCount: 1, totalMinted: "5000000",
    });
  }, 120_000);

  it("[[token-two-rows-liar]] a contract that declares a ledger book and mints natively yields TWO rows, and neither is flagged", async () => {
    const liar = newAddress();
    await emit(liar, KIND.unshieldedLedger, "name", "Ledger Liar", 20);
    await emit(liar, KIND.unshieldedLedger, "symbol", "LLIAR", 20);
    expect(await row(liar, KIND.unshieldedLedger)).toMatchObject({
      status: "declared", privacy: "unshielded", storage: "ledger", color: null,
      name: "Ledger Liar", symbol: "LLIAR", mintCount: 0,
    });

    // The mint is a FACT about kind 0 and says nothing about the kind-2 row the contract described.
    await mint(liar, KIND.unshieldedNative, 42n, 21);

    const rows = await rowsOf(liar);
    expect(rows).toEqual([
      { kind: 0, status: "observed", name: null },
      { kind: 2, status: "declared", name: "Ledger Liar" },
    ]);
    // The mint's own row: a colour, the counters, and no name — nobody described THIS token.
    expect(await row(liar, KIND.unshieldedNative)).toMatchObject({
      status: "observed", privacy: "unshielded", storage: "native",
      color: tokenColorHex(DOMAIN, liar), mintCount: 1, totalMinted: "42", name: null, symbol: null,
    });
    // The declared row is untouched by the mint: still no colour, still named.
    expect(await row(liar, KIND.unshieldedLedger)).toMatchObject({
      status: "declared", storage: "ledger", color: null, name: "Ledger Liar", mintCount: 0,
    });

    // A later declaration for the NATIVE kind describes the minted token, and only that one.
    await emit(liar, KIND.unshieldedNative, "name", "Liar (native side)", 22);
    expect(await rowsOf(liar)).toEqual([
      { kind: 0, status: "described", name: "Liar (native side)" },
      { kind: 2, status: "declared", name: "Ledger Liar" },
    ]);

    // Nothing anywhere in this schema can even hold the 00020 contradiction status.
    const statuses = await sql<{ status: string }[]>`
      SELECT DISTINCT status FROM ${sql(schema)}.tokens WHERE net = ${NET} ORDER BY status`;
    expect(statuses.map((s) => s.status).sort())
      .toEqual(["builtin", "declared", "described", "observed"]);
  }, 120_000);

  it("[[token-status-order]] the arrival order of a mint and its declaration is irrelevant", async () => {
    const mintFirst = newAddress();
    await mint(mintFirst, KIND.shieldedNative, 7n, 30);
    await emit(mintFirst, KIND.shieldedNative, "name", "Same", 31);
    await emit(mintFirst, KIND.shieldedNative, "decimals", encodeInteger(9), 31, { valType: 2 });

    const eventFirst = newAddress();
    await emit(eventFirst, KIND.shieldedNative, "name", "Same", 31);
    await emit(eventFirst, KIND.shieldedNative, "decimals", encodeInteger(9), 31, { valType: 2 });
    await mint(eventFirst, KIND.shieldedNative, 7n, 30);

    const a = await row(mintFirst, KIND.shieldedNative);
    const b = await row(eventFirst, KIND.shieldedNative);
    expect({ ...a, color: null }).toEqual({ ...b, color: null });
    expect(a.status).toBe("described");
  }, 120_000);

  it("[[token-status-dual-kind]] one colour, two kinds: each kind is its own row and its own declaration", async () => {
    const dual = newAddress();
    await mint(dual, KIND.shieldedNative, 1n, 40);
    await mint(dual, KIND.unshieldedNative, 2n, 40);
    await emit(dual, KIND.shieldedNative, "name", "Dual Aurora", 41);
    await emit(dual, KIND.unshieldedNative, "name", "Dual Aurora", 41);

    const shielded = await row(dual, KIND.shieldedNative);
    const unshielded = await row(dual, KIND.unshieldedNative);
    // The same 32 bytes, two rows, both described — the ledger distinguishes them by tag, not by
    // value (MIP §4).
    expect(shielded.color).toBe(unshielded.color);
    expect(shielded.color).toBe(tokenColorHex(DOMAIN, dual));
    expect(shielded.status).toBe("described");
    expect(unshielded.status).toBe("described");
    expect([shielded.totalMinted, unshielded.totalMinted]).toEqual(["1", "2"]);

    // A declaration for one kind cannot reach the other: rename only the shielded row.
    await emit(dual, KIND.shieldedNative, "name", "Dual Aurora (shielded)", 42);
    expect((await row(dual, KIND.shieldedNative)).name).toBe("Dual Aurora (shielded)");
    expect((await row(dual, KIND.unshieldedNative)).name).toBe("Dual Aurora");
  }, 120_000);

  it("[[token-status-last-write]] last write wins by (block height, event id), including two events in one transaction", async () => {
    const renamed = newAddress();
    await emit(renamed, KIND.shieldedNative, "name", "First", 50, { eventId: 900 });
    expect((await row(renamed, KIND.shieldedNative)).name).toBe("First");

    await emit(renamed, KIND.shieldedNative, "name", "Second", 51, { eventId: 901 });
    expect((await row(renamed, KIND.shieldedNative)).name).toBe("Second");

    // An older event delivered late must NOT win.
    await emit(renamed, KIND.shieldedNative, "name", "Stale", 49, { eventId: 899 });
    expect((await row(renamed, KIND.shieldedNative)).name).toBe("Second");

    // Two events in ONE transaction (same height): the higher indexer id is later in evaluation order.
    await emit(renamed, KIND.shieldedNative, "name", "SameBlockLow", 52, { eventId: 910 });
    await emit(renamed, KIND.shieldedNative, "name", "SameBlockHigh", 52, { eventId: 911 });
    expect((await row(renamed, KIND.shieldedNative)).name).toBe("SameBlockHigh");

    // The history is intact: every event is still stored.
    const history = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ${sql(schema)}.token_metadata_events
      WHERE net = ${NET} AND address = ${Buffer.from(renamed, "hex")}`;
    expect(history[0]!.n).toBe("5");
  }, 120_000);

  it("[[token-status-rejected]] a rejected event is stored with its reason and changes nothing about the token", async () => {
    const strict = newAddress();
    await emit(strict, KIND.shieldedNative, "name", "Good", 60);
    const before = await row(strict, KIND.shieldedNative);

    // Transport rejections only (MIP §2.2/§3): a reserved type, an over-long length, an unknown
    // kind. Appendix A failures are the NEXT test, and they do not reject.
    expect(await emit(strict, KIND.shieldedNative, "trait", "x", 61, { valType: 9 }))
      .toMatchObject({ applied: false, rejectReason: "val_type_reserved" });
    expect(await emit(strict, KIND.shieldedNative, "trait", "x", 61, { valLen: 200 }))
      .toMatchObject({ applied: false, rejectReason: "val_len_too_long" });
    expect(await emit(strict, 4, "name", "UnknownKind", 61))
      .toMatchObject({ applied: false, rejectReason: "kind_unknown" });
    expect(await emit(strict, KIND.shieldedNative, new Uint8Array(32), "x", 61))
      .toMatchObject({ applied: false, rejectReason: "key_empty" });

    expect(await row(strict, KIND.shieldedNative)).toEqual(before);
    const rejected = await sql<{ reject_reason: string; applied: boolean }[]>`
      SELECT reject_reason, applied FROM ${sql(schema)}.token_metadata_events
      WHERE net = ${NET} AND address = ${Buffer.from(strict, "hex")} AND NOT applied ORDER BY event_id`;
    expect(rejected.map((r) => r.reject_reason))
      .toEqual(["val_type_reserved", "val_len_too_long", "kind_unknown", "key_empty"]);
    // A rejected event creates no row for the kind it claimed.
    expect(await rowsOf(strict)).toEqual([{ kind: 1, status: "declared", name: "Good" }]);
  }, 120_000);

  it("[[token-projection-error]] an Appendix A failure keeps the trait, flags the projection and still applies the event", async () => {
    const wrong = newAddress();
    await emit(wrong, KIND.shieldedNative, "name", "Right Name", 70);
    await emit(wrong, KIND.shieldedNative, "decimals", encodeInteger(6), 70, { valType: 2 });
    expect(await row(wrong, KIND.shieldedNative)).toMatchObject({ name: "Right Name", decimals: 6 });

    // `decimals` as a UTF-8 string instead of Appendix A's integer.
    expect(await emit(wrong, KIND.shieldedNative, "decimals", "6", 71))
      .toMatchObject({ applied: true, rejectReason: undefined, projectionError: "val_type_mismatch" });

    const after = await row(wrong, KIND.shieldedNative);
    // The event WAS applied — the row is still described/declared by it and its height moved.
    expect(after.status).toBe("declared");
    expect(after.name).toBe("Right Name");
    // Recorded decision Q10: the column has no value from a key that does not project, rather than
    // keeping the key's last good value. Everything in the fold stays a function of the CURRENT
    // stored evidence, which is what makes `rebuild` reproduce a live run exactly.
    expect(after.decimals).toBeNull();

    // …and the trait itself is stored verbatim, with the flag beside it (MIP §5.2, §5.3).
    const kv = await sql<{
      key_text: string; val_type: number; val_len: number; value: Buffer; projection_error: string | null;
    }[]>`
      SELECT key_text, val_type, val_len, value, projection_error FROM ${sql(schema)}.token_metadata_kv
      WHERE net = ${NET} AND address = ${Buffer.from(wrong, "hex")} AND kind = ${KIND.shieldedNative}
        AND key_text = 'decimals'`;
    expect(kv[0]).toMatchObject({ val_type: 1, val_len: 1, projection_error: "val_type_mismatch" });
    expect(kv[0]!.value.toString("utf8")).toBe("6");

    // A good event repairs it, which is the other half of "the event was applied, not rejected".
    await emit(wrong, KIND.shieldedNative, "decimals", encodeInteger(8), 72, { valType: 2 });
    expect((await row(wrong, KIND.shieldedNative)).decimals).toBe(8);

    // Every other Appendix A rule behaves the same way: applied, flagged, column empty.
    const rules = newAddress();
    await emit(rules, KIND.shieldedNative, "name", "N".repeat(10), 80);
    await emit(rules, KIND.shieldedNative, "symbol", "S".repeat(33), 80);             // symbol_len
    await emit(rules, KIND.shieldedNative, "tokenUri", "ftp://a.test/x", 80, { valType: 4 }); // not http(s)
    await emit(rules, KIND.shieldedNative, "metadata", "[1,2]", 80, { valType: 3 });  // not an object
    const flagged = await sql<{ key_text: string; projection_error: string }[]>`
      SELECT key_text, projection_error FROM ${sql(schema)}.token_metadata_kv
      WHERE net = ${NET} AND address = ${Buffer.from(rules, "hex")} AND projection_error IS NOT NULL
      ORDER BY key_text`;
    expect(flagged).toEqual([
      { key_text: "metadata", projection_error: "metadata_not_json_object" },
      { key_text: "symbol", projection_error: "symbol_len" },
      { key_text: "tokenUri", projection_error: "token_uri_not_absolute_http" },
    ]);
    expect(await row(rules, KIND.shieldedNative)).toMatchObject({
      name: "NNNNNNNNNN", symbol: null, tokenUri: null, metadata: null, status: "declared",
    });
  }, 120_000);

  it("[[token-key-nonutf8-stored]] a key that is not valid UTF-8 is stored under its bytes and never rejected", async () => {
    const odd = newAddress();
    const badKey = new Uint8Array(32);
    badKey.set([0xff, 0xfe, 0x01], 0);
    expect(await emit(odd, KIND.shieldedNative, badKey, "still a value", 90))
      .toMatchObject({ applied: true, rejectReason: undefined });

    // A second key whose bytes differ only past UTF-8 stays a SECOND key: the identity is the bytes.
    const otherKey = new Uint8Array(32);
    otherKey.set([0xff, 0xfe, 0x02], 0);
    await emit(odd, KIND.shieldedNative, otherKey, "another", 91);

    const kv = await sql<{ key_hex: string; key_text: string | null; value: Buffer }[]>`
      SELECT key_hex, key_text, value FROM ${sql(schema)}.token_metadata_kv
      WHERE net = ${NET} AND address = ${Buffer.from(odd, "hex")} ORDER BY key_hex`;
    expect(kv.map((r) => r.key_hex)).toEqual(["fffe01", "fffe02"]);
    expect(kv.map((r) => r.key_text)).toEqual([null, null]);
    expect(kv[0]!.value.toString("utf8")).toBe("still a value");

    // The row exists and is `declared`: a key nobody can spell is still a declaration.
    expect(await row(odd, KIND.shieldedNative)).toMatchObject({ status: "declared", name: null });

    // Trailing NULs are trimmed, so the same key sent twice updates one row rather than making two.
    await emit(odd, KIND.shieldedNative, badKey, "updated", 92);
    const again = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ${sql(schema)}.token_metadata_kv
      WHERE net = ${NET} AND address = ${Buffer.from(odd, "hex")}`;
    expect(again[0]!.n).toBe("2");
  }, 120_000);

  it("[[token-status-metadata-parts]] a split metadata document projects only when every part is present and typed, and tokenUri is projected as text", async () => {
    const split = newAddress();
    const document = JSON.stringify({ description: "A nebula", website: "https://example.test", image: "data:image/svg+xml,<svg/>" });
    const chunks: string[] = [];
    for (let i = 0; i < document.length; i += 40) chunks.push(document.slice(i, i + 40));
    expect(chunks.length).toBeGreaterThan(2);

    // Parts 1..n first: nothing may project while part 0 is missing.
    for (let i = 1; i < chunks.length; i++) {
      await emit(split, KIND.shieldedNative, `metadata/${i}`, chunks[i]!, 70 + i, { valType: 3 });
    }
    expect((await row(split, KIND.shieldedNative)).metadata).toBeNull();

    await emit(split, KIND.shieldedNative, "metadata/0", chunks[0]!, 70, { valType: 3 });
    expect((await row(split, KIND.shieldedNative)).metadata).toEqual(JSON.parse(document));

    await emit(split, KIND.shieldedNative, "tokenUri", "http://localhost:10020/constellations/orion", 80, { valType: 4 });
    expect((await row(split, KIND.shieldedNative)).tokenUri).toBe("http://localhost:10020/constellations/orion");

    // A later part that breaks the assembled JSON clears the projection rather than leaving a stale
    // value behind (question Q10's reading, applied consistently): the parts are all still in
    // `token_metadata_kv`, so nothing is lost.
    await emit(split, KIND.shieldedNative, `metadata/${chunks.length}`, "{{{", 90, { valType: 3 });
    expect((await row(split, KIND.shieldedNative)).metadata).toBeNull();

    // Repairing the offending part restores the document, without re-sending the others.
    await emit(split, KIND.shieldedNative, `metadata/${chunks.length}`, "", 91, { valType: 3, valLen: 0 });
    expect((await row(split, KIND.shieldedNative)).metadata).toEqual(JSON.parse(document));

    // A part of the WRONG type is a trait under its own key and the assembly waits (MIP §5.3).
    await emit(split, KIND.shieldedNative, `metadata/${chunks.length}`, "", 92, { valType: 1, valLen: 0 });
    expect((await row(split, KIND.shieldedNative)).metadata).toBeNull();
    const part = await sql<{ projection_error: string | null }[]>`
      SELECT projection_error FROM ${sql(schema)}.token_metadata_kv
      WHERE net = ${NET} AND address = ${Buffer.from(split, "hex")}
        AND key_text = ${`metadata/${chunks.length}`}`;
    expect(part[0]!.projection_error).toBe("val_type_mismatch");
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
    // 00023 made this stronger rather than weaker: NIGHT's row is keyed by its COLOUR (32 zero
    // bytes, the ledger's own `nativeToken().raw`), while the event's claim is keyed by the colour
    // its sentinel `(address, domainSep)` derives — which is not the zero colour. The declaration
    // therefore lands on its own row and cannot reach NIGHT at all, not even to bump a height.
    // `token_key` is what the query names, because `address` alone now matches both rows.
    const night = await sql<{ name: string; status: string; address: Buffer | null }[]>`
      SELECT name, status, address FROM ${sql(schema)}.tokens
      WHERE net = ${NET} AND token_key = ${Buffer.from(zero, "hex")} AND kind = ${KIND.unshieldedNative}`;
    expect(night).toHaveLength(1);
    expect(night[0]).toMatchObject({ name: "NIGHT", status: "builtin" });
    expect(night[0]!.address!.toString("hex")).toBe(zero);

    // The claim itself became a row of its own — an ordinary `declared` token of the colour the
    // sentinel pair derives. Two rows now share the sentinel `(address, domainSep, kind)`, which is
    // precisely why `tokens_by_identity` excludes the built-ins.
    const claimed = await sql<{ name: string; status: string; token_key: Buffer }[]>`
      SELECT name, status, token_key FROM ${sql(schema)}.tokens
      WHERE net = ${NET} AND address = ${Buffer.from(zero, "hex")} AND domain_sep = ${Buffer.from(zero, "hex")}
        AND status <> 'builtin'`;
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ name: "NotNight", status: "declared" });
    expect(claimed[0]!.token_key.toString("hex")).toBe(tokenColorHex(zero, zero));
  }, 120_000);
  // ── Project 00023 Phase F: the three fold rules the FINAL MIP-0018 text changed ────────────
  //
  // These three tests need EXPLICIT event ids, because the whole point of two of them is what the
  // last-write-wins comparison does with an out-of-order arrival. The ids below live in the 1899+
  // block: this file shares one schema across its tests, `token_metadata_events` is keyed on
  // `(net, event_id)`, and `[[token-status-last-write]]` above already owns 899-911 — a reused id
  // is silently NOT stored (`ON CONFLICT DO NOTHING`) and the fold then never runs, which reads as
  // a projection bug rather than as a collision. Keep new blocks disjoint.

  it("[[token-0018-null-clears]] a Null event empties the column and leaves a tombstone, which is what stops a late older event resurrecting the value", async () => {
    const address = newAddress();
    await emit0018(address, KIND.shieldedNative, "name", "Nova", 100, { eventId: 1900 });
    await emit0018(address, KIND.shieldedNative, "symbol", "NOVA", 100, { eventId: 1901 });
    await emit0018(address, KIND.shieldedNative, "decimals", encodeCompactUint(6, 16), 100,
      { eventId: 1902, valType: 2 });
    expect(await row(address, KIND.shieldedNative)).toMatchObject({
      status: "declared", name: "Nova", symbol: "NOVA", decimals: 6,
    });

    // MIP §2.1 type 5 / §6.2: "Null changes the current value of the exact key without erasing
    // history." So the column goes empty…
    expect(await emit0018(address, KIND.shieldedNative, "name", new Uint8Array(0), 101,
      { eventId: 1903, valType: 5 })).toMatchObject({ applied: true, projectionError: undefined });
    expect(await row(address, KIND.shieldedNative)).toMatchObject({
      name: null, symbol: "NOVA", decimals: 6,
    });
    // …the token is STILL a declaration (a Null is an accepted event, not the absence of one)…
    expect((await row(address, KIND.shieldedNative)).status).toBe("declared");
    // …the key keeps its place in the table as a tombstone with the event that cleared it…
    expect(await kv(address, "name")).toEqual({
      name_variant: "mip-0018", val_type: 5, val_len: 0, value_hex: "",
      projection_error: null, updated_event_id: "1903",
    });
    // …and the history is untouched: all four events are still stored, the Null included.
    const history = await sql<{ event_id: string; val_type: number; applied: boolean }[]>`
      SELECT event_id::text, val_type, applied FROM ${sql(schema)}.token_metadata_events
      WHERE net = ${NET} AND address = ${Buffer.from(address, "hex")} ORDER BY event_id`;
    expect(history.map((r) => [r.event_id, r.val_type, r.applied]))
      .toEqual([["1900", 1, true], ["1901", 1, true], ["1902", 2, true], ["1903", 5, true]]);

    // ── Why a tombstone and not a DELETE ─────────────────────────────────────────────────────
    // An OLDER event can arrive after a newer one: a short lookup retried from
    // `pending_event_lookups`, a redelivery, a rebuild mid-flight. The last-write-wins guard is a
    // comparison against the row that is there — with no row there is nothing to compare, and this
    // event would put "Nova" back. It must not.
    expect(await emit0018(address, KIND.shieldedNative, "name", "Nova (late duplicate)", 100,
      { eventId: 1899 })).toMatchObject({ applied: true });
    expect((await row(address, KIND.shieldedNative)).name).toBeNull();
    expect(await kv(address, "name")).toMatchObject({ val_type: 5, updated_event_id: "1903" });

    // A NEWER event sets the key again — a Null is not a gravestone, it is the current value.
    await emit0018(address, KIND.shieldedNative, "name", "Nova II", 102, { eventId: 1904 });
    expect((await row(address, KIND.shieldedNative)).name).toBe("Nova II");
    expect(await kv(address, "name")).toMatchObject({ val_type: 1, updated_event_id: "1904" });

    // Null works on every column this explorer projects, including the two that are not text.
    await emit0018(address, KIND.shieldedNative, "metadata", '{"a":1}', 103, { eventId: 1905, valType: 3 });
    await emit0018(address, KIND.shieldedNative, "tokenUri", "https://example.test/n.json", 103,
      { eventId: 1906, valType: 4 });
    expect(await row(address, KIND.shieldedNative)).toMatchObject({
      metadata: { a: 1 }, tokenUri: "https://example.test/n.json",
    });
    for (const [key, eventId] of [["decimals", 1907], ["metadata", 1908], ["tokenUri", 1909], ["symbol", 1910]] as const) {
      await emit0018(address, KIND.shieldedNative, key, new Uint8Array(0), 104,
        { eventId, valType: 5 });
    }
    expect(await row(address, KIND.shieldedNative)).toMatchObject({
      name: "Nova II", symbol: null, decimals: null, tokenUri: null, metadata: null,
    });
    // …and the row is still a declaration, with five keys on file and four of them Null.
    expect((await row(address, KIND.shieldedNative)).status).toBe("declared");
    const tombstones = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ${sql(schema)}.token_metadata_kv
      WHERE net = ${NET} AND address = ${Buffer.from(address, "hex")} AND val_type = 5`;
    expect(tombstones[0]!.n).toBe("4");

    // An empty STRING is not a Null (MIP §6.2: "present and empty"), and the difference is visible
    // in the column: "" is a value, Null is no value.
    await emit0018(address, KIND.shieldedNative, "symbol", new Uint8Array(0), 105,
      { eventId: 1911, valType: 1, valLen: 0 });
    expect((await row(address, KIND.shieldedNative)).symbol).toBeNull(); // the projection refuses "" as a symbol
    expect(await kv(address, "symbol")).toMatchObject({ val_type: 1, projection_error: "symbol_len" });
  }, 120_000);

  it("[[token-0018-no-multipart]] MIP-0018 defines no multipart representation: metadata/<n> stays a trait under the standard's name while the same parts still assemble under the draft's", async () => {
    const document = JSON.stringify({ description: "A nebula in two halves", website: "https://example.test" });
    const halves = [document.slice(0, 40), document.slice(40)];
    expect(halves.join("")).toBe(document);

    // ── Under the standard: no assembly, and a fragment cannot even be stored ────────────────
    const final = newAddress();
    // Part 0 happens to be a JSON fragment, which MIP §2.1 type 3 rejects outright — the rule that
    // makes the draft's convention impossible rather than merely unimplemented.
    expect(await emit0018(final, KIND.shieldedNative, "metadata/0", halves[0]!, 200,
      { eventId: 1920, valType: 3 })).toMatchObject({ applied: false, rejectReason: "val_type_rule" });
    // Two parts that ARE each complete JSON values are stored — as two independent traits. Nothing
    // is concatenated, because §5.4 defines nothing to concatenate.
    await emit0018(final, KIND.shieldedNative, "metadata/0", '{"half":"one"}', 201,
      { eventId: 1921, valType: 3 });
    await emit0018(final, KIND.shieldedNative, "metadata/1", '{"half":"two"}', 201,
      { eventId: 1922, valType: 3 });
    expect((await row(final, KIND.shieldedNative)).metadata).toBeNull();
    // …and neither is flagged: under the standard these are ordinary keys with no rule to break.
    expect(await kv(final, "metadata/0")).toMatchObject({ name_variant: "mip-0018", projection_error: null });
    expect(await kv(final, "metadata/1")).toMatchObject({ name_variant: "mip-0018", projection_error: null });
    // The only way to a `metadata` column under the standard is one complete value ≤ 189 bytes.
    await emit0018(final, KIND.shieldedNative, "metadata", document, 202, { eventId: 1923, valType: 3 });
    expect((await row(final, KIND.shieldedNative)).metadata).toEqual(JSON.parse(document));
    expect(Buffer.byteLength(document, "utf8")).toBeLessThanOrEqual(189);

    // ── Under the draft name: the deployed contracts' documents still assemble ───────────────
    const draft = newAddress();
    await emit(draft, KIND.shieldedNative, "metadata/1", halves[1]!, 210, { eventId: 1930, valType: 3 });
    expect((await row(draft, KIND.shieldedNative)).metadata).toBeNull(); // part 0 is missing
    await emit(draft, KIND.shieldedNative, "metadata/0", halves[0]!, 211, { eventId: 1931, valType: 3 });
    expect((await row(draft, KIND.shieldedNative)).metadata).toEqual(JSON.parse(document));
    expect(await kv(draft, "metadata/0")).toMatchObject({ name_variant: "legacy-mip-xxxx" });

    // ── And the two conventions do not contaminate one another ───────────────────────────────
    // A standard-name part landing in the middle of a draft-name document does NOT complete it and
    // does not corrupt it: the assembly waits for a draft-name part, exactly as for a missing one.
    const mixed = newAddress();
    await emit(mixed, KIND.shieldedNative, "metadata/0", halves[0]!, 220, { eventId: 1940, valType: 3 });
    await emit0018(mixed, KIND.shieldedNative, "metadata/1", '{"x":1}', 221, { eventId: 1941, valType: 3 });
    expect((await row(mixed, KIND.shieldedNative)).metadata).toBeNull();
    expect(await kv(mixed, "metadata/1")).toMatchObject({ name_variant: "mip-0018" });
    // Re-sent under the draft name, the document completes — the part was never the problem, the
    // name was.
    await emit(mixed, KIND.shieldedNative, "metadata/1", halves[1]!, 222, { eventId: 1942, valType: 3 });
    expect((await row(mixed, KIND.shieldedNative)).metadata).toEqual(JSON.parse(document));
    expect(await kv(mixed, "metadata/1")).toMatchObject({ name_variant: "legacy-mip-xxxx" });

    // A pointer key is not an assembly instruction either (MIP §5.1: "pointer syntax does not
    // require JSON assembly, nested updates, prefix replacement or concatenation").
    await emit0018(final, KIND.shieldedNative, "/metadata/description", "A nebula", 230,
      { eventId: 1950, valType: 1 });
    expect((await row(final, KIND.shieldedNative)).metadata).toEqual(JSON.parse(document));
    expect(await kv(final, "/metadata/description")).toMatchObject({ val_type: 1, projection_error: null });
  }, 120_000);

  it("[[token-0018-decimals-width]] one token can hold keys set under both names, each read under its own rules, and each trait says which", async () => {
    const address = newAddress();
    // The recommended emitter default: `decimals` as `Uint<128>`. Sixteen bytes, little-endian.
    await emit0018(address, KIND.shieldedNative, "decimals", encodeCompactUint(6, 16), 300,
      { eventId: 1960, valType: 2 });
    expect((await row(address, KIND.shieldedNative)).decimals).toBe(6);
    expect(await kv(address, "decimals")).toMatchObject({
      name_variant: "mip-0018", val_type: 2, val_len: 16,
      value_hex: "06000000000000000000000000000000", projection_error: null,
    });

    // The SAME sixteen bytes under the draft name are a number the draft's one-byte rule refuses to
    // project — so the column empties rather than showing 6·2^120, and the trait is kept and
    // flagged. A projection failure is never a rejection (MIP §5.2).
    await emit(address, KIND.shieldedNative, "decimals", encodeCompactUint(6, 16), 301,
      { eventId: 1961, valType: 2 });
    expect((await row(address, KIND.shieldedNative)).decimals).toBeNull();
    expect(await kv(address, "decimals")).toMatchObject({
      name_variant: "legacy-mip-xxxx", val_type: 2, val_len: 16, projection_error: "decimals_len",
    });

    // The draft's own encoding — one big-endian byte — still projects, which is what keeps the
    // deployed reference contracts reading correctly.
    await emit(address, KIND.shieldedNative, "decimals", encodeInteger(6, 1), 302,
      { eventId: 1962, valType: 2 });
    expect((await row(address, KIND.shieldedNative)).decimals).toBe(6);
    expect(await kv(address, "decimals")).toMatchObject({
      name_variant: "legacy-mip-xxxx", val_len: 1, value_hex: "06", projection_error: null,
    });

    // A width only the standard permits, at the far end of the range: 31 bytes, and the number is
    // read from its own low byte.
    await emit0018(address, KIND.shieldedNative, "decimals", encodeCompactUint(18, 31), 303,
      { eventId: 1963, valType: 2 });
    expect((await row(address, KIND.shieldedNative)).decimals).toBe(18);
    expect(await kv(address, "decimals")).toMatchObject({ name_variant: "mip-0018", val_len: 31 });
    // …while the draft name refuses that width at the transport, so the value in force does not
    // move and the rejected event is still recorded as evidence about the contract.
    expect(await emit(address, KIND.shieldedNative, "decimals", encodeCompactUint(18, 31), 304,
      { eventId: 1964, valType: 2 })).toMatchObject({ applied: false, rejectReason: "val_type_rule" });
    expect((await row(address, KIND.shieldedNative)).decimals).toBe(18);
    expect(await kv(address, "decimals")).toMatchObject({ updated_event_id: "1963" });

    // Keys set under different names sit side by side on one token, each carrying its own variant —
    // which is what the page badges.
    await emit(address, KIND.shieldedNative, "name", "Draft Name", 305, { eventId: 1965 });
    await emit0018(address, KIND.shieldedNative, "symbol", "FINAL", 306, { eventId: 1966 });
    expect(await row(address, KIND.shieldedNative)).toMatchObject({
      name: "Draft Name", symbol: "FINAL", decimals: 18, status: "declared",
    });
    const variants = await sql<{ key_text: string; name_variant: string }[]>`
      SELECT key_text, name_variant FROM ${sql(schema)}.token_metadata_kv
      WHERE net = ${NET} AND address = ${Buffer.from(address, "hex")} ORDER BY key_text`;
    expect(variants).toEqual([
      { key_text: "decimals", name_variant: "mip-0018" },
      { key_text: "name", name_variant: "legacy-mip-xxxx" },
      { key_text: "symbol", name_variant: "mip-0018" },
    ]);
    // Every event of both names is stored with its own variant, rejected ones included.
    const byVariant = await sql<{ name_variant: string; n: string }[]>`
      SELECT name_variant, count(*)::text AS n FROM ${sql(schema)}.token_metadata_events
      WHERE net = ${NET} AND address = ${Buffer.from(address, "hex")}
      GROUP BY name_variant ORDER BY name_variant`;
    expect(byVariant).toEqual([
      { name_variant: "legacy-mip-xxxx", n: "4" },
      { name_variant: "mip-0018", n: "3" },
    ]);
  }, 120_000);
});
