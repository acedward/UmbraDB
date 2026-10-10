/**
 * Text a browser page of the static build draws from data it did not write (log lines, error messages, URLs, names),
 * with the explorer's hidden-character rules (`../mip0018/ui/page.js`, "Text: visible marks for hidden characters"):
 * every character that a browser may draw as nothing or let change the text around it is drawn as a visible mark
 * `⟨U+XXXX⟩` instead, decided by Unicode property — every control (`Cc`), format character (`Cf`: bidi embeddings,
 * overrides, isolates and marks, zero-width characters, tag characters, …), private-use (`Co`), unassigned (`Cn`) and
 * surrogate (`Cs`) code point, line and paragraph separator (`Zl`, `Zp`) and every `Default_Ignorable_Code_Point`.
 * The value is its own bidirectional island (class `d`, `unicode-bidi: isolate` in `ui/page.css`) and each mark a
 * `mark-vis` element, as in the explorer. Everything is a text node: nothing is ever parsed as markup.
 *
 * The explorer's script is a plain script with no exports, so the rule is written here once more, character for
 * character; a test compares the two over every code point.
 */

/** The explorer's rule: a character drawn as a visible mark. */
export const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/** A run of ordinary characters, or the visible mark of one hidden character. */
export interface TextPart {
  mark: boolean;
  text: string;
}

const hex4 = (c: number): string => c.toString(16).toUpperCase().padStart(4, "0");

/** The visible mark of a code point: `⟨U+202E⟩`. */
export const markOf = (codePoint: number): string => `⟨U+${hex4(codePoint)}⟩`;

/** `text` split into ordinary runs and visible marks (a lone surrogate is a code point of its own, `Cs`). */
export function visibleParts(text: string): TextPart[] {
  const out: TextPart[] = [];
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.codePointAt(i)!;
    const w = c > 0xffff ? 2 : 1;
    if (HIDDEN_CHARACTER.test(String.fromCodePoint(c))) {
      if (buf !== "") {
        out.push({ mark: false, text: buf });
        buf = "";
      }
      out.push({ mark: true, text: markOf(c) });
    } else {
      buf += text.substr(i, w);
    }
    i += w - 1;
  }
  if (buf !== "") out.push({ mark: false, text: buf });
  return out;
}

/** `text` with every hidden character replaced by its visible mark (for a tooltip or a plain text node). */
export function visibleText(text: string): string {
  return visibleParts(text).map((p) => p.text).join("");
}

/** The parts of `document` the drawing below uses. */
export interface DocumentLike {
  createElement(tag: "span"): HTMLSpanElement;
  createTextNode(text: string): Text;
}

/** `text` as data: a `span.d` holding its ordinary runs as text nodes and each hidden character as a `span.mark-vis`. */
export function dataNode(doc: DocumentLike, text: string): HTMLSpanElement {
  const span = doc.createElement("span");
  span.className = "d";
  for (const p of visibleParts(text)) {
    if (p.mark) {
      const m = doc.createElement("span");
      m.className = "mark-vis";
      m.textContent = p.text;
      span.appendChild(m);
    } else {
      span.appendChild(doc.createTextNode(p.text));
    }
  }
  return span;
}
