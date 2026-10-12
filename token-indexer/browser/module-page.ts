/**
 * The page of a module's tab in the static build's main page (`index.html`), with the structure and the look of the
 * token explorer's page (`../mip0018/ui/page.ts` `UI_BODY`, styled by `../mip0018/ui/page.css` and `explorer.css`), so
 * every module's tab reads the same:
 *
 * - a `header`: the brand (the wordmark and its rule, which a tab hides as it hides the explorer's, the module's title
 *   as `h1` and its subtitle as `.sub`), then `nav.tabs`: the page's own sub-tabs (links), a `.sep`, the `.strip` of
 *   live figures and the refresh button;
 * - the `.banner` (`role="alert"`, hidden while there is nothing to say);
 * - the `main` view (`aria-live="polite"`);
 * - the `footer.foot` note.
 *
 * The ids of the page's elements start with the module's prefix (the explorer's own ids stay its own). Every text the
 * page shows is set as text (`textContent` or `visible-text.ts`), never parsed as markup.
 */
import { dataNode } from "./visible-text.ts";

export interface ModulePageOptions {
  /** The tab's panel: the page's elements are appended to it. */
  parent: HTMLElement;
  /** The start of the ids of the page's elements (`<prefix>-nav-<view>`, `<prefix>-strip`, `<prefix>-now`, …). */
  idPrefix: string;
  title: string;
  subtitle: string;
  /** The page's sub-tabs: each a link to `href`. */
  views: ReadonlyArray<{ id: string; label: string; href: string }>;
  /** The footer note. */
  footer: string;
  /** A sub-tab was picked (a plain click; a click that opens a new tab or window keeps the link's own behaviour). */
  onView(view: string): void;
  /** The refresh button was used. */
  onRefresh(): void;
}

export interface ModulePage {
  readonly header: HTMLElement;
  readonly strip: HTMLElement;
  readonly refresh: HTMLButtonElement;
  readonly banner: HTMLElement;
  readonly main: HTMLElement;
  readonly footer: HTMLElement;
  /** Marks `view`'s sub-tab as the one shown (its link `on`, `aria-current`). */
  setView(view: string): void;
  /** Sets each sub-tab's link. */
  setHrefs(href: (view: string) => string): void;
  /** Shows the strip's figures (`label <b>value</b>`, separated as the explorer's), or a warning in its place. */
  setStrip(parts: ReadonlyArray<{ label: string; value: string }>, warning?: string): void;
  /** Shows `lines` in the banner (each as data), or hides it (none). */
  setBanner(lines: readonly string[]): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function mountModulePage(opts: ModulePageOptions): ModulePage {
  const header = el("header");
  const brand = header.appendChild(el("div", "brand"));
  // The wordmark of the page's own header, as the explorer's header carries it (both hidden inside a tab).
  const logo = document.querySelector("header.product .brand svg");
  if (logo !== null) brand.append(logo.cloneNode(true));
  brand.append(el("span", "rule"), el("h1", undefined, opts.title), el("span", "sub", opts.subtitle));
  const nav = header.appendChild(el("nav", "tabs"));
  nav.setAttribute("aria-label", `${opts.title} views`);
  const links = new Map<string, HTMLAnchorElement>();
  for (const v of opts.views) {
    const a = el("a", undefined, v.label);
    a.id = `${opts.idPrefix}-nav-${v.id}`;
    a.href = v.href;
    a.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      opts.onView(v.id);
    });
    links.set(v.id, a);
    nav.append(a);
  }
  nav.append(el("span", "sep"));
  const strip = nav.appendChild(el("span", "strip"));
  strip.id = `${opts.idPrefix}-strip`;
  const refresh = nav.appendChild(el("button", "now", "refresh"));
  refresh.id = `${opts.idPrefix}-now`;
  refresh.type = "button";
  refresh.addEventListener("click", () => opts.onRefresh());

  const banner = el("div", "banner");
  banner.id = `${opts.idPrefix}-banner`;
  banner.setAttribute("role", "alert");
  banner.hidden = true;
  const main = el("main");
  main.id = `${opts.idPrefix}-view`;
  main.setAttribute("aria-live", "polite");
  const footer = el("footer", "foot", opts.footer);
  opts.parent.append(header, banner, main, footer);

  return {
    header,
    strip,
    refresh,
    banner,
    main,
    footer,
    setView(view: string): void {
      for (const [id, a] of links) {
        a.className = id === view ? "on" : "";
        if (id === view) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
      }
    },
    setHrefs(href: (view: string) => string): void {
      for (const [id, a] of links) a.href = href(id);
    },
    setStrip(parts, warning): void {
      const nodes: Node[] = [];
      parts.forEach((p, i) => {
        if (i > 0) nodes.push(document.createTextNode("  ·  "));
        nodes.push(document.createTextNode(`${p.label} `), el("b", undefined, p.value));
      });
      if (warning !== undefined) {
        if (nodes.length > 0) nodes.push(document.createTextNode("  ·  "));
        const w = el("span", "stale");
        w.append(dataNode(document, warning));
        nodes.push(w);
      }
      strip.replaceChildren(...nodes);
    },
    setBanner(lines: readonly string[]): void {
      banner.hidden = lines.length === 0;
      banner.replaceChildren(
        ...lines.map((line) => {
          const d = el("div");
          d.append(dataNode(document, line));
          return d;
        }),
      );
    },
  };
}
