/**
 * What the indexer's overview (`engine-panel.ts`) shows, computed from its sources with no DOM: the tab's role, the
 * engine's status (`status`, {@link HostStatus}: the boot, the engine's loops, the cursors, the saved configuration and
 * modules, and the storage guard's reading), the API's `/v1/status` (the first indexed height, the archive and scanned
 * heights, durability), the engine's system snapshot (the health line, the finalized tip and the lag, blocks per second,
 * the worker's uptime) and, until the engine has a storage reading, the page's own `navigator.storage` figures. Also the
 * range the user typed, checked before it is sent.
 */
import { HEALTH_LABELS, type SystemSnapshot } from "../engine/system-snapshot.ts";
import type { PersistenceResult } from "./client.ts";
import type { HostStatus, StartConfig } from "./protocol.ts";
import { countText, durationText, rateText } from "./system-model.ts";
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
  /** The page's request to keep the site's storage (`requestPersistentStorage`), once answered. */
  persistence?: PersistenceResult | null;
  /** The engine's latest system snapshot (`null` until one arrives). */
  snapshot?: SystemSnapshot | null;
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
  /** `/v1/status` `startHeight`: the first indexed height, `null` before anything is indexed; with the token indexer off
   *  and no scan range, the archive's first height. */
  startHeight: number | null;
  /** The same sentence the explorer puts next to every list. */
  history: string;
  synced: string;
  scanned: string;
  durability: string;
  /** The storage line (store size, quota, pause threshold, persistence) and its explanation. */
  storage: string;
  storageTitle: string;
  /** The health line of the system snapshot (its label and reason), or the engine's state until there is one. */
  health: string;
  /** The finalized tip, the lag behind it (blocks and time), blocks per second and the worker's uptime (snapshot). */
  tip: string;
  lag: string;
  rate: string;
  uptime: string;
  /** The token indexer module is on (the saved settings; on unless switched off). */
  tokenIndexer: boolean;
  /** The engine runs (a `start` would be refused). */
  running: boolean;
  /** The boot has ended with an open store: the controls can be used. */
  ready: boolean;
  /** The boot failed because of the store (`storeProblem`): `reset`, `range` and `import` replace it. */
  recoverable: boolean;
  /** The store holds blocks: a range change, a reset or an import drops them (export first). */
  holdsData: boolean;
  /** The heights the store holds, for the question before its data is dropped. */
  heldRange: string;
}

const int = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The sentence next to every list of the explorer and in the panel. */
/** The start-height line: from the scan's first height (`/v1/status` `startHeight`), or with the token indexer off and no
 *  scan range from the archive's (`archive`). */
export function historyText(startHeight: number | null, from: "scan" | "archive" = "scan"): string {
  if (startHeight === null) return "nothing indexed yet";
  const what = from === "archive" ? `archived from block ${startHeight} (token indexer off)` : `indexed from block ${startHeight}`;
  return `${what} \u00b7 history before block ${startHeight} is not indexed`;
}

/** Bytes with one decimal, in megabytes below a gigabyte and in gigabytes from one (`995.3 MB`, `11.7 GB`). */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "unknown";
  const [value, unit] = bytes >= 1e9 ? [bytes / 1e9, "GB"] : [bytes / 1e6, "MB"];
  const [whole, frac] = value.toFixed(1).split(".");
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac} ${unit}`;
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

/** Whether the site's storage is persistent, in one word or two. */
const persistentWord = (persisted: boolean | null): string => (persisted === null ? "persistence unknown" : persisted ? "persistent" : "not persistent");

/** The sentence of the storage line's explanation about persistence (and the browser's refusal, when it refused). */
export function persistenceSentence(persisted: boolean | null, request: PersistenceResult | null | undefined): string {
  if (persisted === true) return "Persistent: the browser keeps this site's storage when space runs low.";
  if (persisted === null) return "Whether the browser keeps this site's storage is not known.";
  if (request !== null && request !== undefined && !request.persisted && request.error !== null)
    return `Not persistent: asking the browser to keep this site's storage failed (${request.error}), so it may clear the store when space runs low; the engine runs anyway.`;
  if (request !== null && request !== undefined && !request.persisted && request.requested)
    return "Not persistent: the browser refused to keep this site's storage, so it may clear the store when space runs low; the engine runs anyway.";
  return "Not persistent: the browser may clear this site's storage when space runs low.";
}

/**
 * The storage line, one short line — the store's own size, the quota, the usage at which the sync pauses, and whether
 * the storage is persistent (`60.7 MB · quota 10.8 GB · pauses at 9.7 GB · not persistent`, then `· paused` while the
 * sync is paused) — and its explanation for a tooltip: what the browser counts against the quota (more than the store
 * while it is open: Chrome reserves space for the store's open files), what the pause does, what "not persistent" means
 * and why, and the pause's reason.
 */
export function storageLine(s: HostStatus | null, page: PageStorage | null, request: PersistenceResult | null | undefined): { text: string; title: string } {
  const st = s?.storage ?? null;
  if (st !== null) {
    const parts = [st.storeBytes === null ? "size not read yet" : formatBytes(st.storeBytes), `quota ${formatBytes(st.quotaBytes)}`];
    if (st.pauseAtBytes !== null) parts.push(`pauses at ${formatBytes(st.pauseAtBytes)}`);
    parts.push(persistentWord(st.persisted));
    if (st.paused) parts.push("paused");
    const title = [
      st.storeBytes === null ? "The store's own size is not read yet." : `The store's own files take ${formatBytes(st.storeBytes)}.`,
      `The browser counts ${formatBytes(st.usageBytes)} against this site's quota of ${formatBytes(st.quotaBytes)}; while the store is open that count includes the space Chrome reserves for the store's open files, so it is larger than the store.`,
    ];
    if (st.pauseAtBytes !== null) title.push(`The sync pauses when that count reaches ${formatBytes(st.pauseAtBytes)}, before the quota, and resumes once space frees; the scan and the API go on.`);
    title.push(persistenceSentence(st.persisted, request));
    if (st.paused) title.push(`Paused: ${st.pausedReason ?? "the usage is near the quota"}.`);
    return { text: parts.join(" \u00b7 "), title: title.join(" ") };
  }
  if (page !== null) {
    return {
      text: `size not read yet \u00b7 quota ${formatBytes(page.quotaBytes)} \u00b7 ${persistentWord(page.persisted)}`,
      title: `The engine has not read the store's size yet. The browser counts ${formatBytes(page.usageBytes)} against this site's quota of ${formatBytes(page.quotaBytes)}. ${persistenceSentence(page.persisted, request)}`,
    };
  }
  return { text: "unknown", title: "" };
}

const height = (v: number | null): string => (v === null ? "none" : String(v));

/** The snapshot's health line: its label and reason. */
export function healthText(snap: SystemSnapshot): string {
  const h = snap.overview.health;
  return h.reason === null ? HEALTH_LABELS[h.state] : `${HEALTH_LABELS[h.state]} \u00b7 ${h.reason}`;
}

/**
 * The overview's figures from the system snapshot: the finalized tip; the lag behind it in blocks — the blocks not yet
 * scanned, or with the token indexer off the blocks not yet archived — and in time at the chain's measured seconds per
 * block; blocks per second over the last minute (archive and scan); and the worker's uptime. `—` before a snapshot.
 */
export function snapshotFigures(snap: SystemSnapshot | null, tokenIndexer: boolean): { tip: string; lag: string; rate: string; uptime: string } {
  if (snap === null) return { tip: "\u2014", lag: "\u2014", rate: "\u2014", uptime: "\u2014" };
  const o = snap.overview;
  const behind = tokenIndexer ? o.lag.blocks : o.lag.archiveBlocks;
  const seconds = behind === null || o.lag.secondsPerBlock === null ? null : behind * o.lag.secondsPerBlock;
  const what = tokenIndexer ? "not scanned yet" : "not archived yet";
  return {
    tip: o.finalizedTip === null ? "not read yet" : String(o.finalizedTip),
    lag: behind === null ? "\u2014"
      : behind === 0 ? "none: caught up with the finalized tip"
      : `${countText(behind)} block${behind === 1 ? "" : "s"} ${what}${seconds === null ? "" : ` \u00b7 about ${durationText(seconds * 1_000)}`}`,
    rate: `archive ${rateText(snap.sync.blocksPerSecond)} \u00b7 scan ${tokenIndexer ? rateText(snap.scan.blocksPerSecond) : "off"} (last minute)`,
    uptime: durationText(snap.engine.uptimeMs),
  };
}

export function panelView(i: PanelInputs): PanelView {
  const s = i.status;
  const api = i.api;
  const { state, detail } = stateOf(i);
  const scanStart = int(api?.startHeight);
  const syncHeight = int(api?.archiveHeight) ?? s?.cursors?.sync?.height ?? null;
  const archiveStart = s?.cursors?.sync?.startHeight ?? scanStart;
  const role = i.role === "leader" || i.role === "follower" ? i.role : i.role === "closed" ? "closed" : "connecting";
  const tabs = i.connectedTabs === null ? "" : ` \u00b7 ${i.connectedTabs} tab${i.connectedTabs === 1 ? "" : "s"} open`;
  const config = s?.settings?.config ?? s?.engine?.config;
  const tokenIndexer = s?.settings?.modules?.["token-indexer"] ?? true;
  // With the token indexer off since the store's first start there is no scan range: the archive's first height.
  const fromArchive = scanStart === null && !tokenIndexer && archiveStart !== null && archiveStart !== undefined;
  const startHeight = fromArchive ? archiveStart : scanStart;
  const storage = storageLine(s, i.pageStorage, i.persistence);
  const snap = i.snapshot ?? null;
  return {
    role: `${role === "leader" ? "leader (this tab runs the engine)" : role === "follower" ? "follower (the engine runs in another tab)" : role}${tabs}`,
    network: str(api?.network) ?? s?.network ?? "unknown",
    state,
    stateDetail: detail,
    configuration: configurationText(config, s?.settings?.autoStart),
    startHeight,
    history: historyText(startHeight, fromArchive ? "archive" : "scan"),
    synced: height(syncHeight),
    scanned: `${height(int(api?.indexedHeight))}${tokenIndexer ? "" : " \u00b7 token indexer off"}`,
    durability: str(api?.durability) ?? s?.store?.durability ?? "unknown",
    storage: storage.text,
    storageTitle: storage.title,
    health: snap === null ? (detail === "" ? state : `${state} \u00b7 ${detail}`) : healthText(snap),
    ...snapshotFigures(snap, tokenIndexer),
    tokenIndexer,
    running: s?.engine?.running === true,
    ready: s?.boot.phase === "ready",
    recoverable: s?.boot.phase === "failed" && s.boot.storeProblem !== null,
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
