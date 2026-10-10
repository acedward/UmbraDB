/**
 * The system status page of the static build (`system.html`): everything the browser engine is doing and how it is
 * configured, on one read-only page — Overview (the health line, the heights and the lag), Configuration, Sync, Scan,
 * Databases, Storage, API, Engine, Browser, Snapshots and Logs — drawn from the engine's system snapshot
 * (`../engine/system-snapshot.ts`) by `system-model.ts`. The controls stay on the indexer's overview (`index.html`),
 * whose header links here; this page links back.
 *
 * - **Tabs.** The page joins the other tabs of the store (`tabs.ts`), as every page of the build does: the leader tab
 *   runs the engine worker under the page's watchdog (`?watchdogLimitMs=<ms>` sets its limit, as on `engine.html`), a
 *   follower shows the leader's snapshots, marked "follower". It asks the browser to keep the site's storage, as every
 *   page does.
 * - **Live refresh.** `followSystem` (`system-view.ts`) watches the engine's snapshots while the page is visible (a
 *   snapshot about every 2 s, the database statistics about every 30 s) and stops watching when it is hidden or goes
 *   away, so a hidden page costs the engine nothing.
 * - **Exact row counts** are read on demand ("count rows exactly"), never on the live refresh.
 * - **"Download diagnostics"** saves the snapshot the page shows as JSON (`diagnosticsFile`: redacted and validated
 *   again, its log lines included) through a download link: a `blob:` URL and `<a download>`, a download rather than a
 *   navigation, which the page's policy allows.
 * - **Text.** Everything is drawn with DOM nodes and text: no markup is ever parsed (the build's policy requires
 *   Trusted Types, and this page has no policy for any markup sink). Text from the engine is drawn with the explorer's
 *   hidden-character rules (`visible-text.ts`).
 *
 * For scripted use (the browser tests read it), `window.umbradbEngine` holds the client, the tabs and the snapshot
 * helpers, as on the other pages, and `window.umbradbSystem` the snapshot drawn last and how many were drawn.
 */
import type { SystemSnapshot } from "../engine/system-snapshot.ts";
import { EngineError, requestPersistentStorage, startEngineWorker } from "./client.ts";
import type { SupervisedEngine } from "./supervisor.ts";
import { collectionText, healthLine, statusSections, type StatusCell, type StatusSection, type StatusTable, type StatusValue } from "./system-model.ts";
import { diagnosticsFile, followSystem, refreshSystem } from "./system-view.ts";
import { fetchPublishedSnapshot, publishedSnapshots, saveSnapshotFile } from "./snapshot-page.ts";
import { connectEngineTabs, localEngineOf } from "./tabs.ts";
import { dataNode, visibleText } from "./visible-text.ts";

declare global {
  interface Window {
    umbradbSystem?: {
      /** The snapshot drawn last (`null` before the first). */
      latest(): SystemSnapshot | null;
      /** Snapshots drawn so far. */
      readonly renders: number;
    };
  }
}

const loadedAt = performance.now();
const persistence = requestPersistentStorage();
const limit = Number(new URLSearchParams(location.search).get("watchdogLimitMs"));
let supervised: SupervisedEngine<Worker> | undefined;
const tabs = connectEngineTabs({
  startWorker: () => {
    supervised = startEngineWorker(Number.isSafeInteger(limit) && limit >= 100 ? { limitMs: limit } : {});
    return localEngineOf(supervised);
  },
});
const client = tabs.client;
window.umbradbEngine = {
  client,
  tabs,
  /** This tab's engine worker while it leads. */
  get worker() {
    return tabs.worker();
  },
  restarts: () => supervised?.restarts() ?? [],
  loadedAt,
  persistence,
  snapshots: {
    save: saveSnapshotFile,
    list: () => publishedSnapshots(location.href),
    published: (name) => fetchPublishedSnapshot(name, location.href),
  },
};

let latest: SystemSnapshot | null = null;
let renders = 0;
window.umbradbSystem = {
  latest: () => latest,
  get renders() {
    return renders;
  },
};

// ── DOM (text nodes only) ────────────────────────────────────────────────────────────────────────────────────────

function byId(id: string): HTMLElement {
  const n = document.getElementById(id);
  if (n === null) throw new Error(`the system page has no #${id}`);
  return n;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const messageOf = (e: unknown): string => (e instanceof EngineError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));

const sectionsEl = byId("sections");
const bannerEl = byId("banner");
const roleEl = byId("role");
const liveEl = byId("live");
const collectionEl = byId("collection");
const downloadEl = byId("download") as HTMLButtonElement;
const messageEl = byId("message");

function banner(text: string | null): void {
  bannerEl.hidden = text === null;
  bannerEl.replaceChildren();
  if (text !== null) bannerEl.appendChild(dataNode(document, text));
}
function message(text: string): void {
  messageEl.replaceChildren(dataNode(document, text));
}

function valueRow(grid: HTMLElement, x: StatusValue): void {
  grid.appendChild(node("div", "k", x.label));
  const v = node("div", x.tone === undefined ? "v" : `v tone-${x.tone}`);
  v.setAttribute("data-field", x.field);
  v.appendChild(dataNode(document, x.text));
  grid.appendChild(v);
}

function cellNode(c: StatusCell): HTMLTableCellElement {
  const td = node("td", c.numeric === true ? "num" : undefined);
  if (c.field !== undefined) td.setAttribute("data-field", c.field);
  td.appendChild(dataNode(document, c.text));
  return td;
}

function tableNode(t: StatusTable): HTMLElement {
  const wrap = node("div", "scroll table");
  wrap.appendChild(node("div", "note", t.caption));
  const table = node("table");
  table.setAttribute("data-field", t.field);
  const head = node("tr");
  for (const c of t.columns) head.appendChild(node("th", undefined, c));
  table.appendChild(node("thead")).appendChild(head);
  const body = table.appendChild(node("tbody"));
  for (const r of t.rows) {
    const tr = node("tr");
    for (const c of r) tr.appendChild(cellNode(c));
    body.appendChild(tr);
  }
  wrap.appendChild(table);
  if (t.rows.length === 0) wrap.appendChild(node("div", "empty", t.empty));
  return wrap;
}

let countButton: HTMLButtonElement | undefined;

function sectionNode(s: StatusSection): HTMLElement {
  const el = node("section");
  el.id = `sys-${s.id}`;
  el.setAttribute("data-section", s.id);
  const head = node("div", "row head");
  head.appendChild(node("h2", undefined, s.title));
  if (s.id === "databases") {
    countButton ??= countRowsButton();
    head.appendChild(countButton);
  }
  el.appendChild(head);
  const grid = node("div", "kv");
  for (const x of s.values) valueRow(grid, x);
  el.appendChild(grid);
  for (const t of s.tables) el.appendChild(tableNode(t));
  return el;
}

function render(snapshot: SystemSnapshot): void {
  latest = snapshot;
  renders++;
  const health = healthLine(snapshot);
  document.body.setAttribute("data-health", snapshot.overview.health.state);
  document.body.setAttribute("data-role", snapshot.role);
  roleEl.textContent = snapshot.role === "follower" ? "follower tab: the leader's engine" : "leader tab";
  roleEl.title = visibleText(`${health.label}${health.reason === null ? "" : `: ${health.reason}`}`);
  collectionEl.replaceChildren(dataNode(document, collectionText(snapshot)));
  sectionsEl.replaceChildren(...statusSections(snapshot).map(sectionNode));
  downloadEl.disabled = false;
  if (document.body.getAttribute("data-state") === "loading") document.body.setAttribute("data-state", "ready");
}

// ── Live refresh, exact counts, diagnostics ──────────────────────────────────────────────────────────────────────

function showLive(): void {
  const visible = document.visibilityState === "visible";
  document.body.setAttribute("data-live", visible ? "watching" : "paused");
  liveEl.textContent = visible ? "live: a snapshot about every 2 s while this page is visible" : "paused: nothing is read while this page is hidden";
}

function countRowsButton(): HTMLButtonElement {
  const b = node("button", "mini", "count rows exactly");
  b.type = "button";
  b.setAttribute("data-action", "count-rows");
  b.addEventListener("click", () => {
    b.disabled = true;
    message("counting the rows of every table…");
    refreshSystem(client, { exactCounts: true })
      .then((s) => {
        render(s);
        message(`rows counted: ${s.databases.statements.length} statements`);
      }, (e: unknown) => message(`the rows could not be counted: ${messageOf(e)}`))
      .finally(() => {
        b.disabled = false;
      });
  });
  return b;
}

/** Saves `file` through a download link (a download, not a navigation the page's policy would refuse). */
function save(file: { name: string; type: string; text: string }): void {
  const url = URL.createObjectURL(new Blob([file.text], { type: file.type }));
  const a = node("a");
  a.href = url;
  a.download = file.name;
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

downloadEl.addEventListener("click", () => {
  downloadEl.disabled = true;
  (latest === null ? refreshSystem(client) : Promise.resolve(latest))
    .then((s) => {
      const file = diagnosticsFile(s);
      save(file);
      message(`saved ${file.name}`);
    }, (e: unknown) => message(`no diagnostics: ${messageOf(e)}`))
    .finally(() => {
      downloadEl.disabled = false;
    });
});

tabs.onRoleChange((role) => {
  document.body.setAttribute("data-tab", role);
  if (latest === null) roleEl.textContent = role === "leader" ? "leader tab" : role === "follower" ? "follower tab: the leader's engine" : role;
});

client.booted().then((b) => {
  if (b.phase !== "ready") banner(`the engine did not start (${b.phase}): ${b.error ?? "no reason given"}`);
}, (e: unknown) => banner(`the engine did not answer: ${messageOf(e)}`));

followSystem(client, {
  viewer: `status-${tabs.tabId}`,
  onSnapshot: (s) => {
    banner(null);
    render(s);
  },
  onError: (e) => banner(`the engine's snapshot could not be read: ${messageOf(e)}`),
});

document.addEventListener("visibilitychange", showLive);
showLive();

// Leave at once when the page goes away (a follower takes over sooner); a page restored from the back/forward cache
// joins again from scratch.
addEventListener("pagehide", () => tabs.close());
addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
