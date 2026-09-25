import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { createTokenApi, listen } from "../api/server.js";
import { bootstrapTokenIndexSchema } from "../bootstrap.js";
import { pad32, tokenColorHex } from "../color.js";
import type { TokenIndexerConfig } from "../config.js";
import type { ObservedMint } from "../ingest/decode.js";
import { applyMetadataEvent, applyMint, ensureSeenToken, type PackagePhase } from "../ingest/fold.js";
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
  let nextId = 100;

  const config = (): TokenIndexerConfig => ({
    pgUrl: "", indexerHttp: undefined, net: NET, apiPort: 0,
    schema, archiveSchema: "chain_archive_absent", scanBatch: 500, live2x: false,
  });

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
    expect(list.items.map((t: any) => t.status).sort()).toEqual(["builtin", "builtin", "declared", "declared", "described", "seen"]);
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
    expect(status.counters).toMatchObject({ packages: 9, multipartPackages: 2, mixedPackages: 1 });
  }, 120_000);
});
