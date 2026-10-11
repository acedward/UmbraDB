/**
 * An explanation shown on demand: a control (a button that reads as underlined text) opens a box with a longer text,
 * by every way a page is used — the mouse resting on it (the box stays while the pointer is on the control or the
 * box), a click or a tap, and the keyboard (Enter or Space on the focused control). A click, a tap or Enter on an open
 * box's control closes it; so do Escape and a click anywhere else. The control says whether the box is open
 * (`aria-expanded`) and which box it opens (`aria-controls`).
 *
 * One box can serve several controls (the Database tab's cut cells), each with its own text; the box shows the text of
 * the control that opened it. A page that redraws its figures calls {@link Explanation.refresh}: the box's text is
 * updated in place when it changed, the box and its control stay (an open box does not close, and no node is recreated
 * but the text's own); a box that serves one control keeps its text current while closed too.
 *
 * The text is drawn with the explorer's hidden-character rules (`visible-text.ts`), as text nodes; nothing is parsed as
 * markup, no `style` attribute is set, and no native `title` is used (it opens only after a still hover, never on a
 * click, a tap or the keyboard, and some embedded browsers never show it).
 */
import { dataNode } from "./visible-text.ts";

export interface Explanation {
  /** The box (append it where the explanation belongs). */
  readonly box: HTMLElement;
  /** Makes `control` open the box with the text `text()` returns (read when it opens and at each refresh). */
  attach(control: HTMLButtonElement, text: () => string): void;
  /** Redraws the open box's text when its control's text has changed; the box stays as it is, open or closed. */
  refresh(): void;
  /** The control whose text the box shows, or `null` while it is closed. */
  openedBy(): HTMLButtonElement | null;
  /** Closes the box. */
  close(): void;
  /** Closes the box and forgets every control (their page was redrawn). */
  clear(): void;
}

/** How long the box waits, after the pointer leaves the control and the box, before it closes (time to reach it). */
const LEAVE_MS = 200;

/** A button that reads as text with a dotted underline (the look of an explanation on demand). */
export function explainControl(field?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "explain-control";
  if (field !== undefined) b.setAttribute("data-field", field);
  b.setAttribute("aria-expanded", "false");
  return b;
}

/** A box `id` (unique in the document) for explanations; hidden until a control opens it. */
export function explanation(id: string, field?: string): Explanation {
  const box = document.createElement("div");
  box.className = "explain-box";
  box.id = id;
  box.hidden = true;
  if (field !== undefined) box.setAttribute("data-field", field);
  const texts = new Map<HTMLButtonElement, () => string>();
  /** The control the box shows, and how it was opened: the pointer resting on it, or a click, a tap or a key. */
  let current: HTMLButtonElement | null = null;
  let via: "hover" | "press" | null = null;
  let shown: string | null = null;
  /** A control closed by a press while the pointer is on it: the pointer does not open it again until it leaves. */
  let quiet: HTMLButtonElement | null = null;
  /** The control the mouse pointer is on. */
  let under: HTMLButtonElement | null = null;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;

  /** The box's text: the open control's, or, closed, the one control's when it serves only one (kept current, so it
   *  opens with its latest text). */
  const draw = (): void => {
    const of = current ?? (texts.size === 1 ? [...texts.keys()][0]! : null);
    if (of === null) return;
    const text = texts.get(of)?.() ?? "";
    if (text === shown) return;
    shown = text;
    box.replaceChildren(dataNode(document, text));
  };
  const cancelLeave = (): void => {
    if (leaveTimer !== undefined) clearTimeout(leaveTimer);
    leaveTimer = undefined;
  };
  const open = (control: HTMLButtonElement, how: "hover" | "press"): void => {
    cancelLeave();
    if (current !== null && current !== control) current.setAttribute("aria-expanded", "false");
    if (current !== control && texts.size > 1) shown = null;
    current = control;
    via = how;
    draw();
    box.hidden = false;
    control.setAttribute("aria-expanded", "true");
  };
  const close = (): void => {
    cancelLeave();
    current?.setAttribute("aria-expanded", "false");
    current = null;
    via = null;
    box.hidden = true;
  };
  const isMouse = (e: PointerEvent): boolean => e.pointerType === "mouse";

  box.addEventListener("pointerenter", (e) => {
    if (isMouse(e)) cancelLeave();
  });
  box.addEventListener("pointerleave", (e) => {
    if (isMouse(e) && via === "hover") leaveTimer = setTimeout(close, LEAVE_MS);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && current !== null) {
      const c = current;
      close();
      if (document.activeElement === document.body || box.contains(document.activeElement)) c.focus();
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (current === null || !(e.target instanceof Node)) return;
    if (box.contains(e.target) || [...texts.keys()].some((c) => c.contains(e.target as Node))) return;
    close();
  });

  return {
    box,
    attach(control: HTMLButtonElement, text: () => string): void {
      texts.set(control, text);
      control.setAttribute("aria-controls", box.id);
      control.addEventListener("pointerenter", (e) => {
        if (!isMouse(e)) return;
        under = control;
        if (quiet === control) return;
        if (current === control) cancelLeave();
        else if (via !== "press") open(control, "hover");
      });
      control.addEventListener("pointerleave", (e) => {
        if (!isMouse(e)) return;
        if (under === control) under = null;
        if (quiet === control) quiet = null;
        if (current === control && via === "hover") leaveTimer = setTimeout(close, LEAVE_MS);
      });
      // A click, a tap, Enter and Space: a box the pointer opened is kept open; an open one is closed.
      control.addEventListener("click", () => {
        if (current === control && via === "hover") {
          via = "press";
          cancelLeave();
          return;
        }
        if (current === control) {
          close();
          quiet = under === control ? control : null;
          return;
        }
        open(control, "press");
      });
    },
    refresh: draw,
    openedBy: () => current,
    close,
    clear(): void {
      close();
      texts.clear();
      quiet = null;
      under = null;
      shown = null;
    },
  };
}
