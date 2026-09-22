import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { bootstrapChainArchiveSchema } from "../../chain-archive-sync/bootstrap.js";
import { loadLedgerV9 } from "../../chain-archive-sync/tx-replay-decoder.js";
import { decodeOwnerAddress, ownerAddress } from "../api/bech32m.js";
import { createTokenApi, listen, makeChainHeadReader } from "../api/server.js";
import { bootstrapTokenIndexSchema } from "../bootstrap.js";
import { NIGHT_COLOR_HEX, pad32 } from "../color.js";
import type { TokenIndexerConfig } from "../config.js";
import type { EventSource, IndexerContractEvent } from "../ingest/events.js";
import { applyMetadataEvent, type RawContractEvent } from "../ingest/fold.js";
import { TOKEN_METADATA_NAME_HEX } from "../ingest/payload.js";
import { TokenScanner } from "../ingest/scan.js";
import { loadActivityFixture, loadActivityFixtures, seedArchive } from "./helpers/archive-fixture.js";
import { metadataPayloadHex } from "./helpers/fake-ledger.js";

/**
 * Project 00023, sub-plan 01 task A4.4 — spec §5's routes, over a REAL HTTP server on an
 * OS-assigned port, against a Testcontainers Postgres holding a real `chain_archive` with the four
 * recorded Stagenet transactions, scanned by the real scanner through the real ledger-v9 WASM.
 *
 * Nothing here is seeded by hand except one metadata event, which declares a LEDGER token on the
 * contract that `deposit-toMap` really called — the only way to exercise `shieldedVisibility:
 * "calls-only"` and the calls table that replaces a colour list for kinds 2 and 3 (US7).
 */

const NET = "stagenet";
/** `deposit-toMap`'s contract. It is also where the kind-2 declaration below lives. */
const TOMAP_CONTRACT = "bc4fa552ea7ed042c54043f732bec591297c8cb0408b7ab54365e36b0dda094b";
/** The colour `deposit-toMap` moves, whose mint predates the archive: a `seen` token (US5). */
const DEPOSIT_COLOR = "254fc19366d929e7a5813f04a89fbc68195046f5261428e721e5d16daca8bc47";
/** The colour `shielded-mint-delta` mints, published by the offer delta. */
const MINT_COLOR = "d086a9e29154d03f507a589c89ea61a453f444c2881b8d0d88192f2965fa2cea";
const NIGHT_OWNER = "578d30979c33af7f74fd9fbdb331ea2057ae3ca6b5b51c144c6da501cabb968e";
const LEDGER_DOMAIN = Buffer.from(pad32("umbra:tomap-book")).toString("hex");

class EmptyEventSource implements EventSource {
  async eventsFor(): Promise<IndexerContractEvent[]> { return []; }
}

describe("activity API (spec §5)", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let server: Server;
  let base: string;
  const schema = "token_activity_api";
  const archiveSchema = "arch_activity_api";

  const config = (): TokenIndexerConfig => ({
    pgUrl: "", indexerHttp: undefined, net: NET, apiPort: 0,
    schema, archiveSchema, scanBatch: 500, live2x: false,
  });

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    sql = createClient({ connectionString: container.getConnectionUri(), schema });
    await bootstrapChainArchiveSchema(sql, archiveSchema);
    await bootstrapTokenIndexSchema(sql, { schema, net: NET });
    await seedArchive(sql, archiveSchema, NET, loadActivityFixtures());

    const ledger = await loadLedgerV9();
    const outcome = await new TokenScanner({
      sql, schema, archiveSchema, net: NET, eventSource: new EmptyEventSource(), ledger,
    }).scanOnce();
    expect(outcome.activityRows).toBe(14);

    // A LEDGER token (kind 2) declared by the contract `deposit-toMap` called. It has no colour
    // and no UTXOs by construction (MIP §3), so its only public activity is that contract's calls.
    const event: RawContractEvent = {
      eventId: 1, contractAddress: TOMAP_CONTRACT,
      txHash: "ab".repeat(32), blockHeight: 500_760, nameHex: TOKEN_METADATA_NAME_HEX,
      payloadHex: metadataPayloadHex({
        domainSep: LEDGER_DOMAIN, kindByte: 2, key: "symbol", value: "TMAP",
      }),
    };
    await sql.begin(async (tx) => applyMetadataEvent(tx, schema, NET, event));

    server = createTokenApi({ sql, config: config(), ledger });
    base = `http://127.0.0.1:${await listen(server, 0)}`;
  }, 300_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  async function get(path: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}${path}`, { redirect: "manual" });
    const text = await res.text();
    return { status: res.status, body: text === "" ? null : JSON.parse(text) };
  }

  const goldenView = (label: string): any =>
    JSON.parse(readFileSync(new URL(`./fixtures/activity/${label}.view.json`, import.meta.url), "utf8"));
  const goldenRows = (label: string): any[] =>
    JSON.parse(readFileSync(new URL(`./fixtures/activity/${label}.rows.json`, import.meta.url), "utf8"));

  it("[[token-activity-api-list]] a token's transactions come newest first, page by cursor, filter by role, and render owners as Bech32m beside the hex", async () => {
    // NIGHT is the token in this set with the most rows — four from the contract pass-through and
    // three from the live transfer of 2026-09-21 — and it is the built-in row addressed by the
    // 00020 sentinel key, so the contract-addressed route still reaches it.
    const PASSTHROUGH = "69ea91eb4bf6346c1dcc0dab326740baa876664b20140c09a5df4af3f68385ca";
    const NIGHT_TRANSFER = "b6c1fb95f8495557b682bd3259ecebc9e5e99e4cd6aea50ba26adf5b1cca0120";
    const path = `/v1/contracts/${"00".repeat(32)}/tokens/${"00".repeat(32)}/0/transactions`;
    const all = await get(path);
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(7);
    expect(all.body.nextCursor).toBeNull();
    // Newest first (US3): block 565 372's three rows, then block 500 257's four.
    expect(all.body.items.map((a: any) => [a.blockHeight, a.role])).toEqual([
      [565372, "utxo_in"], [565372, "utxo_out"], [565372, "utxo_out"],
      [500257, "contract_in"], [500257, "contract_out"], [500257, "utxo_in"], [500257, "utxo_out"],
    ]);
    expect(all.body.items.slice(0, 3).every((a: any) => a.txHash === NIGHT_TRANSFER)).toBe(true);
    // The live transfer's own two outputs: 1 NIGHT to the second address, the rest back as change.
    expect(all.body.items.slice(0, 3).map((a: any) => [a.amount, a.direction])).toEqual([
      ["5000000000", "out"], ["1000000", "in"], ["4999000000", "in"],
    ]);
    expect(all.body.items[1]!.owner).toBe("mn_addr_stagenet1ufdmhndl2rm39qnzdup79d2m9zwvd2rq55s2ra6k00xdjdrkqehqgx5glx");
    expect(all.body.items[2]!.owner).toBe("mn_addr_stagenet1m4gv99gjckxx3gmrsjmvguqy7fuzffdjm8z7k5j3uyxc2nl63xksrda9fm");

    const utxoOut = all.body.items.find((a: any) => a.role === "utxo_out" && a.txHash === PASSTHROUGH);
    expect(utxoOut).toMatchObject({
      txHash: "69ea91eb4bf6346c1dcc0dab326740baa876664b20140c09a5df4af3f68385ca",
      blockHeight: 500257, txPosition: 0, result: "success",
      segment: 15274, section: "fallible", itemIndex: 0,
      color: NIGHT_COLOR_HEX, kind: 0,
      // An exact decimal STRING, never a JSON number (FR-014).
      amount: "10", direction: "in",
      ownerHex: NIGHT_OWNER, outputNo: 0,
    });
    expect(typeof utxoOut.amount).toBe("string");
    // Bech32m REPLACES the hex on the page; the hex stays for machine consumers (Q9).
    expect(utxoOut.owner).toBe(ownerAddress(NET, NIGHT_OWNER));
    expect(utxoOut.owner).toBe("mn_addr_stagenet127xnp9uuxwhh7a8an77mxv02ypt6u09xkk63c9zvdkjsrj4mj68qg7c5ad");
    expect(decodeOwnerAddress(utxoOut.owner).hex).toBe(utxoOut.ownerHex);
    // A CONTRACT address is never Bech32m (Q9): the contract rows carry plain hex.
    expect(all.body.items.find((a: any) => a.role === "contract_in").address)
      .toBe("29be1e64846cff4600c5297fa54b27d4c9296b3ccc2cdba190eaba1d64c5f116");
    // Every row resolves to its token — NIGHT's built-in row, by colour.
    for (const row of all.body.items) {
      expect(row.token).toMatchObject({ kind: 0, symbol: "NIGHT", status: "builtin", decimals: 6 });
    }
    // No wall-clock time anywhere (FR-012): heights and positions only.
    for (const row of all.body.items) {
      expect(Object.keys(row).some((k) => /time|timestamp|date/i.test(k))).toBe(false);
    }

    // --- the role filter ---------------------------------------------------------------------
    const spent = await get(`${path}?role=utxo_in`);
    expect(spent.body.items.map((a: any) => a.role)).toEqual(["utxo_in", "utxo_in"]);
    expect((await get(`${path}?role=mint`)).body.items).toEqual([]);
    expect((await get(`${path}?role=sideways`)).status).toBe(400);

    // --- keyset paging across a two-row page --------------------------------------------------
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const url: string = `${path}?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
      const res: { body: any } = await get(url);
      expect(res.body.items.length).toBeLessThanOrEqual(2);
      for (const item of res.body.items) seen.push(`${item.segment}|${item.section}|${item.role}|${item.itemIndex}`);
      cursor = res.body.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen).toEqual(all.body.items.map((a: any) => `${a.segment}|${a.section}|${a.role}|${a.itemIndex}`));
    expect((await get(`${path}?cursor=not-a-cursor`)).status).toBe(400);
    expect((await get(`${path}?limit=0`)).status).toBe(400);

    // --- the token document's read-time counts (spec §5) --------------------------------------
    const night = await get(`/v1/contracts/${"00".repeat(32)}/tokens/${"00".repeat(32)}/0`);
    expect(night.body).toMatchObject({
      symbol: "NIGHT", status: "builtin", shieldedVisibility: "full",
      activityCount: 7, lastActivityHeight: 565372,
    });
    // Only a kind-1 token has a disclosure story, so NIGHT carries neither of those two numbers.
    expect(night.body.disclosedTransactions).toBeUndefined();
    expect(night.body.undisclosedShieldedOffers).toBeUndefined();

    // …while the shielded mint does, and its visibility says exactly how much the ledger shows.
    const shielded = await get(`/v1/colors/${MINT_COLOR}`);
    expect(shielded.body.tokens).toHaveLength(1);
    expect(shielded.body.tokens[0]).toMatchObject({
      kind: 1, status: "observed", shieldedVisibility: "disclosed-imbalances",
      activityCount: 2, lastActivityHeight: 497182,
      // The chain-wide figure the disclosure panel prints: BOTH balanced offers in this set could
      // be this colour and the ledger does not say — the contract deposit and the live SSTAR
      // self-transfer alike.
      disclosedTransactions: 1, undisclosedShieldedOffers: 2,
    });
  }, 60_000);

  it("[[token-activity-api-color]] a colour nobody has named still lists its transactions, and the kind filter separates the two tokens a colour can be", async () => {
    // `254fc193…` has no contract behind it: its mint predates the archive. It is a `seen` row, it
    // has a page, and the colour route is how that page gets its data (US5, Q17).
    const rows = await get(`/v1/colors/${DEPOSIT_COLOR}/transactions`);
    expect(rows.status).toBe(200);
    expect(rows.body.items.map((a: any) => [a.role, a.amount, a.kind]))
      .toEqual([["contract_in", "200000", 0], ["utxo_in", "200000", 0]]);
    for (const row of rows.body.items) {
      expect(row.token).toEqual({
        address: null, domainSep: null, kind: 0, name: null, symbol: null, decimals: null,
        status: "seen",
      });
    }
    // The spender's address, as a wallet shows it (Q9) and as the indexer itself serves it.
    const spend = rows.body.items.find((a: any) => a.role === "utxo_in");
    expect(spend.owner).toBe(loadActivityFixture("deposit-toMap").unshieldedSpentOutputs![0]!.owner);
    expect(spend.ownerKey).toBe("schnorr:68e8d35974b5b8999722d88ef1bd6d4118dcbfaf882e623f186683d3aa19020e");
    expect(spend.intentHash).toBe("61cfd2c6bcfb2ab52404f9e7f6a5bcb19171e56feaa0decad41ba25b87ea9c78");

    // The kind filter: this colour was only ever seen as an UNSHIELDED token, so kind 1 is empty.
    expect((await get(`/v1/colors/${DEPOSIT_COLOR}/transactions?kind=0`)).body.items).toHaveLength(2);
    expect((await get(`/v1/colors/${DEPOSIT_COLOR}/transactions?kind=1`)).body.items).toEqual([]);
    // …and the mint's colour only as a SHIELDED one.
    expect((await get(`/v1/colors/${MINT_COLOR}/transactions?kind=1`)).body.items).toHaveLength(2);
    expect((await get(`/v1/colors/${MINT_COLOR}/transactions?kind=0`)).body.items).toEqual([]);

    // The token document of a row with no contract: the colour is the whole identity.
    const doc = await get(`/v1/colors/${DEPOSIT_COLOR}`);
    expect(doc.status).toBe(200);
    expect(doc.body).toMatchObject({ color: DEPOSIT_COLOR, address: null, domainSep: null, contract: null });
    expect(doc.body.tokens).toHaveLength(1);
    expect(doc.body.tokens[0]).toMatchObject({
      status: "seen", address: null, domainSep: null, color: DEPOSIT_COLOR,
      name: null, symbol: null, shieldedVisibility: "full", activityCount: 2,
      lastActivityHeight: 500750, traits: [],
    });
    expect(doc.body.tokens[0].mints.items).toEqual([]);

    // …and the same rows are reachable through `/v1/tokens?status=seen`. Two colours in this set
    // have no row of their own: this one, and UCOM's — whose mint is a real Stagenet transaction
    // that simply is not among these seven fixtures.
    const seenList = await get("/v1/tokens?status=seen");
    expect(seenList.body.items).toHaveLength(2);
    expect(seenList.body.items.map((t: any) => t.color).sort()).toEqual(
      ["10dbdaf2b0b0aee765b3a83517f63a0371088565aa1d4cf89ccdc1c70b298269", DEPOSIT_COLOR].sort(),
    );
    expect(seenList.body.items.find((t: any) => t.color === DEPOSIT_COLOR)).toMatchObject({
      status: "seen", address: null, domainSep: null, color: DEPOSIT_COLOR,
      contractDomainSeps: null,
    });

    expect((await get("/v1/colors/nothex/transactions")).status).toBe(400);
    expect((await get(`/v1/colors/${"ff".repeat(32)}/transactions`)).body.items).toEqual([]);
  }, 60_000);

  it("[[token-activity-api-tx]] GET /v1/transactions/:hash returns the golden §4 document with the archive's own facts and this transaction's activity rows", async () => {
    for (const fixture of loadActivityFixtures()) {
      const label = fixture.label;
      const res = await get(`/v1/transactions/${fixture.transaction.hash}`);
      expect(res.status, label).toBe(200);

      const { activity, ...document } = res.body;
      const golden = goldenView(label);
      const expected = {
        ...golden,
        // Spec §5's `deltas[] {color, delta, tokenName?}` — resolved at read time.
        offers: golden.offers.map((o: any) => ({
          ...o,
          deltas: o.deltas.map((d: any) => ({ ...d, tokenName: null })),
        })),
        // The archive's own facts, which are not in the bytes. No timestamp among them (Q1).
        blockHeight: fixture.blockHeight,
        blockHash: fixture.blockHash,
        txPosition: 0,
        protocolVersion: fixture.transaction.protocolVersion,
        transactionKind: "regular",
        result: "success",
        segments: null,
      };
      expect(document, label).toEqual(expected);

      // The stored rows come with it, each carrying its resolved token and its Bech32m owner.
      // The route serves them in the table's own order, `(segment, section, role, item_index)`;
      // the golden is in the decoder's WALK order, so both are sorted before comparing.
      const key = (r: any): string =>
        `${String(r.segment).padStart(6, "0")}|${r.section}|${r.role}|${String(r.itemIndex).padStart(4, "0")}`;
      const rows = goldenRows(label).slice().sort((a, b) => key(a).localeCompare(key(b)));
      expect(activity.slice().sort((a: any, b: any) => key(a).localeCompare(key(b)))
        .map((a: any) => [a.segment, a.section, a.role, a.amount, a.itemIndex]), label)
        .toEqual(rows.map((r: any) => [r.segment, r.section, r.role, r.amount, r.itemIndex]));
      for (const row of activity) {
        expect(row.txHash, label).toBe(fixture.transaction.hash);
        expect(row.blockHeight, label).toBe(fixture.blockHeight);
        expect(row.token, `${label} ${row.role}`).not.toBeNull();
        if (row.ownerHex !== null) expect(decodeOwnerAddress(row.owner).hex).toBe(row.ownerHex);
      }
    }

    // The balanced offer, through the route: `deltas: []` is the whole privacy statement (US4).
    const balanced = await get(`/v1/transactions/${loadActivityFixture("balanced-offer-contract").transaction.hash}`);
    expect(balanced.body.offers[0].deltas).toEqual([]);
    expect(balanced.body.offers[0].deltaCount).toBe(0);
    expect(balanced.body.activity).toEqual([]);

    // A named colour puts its name beside the delta.
    const mint = await get(`/v1/transactions/${loadActivityFixture("shielded-mint-delta").transaction.hash}`);
    expect(mint.body.offers[0].deltas[0]).toMatchObject({ color: MINT_COLOR, delta: "-1", tokenName: null });
    // The DUST fee is visible here and only here (Q13).
    expect(mint.body.feeSpeck).toBe("332966033915711");
    expect(mint.body.intents.some((i: any) => i.dustActions !== null)).toBe(true);

    expect((await get(`/v1/transactions/${"ab".repeat(32)}`)).status).toBe(404);
    expect((await get(`/v1/transactions/${"ab".repeat(32)}`)).body.error.code).toBe("TOKEN_NOT_FOUND");
    expect((await get("/v1/transactions/nothex")).status).toBe(400);
  }, 120_000);

  it("[[token-activity-shielded-offers]] every zswap offer is listed, the balanced one is undisclosed, and the counts are the ones the panel shows", async () => {
    const all = await get("/v1/shielded-offers");
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(3);
    // Newest first.
    expect(all.body.items.map((o: any) => o.blockHeight)).toEqual([565376, 497189, 497182]);

    const undisclosed = await get("/v1/shielded-offers?undisclosed=true");
    expect(undisclosed.body.items).toHaveLength(2);
    const contractOffer = undisclosed.body.items.find((o: any) =>
      o.txHash === "c235e6b20f5c66771719ec5235d109ea664eb6dd576fe6396ccbfaed80fa6036");
    expect(contractOffer).toMatchObject({
      blockHeight: 497189, section: "guaranteed", segment: 0,
      inputs: 2, outputs: 1, transients: 1, deltas: 0, undisclosed: true, counted: true,
    });
    // The live user-to-user balanced transfer of 1.000000 SSTAR (task C4(c), spec US6/SC-003) is in
    // this list and in no token's list: one input, two outputs, and no delta to name a colour.
    expect(undisclosed.body.items.find((o: any) =>
      o.txHash === "9b9254f4710e6a1893f30d3d396dd07336d190851961a526b106202d273eed75")).toMatchObject({
      blockHeight: 565376, section: "guaranteed", segment: 0,
      inputs: 1, outputs: 2, transients: 0, deltas: 0, undisclosed: true, counted: true,
    });
    // The MINT's offer is never in this list: its colour is public, exactly, in its delta.
    const disclosed = await get("/v1/shielded-offers?undisclosed=false");
    expect(disclosed.body.items).toHaveLength(1);
    expect(disclosed.body.items[0]).toMatchObject({
      txHash: "bd0360d461843d2c337b04b9353c8b95833dc1d60780e28a62530a53abe024f9",
      deltas: 1, undisclosed: false,
    });
    // …and no activity row anywhere names either balanced transaction, for any colour — including
    // SSTAR's own, which is exactly what SC-003 asks for.
    const SSTAR_COLOR = "3248c456d02ce8a8c2b42541488add504152f745e168d139934c637339c55553";
    const UCOM_COLOR = "10dbdaf2b0b0aee765b3a83517f63a0371088565aa1d4cf89ccdc1c70b298269";
    for (const color of [DEPOSIT_COLOR, MINT_COLOR, NIGHT_COLOR_HEX, SSTAR_COLOR, UCOM_COLOR]) {
      for (const kind of ["", "?kind=0", "?kind=1"]) {
        const rows = await get(`/v1/colors/${color}/transactions${kind}`);
        expect(rows.body.items.every((a: any) =>
          !undisclosed.body.items.some((o: any) => o.txHash === a.txHash)), `${color}${kind}`).toBe(true);
      }
    }
    // SSTAR's colour has no activity row of any kind: the transfer left no public trace of it.
    expect((await get(`/v1/colors/${SSTAR_COLOR}/transactions`)).body.items).toEqual([]);

    // The number the disclosure panel prints is the length of this very list.
    const status = await get("/internal/status");
    expect(status.body.counters.undisclosedShieldedOffers).toBe(undisclosed.body.items.length);
    expect(status.body.counters.shieldedOffers).toBe(all.body.items.length);

    expect((await get("/v1/shielded-offers?undisclosed=maybe")).status).toBe(400);
    expect((await get("/v1/shielded-offers?limit=1")).body.items).toHaveLength(1);
    const first = await get("/v1/shielded-offers?limit=1");
    expect(first.body.nextCursor).not.toBeNull();
    const second = await get(`/v1/shielded-offers?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.items[0].txHash).not.toBe(first.body.items[0].txHash);
  }, 60_000);

  it("[[token-activity-api-calls]] a contract's calls are listed with every public field, and a ledger token answers calls-only with an empty transactions page", async () => {
    const calls = await get(`/v1/contracts/${TOMAP_CONTRACT}/calls`);
    expect(calls.status).toBe(200);
    expect(calls.body.items).toHaveLength(1);
    const call = calls.body.items[0];
    expect(call).toMatchObject({
      txHash: "f5033d4f20e8419921f4633eee0e021017ab5b6bb07f9efb2ecad91959a40396",
      blockHeight: 500750, txPosition: 0, segment: 63196, callIndex: 0,
      address: TOMAP_CONTRACT, entryPoint: "toMap",
    });
    // The call happened in the FALLIBLE transcript, and its public counters are all there.
    expect(call.guaranteed).toBeNull();
    expect(call.fallible).toMatchObject({ ops: 62, logOps: 1, counted: true });
    expect(call.fallible.gas).toEqual({
      readTime: "4794000000", computeTime: "8537697918", bytesWritten: "2458", bytesDeleted: "2458",
    });
    // The effect map that says what the contract received, by colour and amount.
    expect(call.fallible.effects.unshieldedInputs).toEqual([{ color: DEPOSIT_COLOR, amount: "200000" }]);
    expect(call.fallible.effects.unshieldedOutputs).toEqual([]);
    expect(call.fallible.effects.shieldedMints).toEqual([]);

    // --- the ledger token on that contract (kind 2) -------------------------------------------
    const ledgerToken = await get(`/v1/contracts/${TOMAP_CONTRACT}/tokens/${LEDGER_DOMAIN}/2`);
    expect(ledgerToken.status).toBe(200);
    expect(ledgerToken.body).toMatchObject({
      kind: 2, storage: "ledger", status: "declared", symbol: "TMAP",
      // No colour, no UTXOs: the contract's calls are the only public trace (Q4, US7).
      color: null, shieldedVisibility: "calls-only",
      activityCount: 0, lastActivityHeight: null,
    });
    // Its transactions route answers an empty page rather than a 404 — there is nothing to list,
    // and the page shows the calls table under the public-data note instead.
    const empty = await get(`/v1/contracts/${TOMAP_CONTRACT}/tokens/${LEDGER_DOMAIN}/2/transactions`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ items: [], nextCursor: null });

    // A contract with no calls at all is an empty page, not an error.
    expect((await get(`/v1/contracts/${"ab".repeat(32)}/calls`)).body.items).toEqual([]);
    expect((await get("/v1/contracts/nothex/calls")).status).toBe(400);
    // Every contract this fixture set called has exactly one recorded call.
    const status = await get("/internal/status");
    expect(status.body.counters.contractCalls).toBe(4);
  }, 60_000);

  it("[[token-activity-status-counters]] /internal/status carries the five activity counters and they equal the rows the scanner wrote", async () => {
    const status = await get("/internal/status");
    expect(status.status).toBe(200);
    expect(status.body.counters).toMatchObject({
      activityRows: 14,
      seenTokens: 2,
      shieldedOffers: 3,
      undisclosedShieldedOffers: 2,
      contractCalls: 4,
      // 00020's counters are untouched beside them.
      mints: 1,
    });
    // Each one is a COUNT over stored rows, so it agrees with the route that lists those rows.
    const offers = await get("/v1/shielded-offers?limit=500");
    expect(status.body.counters.shieldedOffers).toBe(offers.body.items.length);
    expect(status.body.counters.undisclosedShieldedOffers)
      .toBe(offers.body.items.filter((o: any) => o.undisclosed).length);
    const seen = await get("/v1/tokens?status=seen&limit=500");
    expect(status.body.counters.seenTokens).toBe(seen.body.items.length);

    // SC-009: every colour that appears in public data has a token row, so `seenTokens` is exactly
    // the number of distinct colours nothing has named.
    const unresolved = await sql<{ n: string }[]>`
      SELECT count(DISTINCT (a.color, a.kind))::text AS n
      FROM ${sql(schema)}.token_activity a
      LEFT JOIN ${sql(schema)}.tokens t ON t.net = a.net AND t.token_key = a.color AND t.kind = a.kind
      WHERE a.net = ${NET} AND (t.token_key IS NULL OR t.status = 'seen')`;
    expect(Number(unresolved[0]!.n)).toBe(status.body.counters.seenTokens);

    // ── Q21: the chain's own head sits beside the index's position ──────────────────────────
    // This API is configured with no indexer, so the head is `null` — and the route still answers
    // 200 with every other field intact. That is the contract: the status document is produced
    // from the database, and the one number the database cannot know may never break it.
    expect(status.body).toHaveProperty("chainHead");
    expect(status.body.chainHead).toBeNull();

    // The reader itself: one call per TTL, a shared in-flight promise, and `null` for every
    // failure mode rather than a throw.
    let calls = 0;
    const okFetch = (async () => {
      calls += 1;
      return { ok: true, json: async () => ({ data: { block: { height: 566_035 } } }) };
    }) as unknown as typeof fetch;
    const reader = makeChainHeadReader("http://indexer.invalid/graphql", okFetch);
    expect(await reader()).toBe(566_035);
    expect(await reader()).toBe(566_035);
    expect(calls).toBe(1);                       // the second read came from the cache
    const [a, b] = await Promise.all([reader(), reader()]);
    expect([a, b]).toEqual([566_035, 566_035]);
    expect(calls).toBe(1);

    // Every failure ends in null, and a failed reading is cached too, so a dead indexer costs one
    // call per TTL rather than one per request.
    for (const bad of [
      (async () => { throw new Error("network down"); }),
      (async () => ({ ok: false, json: async () => ({}) })),
      (async () => ({ ok: true, json: async () => ({ errors: [{ message: "boom" }] }) })),
      (async () => ({ ok: true, json: async () => ({ data: { block: null } }) })),
      (async () => ({ ok: true, json: async () => ({ data: { block: { height: "not a number" } } }) })),
    ] as unknown as typeof fetch[]) {
      expect(await makeChainHeadReader("http://indexer.invalid/graphql", bad)()).toBeNull();
    }
    // …and with no indexer configured at all it never even tries.
    expect(await makeChainHeadReader(undefined)()).toBeNull();
    expect(await makeChainHeadReader("")()).toBeNull();

    // The archive tip is real here, and no counter carries a time (Q1).
    expect(status.body.archiveTip).toBe(565376);
    expect(JSON.stringify(status.body.counters)).not.toMatch(/time|date/i);
  }, 60_000);
});
