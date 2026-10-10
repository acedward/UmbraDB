/**
 * The pages refuse to run inside a frame. With the build's headers (`_headers`) a host forbids framing outright
 * (`frame-ancestors 'none'`), but a `<meta>` policy cannot carry `frame-ancestors`: on a host that sends no headers,
 * another site could frame a page and steer clicks onto its controls (reset, a new range). {@link refuseFramed} runs
 * before a page connects to the engine (`connectEngineTabs`, `tabs.ts`): in a frame it replaces the page's content with
 * a notice and throws, so the page's script stops there — it starts no engine worker, joins no tab election and sends
 * nothing to the leader tab.
 */

/** The error a framed page stops with. */
export class FramedPageError extends Error {
  constructor() {
    super("this page does not run inside a frame: open it in its own tab");
    this.name = "FramedPageError";
  }
}

/** The part of a window this module reads. */
export interface WindowLike {
  readonly top: unknown;
  readonly self: unknown;
}

/** Whether `win` is a frame (its top-level window is another one). A window whose top cannot be read counts as framed. */
export function isFramed(win: WindowLike | undefined): boolean {
  if (win === undefined) return false;
  try {
    return win.top !== win.self;
  } catch {
    return true;
  }
}

/** In a frame: the page's content becomes a notice with a link that opens it in its own tab, and {@link FramedPageError}
 *  is thrown. Elsewhere (a top-level page, a worker, Node): nothing. */
export function refuseFramed(
  win: WindowLike | undefined = (globalThis as { window?: WindowLike }).window,
  doc: Document | undefined = (globalThis as { document?: Document }).document,
): void {
  if (!isFramed(win)) return;
  if (doc?.body != null) {
    const notice = doc.createElement("p");
    notice.setAttribute("role", "alert");
    notice.append("This page does not run inside a frame. ");
    const link = doc.createElement("a");
    link.href = doc.location.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open it in its own tab.";
    notice.append(link);
    doc.body.replaceChildren(notice);
  }
  throw new FramedPageError();
}
