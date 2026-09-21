import type { Server } from "node:http";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { TokenIndexQueries } from "../api/queries.js";
import { createTokenApi, domainText, kindParam, listen, resolverMatches, slugOfFirstWord } from "../api/server.js";
import { bootstrapTokenIndexSchema } from "../bootstrap.js";
import { pad32, tokenColorHex } from "../color.js";
import type { TokenIndexerConfig } from "../config.js";
import type { ObservedMint } from "../ingest/decode.js";
import { applyMetadataEvent, applyMint, type RawContractEvent } from "../ingest/fold.js";
import { TOKEN_METADATA_NAME_HEX, encodeInteger } from "../ingest/payload.js";
import { metadataPayloadHex } from "./helpers/fake-ledger.js";

/**
 * Projects 00020/00021 — `[[token-api-contract]]`.
 *
 * Every route of spec 00020 §5 as amended by 00021 FR-106, against a fixture database, over a REAL
 * HTTP server on an OS-assigned port: pagination, filters, the four error codes, the numeric kind
 * byte with its privacy/storage words, typed traits, the linked-rows route, and the `tokenUri`
 * resolver in all three of its spellings plus its 404 and its 409.
 */

const NET = "stagenet";
/** MIP §3's four values. */
const KIND = { unshieldedNative: 0, shieldedNative: 1, unshieldedLedger: 2 } as const;

/** The Constellations collection: one contract, five pieces, dynamic domain separators. */
const CNST = "c0".repeat(32);
/** A ledger token: declared, never minted, no colour. */
const LEDGER = "1e".repeat(32);
/** A token minted but never described. */
const GHOST = "6f".repeat(32);
/** Declares a ledger book and mints natively: two rows under one domain separator (MIP §6.3). */
const LIAR = "11".repeat(32);
/** Two contracts that share a symbol, so the resolver has a genuine ambiguity to report. */
const TWIN_A = "7a".repeat(32);
const TWIN_B = "7b".repeat(32);

describe("token API (spec §5, FR-106)", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let server: Server;
  let base: string;
  const schema = "token_api_test";
  let nextEventId = 1;

  const config = (): TokenIndexerConfig => ({
    pgUrl: "", indexerHttp: undefined, net: NET, apiPort: 0,
    schema, archiveSchema: "chain_archive_absent", scanBatch: 500, live2x: false,
  });

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await bootstrapTokenIndexSchema(sql, { schema, net: NET });
    await seed();
    server = createTokenApi({ sql, config: config() });
    // Port 0 = an OS-assigned free port. The reserved 10020 belongs to the live `serve` only.
    const port = await listen(server, 0);
    base = `http://127.0.0.1:${port}`;
  }, 240_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  async function mint(address: string, domainSep: string, kind: 0 | 1, amount: bigint, height: number): Promise<void> {
    const observed: ObservedMint = {
      segment: 0, callIndex: 0, address, domainSep, kind, amount, entryPoint: "mint", section: "guaranteed",
    };
    await sql.begin(async (tx) => applyMint(tx, schema, NET, observed, {
      txHash: (address.slice(-40) + domainSep.slice(-16) + height.toString(16).padStart(8, "0")).slice(0, 64),
      blockHeight: height, txPosition: 0,
    }));
  }

  async function emit(
    address: string, domainSep: string, kindByte: number, key: string | Uint8Array,
    value: string | Uint8Array, height: number, valType = 1,
  ): Promise<void> {
    const event: RawContractEvent = {
      eventId: nextEventId++,
      contractAddress: address,
      txHash: (address.slice(-48) + height.toString(16).padStart(16, "0")),
      blockHeight: height,
      nameHex: TOKEN_METADATA_NAME_HEX,
      payloadHex: metadataPayloadHex({ domainSep, kindByte, key, value, valType }),
    };
    await sql.begin(async (tx) => applyMetadataEvent(tx, schema, NET, event));
  }

  const piece = (name: string): string => Buffer.from(pad32(`cnst:${name}`)).toString("hex");
  const LIAR_DOMAIN = Buffer.from(pad32("umbra:lliar")).toString("hex");

  async function seed(): Promise<void> {
    await sql`
      INSERT INTO ${sql(schema)}.contracts (net, address, deploy_tx_hash, deploy_height, first_seen_height, last_call_height)
      VALUES (${NET}, ${Buffer.from(CNST, "hex")}, ${Buffer.from("cc".repeat(32), "hex")}, 500, 500, 540)
    `;
    // Constellations: three pieces, each minted once and described.
    const pieces: [string, string, string][] = [
      ["orion", "Constellations · Orion", "1.77"],
      ["lyra", "Constellations · Lyra", "0.03"],
      ["vega", "Constellations · Vega", "0.02"],
    ];
    let height = 510;
    for (const [id, name, magnitude] of pieces) {
      const domain = piece(id);
      await mint(CNST, domain, KIND.shieldedNative, 1n, height);
      await emit(CNST, domain, KIND.shieldedNative, "name", name, height + 1);
      await emit(CNST, domain, KIND.shieldedNative, "symbol", "CNST", height + 1);
      await emit(CNST, domain, KIND.shieldedNative, "decimals", encodeInteger(0), height + 1, 2);
      await emit(CNST, domain, KIND.shieldedNative, "tokenUri", `http://localhost:10020/constellations/${id}`, height + 1, 4);
      await emit(CNST, domain, KIND.shieldedNative, "magnitude", magnitude, height + 2);
      await emit(CNST, domain, KIND.shieldedNative, "metadata",
        JSON.stringify({ description: `The ${id} piece`, image: "data:image/svg+xml,<svg/>" }), height + 2, 3);
      height += 10;
    }
    // Orion gets a second magnitude, so last-write-wins is visible through the API.
    await emit(CNST, piece("orion"), KIND.shieldedNative, "magnitude", "1.70", 600);
    // A rejected event, so `?applied=false` has something to show: val-type 9 is reserved.
    await emit(CNST, piece("orion"), KIND.shieldedNative, "trait", "x", 601, 9);
    // …and an APPLIED event whose Appendix A projection fails, so the trait panel has one of those
    // too: `decimals` carried as a string instead of an integer (MIP §5.3).
    await emit(CNST, piece("orion"), KIND.shieldedNative, "decimals", "0", 602, 1);
    // An opaque trait, to prove the API renders by type rather than by guesswork.
    await emit(CNST, piece("orion"), KIND.shieldedNative, "fingerprint", new Uint8Array([0xde, 0xad]), 603, 0);
    // A key that is not valid UTF-8 at all (MIP §5.1): kept, keyed by its bytes.
    const oddKey = new Uint8Array(32);
    oddKey.set([0xff, 0xfe], 0);
    await emit(CNST, piece("orion"), KIND.shieldedNative, oddKey, "unspellable", 604);

    // A ledger token, declared only.
    const lsun = Buffer.from(pad32("umbra:lsun")).toString("hex");
    await emit(LEDGER, lsun, KIND.unshieldedLedger, "name", "Ledger Sun", 520);
    await emit(LEDGER, lsun, KIND.unshieldedLedger, "symbol", "LSUN", 520);

    // A minted-but-undescribed token.
    await mint(GHOST, Buffer.from(pad32("umbra:sghost")).toString("hex"), KIND.shieldedNative, 999n, 530);

    // The Ledger Liar: a kind-2 declaration and a kind-0 mint under ONE domain separator, which the
    // MIP makes two rows (§6.3) that a consumer MAY link (§4).
    await emit(LIAR, LIAR_DOMAIN, KIND.unshieldedLedger, "name", "Ledger Liar", 540);
    await emit(LIAR, LIAR_DOMAIN, KIND.unshieldedLedger, "symbol", "LLIAR", 540);
    await mint(LIAR, LIAR_DOMAIN, KIND.unshieldedNative, 7n, 541);

    // Two contracts sharing a symbol and an id — the resolver's genuine ambiguity.
    for (const address of [TWIN_A, TWIN_B]) {
      const domain = Buffer.from(pad32("twin:alpha")).toString("hex");
      await mint(address, domain, KIND.unshieldedNative, 1n, 550);
      await emit(address, domain, KIND.unshieldedNative, "name", "Twin Alpha", 551);
      await emit(address, domain, KIND.unshieldedNative, "symbol", "TWIN", 551);
    }
  }

  async function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: Headers }> {
    const res = await fetch(`${base}${path}`, { headers, redirect: "manual" });
    const text = await res.text();
    return { status: res.status, body: text === "" ? null : JSON.parse(text), headers: res.headers };
  }

  it("[[token-api-contract]] GET /v1/tokens lists, filters, searches and pages", async () => {
    const all = await get("/v1/tokens?limit=500");
    expect(all.status).toBe(200);
    // 3 Constellations pieces + ledger + ghost + 2 Liar rows + 2 twins + NIGHT + DUST
    expect(all.body.items).toHaveLength(11);
    expect(all.body.nextCursor).toBeNull();
    // Every row carries the MIP's byte and the two words it encodes (FR-106).
    for (const t of all.body.items) {
      expect([0, 1, 2, 3]).toContain(t.kind);
      expect(t.privacy).toBe(t.kind % 2 === 1 ? "shielded" : "unshielded");
      expect(t.storage).toBe(t.kind >= 2 ? "ledger" : "native");
      if (t.storage === "ledger") expect(t.color).toBeNull();
    }

    const builtin = await get("/v1/tokens?status=builtin");
    expect(builtin.body.items.map((t: any) => t.symbol).sort()).toEqual(["DUST", "NIGHT"]);
    expect(builtin.body.items.find((t: any) => t.symbol === "DUST").color).toBeNull();

    // The four kinds are addressable by their byte, and the old words still map to the native ones.
    expect((await get("/v1/tokens?kind=2")).body.items.map((t: any) => t.symbol).sort()).toEqual(["LLIAR", "LSUN"]);
    expect((await get("/v1/tokens?kind=3")).body.items).toHaveLength(0);
    expect((await get("/v1/tokens?kind=shielded")).body.items.every((t: any) => t.kind === 1)).toBe(true);
    expect((await get("/v1/tokens?kind=unshielded")).body.items.every((t: any) => t.kind === 0)).toBe(true);
    // …while `privacy` covers what the word used to mean across BOTH storages.
    expect((await get("/v1/tokens?privacy=unshielded")).body.items.every((t: any) => t.kind % 2 === 0)).toBe(true);
    expect((await get("/v1/tokens?storage=ledger")).body.items.map((t: any) => t.symbol).sort()).toEqual(["LLIAR", "LSUN"]);
    expect((await get("/v1/tokens?status=observed")).body.items.map((t: any) => t.name).sort()).toEqual([null, null]);

    // `q`: a name prefix, a symbol prefix and an exact colour all work.
    expect((await get("/v1/tokens?q=constell")).body.items).toHaveLength(3);
    expect((await get("/v1/tokens?q=LSUN")).body.items).toHaveLength(1);
    const orionColor = tokenColorHex(piece("orion"), CNST);
    const byColor = await get(`/v1/tokens?q=${orionColor}`);
    expect(byColor.body.items).toHaveLength(1);
    expect(byColor.body.items[0].name).toBe("Constellations · Orion");

    // Keyset paging walks the whole list exactly once.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const url: string = `/v1/tokens?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const res: { body: any } = await get(url);
      for (const item of res.body.items) seen.push(`${item.address}/${item.domainSep}/${item.kind}`);
      cursor = res.body.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(11);
    expect(new Set(seen).size).toBe(11);

    // Order: the built-ins first, then newest first by first-mint height (first-seen height for a
    // row that was never minted), ties by (address, domainSep, kind). Paging walks that same order.
    const ids = all.body.items.map((t: any) => `${t.address}/${t.domainSep}/${t.kind}`);
    expect(seen).toEqual(ids);
    expect(all.body.items.slice(0, 2).map((t: any) => t.symbol)).toEqual(["NIGHT", "DUST"]);
    const heights = all.body.items.slice(2).map((t: any) => t.firstMintHeight ?? t.firstSeenHeight);
    expect(heights).toEqual([...heights].sort((a: number, b: number) => b - a));

    // Each list item summarises its contract's distinct domain separators, so the page can flag a
    // contract that issues several tokens. The built-ins have no contract, hence `null`.
    const byAddress = (a: string) => all.body.items.filter((t: any) => t.address === a);
    for (const t of all.body.items.filter((t: any) => t.status === "builtin")) {
      expect(t.contractDomainSeps).toBeNull();
    }
    for (const t of byAddress(CNST)) {
      expect(t.contractDomainSeps.count).toBe(3);
      expect([...t.contractDomainSeps.first].sort())
        .toEqual(["orion", "lyra", "vega"].map(piece).sort());
    }
    // Two kinds under ONE domain separator are still one separator.
    for (const t of all.body.items.filter((t: any) => t.domainSep === LIAR_DOMAIN)) {
      expect(t.contractDomainSeps.count).toBe(1);
    }
    // Twins share a separator across two contracts: each contract has one.
    for (const t of all.body.items.filter((t: any) => t.symbol === "TWIN")) {
      expect(t.contractDomainSeps).toEqual({ count: 1, first: [t.domainSep] });
    }

    // More than five: the first five by first-seen height, and the full count. Seeded under its
    // own `net` so the shared fixture's row counts are untouched.
    const MANY_NET = "test-many-domainseps";
    const MANY = "ab".repeat(32);
    const seps = Array.from({ length: 7 }, (_, i) => Buffer.from(pad32(`many:${i}`)).toString("hex"));
    try {
      for (let i = 0; i < seps.length; i++) {
        // 00023: a native row is keyed by its colour, and the colour is what the chain would have
        // derived from this very `(domainSep, address)` pair — so the fixture derives it too.
        const color = Buffer.from(tokenColorHex(seps[i]!, MANY), "hex");
        await sql`
          INSERT INTO ${sql(schema)}.tokens
            (net, token_key, kind, address, domain_sep, color, status, first_seen_height)
          VALUES (${MANY_NET}, ${color}, 0, ${Buffer.from(MANY, "hex")},
                  ${Buffer.from(seps[i]!, "hex")}, ${color}, 'observed', ${700 + i})
        `;
      }
      const many = await new TokenIndexQueries(sql, schema, MANY_NET).listTokens({ limit: 50 });
      expect(many.items).toHaveLength(7);
      for (const t of many.items) {
        expect(t.contractDomainSeps).toEqual({ count: 7, first: seps.slice(0, 5) });
      }
    } finally {
      await sql`DELETE FROM ${sql(schema)}.tokens WHERE net = ${MANY_NET}`;
    }
  }, 60_000);

  it("[[token-api-token-routes]] the per-token routes serve the token, its typed traits with provenance, and its mints", async () => {
    const domain = piece("orion");
    const token = await get(`/v1/contracts/${CNST}/tokens/${domain}/1`);
    expect(token.status).toBe(200);
    expect(token.body).toMatchObject({
      address: CNST, domainSep: domain, kind: 1, privacy: "shielded", storage: "native",
      name: "Constellations · Orion", symbol: "CNST", status: "described",
      mintCount: 1, totalMinted: "1", deployHeight: 500,
      tokenUri: "http://localhost:10020/constellations/orion",
    });
    // `decimals` was overwritten by a badly typed event, so the column is empty and the trait is
    // flagged (MIP §5.3, question Q10's applied reading).
    expect(token.body.decimals).toBeNull();
    expect(token.body.color).toBe(tokenColorHex(domain, CNST));
    expect(token.body.metadata).toEqual({ description: "The orion piece", image: "data:image/svg+xml,<svg/>" });

    // The 00020 spelling still resolves to the same row for one release (spec Q2).
    const byWord = await get(`/v1/contracts/${CNST}/tokens/${domain}/shielded`);
    expect(byWord.body).toEqual(token.body);
    expect(kindParam("shielded")).toBe(1);
    expect(kindParam("unshielded")).toBe(0);
    expect(kindParam("3")).toBe(3);

    const meta = await get(`/v1/contracts/${CNST}/tokens/${domain}/1/metadata`);
    const keys = Object.fromEntries(meta.body.keys.map((k: any) => [k.key ?? `hex:${k.keyHex}`, k]));
    expect(Object.keys(keys).sort()).toEqual([
      "decimals", "fingerprint", "hex:fffe", "magnitude", "metadata", "name", "symbol", "tokenUri",
    ]);
    // Last write wins, and the provenance points at the event that set it.
    expect(keys.magnitude).toMatchObject({ valType: 1, valLen: 4, text: "1.70", updatedHeight: 600 });
    expect(keys.magnitude.integer).toBeNull();
    expect(typeof keys.magnitude.eventId).toBe("number");
    expect(keys.magnitude.updatedTxHash).toMatch(/^[0-9a-f]{64}$/);
    // Every trait is rendered by its declared type (FR-106).
    expect(keys.decimals).toMatchObject({ valType: 1, text: "0", integer: null, projectionError: "val_type_mismatch" });
    expect(keys.tokenUri).toMatchObject({ valType: 4, text: "http://localhost:10020/constellations/orion", projectionError: null });
    expect(keys.metadata.valType).toBe(3);
    expect(keys.fingerprint).toMatchObject({ valType: 0, valLen: 2, value: "dead", text: null, integer: null });
    // A key that is not UTF-8 keeps its identity as bytes and has no text at all (MIP §5.1).
    expect(keys["hex:fffe"]).toMatchObject({ key: null, keyHex: "fffe", text: "unspellable" });

    const mints = await get(`/v1/contracts/${CNST}/tokens/${domain}/1/mints`);
    expect(mints.body.items).toHaveLength(1);
    expect(mints.body.items[0]).toMatchObject({
      blockHeight: 510, entryPoint: "mint", kind: 1, privacy: "shielded", amount: "1",
    });
    expect(mints.body.nextCursor).toBeNull();

    // A ledger token has no colour and no mints, by construction (MIP §3).
    const lsun = await get(`/v1/contracts/${LEDGER}/tokens/${Buffer.from(pad32("umbra:lsun")).toString("hex")}/2`);
    expect(lsun.body).toMatchObject({ kind: 2, privacy: "unshielded", storage: "ledger", color: null, status: "declared", mintCount: 0 });
  }, 60_000);

  it("[[token-api-linked-rows]] GET /v1/contracts/:address/tokens/:domainSep lists every row sharing the pair", async () => {
    const linked = await get(`/v1/contracts/${LIAR}/tokens/${LIAR_DOMAIN}`);
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ address: LIAR, domainSep: LIAR_DOMAIN, domainSepText: "umbra:lliar" });
    // The whole point of the MIP's identity change: two rows, in kind order, neither flagged.
    expect(linked.body.tokens.map((t: any) => [t.kind, t.status, t.name])).toEqual([
      [0, "observed", null],
      [2, "declared", "Ledger Liar"],
    ]);
    expect(linked.body.tokens[0].color).toBe(tokenColorHex(LIAR_DOMAIN, LIAR));
    expect(linked.body.tokens[1].color).toBeNull();

    // A token with no sibling still answers, with itself.
    const alone = await get(`/v1/contracts/${CNST}/tokens/${piece("lyra")}`);
    expect(alone.body.tokens.map((t: any) => t.kind)).toEqual([1]);

    expect((await get(`/v1/contracts/${CNST}/tokens/${"ab".repeat(32)}`)).status).toBe(404);
    expect((await get(`/v1/contracts/${CNST}/tokens/nothex`)).status).toBe(400);
  }, 60_000);

  it("[[token-api-contract-routes]] the contract, by-color, events and registry routes", async () => {
    const contract = await get(`/v1/contracts/${CNST}`);
    expect(contract.body).toMatchObject({ address: CNST, deployHeight: 500, lastCallHeight: 540 });
    expect(contract.body.deployTxHash).toBe("cc".repeat(32));
    expect(contract.body.tokens).toHaveLength(3);
    expect(contract.body.pendingLookups).toEqual([]);

    // /v1/colors/:color — one document: contract, domainSep, the coloured row(s) with traits and
    // mints, and the pair's other (colourless, ledger) rows.
    const lyra = await get(`/v1/colors/${tokenColorHex(piece("lyra"), CNST)}`);
    expect(lyra.status).toBe(200);
    expect(lyra.body).toMatchObject({
      address: CNST, domainSep: piece("lyra"), domainSepText: "cnst:lyra", builtin: false,
      contract: { address: CNST, deployHeight: 500, deployTxHash: "cc".repeat(32), lastCallHeight: 540 },
      related: [],
    });
    expect(lyra.body.tokens).toHaveLength(1);
    expect(lyra.body.tokens[0]).toMatchObject({ kind: 1, name: "Constellations · Lyra", symbol: "CNST" });
    expect(lyra.body.tokens[0].traits.map((t: any) => t.key)).toContain("name");
    expect(lyra.body.tokens[0].mints.items).toHaveLength(1);
    expect(lyra.body.tokens[0].mints.nextCursor).toBeNull();
    // The Liar: its kind-0 mint carries the colour, its declared kind-2 ledger row does not.
    const liar = await get(`/v1/colors/${tokenColorHex(LIAR_DOMAIN, LIAR)}`);
    expect(liar.body.tokens.map((t: any) => t.kind)).toEqual([0]);
    expect(liar.body.related.map((t: any) => [t.kind, t.symbol])).toEqual([[2, "LLIAR"]]);
    // NIGHT: a built-in, no contract behind it.
    const night = await get(`/v1/colors/${"00".repeat(32)}`);
    expect(night.body).toMatchObject({ builtin: true, contract: null, related: [] });
    expect(night.body.tokens.map((t: any) => t.symbol)).toEqual(["NIGHT"]);
    expect((await get(`/v1/colors/${"ff".repeat(32)}`)).status).toBe(404);
    expect((await get("/v1/colors/xyz")).status).toBe(400);

    const color = tokenColorHex(piece("lyra"), CNST);
    const byColor = await get(`/v1/tokens/by-color/${color}`);
    expect(byColor.body).toHaveLength(1);
    expect(byColor.body[0].name).toBe("Constellations · Lyra");

    const rejected = await get(`/v1/contracts/${CNST}/events?applied=false`);
    expect(rejected.body.items).toHaveLength(1);
    expect(rejected.body.items[0]).toMatchObject({
      applied: false, rejectReason: "val_type_reserved", keyText: "trait", valType: 9,
    });

    const all = await get(`/v1/contracts/${CNST}/events?limit=500`);
    expect(all.body.items.length).toBeGreaterThan(15);
    // Every event carries the layout's own bytes, including the type and the length (MIP §2).
    for (const e of all.body.items) {
      expect(typeof e.valType).toBe("number");
      expect(typeof e.valLen).toBe("number");
      expect(e.keyHex).toMatch(/^[0-9a-f]*$/);
    }
    const scoped = await get(`/v1/contracts/${CNST}/events?domainSep=${piece("orion")}&limit=500`);
    expect(scoped.body.items.every((e: any) => e.domainSep === piece("orion"))).toBe(true);
    expect(scoped.body.items.length).toBeLessThan(all.body.items.length);

    const registry = await get("/v1/registry.json");
    expect(registry.body.net).toBe(NET);
    // Described native tokens plus the built-in NIGHT (DUST has no colour, so it cannot be keyed).
    const colors = Object.keys(registry.body.tokens);
    expect(colors).toContain(tokenColorHex(piece("orion"), CNST));
    expect(colors).toContain("0".repeat(64));
    expect(registry.body.tokens[tokenColorHex(piece("orion"), CNST)]).toMatchObject({
      address: CNST, domainSep: piece("orion"), kind: 1, privacy: "shielded", symbol: "CNST",
    });
    // A ledger row can never appear here: it has no colour to key on.
    expect(Object.values(registry.body.tokens).every((t: any) => t.kind < 2)).toBe(true);

    const status = await get("/internal/status");
    expect(status.body).toMatchObject({ net: NET, archiveTip: null, pendingLookups: [] });
    expect(status.body.decodeCursor).toEqual({ height: 0, position: -1 });
    expect(status.body.counters.eventsApplied).toBeGreaterThan(0);
    expect(status.body.counters.eventsRejected).toBe(1);
  }, 60_000);

  it("[[token-api-resolver]] the tokenUri resolver answers to all three spellings, 404s an unknown id and 409s a genuine ambiguity", async () => {
    const byName = await get("/constellations/orion");
    const bySymbol = await get("/cnst/orion");
    const byHex = await get(`/${CNST}/${piece("orion")}`);
    expect(byName.status).toBe(200);
    expect(bySymbol.body).toEqual(byName.body);
    expect(byHex.body).toEqual(byName.body);
    expect(byName.body).toMatchObject({
      name: "Constellations · Orion", symbol: "CNST",
      description: "The orion piece", image: "data:image/svg+xml,<svg/>",
      address: CNST, domainSep: piece("orion"), domainSepText: "cnst:orion",
      kind: 1, privacy: "shielded", storage: "native", status: "described",
      tokenUri: "http://localhost:10020/constellations/orion",
    });
    expect(byName.body.mints).toEqual({ count: 1, total: "1", first: 510, last: 510 });
    // Traits in the document are typed, keyed by text where there is one and by bytes where not.
    expect(byName.body.traits.magnitude).toMatchObject({ valType: 1, text: "1.70", updatedHeight: 600 });
    expect(byName.body.traits["hex:fffe"]).toMatchObject({ keyHex: "fffe", text: "unspellable" });
    expect(byName.body.traits.decimals.projectionError).toBe("val_type_mismatch");
    expect(byName.body.linked).toEqual([]);

    // Two rows share the Liar's (address, domainSep), so the two-segment path is genuinely
    // ambiguous and says so — with the path that picks each one (question Q11).
    const ambiguousPair = await get(`/${LIAR}/${LIAR_DOMAIN}`);
    expect(ambiguousPair.status).toBe(409);
    // (Candidate order is the resolver's own: by first-seen height, so the declared row first.)
    expect(ambiguousPair.body.error.candidates.map((c: any) => [c.kind, c.path])).toEqual([
      [2, `/${LIAR}/${LIAR_DOMAIN}/2`],
      [0, `/${LIAR}/${LIAR_DOMAIN}/0`],
    ]);

    // The Liar's document names its sibling row (MIP §4's link).
    const liar = await get(`/${LIAR}/${LIAR_DOMAIN}/2`);
    expect(liar.status).toBe(200);
    expect(liar.body.kind).toBe(2);
    expect(liar.body.linked).toEqual([{
      kind: 0, privacy: "unshielded", storage: "native", status: "observed",
      name: null, symbol: null, color: tokenColorHex(LIAR_DOMAIN, LIAR),
    }]);

    // Case-insensitive, as a hand-typed URL must be.
    expect((await get("/CONSTELLATIONS/Orion")).status).toBe(200);

    const missing = await get("/constellations/pegasus");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("TOKEN_NOT_FOUND");

    const ambiguous = await get("/twin/alpha");
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.error.code).toBe("TOKEN_AMBIGUOUS");
    expect(ambiguous.body.error.candidates).toHaveLength(2);
    expect(ambiguous.body.error.candidates.map((c: any) => c.address).sort()).toEqual([TWIN_A, TWIN_B].sort());
    // The hex form disambiguates, which is what the 409 tells the caller to do.
    expect((await get(`/${TWIN_A}/${Buffer.from(pad32("twin:alpha")).toString("hex")}`)).status).toBe(200);
    // …and so does the kind byte, for the rows that share an address and a domain separator.
    expect((await get(`/${LIAR}/${LIAR_DOMAIN}/0`)).body.kind).toBe(0);
    expect((await get(`/${LIAR}/${LIAR_DOMAIN}/unshielded`)).body.kind).toBe(0);
    expect((await get(`/${LIAR}/${LIAR_DOMAIN}/1`)).status).toBe(404);
    expect((await get(`/${LIAR}/${LIAR_DOMAIN}/sideways`)).status).toBe(400);

    // A browser following the on-chain link gets the document itself (Q65: the earlier redirect to
    // the page's token view made the link look inert from that very view).
    const html = await get("/constellations/orion", { accept: "text/html,application/xhtml+xml,*/*;q=0.8" });
    expect(html.status).toBe(200);
    expect(String(html.headers.get("content-type"))).toContain("application/json");
    expect(html.body).toEqual(byName.body);
  }, 60_000);

  it("[[token-api-errors]] error codes, the page routes and the resolver helpers", async () => {
    expect((await get("/v1/contracts/nothex")).status).toBe(400);
    expect((await get("/v1/contracts/nothex")).body.error.code).toBe("TOKEN_BAD_REQUEST");
    // The kind segment takes 0..3 and the two legacy words, and says so when it does not.
    const badKind = await get(`/v1/contracts/${CNST}/tokens/${piece("orion")}/sideways`);
    expect(badKind.status).toBe(400);
    expect(badKind.body.error.message).toMatch(/kind must be 0, 1, 2 or 3/);
    expect((await get(`/v1/contracts/${CNST}/tokens/${piece("orion")}/4`)).status).toBe(400);
    expect((await get("/v1/tokens?limit=99999")).status).toBe(400);
    expect((await get("/v1/tokens?limit=0")).status).toBe(400);
    expect((await get("/v1/tokens?cursor=not-a-cursor")).status).toBe(400);
    expect((await get("/v1/tokens?kind=sideways")).status).toBe(400);
    // The 00020 contradiction status no longer exists, so asking for it is a 400 rather than an
    // empty page that would read as "there are none".
    expect((await get("/v1/tokens?status=inconsistent")).status).toBe(400);
    expect((await get(`/v1/contracts/${"00".repeat(32)}/tokens/${piece("orion")}/1`)).status).toBe(404);
    expect((await get("/v1/nope")).status).toBe(404);
    expect((await get(`/v1/contracts/${"ab".repeat(32)}`)).status).toBe(404);

    // The page module owns /ui and the redirect from /.
    const root = await fetch(`${base}/`, { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/ui");
    const ui = await fetch(`${base}/ui`);
    expect(ui.status).toBe(200);
    expect(ui.headers.get("content-type")).toMatch(/text\/html/);
    expect(ui.headers.get("content-security-policy")).toMatch(/default-src 'none'/);

    // The helpers the resolver rests on.
    expect(slugOfFirstWord("Constellations · Orion")).toBe("constellations");
    expect(slugOfFirstWord("Ledger Sun")).toBe("ledger");
    expect(slugOfFirstWord(null)).toBeNull();
    expect(domainText(piece("orion"))).toBe("cnst:orion");
    expect(domainText("ff".repeat(32))).toBeNull();
    const token = (await get(`/v1/contracts/${CNST}/tokens/${piece("orion")}/1`)).body;
    expect(resolverMatches(token, "cnst", "orion")).toBe(true);
    expect(resolverMatches(token, "cnst", "lyra")).toBe(false);
    expect(resolverMatches(token, "somethingelse", "orion")).toBe(false);
  }, 60_000);
});
