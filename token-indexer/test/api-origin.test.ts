import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { TokenIndexQueries, originsOf } from "../api/queries.js";
import { createTokenApi, listen } from "../api/server.js";
import { bootstrapTokenIndexSchema } from "../bootstrap.js";
import { pad32, tokenColorHex } from "../color.js";
import type { TokenIndexerConfig } from "../config.js";
import type { ObservedMint } from "../ingest/decode.js";
import { applyMetadataEvent, applyMint, ensureSeenToken, type PackagePhase } from "../ingest/fold.js";
import { insertActivityRow } from "../ingest/store.js";
import {
  LEGACY_NAME_HEX, MIP_0018_NAME_HEX, encodeCompactUint, encodeTokenMetadataUc1, splitIntoParts,
} from "../ingest/payload.js";
import { metadataPayloadHex } from "./helpers/fake-ledger.js";

/**
 * Project 00024-01 task B6 — `[[token-api-origin]]`: the API returns the origin of every value it
 * serves (spec 00024 FR-016b, US6), and the metadata events and traits carry their [Y] package
 * (`segment`, `parts`, `partEventIds`, `phase`; FR-015). Additive only: the page is not changed in
 * this project, and every earlier route keeps its meaning (the 00020/00023 API suites still pass).
 *
 * Real HTTP server on an OS-assigned port, real Postgres. The seed covers every origin a value can
 * have today: a MIP-0018 declaration (one part and multi-part, guaranteed and mixed), a draft-name
 * declaration, a chain fact (mint, seen colour), a derived value (colour, status, the built-ins)
 * and `none` with each of its reasons (no declaration, cleared by a Null, not projected).
 */

const NET = "undeployed";
const SNEB = "5e".repeat(32);   // shielded native, described: a mint + MIP-0018 declarations
const LMOON = "1a".repeat(32);  // unshielded ledger: declarations only, a Null, a projection error
const DRAFT = "d7".repeat(32);  // a draft-name declaration (legacy path, not opted into [Y])
const SEEN_COLOR = "5c".repeat(32);
// 01-D audit F5: a whole MIP-0018 `metadata` beside draft-name `metadata/<n>` parts, twice — an
// orphan part that assembles nothing, and a complete assembly that is newer than the whole one.
const ORPHAN = "0e".repeat(32);
const ASSEMBLED = "ae".repeat(32);
const orphanDomain = Buffer.from(pad32("umbra:orphan")).toString("hex");
const assembledDomain = Buffer.from(pad32("umbra:assembled")).toString("hex");
// Round 2 (N3): two BYTE keys that decode to one key text — `metadata/0` and BOM + `metadata/0`
// (a leading BOM is dropped by the UTF-8 decoder). The evidence must name the row that supplied the
// value, not whichever row a lookup by text happens to find.
const ALIAS = "a1".repeat(32);
const aliasDomain = Buffer.from(pad32("umbra:alias")).toString("hex");
let aliasSupplierId = 0;
let aliasTwinId = 0;
// Round 3: two PROJECTABLE aliases (`metadata/0` and BOM + `metadata/0`, both valid parts) — the
// fold keeps one; the evidence must be that one, whatever order any query returns the rows in.
const ALIAS2 = "a2".repeat(32);
const alias2Domain = Buffer.from(pad32("umbra:alias2")).toString("hex");
let alias2A = 0;
let alias2B = 0;
// Round 2 (N4): a token renamed WHILE an HTTP request is between its token read and its origins read.
const RACE = "ac".repeat(32);
const raceDomain = Buffer.from(pad32("umbra:race")).toString("hex");

const snebDomain = Buffer.from(pad32("umbra:sneb18")).toString("hex");
const lmoonDomain = Buffer.from(pad32("umbra:lmoon18")).toString("hex");
const draftDomain = Buffer.from(pad32("umbra:draft")).toString("hex");
const DOCUMENT = JSON.stringify({ description: "n".repeat(649), website: "https://example.test" });

describe("token API — the origin of every value (FR-016b)", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let server: Server;
  let base: string;
  const schema = "token_api_origin";
  // The activity routes join the archive for each row's result, so the schema must exist (empty).
  const archiveSchema = "arch_api_origin";
  let nextId = 100;

  const config = (): TokenIndexerConfig => ({
    pgUrl: "", indexerHttp: undefined, net: NET, apiPort: 0,
    schema, archiveSchema, scanBatch: 500, live2x: false,
  });

  /** One draft-name declaration (one event, the legacy path); returns its event id. */
  async function declareDraft(
    address: string, domainSep: string, kind: number, key: string, value: string, height: number, valType = 3,
  ): Promise<number> {
    const eventId = nextId++;
    await sql.begin(async (tx) => applyMetadataEvent(tx, schema, NET, {
      eventId, contractAddress: address, txHash: createHash("sha256").update(`draft:${address}:${eventId}`).digest("hex"),
      blockHeight: height, nameHex: LEGACY_NAME_HEX,
      payloadHex: metadataPayloadHex({ domainSep, kindByte: kind, key, value, valType }),
    }));
    return eventId;
  }

  /** One MIP-0018 declaration as the lookup folds it: a package of `parts` consecutive event ids. */
  async function declare(
    address: string, domainSep: string, kind: number, key: string, value: string | Uint8Array,
    o: { valType?: number; height: number; position?: number; segment?: number; phase?: PackagePhase },
  ): Promise<number[]> {
    const payload = encodeTokenMetadataUc1({
      domainSep: new Uint8Array(Buffer.from(domainSep, "hex")), kindByte: kind, key, valType: o.valType ?? 1, value,
    });
    const ids = splitIntoParts(payload).map(() => nextId++);
    await sql.begin(async (tx) => applyMetadataEvent(tx, schema, NET, {
      eventId: ids[0]!, partEventIds: ids, contractAddress: address,
      txHash: createHash("sha256").update(`${address}:${ids[0]}`).digest("hex"),
      blockHeight: o.height, txPosition: o.position ?? 0, nameHex: MIP_0018_NAME_HEX,
      payloadHex: Buffer.from(payload).toString("hex"), segment: o.segment ?? 1, phase: o.phase ?? "guaranteed",
    }));
    return ids;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await bootstrapTokenIndexSchema(sql, { schema, net: NET });
    await bootstrapChainArchiveSchema(sql, archiveSchema);

    // SNEB18: minted (chain), described by MIP-0018 packages — the metadata document in 3 parts.
    const mint: ObservedMint = {
      segment: 1, callIndex: 0, address: SNEB, domainSep: snebDomain, kind: 1, amount: 1_000n,
      entryPoint: "mint", section: "guaranteed",
    };
    await sql.begin(async (tx) => applyMint(tx, schema, NET, mint, { txHash: "a0".repeat(32), blockHeight: 10, txPosition: 0 }));
    await declare(SNEB, snebDomain, 1, "name", "Shielded Nebula · MIP-18", { height: 11, segment: 3 });
    await declare(SNEB, snebDomain, 1, "symbol", "SNEB18", { height: 12, segment: 4 });
    await declare(SNEB, snebDomain, 1, "decimals", encodeCompactUint(6, 16), { valType: 2, height: 13, segment: 5 });
    await declare(SNEB, snebDomain, 1, "metadata", DOCUMENT, { valType: 3, height: 14, segment: 6 });
    // A mixed-phase package is a publisher error that is RECORDED, never dropped (FR-002).
    await declare(SNEB, snebDomain, 1, "lore", "l".repeat(300), { height: 15, segment: 7, phase: "mixed" });

    // LMOON18: a ledger kind; tokenUri set then cleared by a Null; decimals as a string (projection).
    await declare(LMOON, lmoonDomain, 2, "name", "Ledger Moon · MIP-18", { height: 20 });
    await declare(LMOON, lmoonDomain, 2, "tokenUri", "https://example.test/lmoon.json", { valType: 4, height: 21 });
    await declare(LMOON, lmoonDomain, 2, "tokenUri", new Uint8Array(0), { valType: 5, height: 22 });
    await declare(LMOON, lmoonDomain, 2, "decimals", "6", { valType: 1, height: 23 });

    // A draft-name declaration: one event, no segment, no phase (FR-006).
    await sql.begin(async (tx) => applyMetadataEvent(tx, schema, NET, {
      eventId: nextId++, contractAddress: DRAFT, txHash: "d0".repeat(32), blockHeight: 30,
      nameHex: LEGACY_NAME_HEX,
      payloadHex: metadataPayloadHex({ domainSep: draftDomain, kindByte: 2, key: "name", value: "Draft Token" }),
    }));

    // A colour seen in public data, with no contract behind it.
    await ensureSeenToken(sql, schema, NET, SEEN_COLOR, 0, 40);

    // SNEB18's mint as an activity row (00023): a chain fact with its own origin (audit F8).
    await sql.begin(async (tx) => insertActivityRow(tx, schema, NET, {
      segment: 1, section: "guaranteed", role: "mint", itemIndex: 0, color: tokenColorHex(snebDomain, SNEB),
      kind: 1, amount: 1_000n, direction: "in", owner: undefined, ownerKey: undefined, intentHash: undefined,
      outputNo: undefined, address: SNEB, entryPoint: "mint", callIndex: 0, domainSep: snebDomain,
    }, { txHash: "a0".repeat(32), blockHeight: 10, txPosition: 0 }));

    // F5: the whole document, then a draft part `metadata/1` with no `metadata/0` — it assembles
    // nothing, so the whole document stays the value AND the evidence …
    await declare(ORPHAN, orphanDomain, 2, "metadata", JSON.stringify({ ok: true }), { valType: 3, height: 50 });
    await declareDraft(ORPHAN, orphanDomain, 2, "metadata/1", "}", 51);
    // … and the whole document, then a COMPLETE, newer draft assembly — the assembly wins both.
    await declare(ASSEMBLED, assembledDomain, 2, "metadata", JSON.stringify({ old: true }), { valType: 3, height: 60 });
    await declareDraft(ASSEMBLED, assembledDomain, 2, "metadata/0", '{"new":', 61);
    await declareDraft(ASSEMBLED, assembledDomain, 2, "metadata/1", "true}", 62);
    await declare(RACE, raceDomain, 2, "name", "Race One", { height: 65 });
    await declare(RACE, raceDomain, 2, "symbol", "RACE", { height: 65, position: 1 });
    alias2A = await declareDraft(ALIAS2, alias2Domain, 2, "metadata/0", '{"a":1}', 68);
    alias2B = await declareDraft(ALIAS2, alias2Domain, 2, "\uFEFFmetadata/0", '{"b":1}', 69);
    aliasSupplierId = await declareDraft(ALIAS, aliasDomain, 2, "metadata/0", "{}", 63);
    aliasTwinId = await declareDraft(ALIAS, aliasDomain, 2, "\uFEFFmetadata/0", "x", 64, 1);

    server = createTokenApi({ sql, config: config() });
    base = `http://127.0.0.1:${await listen(server, 0)}`;
  }, 240_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  async function get(path: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const res = await fetch(`${base}${path}`);
    expect(res.status, path).toBe(200);
    return res.json();
  }

  const ORIGINS = ["mip-0018", "public-interface", "chain", "derived", "none"];
  const FIELDS = ["name", "symbol", "decimals", "tokenUri", "metadata", "color", "status", "mints"] as const;

  /** The invariant of FR-016b on one token: every served value has an origin, a present value is
   *  never `none`, an absent one always is (with a reason), and evidence/rule/reason are there. */
  function expectEveryValueHasItsOrigin(t: any, label: string): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(Object.keys(t.origins).sort(), label).toEqual([...FIELDS].sort());
    for (const f of FIELDS) {
      const o = t.origins[f];
      expect(ORIGINS, `${label}.${f}`).toContain(o.origin);
      if (o.origin === "none") expect(typeof o.reason, `${label}.${f} reason`).toBe("string");
      if (o.origin === "derived") expect(typeof o.rule, `${label}.${f} rule`).toBe("string");
      if (o.origin === "mip-0018" || o.origin === "chain") expect(o.evidence, `${label}.${f} evidence`).toBeDefined();
    }
    for (const f of ["name", "symbol", "decimals", "tokenUri", "metadata", "color"] as const) {
      const present = t[f] !== null && t[f] !== undefined;
      expect(t.origins[f].origin !== "none", `${label}.${f}: value ${JSON.stringify(t[f])?.slice(0, 40)} vs origin ${t.origins[f].origin}`).toBe(present);
    }
    expect(t.origins.mints.origin, `${label}.mints`).toBe(t.mintCount > 0 ? "chain" : "none");
  }

  it("[[token-api-origin]] every value the token routes serve carries its origin — mip-0018 with its package, chain, derived with the rule, none with the reason — and events, traits, mints and activity carry theirs", async () => {
    // ── every token of every list route ─────────────────────────────────────────────────────
    const list = await get("/v1/tokens?limit=100");
    expect(list.items.map((t: any) => t.status).sort()).toEqual(["builtin", "builtin", "declared", "declared", "declared", "declared", "declared", "declared", "declared", "described", "seen"]);
    for (const t of list.items) expectEveryValueHasItsOrigin(t, `list ${t.symbol ?? t.color ?? t.status}`);

    // ── SNEB18: MIP-0018 packages, a chain mint, a derived colour and status ─────────────────
    const sneb = await get(`/v1/contracts/${SNEB}/tokens/${snebDomain}/1`);
    expectEveryValueHasItsOrigin(sneb, "SNEB18");
    expect(sneb.metadata).toEqual(JSON.parse(DOCUMENT));
    expect(sneb.origins.metadata).toMatchObject({
      origin: "mip-0018",
      evidence: { key: "metadata", nameVariant: "mip-0018", parts: 3, segment: 6, phase: "guaranteed", blockHeight: 14, txPosition: 0 },
    });
    expect(sneb.origins.metadata.evidence.eventIds).toHaveLength(3);
    expect(sneb.origins.name).toMatchObject({ origin: "mip-0018", evidence: { key: "name", parts: 1, segment: 3 } });
    expect(sneb.origins.tokenUri).toEqual({ origin: "none", reason: "no declaration" });
    expect(sneb.origins.color).toMatchObject({ origin: "derived", evidence: { address: SNEB, domainSep: snebDomain } });
    expect(sneb.color).toBe(tokenColorHex(snebDomain, SNEB));
    expect(sneb.origins.status).toMatchObject({ origin: "derived", evidence: { mintCount: 1, declared: true } });
    expect(sneb.origins.status.rule).toMatch(/§7\.2/);
    expect(sneb.origins.mints).toMatchObject({ origin: "chain", evidence: { mintCount: 1, firstMintHeight: 10, lastMintHeight: 10 } });

    // Its traits carry their package — segment, parts, part event ids, phase — and an origin.
    const traits = (await get(`/v1/contracts/${SNEB}/tokens/${snebDomain}/1/metadata`)).keys;
    const byKey = Object.fromEntries(traits.map((k: any) => [k.key, k]));
    expect(byKey.metadata).toMatchObject({ valLen: 649 + 51, parts: 3, segment: 6, phase: "guaranteed", txPosition: 0 });
    expect(byKey.metadata.partEventIds).toHaveLength(3);
    expect(byKey.metadata.partEventIds[0]).toBe(byKey.metadata.eventId);
    expect(byKey.lore).toMatchObject({ valLen: 300, parts: 2, phase: "mixed" });
    for (const k of traits) {
      expect(k.origin.origin, k.key).toBe("mip-0018");
      expect(k.origin.evidence.eventIds, k.key).toEqual(k.partEventIds);
      expect(k.origin.evidence.parts, k.key).toBe(k.parts);
    }
    // Its mints are chain facts.
    const mints = await get(`/v1/contracts/${SNEB}/tokens/${snebDomain}/1/mints`);
    expect(mints.items).toHaveLength(1);
    expect(mints.items[0].origin).toMatchObject({ origin: "chain", evidence: { txHash: "a0".repeat(32), blockHeight: 10, segment: 1, callIndex: 0 } });

    // …and the colour document serves the same token with the same origins.
    const colour = await get(`/v1/colors/${sneb.color}`);
    expect(colour.tokens[0].origins).toEqual(sneb.origins);
    expect(colour.tokens[0].traits.map((k: any) => k.origin.origin)).toEqual(traits.map(() => "mip-0018"));

    // ── LMOON18: a ledger kind — no colour; a Null clears; a projection that fails ───────────
    const lmoon = await get(`/v1/contracts/${LMOON}/tokens/${lmoonDomain}/2`);
    expectEveryValueHasItsOrigin(lmoon, "LMOON18");
    expect(lmoon.origins.color).toEqual({ origin: "none", reason: "a ledger kind has no colour (MIP-0018 §3)" });
    expect(lmoon.origins.tokenUri).toMatchObject({ origin: "none", reason: "cleared by a Null declaration", evidence: { key: "tokenUri", blockHeight: 22 } });
    expect(lmoon.origins.decimals).toMatchObject({ origin: "none", reason: "declared but not projected: val_type_mismatch" });
    expect(lmoon.origins.mints).toEqual({ origin: "none", reason: "no observed mint" });

    // ── the draft name: a MIP-0018 draft declaration, one event, no package fields ──────────
    const draft = await get(`/v1/contracts/${DRAFT}/tokens/${draftDomain}/2`);
    expectEveryValueHasItsOrigin(draft, "draft");
    expect(draft.origins.name).toMatchObject({ origin: "mip-0018", evidence: { nameVariant: "legacy-mip-xxxx", parts: 1, segment: null, phase: null } });

    // ── the seen colour and the built-ins ───────────────────────────────────────────────────
    const seen = list.items.find((t: any) => t.status === "seen");
    expect(seen.origins.color).toMatchObject({ origin: "chain", evidence: { firstSeenHeight: 40 } });
    expect(seen.origins.name.reason).toMatch(/no contract is known/);
    const night = list.items.find((t: any) => t.symbol === "NIGHT");
    const dust = list.items.find((t: any) => t.symbol === "DUST");
    expect(night.origins.name.origin).toBe("derived");
    expect(night.origins.color).toMatchObject({ origin: "derived", rule: expect.stringMatching(/native token/) });
    expect(dust.origins.color).toMatchObject({ origin: "none", reason: expect.stringMatching(/Q30/) });

    // ── metadata events: the package, its SHA-256, its origin ───────────────────────────────
    const events = await get(`/v1/contracts/${SNEB}/events`);
    const meta = events.items.find((e: any) => e.keyText === "metadata");
    expect(meta).toMatchObject({ segment: 6, parts: 3, phase: "guaranteed", payloadLength: 768, txPosition: 0 });
    expect(meta.partEventIds).toEqual(byKey.metadata.partEventIds);
    const expectedPayload = encodeTokenMetadataUc1({
      domainSep: new Uint8Array(Buffer.from(snebDomain, "hex")), kindByte: 1, key: "metadata", valType: 3, value: DOCUMENT,
    });
    expect(meta.payloadSha256).toBe(createHash("sha256").update(expectedPayload).digest("hex"));
    expect(meta.origin).toMatchObject({ origin: "mip-0018", evidence: { parts: 3, segment: 6, eventIds: meta.partEventIds } });
    for (const e of events.items) expect(e.origin.origin).toBe("mip-0018");

    // ── the registry and /internal/status ───────────────────────────────────────────────────
    const registry = await get("/v1/registry.json");
    expect(registry.tokens[sneb.color].origins.metadata).toEqual(sneb.origins.metadata);
    const status = await get("/internal/status");
    expect(status.counters).toMatchObject({ packages: 13, multipartPackages: 2, mixedPackages: 1 });

    // ── activity rows carry a chain origin (audit F8: the claim above is now exercised) ─────
    for (const path of [`/v1/colors/${sneb.color}/transactions`, `/v1/contracts/${SNEB}/tokens/${snebDomain}/1/transactions`]) {
      const activity = await get(path);
      expect(activity.items, path).toHaveLength(1);
      expect(activity.items[0], path).toMatchObject({ role: "mint", amount: "1000" });
      expect(activity.items[0].origin, path).toEqual({
        origin: "chain", rule: expect.stringMatching(/counted public token movement/),
        evidence: { txHash: "a0".repeat(32), blockHeight: 10, txPosition: 0, segment: 1, section: "guaranteed", role: "mint", itemIndex: 0 },
      });
    }

    // ── metadata evidence is the declaration the document came from (audit F5) ──────────────
    const orphan = await get(`/v1/contracts/${ORPHAN}/tokens/${orphanDomain}/2`);
    expectEveryValueHasItsOrigin(orphan, "orphan");
    expect(orphan.metadata).toEqual({ ok: true });
    // Before the fix this cited the newer, incomplete `metadata/1` part.
    expect(orphan.origins.metadata).toMatchObject({ origin: "mip-0018", evidence: { key: "metadata", nameVariant: "mip-0018", blockHeight: 50 } });
    const assembled = await get(`/v1/contracts/${ASSEMBLED}/tokens/${assembledDomain}/2`);
    expectEveryValueHasItsOrigin(assembled, "assembled");
    expect(assembled.metadata).toEqual({ new: true });
    expect(assembled.origins.metadata.origin).toBe("mip-0018");
    expect(assembled.origins.metadata.evidence.map((e: any) => [e.key, e.nameVariant, e.blockHeight])).toEqual([
      ["metadata/0", "legacy-mip-xxxx", 61], ["metadata/1", "legacy-mip-xxxx", 62],
    ]);

    // … and it names the ROW that supplied the value when two byte keys share a key text (N3).
    const [aliasRows] = await Promise.all([sql<{ key_text: string; key_hex: string; projection_error: string | null }[]>`
      SELECT key_text, key_hex, projection_error FROM ${sql(schema)}.token_metadata_kv
      WHERE net = ${NET} AND address = ${Buffer.from(ALIAS, "hex")} ORDER BY updated_event_id`]);
    expect(aliasRows.map((r) => r.key_text)).toEqual(["metadata/0", "metadata/0"]); // one text, two keys
    expect(aliasRows[0]!.key_hex).not.toBe(aliasRows[1]!.key_hex);
    expect(aliasRows[1]!.projection_error).not.toBeNull(); // the twin is not a projectable part
    const alias = await get(`/v1/contracts/${ALIAS}/tokens/${aliasDomain}/2`);
    expect(alias.metadata).toEqual({});
    expect(alias.origins.metadata.evidence.map((e: any) => e.eventIds)).toEqual([[aliasSupplierId]]);
    expect(aliasTwinId).toBeGreaterThan(aliasSupplierId);

    // … and with two PROJECTABLE aliases (round 3) the evidence is the row the stored value came
    // from: the fold records it (`tokens.metadata_event_ids`) and the API cites exactly that.
    const alias2 = await get(`/v1/contracts/${ALIAS2}/tokens/${alias2Domain}/2`);
    const supplier = (alias2.metadata as { a?: number }).a === 1 ? alias2A : alias2B;
    const other = supplier === alias2A ? alias2B : alias2A;
    expect([{ a: 1 }, { b: 1 }]).toContainEqual(alias2.metadata);
    expect(alias2.origins.metadata.evidence.map((e: any) => e.eventIds)).toEqual([[supplier]]);
    const storedIds = await sql<{ ids: string[] | null }[]>`
      SELECT metadata_event_ids::text[] AS ids FROM ${sql(schema)}.tokens WHERE net = ${NET} AND address = ${Buffer.from(ALIAS2, "hex")}`;
    expect(storedIds[0]!.ids).toEqual([String(supplier)]);
    // The binding holds for ANY row order: the pure `originsOf` over the same kv rows, forwards and
    // reversed, cites the stored supplier both times — re-deriving the choice would follow the order.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kvRows = await sql<any[]>`
      SELECT kv.key_text, kv.name_variant, kv.val_type, kv.projection_error, kv.val_len, kv.value,
             kv.updated_event_id::text, kv.updated_height::text, kv.updated_tx_position,
             e.tx_hash, e.segment, e.parts, e.part_event_ids::text[] AS part_event_ids, e.phase
      FROM ${sql(schema)}.token_metadata_kv kv
      LEFT JOIN ${sql(schema)}.token_metadata_events e ON e.net = kv.net AND e.event_id = kv.updated_event_id
      WHERE kv.net = ${NET} AND kv.address = ${Buffer.from(ALIAS2, "hex")}`;
    expect(kvRows.map((r) => r.key_text)).toEqual(["metadata/0", "metadata/0"]);
    expect(kvRows.every((r) => r.projection_error === null)).toBe(true); // both projectable
    for (const rows of [kvRows, [...kvRows].reverse()]) {
      expect(originsOf(alias2, rows, storedIds[0]!.ids).metadata).toMatchObject({ origin: "mip-0018" });
      expect((originsOf(alias2, rows, storedIds[0]!.ids).metadata as any).evidence.map((e: any) => e.eventIds)).toEqual([[supplier]]);
    }
    // (Without the stored ids one of the two orders cites the other row — the defect they remove.)
    const rederived = [kvRows, [...kvRows].reverse()].map((rows) => (originsOf(alias2, rows).metadata as any).evidence.map((e: any) => e.eventIds));
    expect(rederived).toContainEqual([[other]]);

    // ── one snapshot per HTTP request (audit F6; round 2 N4): a second server whose query object
    //    commits a rename (on another connection) between the token read and the origins read of
    //    the next request it serves — the token route, then the tokenUri resolver ───────────────
    let armed: (() => Promise<void>) | undefined;
    const racing = createTokenApi({
      sql, config: config(),
      testHooks: { beforeOrigins: async () => { const once = armed; armed = undefined; await once?.(); } },
    });
    const raceBase = `http://127.0.0.1:${await listen(racing, 0)}`;
    const raceGet = async (path: string): Promise<any> => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const res = await fetch(`${raceBase}${path}`);
      expect(res.status, path).toBe(200);
      return res.json();
    };
    try {
      armed = () => declare(RACE, raceDomain, 2, "name", "Race Two", { height: 66 }).then(() => undefined);
      const during = await raceGet(`/v1/contracts/${RACE}/tokens/${raceDomain}/2`);
      expect(armed).toBeUndefined(); // the rename really committed in the middle of that request
      // One snapshot: the old name WITH the old name's evidence (not the new declaration's).
      expect(during.name).toBe("Race One");
      expect(during.origins.name).toMatchObject({ origin: "mip-0018", evidence: { key: "name", blockHeight: 65 } });
      const after = await raceGet(`/v1/contracts/${RACE}/tokens/${raceDomain}/2`);
      expect(after.name).toBe("Race Two");
      expect(after.origins.name.evidence.blockHeight).toBe(66);

      // The resolver: candidates (with origins) first, then the traits — one snapshot too.
      armed = () => declare(RACE, raceDomain, 2, "name", "Race Three", { height: 67 }).then(() => undefined);
      const resolved = await raceGet("/RACE/race");
      expect(armed).toBeUndefined();
      expect(resolved.name).toBe("Race Two");
      expect(resolved.traits.name.text).toBe(resolved.name);
    } finally {
      await new Promise<void>((resolve) => racing.close(() => resolve()));
    }

    // ── one snapshot per request (audit F6): a fold committed between two reads of one
    //    request is invisible to both; the next request sees it, value and evidence together ──
    const queries = new TokenIndexQueries(sql, schema, NET, archiveSchema);
    const inside = await queries.inSnapshot(async () => {
      const before = await queries.token(LMOON, lmoonDomain, 2);
      // committed on ANOTHER connection while the snapshot is open
      await declare(LMOON, lmoonDomain, 2, "name", "Ledger Moon · renamed", { height: 70 });
      const after = await queries.token(LMOON, lmoonDomain, 2);
      return { before, after };
    });
    expect(inside.before!.name).toBe("Ledger Moon · MIP-18");
    expect(inside.after).toEqual(inside.before);
    const renamed = await get(`/v1/contracts/${LMOON}/tokens/${lmoonDomain}/2`);
    expect(renamed.name).toBe("Ledger Moon · renamed");
    expect(renamed.origins.name).toMatchObject({ origin: "mip-0018", evidence: { key: "name", blockHeight: 70 } });
  }, 120_000);
});
