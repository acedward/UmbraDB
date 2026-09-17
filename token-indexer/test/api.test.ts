import type { Server } from "node:http";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { createTokenApi, domainText, listen, resolverMatches, slugOfFirstWord } from "../api/server.js";
import { bootstrapTokenIndexSchema } from "../bootstrap.js";
import { pad32, tokenColorHex } from "../color.js";
import type { TokenIndexerConfig } from "../config.js";
import type { ObservedMint } from "../ingest/decode.js";
import { applyMetadataEvent, applyMint, type RawContractEvent } from "../ingest/fold.js";
import { TOKEN_METADATA_NAME_HEX } from "../ingest/payload.js";
import { metadataPayloadHex } from "./helpers/fake-ledger.js";

/**
 * Project 00020, sub-plan 01 Phase 6 — `[[token-api-contract]]`.
 *
 * Every route of spec §5 against a fixture database, over a REAL HTTP server on an OS-assigned
 * port: pagination, filters, the four error codes, and the `tokenUri` resolver in all three of its
 * spellings plus its 404 and its 409.
 */

const NET = "stagenet";
const KIND = { unshieldedNative: 0, shieldedNative: 1, unshieldedLedger: 2 } as const;

/** The Constellations collection: one contract, five pieces, dynamic domain separators. */
const CNST = "c0".repeat(32);
/** A ledger token: declared, never minted, no colour. */
const LEDGER = "1e".repeat(32);
/** A token minted but never described. */
const GHOST = "6f".repeat(32);
/** Two contracts that share a symbol, so the resolver has a genuine ambiguity to report. */
const TWIN_A = "7a".repeat(32);
const TWIN_B = "7b".repeat(32);

describe("token API (spec §5)", () => {
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

  async function mint(address: string, domainSep: string, kind: "shielded" | "unshielded", amount: bigint, height: number): Promise<void> {
    const observed: ObservedMint = {
      segment: 0, callIndex: 0, address, domainSep, kind, amount, entryPoint: "mint", section: "guaranteed",
    };
    await sql.begin(async (tx) => applyMint(tx, schema, NET, observed, {
      txHash: (address.slice(-40) + domainSep.slice(-16) + height.toString(16).padStart(8, "0")).slice(0, 64),
      blockHeight: height, txPosition: 0,
    }));
  }

  async function emit(address: string, domainSep: string, kindByte: number, key: string, value: string | Uint8Array, height: number): Promise<void> {
    const event: RawContractEvent = {
      eventId: nextEventId++,
      contractAddress: address,
      txHash: (address.slice(-48) + height.toString(16).padStart(16, "0")),
      blockHeight: height,
      nameHex: TOKEN_METADATA_NAME_HEX,
      payloadHex: metadataPayloadHex({ domainSep, kindByte, key, value }),
    };
    await sql.begin(async (tx) => applyMetadataEvent(tx, schema, NET, event));
  }

  const piece = (name: string): string => Buffer.from(pad32(`cnst:${name}`)).toString("hex");

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
      await mint(CNST, domain, "shielded", 1n, height);
      await emit(CNST, domain, KIND.shieldedNative, "name", name, height + 1);
      await emit(CNST, domain, KIND.shieldedNative, "symbol", "CNST", height + 1);
      await emit(CNST, domain, KIND.shieldedNative, "decimals", new Uint8Array([0]), height + 1);
      await emit(CNST, domain, KIND.shieldedNative, "tokenUri", `http://localhost:10020/constellations/${id}`, height + 1);
      await emit(CNST, domain, KIND.shieldedNative, "magnitude", magnitude, height + 2);
      await emit(CNST, domain, KIND.shieldedNative, "metadata", JSON.stringify({ description: `The ${id} piece`, image: "data:image/svg+xml,<svg/>" }), height + 2);
      height += 10;
    }
    // Orion gets a second magnitude, so last-write-wins is visible through the API.
    await emit(CNST, piece("orion"), KIND.shieldedNative, "magnitude", "1.70", 600);
    // A rejected event, so `?applied=false` has something to show.
    await emit(CNST, piece("orion"), KIND.shieldedNative, "decimals", new Uint8Array([99]), 601);

    // A ledger token, declared only.
    await emit(LEDGER, Buffer.from(pad32("umbra:lsun")).toString("hex"), KIND.unshieldedLedger, "name", "Ledger Sun", 520);
    await emit(LEDGER, Buffer.from(pad32("umbra:lsun")).toString("hex"), KIND.unshieldedLedger, "symbol", "LSUN", 520);

    // A minted-but-undescribed token.
    await mint(GHOST, Buffer.from(pad32("umbra:sghost")).toString("hex"), "shielded", 999n, 530);

    // Two contracts sharing a symbol and an id — the resolver's genuine ambiguity.
    for (const address of [TWIN_A, TWIN_B]) {
      const domain = Buffer.from(pad32("twin:alpha")).toString("hex");
      await mint(address, domain, "unshielded", 1n, 550);
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
    // 3 Constellations pieces + ledger + ghost + 2 twins + NIGHT + DUST
    expect(all.body.items).toHaveLength(9);
    expect(all.body.nextCursor).toBeNull();

    const builtin = await get("/v1/tokens?status=builtin");
    expect(builtin.body.items.map((t: any) => t.symbol).sort()).toEqual(["DUST", "NIGHT"]);
    expect(builtin.body.items.find((t: any) => t.symbol === "DUST").color).toBeNull();

    expect((await get("/v1/tokens?storage=ledger")).body.items.map((t: any) => t.symbol)).toEqual(["LSUN"]);
    expect((await get("/v1/tokens?status=observed")).body.items.map((t: any) => t.name)).toEqual([null]);
    expect((await get("/v1/tokens?kind=shielded")).body.items.every((t: any) => t.kind === "shielded")).toBe(true);

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
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
  }, 60_000);

  it("[[token-api-contract]] the per-token routes serve the token, its traits with provenance, and its mints", async () => {
    const domain = piece("orion");
    const token = await get(`/v1/contracts/${CNST}/tokens/${domain}/shielded`);
    expect(token.status).toBe(200);
    expect(token.body).toMatchObject({
      address: CNST, domainSep: domain, kind: "shielded", storage: "native",
      name: "Constellations · Orion", symbol: "CNST", decimals: 0, status: "described",
      mintCount: 1, totalMinted: "1", deployHeight: 500,
      tokenUri: "http://localhost:10020/constellations/orion",
    });
    expect(token.body.color).toBe(tokenColorHex(domain, CNST));
    expect(token.body.metadata).toEqual({ description: "The orion piece", image: "data:image/svg+xml,<svg/>" });

    const meta = await get(`/v1/contracts/${CNST}/tokens/${domain}/shielded/metadata`);
    const keys = Object.fromEntries(meta.body.keys.map((k: any) => [k.key, k]));
    expect(Object.keys(keys).sort()).toEqual(["decimals", "magnitude", "metadata", "name", "symbol", "tokenUri"]);
    // Last write wins, and the provenance points at the event that set it.
    expect(keys.magnitude.text).toBe("1.70");
    expect(keys.magnitude.updatedHeight).toBe(600);
    expect(typeof keys.magnitude.eventId).toBe("number");
    expect(keys.magnitude.updatedTxHash).toMatch(/^[0-9a-f]{64}$/);
    expect(keys.decimals.text).toBe(" "); // one byte, value 0 — hex is the useful form here
    expect(keys.decimals.value).toMatch(/^00/);

    const mints = await get(`/v1/contracts/${CNST}/tokens/${domain}/shielded/mints`);
    expect(mints.body.items).toHaveLength(1);
    expect(mints.body.items[0]).toMatchObject({ blockHeight: 510, entryPoint: "mint", kind: "shielded", amount: "1" });
    expect(mints.body.nextCursor).toBeNull();

    // A ledger token has no colour and no mints, by construction.
    const lsun = await get(`/v1/contracts/${LEDGER}/tokens/${Buffer.from(pad32("umbra:lsun")).toString("hex")}/unshielded`);
    expect(lsun.body).toMatchObject({ storage: "ledger", color: null, status: "declared", mintCount: 0 });
  }, 60_000);

  it("[[token-api-contract]] the contract, by-color, events and registry routes", async () => {
    const contract = await get(`/v1/contracts/${CNST}`);
    expect(contract.body).toMatchObject({ address: CNST, deployHeight: 500, lastCallHeight: 540 });
    expect(contract.body.deployTxHash).toBe("cc".repeat(32));
    expect(contract.body.tokens).toHaveLength(3);
    expect(contract.body.pendingLookups).toEqual([]);

    const color = tokenColorHex(piece("lyra"), CNST);
    const byColor = await get(`/v1/tokens/by-color/${color}`);
    expect(byColor.body).toHaveLength(1);
    expect(byColor.body[0].name).toBe("Constellations · Lyra");

    const rejected = await get(`/v1/contracts/${CNST}/events?applied=false`);
    expect(rejected.body.items).toHaveLength(1);
    expect(rejected.body.items[0]).toMatchObject({ applied: false, rejectReason: "decimals_range", keyText: "decimals" });

    const all = await get(`/v1/contracts/${CNST}/events?limit=500`);
    expect(all.body.items.length).toBeGreaterThan(15);
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
      address: CNST, domainSep: piece("orion"), kind: "shielded", symbol: "CNST",
    });

    const status = await get("/internal/status");
    expect(status.body).toMatchObject({ net: NET, archiveTip: null, pendingLookups: [] });
    expect(status.body.decodeCursor).toEqual({ height: 0, position: -1 });
    expect(status.body.counters.eventsApplied).toBeGreaterThan(0);
    expect(status.body.counters.eventsRejected).toBe(1);
  }, 60_000);

  it("[[token-api-contract]] the tokenUri resolver answers to all three spellings, 404s an unknown id and 409s a genuine ambiguity", async () => {
    const byName = await get("/constellations/orion");
    const bySymbol = await get("/cnst/orion");
    const byHex = await get(`/${CNST}/${piece("orion")}`);
    expect(byName.status).toBe(200);
    expect(bySymbol.body).toEqual(byName.body);
    expect(byHex.body).toEqual(byName.body);
    expect(byName.body).toMatchObject({
      name: "Constellations · Orion", symbol: "CNST", decimals: 0,
      description: "The orion piece", image: "data:image/svg+xml,<svg/>",
      address: CNST, domainSep: piece("orion"), domainSepText: "cnst:orion",
      kind: "shielded", storage: "native", status: "described",
      tokenUri: "http://localhost:10020/constellations/orion",
    });
    expect(byName.body.mints).toEqual({ count: 1, total: "1", first: 510, last: 510 });
    expect(byName.body.traits.magnitude).toMatchObject({ text: "1.70", updatedHeight: 600 });

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

    // A browser following the on-chain link lands on the page's own token view.
    const html = await get("/constellations/orion", { accept: "text/html,application/xhtml+xml" });
    expect(html.status).toBe(302);
    expect(html.headers.get("location")).toBe(`/ui#/token/${CNST}/${piece("orion")}/shielded`);
  }, 60_000);

  it("[[token-api-contract]] error codes, the page routes and the resolver helpers", async () => {
    expect((await get("/v1/contracts/nothex")).status).toBe(400);
    expect((await get("/v1/contracts/nothex")).body.error.code).toBe("TOKEN_BAD_REQUEST");
    expect((await get(`/v1/contracts/${CNST}/tokens/${piece("orion")}/sideways`)).status).toBe(400);
    expect((await get("/v1/tokens?limit=99999")).status).toBe(400);
    expect((await get("/v1/tokens?limit=0")).status).toBe(400);
    expect((await get("/v1/tokens?cursor=not-a-cursor")).status).toBe(400);
    expect((await get("/v1/tokens?kind=sideways")).status).toBe(400);
    expect((await get(`/v1/contracts/${"00".repeat(32)}/tokens/${piece("orion")}/shielded`)).status).toBe(404);
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
    const token = (await get(`/v1/contracts/${CNST}/tokens/${piece("orion")}/shielded`)).body;
    expect(resolverMatches(token, "cnst", "orion")).toBe(true);
    expect(resolverMatches(token, "cnst", "lyra")).toBe(false);
    expect(resolverMatches(token, "somethingelse", "orion")).toBe(false);
  }, 60_000);
});
