import { readFileSync } from "node:fs";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapTokenIndexSchema } from "../bootstrap.js";
import type { ObservedMint } from "../ingest/decode.js";
import { applyMetadataEvent, applyMint } from "../ingest/fold.js";
import { readPackages, type PartEvent } from "../ingest/packages.js";
import { MIP_0018_EVENT_NAME, MIP_0018_NAME_HEX, parseTokenMetadata } from "../ingest/payload.js";

/**
 * Project 00024-01 — `[[multipart-0018-golden]]`: the MIP-0018 corpus of the REAL compiled MIP-18
 * contracts (`acedward/mip-0018-midnight-contracts` @ `cb6c675`, `fixtures/contracts/SOURCE.md`),
 * whose declarations travel as [Y] packages, folds BYTE-EXACTLY into its expected rows, long values
 * included (spec US3, SC-002).
 *
 * The corpus records the chain's view (86 Misc events of 256 bytes, each with its package and part)
 * and the contracts' own merged packages (82). Three agreements are checked for every package: the
 * [Y] reader rebuilds the recorded package from the recorded EVENTS ([Y] §4), the UC-1 decoder reads
 * the recorded fields back, and the fold produces exactly the expected rows — columns, the projected
 * `metadata` document, every trait's bytes and part count, status, colour.
 *
 * (Task B5 ran this id on a synthetic corpus in the same shape while the contracts repository's
 * corpus did not exist yet; phase 01-C re-pointed it here and deleted the synthetic one.)
 */

const DIR = "contracts";
const fixture = (file: string): string =>
  readFileSync(new URL(`./fixtures/${DIR}/${file}`, import.meta.url), "utf8");
const read = <T>(file: string): T => JSON.parse(fixture(file)) as T;

/** The pinned bytes (`fixtures/contracts/SOURCE.md`): a changed file fails here, before anything is
 *  read out of it. */
const PINNED_SHA256: Record<string, string> = {
  "events.json": "adb602dfbb4af99564b845e843de2862fc4a0c0ab2b8cfd11d4e5cfee97c3d16",
  "expected-tokens.json": "668ee3301f09cf12556c0af2b47e10ebe92c46541837e118f63227c2b7434f89",
  "mints.json": "6a0ebbaa47f9fa48fe552533b6a5f1acbae111d5d4f007711858e23cf263edb2",
  "color-vectors.json": "9d5af0eed68dacb333d6c6e03aa316ac37eef5fa7ee5f88dc4445398b9293216",
  "negative-payloads.json": "8b896e73a409bf1a790b4d54e4f9109620551dc8f11d3c2c16596171773e7751",
  "PRODUCER-SOURCE.md": "47859af6928d677b253082c406acd58f6334fd675d478e7ec1176602c0678bca",
};

interface CorpusEvent {
  eventId: number; row: string; step: number; contractAddress: string; txStandIn: string;
  segmentStandIn: number; packageId: number; part: number; parts: number; eventName: string;
  payloadHex: string;
}
interface CorpusPackage {
  packageId: number; row: string; step: number; circuit: string; contractAddress: string;
  txStandIn: string; segmentStandIn: number; parts: number; eventIds: number[]; eventName: string;
  payloadHex: string; payloadSha256: string; domainSepHex: string; kind: number; keyText: string;
  keyHex: string; valType: number; len: number; valueHex: string;
}
interface CorpusMint { row: string; contractAddress: string; domainSepHex: string; kindByte: 0 | 1; amount: string; op: string }
interface Trait { valType: number; valLen: number; parts: number; valueHex: string; text: string | null }
interface ExpectedToken {
  row: string; contractAddress: string; domainSepHex: string; kind: number; privacy: string; storage: string;
  colorHex: string | null; name?: string; symbol?: string; decimals?: number; tokenUri?: string;
  metadata?: unknown; traits: Record<string, Trait>; mintCount: number; totalMinted: string; status: string;
}

const NET = "undeployed";
/** The keys `expected-tokens.json` states as columns (`name`, `symbol`, `decimals`, `tokenUri`) rather
 *  than as traits. */
const COLUMN_KEYS = new Set(["name", "symbol", "decimals", "tokenUri"]);
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

describe("MIP-0018 on [Y] packages — the golden corpus of the MIP-18 contracts", () => {
  const corpus = read<{ count: number; packageCount: number; events: CorpusEvent[]; packages: CorpusPackage[] }>("events.json");
  const mints = read<{ count: number; mints: CorpusMint[] }>("mints.json");
  const expected = read<{ count: number; tokens: ExpectedToken[] }>("expected-tokens.json");
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  const schema = "token_mp_golden";

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await bootstrapTokenIndexSchema(sql, { schema, net: NET });
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  it("[[multipart-0018-golden]] every package of the MIP-18 contracts' corpus is rebuilt by the [Y] reader from its recorded events, decodes to its recorded fields, and folds byte-exactly into the expected rows — long values included", async () => {
    // ── the corpus is the pinned one, byte for byte ─────────────────────────────────────────
    for (const [file, digest] of Object.entries(PINNED_SHA256)) {
      expect(sha(new Uint8Array(Buffer.from(fixture(file), "utf8"))), file).toBe(digest);
    }
    expect(corpus.events).toHaveLength(corpus.count);
    expect(corpus.count).toBe(86);
    expect(corpus.packages).toHaveLength(corpus.packageCount);
    expect(corpus.packageCount).toBe(82);
    expect(corpus.packages.reduce((n, p) => n + p.eventIds.length, 0)).toBe(86);

    // ── reader and decoder agree with the corpus, package by package ───────────────────────
    const byId = new Map(corpus.events.map((e) => [e.eventId, e]));
    for (const p of corpus.packages) {
      const label = `${p.row} ${p.circuit} (${p.keyText})`;
      expect(p.eventName, label).toBe(MIP_0018_EVENT_NAME);
      // The chain's view: the package's events, as the indexer delivers them. Every one carries the
      // corpus's per-call transaction and intent stand-ins; the reader must find the package's
      // boundaries from them alone.
      const events: PartEvent[] = p.eventIds.map((id, index) => {
        const e = byId.get(id)!;
        expect(e, `${label} event ${id}`).toBeDefined();
        expect([e.packageId, e.part, e.parts, e.txStandIn], `${label} event ${id}`)
          .toEqual([p.packageId, index + 1, p.parts, p.txStandIn]);
        return {
          network: NET, contract: e.contractAddress, nameHex: MIP_0018_NAME_HEX,
          transactionHash: e.txStandIn, segment: e.segmentStandIn,
          position: e.eventId, payload: new Uint8Array(Buffer.from(e.payloadHex, "hex")), phase: "guaranteed",
        };
      });
      const [pkg, ...more] = readPackages(events).packages;
      expect(more, label).toEqual([]);
      expect(Buffer.from(pkg!.payload).toString("hex"), label).toBe(p.payloadHex);
      expect(sha(pkg!.payload), label).toBe(p.payloadSha256);
      expect(pkg!.positions, label).toEqual(p.eventIds);
      const parsed = parseTokenMetadata(pkg!.payload, "mip-0018");
      expect(parsed.applied, `${label}: ${parsed.rejectReason}`).toBe(true);
      expect(parsed.parts, label).toBe(p.parts);
      expect(Buffer.from(parsed.domainSep).toString("hex"), label).toBe(p.domainSepHex);
      expect(parsed.kindByte, label).toBe(p.kind);
      expect(parsed.keyText, label).toBe(p.keyText);
      expect(parsed.valType, label).toBe(p.valType);
      expect(parsed.valLen, label).toBe(p.len);
      expect(Buffer.from(parsed.valueBytes).toString("hex"), label).toBe(p.valueHex);
      expect(parsed.projectionError, label).toBeUndefined();
    }
    // All events of the corpus read at once — every call's events in one list, as a block would
    // deliver them — still form exactly the recorded packages: the grouping key keeps them apart.
    const all = readPackages(corpus.events.map((e) => ({
      network: NET, contract: e.contractAddress, nameHex: MIP_0018_NAME_HEX,
      transactionHash: e.txStandIn, segment: e.segmentStandIn, position: e.eventId,
      payload: new Uint8Array(Buffer.from(e.payloadHex, "hex")), phase: "guaranteed" as const,
    }))).packages;
    expect(all.map((p) => sha(p.payload)).sort()).toEqual(corpus.packages.map((p) => p.payloadSha256).sort());
    // The long values the corpus exists for (spec US3: ~700 bytes in 3 parts, ~400 in 2).
    const long = corpus.packages.filter((p) => p.parts > 1).map((p) => [p.row, p.keyText, p.len, p.parts]);
    expect(long).toEqual([
      ["LMOON18", "description", 377, 2],
      ["SNEB18", "metadata", 677, 3],
      ["CNST18", "metadata", 279, 2],
    ]);

    // ── the fold: mints first, then every package in emission order, one intent each ───────
    for (const [index, m] of mints.mints.entries()) {
      const observed: ObservedMint = {
        segment: 1, callIndex: index, address: m.contractAddress, domainSep: m.domainSepHex,
        kind: m.kindByte, amount: BigInt(m.amount), entryPoint: m.op, section: "guaranteed",
      };
      await sql.begin(async (tx) => applyMint(tx, schema, NET, observed, {
        txHash: "ff".repeat(31) + index.toString(16).padStart(2, "0"), blockHeight: 900, txPosition: 0,
      }));
    }
    for (const p of corpus.packages) {
      const outcome = await sql.begin(async (tx) => applyMetadataEvent(tx, schema, NET, {
        eventId: p.eventIds[0]! + 1, // the indexer's ids are positive; a package's id is its first part's (P1)
        partEventIds: p.eventIds.map((id) => id + 1),
        contractAddress: p.contractAddress,
        txHash: p.txStandIn,
        blockHeight: 1_000 + p.packageId, txPosition: 0,
        nameHex: MIP_0018_NAME_HEX, payloadHex: p.payloadHex, segment: p.segmentStandIn, phase: "guaranteed",
      }));
      expect(outcome, `${p.row} ${p.circuit}`).toMatchObject({ stored: true, applied: true, projectionError: undefined });
    }

    // ── …into exactly the expected rows ────────────────────────────────────────────────────
    const rows = await sql<{
      address: Buffer; domain_sep: Buffer; kind: number; privacy: string; storage: string; color: Buffer | null;
      name: string | null; symbol: string | null; decimals: number | null; token_uri: string | null;
      metadata: unknown; mint_count: string; total_minted: string; status: string;
    }[]>`
      SELECT address, domain_sep, kind, privacy, storage, color, name, symbol, decimals, token_uri, metadata,
             mint_count::text, total_minted::text, status
      FROM ${sql(schema)}.tokens WHERE net = ${NET} AND status <> 'builtin'`;
    expect(rows).toHaveLength(expected.count);
    expect(expected.count).toBe(17);
    for (const want of expected.tokens) {
      const label = `${want.row} kind ${want.kind} ${want.domainSepHex.slice(0, 16)}`;
      const row = rows.find((r) => r.address.toString("hex") === want.contractAddress
        && r.domain_sep.toString("hex") === want.domainSepHex && r.kind === want.kind);
      expect(row, label).toBeDefined();
      expect({
        privacy: row!.privacy, storage: row!.storage, colorHex: row!.color?.toString("hex") ?? null,
        name: row!.name, symbol: row!.symbol, decimals: row!.decimals, tokenUri: row!.token_uri,
        metadata: row!.metadata ?? null, mintCount: Number(row!.mint_count), totalMinted: row!.total_minted,
        status: row!.status,
      }, label).toEqual({
        privacy: want.privacy, storage: want.storage, colorHex: want.colorHex,
        name: want.name ?? null, symbol: want.symbol ?? null, decimals: want.decimals ?? null,
        tokenUri: want.tokenUri ?? null, metadata: want.metadata ?? null, mintCount: want.mintCount,
        totalMinted: want.totalMinted, status: want.status,
      });

      // Every trait: its type, its length, its bytes, its text, and the number of parts of the
      // package that set it — read back through the kv row's own event id. The corpus lists the
      // four keys it projects into columns (checked above) as columns only; every other key,
      // `metadata` included, is a trait, and the set must match exactly.
      const traits = await sql<{ key_text: string; val_type: number; val_len: number; value: Buffer; parts: number }[]>`
        SELECT kv.key_text, kv.val_type, kv.val_len, kv.value, e.parts
        FROM ${sql(schema)}.token_metadata_kv kv
        JOIN ${sql(schema)}.token_metadata_events e ON e.net = kv.net AND e.event_id = kv.updated_event_id
        WHERE kv.net = ${NET} AND kv.address = ${Buffer.from(want.contractAddress, "hex")}
          AND kv.domain_sep = ${Buffer.from(want.domainSepHex, "hex")} AND kv.kind = ${want.kind}`;
      const got = Object.fromEntries(traits.filter((t) => !COLUMN_KEYS.has(t.key_text)).map((t) => [t.key_text, {
        valType: t.val_type, valLen: t.val_len, parts: t.parts, valueHex: t.value.toString("hex"),
        text: t.val_type === 1 || t.val_type === 3 || t.val_type === 4 ? t.value.toString("utf8") : null,
      }]));
      expect(got, `${label} traits`).toEqual(want.traits);
    }

    // History keeps every package, long ones whole: LMOON18's first description, its Null and the
    // 377-byte value are three rows; the current value is the last.
    const history = await sql<{ val_type: number; val_len: number; parts: number }[]>`
      SELECT val_type, val_len, parts FROM ${sql(schema)}.token_metadata_events
      WHERE net = ${NET} AND key_text = 'description' ORDER BY block_height, tx_position, event_id`;
    expect(history).toEqual([
      { val_type: 1, val_len: 52, parts: 1 }, { val_type: 5, val_len: 0, parts: 1 }, { val_type: 1, val_len: 377, parts: 2 },
    ]);
    // …and nothing was rejected: every package the contracts emit is a valid declaration.
    const rejected = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM ${sql(schema)}.token_metadata_events WHERE net = ${NET} AND NOT applied`;
    expect(rejected[0]!.n).toBe("0");
  }, 180_000);
});
