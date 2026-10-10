/**
 * The header tabs of the static build's main page (`index.html`): **Overview** (the indexer: its figures, controls and
 * modules), **Token Indexer** (the MIP-0018 token explorer, present only while its module is on), **JSON RPC** (the EVM
 * JSON-RPC module's methods, present only while its module is on), **Database** (the store's tables) and a link to the
 * system status page.
 *
 * - **The URL holds the tab:** `?tab=overview|tokens|jsonrpc|database`, written with `history.pushState` when a tab is picked
 *   (no reload), so a reload or a shared link opens the same tab, and back and forward move between tabs. The fragment
 *   stays the token explorer's own (`#/…`, `ui/page.js`): a URL with no `tab` and an explorer route opens the Token
 *   Indexer tab, and following an explorer route from another tab opens it too. With no `tab` and no route, the
 *   overview opens.
 * - **The Token Indexer and JSON RPC tabs** are hidden while their module is off; when one goes away while shown, or a URL
 *   names it, the overview is shown and written into the URL. While its tab is not shown the explorer skips its periodic refresh
 *   (`explorer-transport.ts` `shown`), and it refreshes when shown.
 * - **The overview** follows the engine's system snapshot only while it is shown (`engine-panel.ts` `watch`); the
 *   Database tab reads the store's tables when first shown.
 * - The document's title names the tab shown.
 */

export const SHELL_TABS = ["overview", "tokens", "jsonrpc", "database"] as const;
export type ShellTab = (typeof SHELL_TABS)[number];

/** The document title while each tab is shown. */
export const TAB_TITLES: Record<ShellTab, string> = {
  overview: "UmbraDB indexer",
  tokens: "MIP-0018 token explorer",
  jsonrpc: "UmbraDB JSON RPC",
  database: "UmbraDB database",
};

const isTab = (v: string | null): v is ShellTab => v !== null && (SHELL_TABS as readonly string[]).includes(v);

/** Whether a fragment is one of the token explorer's routes (`#/…`). */
export const isExplorerRoute = (hash: string): boolean => hash.startsWith("#/");

/** The tab a URL names: its `tab`, else the Token Indexer tab for an explorer route, else the overview. */
export function tabOf(url: { search: string; hash: string }): ShellTab {
  const named = new URLSearchParams(url.search).get("tab");
  if (isTab(named)) return named;
  return isExplorerRoute(url.hash) ? "tokens" : "overview";
}

/** `href` with its `tab` set to `tab` (its other parameters and its fragment kept). */
export function urlWithTab(href: string, tab: ShellTab): string {
  const u = new URL(href);
  u.searchParams.set("tab", tab);
  return u.toString();
}

/** The tabs of the modules, present only while their module is on. */
export type ModuleTab = "tokens" | "jsonrpc";

export interface ShellOptions {
  /** Called when a tab is shown (also the first time). */
  onShow?: (tab: ShellTab, previous: ShellTab | null) => void;
}

export interface Shell {
  /** The tab shown. */
  current(): ShellTab;
  /** Shows `tab` and writes it into the URL (a new history entry). */
  open(tab: ShellTab): void;
  /** Whether a module's tab (Token Indexer, JSON RPC) exists (its module is on); hiding it while shown shows the
   *  overview. */
  setAvailable(tab: ModuleTab, available: boolean): void;
}

function byId(id: string): HTMLElement {
  const n = document.getElementById(id);
  if (n === null) throw new Error(`the page has no #${id}`);
  return n;
}

export function mountShell(opts: ShellOptions = {}): Shell {
  const links = new Map<ShellTab, HTMLAnchorElement>(SHELL_TABS.map((t) => [t, byId(`tab-${t}`) as HTMLAnchorElement]));
  const panels = new Map<ShellTab, HTMLElement>(SHELL_TABS.map((t) => [t, byId(`tab-panel-${t}`)]));
  /** The module tabs that exist (a tab not named exists). */
  const available = new Map<ShellTab, boolean>();
  const exists = (tab: ShellTab): boolean => available.get(tab) ?? true;
  let shown: ShellTab | null = null;

  /** The tab that is shown for `wanted`: the overview while its module's tab does not exist. */
  const effective = (wanted: ShellTab): ShellTab => (exists(wanted) ? wanted : "overview");

  function show(wanted: ShellTab): void {
    const tab = effective(wanted);
    const previous = shown;
    shown = tab;
    for (const t of SHELL_TABS) {
      panels.get(t)!.hidden = t !== tab;
      const a = links.get(t)!;
      a.className = t === tab ? "on" : "";
      if (t === tab) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    document.title = TAB_TITLES[tab];
    document.body.setAttribute("data-tab-shown", tab);
    if (previous !== tab) opts.onShow?.(tab, previous);
  }

  function open(tab: ShellTab): void {
    const t = effective(tab);
    if (t !== tabOf(location)) history.pushState(null, "", urlWithTab(location.href, t));
    show(t);
  }

  for (const [t, a] of links) {
    a.href = `?tab=${t}`;
    a.addEventListener("click", (event) => {
      // A click that opens a new tab or window (a modifier, the middle button) keeps the link's own behaviour.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      open(t);
    });
  }
  addEventListener("popstate", () => show(tabOf(location)));
  addEventListener("hashchange", () => {
    // An explorer route followed from another tab (a link, the address bar) opens the Token Indexer tab.
    if (shown !== "tokens" && exists("tokens") && isExplorerRoute(location.hash)) {
      history.replaceState(null, "", urlWithTab(location.href, "tokens"));
      show("tokens");
    }
  });
  show(tabOf(location));

  return {
    current: () => shown ?? "overview",
    open,
    setAvailable(tab: ModuleTab, on: boolean): void {
      if (on === exists(tab)) return;
      available.set(tab, on);
      links.get(tab)!.hidden = !on;
      // The tab went away while shown (or named by the URL): the overview, written into the URL.
      if (!on && (shown === tab || tabOf(location) === tab)) {
        history.replaceState(null, "", urlWithTab(location.href, "overview"));
        show("overview");
      }
    },
  };
}
