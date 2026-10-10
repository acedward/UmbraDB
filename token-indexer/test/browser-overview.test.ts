/**
 * The main page of the static build without a browser: the overview's view of the engine's system snapshot, the
 * Modules section's list, the tabs' URL rule and the Database tab's view of the engine's answers.
 *
 * - `[[browser.overview.model]]` — the overview (`browser/panel-model.ts`): the health line is the snapshot's (its label
 *   and reason), else the engine's state; the finalized tip, the lag in blocks and time, blocks per second and the
 *   worker's uptime come from the snapshot; with the token indexer off the lag counts the blocks not archived yet, the
 *   scan's rate says off and the scan height says so; the module's state is the saved settings' (on unless switched off).
 * - `[[browser.overview.modules]]` — the Modules section's list (`browser/modules.ts`): the indexer roadmap's ten
 *   modules by product name, Token Indexer first and the only one the engine can switch, each with a one-line
 *   description.
 * - `[[browser.overview.tabs]]` — the tabs' URL rule (`browser/shell.ts`): `?tab=` names the tab; with none, an explorer
 *   route opens the Token Indexer tab and anything else the overview; setting the tab keeps the other parameters and the
 *   explorer's route.
 * - `[[browser.database.model]]` — the Database tab's view (`browser/database-model.ts`): `NULL`; bytes as the hex of
 *   their first 8 bytes, `…` and their length, what was sent in the tooltip; text cut at 48 characters with its length
 *   (astral characters counted as one), what was sent in the tooltip; sizes, estimates, kinds, the order and the page.
 */
import { describe, expect, it } from "vitest";
import { CELL_CHARS, cellText, kindText, orderText, pageText, rowsEstimateText, sizeText, tableLabel, tablesSummary } from "../browser/database-model.ts";
import { INDEXER_MODULES } from "../browser/modules.ts";
import { healthText, type PanelInputs, panelView, snapshotFigures } from "../browser/panel-model.ts";
import { type HostStatus, MODULE_IDS } from "../browser/protocol.ts";
import { isExplorerRoute, tabOf, TAB_TITLES, urlWithTab } from "../browser/shell.ts";
import { HEALTH_LABELS } from "../engine/system-snapshot.ts";
import { snapshotFixture } from "./helpers/snapshot-fixture.ts";

const BOOT_READY: HostStatus["boot"] = {
  phase: "ready", error: null, capabilities: null, storeProblem: null,
  timings: { capabilitiesMs: 1, storeMs: 1, ledgerMs: 1, migrateMs: 1, totalMs: 4 },
};
const CONFIG = { source: { kind: "tape" as const, range: "u1" as const }, startHeight: 715402 };
function hostStatus(over: Partial<HostStatus> = {}): HostStatus {
  return {
    protocol: 1, network: "stagenet", boot: BOOT_READY, store: null,
    engine: {
      running: true, config: CONFIG, error: null,
      status: { started: true, stopping: false, sync: { phase: "idle", failures: 0 }, scan: { phase: "idle", failures: 0, scanner: "following" }, api: { inFlight: 0, maxConcurrentRequests: 8 } },
    },
    cursors: null, settings: { config: CONFIG, autoStart: true }, storage: null, snapshots: { lastExport: null, lastImport: null },
    ...over,
  };
}
const API = { network: "stagenet", startHeight: 714485, indexedHeight: 714900, archiveHeight: 715183, durability: "non-durable", scanner: "following" };
const inputs = (over: Partial<PanelInputs> = {}): PanelInputs => ({
  role: "leader", connectedTabs: 1, status: hostStatus(), statusError: null, api: API, pageStorage: null, snapshot: null, ...over,
});

describe("the static build's main page (no browser)", () => {
  it("[[browser.overview.model]] the overview: the snapshot's health line, tip, lag, blocks/s and uptime; the engine's state until a snapshot arrives; with the token indexer off the lag counts unarchived blocks and the scan says off; the module's state from the saved settings", () => {
    const snap = snapshotFixture();
    const v = panelView(inputs({ snapshot: snap }));
    expect(v.health).toBe("catching up · scan 1234 blocks behind the finalized tip");
    expect(healthText(snap)).toBe(v.health);
    expect([v.tip, v.lag, v.rate, v.uptime]).toEqual([
      "716134",
      "1,234 blocks not scanned yet · about 2 h 3 min", // 1234 × 6 s
      "archive 1.37 blocks/s · scan 12.50 blocks/s (last minute)",
      "1 h 2 min",
    ]);
    expect([v.scanned, v.synced, v.tokenIndexer]).toEqual(["714900", "715183", true]);
    // Each health state by the status page's label; no reason, the label alone.
    for (const state of Object.keys(HEALTH_LABELS) as Array<keyof typeof HEALTH_LABELS>) {
      const s = snapshotFixture({ overview: { ...snap.overview, health: { state, label: HEALTH_LABELS[state], reason: null } } });
      expect(panelView(inputs({ snapshot: s })).health).toBe(HEALTH_LABELS[state]);
    }
    // Before a snapshot: the engine's state, and nothing for the snapshot's figures.
    const before = panelView(inputs());
    expect([before.health, before.tip, before.lag, before.rate, before.uptime]).toEqual(["running · sync idle · scan following", "—", "—", "—", "—"]);
    expect(panelView(inputs({ status: null })).health).toBe("connecting");
    // Caught up; one block; a tip not read yet; no measured block time.
    const lag = (l: Partial<typeof snap.overview.lag>, tip: number | null = 716134) =>
      snapshotFigures(snapshotFixture({ overview: { ...snap.overview, finalizedTip: tip, lag: { ...snap.overview.lag, ...l } } }), true);
    expect(lag({ blocks: 0 }).lag).toBe("none: caught up with the finalized tip");
    expect(lag({ blocks: 1, secondsPerBlock: null }).lag).toBe("1 block not scanned yet");
    expect(lag({ blocks: null }, null)).toMatchObject({ lag: "—", tip: "not read yet" });
    // The token indexer off (the saved settings): the archive's lag, the scan off.
    const off = panelView(inputs({ snapshot: snap, status: hostStatus({ settings: { config: CONFIG, autoStart: true, modules: { "token-indexer": false } } }) }));
    expect([off.tokenIndexer, off.scanned, off.lag, off.rate]).toEqual([
      false, "714900 · token indexer off", "951 blocks not archived yet · about 1 h 35 min", "archive 1.37 blocks/s · scan off (last minute)",
    ]);
    expect(panelView(inputs({ status: hostStatus({ settings: { config: CONFIG, autoStart: true, modules: { "token-indexer": true } } }) })).tokenIndexer).toBe(true);
    expect(panelView(inputs({ status: null })).tokenIndexer).toBe(true);
  });

  it("[[browser.overview.modules]] the Modules section lists the indexer roadmap's ten modules by product name, Token Indexer first and the only one the engine switches, each with a one-line description", () => {
    expect(INDEXER_MODULES.map((m) => m.name)).toEqual([
      "Token Indexer MIP-0018",
      "Public API Part 1 (wallets)",
      "Public API Part 2 (dApps)",
      "Public API Part 3 (SPO)",
      "Fast Dust Sync",
      "Fast Shielded Sync",
      "Shielded Token State & Discovery MIP-0006",
      "Unshielded Token State MIP-0006",
      "JSON RPC",
      "Explorer POC",
    ]);
    expect(INDEXER_MODULES.map((m) => m.id)).toEqual(["token-indexer", "api-wallets", "api-dapps", "api-spo", "fast-dust", "fast-shielded", "shielded-state", "unshielded-state", "jsonrpc", "explorer"]);
    expect(INDEXER_MODULES.filter((m) => m.engineModule !== null).map((m) => m.engineModule)).toEqual([...MODULE_IDS]);
    for (const m of INDEXER_MODULES) {
      expect(m.name, m.id).not.toMatch(/^Mod:/);
      expect(m.description, m.id).toMatch(/^\S.{20,140}\.$/);
      expect(m.description, m.id).not.toMatch(/[\n\r]|PR #|#\d/);
    }
  });

  it("[[browser.overview.tabs]] the tab a URL names: its tab parameter, else the Token Indexer tab for an explorer route, else the overview; setting it keeps the other parameters and the route", () => {
    const at = (search: string, hash: string) => tabOf({ search, hash });
    expect(at("", "")).toBe("overview");
    expect(at("?tab=database", "")).toBe("database");
    expect(at("?tab=tokens", "")).toBe("tokens");
    expect(at("?tab=overview", "#/token/ab/cd/1")).toBe("overview");
    expect(at("", "#/")).toBe("tokens");
    expect(at("?refresh=600", "#/contract/ab")).toBe("tokens");
    expect(at("?tab=nope", "")).toBe("overview");
    expect(at("?tab=", "#x")).toBe("overview");
    expect([isExplorerRoute("#/status"), isExplorerRoute("#status"), isExplorerRoute("")]).toEqual([true, false, false]);
    expect(urlWithTab("https://site.test/index.html?refresh=600&watchdogLimitMs=5000#/token/ab/cd/1", "database")).toBe(
      "https://site.test/index.html?refresh=600&watchdogLimitMs=5000&tab=database#/token/ab/cd/1");
    expect(urlWithTab("https://site.test/sub/?tab=tokens", "overview")).toBe("https://site.test/sub/?tab=overview");
    expect(TAB_TITLES).toEqual({ overview: "UmbraDB indexer", tokens: "MIP-0018 token explorer", database: "UmbraDB database" });
  });

  it("[[browser.database.model]] the Database tab's view: NULL; bytes as the hex of their first 8 bytes and their length; text cut at 48 characters with its length; what was sent in the tooltip; sizes, estimates, kinds, order and page", () => {
    expect(cellText({ kind: "null" })).toEqual({ text: "NULL", title: null, isNull: true });
    expect(cellText({ kind: "bytes", hex: "", bytes: 0 })).toEqual({ text: " · 0 bytes", title: null, isNull: false });
    expect(cellText({ kind: "bytes", hex: "0a0b", bytes: 2 })).toEqual({ text: "0a0b · 2 bytes", title: null, isNull: false });
    expect(cellText({ kind: "bytes", hex: "00112233445566778899aabbccddeeff", bytes: 32 })).toEqual({
      text: "0011223344556677… · 32 bytes", title: "00112233445566778899aabbccddeeff… (32 bytes)", isNull: false,
    });
    expect(cellText({ kind: "bytes", hex: "001122334455667788", bytes: 9 })).toEqual({
      text: "0011223344556677… · 9 bytes", title: "001122334455667788 (9 bytes)", isNull: false,
    });
    expect(cellText({ kind: "text", text: "715433", chars: 6 })).toEqual({ text: "715433", title: null, isNull: false });
    const long = "x".repeat(256);
    expect(cellText({ kind: "text", text: long, chars: 70_000 })).toEqual({
      text: `${"x".repeat(CELL_CHARS)}… (70,000 characters)`, title: `${long}… (70,000 characters)`, isNull: false,
    });
    const astral = "\u{1F600}".repeat(50); // 50 characters, 100 UTF-16 units
    expect(cellText({ kind: "text", text: astral, chars: 50 }).text).toBe(`${"\u{1F600}".repeat(48)}… (50 characters)`);
    expect(cellText({ kind: "text", text: "\u{1F600}".repeat(48), chars: 48 }).title).toBe(null);
    // Hostile text stays text here (the page draws its marks).
    expect(cellText({ kind: "text", text: "\u202e<b>", chars: 4 }).text).toBe("\u202e<b>");

    expect([sizeText(0), sizeText(8_192), sizeText(999_999), sizeText(4_259_840)]).toEqual(["0.0 kB", "8.2 kB", "1000.0 kB", "4.3 MB"]);
    expect([rowsEstimateText(null), rowsEstimateText(699.4), rowsEstimateText(12_345)]).toEqual(["no estimate", "~699 rows", "~12,345 rows"]);
    expect([kindText({ kind: "table", partitionOf: null }), kindText({ kind: "partitioned", partitionOf: null }), kindText({ kind: "partition", partitionOf: "blocks" })]).toEqual(
      ["table", "partitioned", "partition of blocks"]);
    expect(tableLabel({ name: "blocks_p0", kind: "partition", partitionOf: "blocks", estimatedRows: null, totalBytes: 106_496 })).toBe("blocks_p0 · no estimate · 106.5 kB");
    expect(tablesSummary({ databaseBytes: 10_551_419, elapsedMs: 3, schemas: [{ name: "a", tables: [] }, { name: "b", tables: [{ name: "t", kind: "table", partitionOf: null, estimatedRows: 1, totalBytes: 1 }] }] })).toBe(
      "2 schemas · 1 tables · 10.6 MB in all · estimated rows and sizes from the catalog · read-only");
    // Newest first only where the key, after the network, leads with a block height; any other key is named as it is.
    expect(orderText({ orderBy: ["net", "height", "block_hash"] })).toBe("newest first: by net, height, block_hash, descending");
    expect(orderText({ orderBy: ["network", "block_height", "tx_index", "item_index"] })).toBe("newest first: by network, block_height, tx_index, item_index, descending");
    expect(orderText({ orderBy: ["hash"] })).toBe("by primary key (hash), descending");
    expect(orderText({ orderBy: ["kind", "key"] })).toBe("by primary key (kind, key), descending");
    expect(orderText({ orderBy: ["network", "contract_address", "block_height", "tx_index", "event_index", "classification"] })).toBe(
      "by primary key (network, contract_address, block_height, tx_index, event_index, classification), descending");
    expect(orderText({ orderBy: ["network"] })).toBe("by primary key (network), descending");
    expect(orderText({ orderBy: [] })).toBe("newest first: the last written row first (the table has no primary key)");
    const row = [{ kind: "null" as const }];
    expect(pageText({ offset: 0, rows: [row, row], more: true })).toBe("rows 1–2, more follow");
    expect(pageText({ offset: 25, rows: [row], more: false })).toBe("rows 26–26");
    expect(pageText({ offset: 0, rows: [], more: false })).toBe("no rows");
    expect(pageText({ offset: 50, rows: [], more: false })).toBe("no rows from row 51");
  });
});
