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
import { FILES, buildSyntheticCorpus, render } from "./fixtures/multipart-synthetic/generate.js";

/**
 * Project 00024-01 task B5 — `[[multipart-0018-golden]]`: a MIP-0018 corpus of declarations carried
 * as [Y] packages folds BYTE-EXACTLY into its expected rows, long values included (spec US3, SC-002).
 *
 * **Interim corpus.** The contracts repository's regenerated simulator corpus (plan 00024-01 task
 * 01-A5) does not exist yet, so this test reads `fixtures/multipart-synthetic/` — the same shape,
 * built with this repository's UC-1 encoder, NOT contract output (its `SOURCE.md`). When 01-A5
 * lands, the corpus directory changes and nothing else should have to.
 *
 * Three agreements are checked for every package: the reader rebuilds the recorded payload from
 * the recorded parts ([Y] §4), the decoder reads the recorded fields back (UC-1), and the fold
 * produces exactly the expected rows — columns, every trait's bytes, status, colour.
 */

const DIR = "multipart-synthetic";
const read = <T>(file: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${DIR}/${file}`, import.meta.url), "utf8")) as T;

interface CorpusPackage {
  row: string; step: number; op: string; contractAddress: string; eventName: string;
  segment: number; phase: "guaranteed" | "fallible"; parts: { eventId: number; payloadHex: string }[];
  payloadHex: string; payloadSha256: string; domainSepHex: string; kind: number; keyText: string;
  valType: number; len: number; valueSha256: string;
}
interface CorpusMint { row: string; contractAddress: string; domainSepHex: string; kindByte: 0 | 1; amount: string; colorHex: string }
interface Trait { valType: number; valLen: number; valueHex: string; text: string | null }
interface ExpectedToken {
  row: string; contractAddress: string; domainSepHex: string; kind: number; privacy: string; storage: string;
  colorHex: string | null; name: string | null; symbol: string | null; decimals: number | null;
  tokenUri: string | null; metadata: unknown; traits: Record<string, Trait>;
  mintCount: number; totalMinted: string; status: string;
}

const NET = "undeployed";
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

describe("MIP-0018 on [Y] packages — the golden corpus (synthetic until 01-A5)", () => {
  const packages = read<{ count: number; packages: CorpusPackage[] }>(FILES.packages);
  const mints = read<{ count: number; mints: CorpusMint[] }>(FILES.mints);
  const expected = read<{ count: number; tokens: ExpectedToken[] }>(FILES.expectedTokens);
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

  it("[[multipart-0018-golden]] every package of the corpus is rebuilt from its parts, decodes to its recorded fields, and folds byte-exactly into the expected rows — long values included (synthetic corpus in the 01-A5 shape until 01-A5 lands)", async () => {
    // ── the corpus is what its generator says, byte for byte (no hand edits) ───────────────
    const regenerated = buildSyntheticCorpus();
    for (const [key, file] of Object.entries(FILES)) {
      expect(readFileSync(new URL(`./fixtures/${DIR}/${file}`, import.meta.url), "utf8"), file)
        .toBe(render(regenerated[key as keyof typeof regenerated]));
    }
    expect(packages.packages).toHaveLength(packages.count);
    expect(packages.count).toBe(16);
    expect(packages.packages.reduce((n, p) => n + p.parts.length, 0)).toBe(22);

    // ── reader and decoder agree with the corpus, package by package ───────────────────────
    for (const p of packages.packages) {
      const label = `${p.row}#${p.step} ${p.keyText}`;
      expect(p.eventName, label).toBe(MIP_0018_EVENT_NAME);
      const events: PartEvent[] = p.parts.map((part) => ({
        network: NET, contract: p.contractAddress, nameHex: MIP_0018_NAME_HEX,
        transactionHash: (p.step + 1).toString(16).padStart(64, "0"), segment: p.segment,
        position: part.eventId, payload: new Uint8Array(Buffer.from(part.payloadHex, "hex")), phase: p.phase,
      }));
      const [pkg, ...more] = readPackages(events).packages;
      expect(more, label).toEqual([]);
      expect(Buffer.from(pkg!.payload).toString("hex"), label).toBe(p.payloadHex);
      expect(sha(pkg!.payload), label).toBe(p.payloadSha256);
      expect(pkg!.positions, label).toEqual(p.parts.map((x) => x.eventId));
      const parsed = parseTokenMetadata(pkg!.payload, "mip-0018");
      expect(parsed.applied, `${label}: ${parsed.rejectReason}`).toBe(true);
      expect(parsed.parts, label).toBe(p.parts.length);
      expect(Buffer.from(parsed.domainSep).toString("hex"), label).toBe(p.domainSepHex);
      expect(parsed.kindByte, label).toBe(p.kind);
      expect(parsed.keyText, label).toBe(p.keyText);
      expect(parsed.valType, label).toBe(p.valType);
      expect(parsed.valLen, label).toBe(p.len);
      expect(sha(parsed.valueBytes), label).toBe(p.valueSha256);
      expect(parsed.projectionError, label).toBeUndefined();
    }
    // The long values the corpus exists for.
    const long = packages.packages.filter((p) => p.parts.length > 1).map((p) => [p.row, p.keyText, p.len, p.parts.length]);
    expect(long).toEqual([
      ["SNEB18", "metadata", 697, 3],
      ["LMOON18", "description", 400, 2],
      ["CNST18", "name", 202, 2],
      ["CNST18", "lore", 300, 2],
      ["CNST18", "tokenUri", 259, 2],
    ]);

    // ── the fold: mints first, then every package in emission order, one intent each ───────
    for (const [index, m] of mints.mints.entries()) {
      const observed: ObservedMint = {
        segment: 1, callIndex: index, address: m.contractAddress, domainSep: m.domainSepHex,
        kind: m.kindByte, amount: BigInt(m.amount), entryPoint: "mint", section: "guaranteed",
      };
      await sql.begin(async (tx) => applyMint(tx, schema, NET, observed, {
        txHash: "ff".repeat(31) + index.toString(16).padStart(2, "0"), blockHeight: 900, txPosition: 0,
      }));
    }
    for (const p of packages.packages) {
      const outcome = await sql.begin(async (tx) => applyMetadataEvent(tx, schema, NET, {
        eventId: p.parts[0]!.eventId + 1, // the indexer's ids are positive
        partEventIds: p.parts.map((x) => x.eventId + 1),
        contractAddress: p.contractAddress,
        txHash: (p.step + 1).toString(16).padStart(64, "0"),
        blockHeight: 1_000 + p.step, txPosition: 0,
        nameHex: MIP_0018_NAME_HEX, payloadHex: p.payloadHex, segment: p.segment, phase: p.phase,
      }));
      expect(outcome, `${p.row}#${p.step}`).toMatchObject({ stored: true, applied: true, projectionError: undefined });
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
    for (const want of expected.tokens) {
      const row = rows.find((r) => r.address.toString("hex") === want.contractAddress
        && r.domain_sep.toString("hex") === want.domainSepHex && r.kind === want.kind);
      expect(row, want.row).toBeDefined();
      expect({
        privacy: row!.privacy, storage: row!.storage, colorHex: row!.color?.toString("hex") ?? null,
        name: row!.name, symbol: row!.symbol, decimals: row!.decimals, tokenUri: row!.token_uri,
        metadata: row!.metadata ?? null, mintCount: Number(row!.mint_count), totalMinted: row!.total_minted,
        status: row!.status,
      }, want.row).toEqual({
        privacy: want.privacy, storage: want.storage, colorHex: want.colorHex,
        name: want.name, symbol: want.symbol, decimals: want.decimals, tokenUri: want.tokenUri,
        metadata: want.metadata, mintCount: want.mintCount, totalMinted: want.totalMinted, status: want.status,
      });

      const traits = await sql<{ key_text: string; val_type: number; val_len: number; value: Buffer }[]>`
        SELECT key_text, val_type, val_len, value FROM ${sql(schema)}.token_metadata_kv
        WHERE net = ${NET} AND address = ${Buffer.from(want.contractAddress, "hex")}
          AND domain_sep = ${Buffer.from(want.domainSepHex, "hex")} AND kind = ${want.kind}`;
      const got = Object.fromEntries(traits.map((t) => [t.key_text, {
        valType: t.val_type, valLen: t.val_len, valueHex: t.value.toString("hex"),
        text: t.val_type === 1 || t.val_type === 3 || t.val_type === 4 ? t.value.toString("utf8") : null,
      }]));
      expect(got, `${want.row} traits`).toEqual(want.traits);
    }

    // History keeps every package, long ones whole: LMOON's short description, its Null and the
    // 400-byte value are three rows; the current value is the last.
    const history = await sql<{ val_type: number; val_len: number; parts: number }[]>`
      SELECT val_type, val_len, parts FROM ${sql(schema)}.token_metadata_events
      WHERE net = ${NET} AND key_text = 'description' ORDER BY block_height, tx_position, event_id`;
    expect(history).toEqual([
      { val_type: 1, val_len: 26, parts: 1 }, { val_type: 5, val_len: 0, parts: 1 }, { val_type: 1, val_len: 400, parts: 2 },
    ]);
  }, 180_000);
});
