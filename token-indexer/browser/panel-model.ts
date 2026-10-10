/**
 * What the explorer's engine panel (`engine-panel.ts`) shows, computed from its sources with no DOM: the tab's role,
 * the engine's status (`status`, {@link HostStatus}: the boot, the engine's loops, the cursors, the saved configuration
 * and the storage guard's reading), the API's `/v1/status` (the first indexed height, the archive and scanned heights,
 * durability) and, until the engine has a storage reading, the page's own `navigator.storage` figures. Also the range
 * the user typed, checked before it is sent.
 */
import type { HostStatus, StartConfig } from "./protocol.ts";
import type { TabRole } from "./tabs.ts";

/** The `/v1/status` fields the panel reads (an API answer: every field is checked before use). */
export interface ApiStatusFields {
  network?: unknown;
  startHeight?: unknown;
  indexedHeight?: unknown;
  archiveHeight?: unknown;
  durability?: unknown;
  scanner?: unknown;
}

/** The page's own storage figures (`navigator.storage.estimate()` and `persisted()`). */
export interface PageStorage {
  usageBytes: number | null;
  quotaBytes: number | null;
  persisted: boolean | null;
}

export interface PanelInputs {
  role: TabRole;
  connectedTabs: number | null;
  /** `null` until the first status answer. */
  status: HostStatus | null;
  /** Why the last status request failed. */
  statusError: string | null;
  /** `null` until the first `/v1/status` answer (or while the API does not answer). */
  api: ApiStatusFields | null;
  pageStorage: PageStorage | null;
}

/** The engine's state, as one word or phrase, plus its detail. */
export type EngineState =
  | "connecting"
  | "unavailable"
  | "booting"
  | "unsupported"
  | "failed"
  | "not started"
  | "stopped"
  | "running"
  | "waiting (network)"
  | "stalled (scan)"
  | "paused (storage)";

export interface PanelView {
  role: string;
  network: string;
  state: EngineState;
  stateDetail: string;
  /** The saved configuration (or the running one): mode, range, source and whether it starts by itself. */
  configuration: string;
  /** `/v1/status` `startHeight`: the first indexed height, `null` before anything is indexed. */
  startHeight: number | null;
  /** The same sentence the explorer puts next to every list. */
  history: string;
  synced: string;
  scanned: string;
  durability: string;
  storage: string;
  /** The engine runs (a `start` would be refused). */
  running: boolean;
  /** The boot has ended with an open store: the controls can be used. */
  ready: boolean;
  /** The store holds blocks: a range change, a reset or an import drops them (export first). */
  holdsData: boolean;
  /** The heights the store holds, for the question before its data is dropped. */
  heldRange: string;
}

const int = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The sentence next to every list of the explorer and in the panel. */
export function historyText(startHeight: number | null): string {
  return startHeight === null ? "nothing indexed yet" : `indexed from block ${startHeight} \u00b7 history before block ${startHeight} is not indexed`;
}

/** Bytes as megabytes with one decimal (`1,234.5 MB`). */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "unknown";
  const mb = (bytes / 1_000_000).toFixed(1);
  const [whole, frac] = mb.split(".");
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac} MB`;
}

/** A start configuration in words. */
export function configurationText(config: StartConfig | undefined, autoStart: boolean | undefined): string {
  if (config === undefined) return "none saved";
  const parts: string[] = [];
  const start = config.startHeight;
  parts.push(start === undefined || start === "tip" ? "from the finalized tip" : `from block ${start}`);
  parts.push(config.endHeight === undefined ? "following the finalized tip" : `to block ${config.endHeight}`);
  const source = config.source ?? { kind: "network" as const };
  parts.push(source.kind === "tape" ? `recorded range ${source.range}, replayed offline` : "the network's node and indexer");
  if (autoStart !== undefined) parts.push(autoStart ? "starts by itself" : "starts on request");
  return parts.join(" \u00b7 ");
}

function stateOf(i: PanelInputs): { state: EngineState; detail: string } {
  const s = i.status;
  if (s === null) return i.statusError === null ? { state: "connecting", detail: "" } : { state: "unavailable", detail: i.statusError };
  const boot = s.boot;
  if (boot.phase === "unsupported") return { state: "unsupported", detail: boot.error ?? "" };
  if (boot.phase === "failed") return { state: "failed", detail: boot.error ?? "" };
  if (boot.phase !== "ready") return { state: "booting", detail: boot.phase };
  const e = s.engine;
  if (e === null) return { state: "not started", detail: "" };
  if (!e.running) return e.error === null ? { state: "stopped", detail: "" } : { state: "failed", detail: e.error };
  const sync = e.status.sync;
  const scan = e.status.scan;
  const loops = `sync ${sync.phase} \u00b7 scan ${scan.scanner}`;
  if (s.storage?.paused === true) return { state: "paused (storage)", detail: s.storage.pausedReason ?? loops };
  if ((sync.phase === "starting" || sync.phase === "backoff") && sync.lastError !== undefined) return { state: "waiting (network)", detail: sync.lastError };
  if (scan.scanner === "stalled") return { state: "stalled (scan)", detail: scan.lastError ?? loops };
  return { state: "running", detail: loops };
}

function storageText(s: HostStatus | null, page: PageStorage | null): string {
  const st = s?.storage ?? null;
  if (st !== null) {
    const parts = [`${formatBytes(st.usageBytes)} used of ${formatBytes(st.quotaBytes)}`];
    if (st.pauseAtBytes !== null) parts.push(`the sync pauses at ${formatBytes(st.pauseAtBytes)}`);
    if (st.storeBytes !== null) parts.push(`store files ${formatBytes(st.storeBytes)}`);
    parts.push(`persistent: ${st.persisted === null ? "unknown" : st.persisted ? "yes" : "no"}`);
    if (st.paused) parts.push(`paused: ${st.pausedReason ?? "near the quota"}`);
    return parts.join(" \u00b7 ");
  }
  if (page !== null) {
    return `${formatBytes(page.usageBytes)} used of ${formatBytes(page.quotaBytes)} \u00b7 persistent: ${page.persisted === null ? "unknown" : page.persisted ? "yes" : "no"}`;
  }
  return "unknown";
}

const height = (v: number | null): string => (v === null ? "none" : String(v));

export function panelView(i: PanelInputs): PanelView {
  const s = i.status;
  const api = i.api;
  const { state, detail } = stateOf(i);
  const startHeight = int(api?.startHeight);
  const syncHeight = int(api?.archiveHeight) ?? s?.cursors?.sync?.height ?? null;
  const archiveStart = s?.cursors?.sync?.startHeight ?? startHeight;
  const role = i.role === "leader" || i.role === "follower" ? i.role : i.role === "closed" ? "closed" : "connecting";
  const tabs = i.connectedTabs === null ? "" : ` \u00b7 ${i.connectedTabs} tab${i.connectedTabs === 1 ? "" : "s"} open`;
  const config = s?.settings?.config ?? s?.engine?.config;
  return {
    role: `${role === "leader" ? "leader (this tab runs the engine)" : role === "follower" ? "follower (the engine runs in another tab)" : role}${tabs}`,
    network: str(api?.network) ?? s?.network ?? "unknown",
    state,
    stateDetail: detail,
    configuration: configurationText(config, s?.settings?.autoStart),
    startHeight,
    history: historyText(startHeight),
    synced: height(syncHeight),
    scanned: height(int(api?.indexedHeight)),
    durability: str(api?.durability) ?? s?.store?.durability ?? "unknown",
    storage: storageText(s, i.pageStorage),
    running: s?.engine?.running === true,
    ready: s?.boot.phase === "ready",
    holdsData: syncHeight !== null,
    heldRange: syncHeight === null ? "" : archiveStart === null || archiveStart === undefined ? `up to block ${syncHeight}` : `${archiveStart}\u2013${syncHeight}`,
  };
}

/** The range the user typed: a start (`tip` or a height) and an optional end. */
export type RangeInput = { ok: true; startHeight: number | "tip"; endHeight?: number } | { ok: false; message: string };

export function parseRange(startText: string, endText: string): RangeInput {
  const start = startText.trim().toLowerCase();
  const end = endText.trim();
  let startHeight: number | "tip";
  if (start === "" || start === "tip") startHeight = "tip";
  else if (/^\d{1,15}$/.test(start) && Number.isSafeInteger(Number(start))) startHeight = Number(start);
  else return { ok: false, message: "the start height is \"tip\" or a block height" };
  if (end === "") return { ok: true, startHeight };
  if (!/^\d{1,15}$/.test(end) || !Number.isSafeInteger(Number(end))) return { ok: false, message: "the end height is empty (follow the tip) or a block height" };
  const endHeight = Number(end);
  if (typeof startHeight === "number" && endHeight < startHeight) return { ok: false, message: "the end height is below the start height" };
  return { ok: true, startHeight, endHeight };
}
