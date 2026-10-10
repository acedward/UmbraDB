/**
 * The explorer's engine panel (static build only): what the browser engine indexes and how it is doing, with its
 * controls. It shows this tab's role (leader or follower, and the open tabs), the network, the engine's state, the saved
 * configuration, the first indexed height with "history before block H is not indexed" (`/v1/status` `startHeight`),
 * the synced and scanned heights, durability and storage (the engine's storage reading: usage, quota, the pause
 * threshold, persistence; the page's own `navigator.storage` figures until the engine has one), and links to the system
 * status page.
 *
 * Controls, each one engine request (from a follower tab the leader performs it): `start` (the saved configuration),
 * `stop`, `range` (the typed start, `tip` or a height, and optional end), `reset`, `export` and `import` (a snapshot
 * file). A range change, a reset and an import drop the store's data, so when the store holds blocks the panel first
 * asks, offering to export a snapshot before going on. The answer to each request, or its error, is shown below the
 * controls.
 *
 * Everything is drawn with DOM nodes and `textContent` (no markup is parsed), with no `style` attribute; the panel
 * refreshes every 2 s while the page is visible, after each request and on the engine's notices.
 */
import { type EngineClient, EngineError } from "./client.ts";
import { type PageStorage, type PanelView, panelView, parseRange } from "./panel-model.ts";
import type { HostStatus } from "./protocol.ts";
import type { EngineTabs } from "./tabs.ts";

export interface EnginePanelOptions {
  client: EngineClient;
  tabs: Pick<EngineTabs, "role" | "connectedTabs" | "onRoleChange">;
  /** The panel is inserted after this element. */
  after: Element;
  /** Default 2 000. */
  refreshMs?: number;
  /** The page's storage figures. Default: `navigator.storage`. */
  pageStorage?: () => Promise<PageStorage>;
  /** The system status page. Default `./system.html`. */
  systemHref?: string;
}

export interface EnginePanel {
  readonly element: HTMLElement;
  refresh(): Promise<void>;
  close(): void;
}

async function navigatorStorage(): Promise<PageStorage> {
  const storage = globalThis.navigator?.storage;
  if (storage === undefined) return { usageBytes: null, quotaBytes: null, persisted: null };
  const [estimate, persisted] = await Promise.all([storage.estimate().catch(() => undefined), storage.persisted().catch(() => null)]);
  return { usageBytes: estimate?.usage ?? null, quotaBytes: estimate?.quota ?? null, persisted };
}

const messageOf = (e: unknown): string => (e instanceof EngineError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** A file the engine answered (an exported snapshot), whatever object carries it. */
function fileOf(result: unknown): { blob: Blob; name: string } | null {
  const named = (b: Blob, name: unknown): { blob: Blob; name: string } => ({
    blob: b,
    name: typeof name === "string" && /^[\w.-]{1,200}$/.test(name) ? name : b instanceof File && /^[\w.-]{1,200}$/.test(b.name) ? b.name : "umbradb-snapshot.tar",
  });
  if (result instanceof Blob) return named(result, undefined);
  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>;
    for (const k of ["file", "snapshot", "blob"]) if (r[k] instanceof Blob) return named(r[k] as Blob, r.name ?? r.fileName);
  }
  return null;
}

/** Saves a file through a download link (a download, not a navigation the page's policy would refuse). */
function save(file: { blob: Blob; name: string }): void {
  const url = URL.createObjectURL(file.blob);
  const a = node("a");
  a.href = url;
  a.download = file.name;
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function mountEnginePanel(opts: EnginePanelOptions): EnginePanel {
  const { client, tabs } = opts;
  const readPageStorage = opts.pageStorage ?? navigatorStorage;

  // ── Markup ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const root = node("section", "engine-panel");
  root.id = "engine-panel";
  root.setAttribute("aria-label", "browser engine");
  const head = node("div", "row");
  head.append(node("h2", undefined, "engine"));
  const system = node("a", "system-link", "system status");
  system.href = opts.systemHref ?? "./system.html";
  system.setAttribute("data-link", "system");
  head.append(system);
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
  row("role", "tab");
  row("network", "network");
  row("state", "engine");
  row("configuration", "configuration");
  const history = row("history", "indexed from");
  row("synced", "synced height");
  row("scanned", "scanned height");
  row("durability", "durability");
  row("storage", "storage");
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
  opts.after.after(root);

  // ── State ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  let status: HostStatus | null = null;
  let statusError: string | null = null;
  let api: Record<string, unknown> | null = null;
  let pageStorage: PageStorage | null = null;
  let connected: number | null = null;
  let view: PanelView | null = null;
  let busy = false;
  let refreshing: Promise<void> | null = null;
  let again = false;
  let closed = false;
  let pending: { go: () => Promise<void> } | null = null;

  function render(): void {
    view = panelView({ role: tabs.role(), connectedTabs: connected, status, statusError, api, pageStorage });
    const set = (k: string, text: string): void => {
      fields.get(k)!.textContent = text;
    };
    set("role", view.role);
    set("network", view.network);
    set("state", view.stateDetail === "" ? view.state : `${view.state} \u00b7 ${view.stateDetail}`);
    set("configuration", view.configuration);
    set("history", view.history);
    history.setAttribute("data-start-height", view.startHeight === null ? "" : String(view.startHeight));
    set("synced", view.synced);
    set("scanned", view.scanned);
    set("durability", view.durability);
    set("storage", view.storage);
    root.setAttribute("data-role", tabs.role());
    root.setAttribute("data-state", view.state);
    const idle = !busy && view.ready;
    startButton.disabled = !idle || view.running;
    stopButton.disabled = !idle || !view.running;
    for (const b of [rangeButton, resetButton, exportButton, importButton]) b.disabled = !idle;
    for (const b of [confirmExport, confirmGo]) b.disabled = busy;
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
    message.textContent = text;
  }

  /** Runs one request: the controls wait for it, its answer or error is shown, then the panel reads again. */
  async function run(label: string, request: () => Promise<unknown>, done: (result: unknown) => string): Promise<void> {
    busy = true;
    render();
    say(`${label}\u2026`);
    try {
      say(done(await request()));
    } catch (e) {
      say(`${label} failed \u00b7 ${messageOf(e)}`);
    } finally {
      // The controls are free again as soon as the answer is shown, not only once the panel has read the engine again.
      busy = false;
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
    confirmText.textContent = `This store holds blocks ${view.heldRange}. ${what} drops them; export a snapshot first to keep them.`;
    confirmGo.textContent = `drop the data and ${what.toLowerCase()}`;
    confirm.hidden = false;
  }

  const exportSnapshot = (): Promise<void> =>
    run("export", () => client.export(), (result) => {
      const file = fileOf(result);
      if (file === null) return "export answered no file";
      save(file);
      return `snapshot saved as ${file.name}`;
    });

  startButton.addEventListener("click", () => void run("start", () => client.start(), () => "started"));
  stopButton.addEventListener("click", () => void run("stop", () => client.stop(), () => "stopped"));
  rangeButton.addEventListener("click", () => {
    const r = parseRange(rangeStart.value, rangeEnd.value);
    if (!r.ok) {
      say(`range not sent \u00b7 ${r.message}`);
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
      say("import not sent \u00b7 choose a snapshot file first");
      return;
    }
    dropping("Importing a snapshot", () => run("import", () => client.import(file), () => `snapshot ${file.name} imported`));
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
  render();
  void refresh();

  return {
    element: root,
    refresh,
    close(): void {
      closed = true;
      clearInterval(timer);
      offRole();
      offNotice();
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}
