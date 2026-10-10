/**
 * The explorer page of the static build (`index.html`), made from the explorer that `GET /ui` serves
 * (`token-indexer/mip0018/ui/`), so both show the same page (Node tooling: a Vite plugin).
 *
 * - The markup: `index.html` holds the marker `<!-- umbradb-explorer-markup -->` where the explorer's markup
 *   (`UI_BODY` of `ui/page.ts`: header, banner, view, footer) is written, in the build and on the dev server.
 * - The font: `ui/page.css` names the brand font by the path `GET /ui` serves it at (`/ui/outfit.woff2`); for the static
 *   build that reference becomes the font file itself, which the bundler then emits beside the pages with a relative
 *   URL (so the site also works under a sub-path). The build fails if `page.css` no longer has that reference.
 *
 * The script (`ui/page.js`) and the style need nothing else: `explorer-page.ts` imports the script and `index.html`
 * links the style, and the build's security plugin (`build-csp.ts`) gives the page its policy like every other page.
 */
import type { Plugin } from "vite";
import { UI_BODY } from "../mip0018/ui/page.ts";

export const EXPLORER_MARKER = "<!-- umbradb-explorer-markup -->";
/** The font reference of `ui/page.css` (the path `GET /ui` serves the font at). */
export const SERVED_FONT_URL = 'url("/ui/outfit.woff2")';
/** The same font as a file next to `ui/page.css`. */
export const FONT_FILE_URL = 'url("./fonts/Outfit-Variable-latin.woff2")';

const isPageCss = (id: string): boolean => id.split("?")[0]!.split("\\").join("/").endsWith("/token-indexer/mip0018/ui/page.css");

export function explorerPage(): Plugin {
  return {
    name: "umbradb-explorer-page",
    enforce: "pre",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const at = html.indexOf(EXPLORER_MARKER);
        if (at < 0) return html;
        if (html.indexOf(EXPLORER_MARKER, at + 1) >= 0) throw new Error(`a page holds ${EXPLORER_MARKER} more than once`);
        return html.slice(0, at) + UI_BODY + html.slice(at + EXPLORER_MARKER.length);
      },
    },
    transform(code, id) {
      if (!isPageCss(id)) return null;
      if (!code.includes(SERVED_FONT_URL)) throw new Error(`ui/page.css no longer references the font as ${SERVED_FONT_URL}`);
      return { code: code.split(SERVED_FONT_URL).join(FONT_FILE_URL), map: null };
    },
  };
}
