# The MIP-0018 token explorer page

One document at `GET /ui`, served by the token indexer's own process (`serve()` in `../serve-cli.ts` passes `serveUi`
to the API server as its `ui` hook), reading **only** the read-only JSON API of the same origin (`../../API.md`). No
database access, no other origin, no URI ever fetched.

| File | Role |
|---|---|
| `page.ts` | Builds the document, its Content-Security-Policy and the static routes (`serveUi`); exports the page's markup (`UI_BODY`), from which the static browser build makes its explorer page |
| `page.js` | The page script — a plain JavaScript file, inlined at start-up (never a TypeScript template literal) |
| `page.css` | The look |
| `fonts/Outfit-Variable-latin.woff2`, `fonts/OFL.txt` | The Midnight brand face Outfit (SIL OFL 1.1; see `NOTICE`), served at `/ui/outfit.woff2` |
| `favicon.ico` | The Midnight mark, served at `/ui/favicon.ico` and `/favicon.ico` |

The font, its licence and the icon are byte-identical copies of the explorer in acedward/UmbraDB PR #19
(`feat/00020-token-indexer @ 11af38e`, `token-indexer/ui/`); font SHA-256
`92684e4acde79ef07758cd09380b7e01e9824d8b061eddeda046f78c166d7b12`, icon
`b41509ad57381debefaba6fb3e2e478c1e38ea8afc5e6f11ecd1aeaba4e14c45`.

The static browser build (`../../browser/`, `index.html`) serves the same explorer from static files, in the Token
Indexer tab of its main page: the same script, style and markup, with the API answered by the engine in a worker. The
script's one API function, `api(path)`, sends a same-origin `fetch` here; there the build installs
`window.umbradbExplorerHost` before the script runs, and `api` asks it instead: its answer is a fetch `Response`, read
the same way (the 8 MiB cap, the same errors). With that host the script also states the first indexed height next to
every list ("history before block H is not indexed"), since that index may start mid-chain, and skips its periodic
refresh while the host says the explorer is not shown (its tab is hidden). Here there is no host: nothing changes on
`GET /ui`. See `../../browser/README.md` (Main page).

## Look

The Midnight style (the look of the explorer in acedward/UmbraDB PR #19): Outfit, a white surface with black type and
one blue (`#0000fe`), the header with the Midnight wordmark, a rule and the title, tab navigation and a status strip;
grey panel sections with small dim headings; tables with hover rows (NIGHT/DUST rows tinted); kind chips (shielded
purple, unshielded blue, ledger teal dashed, seen violet dashed); hex shortened head…tail, whole in the tooltip,
copied on click; monospaced heights, amounts and hex. The page has no origins model, no URI links or resolver, no
external links and no wall-clock time.

## Routes

| Hash | View | API reads |
|---|---|---|
| `#/` | token list: NIGHT, DUST, every minted or described identity, seen colors | `/v1/tokens` (pages of 100, "load more") |
| `#/token/<contract>/<domainSep>/<kind>` | one identity: heading, identity, common fields, current fields, symbol group, mark, activity, the contract's events | `/v1/identities/…`, `/v1/tokens/{color}/activity` or `/v1/contracts/{address}/activity`, `/v1/events?contract=` |
| `#/color/<color>` | a color: NIGHT (built-in), a minted color's identities and related kind-3, or a seen color; activity | `/v1/tokens/{color}`, `/v1/tokens/{color}/activity` |
| `#/builtin/DUST` | DUST (no color) | `/v1/tokens?limit=2` |
| `#/contract/<address>` | identities, symbol groups, activity, events | `/v1/contracts/{address}/tokens`, `/v1/contracts/{address}/activity`, `/v1/events?contract=` |
| `#/tx/<hash>` | the MIP-0018 events of a transaction | `/v1/events?tx=` |
| `#/status` | the API's status | `/v1/status` (also read on every refresh for the strip) |

A 404 from an activity endpoint is drawn as "activity is not served by this API". The page refreshes the current view
every 10 s (`/ui?refresh=<ms>`, 500 – 3 600 000), skips a tick while the previous read of the same view runs, and
drops a read that finishes after the route moved.

## Safety (MIP-0018 Security considerations: untrusted input, off-chain content, self-declared standards)

- **Text only.** Every value reaches the document as a text node or a DOM property (`textContent`, `title`); the
  script has no markup sink. The CSP also requires Trusted Types with no policy, so an `innerHTML`-class sink would
  throw in the browser.
- **Visible marks.** Characters that change the layout of the text around them or cannot be seen are drawn as
  `⟨U+XXXX⟩`, decided by Unicode property, not by a list: every control (`Cc`: C0 incl. NUL, tab,
  newline, ESC; DEL; C1), format character (`Cf`: bidi embeddings/overrides/isolates and marks, zero-width
  characters, Arabic number signs U+0600–U+0605, shorthand format controls U+1BCA0–U+1BCA3, tag characters, …),
  private-use (`Co`), unassigned (`Cn`) and surrogate (`Cs`) code point, line/paragraph separator (`Zl`, `Zp`), and
  every `Default_Ignorable_Code_Point` (variation selectors incl. Mongolian U+180B–U+180F, Hangul fillers, combining
  grapheme joiner, soft hyphen, …) — `/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u`
  in the browser's own Unicode data. Every published value is its own bidi island (`unicode-bidi: isolate`).
- **Budgets.** A response is read up to 8 MiB; 48 drawn characters per table cell, 160 in a heading, 600 per field
  value ("show all" on request), 400 per tooltip, 500 fields per identity (read in the API's keyset pages of 100 with
  "load more fields"; the identity's `fieldCount` is shown), 20 rejection reasons per tooltip; lists of 100 rows per
  page, "load more" up to 50 pages; a group shows the API's first 100 members and its member count; the contract view
  merges the groups of the token pages it read.
- **No fetch, no link from data.** A URI value (type 4) is text, labelled as never fetched; the only links are the
  page's own hash routes, built from validated 32-byte hex. Nothing is loaded from any other origin
  (`default-src 'none'`, `connect-src 'self'`, `img-src 'self'`, `font-src 'self'`).
- **No fallback.** A common field whose current value is unusable is drawn as "unusable — no value shown"; an absent
  one as "not set" (no default decimals); `decimals` and amounts in display units come from the API.
- **Claims, not curation.** Names and symbols are shown with the contract they belong to; `standards` tags are
  marked self-declared.
- **Heights only.** The script reads no clock.

CSP of `/ui`: `default-src 'none'; script-src 'sha256-…'; style-src 'sha256-…'; connect-src 'self'; img-src 'self';
font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';
require-trusted-types-for 'script'; trusted-types 'none'` — the two hashes are computed from the bytes served.

## Tests

- `token-indexer/test/mip0018-ui-page.test.ts` — `[[mip0018.ui.page-guard]]` (the served document parses, its CSP
  hashes are its blocks' bytes, the script compiles — with a stray-backtick negative control —, pure ASCII, no handler
  or style attribute, no external reference, no markup sink/clock/other network client in the script) and
  `[[mip0018.ui.static-routes]]`. No database, no browser.
- `token-indexer/test/mip0018-ui-browser.test.ts` — a real headless Chromium/Chrome over the DevTools protocol
  (`token-indexer/test/helpers/cdp-browser.ts`, no npm dependency): `[[mip0018.ui.browser-routes]]`,
  `[[mip0018.ui.browser-activity-shape]]`, `[[mip0018.ui.browser-hostile-text]]`, `[[mip0018.ui.browser-withdrawn]]`.
  It needs a browser: `MIP0018_UI_BROWSER` or `CHROME_BIN`, the Chromium of the Playwright image, or Chrome on `PATH`
  (GitHub's ubuntu runners have it). Locally, run the tests in the Playwright image as the host user:

  ```sh
  docker run --rm --user "$(id -u):$(id -g)" --group-add "$(stat -c %g /var/run/docker.sock)" \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD":/work -w /work \
    mcr.microsoft.com/playwright:v1.63.0-noble \
    npx vitest run token-indexer/test/mip0018-ui-browser.test.ts --maxWorkers=2
  ```

  `MIP0018_UI_SCREENSHOTS=<dir>` saves PNGs of the list and some views.
