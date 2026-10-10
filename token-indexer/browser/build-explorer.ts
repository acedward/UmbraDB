/**
 * The main page of the static build (`index.html`) carries the explorer that `GET /ui` serves
 * (`token-indexer/mip0018/ui/`) in its Token Indexer tab, so both show the same explorer (Node tooling: a Vite plugin).
 *
 * - The markup: `index.html` holds the marker `<!-- umbradb-explorer-markup -->` where the explorer's markup
 *   (`UI_BODY` of `ui/page.ts`: header, banner, view, footer) is written, in the build and on the dev server, and the
 *   marker `<!-- umbradb-logo -->` where the Midnight wordmark of the explorer's header (`LOGO`) is written, for the
 *   page's own header.
 * - The font: `ui/page.css` names the brand font by the path `GET /ui` serves it at (`/ui/outfit.woff2`); for the static
 *   build that reference becomes the font file itself, which the bundler then emits beside the pages with a relative
 *   URL (so the site also works under a sub-path). The build fails if `page.css` no longer has that reference.
 *
 * - The dev server: the pages link the explorer's shared files as `../mip0018/ui/…` (the style, the icon). The dev
 *   server's root is this directory, so those links arrive as `/mip0018/ui/…`, a path under the root that does not
 *   exist (the server would answer it with a page); the plugin maps that prefix to the files themselves through Vite's
 *   `/@fs/`, so the dev server serves the same style, through the same transforms (the font above), as the build.
 *
 * The script (`ui/page.js`) and the style need nothing else: `explorer-page.ts` imports the script and `index.html`
 * links the style, and the build's security plugin (`build-csp.ts`) gives the page its policy like every other page.
 */
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { LOGO, UI_BODY } from "../mip0018/ui/page.ts";

export const EXPLORER_MARKER = "<!-- umbradb-explorer-markup -->";
export const LOGO_MARKER = "<!-- umbradb-logo -->";

/** `html` with the one `marker` it holds replaced by `markup` (unchanged when it holds none; refused when it holds two). */
function replaceOnce(html: string, marker: string, markup: string): string {
  const at = html.indexOf(marker);
  if (at < 0) return html;
  if (html.indexOf(marker, at + 1) >= 0) throw new Error(`a page holds ${marker} more than once`);
  return html.slice(0, at) + markup + html.slice(at + marker.length);
}
/** The font reference of `ui/page.css` (the path `GET /ui` serves the font at). */
export const SERVED_FONT_URL = 'url("/ui/outfit.woff2")';
/** The same font as a file next to `ui/page.css`. */
export const FONT_FILE_URL = 'url("./fonts/Outfit-Variable-latin.woff2")';

/** Where the pages' `../mip0018/ui/` links arrive on the dev server, and the directory they name. */
export const DEV_UI_PREFIX = "/mip0018/ui/";
const UI_DIR = fileURLToPath(new URL("../mip0018/ui/", import.meta.url)).split("\\").join("/");

const isPageCss = (id: string): boolean => id.split("?")[0]!.split("\\").join("/").endsWith("/token-indexer/mip0018/ui/page.css");

export function explorerPage(): Plugin {
  return {
    name: "umbradb-explorer-page",
    enforce: "pre",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return replaceOnce(replaceOnce(html, EXPLORER_MARKER, UI_BODY), LOGO_MARKER, LOGO);
      },
    },
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url?.startsWith(DEV_UI_PREFIX) === true) req.url = `/@fs/${UI_DIR.replace(/^\//, "")}${req.url.slice(DEV_UI_PREFIX.length)}`;
        next();
      });
    },
    transform(code, id) {
      if (!isPageCss(id)) return null;
      if (!code.includes(SERVED_FONT_URL)) throw new Error(`ui/page.css no longer references the font as ${SERVED_FONT_URL}`);
      return { code: code.split(SERVED_FONT_URL).join(FONT_FILE_URL), map: null };
    },
  };
}
