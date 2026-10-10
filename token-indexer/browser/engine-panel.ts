/**
 * The indexer section of the overview (static build only, `index.html`): what the browser engine indexes and how it is
 * doing, with its controls. It shows the health line (the engine's system snapshot, `HEALTH_LABELS`), this tab's role
 * (leader or follower, and the open tabs), the network, the engine's state, the saved configuration, the first indexed
 * height with "history before block H is not indexed" (`/v1/status` `startHeight`; with the token indexer off and no
 * scan range, the archive's first height), the archive and scanned heights,
 * the finalized tip and the lag behind it (blocks and time), blocks per second, the worker's uptime, durability and the
 * storage line (store size, quota, pause threshold, persistence; the explanation in its tooltip). When the boot failed
 * because of the store (another PGlite version wrote it, or it does not open), the state says so and `reset`, `range`
 * and `import` stay enabled: they replace the store.
 *
 * Controls, each one engine request (from a follower tab the leader performs it): `start` (the saved configuration),
 * `stop`, `range` (the typed start, `tip` or a height, and optional end), `reset`, `export` (the snapshot file is saved
 * as a download, `snapshot-page.ts`) and `import` (the chosen snapshot file; afterwards the engine is stopped and a start
 * continues after the snapshot's last block). A range change, a reset and an import drop the store's data, so when the
 * store holds blocks the section first asks, offering to export a snapshot before going on. The answer to each request,
 * or its error (a refused snapshot says why), is shown below the controls.
 *
 * Everything is drawn with DOM nodes and text (no markup is parsed), with no `style` attribute; text that comes from
 * the engine or from a file (errors, refusal reasons, names) is drawn with the explorer's hidden-character rules
 * (`visible-text.ts`), every value as its own bidirectional island. The section reads the engine every 2 s while the
 * page is visible, after each request and on the engine's notices; it follows the system snapshot (`system-view.ts`)
 * only while it is shown ({@link EnginePanel.watch}) and the page is visible.
 */
import type { SystemSnapshot } from "../engine/system-snapshot.ts";
import { type EngineClient, EngineError, type PersistenceResult } from "./client.ts";
import { type PageStorage, type PanelInputs, type PanelView, panelView, parseRange } from "./panel-model.ts";
import type { ExportResult, HostStatus, ImportResult } from "./protocol.ts";
import { saveSnapshotFile } from "./snapshot-page.ts";
import { followSystem } from "./system-view.ts";
import type { EngineTabs } from "./tabs.ts";
import { dataNode, visibleText } from "./visible-text.ts";

export interface EnginePanelOptions {
  client: EngineClient;
  tabs: Pick<EngineTabs, "tabId" | "role" | "connectedTabs" | "onRoleChange">;
  /** The section is appended to this element. */
  parent: Element;
  /** Default 2 000. */
  refreshMs?: number;
  /** The page's storage figures. Default: `navigator.storage`. */
  pageStorage?: () => Promise<PageStorage>;
  /** The page's request to keep the site's storage (`requestPersistentStorage`): a refusal is explained with the storage. */
  persistence?: Promise<PersistenceResult>;
  /** Called after each drawing with the view and the engine's status it was drawn from. */
  onView?: (view: PanelView, status: HostStatus | null) => void;
}

export interface EnginePanel {
  readonly element: HTMLElement;
  refresh(): Promise<void>;
  /** Follows the engine's system snapshot (`true`: while the page is visible) or stops following it. */
  watch(on: boolean): void;
  /** The sources of the last drawing (for scripted checks). */
  inputs(): PanelInputs | null;
  close(): void;
}

async function navigatorStorage(): Promise<PageStorage> {
  const storage = globalThis.navigator?.storage;
  if (storage === undefined) return { usageBytes: null, quotaBytes: null, persisted: null };
  const [estimate, persisted] = await Promise.all([storage.estimate().catch(() => undefined), storage.persisted().catch(() => null)]);
  return { usageBytes: estimate?.usage ?? null, quotaBytes: estimate?.quota ?? null, persisted };
}

/** An engine request's error as one line: its code and message. */
export const messageOf = (e: unknown): string => (e instanceof EngineError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function mountEnginePanel(opts: EnginePanelOptions): EnginePanel {
  const { client, tabs } = opts;
  const readPageStorage = opts.pageStorage ?? navigatorStorage;

  // ── Markup ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const root = node("section", "engine-panel");
  root.id = "engine-panel";
  root.setAttribute("aria-label", "indexer");
  const head = node("div", "row");
  head.append(node("h2", undefined, "indexer"));
  root.append(head);

  const grid = node("div", "kv");
  const fields = new Map<string, HTMLElement>();
  const row = (key: string, label: string): HTMLElement => {
    const v = node("div", "v");
    v.setAttribute("data-field", key);
    grid.append(node("div", "k", label), v);
    fields.set(key, v);
    return v;
  };
  row("health", "health");
  row("role", "tab");
  row("network", "network");
  row("state", "engine");
  row("configuration", "configuration");
  const history = row("history", "start height");
  row("synced", "archive height");
  row("scanned", "scan height");
  row("tip", "finalized tip");
  row("lag", "lag");
  row("rate", "blocks/s");
  row("uptime", "uptime");
  row("durability", "durability");
  const storageField = row("storage", "storage");
  root.append(grid);

  const controls = node("div", "row controls");
  const button = (action: string, label: string): HTMLButtonElement => {
    const b = node("button", undefined, label);
    b.type = "button";
    b.setAttribute("data-action", action);
    return b;
  };
  const input = (name: string, label: string, placeholder: string): HTMLInputElement => {
    const i = node("input");
    i.type = "text";
    i.placeholder = placeholder;
    i.setAttribute("data-input", name);
    i.setAttribute("aria-label", label);
    i.size = 10;
    return i;
  };
  const startButton = button("start", "start");
  const stopButton = button("stop", "stop");
  const rangeStart = input("range-start", "start height", "tip or a height");
  const rangeEnd = input("range-end", "end height", "end (optional)");
  const rangeButton = button("range", "change range");
  const resetButton = button("reset", "reset");
  const exportButton = button("export", "export snapshot");
  const snapshotInput = node("input");
  snapshotInput.type = "file";
  snapshotInput.setAttribute("data-input", "snapshot");
  snapshotInput.setAttribute("aria-label", "snapshot file");
  const importButton = button("import", "import snapshot");
  controls.append(startButton, stopButton, node("span", "sep"), rangeStart, rangeEnd, rangeButton, resetButton, node("span", "sep"), exportButton, snapshotInput, importButton);
  root.append(controls);

  const confirm = node("div", "confirm");
  confirm.setAttribute("data-field", "confirm");
  confirm.hidden = true;
  const confirmText = node("div");
  const confirmExport = button("confirm-export", "export a snapshot first");
  const confirmGo = button("confirm-go", "go on");
  const confirmCancel = button("confirm-cancel", "cancel");
  const confirmButtons = node("div", "row");
  confirmButtons.append(confirmExport, confirmGo, confirmCancel);
  confirm.append(confirmText, confirmButtons);
  root.append(confirm);

  const message = node("div", "note");
  message.setAttribute("data-field", "message");
  message.setAttribute("role", "status");
  root.append(message);
  opts.parent.append(root);

  // ── State ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  let status: HostStatus | null = null;
  let statusError: string | null = null;
  let api: Record<string, unknown> | null = null;
  let pageStorage: PageStorage | null = null;
  let connected: number | null = null;
  let snapshot: SystemSnapshot | null = null;
  let persistence: PersistenceResult | null = null;
  void opts.persistence?.then((p) => {
    persistence = p;
    render();
  });
  let lastInputs: PanelInputs | null = null;
  let view: PanelView | null = null;
  let busy = false;
  let refreshing: Promise<void> | null = null;
  let again = false;
  let closed = false;
  let pending: { go: () => Promise<void> } | null = null;

  /** `text` as data in `el`: its hidden characters as visible marks, in a bidirectional island of its own. */
  const draw = (el: HTMLElement, text: string): void => {
    el.replaceChildren(dataNode(document, text));
  };

  function render(): void {
    lastInputs = { role: tabs.role(), connectedTabs: connected, status, statusError, api, pageStorage, persistence, snapshot };
    view = panelView(lastInputs);
    const set = (k: string, text: string): void => draw(fields.get(k)!, text);
    set("health", view.health);
    set("role", view.role);
    set("network", view.network);
    set("state", view.stateDetail === "" ? view.state : `${view.state} · ${view.stateDetail}`);
    set("configuration", view.configuration);
    set("history", view.history);
    history.setAttribute("data-start-height", view.startHeight === null ? "" : String(view.startHeight));
    set("synced", view.synced);
    set("scanned", view.scanned);
    set("tip", view.tip);
    set("lag", view.lag);
    set("rate", view.rate);
    set("uptime", view.uptime);
    set("durability", view.durability);
    set("storage", view.storage);
    storageField.title = visibleText(view.storageTitle);
    root.setAttribute("data-role", tabs.role());
    root.setAttribute("data-state", view.state);
    root.setAttribute("data-health", snapshot?.overview.health.state ?? "");
    const idle = !busy && view.ready;
    startButton.disabled = !idle || view.running;
    stopButton.disabled = !idle || !view.running;
    exportButton.disabled = !idle;
    // A store the boot could not use can still be replaced: reset, a new range or a snapshot.
    for (const b of [rangeButton, resetButton, importButton]) b.disabled = !idle && !(view.recoverable && !busy);
    for (const b of [confirmExport, confirmGo]) b.disabled = busy;
    opts.onView?.(view, status);
  }

  async function read(): Promise<void> {
    const [s, a, n] = await Promise.allSettled([client.status(), client.api("GET", "/v1/status"), tabs.connectedTabs()]);
    if (s.status === "fulfilled") {
      status = s.value;
      statusError = null;
    } else {
      // The engine did not answer (no leader yet, a closed worker): shown as such, not as its last known state.
      status = null;
      statusError = messageOf(s.reason);
    }
    if (a.status === "fulfilled" && a.value.status === 200) {
      try {
        const parsed: unknown = JSON.parse(a.value.body);
        api = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
      } catch {
        api = null;
      }
    }
    if (n.status === "fulfilled") connected = n.value;
    pageStorage = status?.storage == null ? await readPageStorage().catch(() => null) : null;
  }

  /** Reads the sources and draws them. A call while a read runs reads again once it ends (so a request's outcome is
   *  never drawn from a read that started before it), and resolves after that read. */
  function refresh(): Promise<void> {
    if (closed) return Promise.resolve();
    if (refreshing !== null) {
      again = true;
      return refreshing;
    }
    refreshing = (async () => {
      do {
        again = false;
        await read().catch(() => {});
        if (!closed) render();
      } while (again && !closed);
      refreshing = null;
    })();
    return refreshing;
  }

  function say(text: string): void {
    draw(message, text);
  }

  /** Runs one request: the controls wait for it, its answer or error is shown, then the section reads again. */
  async function run(label: string, request: () => Promise<unknown>, done: (result: unknown) => string): Promise<void> {
    busy = true;
    render();
    say(`${label}…`);
    try {
      say(done(await request()));
    } catch (e) {
      say(`${label} failed · ${messageOf(e)}`);
    } finally {
      busy = false;
      // Enable the controls with the answer, not only after the refresh: a click right after the answer must count.
      render();
      await refresh();
    }
  }

  function hideConfirm(): void {
    pending = null;
    confirm.hidden = true;
  }

  /** Runs `go` at once on a store with no blocks; otherwise asks first, offering an export. */
  function dropping(what: string, go: () => Promise<void>): void {
    if (view === null || !view.holdsData) {
      void go();
      return;
    }
    pending = { go };
    draw(confirmText, `This store holds blocks ${view.heldRange}. ${what} drops them; export a snapshot first to keep them.`);
    confirmGo.textContent = `drop the data and ${what.toLowerCase()}`;
    confirm.hidden = false;
  }

  const exportSnapshot = (): Promise<void> =>
    run("export", () => client.export(), (result) => {
      const r = result as ExportResult;
      saveSnapshotFile(r);
      return `snapshot saved as ${r.name} (blocks ${r.manifest.archive.startHeight ?? r.manifest.archive.height}–${r.manifest.archive.height})`;
    });

  startButton.addEventListener("click", () => void run("start", () => client.start(), () => "started"));
  stopButton.addEventListener("click", () => void run("stop", () => client.stop(), () => "stopped"));
  rangeButton.addEventListener("click", () => {
    const r = parseRange(rangeStart.value, rangeEnd.value);
    if (!r.ok) {
      say(`range not sent · ${r.message}`);
      return;
    }
    const text = `${r.startHeight === "tip" ? "the finalized tip" : `block ${r.startHeight}`}${r.endHeight === undefined ? ", following the tip" : ` to block ${r.endHeight}`}`;
    dropping("Changing the range", () =>
      run("range", () => (r.endHeight === undefined ? client.range(r.startHeight) : client.range(r.startHeight, r.endHeight)), () => `the store now indexes from ${text}`),
    );
  });
  resetButton.addEventListener("click", () => {
    dropping("Resetting", () => run("reset", () => client.reset(), () => "reset: the store's data was dropped and the saved configuration started again"));
  });
  exportButton.addEventListener("click", () => void exportSnapshot());
  importButton.addEventListener("click", () => {
    const file = snapshotInput.files?.[0];
    if (file === undefined) {
      say("import not sent · choose a snapshot file first");
      return;
    }
    dropping("Importing a snapshot", () =>
      run("import", () => client.import(file), (result) => {
        const a = (result as ImportResult).manifest.archive;
        return `snapshot ${file.name} imported: blocks ${a.startHeight ?? a.height}–${a.height}; the engine is stopped, and a start continues from block ${a.height + 1}`;
      }),
    );
  });
  confirmExport.addEventListener("click", () => void exportSnapshot());
  confirmGo.addEventListener("click", () => {
    const p = pending;
    hideConfirm();
    if (p !== null) void p.go();
  });
  confirmCancel.addEventListener("click", () => {
    hideConfirm();
    say("cancelled: nothing was sent");
  });

  // ── Refresh ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const offRole = tabs.onRoleChange(() => void refresh());
  const offNotice = client.onNotice((n) => {
    if (n.notice === "boot" || n.notice === "engine") void refresh();
  });
  const onVisible = (): void => {
    if (document.visibilityState === "visible") void refresh();
  };
  document.addEventListener("visibilitychange", onVisible);
  const timer = setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, opts.refreshMs ?? 2_000);

  let unfollow: (() => void) | null = null;
  function watch(on: boolean): void {
    if (closed || on === (unfollow !== null)) return;
    if (!on) {
      unfollow!();
      unfollow = null;
      return;
    }
    unfollow = followSystem(client, {
      viewer: `overview-${tabs.tabId}`,
      onSnapshot: (s) => {
        snapshot = s;
        render();
      },
    });
  }

  render();
  void refresh();

  return {
    element: root,
    refresh,
    watch,
    inputs: () => lastInputs,
    close(): void {
      watch(false);
      closed = true;
      clearInterval(timer);
      offRole();
      offNotice();
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}
