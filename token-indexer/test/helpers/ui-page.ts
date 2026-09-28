import vm from "node:vm";
import { DASHBOARD_HTML } from "../../ui/page.js";

/**
 * A browser just large enough for the explorer page (spec 00024 US6; `[[token-ui-origin]]`,
 * `[[token-ui-hostile-values]]`). The page's behaviour lives in ONE inline script that builds its
 * views with `createElement`, `appendChild` and `textContent` only (it assigns no markup), so a
 * small document is enough to run the SAME string the page serves — read off `DASHBOARD_HTML`,
 * not imported from anywhere else — in a `node:vm` context.
 *
 * What the page does in a browser, this harness does too (audit 03-E1a finding F15: the first
 * harness discarded every listener, so boot, navigation, copying and scrolling never ran):
 *  - element and window listeners are KEPT; a click bubbles to the parents until a handler stops it;
 *  - `window.location.hash` is a route: {@link Page.navigate} sets it and fires `hashchange`;
 *  - `fetch` answers from a route table ({@link Page.routes}) and records every request;
 *  - `navigator.clipboard.writeText` records what was copied;
 *  - `document.getElementById` finds an element only in the document (null otherwise, as a browser
 *    does), with the static chrome of the page's markup (`BODY` ids) present from the start;
 *  - `scrollIntoView` records that it was called.
 */

export const SERVED_SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(DASHBOARD_HTML)?.[1] ?? "";

// The ids of the page's static markup (BODY in ui/page.ts): present before the script runs.
const CHROME_IDS = [
  "poc", "poc-hide", "poc-show", "now", "toggle", "banner", "filters", "q", "f-kind", "f-storage", "f-status",
  "f-mip", "clear", "count", "view", "strip", "nav-list", "nav-offers", "nav-status", "icon-link",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface FakeEvent {
  type: string; key?: string; stopped: boolean; defaultPrevented: boolean;
  stopPropagation(): void; preventDefault(): void;
}
export function fakeEvent(type: string, extra: Record<string, unknown> = {}): FakeEvent {
  const ev: FakeEvent = {
    type, stopped: false, defaultPrevented: false,
    stopPropagation() { ev.stopped = true; },
    preventDefault() { ev.defaultPrevented = true; },
    ...extra,
  };
  return ev;
}

type Listener = (ev: FakeEvent) => unknown;

export class FakeElement {
  nodeType = 1;
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  className = "";
  id = "";
  title = "";
  href = "";
  target = "";
  rel = "";
  value = "";
  hidden = false;
  disabled = false;
  scrolled = 0;
  private text = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [prop: string]: any;
  constructor(public tagName: string) {}
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(""); }
  set textContent(v: string) { for (const c of this.children) c.parentNode = null; this.children = []; this.text = String(v); }
  get firstChild(): FakeElement | null { return this.children[0] ?? null; }
  appendChild(child: FakeElement): FakeElement {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeElement): FakeElement {
    this.children = this.children.filter((c) => c !== child);
    child.parentNode = null;
    return child;
  }
  addEventListener(type: string, fn: Listener): void { (this.listeners[type] ??= []).push(fn); }
  setAttribute(k: string, v: string): void { this.attrs[k] = String(v); }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  scrollIntoView(): void { this.scrolled += 1; }
  select(): void { /* the copy fallback selects its buffer */ }
  /** A click as a browser delivers it: on the element, then each parent, until one stops it; then,
   *  unless a handler prevented it, the default action of the nearest link — a "#…" href navigates
   *  this page (the owning document's navigate hook), any other href is recorded as opened. */
  click(): FakeEvent {
    const ev = fakeEvent("click");
    for (let n: FakeElement | null = this; n !== null && !ev.stopped; n = n.parentNode) {
      for (const fn of n.listeners.click ?? []) fn.call(n, ev);
    }
    if (!ev.defaultPrevented) {
      let a: FakeElement | null = this;
      while (a !== null && !(a.tagName === "a" && a.href !== "")) a = a.parentNode;
      if (a !== null) {
        const doc = a.ownerDocument as FakeDocument | undefined;
        if (a.href.startsWith("#")) doc?.navigateHook?.(a.href);
        else doc?.opened.push(a.href);
      }
    }
    return ev;
  }
  *walk(): Generator<FakeElement> { yield this; for (const c of this.children) yield* c.walk(); }
}

export class FakeDocument {
  body = new FakeElement("body");
  copiedByCommand: string[] = [];
  /** Links followed to another document (not a "#…" route of this page). */
  opened: string[] = [];
  /** Set by {@link loadPage}: what following a "#…" link does. */
  navigateHook: ((hash: string) => void) | null = null;
  constructor() {
    this.body.ownerDocument = this;
    for (const id of CHROME_IDS) {
      const e = new FakeElement(id === "view" ? "main" : "div");
      e.id = id;
      this.body.appendChild(e);
    }
  }
  createElement(tag: string): FakeElement {
    const e = new FakeElement(tag.toLowerCase());
    e.ownerDocument = this;
    return e;
  }
  getElementById(id: string): FakeElement | null {
    for (const e of this.body.walk()) if (e.id === id) return e;
    return null;
  }
  execCommand(cmd: string): boolean {
    const buf = [...this.body.walk()].find((e) => e.tagName === "textarea");
    if (cmd === "copy" && buf) this.copiedByCommand.push(buf.value);
    return cmd === "copy";
  }
}

/** A non-200 answer of the fake API. */
export class Reply { constructor(public status: number, public body?: Json) {} }
/** A route of the fake API: a payload (answered 200), or a {@link Reply}. */
export type Route = Json | Reply;
export interface Page {
  ctx: Json;
  doc: FakeDocument;
  /** Every path the page fetched, in order. */
  requests: string[];
  /** Everything written to the clipboard. */
  copied: string[];
  /** The fake API: path (with its query) → payload. An unknown path answers 404. */
  routes: Map<string, Route>;
  window: Json;
  /** Sets `location.hash` and fires `hashchange`, as following a link does. */
  navigate(hash: string): void;
  /** Runs the DOMContentLoaded listeners (the page's boot). */
  boot(): void;
  /** Lets every pending fetch and render settle. */
  settle(): Promise<void>;
}

export function loadPage(script = SERVED_SCRIPT, routes: Map<string, Route> = new Map()): Page {
  const doc = new FakeDocument();
  const requests: string[] = [];
  const copied: string[] = [];
  const winListeners: Record<string, Listener[]> = {};
  const location = { hash: "" };
  const win = {
    addEventListener(type: string, fn: Listener) { (winListeners[type] ??= []).push(fn); },
    location,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    innerWidth: 1280, innerHeight: 800,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  const fetchStub = async (path: string): Promise<Json> => {
    requests.push(path);
    const route = routes.has(path) ? routes.get(path) : new Reply(404, { error: { code: "NOT_FOUND" } });
    const status = route instanceof Reply ? route.status : 200;
    const body = route instanceof Reply ? route.body : route;
    const text = body === undefined ? "" : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text };
  };
  const ctx = vm.createContext({
    window: win,
    document: doc,
    navigator: { clipboard: { writeText: async (v: string) => { copied.push(v); } } },
    fetch: fetchStub,
    TextDecoder,
  });
  vm.runInContext(script, ctx, { filename: "served-page-script.js" });
  const fire = (type: string): void => { for (const fn of winListeners[type] ?? []) fn(fakeEvent(type)); };
  doc.navigateHook = (hash: string) => { location.hash = hash; fire("hashchange"); };
  return {
    ctx, doc, requests, copied, routes, window: win,
    navigate(hash: string) { location.hash = hash; fire("hashchange"); },
    boot() { fire("DOMContentLoaded"); },
    async settle() { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); },
  };
}

/** Every element under `root` that carries the page's value mark `data-o`. */
export function marksOf(root: FakeElement): Map<string, FakeElement[]> {
  const drawn = new Map<string, FakeElement[]>();
  for (const e of root.walk()) {
    const f = e.getAttribute("data-o");
    if (f !== null) drawn.set(f, [...(drawn.get(f) ?? []), e]);
  }
  return drawn;
}

/** The nearest ancestor-or-self of `e` that carries a `data-o` mark, or null. */
export function markedAncestor(e: FakeElement): FakeElement | null {
  for (let n: FakeElement | null = e; n !== null; n = n.parentNode) if (n.getAttribute("data-o") !== null) return n;
  return null;
}
