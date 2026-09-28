import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The token explorer: one self-contained HTML page, served by the token-indexer API process at
 * `GET /ui` (spec `00020-token-indexer` §8, US4; sub-plan `00020-03` Phase 1).
 *
 * ── Why a string constant and not a file, a template or a bundle ─────────────────────────────
 * The repository's dependency-minimalism rule (`design/design.md` §7) and the owner's decision
 * Q2 ("keep it there for now") both land on the same shape as the 00009 dashboard
 * (`shielded-monitor/api/ui/page.ts`, the precedent this module copies): **no framework, no
 * bundler, no CSS library, no icon font, no web font, no external resource of any kind**, and
 * `package.json` is unchanged by the change that adds it. A string compiled into the module
 * cannot be lost by `tsc`, by an asset-copy script or by `npm pack`.
 *
 * One deliberate exception, for the Midnight brand look: the brand face **Outfit** (SIL OFL,
 * `ui/fonts/OFL.txt`) is vendored beside this module and served by this same process at
 * `GET /ui/outfit.woff2` — same origin, so `font-src 'self'` and still no external resource. The
 * palette and the inline logo come from the Midnight style kit (the 2026 external presentation
 * template, p.28 colours, p.32 logo). If the font file is missing the page falls back to the
 * system sans stack and nothing else changes.
 *
 * The proof-of-concept notice at the top links out to four GitHub pages (MIP-0018 itself, on
 * `main`, this indexer's PR, the example contracts and the deployed token addresses). Those are plain `<a>` navigations a person chooses to follow, not resources the
 * page loads: `default-src 'none'` still stops the page from fetching anything off its origin.
 *
 * ── What it talks to ────────────────────────────────────────────────────────────────────────
 * Only the **relative** routes of spec §5, on its own origin:
 *
 *   GET /v1/tokens?kind&storage&status&q&limit&cursor
 *   GET /v1/colors/:color                              (the list's "API" column links here)
 *   GET /v1/contracts/:address
 *   GET /v1/contracts/:address/events?limit=     (every event; 00024-03 dropped "applied=false")
 *   GET /v1/contracts/:address/tokens/:domainSep/:kind
 *   GET /v1/contracts/:address/tokens/:domainSep/:kind/metadata
 *   GET /v1/contracts/:address/tokens/:domainSep/:kind/mints?limit&cursor
 *   GET /internal/status
 *
 * and, since 00023 (spec `00023-token-transactions` §5, US1/US2/US4/US5/US7):
 *
 *   GET /v1/contracts/:address/tokens/:domainSep/:kind/transactions?role&limit&cursor
 *   GET /v1/colors/:color/transactions?kind&role&limit&cursor   (a colour with no contract yet)
 *   GET /v1/contracts/:address/calls?limit&cursor               (a ledger token's public activity)
 *   GET /v1/transactions/:hash                                  (the whole public decode)
 *   GET /v1/shielded-offers?undisclosed&limit&cursor            (what the ledger does not say)
 *
 * with four hash routes on top of the three it had: `#/tx/<hash>`, `#/shielded-offers` and
 * `#/color/<color>/<kind>` (the page of a colour whose mint predates the archive, US5).
 *
 * and, since 00024-03 (spec `00024` US6, FR-016 — the page shows where every value came from):
 *
 *   GET /v1/contracts/:address/interface              (the contract view's "public interface",
 *                                                      read again only when the contract route's
 *                                                      interface summary changed)
 *
 * and links (raw JSON in a new tab, never read by the page) to the paginated lists a view shows only
 * the start of: GET /v1/contracts/:address/interface/events and GET /v1/contracts/:address/events.
 *
 * with an optional section on the contract and token routes (`#/contract/<address>/interface`,
 * `#/token/…/mints`, …) that an origin's evidence link scrolls to. Every value of the token and
 * contract views carries its origin — "MIP-0018 declaration", "Public interface", "Chain
 * observation", "Derived by this indexer" or "Not available" — with the link to its evidence; the
 * labels come from the API's `origin` fields through one pure view model (`tokenModel`,
 * `contractModel`), which the governed test `[[token-ui-origin]]` evaluates on recorded payloads.
 *
 * A `tokenUri` that points at `localhost:<any port>` is rewritten to this page's own origin
 * before it is rendered (spec §8 and FR-013: the reference Constellations pieces bake
 * `localhost:10020` into their metadata, and the API may well be listening somewhere else), so
 * clicking a piece's URI opens the resolver document `GET /{token-name}/{id}` of *this* process.
 *
 * ── Safety properties this module holds on purpose ──────────────────────────────────────────
 * Every value that reaches the document goes through `textContent`: there is no `innerHTML`
 * assignment anywhere in this file, so nothing a response carries — on a public chain every
 * payload is a stranger's bytes — can become markup. The CSP below is computed from the very
 * bytes that are served, so it admits exactly this page's own script and style and nothing else;
 * `default-src 'none'` means an injected reference to any other origin fetches nothing.
 *
 * ── Layout of this file ─────────────────────────────────────────────────────────────────────
 * `STYLE`, `SCRIPT` and `BODY` are separate constants; the first two are hashed into the CSP.
 * Note for editors: `SCRIPT` is a TypeScript template literal, so it deliberately contains **no
 * backslash escape, no backtick and no `${`** — a `\d` written here would be cooked away into a
 * plain `d` before the browser ever saw it. That is why the code below parses hex, URIs and the
 * hash route by hand instead of with regular expressions.
 */

// ── Style ────────────────────────────────────────────────────────────────────────────────────

const STYLE = `
/* Midnight brand (the 2026 external presentation template, p.28 palette), LIGHT: white surface,
   black type, one blue. Outfit is the brand face and is served by this process from
   /ui/outfit.woff2; hex, heights and amounts stay monospaced because they are data to compare,
   not prose.
   The owner asked for a light page after the live review (plan 00023, Phase E). There is one
   palette and no toggle: the brand colours keep their names, only the ROLES swap, so every rule
   below reads the same as it did on the black page. Every text colour clears WCAG AA on the
   surface it actually sits on (>= 4.5:1 body, >= 3:1 large/bold and control edges) — computed
   from these hex values, not eyeballed; the 60 pairs and their ratios are in the plan's Phase E
   log. */
@font-face {
  font-family: "Outfit"; font-style: normal; font-weight: 100 900; font-display: swap;
  src: url("/ui/outfit.woff2") format("woff2");
}
:root {
  --md-black: #0a0a0a; --md-white: #ffffff; --md-blue: #0000fe; --md-grey: #cccccc;
  --md-grey-light: #e6e6e6; --md-muted: #5f5f5f;
  --bg: var(--md-white); --panel: #f6f6f6; --panel2: #efefef; --line: #dddddd;
  --rule: var(--md-grey);
  --ink: var(--md-black); --dim: var(--md-muted); --accent: var(--md-blue);
  --bad: #b3261e; --bad-bg: #fdecec; --bad-fg: #8c1d18;
  /* A hovered row, a built-in row and an opened detail row each sit one step off the panel they
     are on, exactly as they sat one step darker on the black page. */
  --hover: var(--md-grey-light); --zebra: #ededed; --det: #f1f1f1;
  /* The brand blue as a ground: the notice, and anything the page marks blue. */
  --tint-blue: #e8e8ff; --tint-notice: #ecedff;
  /* A control's edge needs 3:1 against white to be seen at all; --rule is a hairline between
     rows and must not shout. */
  --ctl: #8f8f8f;
  --sans: "Outfit", "Avenir Next", "Century Gothic", ui-sans-serif, system-ui, -apple-system,
    "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
}
/* ── Tag colours: one hue per meaning, stated once ──────────────────────────────────────────
   The owner asked for tags of different colours. A meaning gets a hue and keeps it everywhere it
   appears on the page — a status badge, a family chip, and the direction word of an activity row
   that expresses the same thing. Each hue is a triple: a background at a ~12-15 % tint, a border
   at ~40 %, and the hue's dark shade as the text, which is what makes a small chip legible on a
   white page (every -fg on its own -bg clears 5.4:1). A brand pass replaces this block and
   touches nothing else. */
:root {
  --tag-builtin-bg: #ececec; --tag-builtin-bd: #b4b4b4; --tag-builtin-fg: #2b2b2b;
  --tag-observed-bg: #fdf1d9; --tag-observed-bd: #e0aa4f; --tag-observed-fg: #8a5200;
  --tag-declared-bg: #e7eef5; --tag-declared-bd: #8fb0c8; --tag-declared-fg: #2f4a63;
  --tag-described-bg: #e3f3e8; --tag-described-bd: #7cc192; --tag-described-fg: #1b6b37;
  --tag-seen-bg: #ece9fb; --tag-seen-bd: #a89ae2; --tag-seen-fg: #4527a0;
  --tag-unknown-bg: #f0f0f0; --tag-unknown-bd: #c2c2c2; --tag-unknown-fg: #616161;
  --tag-shielded-bg: #f7ecfd; --tag-shielded-bd: #c79ae8; --tag-shielded-fg: #6b21a8;
  --tag-unshielded-bg: #e6f1fa; --tag-unshielded-bd: #85b6db; --tag-unshielded-fg: #13558c;
  --tag-ledger-bg: #e2f4f3; --tag-ledger-bd: #78c2be; --tag-ledger-fg: #0f6b68;
  --tag-collection-bg: var(--tint-blue); --tag-collection-bd: #9b9bfb;
  --tag-collection-fg: var(--md-blue);
  --tag-dual-bg: #fdeee0; --tag-dual-bd: #e9a870; --tag-dual-fg: #a14400;
  --tag-bad-bg: var(--bad-bg); --tag-bad-bd: #e3a29f; --tag-bad-fg: var(--bad-fg);
  /* One more meaning, one more hue (F1.4): an event that arrived under the SUPERSEDED draft event
     name rather than the standard's. Rose — the only hue left unused by the eleven above, so the
     badge cannot be mistaken for a status, a family or a direction. Text 7.81:1 on its own ground;
     the border's 2.34:1 sits mid-band among the eleven existing tag borders (2.04-2.50:1), which
     is the band this palette already holds a decorative edge to. */
}
* { box-sizing: border-box; }
/* A display rule on an element beats the user agent's [hidden] rule, and the filter bar is a
   flex container that the token/contract/status views hide — so say it once, loudly. */
[hidden] { display: none !important; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 14px/1.55 var(--sans); -webkit-font-smoothing: antialiased;
}
a { color: var(--ink); text-decoration: underline; text-decoration-color: var(--rule);
  text-underline-offset: 3px; }
a:hover { text-decoration-color: var(--accent); }
code { font-family: var(--mono); font-size: 0.92em; }
header { padding: 22px 28px 0; border-bottom: 1px solid var(--rule); }
.brand { display: flex; align-items: center; gap: 14px; color: var(--ink); }
.brand svg { height: 22px; width: auto; display: block; }
.brand .rule { width: 1px; height: 22px; background: var(--rule); }
h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.015em; }
nav.tabs { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 18px 0 0; }
nav.tabs a { padding: 8px 16px; color: var(--dim); text-decoration: none; font-weight: 500;
  border-bottom: 2px solid transparent; margin-bottom: -1px; }
nav.tabs a:hover { color: var(--ink); }
nav.tabs a.on { color: var(--ink); border-bottom-color: var(--accent); }
nav.tabs .sep { flex: 1 1 auto; }
.strip { color: var(--dim); font-size: 12px; white-space: nowrap; }
.strip b { color: var(--ink); font-weight: 600; font-family: var(--mono); font-size: 11.5px; }
/* A strip segment that says the page may be out of date: the relative time past STALE_MS, and a
   chain tip the indexer would not give. Same size as the rest of the strip, the page's red. */
.strip .stale { color: var(--bad); font-weight: 600; }
/* The proof-of-concept notice: the one tinted surface on a white page, in the brand blue's
   lightest tint, so it is read first. Blue rule on the left, as the template marks a callout. */
.poc { margin: 18px 28px 0; padding: 14px 18px 14px 16px; background: var(--tint-notice);
  color: var(--ink); border-left: 4px solid var(--accent); font-size: 13.5px; line-height: 1.6; }
.poc p { margin: 6px 0 0; max-width: 110ch; }
.poc-h { font-weight: 700; font-size: 14px; letter-spacing: 0.01em; color: var(--accent); }
.poc a { color: var(--ink); text-decoration-color: var(--accent); text-decoration-thickness: 2px; }
.poc a:hover { color: var(--accent); }
.poc code { background: rgba(0, 0, 0, 0.07); padding: 0 4px; }
.poc { position: relative; padding-right: 90px; }
.poc-x { position: absolute; top: 10px; right: 12px; padding: 3px 10px; font-size: 11.5px;
  font-weight: 600; letter-spacing: 0.06em; color: var(--ink); border-color: var(--ink);
  background: transparent; }
.poc-x:hover:enabled { background: var(--ink); color: var(--md-white); border-color: var(--ink); }
.poc-links { list-style: none; margin: 10px 0 0; padding: 0; font-weight: 500; display: flex;
  flex-wrap: wrap; gap: 2px 24px; margin-right: -72px; }
.banner { margin: 14px 28px 0; padding: 10px 14px; border: 1px solid var(--bad);
  background: var(--bad-bg); color: var(--bad-fg); font-size: 13px; white-space: pre-wrap; }
.filters { display: flex; gap: 14px; align-items: end; flex-wrap: wrap; padding: 18px 28px 0; }
.filters label { color: var(--dim); font-size: 12px; font-weight: 500; display: flex;
  flex-direction: column; gap: 5px; }
main { padding: 18px 28px 56px; display: grid; gap: 18px; }
section { background: var(--panel); border: 1px solid var(--line); padding: 18px 20px; }
h2 { margin: 0 0 14px; font-size: 13px; font-weight: 500; color: var(--dim); letter-spacing: 0.02em; }
h3 { margin: 0 0 6px; font-size: 20px; font-weight: 700; letter-spacing: -0.012em; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; color: var(--dim); font-weight: 500; font-size: 12px; padding: 6px 10px 8px;
  border-bottom: 1px solid var(--rule); white-space: nowrap; }
td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; white-space: nowrap; }
tr:last-child td { border-bottom: none; }
tbody tr.pick { cursor: pointer; }
tbody tr.pick:hover td { background: var(--hover); }
tr.built td { background: var(--zebra); }
tr.mark td { background: var(--tint-blue); }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 5px 18px; font-size: 13px; }
.kv .k { color: var(--dim); }
.num { text-align: right; font-family: var(--mono); font-size: 12.5px; font-variant-numeric: tabular-nums; }
/* Status, one hue per row source (E2): builtin neutral grey (this indexer's own two rows),
   observed amber (a mint was seen and nothing was said), declared slate (the contract named the
   token), described green (it published the traits too), seen violet (a colour watched moving
   before any contract named it) and unknown a flat light grey. A status is a fact about how much
   the chain has said, so the hue is the reader's index into that. */
.badge { display: inline-block; padding: 1px 9px; font-size: 11.5px; font-weight: 500; border: 1px solid; }
.st-builtin { color: var(--tag-builtin-fg); border-color: var(--tag-builtin-bd); background: var(--tag-builtin-bg); }
.st-observed { color: var(--tag-observed-fg); border-color: var(--tag-observed-bd); background: var(--tag-observed-bg); }
.st-declared { color: var(--tag-declared-fg); border-color: var(--tag-declared-bd); background: var(--tag-declared-bg); }
.st-described { color: var(--tag-described-fg); border-color: var(--tag-described-bd); background: var(--tag-described-bg); }
.st-unknown { color: var(--tag-unknown-fg); border-color: var(--tag-unknown-bd); background: var(--tag-unknown-bg); }
/* The family chip: shielded purple, unshielded blue, ledger teal (dashed, because a ledger token
   is a claim the chain never corroborates), collection the Midnight blue, dual orange. */
.fam { display: inline-block; min-width: 0; padding: 0 7px; margin-right: 6px; font-size: 11px;
  font-weight: 500; border: 1px solid var(--tag-unknown-bd); color: var(--tag-unknown-fg);
  background: var(--tag-unknown-bg); }
.fam-ledger { color: var(--tag-ledger-fg); border-color: var(--tag-ledger-bd);
  background: var(--tag-ledger-bg); border-style: dashed; }
.fam-shielded { color: var(--tag-shielded-fg); border-color: var(--tag-shielded-bd);
  background: var(--tag-shielded-bg); }
.fam-unshielded { color: var(--tag-unshielded-fg); border-color: var(--tag-unshielded-bd);
  background: var(--tag-unshielded-bg); }
.fam-collection { color: var(--tag-collection-fg); border-color: var(--tag-collection-bd);
  background: var(--tag-collection-bg); }
.fam-dual { color: var(--tag-dual-fg); border-color: var(--tag-dual-bd);
  background: var(--tag-dual-bg); }
.multi { display: inline-block; margin-left: 8px; padding: 0 7px; font-family: var(--sans);
  font-size: 11px; font-weight: 500; color: var(--tag-collection-fg);
  background: var(--tag-collection-bg); border: 1px solid var(--accent); cursor: default; }
.multi:focus { outline: 1px solid var(--accent); outline-offset: 1px; }
.tip { position: fixed; z-index: 50; max-width: 380px; padding: 10px 12px; background: var(--md-white);
  border: 1px solid var(--ctl); color: var(--ink); font-size: 12.5px; line-height: 1.6;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18); pointer-events: none; }
.tip .hex, .tip .here { font-family: var(--mono); font-size: 12px; }
.tip .here { color: var(--ink); }
.tip .hex { color: var(--dim); }
td.apicol { text-align: center; }
/* The MIP-0018 column (Phase G): a check mark, or nothing. Centred under its own heading, and the
   mark is sized up a little because an emoji glyph sits smaller than the 13px text beside it. */
td.mipcol { text-align: center; }
.mip { font-size: 14px; line-height: 1; }
.api { display: inline-flex; padding: 3px; color: var(--dim); border: 1px solid transparent; }
.api:hover { color: var(--accent); border-color: var(--accent); background: var(--tint-blue); }
.api svg { display: block; }
.cp { cursor: pointer; text-decoration: underline dotted; text-decoration-color: var(--ctl);
  text-underline-offset: 3px; }
.cp.copied { color: var(--md-white); background: var(--accent); text-decoration: none; }
.cp.copyfail { color: var(--bad); }
.cpbuf { position: fixed; top: -1000px; left: -1000px; opacity: 0; }
.note { color: var(--dim); font-size: 12px; }
.err { color: var(--bad); font-size: 12.5px; }
.empty { color: var(--dim); padding: 12px 2px; font-size: 13px; }
.txt { color: var(--ink); }
/* A projection that Appendix A refused: the trait is real and kept, the column it would feed is
   not written. Shown as a warning, never as an error — the event itself was applied. */
.perr { color: var(--tag-observed-fg); text-decoration: underline wavy var(--tag-observed-bd); }
.vtype { color: var(--dim); font-size: 11.5px; }
.hex { color: var(--dim); font-family: var(--mono); font-size: 12.5px; }
.no { color: var(--dim); }
pre { margin: 0; padding: 12px 14px; background: var(--bg); border: 1px solid var(--line);
  font-family: var(--mono); font-size: 12px; white-space: pre-wrap; word-break: break-word;
  max-height: 420px; overflow: auto; }
button { font: inherit; font-size: 13px; font-weight: 500; padding: 7px 14px; cursor: pointer;
  background: var(--md-white); color: var(--ink); border: 1px solid var(--ctl); }
button:hover:enabled { border-color: var(--ink); }
button:disabled { opacity: 0.4; cursor: default; }
button#now { background: var(--accent); border-color: var(--accent); color: var(--md-white); }
button#now:hover:enabled { background: #0000c4; border-color: #0000c4; }
input, select { font: inherit; font-size: 13.5px; padding: 7px 10px; background: var(--bg);
  color: var(--ink); border: 1px solid var(--ctl); border-radius: 0; }
input::placeholder { color: var(--dim); }
input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.crumb { color: var(--dim); font-size: 13px; margin-bottom: 10px; }
.wrapv { white-space: normal; word-break: break-word; max-width: 46ch; }
/* ── 00023: activity rows, the disclosure panel, the calls note, the transaction view ───────
   A colour seen in public data before any mint named it (status seen, US5) is marked with a
   dashed badge: the row is real, the contract behind it is not known. */
.st-seen { color: var(--tag-seen-fg); border-color: var(--tag-seen-bd); border-style: dashed;
  background: var(--tag-seen-bg); }
.pill { display: inline-block; margin-left: 8px; padding: 0 7px; font-size: 11px; font-weight: 500;
  color: var(--tag-seen-fg); border: 1px dashed var(--tag-seen-bd); background: var(--tag-seen-bg); }
/* What a shielded token discloses, in numbers (US4 as the owner settled it in Q22: the static
   public/private columns are gone — the reader is an advanced user — and only the two live counts
   and their link remain). */
.counts { display: flex; gap: 26px; flex-wrap: wrap; margin-top: 14px; padding-top: 12px;
  border-top: 1px solid var(--line); align-items: baseline; }
.counts b { font-family: var(--mono); font-size: 16px; color: var(--ink); }
.warnnote { margin: 0 0 12px; padding: 11px 14px; border-left: 4px solid var(--accent);
  background: var(--panel2); color: var(--ink); font-size: 13px; line-height: 1.6; }
.warnnote b { color: var(--accent); }
/* "counted" is the ordinary case and stays neutral; "not counted" is the one that changes what a
   reader may conclude, so it takes the page's red (E2). */
.chip { display: inline-block; padding: 0 7px; font-size: 11px; font-weight: 500;
  border: 1px solid var(--tag-unknown-bd); color: var(--tag-unknown-fg);
  background: var(--tag-unknown-bg); }
.chip.nocount { color: var(--tag-bad-fg); border-color: var(--tag-bad-bd);
  background: var(--tag-bad-bg); }
tr.det td { background: var(--det); white-space: normal; }
.det-grid { display: grid; grid-template-columns: max-content 1fr; gap: 5px 18px; font-size: 12.5px;
  margin: 6px 0 4px; }
.det-grid .k { color: var(--dim); }
.amt { font-family: var(--mono); font-variant-numeric: tabular-nums; }
/* The "what happened" word of an activity row carries the hue of the row's DIRECTION, and only as
   text: a whole tinted cell in every row would be a wall of colour, while one coloured word lets a
   reader see at a glance that a list is all inflow or all outflow. The hues are the tag hues of
   the same meanings — value arriving is the green of "described", value leaving the amber of
   "observed", a shielded-pool delta the purple of the shielded chip, a mint the Midnight blue. */
.dir-in { color: var(--tag-described-fg); }
.dir-out { color: var(--tag-observed-fg); }
.dir-pool { color: var(--tag-shielded-fg); }
.dir-mint { color: var(--tag-collection-fg); }
.expand { padding: 1px 9px; font-size: 11.5px; }
.txsec { margin-top: 14px; }
.txsec:first-child { margin-top: 0; }
.txsec > .h { color: var(--dim); font-size: 12px; margin-bottom: 6px; }
/* ── 00024-03: where every value came from (spec 00024 US6) ─────────────────────────────────
   One hue per ORIGIN, stated once here, distinct from every tag hue above, each text colour at
   >= 6:1 on its own ground and on every surface a table cell can have. A label the page gives a
   value the API serves without an origin (question Q28) has a dashed edge, like the other claims
   the page makes on its own. */
:root {
  --or-mip-bg: #eceffc; --or-mip-bd: #9aa6e6; --or-mip-fg: #2a3b8f;
  --or-pi-bg: #fbe9f1; --or-pi-bd: #e29ab9; --or-pi-fg: #8a1c4f;
  --or-chain-bg: #f6f1dc; --or-chain-bd: #cdb86a; --or-chain-fg: #5a4a0f;
  --or-derived-bg: #e2f3f7; --or-derived-bd: #79c0d2; --or-derived-fg: #0f5c6e;
  --or-none-bg: #f4f4f4; --or-none-bd: #b9b9b9; --or-none-fg: #555555;
  /* the interface statuses: verified, waiting (pending, stale), unavailable (unchecked,
     unfetchable, unreachable); failed takes the page's red */
  --if-ok-bg: #e1f4e8; --if-ok-bd: #86c79e; --if-ok-fg: #17593a;
  --if-wait-bg: #fff3d1; --if-wait-bd: #e0b84f; --if-wait-fg: #6e4a00;
  --if-unav-bg: #ececec; --if-unav-bd: #adadad; --if-unav-fg: #4d4d4d;
  --pp-bg: #efebfc; --pp-bd: #a99be3; --pp-fg: #3a2c8c;
}
/* A grid item may not shrink below its content by default, so one wide table (more columns now,
   each value with its label) would widen every section and the page: the items may shrink, and a
   wide table scrolls inside its own .scroll wrapper, as the others always did. */
main > * { min-width: 0; }
.orig { display: inline-block; margin: 1px 0 1px 6px; padding: 0 7px; font-size: 11px; font-weight: 500;
  border: 1px solid; text-decoration: none; white-space: nowrap; }
td > .orig:first-child, .ob .orig { margin-left: 0; }
a.orig:hover { text-decoration: underline; }
.or-mip-0018 { color: var(--or-mip-fg); border-color: var(--or-mip-bd); background: var(--or-mip-bg); }
.or-public-interface { color: var(--or-pi-fg); border-color: var(--or-pi-bd); background: var(--or-pi-bg); }
.or-chain { color: var(--or-chain-fg); border-color: var(--or-chain-bd); background: var(--or-chain-bg); }
.or-derived { color: var(--or-derived-fg); border-color: var(--or-derived-bd); background: var(--or-derived-bg); }
.or-none, .or-unknown { color: var(--or-none-fg); border-color: var(--or-none-bd); background: var(--or-none-bg); }
.or-unknown { color: var(--bad-fg); border-color: var(--bad); }
.or-page { border-style: dashed; }
.p1 { display: inline-block; margin-left: 6px; padding: 0 5px; font-size: 10.5px; font-weight: 700;
  color: var(--md-white); background: var(--or-mip-fg); cursor: help; }
.ob { display: grid; gap: 3px; }
.oev { color: var(--dim); font-size: 11.5px; line-height: 1.5; white-space: normal; word-break: break-word;
  max-width: 72ch; }
.vo { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 2px 0; }
td.k { color: var(--dim); }
td.fv { white-space: normal; word-break: break-word; max-width: 60ch; }
td.ocell { white-space: normal; min-width: 260px; }
tr.hist td { background: var(--det); font-size: 12.5px; }
.ifb.if-ok { color: var(--if-ok-fg); border-color: var(--if-ok-bd); background: var(--if-ok-bg); }
.ifb.if-wait { color: var(--if-wait-fg); border-color: var(--if-wait-bd); background: var(--if-wait-bg); }
.ifb.if-unav { color: var(--if-unav-fg); border-color: var(--if-unav-bd); background: var(--if-unav-bg);
  border-style: dashed; }
.ifb.if-bad, .ifb.if-unknown { color: var(--tag-bad-fg); border-color: var(--tag-bad-bd); background: var(--tag-bad-bg); }
.pp { display: inline-block; margin-left: 6px; padding: 0 6px; font-size: 11px; font-weight: 500;
  color: var(--pp-fg); border: 1px solid var(--pp-bd); background: var(--pp-bg); cursor: default; }
.pp-bad { color: var(--tag-bad-fg); border-color: var(--tag-bad-bd); background: var(--tag-bad-bg); }
/* A diagnostic is served bounded ("… [N characters omitted]") and shown as served: it wraps, it
   never widens the table. A URL of up to 262 112 bytes is shortened for the eye (head … tail) and
   copied whole. */
.diag { white-space: pre-wrap; word-break: break-word; display: inline-block; max-width: 72ch; }
/* 00024-03 (audit 03-E1a F14): every piece of published text is its own bidirectional island, so
   right-to-left text in a name cannot reorder the label or the chip beside it. */
main span, main a, main td, main pre, main h3 { unicode-bidi: isolate; }
.urlv { white-space: normal; word-break: break-all; display: inline-block; max-width: 72ch; }
.cpbtn { font-size: 11.5px; }
`;

// ── Behaviour ────────────────────────────────────────────────────────────────────────────────
//
// Plain ES2017: `var`, function declarations, `async`/`await`, no module syntax, no template
// literal, no regular expression and no backslash (see the file header for why).

const SCRIPT = `
"use strict";

// Every API path this page uses, spelled out as literals so a route-coverage test can read them
// off the served document and check each one against the server's own table:
//   GET /v1/tokens
//   GET /v1/colors/:color
//   GET /v1/contracts/:address
//   GET /v1/contracts/:address/events?limit=                         (every event, 00024-03)
//   GET /v1/contracts/:address/tokens/:domainSep/:kind
//   GET /v1/contracts/:address/tokens/:domainSep/:kind/metadata
//   GET /v1/contracts/:address/tokens/:domainSep/:kind/mints
//   GET /v1/contracts/:address/tokens/:domainSep/:kind/transactions   (00023, FR-006)
//   GET /v1/colors/:color/transactions                                (00023, FR-008)
//   GET /v1/contracts/:address/calls                                  (00023, FR-020)
//   GET /v1/transactions/:hash                                        (00023, FR-007)
//   GET /v1/shielded-offers                                           (00023, FR-018)
//   GET /v1/contracts/:address/interface                              (00024-03, the interface section)
//   GET /internal/status
var P_TOKENS = "/v1/tokens";
var P_COLORS = "/v1/colors";
var P_CONTRACTS = "/v1/contracts";
var P_TXS = "/v1/transactions";
var P_OFFERS = "/v1/shielded-offers";
var P_STATUS = "/internal/status";

var REFRESH_MS = 10000;
var LIST_LIMIT = 200;
// While the MIP-0018 filter is on, the page asks for the API's maximum page (MAX_LIMIT in
// api/server.ts) instead of the usual one: the filter runs over the rows already loaded, so a
// smaller page could hide a token that HAS metadata behind a boundary the reader never sees.
var LIST_LIMIT_FILTERED = 500;
var MINT_LIMIT = 200;
// The mint history is read page by page too (oldest first), up to MINT_PAGES pages; a token with more
// says so beside the table, with its mint count and a link to the whole list (audit 03-E1a R3I).
var MINT_PAGES = 5;
var ACT_LIMIT = 200;
var CALL_LIMIT = 200;
var OFFER_LIMIT = 200;

var state = {
  route: { view: "list" },
  // mip is the one filter applied in the browser rather than by the API: "has metadata published
  // under MIP-0018" is a rule over the row's status, not a column the list route filters on.
  filters: { kind: "", storage: "", status: "", q: "", mip: "" },
  list: { items: [], nextCursor: null, loaded: false },
  detail: null,
  contract: null,
  status: null,
  // 00023: the transactions section's own controls, kept outside "detail" so a 10 s refresh does
  // not throw away a role filter, a loaded page or an opened offer.
  act: { role: "", pages: 1, expand: {} },
  tx: null,
  offers: { items: [], nextCursor: null, loaded: false, undisclosed: "true", pages: 1 },
  scrollTo: null,
  // values drawn whole on the reader's request ("show all"), by their field key (E1a-R3E)
  expandText: {},
  errors: [],
  lastOk: null,
  paused: false,
  timer: null,
  tick: null,
  debounce: null,
  busy: false
};

// ── DOM helpers (textContent only; this file assigns no markup anywhere) ────────────────────

function el(id) { return document.getElementById(id); }
function node(tag, text, cls) {
  var n = document.createElement(tag);
  if (text !== undefined && text !== null) n.textContent = shown(text);
  if (cls) n.className = cls;
  return n;
}
function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
function cell(row, child, cls) {
  var td = document.createElement("td");
  if (cls) td.className = cls;
  if (child === null || child === undefined) td.textContent = "-";
  else if (typeof child === "object" && child.nodeType) td.appendChild(child);
  else td.textContent = shown(child);
  row.appendChild(td);
  return td;
}
// A label is a string, or {label, title} when the column's name needs a tooltip of its own (the
// list's MIP-0018 column: a check mark in a column headed by a number means nothing on its own).
function headRow(table, labels) {
  var thead = document.createElement("thead");
  var tr = document.createElement("tr");
  for (var i = 0; i < labels.length; i++) {
    var spec = labels[i];
    var isPair = spec !== null && typeof spec === "object";
    var th = node("th", isPair ? spec.label : spec);
    if (isPair && spec.title) th.title = spec.title;
    tr.appendChild(th);
  }
  thead.appendChild(tr);
  table.appendChild(thead);
  return thead;
}
function tableIn(parent, labels) {
  var wrap = node("div", null, "scroll");
  var table = document.createElement("table");
  headRow(table, labels);
  var tbody = document.createElement("tbody");
  table.appendChild(tbody);
  wrap.appendChild(table);
  parent.appendChild(wrap);
  return tbody;
}
function enc(v) { return encodeURIComponent(txt(v === null || v === undefined ? "" : v)); }

// ── Values ──────────────────────────────────────────────────────────────────────────────────

function isHex(s) {
  if (typeof s !== "string" || s.length === 0 || s.length % 2 !== 0) return false;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    var ok = (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
    if (!ok) return false;
  }
  return true;
}
function hexBytes(s) {
  var out = [];
  for (var i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.substr(i, 2), 16));
  return out;
}
// A domain separator / key / value is 32 NUL-padded bytes more often than not, and reads far
// better as its text ("cnst:orion") than as 64 hex characters. Printable ASCII only: anything
// else stays hex, so no byte string can pretend to be a name.
function hexText(s) {
  if (!isHex(s)) return null;
  var b = hexBytes(s);
  while (b.length > 0 && b[b.length - 1] === 0) b.pop();
  if (b.length === 0) return null;
  var out = "";
  for (var i = 0; i < b.length; i++) {
    var v = b[i];
    if (v < 32 || v > 126) return null;
    out += String.fromCharCode(v);
  }
  return out;
}
function shortHex(s, head, tail) {
  if (typeof s !== "string" || s.length === 0) return "-";
  if (s.length <= head + tail + 1) return s;
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}
function slug(s) {
  var out = "";
  var low = txt(s === null || s === undefined ? "" : s).toLowerCase();
  for (var i = 0; i < low.length; i++) {
    var c = low.charAt(i);
    var code = low.charCodeAt(i);
    var alnum = (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
    if (alnum) out += c;
    else if (out.length > 0 && out.charAt(out.length - 1) !== "-") out += "-";
  }
  while (out.length > 0 && out.charAt(out.length - 1) === "-") out = out.slice(0, out.length - 1);
  return out;
}
// Every payload value reaches the page as text through txt(): a string as it is, a number or a
// boolean as its digits or word, anything else as its JSON. Never String() or "+" on an object: the
// API passes some bundle fields through as they were published (package.json "compact.language",
// "runtime", "interface", "flags"), and valid JSON such as {"toString": null} makes String() throw
// a TypeError — which stopped the whole view from being drawn (audit 03-E1a finding F3).
function txt(v) {
  if (v === null || v === undefined) return "";
  var t = typeof v;
  if (t === "string") return v;
  if (t === "number" || t === "boolean" || t === "bigint") return "" + v;
  try {
    var j = JSON.stringify(v);
    return typeof j === "string" ? j : "";
  } catch (e) { return "(a value this page cannot show)"; }
}
function orDash(v) { return v === null || v === undefined || v === "" ? "-" : txt(v); }
// Characters that change how the text around them is laid out, or that cannot be seen at all, are
// drawn as a visible mark "⟨U+202E⟩": "safe" + U+202E + "tnuomA" would otherwise read as another
// identifier, and a zero-width space makes two names look the same (audit 03-E1a finding F14). Only
// what is DRAWN changes; a copy control copies the original characters.
function hiddenChar(c) {
  return (c < 32 && c !== 9 && c !== 10 && c !== 13) || (c >= 127 && c <= 159) || c === 173 || c === 847
    || c === 1564 || c === 4447 || c === 4448 || c === 6068 || c === 6069 || c === 6158
    || (c >= 8203 && c <= 8207) || (c >= 8234 && c <= 8238) || (c >= 8288 && c <= 8303)
    || c === 12644 || c === 65279 || c === 65440 || (c >= 65529 && c <= 65531)
    || (c >= 119155 && c <= 119162) || (c >= 917504 && c <= 917631);
}
function shown(value) {
  var v = txt(value);
  var out = null;
  for (var i = 0; i < v.length; i++) {
    var c = v.codePointAt(i);
    var w = c > 65535 ? 2 : 1;
    if (hiddenChar(c)) {
      if (out === null) out = v.slice(0, i);
      var h = c.toString(16).toUpperCase();
      while (h.length < 4) h = "0" + h;
      out += "⟨U+" + h + "⟩";
    } else if (out !== null) {
      out += v.substr(i, w);
    }
    i += w - 1;
  }
  return out === null ? v : out;
}

// ── Copy to clipboard ───────────────────────────────────────────────────────────────────────

function copyable(value, label, cls) {
  var text = label === null || label === undefined ? "-" : txt(label);
  var s = node("span", text, cls ? "cp " + cls : "cp");
  if (value === null || value === undefined || value === "") { s.className = cls || ""; return s; }
  var full = txt(value);
  s.title = shown(full.length > 200 ? full.slice(0, 200) + "… (" + full.length + " characters)" : full) + "  (click to copy)";
  s.addEventListener("click", function (ev) { ev.stopPropagation(); copyValue(txt(value), s); });
  return s;
}
function copyValue(value, target) {
  var base = target.className;
  function flash(ok) {
    target.className = base + (ok ? " copied" : " copyfail");
    window.setTimeout(function () { target.className = base; }, 900);
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () { flash(true); },
        function () { selectFallback(value, flash); });
      return;
    }
  } catch (e) { /* fall through to the selection fallback */ }
  selectFallback(value, flash);
}
// No clipboard API (or no permission): park the value in an off-screen read-only field and select
// it, so it can be copied with the keyboard. Nothing leaves the page either way.
function selectFallback(value, flash) {
  var ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "readonly");
  ta.className = "cpbuf";
  document.body.appendChild(ta);
  ta.select();
  var ok = false;
  try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  flash(ok);
}

// ── Fetch ───────────────────────────────────────────────────────────────────────────────────

// No answer is read past MAX_RESPONSE_BYTES: a publisher chooses what some answers hold (URLs of up
// to 262 112 bytes, bundle-derived lists), and the page must not buffer and parse without end on
// every refresh (audit 03-E1a finding F4). An announced length over the bound is refused before
// reading; a streamed body is counted as it arrives and cancelled at the bound.
var MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
function tooLarge(path, n) {
  var err = new Error("the answer is larger than this page reads (" + groupDigits(n) + " bytes > "
    + groupDigits(MAX_RESPONSE_BYTES) + "): " + path);
  err.status = 0;
  err.code = "TOO_LARGE";
  return err;
}
async function readBody(res, path) {
  var announced = res.headers && res.headers.get ? Number(res.headers.get("content-length")) : NaN;
  if (announced > MAX_RESPONSE_BYTES) throw tooLarge(path, announced);
  var reader = res.body && res.body.getReader && typeof TextDecoder !== "undefined" ? res.body.getReader() : null;
  if (reader === null) {
    var whole = await res.text();
    if (whole.length > MAX_RESPONSE_BYTES) throw tooLarge(path, whole.length);
    return whole;
  }
  var dec = new TextDecoder("utf-8");
  var parts = [];
  var n = 0;
  for (;;) {
    var chunk = await reader.read();
    if (chunk.done) break;
    n += chunk.value.byteLength;
    if (n > MAX_RESPONSE_BYTES) {
      try { reader.cancel(); } catch (e) { /* already closed */ }
      throw tooLarge(path, n);
    }
    parts.push(dec.decode(chunk.value, { stream: true }));
  }
  parts.push(dec.decode());
  return parts.join("");
}
async function api(path) {
  var res = await fetch(path, { headers: { accept: "application/json" }, cache: "no-store" });
  var body = await readBody(res, path);
  var parsed = null;
  if (body !== "") { try { parsed = JSON.parse(body); } catch (e) { parsed = null; } }
  if (!res.ok) {
    var code = parsed && parsed.error && parsed.error.code ? parsed.error.code : "HTTP_" + res.status;
    var err = new Error(res.status + " " + code + ": " + path);
    err.status = res.status;
    err.code = code;
    throw err;
  }
  return parsed;
}
// The §5 collections answer { items: [...] } (and /metadata answers { keys: [...] }); a bare array
// is accepted too, so a small shape difference in the API never blanks a panel.
function itemsOf(payload) {
  if (!payload) return [];
  if (Object.prototype.toString.call(payload) === "[object Array]") return payload;
  if (payload.items && Object.prototype.toString.call(payload.items) === "[object Array]") return payload.items;
  if (payload.keys && Object.prototype.toString.call(payload.keys) === "[object Array]") return payload.keys;
  if (payload.events && Object.prototype.toString.call(payload.events) === "[object Array]") return payload.events;
  if (payload.tokens && Object.prototype.toString.call(payload.tokens) === "[object Array]") return payload.tokens;
  return [];
}
function isArray(v) { return Object.prototype.toString.call(v) === "[object Array]"; }
function arr(v) { return isArray(v) ? v : []; }
// A collection the API may send either as an array or as a map keyed by segment (spec §4 names
// "fallibleOffer: Map<segment, ZswapOffer>" and "intents: Map<segment, Intent>"; question Q15).
// Either way this hands back a list whose items carry their segment.
function segList(v) {
  if (isArray(v)) return v;
  if (!v || typeof v !== "object") return [];
  var out = [];
  for (var k in v) {
    if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
    var item = v[k];
    if (!item || typeof item !== "object") continue;
    var copy = {};
    for (var p in item) if (Object.prototype.hasOwnProperty.call(item, p)) copy[p] = item[p];
    if (copy.segment === undefined || copy.segment === null) copy.segment = Number(k);
    out.push(copy);
  }
  return out;
}
function count(v) { return isArray(v) ? v.length : (v === null || v === undefined ? 0 : Number(v)); }

// ── 00023: amounts, roles, wallet addresses ─────────────────────────────────────────────────

// Exact by construction (FR-014): the API sends the raw integer as a decimal string and the token
// its decimals, so the point is placed by hand. No Number(), no rounding, no locale — a token with
// 18 decimals would lose its low digits to a float before it ever reached the screen.
function formatUnits(amount, decimals) {
  var s = txt(amount === null || amount === undefined ? "" : amount);
  if (s === "") return "-";
  var sign = "";
  if (s.charAt(0) === "-") { sign = "-"; s = s.slice(1); }
  var d = decimals === null || decimals === undefined ? 0 : Number(decimals);
  if (!(d > 0)) return sign + s;
  while (s.length <= d) s = "0" + s;
  return sign + s.slice(0, s.length - d) + "." + s.slice(s.length - d);
}
function decimalsOf(a, t) {
  if (t && t.decimals !== null && t.decimals !== undefined) return t.decimals;
  if (a && a.token && a.token.decimals !== null && a.token.decimals !== undefined) return a.token.decimals;
  return null;
}
// A shielded delta is stored unsigned with a direction, and the sign is put back here FROM THE
// POOL'S PERSPECTIVE: value entering the shielded pool reads "+", value leaving it reads "-". The
// ledger publishes the opposite number — its delta is inputs minus outputs, so a mint is negative
// there — and that raw value stays on hover and in the raw JSON, where a reader comparing with the
// chain will look for it. Printing the ledger's sign in a column headed by "into the shielded pool"
// contradicted the words beside it.
function poolSign(direction) {
  return direction === "pool_in" ? "+" : (direction === "pool_out" ? "-" : "");
}
// The row's amount in the token's decimals; the raw units are on hover (FR-009).
function amountCell(a, t) {
  var dec = decimalsOf(a, t);
  var sign = poolSign(a.direction);
  var s = node("span", sign + formatUnits(a.amount, dec), "amt");
  var title = txt(a.amount) + " raw units";
  if (dec !== null && dec !== undefined) title += "  ·  decimals " + dec;
  if (a.role === "shielded_delta") {
    title += "  ·  the ledger's own offer delta is "
      + (a.direction === "pool_in" ? "-" : "+") + txt(a.amount) + " (inputs - outputs)";
  }
  s.title = title;
  return s;
}
// An offer delta straight from the §4 document, which carries the LEDGER's signed value. Shown the
// same way round as the rows above, with the ledger's own number on hover.
function poolDeltaCell(delta) {
  var raw = txt(delta === null || delta === undefined ? "" : delta);
  if (raw === "") return node("span", "-", "amt");
  var magnitude = raw.charAt(0) === "-" ? raw.slice(1) : raw;
  var shown = raw.charAt(0) === "-" ? "+" + magnitude : "-" + magnitude;
  var s = node("span", shown, "amt");
  s.title = "the ledger's own offer delta is " + raw + " (inputs - outputs); shown here from the "
    + "shielded pool's perspective";
  return s;
}
// The transaction-level guaranteed zswap offer is stored under segment 0 because the table needs a
// key, not because the chain calls it that: the guaranteed section IS segment 0. Printing
// "segment 0" beside it shows a reader a storage detail and sends them looking for an intent that
// does not exist. Only intent-carried sections get a number.
function isTxLevelOffer(section, segment) {
  return txt(section) === "guaranteed" && (segment === 0 || segment === "0");
}
function sectionLabel(section, segment) {
  if (isTxLevelOffer(section, segment)) return "guaranteed offer";
  return txt(section) + " · segment " + orDash(segment);
}
function offerHeading(section, segment) {
  if (isTxLevelOffer(section, segment)) return "guaranteed offer";
  return txt(section) + " offer · segment " + orDash(segment);
}
var ROLES = [
  ["", "all"],
  ["utxo_out", "UTXO created"],
  ["utxo_in", "UTXO spent"],
  ["contract_in", "received by contract"],
  ["contract_out", "paid by contract"],
  ["mint", "minted"],
  ["shielded_delta", "shielded pool delta"],
  ["reward", "reward"]
];
function roleLabel(a) {
  if (a.role === "shielded_delta") {
    return a.direction === "pool_out" ? "out of the shielded pool" : "into the shielded pool";
  }
  for (var i = 1; i < ROLES.length; i++) if (ROLES[i][0] === a.role) return ROLES[i][1];
  return txt(a.role);
}
// The hue of the "what happened" word, from the row's own direction (FR-014: amount is unsigned
// and "direction" carries the sign). A mint is an "in" row in the database, but it is the one
// thing on this page that CREATES value rather than moving it, so it keeps its own colour.
function directionClass(a) {
  if (!a) return "";
  if (a.role === "mint") return "dir-mint";
  var d = a.direction === null || a.direction === undefined ? "" : txt(a.direction);
  if (d === "pool_in" || d === "pool_out") return "dir-pool";
  if (d === "in") return "dir-in";
  if (d === "out") return "dir-out";
  return "";
}
// One cell, so the transactions table of a token and the activity list inside a transaction agree
// on both the word and its colour.
function roleCell(a) {
  return node("span", roleLabel(a), directionClass(a));
}
// Q9: a wallet address is shown as Bech32m and only as Bech32m. The human-readable part names the
// network and is kept whole; the data part is elided in the middle. The API also sends "ownerHex",
// which this page never displays.
function shortAddr(s) {
  var v = txt(s === null || s === undefined ? "" : s);
  if (v === "") return "-";
  var cut = v.lastIndexOf("1");
  if (cut < 1 || v.length - cut < 16) return v;
  return v.slice(0, cut + 1) + v.slice(cut + 1, cut + 6) + "…" + v.slice(v.length - 5);
}
function ownerCell(owner) {
  if (!owner) return node("span", "-", "no");
  return copyable(owner, shortAddr(owner), "hex");
}
function contractLink(address, label) {
  if (!address) return node("span", "-", "no");
  var a = node("a", label === undefined || label === null ? shortHex(address, 8, 6) : label, "hex");
  a.href = hashContract(address);
  a.title = address + " (open the contract)";
  a.addEventListener("click", function (ev) { ev.stopPropagation(); });
  return a;
}
function txLink(hash) {
  if (!hash) return node("span", "-", "no");
  var a = node("a", shortHex(hash, 8, 6), "hex");
  a.href = hashTx(hash);
  a.title = hash + " (open the whole transaction)";
  a.addEventListener("click", function (ev) { ev.stopPropagation(); });
  return a;
}
function colorLink(color, kind) {
  if (!color) return node("span", "-", "no");
  var a = node("a", shortHex(color, 8, 6), "hex");
  a.href = hashColor(color, kind === null || kind === undefined ? 0 : kind);
  a.title = color + " (open the token of this colour)";
  a.addEventListener("click", function (ev) { ev.stopPropagation(); });
  return a;
}
function hexListCell(values, key) {
  var list = arr(values);
  if (list.length === 0) return node("span", "none", "no");
  var wrap = node("span");
  for (var i = 0; i < list.length; i++) {
    var v = key === undefined ? list[i] : list[i][key];
    if (i > 0) wrap.appendChild(node("span", "  "));
    if (!v) wrap.appendChild(node("span", "-", "no"));
    else wrap.appendChild(copyable(v, shortHex(txt(v), 8, 6), "hex"));
  }
  return wrap;
}
function countedChip(counted) {
  if (counted === false) {
    // One phrase, from the same map as every other tag; the note under the activity table still
    // says what follows from it (no activity row is stored, the transaction is shown whole).
    return withHelp(node("span", "not counted", "chip nocount"), "nocount");
  }
  return node("span", "counted", "chip");
}
// Spec §5: the API states what a token's page can honestly show. The fallback derives the same
// answer from the row itself, so the page still renders against an API that has not caught up.
function visibilityOf(t) {
  if (!t) return "full";
  if (t.shieldedVisibility) return txt(t.shieldedVisibility);
  if (t.storage === "ledger") return "calls-only";
  if (t.status === "builtin" && !t.color) return "not-tracked";
  return Number(t.kind) === 1 ? "disclosed-imbalances" : "full";
}
var VISIBILITY = {
  "full": "everything: every UTXO and every contract flow of this colour is public",
  "disclosed-imbalances": "the offers whose imbalance names this colour, and nothing about the coins",
  "calls-only": "its contract's calls; balances live in contract state this indexer does not read",
  "not-tracked": "not tracked per token: every transaction pays a DUST fee"
};
function visibilityCell(t) {
  var v = visibilityOf(t);
  var s = node("span", v + " — " + (VISIBILITY[v] ? VISIBILITY[v] : "unknown"), "wrapv");
  return s;
}
// FR-013's five counters: read from "counters" first, then from the top level (question Q16).
function counterOf(st, name) {
  if (!st) return null;
  var c = st.counters || {};
  if (c[name] !== undefined && c[name] !== null) return c[name];
  if (st[name] !== undefined && st[name] !== null) return st[name];
  return null;
}

// ── Routing (hash only: the page is one document and every view is bookmarkable) ────────────

// 00024-03: a route may end in a section of its view — "#/contract/<address>/interface",
// "#/token/<address>/<domainSep>/<kind>/mints" — which the page scrolls to once it is drawn. That
// is how an origin's evidence link lands on the publication or the rows it cites.
var FOCUS_SECTIONS = ["interface", "calls", "mints", "traits", "events", "activity", "metadata", "facts", "tokens"];
function focusOf(s) { return s !== undefined && FOCUS_SECTIONS.indexOf(s) >= 0 ? s : null; }
function parseHash() { return routeOf(window.location.hash || ""); }
function routeOf(hash) {
  var h = txt(hash === null || hash === undefined ? "" : hash);
  if (h.charAt(0) === "#") h = h.slice(1);
  var raw = h.split("/");
  var parts = [];
  for (var i = 0; i < raw.length; i++) {
    if (raw[i] === "") continue;
    try { parts.push(decodeURIComponent(raw[i])); } catch (e) { parts.push(raw[i]); }
  }
  if (parts.length === 0) return { view: "list" };
  if (parts[0] === "status") return { view: "status" };
  if (parts[0] === "shielded-offers") return { view: "offers" };
  if (parts[0] === "tx" && parts.length >= 2) return { view: "tx", hash: parts[1] };
  if (parts[0] === "contract" && parts.length >= 2) {
    return { view: "contract", address: parts[1], focus: focusOf(parts[2]) };
  }
  if (parts[0] === "token" && parts.length >= 4) {
    return { view: "token", address: parts[1], domainSep: parts[2], kind: parts[3], focus: focusOf(parts[4]) };
  }
  // US5: a colour whose mint predates the archive has no (address, domainSep) to route by, so its
  // page is the colour and the kind. When a later mint names it, the token route works as well.
  if (parts[0] === "color" && parts.length >= 3) {
    return { view: "token", color: parts[1], kind: parts[2], focus: focusOf(parts[3]) };
  }
  return { view: "list" };
}
function hashToken(t) {
  if (!t.address || !t.domainSep) return t.color ? hashColor(t.color, t.kind) : "#/";
  return "#/token/" + enc(t.address) + "/" + enc(t.domainSep) + "/" + enc(t.kind);
}
function hashColor(color, kind) { return "#/color/" + enc(color) + "/" + enc(kind); }
function hashTx(h) { return "#/tx/" + enc(h); }
function hashContract(a) { return "#/contract/" + enc(a); }
function routeKey(r) {
  return [r.view, r.address, r.domainSep, r.kind, r.color, r.hash].join("|");
}
function go(hash) { window.location.hash = hash; }

// ── tokenUri and the resolver ───────────────────────────────────────────────────────────────
//
// A reference piece carries "localhost:10020/constellations/orion" (spec §7.1). Whatever port
// this process actually listens on, the document it names is served by THIS origin, so the link
// is rewritten to a same-origin path. A URI on any other host is left alone and rendered as it is.

// Where a browser goes for an http(s) URL: the platform's own URL parser decides — the host it gives
// is the host the browser will go to (percent-decoded, lower-cased, IDNA-mapped; tabs and newlines
// dropped; the run of slashes and backslashes after the scheme skipped; user information split off),
// so a shortened URL can always show where it leads (audit 03-E1a findings F13, R3F:
// "%65%76%69%6c.example" is evil.example). A URL it refuses — or no parser at all — makes no link.
function urlDest(url) {
  if (typeof URL !== "function") return null;
  var u = null;
  try { u = new URL(txt(url)); } catch (e) { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return { host: u.hostname, userinfo: u.username !== "" || u.password !== "", path: u.pathname + u.search + u.hash };
}
// The path of a same-origin rewrite: one leading slash, never two (a "//host/…" href would leave
// this origin) and never a backslash (browsers read it as a slash). Tabs and newlines go FIRST, as a
// browser drops them before it parses: "/" + TAB + "/evil.example" is "//evil.example" to it (audit
// 03-E1a finding R2B). The result is checked once more; anything else is not made a link (null).
function localPath(path) {
  var p = "";
  for (var j = 0; j < path.length; j++) {
    var c = path.charCodeAt(j);
    if (c !== 9 && c !== 10 && c !== 13) p += path.charAt(j);
  }
  var i = 0;
  while (i < p.length && (p.charAt(i) === "/" || p.charCodeAt(i) === 92)) i++;
  var out = "/" + p.slice(i);
  var second = out.length > 1 ? out.charCodeAt(1) : 0;
  return second === 47 || second === 92 ? null : out;
}
function splitUri(uri) {
  var s = txt(uri === null || uri === undefined ? "" : uri);
  var low = s.toLowerCase();
  var mark = ":" + "//";
  var linkable = low.indexOf("http" + mark) === 0 || low.indexOf("https" + mark) === 0;
  var dest = linkable ? urlDest(s) : null;
  if (dest === null) return { href: null, label: s, local: false, host: null, userinfo: false };
  var local = dest.host === "localhost" || dest.host === "127.0.0.1" || dest.host === "[" + "::1]";
  // A URI with user information before its host is not made a link: its label reads as one host
  // and the browser would open another.
  var href = dest.userinfo || dest.host === "" ? null : (local ? localPath(dest.path) : s);
  if (href === null && local && !dest.userinfo) return { href: null, label: s, local: false, host: dest.host, userinfo: false };
  return { href: href, label: s, local: local, host: dest.host, userinfo: dest.userinfo };
}
function uriLink(uri) {
  if (uri === null || uri === undefined || uri === "") return node("span", "-", "no");
  var parsed = splitUri(uri);
  if (parsed.href === null && parsed.userinfo) {
    var warn = node("span", null, "wrapv");
    warn.appendChild(node("span", parsed.label, "hex"));
    warn.appendChild(node("span", "  (not a link: user information before the host; it leads to "
      + clipText(parsed.host, NAME_MAX).text + ")", "err"));
    return warn;
  }
  if (parsed.href === null) return node("span", parsed.label, "hex");
  var a = node("a", parsed.label);
  a.href = parsed.href;
  a.rel = "noreferrer noopener";
  a.target = "_blank";
  a.title = shown(clipText(parsed.local ? "rewritten to this origin: " + parsed.href : parsed.label, TEXT_MAX).text) + " (opens the metadata document in a new tab)";
  // A row click navigates to the token view; a click on the link itself must only open the document.
  a.addEventListener("click", function (ev) { ev.stopPropagation(); });
  return a;
}
// The page's own resolver link, GET /{token-name}/{id} (spec §5). The pretty form uses the
// symbol and the piece id ("cnst:orion" under symbol CNST is the piece "orion"); the hex form
// (address / domainSep) always resolves, so both are offered.
function resolverPaths(t) {
  var out = [];
  var sym = t.symbol ? txt(t.symbol).toLowerCase() : null;
  if (sym) {
    var text = hexText(t.domainSep);
    var id = null;
    if (text !== null && text.toLowerCase().indexOf(sym + ":") === 0) id = text.slice(sym.length + 1);
    else if (t.name) id = slug(t.name);
    else if (text !== null) id = text;
    if (id) {
      var pretty = "/" + enc(sym) + "/" + enc(id);
      out.push({ label: "resolver", path: pretty, short: pretty });
    }
  }
  // The hex form always resolves (the resolver accepts the 64-hex address and domain separator), so
  // it is offered beside the pretty one — with a short label, because 130 characters of hex in a
  // link is not a link, it is a wall. It carries the KIND BYTE as a third segment: since the kind
  // is part of the identity, two rows can share an address and a domain separator, and the two
  // segment form would answer 409 for both of them.
  if (t.address && t.domainSep) {
    var kindPart = t.kind === null || t.kind === undefined ? "" : "/" + enc(t.kind);
    out.push({
      label: "resolver (hex form)",
      path: "/" + enc(t.address) + "/" + enc(t.domainSep) + kindPart,
      short: "/" + shortHex(t.address, 6, 4) + "/" + shortHex(t.domainSep, 6, 4) + kindPart
    });
  }
  return out;
}

// ── Token cells ─────────────────────────────────────────────────────────────────────────────

// Every tag on this page says one word — "observed", "dual", "multiple" — and a word is only a
// label if the reader already knows the vocabulary. One phrase per tag, stated ONCE here and read
// by the badge and chip constructors below, so a wording change is one line and no tag can be left
// unexplained. The mechanism is the native title attribute: no script, no library, no extra
// element, and nothing for the Content Security Policy to admit.
var TAG_HELP = {
  // the five row sources (MIP section 7.2's three, plus this indexer's builtin and 00023's seen)
  builtin: "Built into the network: NIGHT and DUST have no issuing contract",
  observed: "Minted on chain by its contract; the contract has published no metadata for it",
  declared: "Its contract published metadata for it, but no mint has been seen",
  described: "Minted on chain and described by its contract's published metadata",
  seen: "Seen in public transaction data before its mint; the issuing contract is not known yet",
  // the five families, derived from the rows themselves (see familyOf)
  shielded: "A native shielded token: coins are commitments, only offer imbalances name the colour",
  unshielded: "A native unshielded token: every UTXO shows its owner, colour and amount",
  ledger: "A ledger token: balances live in the contract's own state, not in UTXOs",
  collection: "One contract minting many tokens, one domain separator per piece",
  dual: "One domain separator issued both shielded and unshielded",
  // the two chips that are not a status and not a family
  multiple: "This contract issues several domain separators; open the contract to see them all",
  nocount: "This section did not take effect: its transaction or segment failed"
};
// Own properties only: a status string arrives from the API, and "constructor" or "toString" would
// otherwise hand a function to title.
function tagHelp(name) {
  if (!name || !Object.prototype.hasOwnProperty.call(TAG_HELP, name)) return null;
  return TAG_HELP[name];
}
// Sets a tag's tooltip and returns the node, so a constructor stays one expression.
function withHelp(n, name) {
  var help = tagHelp(name);
  if (help) n.title = help;
  return n;
}

// MIP section 7.2 has three consumer states; builtin is this indexer's own fourth, for the two
// seeded rows. There is no state for a self-contradicting row: a declaration and a mint populate
// different rows, so a row has nothing to contradict.
function statusBadge(s) {
  var v = s ? txt(s) : "unknown";
  // 00023 adds the fourth row source: a colour seen in public data whose contract is not known
  // yet (US5). It is a real row with real transactions and no name.
  var known = ["builtin", "observed", "declared", "described", "seen"];
  var cls = known.indexOf(v) < 0 ? "st-unknown" : "st-" + v;
  // A status the page does not know is left without a tooltip rather than given a wrong one.
  return withHelp(node("span", v, "badge " + cls), v);
}
// The kind byte (MIP section 3) as the two words it encodes. The byte itself goes in the title,
// because it is the identity and a reader copying a URL needs it.
function kindLabel(t) {
  if (!t) return "-";
  var privacy = t.privacy ? txt(t.privacy) : "?";
  var storage = t.storage ? txt(t.storage) : "?";
  return privacy + " " + String.fromCharCode(183) + " " + storage;
}
// The token view's subtitle, under the name. Every segment says either the fact or WHY it is
// missing: "no symbol" reads like a symbol whose value is the words "no symbol", and a bare "-"
// for decimals says nothing at all about whether the contract published none or the page failed
// to read one. The kind byte keeps its privacy word in brackets, and the storage word becomes
// "native token" / "ledger token", which is what the distinction actually means to a reader.
//   no symbol metadata · kind 0 (unshielded) · native token · no decimals metadata
//   SSTAR · kind 1 (shielded) · native token · decimals 6
// The token heading's one-line summary. Every value in it is drawn with its own origin chip and
// marked as another occurrence of its fact (audit 03-E1a finding R2E); the words for what is not
// known stay the 00023 ones ("no symbol metadata", "no decimals metadata").
function subtitleNode(t, m) {
  var wrap = node("span", null, "note");
  function part(field, text) {
    var it = factOf(m, field);
    var s = marked(node("span", null, "vo"), field);
    s.appendChild(node("span", text));
    s.appendChild(originChip(it.origin));
    if (it.origin.p1) s.appendChild(p1Mark());
    wrap.appendChild(s);
  }
  function sep() { wrap.appendChild(node("span", "  ·  ")); }
  part("symbol", t.symbol ? txt(t.symbol) : "no symbol metadata");
  sep();
  part("kind", "kind " + orDash(t.kind));
  wrap.appendChild(node("span", " "));
  part("privacy", "(" + (t.privacy ? txt(t.privacy) : "?") + ")");
  sep();
  part("storage", t.storage === "ledger" ? "ledger token" : (t.storage === "native" ? "native token" : "storage unknown"));
  sep();
  part("decimals", t.decimals === null || t.decimals === undefined ? "no decimals metadata" : "decimals " + txt(t.decimals));
  return wrap;
}
function kindCell(t) {
  var s = node("span", kindLabel(t));
  if (t.kind !== null && t.kind !== undefined) s.title = "kind byte " + txt(t.kind);
  return s;
}
// The family chip is DERIVED from the rows themselves, never from the name's first word: the
// indexer sees every contract on the chain, and most of them are not this project's reference set.
//
//   ledger      the row's storage is ledger (MIP kinds 2 and 3): no colour, never minted
//   dual        the same domain separator exists as BOTH native kinds, sharing one colour
//   collection  the contract has several native domain separators, one per piece (ERC-1155 shape)
//   shielded /
//   unshielded  a plain native token, labelled by its privacy tag
//
// Built-in rows get no chip: NIGHT and DUST share a sentinel address and are already labelled.
// The index covers the rows currently on screen, which is the whole list page in practice.
function familyIndex(items) {
  var domains = {};
  var kinds = {};
  for (var i = 0; i < (items || []).length; i++) {
    var t = items[i];
    if (!t || t.status === "builtin" || t.storage !== "native") continue;
    // A "seen" row has no contract and no domain separator (US5): it cannot take part in a family,
    // and two of them would otherwise look like one asset minted under two kinds.
    if (!t.address || !t.domainSep) continue;
    var a = txt(t.address);
    var d = txt(t.domainSep);
    if (!domains[a]) domains[a] = {};
    domains[a][d] = true;
    var pair = a + "/" + d;
    if (!kinds[pair]) kinds[pair] = {};
    kinds[pair][txt(t.kind)] = true;
  }
  return { domains: domains, kinds: kinds };
}
function countKeys(o) {
  var n = 0;
  for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) n++;
  return n;
}
function familyOf(t, index) {
  if (!t || t.status === "builtin") return null;
  if (!t.address || !t.domainSep) return null;
  if (t.storage === "ledger") return "ledger";
  var pair = txt(t.address) + "/" + txt(t.domainSep);
  var kinds = index && index.kinds ? index.kinds[pair] : null;
  if (kinds && kinds["0"] && kinds["1"]) return "dual";
  var domains = index && index.domains ? index.domains[txt(t.address)] : null;
  if (domains && countKeys(domains) > 1) return "collection";
  return t.privacy ? txt(t.privacy) : null;
}
var FAMILY_RULE = "the kind of asset this row is, from its own storage bit and its contract's token rows: "
  + "ledger (a ledger token) · dual (one domain separator under kinds 0 and 1) · collection (the contract "
  + "issues several domain separators) · otherwise its privacy";
// The token view's heading: the family badge, the name (or, for a colour no contract has named, the
// colour), each marked as its own value with its own origin chip (audit 03-E1a finding R3B).
function headingNodes(t, m, h3) {
  var fam = factOf(m, "family");
  if (fam.value !== undefined && fam.value !== null) {
    var f = marked(node("span", null, "vo"), "family");
    f.appendChild(withHelp(node("span", fam.value, "fam fam-" + fam.value), fam.value));
    f.appendChild(originChip(fam.origin));
    h3.appendChild(f);
  }
  var seen = t.status === "seen";
  var which = seen ? factOf(m, "color") : factOf(m, "name");
  var v = marked(node("span", null, "vo"), which.field);
  v.appendChild(node("span", t.name ? txt(t.name) : (seen ? "colour " + shortHex(t.color, 8, 6) : "(undescribed)"),
    t.name ? "txt" : (seen ? "hex" : "no")));
  v.appendChild(originChip(which.origin));
  if (which.origin.p1) v.appendChild(p1Mark());
  h3.appendChild(v);
  if (seen) {
    var pill = node("span", "unknown contract", "pill");
    pill.title = "this colour was seen in public transaction data before any mint or metadata "
      + "event named it: its contract and domain separator are not known (its mint predates the "
      + "archive). A later mint or metadata event completes this row in place.";
    h3.appendChild(pill);
  }
}
function nameCell(t, index) {
  var wrap = node("span");
  var fam = familyOf(t, index);
  if (fam) wrap.appendChild(withHelp(node("span", fam, "fam fam-" + fam), fam));
  var seen = t.status === "seen";
  wrap.appendChild(t.name ? boundedNode(t.name, NAME_MAX, "txt")
    : node("span", seen ? "colour " + shortHex(t.color, 8, 6) : "(undescribed)", seen ? "hex" : "no"));
  if (seen) {
    // US5: the row exists because the colour was seen moving, not because a contract said so.
    var pill = node("span", "unknown contract", "pill");
    pill.title = "this colour was seen in public transaction data before any mint or metadata "
      + "event named it: its contract and domain separator are not known (its mint predates the "
      + "archive). A later mint or metadata event completes this row in place.";
    wrap.appendChild(pill);
  }
  return wrap;
}
// One trait's value, rendered by its declared type (MIP section 2.1): text for 1/3/4, the decimal
// integer for 2, hex for opaque bytes and for anything that did not decode.
function typeLabel(vt) {
  // MIP-0018 section 2.1's six types. 5 is Null - an explicit "this key has no value", distinct
  // from an empty string and from the JSON literal null - and it exists under the standard's name
  // only: under the superseded draft name 5 is reserved and the event is rejected outright.
  var names = ["opaque", "text", "integer", "JSON", "URI", "Null"];
  if (vt === null || vt === undefined) return "-";
  var n = Number(vt);
  return n >= 0 && n < names.length ? txt(n) + " " + names[n] : txt(n) + " reserved";
}
function traitValueCell(tr, openKey) {
  if (Number(tr.valType) === 2 && tr.integer !== null && tr.integer !== undefined) {
    return node("span", txt(tr.integer), "txt");
  }
  // a current value is drawn whole up to TRAIT_MAX drawn characters — every realistic long value —
  // and past that on the reader's request (audit 03-E1a finding R3E)
  if (tr.text !== null && tr.text !== undefined) {
    return openKey ? boundedNode(tr.text, TRAIT_MAX, "txt wrapv", openKey) : node("span", txt(tr.text), "txt wrapv");
  }
  if (tr.value) return copyable(tr.value, shortHex(txt(tr.value), 10, 8), "hex");
  return node("span", "(empty)", "no");
}
function traitKeyCell(tr) {
  var wrap = node("span");
  if (tr.key !== null && tr.key !== undefined) {
    wrap.appendChild(node("span", txt(tr.key), "txt"));
  } else {
    // MIP section 5.1: a key that is not valid UTF-8 is still a key. It is shown as its bytes.
    var hexKey = copyable(tr.keyHex, "0x" + shortHex(txt(tr.keyHex), 8, 6), "hex");
    hexKey.title = "this key is not valid UTF-8 and is shown as its bytes";
    wrap.appendChild(hexKey);
  }
  return wrap;
}
function domainCell(d) {
  var text = hexText(d);
  if (text !== null) return copyable(d, text, "txt");
  return copyable(d, shortHex(d, 8, 6), "hex");
}
function domainLabel(d) {
  var text = hexText(d);
  return text !== null ? text : shortHex(d, 8, 6);
}
// One shared tooltip, fixed to the viewport: the table sits in an overflow-x wrapper that would
// clip an absolutely positioned child on the bottom rows.
function showTip(anchor, build) {
  hideTip();
  var tip = node("div", null, "tip");
  tip.id = "tip";
  build(tip);
  document.body.appendChild(tip);
  var r = anchor.getBoundingClientRect();
  var w = tip.offsetWidth, h = tip.offsetHeight;
  var left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  var top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  tip.style.left = left + "px";
  tip.style.top = top + "px";
}
function hideTip() {
  var old = document.getElementById("tip");
  if (old && old.parentNode) old.parentNode.removeChild(old);
}
// The list's domainSep cell: the row's own separator, plus a "multiple" chip when its contract
// issues under more than one. Hover or focus the chip for the contract's first five (by first-seen
// height) and how many more there are.
function listDomainCell(t) {
  var wrap = node("span");
  wrap.appendChild(domainCell(t.domainSep));
  var ds = t.contractDomainSeps;
  if (!ds || !(ds.count > 1)) return wrap;
  // The chip keeps its hover panel (the contract's first five separators); the tooltip says what
  // the word itself means, which the panel assumes the reader already knows.
  var chip = withHelp(node("span", "multiple", "multi"), "multiple");
  chip.tabIndex = 0;
  var build = function (tip) {
    tip.appendChild(node("div", ds.count + " domainSeps on this contract", "note"));
    var first = ds.first || [];
    for (var i = 0; i < first.length; i++) {
      var here = first[i] === t.domainSep;
      tip.appendChild(node("div", domainLabel(first[i]) + (here ? "  ← this row" : ""), here ? "here" : "hex"));
    }
    if (ds.count > first.length) tip.appendChild(node("div", "+" + (ds.count - first.length) + " more", "note"));
  };
  chip.addEventListener("mouseenter", function () { showTip(chip, build); });
  chip.addEventListener("focus", function () { showTip(chip, build); });
  chip.addEventListener("mouseleave", hideTip);
  chip.addEventListener("blur", hideTip);
  wrap.appendChild(chip);
  return wrap;
}
// A colour is absent for exactly two reasons, and they are different facts: a ledger token never
// has one (nothing is minted, so nothing is derived), and DUST has none at all — the ledger types
// it as a unit variant, not as 32 bytes. Neither is rendered as an empty cell.
function colorCell(c, storage) {
  if (!c) {
    if (storage === "ledger") return node("span", "ledger token", "no");
    return node("span", "none", "no");
  }
  return copyable(c, shortHex(c, 8, 6), "hex");
}
function isZeroHex(s) {
  if (!isHex(s)) return false;
  for (var i = 0; i < s.length; i++) if (s.charAt(i) !== "0") return false;
  return true;
}
// NIGHT and DUST are seeded rows with no contract behind them: their "address" is a sentinel of
// 32 zero bytes, and printing 64 zeros as if it were a deployment would be a lie in 64 characters.
function addressCell(t) {
  // Two different absences, and neither is an empty cell: a built-in row has a zero sentinel
  // instead of a contract, a "seen" row has none yet (US5).
  if (!t.address) return node("span", t.status === "seen" ? "unknown contract" : "built-in", "no");
  if (isZeroHex(t.address)) return node("span", "built-in", "no");
  return copyable(t.address, shortHex(t.address, 8, 6), "hex");
}
function mintsCell(t) {
  var wrap = node("span");
  wrap.appendChild(node("span", orDash(t.mintCount)));
  if (t.totalMinted !== null && t.totalMinted !== undefined) {
    wrap.appendChild(node("span", " · " + t.totalMinted, "note"));
  }
  return wrap;
}
function heightsCell(t) {
  if (t.firstMintHeight === null || t.firstMintHeight === undefined) return node("span", "-", "no");
  return node("span", txt(t.firstMintHeight) + " … " + orDash(t.lastMintHeight));
}
// NIGHT and DUST first, then every named row, then the colours nobody has named yet (US5
// scenario 3: "seen" rows sort after named rows — they are the ones a reader can say least about).
function sortTokens(items) {
  var built = [];
  var rest = [];
  var seen = [];
  for (var i = 0; i < items.length; i++) {
    var t = items[i];
    if (!t) continue;
    if (t.status === "builtin") built.push(t);
    else if (t.status === "seen") seen.push(t);
    else rest.push(t);
  }
  built.sort(function (a, b) { return txt(a.symbol) < txt(b.symbol) ? 1 : -1; });  // NIGHT, then DUST
  return built.concat(rest).concat(seen);
}

// ── 00024-03: where every value came from (spec 00024 US6, FR-016, FR-016b) ─────────────────
//
// The API sends an "origin" with every value it serves (FR-016b): one of five kinds and the
// evidence behind it. This block turns those into what the token and contract views show — a label,
// one line of evidence and the links that open it — and it is PURE: it reads API payloads and
// returns plain objects, never a DOM node. The page's governed test evaluates this very script
// (node:vm, the string this module serves) on recorded payloads and checks that every value of the
// two views carries a label and a link that resolves ([[token-ui-origin]]); the renderers further
// down draw only what these functions return, so what is tested is what is shown.
//
//   mip-0018          the package: tx, block, position, segment, parts, phase, event ids → the tx
//   public-interface  the publication: tx, block, segment, parts, commitment, levels, checked at
//                     → the contract's interface section (and the publication tx)
//   chain             the transaction or mint in the archive → the tx (or the section listing them)
//   derived           the rule applied (and, for a MIP-0018 key declared more than once, P1)
//   none              the reason
//
// A few values reach the page with no origin at all (the token's identity, its heights and
// counts, a contract's deploy facts, contract calls). The page labels those itself with a fixed
// rule, marked as its own, and says so (question Q28); it never invents evidence the API did not
// send. Diagnostics arrive already bounded by the indexer ("… [N characters omitted]") and are
// shown exactly as served.

var EVENT_LIMIT = 500;
// The contract's events are read page by page, following the API's cursor, up to EVENT_PAGES pages
// (EVENT_PAGES x EVENT_LIMIT events, oldest first). A contract with more says so where it matters —
// a key's history and the P1 count are then made of the events read (audit 03-E1a finding F2).
var EVENT_PAGES = 4;

var ORIGIN_LABELS = {
  "mip-0018": "MIP-0018 declaration",
  "public-interface": "Public interface",
  "chain": "Chain observation",
  "derived": "Derived by this indexer",
  "none": "Not available"
};
var P1_NOTE = "P1: last write, positioned by the first part";
var P1_RULE = "P1 (spec 00024 §9.2): of several declarations of one key, the last write wins in "
  + "MIP-0018's canonical order — block, transaction position, execution order — and a multi-part "
  + "package is positioned by its first part";
var PAGE_NOTE = "this page's own label: the API serves this value without an origin (Q28)";

// The seven publication statuses of the API (INTERFACE_STATUSES in api/queries.ts; spec §4 Key
// Entities). "historical" is not a status: it is the role of every publication older than the
// current one, and each keeps its own last result.
var INTERFACE_STATUS = {
  "pending": { cls: "if-wait",
    help: "published; its first check has not run yet — no level is claimed" },
  "verified": { cls: "if-ok",
    help: "the bundle passed the levels shown: L1 the commitment and every listed file, L2 the "
      + "verifier keys against the contract's state, L3 the keys recompiled with the exact compiler" },
  "failed": { cls: "if-bad",
    help: "the bundle failed the level shown and the reason says why; a newer failed publication is "
      + "the current one and is shown failed (Q14)" },
  "unchecked": { cls: "if-unav",
    help: "a limit (size, count or deadline) or an unavailable contract state stopped the check before "
      + "it finished: only the levels shown passed (L1, or none); retried" },
  "unfetchable": { cls: "if-unav",
    help: "the URL is refused by policy (not http(s), a private address, not text): no level is claimed" },
  "unreachable": { cls: "if-unav",
    help: "the host did not deliver (an HTTP error, a refused connection, a listed file missing): no "
      + "level is claimed; retried with exponential backoff (Q25)" },
  "stale": { cls: "if-wait",
    help: "the contract's verifier keys changed in a maintenance update: waiting for re-verification" }
};
// The role of a publication is a choice this indexer makes by rule P2, so it is labelled "Derived by
// this indexer" with that rule (spec US6: "current" choices made by a §9.2 rule), not with the
// publication's own origin (audit 03-E1a finding F9). The API serves the role without an origin of
// its own, so the label is the page's (Q28).
var P2_RULE = "P2 (spec 00024 §9.2): a contract's newest publication — by block, transaction position and "
  + "execution order — is its current one, whatever its result (Q14); every older one is historical";
function roleOrigin(p) {
  var q = p && typeof p === "object" ? p : {};
  return pageOrigin("derived", P2_RULE, { eventId: q.eventId, blockHeight: q.blockHeight, txPosition: q.txPosition });
}
var ROLE_HELP = {
  "current": "the newest publication of this contract (P2: block, transaction position, execution order)",
  "historical": "an older publication, kept with its own last result; never presented as current"
};

function own(o, k) { return !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k); }
function partsText(n) { return txt(n) + " part" + (Number(n) === 1 ? "" : "s"); }
function asciiHex(s) {
  var out = "";
  var str = txt(s);
  for (var i = 0; i < str.length; i++) {
    var h = str.charCodeAt(i).toString(16);
    out += h.length < 2 ? "0" + h : h;
  }
  return out;
}

// ── interface statuses and levels ────────────────────────────────────────────────────────────

function levelsPassed(levels) {
  if (!levels) return "";
  var out = [];
  if (levels.l1 === "passed") out.push("L1");
  if (levels.l2 === "passed") out.push("L2");
  if (levels.l3 === "passed") out.push("L3");
  return out.join("/");
}
function levelsLine(levels) {
  var lv = levels || {};
  return "L1 " + orDash(lv.l1) + " · L2 " + orDash(lv.l2) + " · L3 " + orDash(lv.l3);
}
function failedLevelOf(x) {
  if (!x) return null;
  if (typeof x.failedLevel === "number") return x.failedLevel;
  var lv = x.levels || {};
  if (lv.l1 === "failed") return 1;
  if (lv.l2 === "failed") return 2;
  if (lv.l3 === "failed") return 3;
  return null;
}
// One publication's result as a badge: "verified L1/L2/L3", "verified L1/L2", "failed at L1",
// "unchecked", ... with the help text and the notes a reader needs beside it.
function interfaceStatusView(x) {
  var status = x && x.status !== undefined && x.status !== null ? txt(x.status) : "unknown";
  var known = own(INTERFACE_STATUS, status);
  var passed = levelsPassed(x ? x.levels : null);
  var failed = failedLevelOf(x);
  var text = status;
  if (status === "verified") text = "verified " + (passed === "" ? "(no level)" : passed);
  else if (status === "failed") text = failed === null ? "failed" : "failed at L" + failed;
  else if (status === "stale" && passed !== "") text = "stale (was " + passed + ")";
  // The verifier stops at Level 2 with L1 passed when the contract state is unavailable or a Level 2
  // limit is reached: the badge says what did pass (audit 03-E1a finding F11).
  else if (status === "unchecked" && passed !== "") text = "unchecked (" + passed + " passed)";
  var notes = [];
  if (x && x.levels && status === "verified" && x.levels.l3 !== "passed") {
    notes.push("L3 " + orDash(x.levels.l3) + (x.l3Reason ? ": " + x.l3Reason : ""));
  }
  if (x && x.verifiedUntil) notes.push("verified until " + x.verifiedUntil);
  return {
    status: status, known: known, text: text, passed: passed, failedLevel: failed, notes: notes,
    cls: known ? INTERFACE_STATUS[status].cls : "if-unknown",
    help: known ? INTERFACE_STATUS[status].help : "a status this page does not know"
  };
}

// ── evidence ─────────────────────────────────────────────────────────────────────────────────

function evidenceList(ev) {
  if (isArray(ev)) return ev;
  return ev && typeof ev === "object" ? [ev] : [];
}
function eventIdsOf(p) {
  if (isArray(p.eventIds)) return p.eventIds;
  if (isArray(p.partEventIds)) return p.partEventIds;
  return p.eventId === undefined || p.eventId === null ? [] : [p.eventId];
}
// "tx 591d1c45…94bb2c · block 221 · position 0 · segment 23651 · 1 part · guaranteed · event 97"
function packageText(p) {
  var bits = [];
  if (!p) return "";
  if (p.txHash) bits.push("tx " + shortHex(txt(p.txHash), 8, 6));
  if (p.blockHeight !== undefined && p.blockHeight !== null) bits.push("block " + p.blockHeight);
  if (p.txPosition !== undefined && p.txPosition !== null) bits.push("position " + p.txPosition);
  if (p.segment !== undefined && p.segment !== null) bits.push("segment " + p.segment);
  if (p.parts !== undefined && p.parts !== null) bits.push(partsText(p.parts));
  if (p.phase) bits.push(txt(p.phase));
  var ids = eventIdsOf(p);
  if (ids.length > 0) bits.push((ids.length === 1 ? "event " : "events ") + idsText(ids));
  return bits.join(" · ");
}
// A package may hold up to 1 024 parts (FR-004): the first three ids and the last say which events
// they are without a thousand numbers in one line.
function idsText(ids) {
  if (ids.length <= 6) return ids.join(", ");
  return ids.slice(0, 3).join(", ") + ", … " + ids[ids.length - 1] + " (" + ids.length + " ids)";
}
// Plain facts of an evidence object that is not a package ({mintCount, firstMintHeight, ...}). A
// transaction, a contract or a list it names becomes a link instead, so it is not repeated here.
var LINKED_EVIDENCE = ["txHash", "contract", "list"];
function factsText(ev) {
  var bits = [];
  if (!ev || typeof ev !== "object" || isArray(ev)) return "";
  for (var k in ev) {
    if (!own(ev, k) || LINKED_EVIDENCE.indexOf(k) >= 0) continue;
    var v = ev[k];
    if (v === null || v === undefined || typeof v === "object") continue;
    var s = txt(v);
    bits.push(k + " " + (isHex(s) && s.length > 20 ? shortHex(s, 8, 6) : s));
  }
  return bits.join(" · ");
}
function txEvidence(txHash, what) {
  var h = txHash === null || txHash === undefined ? "" : txt(txHash);
  if (!isHex(h)) return null;
  return { href: hashTx(h), text: (what || "tx") + " " + shortHex(h, 8, 6), title: h + " (open the transaction)" };
}
var SECTION_TEXT = {
  "interface": "the public interface", "calls": "the contract's calls", "mints": "the mint history",
  "traits": "the traits", "events": "the raw events", "activity": "the transactions",
  "metadata": "the metadata document", "facts": "the token's values", "tokens": "the contract's tokens"
};
function sectionEvidence(ctx, section) {
  var c = ctx || {};
  if (c.token && c.token.address && c.token.domainSep) {
    return { href: hashTokenSection(c.token, section), text: SECTION_TEXT[section] || section,
      title: "open " + (SECTION_TEXT[section] || section) + " of this token" };
  }
  if (c.token && c.token.color) {
    return { href: hashTokenSection(c.token, section), text: SECTION_TEXT[section] || section,
      title: "open " + (SECTION_TEXT[section] || section) + " of this colour" };
  }
  if (c.address) {
    return { href: hashContract(c.address) + "/" + enc(section), text: SECTION_TEXT[section] || section,
      title: "open " + (SECTION_TEXT[section] || section) + " of this contract" };
  }
  return null;
}

// The seed of the two built-in rows (NIGHT, DUST), as the API serves it: the evidence of every value
// the indexer seeded rather than observed (00020 owner decision Q7; audit 03-E1a finding R3A).
var SEED_EVIDENCE = { href: P_TOKENS + "?status=builtin", text: "the seeded built-in rows (API)",
  title: "the built-in rows this indexer seeds, as GET /v1/tokens?status=builtin serves them (raw JSON, new tab)" };

// A value the API serves WITHOUT an origin: the page's own label, marked as such (Q28).
function pageOrigin(kind, text, evidence) {
  var o = { origin: kind, page: true };
  if (kind === "none") o.reason = text; else o.rule = text;
  if (evidence) o.evidence = evidence;
  return o;
}

// The one function every label on the token and contract views goes through.
//   ctx.address       the contract (a public-interface value links to its interface section)
//   ctx.token         the token (a chain value without a transaction links to its section)
//   ctx.section       that section, for a chain value that cites no transaction
//   ctx.declarations  how many applied declarations the value's key has (> 1 → P1 is named)
function originView(o, ctx) {
  var c = ctx || {};
  var kind = o && typeof o === "object" && typeof o.origin === "string" ? o.origin : null;
  var known = kind !== null && own(ORIGIN_LABELS, kind);
  var v = {
    kind: known ? kind : "unknown", known: known,
    label: known ? ORIGIN_LABELS[kind] : "Origin not given",
    detail: "", links: [], rule: null, reason: null, parts: null, phase: null, p1: false,
    page: !!(o && o.page)
  };
  if (!known) {
    v.detail = o && typeof o === "object"
      ? "the API sent an origin this page does not know: " + txt(o.origin)
      : "the API sent no origin for this value";
    return v;
  }
  var ev = o.evidence;
  var texts = [];
  if (kind === "mip-0018") {
    var packages = evidenceList(ev);
    for (var i = 0; i < packages.length; i++) {
      texts.push(packageText(packages[i]));
      var link = txEvidence(packages[i].txHash, packages.length > 1 ? "declaration " + (i + 1) + " tx" : "tx");
      if (link) v.links.push(link);
    }
    if (packages.length === 1) {
      v.parts = packages[0].parts === undefined ? null : packages[0].parts;
      v.phase = packages[0].phase === undefined ? null : packages[0].phase;
      if (Number(v.parts) > 1) v.label = ORIGIN_LABELS[kind] + ", " + partsText(v.parts);
    } else if (packages.length > 1) {
      v.label = ORIGIN_LABELS[kind] + ", " + packages.length + " declarations";
    }
    if (Number(c.declarations) > 1) {
      v.p1 = true;
      texts.push(P1_NOTE + " — the latest of " + (c.partial ? "at least " : "") + c.declarations
        + " declarations of this key" + (c.partial ? " (" + eventsReadText() + ")" : ""));
    }
  } else if (kind === "public-interface") {
    var e = ev && typeof ev === "object" ? ev : {};
    var st = interfaceStatusView(e);
    v.label = ORIGIN_LABELS[kind] + ", " + (st.status === "verified" ? (st.passed === "" ? "no level" : st.passed) : st.text);
    texts.push("publication " + packageText(e));
    if (e.commitment) texts.push("commitment " + shortHex(txt(e.commitment), 8, 6));
    texts.push(e.checkedAt ? "checked " + e.checkedAt : "not checked yet");
    if (c.address) {
      v.links.push({ href: hashContract(c.address) + "/interface", text: "the interface",
        title: "open this contract's public interface: URL, files, keys, circuits, history" });
    }
    var pl = txEvidence(e.txHash, "publication tx");
    if (pl) v.links.push(pl);
    v.parts = e.parts === undefined ? null : e.parts;
    v.phase = e.phase === undefined ? null : e.phase;
  } else if (kind === "chain") {
    v.rule = o.rule ? txt(o.rule) : null;
    if (v.rule) texts.push(v.rule);
    var ce = ev && typeof ev === "object" && !isArray(ev) ? ev : {};
    var facts = factsText(ce);
    if (facts) texts.push(facts);
    var tl = txEvidence(ce.txHash, "tx");
    if (tl) v.links.push(tl);
    if (ce.contract && isHex(txt(ce.contract))) {
      v.links.push({ href: hashContract(txt(ce.contract)), text: "the contract",
        title: txt(ce.contract) + " (open the contract)" });
    }
    if (ce.list === "shielded-offers") {
      v.links.push({ href: "#/shielded-offers", text: "the list of those offers",
        title: "open every shielded offer whose colour is undisclosed" });
    }
    if (v.links.length === 0 && c.section) {
      var sl = sectionEvidence(c, c.section);
      if (sl) v.links.push(sl);
    }
  } else if (kind === "derived") {
    v.rule = o.rule ? txt(o.rule) : "(no rule given)";
    texts.push(v.rule);
    var de = factsText(ev);
    if (de) texts.push("inputs: " + de);
    // A derived value links the inputs it names, where the page shows them (audit 03-E1a finding
    // F7): the contract, the token's mints, its declarations; else the section its ctx names.
    var din = ev && typeof ev === "object" && !isArray(ev) ? ev : {};
    // A built-in row's values are the seed's, whatever inputs the rule names (a seeded row has no
    // mint and no declaration to show): the seed is their evidence (audit 03-E1a findings R3A, R4A).
    if (c.seed) din = {};
    if (din.address && isHex(txt(din.address))) {
      v.links.push({ href: hashContract(txt(din.address)), text: "input: the contract",
        title: txt(din.address) + " (open the contract)" });
    }
    if (own(din, "mintCount") && c.token) {
      var mi = sectionEvidence(c, "mints");
      if (mi) { mi.text = "input: the mint history"; v.links.push(mi); }
    }
    if (own(din, "declared") && c.token) {
      var dl = sectionEvidence(c, "traits");
      if (dl) { dl.text = "input: the declarations"; v.links.push(dl); }
    }
    var dt = txEvidence(din.txHash, "input: tx");
    if (dt) v.links.push(dt);
    if (v.links.length === 0 && c.seed) v.links.push(SEED_EVIDENCE);
    if (v.links.length === 0 && c.api) {
      v.links.push({ href: c.api, text: "the token's row (API)", title: "the token as the API serves it (raw JSON, new tab)" });
    }
    if (v.links.length === 0 && c.section) {
      var ds = sectionEvidence(c, c.section);
      if (ds) v.links.push(ds);
    }
  } else {
    v.reason = o.reason ? txt(o.reason) : "no reason given";
    v.label = ORIGIN_LABELS[kind] + " (" + v.reason + ")";
    texts.push(v.reason);
    var np = evidenceList(ev);
    for (var j = 0; j < np.length; j++) {
      if (!np[j].txHash) continue;
      texts.push("the declaration: " + packageText(np[j]));
      var nl = txEvidence(np[j].txHash, "declaration tx");
      if (nl) v.links.push(nl);
    }
  }
  if (v.page) texts.push(PAGE_NOTE);
  v.detail = texts.join(" · ");
  return v;
}

// ── MIP-0018 history: every applied declaration of a key, newest first (P1 order) ───────────

function declarationsOf(events, t) {
  var byKey = {};
  var list = arr(events);
  if (!t) return byKey;
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (!e || e.applied !== true) continue;
    if (txt(e.domainSep) !== txt(t.domainSep)) continue;
    if (Number(e.kindByte) !== Number(t.kind)) continue;
    var k = txt(e.keyHex === undefined || e.keyHex === null ? e.key : e.keyHex);
    if (!own(byKey, k)) byKey[k] = [];
    byKey[k].push(e);
  }
  for (var key in byKey) {
    if (!own(byKey, key)) continue;
    byKey[key].sort(function (a, b) {
      if (Number(a.blockHeight) !== Number(b.blockHeight)) return Number(b.blockHeight) - Number(a.blockHeight);
      if (Number(a.txPosition) !== Number(b.txPosition)) return Number(b.txPosition) - Number(a.txPosition);
      return Number(b.eventId) - Number(a.eventId);
    });
  }
  return byKey;
}
function declaredValueText(e) {
  if (!e) return "-";
  if (Number(e.valType) === 5) return "Null (the key was cleared)";
  if (Number(e.valType) === 2 && e.integer !== null && e.integer !== undefined) return txt(e.integer);
  if (e.text !== null && e.text !== undefined) return txt(e.text);
  if (e.value) return "0x" + shortHex(txt(e.value), 10, 8);
  return "(empty)";
}

// ── the token view ───────────────────────────────────────────────────────────────────────────

function hashTokenSection(t, section) { return hashToken(t) + "/" + enc(section); }
// Where a token's identity (domain separator, kind byte) is carried, so its evidence link lands on
// rows that show it: its declarations when it was declared, its mints when it was only minted, the
// public movements of a colour no contract named (audit 03-E1a finding F8).
// The observation that set a token's first-seen height, so its evidence link lands on it: a mint at
// that height, else an APPLIED declaration of this token at that height (a rejected one never
// updated the token), else — only when the page read all of the contract's events — a public
// movement, where the view lists them. Anything else is not known to the page and is not guessed
// (audit 03-E1a findings R2I, R3D, R4B): null, and the value cites the API's row that carries it.
function firstSeenSection(t, events, unknownRead) {
  if (!t || t.status === "builtin") return null;
  var h = Number(t.firstSeenHeight);
  if (t.firstMintHeight !== null && t.firstMintHeight !== undefined && Number(t.firstMintHeight) === h) return "mints";
  var list = arr(events);
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    if (e && e.applied === true && txt(e.domainSep) === txt(t.domainSep) && Number(e.kindByte) === Number(t.kind)
      && Number(e.blockHeight) === h) return "events";
  }
  if (unknownRead) return null;
  var vis = visibilityOf(t);
  return vis === "full" || vis === "disclosed-imbalances" ? "activity" : null;
}
// The API's own row of a token (raw JSON), the evidence of a value the page cannot place better.
function tokenApiHref(t) {
  return t.address && t.domainSep ? tokenBase(t) : P_COLORS + "/" + enc(t.color);
}
function identitySection(t) {
  if (!t) return null;
  if (t.status === "builtin") return null;
  if (!t.address || !t.domainSep) return "activity";
  return t.status === "observed" ? "mints" : "events";
}
function valueOrNull(v) { return v === null || v === undefined || v === "" ? null : txt(v); }

// Every value the token view shows, each with its origin, section by section. "all" lists every
// item once, so a reader (or a test) can walk the whole view without knowing its layout.
function tokenModel(d) {
  var t = d && d.token ? d.token : null;
  if (!t) return null;
  var o = t.origins || {};
  var events = arr(d.events);
  var decls = declarationsOf(events, t);
  var ctx = { token: t, address: t.address };
  var builtin = t.status === "builtin";
  var seen = !t.address || !t.domainSep;
  var seeded = pageOrigin("derived", "a seeded built-in row: the ledger's own token (00020 owner decision Q7)");
  var noContract = pageOrigin("none", "no contract is known for this colour (status seen)");
  var partial = d.eventsMore === true;
  // How many applied declarations a key has among the events read; when the contract has more
  // events than the page reads, the current declaration may lie beyond them and counts as one more.
  // Only declarations that come BEFORE the current one in P1's order count, or are listed as earlier:
  // the metadata and the events are two reads, and a declaration indexed between them is newer than
  // the current value the page shows — never "earlier" (audit 03-E1a finding R3G).
  function earlier(e, cur) {
    if (!cur) return true;
    var fin = function (v) { return v !== null && v !== undefined && isFinite(Number(v)); };
    // a place the payload does not give is not compared (an older API row, a colour document's trait)
    if (fin(cur.blockHeight) && fin(e.blockHeight) && Number(e.blockHeight) !== Number(cur.blockHeight)) {
      return Number(e.blockHeight) < Number(cur.blockHeight);
    }
    if (fin(cur.txPosition) && fin(e.txPosition) && Number(e.txPosition) !== Number(cur.txPosition)) {
      return Number(e.txPosition) < Number(cur.txPosition);
    }
    return fin(cur.eventId) && fin(e.eventId) ? Number(e.eventId) < Number(cur.eventId) : true;
  }
  function declCountOf(keyId, cur) {
    var l = decls[keyId] || [];
    var have = false;
    var n = 0;
    for (var i = 0; i < l.length; i++) {
      if (cur && Number(l[i].eventId) === Number(cur.eventId)) { have = true; n++; } else if (earlier(l[i], cur)) n++;
    }
    return n + (!have && cur ? 1 : 0);
  }
  // Where the current declaration of a fact sits: its package's place (P1: the first part).
  function currentOf(origin) {
    var pk = origin && origin.origin === "mip-0018" ? evidenceList(origin.evidence)[0] : null;
    return pk ? { blockHeight: pk.blockHeight, txPosition: pk.txPosition, eventId: eventIdsOf(pk)[0] } : null;
  }
  function declCount(keyText) { return declCountOf(asciiHex(keyText), currentOf(o[keyText])); }
  function item(field, label, value, origin, extra) {
    var c = extra || ctx;
    // A built-in row's values are the indexer's seed, a rule with no chain inputs: their evidence is
    // the seed itself, as the API serves it (audit 03-E1a findings R2A, R3A).
    if (builtin) {
      var cc = {};
      for (var k in c) if (own(c, k)) cc[k] = c[k];
      cc.seed = true;
      c = cc;
    }
    var it = { field: field, label: label, value: valueOrNull(value), origin: originView(origin, c) };
    return it;
  }
  var facts = [];
  // Where this token's identity is carried (and, for a built-in row, where the chain shows it).
  var idCtx = { token: t, section: identitySection(t) };
  facts.push(item("address", "address",
    builtin ? "built-in row, no contract" : (seen ? "unknown" : t.address),
    builtin ? seeded : (seen ? noContract : pageOrigin("chain",
      "the contract that declared or minted this token; its deploy and calls are on the contract view",
      { contract: t.address })), builtin ? idCtx : undefined));
  facts.push(item("domainSep", "domainSep", seen ? "unknown" : t.domainSep,
    builtin ? seeded : (seen ? noContract : pageOrigin("chain",
      "MIP-0018 §4: carried by every declaration and mint of this token")), idCtx));
  facts.push(item("kind", "kind", orDash(t.kind) + "  (" + kindLabel(t) + ")",
    builtin ? seeded : pageOrigin("chain", "MIP-0018 §3: the kind byte carried by this token's declarations and mints"), idCtx));
  facts.push(item("privacy", "privacy", t.privacy,
    pageOrigin("derived", "MIP-0018 §3: bit 0 of the kind byte"), idCtx));
  facts.push(item("storage", "storage", t.storage,
    pageOrigin("derived", "MIP-0018 §3: bit 1 of the kind byte"), idCtx));
  // The family badge of the heading is a value of its own, derived from the token's storage and its
  // contract's rows — never under the name's origin (audit 03-E1a finding R3B).
  var fam = familyOf(t, familyIndex(d.siblings && d.siblings.length ? d.siblings : [t]));
  if (fam !== null) {
    facts.push(item("family", "family", fam, pageOrigin("derived", FAMILY_RULE, t.address ? { address: t.address } : null), idCtx));
  }
  // A colour seen in public data only (status seen) cites no transaction: its evidence is the
  // token's public movements (audit 03-E1a finding F7).
  facts.push(item("color", "colour", t.color, o.color, { token: t, address: t.address, section: seen ? "activity" : null }));
  facts.push(item("name", "name", t.name, o.name, { token: t, address: t.address, declarations: declCount("name"), partial: partial }));
  facts.push(item("symbol", "symbol", t.symbol, o.symbol, { token: t, address: t.address, declarations: declCount("symbol"), partial: partial }));
  facts.push(item("decimals", "decimals", t.decimals, o.decimals, { token: t, address: t.address, declarations: declCount("decimals"), partial: partial }));
  facts.push(item("tokenUri", "tokenUri", t.tokenUri, o.tokenUri, { token: t, address: t.address, declarations: declCount("tokenUri"), partial: partial }));
  facts.push(item("status", "status", t.status, o.status));
  var mintCtx = { token: t, section: "mints" };
  facts.push(item("mintCount", "mint count", t.mintCount, o.mints, mintCtx));
  facts.push(item("totalMinted", "total minted", t.totalMinted, o.mints, mintCtx));
  facts.push(item("firstMintHeight", "first mint height", t.firstMintHeight, o.mints, mintCtx));
  facts.push(item("lastMintHeight", "last mint height", t.lastMintHeight, o.mints, mintCtx));
  var fsSection = firstSeenSection(t, events, partial || d.eventsFailed === true);
  facts.push(item("firstSeenHeight", "first seen height", t.firstSeenHeight,
    builtin ? seeded : pageOrigin("derived", "the lowest block height at which a declaration, a mint or a public movement of this token was seen"
      + (fsSection === null ? " — the observation that set it is not among what this page read; the API's row carries the height" : "")),
    fsSection === null ? { token: t, api: tokenApiHref(t) } : { token: t, section: fsSection }));
  facts.push(item("metadataUpdatedHeight", "metadata updated height", t.metadataUpdatedHeight,
    t.metadataUpdatedHeight === null || t.metadataUpdatedHeight === undefined
      ? pageOrigin("none", builtin ? "a built-in row carries no declaration" : "no applied declaration")
      : pageOrigin("derived", "the block of this token's latest applied MIP-0018 declaration"),
    { token: t, section: "traits" }));
  facts.push(item("deployHeight", "deploy height", t.deployHeight,
    builtin ? seeded : (t.deployHeight === null || t.deployHeight === undefined
      ? pageOrigin("none", seen ? "no contract is known for this colour (status seen)" : "the contract's deploy is not in the archive")
      : pageOrigin("chain", "the block of the contract's deploy transaction (on the contract view)", { contract: t.address })),
    builtin ? idCtx : undefined));
  var vis = visibilityOf(t);
  if (t.activityCount !== undefined) {
    var actOrigin = vis === "not-tracked" ? pageOrigin("none", "DUST is not tracked per token: every transaction pays a fee (Q13)")
      : (vis === "calls-only" ? pageOrigin("none", "a ledger kind has no colour and so no activity row; its contract's calls are listed instead (US7)")
        : pageOrigin("chain", "00023: the counted public movements of this token in archived transactions"));
    facts.push(item("activityCount", "activity rows", t.activityCount, actOrigin, { token: t, section: "activity" }));
    facts.push(item("lastActivityHeight", "last activity height", t.lastActivityHeight, actOrigin, { token: t, section: "activity" }));
  }
  // What the visibility decides is which section below lists this token's public data: it links it
  // (audit 03-E1a finding R2A).
  facts.push(item("visibility", "what the chain lets this page show", visibilityOf(t),
    pageOrigin("derived", "00023 §5: what the ledger publishes for this kind of token (DUST: not tracked, Q13)"),
    { token: t, section: vis === "calls-only" ? (t.address ? "calls" : null) : (vis === "not-tracked" ? null : "activity") }));
  var disclosure = [];
  if (vis === "disclosed-imbalances") {
    disclosure.push(item("disclosedTransactions", "transactions disclose this colour", t.disclosedTransactions,
      pageOrigin("chain", "00023 US4: transactions whose offers publish this colour's net imbalance"), { token: t, section: "activity" }));
    disclosure.push(item("undisclosedShieldedOffers", "shielded offers publish no colour", t.undisclosedShieldedOffers,
      pageOrigin("chain", "00023 FR-018: zswap offers on this chain that publish no colour at all",
        { list: "shielded-offers" })));
  }

  // The contract's public interface, as the token route carries it: status and levels, no URL.
  var iface = t.interface;
  var ifaceItem = item("interface", "public interface",
    iface ? interfaceStatusView(iface).text : null,
    iface ? iface.origin : (builtin ? pageOrigin("none", "a built-in row has no contract") : (seen
      ? noContract : pageOrigin("none", "this token's contract has published no public interface"))),
    { token: t, address: t.address });
  ifaceItem.status = iface ? interfaceStatusView(iface) : null;

  var metadata = item("metadata", "metadata document",
    t.metadata === null || t.metadata === undefined ? null : jsonText(t.metadata), o.metadata,
    { token: t, address: t.address, declarations: declCount("metadata"), partial: partial });

  var traits = [];
  // at most TRAIT_ROWS keys are drawn (the traits section says how many there are, with a link to all)
  var keysAll = arr(d.keys);
  var keys = keysAll.slice(0, TRAIT_ROWS);
  for (var k = 0; k < keys.length; k++) {
    var kv = keys[k];
    var keyId = txt(kv.keyHex === undefined || kv.keyHex === null ? asciiHex(kv.key) : kv.keyHex);
    var all = decls[keyId] || [];
    var cur = { blockHeight: kv.updatedHeight, txPosition: kv.txPosition, eventId: kv.eventId };
    var history = [];
    for (var h = 0; h < all.length; h++) {
      if (Number(all[h].eventId) === Number(kv.eventId) || !earlier(all[h], cur)) continue;
      var he = all[h];
      var hi = item("trait:" + keyId + ":" + he.eventId, "earlier declaration", declaredValueText(he), he.origin, { token: t, address: t.address });
      hi.eventId = he.eventId; hi.blockHeight = he.blockHeight; hi.txPosition = he.txPosition;
      hi.txHash = he.txHash; hi.valType = he.valType; hi.parts = he.parts; hi.phase = he.phase;
      history.push(hi);
    }
    var ti = item("trait:" + keyId, kv.key === null || kv.key === undefined ? "0x" + keyId : txt(kv.key),
      traitText(kv), kv.origin, { token: t, address: t.address, declarations: declCountOf(keyId, cur), partial: partial });
    ti.trait = kv; ti.history = history; ti.parts = kv.parts; ti.phase = kv.phase;
    traits.push(ti);
  }

  var mints = [];
  var ml = arr(d.mints);
  for (var m = 0; m < ml.length; m++) {
    var mi = item("mint:" + ml[m].txHash + ":" + ml[m].segment + ":" + ml[m].callIndex, "mint",
      ml[m].amount, ml[m].origin, { token: t, section: "mints" });
    mi.row = ml[m];
    mints.push(mi);
  }
  var activity = [];
  var al = d.activity ? arr(d.activity.items) : [];
  for (var a = 0; a < al.length; a++) {
    var ai = item("activity:" + [al[a].txHash, al[a].segment, al[a].section, al[a].role, al[a].itemIndex].join(":"),
      roleLabel(al[a]), al[a].amount, al[a].origin, { token: t, section: "activity" });
    ai.row = al[a];
    activity.push(ai);
  }
  var calls = callsModel(d.calls, t.address);
  var siblings = [];
  var sl = arr(d.siblings);
  for (var s = 0; s < sl.length; s++) {
    var sib = sl[s];
    if (!sib || txt(sib.domainSep) !== txt(t.domainSep) || Number(sib.kind) === Number(t.kind)) continue;
    siblings.push(siblingItems(sib, SIBLING_FIELDS));
  }
  var ev = eventsModel(events, t.domainSep, t.address);
  var model = {
    token: t, facts: facts, disclosure: disclosure, iface: ifaceItem, metadata: metadata,
    traits: traits, mints: mints, activity: activity, calls: calls, siblings: siblings, events: ev,
    historyPartial: partial, mintsMore: d.mintsMore === true,
    traitsMore: keysAll.length > TRAIT_ROWS ? keysAll.length : null,
    // how many keys the API serves: a count of the token's own, drawn in the traits section's note
    traitsCount: keysAll.length > TRAIT_ROWS ? item("traits:count", "keys", keysAll.length,
      pageOrigin("derived", "the number of keys GET …/metadata serves for this token"),
      { token: t, api: t.address && t.domainSep ? tokenBase(t) + "/metadata" : P_COLORS + "/" + enc(t.color) }) : null
  };
  model.all = collectItems(model);
  return model;
}
function jsonText(v) {
  try { return JSON.stringify(v, null, 2); } catch (e) { return txt(v); }
}
function traitText(tr) {
  if (Number(tr.valType) === 5) return "Null (the key was cleared)";
  if (Number(tr.valType) === 2 && tr.integer !== null && tr.integer !== undefined) return txt(tr.integer);
  if (tr.text !== null && tr.text !== undefined) return txt(tr.text);
  if (tr.value) return "0x" + txt(tr.value);
  return "(empty)";
}
// A row of another table (the contract's tokens, the rows sharing a domain separator): each value
// the row shows — exactly the columns it has — with its own origin from the token's "origins".
var SIBLING_FIELDS = ["kind", "color", "name", "symbol", "decimals", "mints", "status"];
var CONTRACT_TOKEN_FIELDS = ["domainSep", "kind", "color", "name", "symbol", "decimals", "mints", "status"];
function siblingItems(t, fields) {
  var o = t.origins || {};
  var ctx = { token: t, address: t.address };
  var base = "row:" + t.domainSep + ":" + t.kind + ":";
  var identity = pageOrigin("chain", "MIP-0018 §3–§4: carried by every declaration and mint of this token");
  var idCtx = { token: t, section: identitySection(t) };
  var all = {
    domainSep: { value: t.domainSep, origin: identity, ctx: idCtx },
    kind: { value: t.kind, origin: identity, ctx: idCtx },
    color: { value: t.color, origin: o.color, ctx: ctx },
    name: { value: t.name, origin: o.name, ctx: ctx },
    symbol: { value: t.symbol, origin: o.symbol, ctx: ctx },
    decimals: { value: t.decimals, origin: o.decimals, ctx: ctx },
    mints: { value: t.mintCount, origin: o.mints, ctx: { token: t, section: "mints" } },
    status: { value: t.status, origin: o.status, ctx: ctx }
  };
  var items = [];
  for (var i = 0; i < fields.length; i++) {
    var f = all[fields[i]];
    items.push({ field: base + fields[i], label: fields[i], value: valueOrNull(f.value), origin: originView(f.origin, f.ctx) });
  }
  return { token: t, items: items };
}
function callsModel(page, address) {
  var out = [];
  var items = page ? arr(page.items) : [];
  for (var i = 0; i < items.length; i++) {
    var c = items[i];
    // A call row carries no origin on the wire (ContractCallJson): it IS a transcript of an
    // archived transaction, so the page labels it with that transaction as its evidence (Q28).
    var origin = c.origin ? c.origin : pageOrigin("chain", "a call of this contract in an archived transaction",
      { txHash: c.txHash, blockHeight: c.blockHeight, txPosition: c.txPosition, segment: c.segment, callIndex: c.callIndex });
    out.push({ field: "call:" + c.txHash + ":" + c.segment + ":" + c.callIndex, label: "call",
      value: valueOrNull(c.entryPoint === null || c.entryPoint === undefined ? "call " + c.callIndex : c.entryPoint),
      origin: originView(origin, { address: address, section: "calls" }), row: c });
  }
  return out;
}
function eventsModel(events, markDomain, address) {
  var out = [];
  var ordered = orderEvents(arr(events), markDomain);
  for (var i = 0; i < ordered.length; i++) {
    var e = ordered[i];
    var id = e.eventId === undefined ? e.id : e.eventId;
    out.push({ field: "event:" + id, label: "event " + id, value: declaredValueText(e),
      origin: originView(e.origin, { address: address, section: "events" }), row: e });
  }
  return out;
}
function collectItems(model) {
  var all = [];
  function push(list) { for (var i = 0; i < list.length; i++) all.push(list[i]); }
  push(model.facts || []);
  push(model.disclosure || []);
  if (model.iface) all.push(model.iface);
  if (model.metadata) all.push(model.metadata);
  var traits = model.traits || [];
  for (var t = 0; t < traits.length; t++) { all.push(traits[t]); push(traits[t].history || []); }
  push(model.mints || []);
  push(model.activity || []);
  push(model.calls || []);
  var sib = (model.siblings || []).concat(model.tokens || []);
  for (var s = 0; s < sib.length; s++) push(sib[s].items);
  push(model.events || []);
  if (model.face) {
    push(model.face.rows); push(model.face.files); push(model.face.keys); push(model.face.circuits);
    push(model.face.witnesses); push(model.face.checks); push(model.face.history); push(model.face.roles || []);
  }
  push(model.pending || []);
  if (model.traitsCount) all.push(model.traitsCount);
  if (model.tokensCount) all.push(model.tokensCount);
  return all;
}

// ── the contract view and its public interface ──────────────────────────────────────────────

// A URL may be 262 112 bytes (256 parts of [Y]): the page shows its head and tail and copies the
// whole of it; only http(s) becomes a link.
var URL_HEAD = 72;
var URL_TAIL = 28;
// A publication's URL view is computed once per publication object: the interface payload is kept
// across refreshes while its summary is unchanged (E1a-F4), and a URL may be 262 112 bytes, so the
// 10 s re-render must not parse up to 101 of them again.
var URL_VIEWS = typeof WeakMap === "function" ? new WeakMap() : null;
function urlViewOf(p) {
  if (!p || typeof p !== "object") return urlView(null);
  if (URL_VIEWS !== null && URL_VIEWS.has(p)) return URL_VIEWS.get(p);
  var uv = urlView(p.url);
  if (URL_VIEWS !== null) URL_VIEWS.set(p, uv);
  return uv;
}
function urlView(url) {
  var s = url === null || url === undefined ? "" : txt(url);
  var n = s.length;
  var cut = n > URL_HEAD + URL_TAIL + 1;
  var low = s.slice(0, 8).toLowerCase();
  var mark = ":" + "//";
  var linkable = low.indexOf("http" + mark) === 0 || low.indexOf("https" + mark) === 0;
  var dest = linkable ? urlDest(s) : null;
  return {
    full: s, length: n, shortened: cut,
    short: cut ? s.slice(0, URL_HEAD) + "…" + s.slice(n - URL_TAIL) : s,
    href: dest !== null && !dest.userinfo && dest.host !== "" ? s : null,
    host: dest !== null ? dest.host : null, userinfo: dest !== null && dest.userinfo
  };
}
// Where a contract whose deploy is not archived shows its address: the first of its calls, its
// declaration events, its public interface, its token rows that the page has (audit 03-E1a finding
// R3H: a contract that only minted or published an interface cited an empty events section).
function addressSection(c) {
  if (c.calls && arr(c.calls.items).length > 0) return "calls";
  if (arr(c.events).length > 0) return "events";
  if (c.iface) return "interface";
  if (c.contract && arr(c.contract.tokens).length > 0) return "tokens";
  return null;
}
function contractModel(c) {
  var d = c && c.contract ? c.contract : null;
  if (!d) return null;
  var address = d.address;
  var ctx = { address: address };
  var deployKnown = d.deployTxHash !== null && d.deployTxHash !== undefined;
  // Without an archived deploy and with none of its other reads at hand (they failed), the address is
  // still carried by the publication the contract route's interface summary cites (R4E).
  var addrSec = deployKnown ? null : addressSection(c);
  var pubEv = d.interface && d.interface.origin && d.interface.origin.evidence ? d.interface.origin.evidence : null;
  var pubTx = pubEv && isHex(txt(pubEv.txHash)) ? txt(pubEv.txHash) : null;
  var deploy = deployKnown
    ? pageOrigin("chain", "the contract's deploy transaction in the archive", { txHash: d.deployTxHash, blockHeight: d.deployHeight })
    : pageOrigin("none", "the contract's deploy is not in the archive");
  function it(field, label, value, origin, extra) {
    return { field: field, label: label, value: valueOrNull(value), origin: originView(origin, extra || ctx) };
  }
  var facts = [
    it("address", "address", address, deployKnown
      ? pageOrigin("chain", "the address the deploy transaction created", { txHash: d.deployTxHash })
      : pageOrigin("chain", "the address its calls, declarations, publications and tokens carry",
        addrSec === null && pubTx ? { txHash: pubTx } : null),
      { address: address, section: addrSec || "calls" }),
    it("deployHeight", "deploy height", d.deployHeight, deploy),
    it("deployTxHash", "deploy tx", d.deployTxHash, deploy),
    it("lastCallHeight", "last call height", d.lastCallHeight,
      d.lastCallHeight === null || d.lastCallHeight === undefined
        ? pageOrigin("none", "no call of this contract is archived")
        : pageOrigin("chain", "the block of this contract's latest archived call"), { address: address, section: "calls" })
  ];
  var tokens = [];
  var list = itemsOf(d.tokens ? { items: d.tokens } : null);
  // at most CONTRACT_TOKEN_ROWS token rows are drawn; the count of all of them is a value of its own
  for (var i = 0; i < list.length && i < CONTRACT_TOKEN_ROWS; i++) tokens.push(siblingItems(list[i], CONTRACT_TOKEN_FIELDS));
  var tokensCount = list.length > CONTRACT_TOKEN_ROWS
    ? it("tokens:count", "token rows", list.length, pageOrigin("derived", "the number of token rows GET /v1/contracts/:address serves"),
      { address: address, api: P_CONTRACTS + "/" + enc(address) })
    : null;
  var pending = [];
  var pl = arr(d.pendingLookups);
  for (var p = 0; p < pl.length; p++) {
    pending.push(it("pending:" + pl[p].txHash, "pending lookup", pl[p].lastError || (pl[p].got + "/" + pl[p].expected),
      pageOrigin("derived", "the scanner's pending event lookup for this transaction: events expected against events read",
        { txHash: pl[p].txHash })));
  }
  var model = {
    contract: d, facts: facts, tokens: tokens, pending: pending, tokensCount: tokensCount,
    face: interfaceModel(c.iface, address, c.ifaceLoaded !== false),
    calls: callsModel(c.calls, address), events: eventsModel(c.events, null, address)
  };
  model.all = collectItems(model);
  return model;
}
// The "Public interface" section: GET /v1/contracts/:address/interface, every value with its origin.
function interfaceModel(x, address, loaded) {
  var ctx = { address: address };
  if (!x) {
    return {
      present: false, unavailable: !loaded,
      rows: [{ field: "iface:none", label: "public interface", value: null,
        origin: originView(loaded ? pageOrigin("none", "this contract has published no public interface")
          : pageOrigin("none", "the interface could not be read: see partial data"), ctx) }],
      files: [], keys: [], circuits: [], witnesses: [], checks: [], history: []
    };
  }
  var O = x.origin;
  var st = interfaceStatusView(x);
  var rows = [];
  var roleCtx = { address: address, section: "interface" };
  function row(field, label, value, extra, own0) {
    var r = { field: "iface:" + field, label: label, value: valueOrNull(value),
      origin: own0 ? originView(own0, roleCtx) : originView(O, ctx) };
    if (extra) for (var k in extra) if (own(extra, k)) r[k] = extra[k];
    rows.push(r);
    return r;
  }
  row("status", "status", st.text, { status: st });
  row("role", "role", x.role, { help: ROLE_HELP[x.role] || null }, roleOrigin(x));
  row("levels", "levels", levelsLine(x.levels));
  if (st.failedLevel !== null) row("failure", "failed at", "L" + st.failedLevel + (x.reason ? ": " + x.reason : ""), { diagnostic: true });
  else if (x.reason) row("reason", "reason", x.reason, { diagnostic: true });
  if (x.levels && x.levels.l3 !== "passed") {
    row("l3", "Level 3", orDash(x.levels.l3) + (x.l3Reason ? ": " + x.l3Reason : ""), { diagnostic: true });
  }
  row("commitment", "commitment", x.commitment, { hex: true });
  var uv = urlViewOf(x);
  if (x.url !== null && x.url !== undefined) row("url", "bundle URL", x.url, { url: uv });
  else row("url", "bundle URL", x.urlError ? "not decodable: " + x.urlError : null, { diagnostic: true });
  row("publication", "publication", packageText(x), { txHash: x.txHash });
  row("payload", "package payload", orDash(x.payloadLength) + " bytes · SHA-256 " + orDash(x.payloadSha256));
  row("checkedAt", "last check", x.checkedAt || "not checked yet");
  row("checks", "checks so far", x.checks);
  row("lastVerifiedAt", "last verified", x.lastVerifiedAt);
  row("verifiedUntil", "verified until", x.verifiedUntil);
  row("nextCheckAt", "next check", x.nextCheckAt);
  row("state", "contract state used", x.state ? "block " + orDash(x.state.blockHeight) + " · tx " + shortHex(txt(x.state.txHash || ""), 8, 6) : null,
    x.state && x.state.txHash ? { txHash: x.state.txHash } : null);
  row("compiler", "compiler", x.compiler ? orDash(x.compiler.name) + " " + orDash(x.compiler.version) : null);
  if (x.build) {
    row("build", "build", "compiler " + orDash(x.build.compiler) + " · language " + orDash(x.build.language)
      + " · runtime " + orDash(x.build.runtime) + " · interface " + orDash(x.build.interface)
      + " · flags " + (arr(x.build.flags).length === 0 ? "none" : arr(x.build.flags).map(txt).join(" ")));
  }
  row("publications", "publications of this contract", x.publications);
  // Items are keyed by their position, never by a published name: a name may be megabytes (E1a-F5).
  var files = [];
  var fl = arr(x.files);
  for (var f = 0; f < fl.length; f++) {
    files.push({ field: "iface:file:" + f, label: txt(fl[f].path), value: valueOrNull(fl[f].size),
      origin: originView(fl[f].origin, ctx), row: fl[f] });
  }
  var keys = [];
  var kl = arr(x.keys);
  for (var k = 0; k < kl.length; k++) {
    keys.push({ field: "iface:key:" + k, label: txt(kl[k].circuit), value: valueOrNull(kl[k].sha256),
      origin: originView(kl[k].origin, ctx), row: kl[k] });
  }
  var circuits = [];
  var cl = arr(x.circuits);
  for (var c = 0; c < cl.length; c++) {
    circuits.push({ field: "iface:circuit:" + c, label: txt(cl[c].name), value: circuitSignature(cl[c]),
      origin: originView(cl[c].origin, ctx), row: cl[c] });
  }
  var witnesses = [];
  var wl = arr(x.witnesses);
  for (var w = 0; w < wl.length; w++) {
    // A witness is a name the bundle's code declares; the API sends it as a plain string of the
    // interface, so it carries the interface's own origin.
    witnesses.push({ field: "iface:witness:" + w, label: "witness", value: valueOrNull(wl[w]), origin: originView(O, ctx) });
  }
  var checks = [];
  var chl = arr(x.checkHistory);
  for (var h = 0; h < chl.length; h++) {
    var ch = chl[h];
    var base = O && O.evidence && typeof O.evidence === "object" ? O.evidence : {};
    var evc = {};
    for (var b in base) if (own(base, b)) evc[b] = base[b];
    evc.status = ch.status; evc.level = ch.level; evc.levels = ch.levels; evc.checkedAt = ch.checkedAt;
    checks.push({ field: "iface:check:" + ch.checkNo, label: "check " + ch.checkNo, value: interfaceStatusView(ch).text,
      origin: originView({ origin: "public-interface", evidence: evc }, ctx), row: ch, status: interfaceStatusView(ch) });
  }
  var history = [];
  var hl = arr(x.history);
  var roles = [];
  for (var q = 0; q < hl.length; q++) {
    var hi = { field: "iface:history:" + hl[q].eventId, label: "publication " + hl[q].eventId,
      value: interfaceStatusView(hl[q]).text, origin: originView(hl[q].origin, ctx), row: hl[q],
      status: interfaceStatusView(hl[q]), url: urlViewOf(hl[q]) };
    hi.role = { field: "iface:history:" + hl[q].eventId + ":role", label: "role", value: valueOrNull(hl[q].role),
      origin: originView(roleOrigin(hl[q]), roleCtx) };
    roles.push(hi.role);
    history.push(hi);
  }
  // The API serves the newest 100 older publications and the newest 100 checks: say how many there
  // are when that is fewer than all (audit 03-E1a finding F6), and link the paginated route.
  var olderTotal = Number(x.publications) - 1;
  // The indexer keeps a summary of the first 500 named circuits and flags that there were more in
  // its report (level2 circuitsTruncated): the circuits table says so (audit 03-E1a finding F12).
  var rl = x.report && typeof x.report === "object" && x.report.levels && typeof x.report.levels === "object" ? x.report.levels : {};
  var circuitsTruncated = !!(rl.l2 && typeof rl.l2 === "object" && rl.l2.circuitsTruncated === true);
  var checksTotal = Number(x.checks);
  return { present: true, status: st, rows: rows, files: files, keys: keys, circuits: circuits,
    witnesses: witnesses, checks: checks, history: history, roles: roles, url: uv, address: address,
    circuitsTruncated: circuitsTruncated,
    historyMore: olderTotal > hl.length ? olderTotal : null,
    checksMore: checksTotal > chl.length ? checksTotal : null };
}
// A note that shows a count of the interface (checks so far, publications) is another occurrence
// of that row: marked as it, with its origin chip (audit 03-E1a finding R3B).
function asOccurrence(n, face, field) {
  var r = null;
  for (var i = 0; i < face.rows.length; i++) if (face.rows[i].field === "iface:" + field) r = face.rows[i];
  if (r === null) return n;
  marked(n, r.field);
  n.appendChild(node("span", "  "));
  n.appendChild(originChip(r.origin));
  return n;
}
// "the newest 100 of 250 …": a table that shows fewer rows than exist says so.
function moreNote(shown, total, what, href, linkText) {
  var n = node("div", null, "note err");
  n.appendChild(node("span", "the newest " + groupDigits(shown) + " of " + groupDigits(total) + " " + what + " are shown"
    + (href ? " — all of them: " : "")));
  if (href) {
    var a = node("a", linkText);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    n.appendChild(a);
  }
  return n;
}
function circuitSignature(c) {
  var args = arr(c.arguments);
  var parts = [];
  for (var i = 0; i < args.length; i++) parts.push(orDash(args[i].name) + ": " + orDash(args[i].type));
  return orDash(c.name) + "(" + parts.join(", ") + "): " + orDash(c.resultType);
}

// ── the list: the interface column and the multi-part badges ────────────────────────────────

// Every MIP-0018 value of a list row that came in more than one part, or not in one guaranteed
// phase ([Y] §5; a mixed package is a publisher error, FR-002).
function multipartOf(t) {
  var out = [];
  var o = t && t.origins ? t.origins : {};
  for (var k in o) {
    if (!own(o, k) || !o[k] || o[k].origin !== "mip-0018") continue;
    var pk = evidenceList(o[k].evidence);
    for (var i = 0; i < pk.length; i++) {
      var parts = Number(pk[i].parts);
      var phase = pk[i].phase ? txt(pk[i].phase) : null;
      if (parts > 1 || (phase !== null && phase !== "guaranteed")) {
        out.push({ field: k, parts: parts, phase: phase });
      }
    }
  }
  return out;
}
// The list's interface column reads the row's own summary (status and levels). It shows no part
// badge: only GET /v1/interfaces carries a publication's part count, as whole publications with
// URLs of up to 262 112 bytes each — up to ~131 MB for 500 contracts on every refresh (audit 03-E1a
// finding F4; question Q30). The part count and phase are on the contract view.
function listInterfaceView(t) {
  if (!t || !t.interface) return null;
  return interfaceStatusView(t.interface);
}

// ── 00024-03: drawing an origin ─────────────────────────────────────────────────────────────
//
// An origin is drawn one of two ways: a CHIP (its label; a link to its first piece of evidence
// when it has one; the whole evidence line on hover) beside a value in a table, or a BLOCK (the
// chip, then the evidence line and every link) in the two "value · origin" tables. Every value
// row carries data-o = its field key, so the governed test can match what is drawn against the
// view model item for item.

function stopClick(ev) { ev.stopPropagation(); }
// An evidence link: the click stays on the link (a row's own click does not run) and follows it.
// Following the link the page is already on changes no fragment, so no hashchange fires — the
// section it names is scrolled to here instead (audit 03-E1a finding R3K).
// A "#…" evidence link is a route of this page; any other (the API's own answer, raw JSON) opens in
// a new tab, so the reader keeps the view.
function evidenceHref(a, href) {
  a.href = href;
  if (href.charAt(0) === "#") {
    a.addEventListener("click", followEvidence(href));
  } else {
    a.target = "_blank";
    a.rel = "noopener";
    a.addEventListener("click", stopClick);
  }
  return a;
}
function followEvidence(href) {
  return function (ev) {
    ev.stopPropagation();
    if (window.location.hash !== href) return;
    var f = routeOf(href).focus;
    var target = f ? document.getElementById(f) : null;
    if (target && target.scrollIntoView) target.scrollIntoView();
  };
}
function originChip(ov) {
  var first = ov.links.length > 0 ? ov.links[0] : null;
  var chip = node(first ? "a" : "span", ov.label, "orig or-" + ov.kind + (ov.page ? " or-page" : ""));
  if (first) {
    evidenceHref(chip, first.href);
  }
  chip.title = shown(ov.label + (ov.detail ? " — " + ov.detail : ""));
  chip.setAttribute("data-origin", ov.kind);
  return chip;
}
function p1Mark() {
  var s = node("span", "P1", "p1");
  s.title = P1_RULE;
  return s;
}
function originBlock(ov) {
  var wrap = node("div", null, "ob");
  var head = node("div", null, "row");
  head.appendChild(originChip(ov));
  if (ov.p1) head.appendChild(p1Mark());
  wrap.appendChild(head);
  var ev = node("div", null, "oev");
  ev.appendChild(node("span", ov.detail));
  for (var i = 0; i < ov.links.length; i++) {
    ev.appendChild(node("span", "  ·  "));
    var a = node("a", ov.links[i].text);
    evidenceHref(a, ov.links[i].href);
    a.title = shown(ov.links[i].title || ov.links[i].text);
    ev.appendChild(a);
  }
  wrap.appendChild(ev);
  return wrap;
}
// A value with its chip beside it, for the cells of a dense table.
function withOrigin(valueNode, ov) {
  var wrap = node("span", null, "vo");
  wrap.appendChild(valueNode);
  wrap.appendChild(originChip(ov));
  if (ov.p1) wrap.appendChild(p1Mark());
  return wrap;
}
function marked(n, field) { n.setAttribute("data-o", field); return n; }
function ifaceBadge(st) {
  var b = node("span", st.text, "badge ifb " + st.cls);
  b.title = shown(st.help + (st.notes.length > 0 ? " · " + st.notes.join(" · ") : ""));
  return b;
}
function partsChip(parts, phase, what) {
  var p = Number(parts);
  var ph = phase ? txt(phase) : null;
  var mixed = ph !== null && ph !== "guaranteed";
  var c = node("span", partsText(p) + (mixed ? " · " + ph : ""), mixed ? "pp pp-bad" : "pp");
  c.title = (what ? what + ": " : "") + "one [Y] multi-part package in " + partsText(p)
    + (ph ? ", " + ph + " phase" : "")
    + (ph === "mixed" ? " — mixed phase is a publisher error (FR-002): shown, not dropped" : "");
  return c;
}
// "1 · guaranteed" as plain text; a chip once there is more than one part, or another phase.
function partsPhaseCell(parts, phase) {
  if (parts === null || parts === undefined) return node("span", "-", "no");
  var ph = phase ? txt(phase) : null;
  if (Number(parts) > 1 || (ph !== null && ph !== "guaranteed")) return partsChip(parts, ph, null);
  return node("span", txt(parts) + (ph ? " · " + ph : ""), "note");
}
// The "value | origin" table of the token and contract views.
function factsTable(parent, items, valueOf) {
  var tb = tableIn(parent, ["", "value", "origin and evidence"]);
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var tr = marked(document.createElement("tr"), it.field);
    cell(tr, it.label, "k");
    cell(tr, valueOf(it), "fv");
    cell(tr, originBlock(it.origin), "ocell");
    tb.appendChild(tr);
  }
  return tb;
}
// A URL shortened for the eye and copied whole: the head, an ellipsis, the tail, its length.
function urlNode(uv) {
  var wrap = node("span", null, "urlv");
  if (uv.href) {
    var a = node("a", uv.short, "hex");
    a.href = uv.href;
    a.rel = "noreferrer noopener";
    a.target = "_blank";
    a.title = uv.shortened ? uv.length + " characters; use copy for the whole URL" : shown(uv.full);
    a.addEventListener("click", stopClick);
    wrap.appendChild(a);
  } else {
    wrap.appendChild(node("span", uv.short, "hex"));
  }
  if (uv.shortened) wrap.appendChild(node("span", "  (" + groupDigits(uv.length) + " characters)", "note"));
  // Where it leads, always in view: a shortened URL must not hide its host (E1a-F13).
  if (uv.host !== null) {
    wrap.appendChild(node("span", "  → " + clipText(uv.host, NAME_MAX).text, "note"));
    if (uv.userinfo) wrap.appendChild(node("span", "  (not a link: user information before the host)", "err"));
  }
  wrap.appendChild(node("span", "  "));
  var cp = copyable(uv.full, "copy", "cpbtn");
  cp.title = "copy the whole URL (" + uv.length + " characters)";
  wrap.appendChild(cp);
  return wrap;
}

// Bundle-derived text is the publisher's to choose and cheap to make huge (contract-info.json may be
// 8 MiB): a name, a path, a signature or a build field is drawn as its head and tail with its
// length, and copied whole (audit 03-E1a finding F5). Diagnostics arrive bounded by the indexer and
// are drawn as served; a URL has urlNode.
var NAME_MAX = 160;
var HISTORY_MAX = 160;
// A current trait value is drawn whole up to TRAIT_MAX characters, and at most TRAIT_ROWS keys of a
// token are drawn: 2 000 keys of 8 000 hidden characters each made 128 M drawn characters (R3E).
var TRAIT_MAX = 2048;
var TRAIT_ROWS = 500;
var CONTRACT_TOKEN_ROWS = 500;
var SIG_MAX = 400;
var TEXT_MAX = 1000;
// The budget holds for what is DRAWN: the marks shown() puts in place of hidden characters count
// too (one hidden character draws as eight), so head and tail are marked first, then cut (audit
// 03-E1a finding R2D). Only a bounded head and tail of the value are ever scanned.
function clipText(value, max) {
  var v = txt(value);
  var whole = v.length <= max ? shown(v) : null;
  if (whole !== null && whole.length <= max) return { text: whole, cut: false, length: v.length };
  var head = Math.floor(max * 0.7);
  var tail = max - head;
  var h = shown(v.slice(0, head)).slice(0, head);
  var t = shown(v.slice(Math.max(0, v.length - tail)));
  t = t.slice(Math.max(0, t.length - tail));
  return { text: h + "…" + t, cut: true, length: v.length };
}
// openKey (optional): the reader may ask for the whole value ("show all"), kept across refreshes.
function boundedNode(value, max, cls, openKey) {
  var open = !!(openKey && state.expandText[openKey]);
  var c = open ? { text: shown(txt(value)), cut: false, length: txt(value).length } : clipText(value, max);
  if (!c.cut && !open) return node("span", c.text, cls);
  var wrap = node("span", null, cls);
  wrap.appendChild(node("span", c.text));
  if (!open) wrap.appendChild(node("span", "  (" + groupDigits(c.length) + " characters)", "note"));
  wrap.appendChild(node("span", "  "));
  var cp = copyable(txt(value), "copy", "cpbtn");
  cp.title = "copy the whole value (" + c.length + " characters)";
  wrap.appendChild(cp);
  if (openKey) {
    var tg = node("button", open ? "show less" : "show all", "expand");
    tg.addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (open) delete state.expandText[openKey]; else state.expandText[openKey] = true;
      render();
    });
    wrap.appendChild(node("span", "  "));
    wrap.appendChild(tg);
  }
  return wrap;
}

// ── Loaders ─────────────────────────────────────────────────────────────────────────────────

function listQuery(cursor) {
  var qs = P_TOKENS + "?limit=" + (state.filters.mip ? LIST_LIMIT_FILTERED : LIST_LIMIT);
  if (state.filters.kind) qs += "&kind=" + enc(state.filters.kind);
  if (state.filters.storage) qs += "&storage=" + enc(state.filters.storage);
  if (state.filters.status) qs += "&status=" + enc(state.filters.status);
  if (state.filters.q) qs += "&q=" + enc(state.filters.q);
  if (cursor) qs += "&cursor=" + enc(cursor);
  return qs;
}
async function loadList(cursor) {
  var payload = await api(listQuery(cursor));
  var items = itemsOf(payload);
  state.list.items = cursor ? state.list.items.concat(items) : sortTokens(items);
  state.list.nextCursor = payload && payload.nextCursor ? payload.nextCursor : null;
  state.list.loaded = true;
}
function tokenBase(r) {
  return P_CONTRACTS + "/" + enc(r.address) + "/tokens/" + enc(r.domainSep) + "/" + enc(r.kind);
}
// Every token-metadata event of the contract, applied AND rejected: the route filters only when
// "applied" is given, and "applied=false" means the rejected ones alone (00024-03 finding: the page
// asked for that since 00020, so the table showed no applied declaration at all). The applied ones
// are what a key's MIP-0018 history is made of.
function contractEventsPath(address, cursor) {
  var p = P_CONTRACTS + "/" + enc(address) + "/events?limit=" + EVENT_LIMIT;
  if (cursor) p += "&cursor=" + enc(cursor);
  return p;
}
function eventsReadText() {
  return "the page reads a contract's first " + groupDigits(EVENT_PAGES * EVENT_LIMIT) + " events";
}
// FR-006 by (address, domainSep, kind); FR-008 by colour for a row that has no address yet (US5).
function activityPath(t, cursor) {
  var p;
  if (t.address && t.domainSep) p = tokenBase(t) + "/transactions?limit=" + ACT_LIMIT;
  else p = P_COLORS + "/" + enc(t.color) + "/transactions?limit=" + ACT_LIMIT + "&kind=" + enc(t.kind);
  if (state.act.role) p += "&role=" + enc(state.act.role);
  if (cursor) p += "&cursor=" + enc(cursor);
  return p;
}
function callsPath(address, cursor) {
  var p = P_CONTRACTS + "/" + enc(address) + "/calls?limit=" + CALL_LIMIT;
  if (cursor) p += "&cursor=" + enc(cursor);
  return p;
}
// "load more" is a page count, not a saved cursor: the 10 s refresh re-reads the same number of
// pages, so a reader who asked for 600 NIGHT rows still has them after it fires.
// A later page that fails keeps the pages already read: they come back with the cursor that could
// not be followed (so the caller knows more exist) and the error (audit 03-E1a finding R4G: 200 mints
// read, then a 503, showed "no mint observed"). Only a failed FIRST page is a failure.
async function loadPages(pathOf, pages) {
  var items = [];
  var cursor = null;
  var next = null;
  for (var i = 0; i < (pages > 0 ? pages : 1); i++) {
    var payload;
    try {
      payload = await api(pathOf(cursor));
    } catch (e) {
      if (i === 0) throw e;
      return { items: items, nextCursor: cursor, error: e };
    }
    items = items.concat(itemsOf(payload));
    next = payload && payload.nextCursor ? payload.nextCursor : null;
    if (!next) break;
    cursor = next;
  }
  return { items: items, nextCursor: next, error: null };
}
function partlyNote(notes, what, p) {
  if (p && p.error) notes.push(what + " partly unavailable (the pages after the first " + p.items.length + " rows): " + p.error.message);
}
async function loadToken(r) {
  var d = { token: null, keys: [], mints: [], events: [], siblings: [], activity: null,
    calls: null, notes: [] };
  if (r.color) {
    await loadSeenToken(r, d);
  } else {
    await loadNamedToken(r, d);
  }
  await loadTokenActivity(d);
  state.detail = d;
}
// A "seen" row (US5) has no token route to ask, so the colour document answers for it and the row
// of the route's kind is the one shown; its traits and mints travel with it (question Q17).
async function loadSeenToken(r, d) {
  var doc = await api(P_COLORS + "/" + enc(r.color));
  var rows = itemsOf(doc && doc.tokens ? { items: doc.tokens } : null);
  for (var i = 0; i < rows.length; i++) {
    if (txt(rows[i].kind) === txt(r.kind)) d.token = rows[i];
  }
  if (d.token === null && rows.length > 0) d.token = rows[0];
  if (d.token === null) throw new Error("404 TOKEN_NOT_FOUND: no row for colour " + r.color);
  // A colour whose row names its contract (a mint or a declaration completed it) is that token: it
  // is read as the token route reads it — its declarations, their history and P1 — not from the
  // colour document alone (audit 03-E1a finding R4D).
  if (d.token.address && d.token.domainSep && !isZeroHex(txt(d.token.address))) {
    await loadNamedToken({ address: txt(d.token.address), domainSep: txt(d.token.domainSep), kind: txt(d.token.kind) }, d);
    return;
  }
  d.keys = itemsOf(d.token.traits ? { items: d.token.traits } : null);
  d.mints = itemsOf(d.token.mints);
  d.mintsMore = !!(d.token.mints && d.token.mints.nextCursor);
  d.siblings = rows;
}
async function loadTokenActivity(d) {
  var t = d.token;
  var vis = visibilityOf(t);
  // DUST (Q13) asks for nothing: every transaction pays a fee, so there is no per-token list.
  if (vis === "not-tracked") return;
  if (vis === "calls-only") {
    if (!t.address) return;
    await loadPages(function (c) { return callsPath(t.address, c); }, state.act.pages).then(
      function (p) { d.calls = p; partlyNote(d.notes, "contract calls", p); },
      function (e) { d.notes.push("contract calls unavailable: " + e.message); });
    return;
  }
  await loadPages(function (c) { return activityPath(t, c); }, state.act.pages).then(
    function (p) { d.activity = p; partlyNote(d.notes, "transactions", p); },
    function (e) { d.notes.push("transactions unavailable: " + e.message); });
}
async function loadNamedToken(r, d) {
  d.token = await api(tokenBase(r));
  await Promise.all([
    api(tokenBase(r) + "/metadata").then(
      function (p) { d.keys = itemsOf(p); },
      function (e) { d.notes.push("traits unavailable: " + e.message); }),
    loadPages(function (c) { return tokenBase(r) + "/mints?limit=" + MINT_LIMIT + (c ? "&cursor=" + enc(c) : ""); }, MINT_PAGES).then(
      function (p) { d.mints = p.items; d.mintsMore = p.nextCursor !== null; partlyNote(d.notes, "mint history", p); },
      function (e) { d.notes.push("mint history unavailable: " + e.message); }),
    loadPages(function (c) { return contractEventsPath(r.address, c); }, EVENT_PAGES).then(
      function (p) { d.events = p.items; d.eventsMore = p.nextCursor !== null; partlyNote(d.notes, "raw events", p); },
      function (e) { d.eventsFailed = true; d.notes.push("raw events unavailable: " + e.message); }),
    // Every token row of this contract. Two things come out of it: the rows sharing this token's
    // domain separator, which the MIP (section 4) lets a consumer link as one asset's several
    // representations, and the family chip, which is derived from how the contract's rows relate.
    // The dedicated route GET /v1/contracts/:address/tokens/:domainSep serves the first alone; the
    // contract route serves both in one request, which is why the page asks for it instead.
    api(P_CONTRACTS + "/" + enc(r.address)).then(
      function (p) { d.siblings = itemsOf(p && p.tokens ? { items: p.tokens } : null); },
      function (e) { d.notes.push("related rows unavailable: " + e.message); })
  ]);
}
// The interface section's publication is read again only when the contract route's summary of it
// (event, status, levels, check times) changed: a publication with 100 older ones and their URLs can
// be megabytes, and the 10 s refresh must not download it again and again (audit 03-E1a finding F4).
// The summary describes the CURRENT publication only; an older one can still finish its own check
// (or retry) while the current one is unchanged. The kept document is therefore read again at least
// every IFACE_MAX_AGE_MS (audit 03-E1a finding R2C): at most one minute stale, at most one download
// a minute instead of one every 10 s refresh.
var IFACE_MAX_AGE_MS = 60000;
function ifaceKey(summary) {
  if (!summary || typeof summary !== "object") return null;
  var lv = summary.levels && typeof summary.levels === "object" ? summary.levels : {};
  return [summary.eventId, summary.status, summary.level, lv.l1, lv.l2, lv.l3, summary.checkedAt,
    summary.verifiedUntil, summary.l3Reason].map(txt).join("|");
}
async function loadContract(address) {
  var prev = state.contract && state.contract.address === address ? state.contract : null;
  var c = { address: address, contract: null, events: [], calls: null, notes: [], iface: null, ifaceLoaded: true, ifaceKey: null,
    ifaceAt: 0 };
  c.contract = await api(P_CONTRACTS + "/" + enc(address));
  var summary = c.contract ? c.contract.interface : undefined;
  c.ifaceKey = ifaceKey(summary);
  var ifaceLoad;
  if (summary === null) {
    ifaceLoad = null; // the contract route says: no publication
  } else if (c.ifaceKey !== null && prev !== null && prev.ifaceKey === c.ifaceKey && prev.iface
      && Date.now() - prev.ifaceAt < IFACE_MAX_AGE_MS) {
    c.iface = prev.iface;
    c.ifaceAt = prev.ifaceAt;
    ifaceLoad = null;
  } else {
    // 00024-02's route: the current publication with everything its checks established, and every
    // older one. A 404 is an answer ("none published"), not an error.
    ifaceLoad = api(P_CONTRACTS + "/" + enc(address) + "/interface").then(
      function (p) { c.iface = p; c.ifaceAt = Date.now(); },
      function (e) {
        if (e.status === 404) return;
        c.ifaceLoaded = false;
        c.notes.push("public interface unavailable: " + e.message);
      });
  }
  await Promise.all([
    ifaceLoad,
    loadPages(function (cur) { return contractEventsPath(address, cur); }, EVENT_PAGES).then(
      function (p) { c.events = p.items; c.eventsMore = p.nextCursor !== null; partlyNote(c.notes, "raw events", p); },
      function (e) { c.notes.push("raw events unavailable: " + e.message); }),
    // US7: the same calls table the ledger-token page shows, under the same note.
    loadPages(function (cur) { return callsPath(address, cur); }, state.act.pages).then(
      function (p) { c.calls = p; partlyNote(c.notes, "contract calls", p); },
      function (e) { c.notes.push("contract calls unavailable: " + e.message); })
  ]);
  state.contract = c;
}
// FR-007: the whole public decode of one transaction, computed on request from the archived bytes.
async function loadTx(hash) {
  var keep = state.tx && state.tx.hash === hash ? state.tx.raw : false;
  var doc = await api(P_TXS + "/" + enc(hash));
  state.tx = { hash: hash, doc: doc, raw: keep };
}
// FR-018: the chain-wide list behind the disclosure panel's number.
function offersPath(cursor) {
  var p = P_OFFERS + "?limit=" + OFFER_LIMIT;
  if (state.offers.undisclosed === "true" || state.offers.undisclosed === "false") {
    p += "&undisclosed=" + enc(state.offers.undisclosed);
  }
  if (cursor) p += "&cursor=" + enc(cursor);
  return p;
}
async function loadOffers() {
  var page = await loadPages(offersPath, state.offers.pages);
  state.offers.items = page.items;
  state.offers.nextCursor = page.nextCursor;
  state.offers.loaded = true;
}
async function loadStatus() { state.status = await api(P_STATUS); }

// ── Refresh: the status strip on every view, plus whatever the view needs ───────────────────

async function refresh() {
  if (state.busy) return;
  state.busy = true;
  var errors = [];
  var route = state.route;
  await loadStatus().then(function () {}, function (e) { errors.push("status: " + e.message); });
  try {
    if (route.view === "list") await loadList(null);
    else if (route.view === "token") await loadToken(route);
    else if (route.view === "contract") await loadContract(route.address);
    else if (route.view === "tx") await loadTx(route.hash);
    else if (route.view === "offers") await loadOffers();
  } catch (e) {
    errors.push(route.view + ": " + e.message);
  }
  state.errors = errors;
  if (errors.length === 0) state.lastOk = new Date();
  state.busy = false;
  render();
}

// ── Chrome: banner, strip, tabs, filters ────────────────────────────────────────────────────

function renderBanner() {
  var b = el("banner");
  clear(b);
  if (state.errors.length === 0) { b.hidden = true; return; }
  b.hidden = false;
  b.appendChild(node("div", "the API did not answer everything this view needs, so what is shown may be stale"));
  for (var i = 0; i < state.errors.length; i++) b.appendChild(node("div", "• " + state.errors[i]));
  if (state.lastOk) b.appendChild(node("div", "last complete refresh: " + state.lastOk.toLocaleTimeString(), "note"));
}
// The strip answers one question — is what I am looking at current? — and after the owner's
// Phase E review it answers it in four segments and nothing else:
//
//   net: stagenet  ·  chain tip 567117  ·  behind 1 234  ·  last updated 12 s ago
//
// What left, and why (owner decision Q24, refining Q21). "indexed" and "pending lookups" are
// diagnostics of the pipeline rather than of the page, and both keep their place on the status
// view, where the two raw positions sit beside them. "in sync" was a word printed to say that
// nothing was wrong: the **absence** of the "behind" segment says the same thing without asking
// anyone to read it, so the segment appears only while the index really is behind. The distance
// itself is still the Q21 number — chainHead − min(archiveTip, decodeCursor) — so a
// rebuilt-but-unscanned index cannot look level, and the archive's lead over the decoder is read
// on the status view, which shows both positions as their own rows.
//
// "last updated" is relative, because the question is never "at what o'clock" but "is this
// stale?", and it turns red past STALE_MS so a page whose refreshes have stopped says so.
var STALE_MS = 60000;
var STRIP_TICK_MS = 1000;
function cursorHeight(st) {
  var cur = st.decodeCursor || {};
  return cur.height === undefined || cur.height === null ? null : Number(cur.height);
}
function archiveHeight(st) {
  return st.archiveTip === undefined || st.archiveTip === null ? null : Number(st.archiveTip);
}
// "indexed" is the SMALLER of the two positions this pipeline has — how far the raw bytes have
// been fetched, and how far they have been decoded. Taking the minimum is what makes one number
// honest: after a rebuild the cursor is 0 while the archive still holds half a million blocks, and
// a strip that showed the archive's number would claim to be in sync while the index was empty.
// The gap between the two is read on the status view, which lists both positions as their own rows.
function indexedHeight(st) {
  var cur = cursorHeight(st);
  var tip = archiveHeight(st);
  if (cur === null) return tip;
  if (tip === null) return cur;
  return tip < cur ? tip : cur;
}
function behindHead(st) {
  var head = st.chainHead === undefined ? null : st.chainHead;
  var indexed = indexedHeight(st);
  if (head === null || indexed === null) return null;
  return Number(head) - indexed;
}
// The status view is a full technical listing, so it keeps the words for the two states the strip
// now expresses by saying nothing at all.
function behindText(st) {
  var b = behindHead(st);
  if (b === null) return "chain tip unavailable";
  if (b <= 0) return "in sync";
  return txt(b);
}
// A distance is a COUNT and its digits are grouped for reading; a height is an IDENTIFIER a reader
// compares digit by digit against another screen, so a height is never grouped. The separator is a
// non-breaking space, so the number cannot break across a line. (No regular expression and no
// backslash here — see the file header.)
function groupDigits(n) {
  var s = txt(n);
  var out = "";
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += String.fromCharCode(160);
    out += s.charAt(i);
  }
  return out;
}
// "12 s ago", not "11:17:43 PM": the reader's question is whether the numbers beside it are fresh.
// Seconds while seconds matter, then minutes, then hours — and a floor of "just now", because a
// page that refreshes every ten seconds would otherwise flicker through the first four.
function agoText(then, now) {
  if (!then) return "never updated";
  var secs = Math.floor((now - then.getTime()) / 1000);
  if (secs < 0) secs = 0;
  if (secs < 5) return "just now";
  if (secs < 60) return txt(secs) + " s ago";
  var mins = Math.floor(secs / 60);
  if (mins < 60) return txt(mins) + " min ago";
  return txt(Math.floor(mins / 60)) + " h ago";
}
function renderStrip() {
  var s = el("strip");
  clear(s);
  var st = state.status;
  if (!st) { s.appendChild(node("span", "status unavailable", "err")); return; }
  function sep() { s.appendChild(node("span", "  ·  ")); }
  s.appendChild(node("span", "net: "));
  s.appendChild(node("b", orDash(st.net)));
  sep();
  var head = st.chainHead === undefined || st.chainHead === null ? null : Number(st.chainHead);
  if (head === null) {
    // Said out loud, never as a dash or a zero distance: the page cannot tell how current it is.
    s.appendChild(node("span", "chain tip unavailable", "stale"));
  } else {
    s.appendChild(node("span", "chain tip "));
    s.appendChild(node("b", txt(head)));
  }
  var b = behindHead(st);
  if (b !== null && b > 0) {
    sep();
    s.appendChild(node("span", "behind "));
    s.appendChild(node("b", groupDigits(b)));
  }
  sep();
  var now = new Date();
  var stale = state.lastOk === null || now.getTime() - state.lastOk.getTime() > STALE_MS;
  s.appendChild(node("span",
    state.lastOk === null ? "never updated" : "last updated " + agoText(state.lastOk, now),
    stale ? "stale" : null));
}
function renderTabs() {
  var v = state.route.view;
  el("nav-list").className = v === "status" || v === "offers" ? "" : "on";
  el("nav-offers").className = v === "offers" ? "on" : "";
  el("nav-status").className = v === "status" ? "on" : "";
  el("filters").hidden = v !== "list";
}

// ── View: list ──────────────────────────────────────────────────────────────────────────────

// The list's "API" column: a link to the raw JSON behind the row, opened in a new tab. A row with
// a colour links to everything known about that colour; a colourless one (a ledger token, DUST)
// to its own token route. The icon is cloned from a <template> in the markup so the script never
// has to name the SVG namespace.
function apiHref(t) {
  return t.color ? P_COLORS + "/" + enc(t.color) : tokenBase(t);
}
function apiCell(t) {
  var href = apiHref(t);
  var a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener";
  a.className = "api";
  a.title = "raw JSON · " + href;
  a.setAttribute("aria-label", "raw JSON for this row");
  var tpl = document.getElementById("icon-link");
  if (tpl && tpl.content && tpl.content.firstElementChild) a.appendChild(tpl.content.firstElementChild.cloneNode(true));
  else a.textContent = "json";
  a.addEventListener("click", function (e) { e.stopPropagation(); });
  return a;
}
// ── MIP-0018: which rows have metadata published on chain ───────────────────────────────────
//
// A token's contract published token-metadata for it in exactly the two states MIP section 7.2
// calls declared (published, never minted) and described (published and minted); observed is
// a mint with nothing said about it, seen is a colour with no contract at all, and builtin is
// this indexer's own seed. BOTH event-name variants count: the draft name is the same standard at
// an earlier number, and the owner's decision is that a reader of the list is not asked to care
// Deliberately one line, so narrowing the rule to the final name later is a one-line change.
function hasMip0018(t) {
  return !!t && (t.status === "declared" || t.status === "described");
}
var MIP_HEAD = "Has metadata published on chain under MIP-0018";
// The check mark is an emoji so it reads as a mark rather than as a character in a data column;
// a row without metadata is left EMPTY on purpose — a cross in every second row would read as a
// failure, and "nothing published" is not one.
function mipCell(t) {
  var wrap = node("span");
  if (hasMip0018(t)) wrap.appendChild(withTitle(node("span", "✅", "mip"), MIP_HEAD));
  // 00024-03: a value that arrived as a multi-part package says how many parts, and its phase.
  var mp = multipartOf(t);
  for (var i = 0; i < mp.length; i++) wrap.appendChild(partsChip(mp[i].parts, mp[i].phase, mp[i].field));
  return wrap;
}
// The list is an index: the origin of each value it shows — and the link to its evidence — is on the
// token view, one click away (organizer question Q29, default (a); audit 03-E1a finding F1).
var LIST_ORIGIN_NOTE = "where each value came from (MIP-0018 declaration, public interface, chain "
  + "observation, derived by this indexer, not available) and the link to its evidence are on the token "
  + "view: click the row";
var IFACE_HEAD = "The contract's public interface: the result of its current publication and the "
  + "levels it passed (L1 files and commitment, L2 keys, L3 recompiled keys)";
function listIfaceCell(t) {
  var st = listInterfaceView(t);
  if (st === null) return node("span", "", "no");
  var wrap = node("span", null, "vo");
  wrap.appendChild(ifaceBadge(st));
  return wrap;
}
function withTitle(n, title) { n.title = shown(title); return n; }
// The frontend filter of the same rule (owner, Phase G). It filters the rows ALREADY LOADED, and
// listQuery asks the API for its maximum page while it is on, so a token with metadata cannot be
// hidden behind a page boundary the reader never sees.
function visibleListItems() {
  var items = state.list.items;
  if (!state.filters.mip) return items;
  var out = [];
  for (var i = 0; i < items.length; i++) if (hasMip0018(items[i])) out.push(items[i]);
  return out;
}
function renderList(main) {
  var sec = node("section");
  sec.appendChild(node("h2", "tokens"));
  var items = visibleListItems();
  el("count").textContent = state.list.loaded
    ? items.length + " row" + (items.length === 1 ? "" : "s") + (state.list.nextCursor ? " (more available)" : "")
    : "loading…";
  if (!state.list.loaded) {
    sec.appendChild(node("div", "loading…", "empty"));
    main.appendChild(sec);
    return;
  }
  if (items.length === 0 && state.filters.mip && state.list.items.length > 0) {
    sec.appendChild(node("div",
      "no loaded token has metadata published under MIP-0018. Clear the MIP-0018 filter to see "
      + "every row the other filters allow.", "empty"));
    main.appendChild(sec);
    return;
  }
  if (items.length === 0) {
    sec.appendChild(node("div",
      "no token matches. The indexer creates a row from an observed mint or an emitted token-metadata event; "
      + "on a quiet chain the built-in NIGHT and DUST rows are all there is.", "empty"));
    main.appendChild(sec);
    return;
  }
  // The family index reads the WHOLE loaded set, never the filtered one: "collection" means the
  // contract issues several domain separators, which is a fact about the contract and must not
  // change because a filter hid one of its rows.
  var index = familyIndex(state.list.items);
  var tbody = tableIn(sec, [{ label: "MIP-0018", title: MIP_HEAD },
    "colour", "domainSep", "address", "kind", "name", "symbol",
    "dec", "#mints (#tokens)", "first … last block", "status", { label: "interface", title: IFACE_HEAD },
    "tokenUri", "API"]);
  for (var i = 0; i < items.length; i++) {
    var t = items[i];
    var tr = document.createElement("tr");
    tr.className = t.status === "builtin" ? "pick built" : "pick";
    cell(tr, mipCell(t), "mipcol");
    cell(tr, colorCell(t.color, t.storage));
    cell(tr, listDomainCell(t));
    cell(tr, addressCell(t));
    cell(tr, kindCell(t));
    cell(tr, nameCell(t, index));
    cell(tr, t.symbol === null || t.symbol === undefined || t.symbol === "" ? "-" : boundedNode(t.symbol, NAME_MAX, ""));
    cell(tr, t.decimals === null || t.decimals === undefined ? "-" : txt(t.decimals), "num");
    cell(tr, mintsCell(t), "num");
    cell(tr, heightsCell(t));
    cell(tr, statusBadge(t.status));
    cell(tr, listIfaceCell(t));
    cell(tr, uriLink(t.tokenUri));
    cell(tr, apiCell(t), "apicol");
    (function (token) {
      tr.addEventListener("click", function () { go(hashToken(token)); });
    })(t);
    tbody.appendChild(tr);
  }
  if (state.list.nextCursor) {
    var more = node("button", "load more");
    more.addEventListener("click", function () {
      more.disabled = true;
      loadList(state.list.nextCursor).then(render, function (e) {
        state.errors = ["list: " + e.message];
        render();
      });
    });
    var bar = node("div", null, "row");
    bar.style.marginTop = "10px";
    bar.appendChild(more);
    sec.appendChild(bar);
  }
  sec.appendChild(node("div",
    "click a row for the token view · click a hex value to copy it · rows with status builtin are the "
    + "hardcoded NIGHT and DUST entries, rows with status seen are colours this indexer watched move "
    + "before any contract named them, every other row comes from an observed mint or an emitted event "
    + "· a token is (contract, domainSep, kind) with the whole kind byte, so one domain separator can "
    + "hold up to four rows · " + LIST_ORIGIN_NOTE,
    "note"));
  main.appendChild(sec);
}

// ── 00023: the transactions section, the disclosure panel and the contract calls ────────────

// One row per public occurrence of the token in an archived transaction (US1, FR-009). Heights and
// positions only: the archive holds no wall-clock time and the owner asked for none (Q1).
function activitySection(t, d, items, countItem) {
  var model = items || [];
  var sec = node("section");
  sec.id = "activity";
  sec.appendChild(node("h2", "transactions: every public occurrence of this token"));
  var vis = visibilityOf(t);

  var bar = node("div", null, "row");
  bar.appendChild(node("span", "what happened", "note"));
  var sel = document.createElement("select");
  for (var i = 0; i < ROLES.length; i++) {
    var opt = document.createElement("option");
    opt.value = ROLES[i][0];
    opt.textContent = ROLES[i][1];
    if (ROLES[i][0] === state.act.role) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", function () {
    state.act.role = sel.value;
    state.act.pages = 1;
    refresh();
  });
  bar.appendChild(sel);
  var rows = d.activity ? d.activity.items : [];
  bar.appendChild(node("span",
    (d.activity ? "" : "loading…") + (d.activity && d.activity.nextCursor ? "more rows available below" : ""), "note"));
  // the index's own count is a value of the token: drawn as an occurrence of it, with its origin
  // (audit 03-E1a finding R3B)
  if (t.activityCount !== null && t.activityCount !== undefined && countItem) {
    var cnt = marked(node("span", null, "note"), countItem.field);
    cnt.appendChild(node("span", "  ·  " + txt(t.activityCount) + " in the index  "));
    cnt.appendChild(originChip(countItem.origin));
    bar.appendChild(cnt);
  }
  sec.appendChild(bar);

  if (!d.activity) {
    sec.appendChild(node("div", "not loaded (see the banner above)", "empty"));
    return sec;
  }
  if (rows.length === 0) {
    sec.appendChild(node("div", state.act.role
      ? "no row of this kind for this token; clear the filter to see the rest"
      : (vis === "disclosed-imbalances"
        ? "no transaction has published this colour yet. That is not proof that nothing moved: a "
          + "balanced shielded transfer publishes no colour at all (see the panel above)."
        : "no archived transaction has touched this token yet"), "empty"));
    return sec;
  }
  var tb = tableIn(sec, ["block", "pos", "tx", "what", "amount", "counterparty", "section", "origin", ""]);
  for (var r = 0; r < rows.length; r++) {
    var a = rows[r];
    var key = txt(a.txHash) + "|" + txt(a.segment) + "|" + txt(a.section) + "|"
      + txt(a.role) + "|" + txt(a.itemIndex);
    var tr = document.createElement("tr");
    // The model is built from the same page of rows, in the same order (tokenModel).
    var ai = model[r] || { field: "activity:" + key, origin: originView(a.origin, { token: t, section: "activity" }) };
    marked(tr, ai.field);
    cell(tr, orDash(a.blockHeight), "num");
    cell(tr, orDash(a.txPosition), "num");
    cell(tr, txLink(a.txHash));
    cell(tr, roleCell(a));
    cell(tr, amountCell(a, t), "num");
    cell(tr, counterpartyCell(a));
    cell(tr, node("span", sectionLabel(a.section, a.segment), "note"));
    cell(tr, originChip(ai.origin));
    if (a.role === "shielded_delta") {
      var open = state.act.expand[key] !== undefined && state.act.expand[key] !== null;
      var btn = node("button", open ? "hide offer" : "offer", "expand");
      (function (row, k) {
        btn.addEventListener("click", function (ev) { ev.stopPropagation(); toggleOffer(row, k); });
      })(a, key);
      cell(tr, btn);
    } else {
      cell(tr, node("span", "", "no"));
    }
    tb.appendChild(tr);
    if (a.role === "shielded_delta" && state.act.expand[key]) tb.appendChild(offerDetailRow(a, key, 9, ai));
  }
  if (d.activity.nextCursor) {
    var more = node("button", "load more");
    more.addEventListener("click", function () {
      more.disabled = true;
      state.act.pages = state.act.pages + 1;
      refresh();
    });
    var holder = node("div", null, "row");
    holder.style.marginTop = "10px";
    holder.appendChild(more);
    holder.appendChild(node("span", "500 rows at most per request; NIGHT's list is long by design (Q2)", "note"));
    sec.appendChild(holder);
  }
  sec.appendChild(node("div", activityHint(vis), "note"));
  return sec;
}
function activityHint(vis) {
  if (vis === "disclosed-imbalances") {
    return "a shielded token's list holds exactly what the ledger publishes about its colour: the "
      + "offers whose net imbalance names it (mints, burns, a contract paying into or out of the "
      + "pool) and its mints. A balanced transfer between two users names no colour and cannot "
      + "appear here — open the offer of a row to see what the ledger does publish.";
  }
  return "one row per public occurrence of this token in an archived transaction, newest first · "
    + "block height and position in the block, never a wall-clock time (the archive stores none) · "
    + "amounts are shown in the token's decimals, the raw units are on hover · an owner is shown as "
    + "its Bech32m address, which is what a wallet shows";
}
function counterpartyCell(a) {
  if (a.address) {
    var wrap = node("span");
    wrap.appendChild(contractLink(a.address));
    if (a.entryPoint) {
      wrap.appendChild(node("span", " · "));
      wrap.appendChild(node("span", txt(a.entryPoint)));
    }
    return wrap;
  }
  if (a.owner) {
    var holder = node("span");
    holder.appendChild(ownerCell(a.owner));
    if (a.role === "utxo_in" && a.intentHash) {
      var spent = node("span", " spends " + shortHex(txt(a.intentHash), 6, 4)
        + "/" + orDash(a.outputNo), "note");
      spent.title = "the UTXO being spent: intent hash " + a.intentHash + ", output " + orDash(a.outputNo);
      holder.appendChild(spent);
    }
    return holder;
  }
  if (a.role === "shielded_delta") {
    return node("span", "a commitment, not an address", "no");
  }
  return node("span", "-", "no");
}
// FR-011: a delta row opens the offer the ledger published — its commitments, nullifiers,
// transients and contract addresses, fetched from the transaction route when it is opened.
function toggleOffer(a, key) {
  if (state.act.expand[key]) {
    state.act.expand[key] = null;
    render();
    return;
  }
  state.act.expand[key] = { loading: true, doc: null, error: null };
  render();
  api(P_TXS + "/" + enc(a.txHash)).then(function (doc) {
    var cur = state.act.expand[key];
    if (!cur) return;
    cur.loading = false;
    cur.doc = doc;
    render();
  }, function (e) {
    var cur = state.act.expand[key];
    if (!cur) return;
    cur.loading = false;
    cur.error = "offer detail unavailable: " + e.message;
    render();
  });
}
// The opened offer is another occurrence of its activity row: the same archived transaction is its
// evidence, so it is marked as that row and carries the row's origin (audit 03-E1a finding R2E).
function offerDetailRow(a, key, span, item) {
  var tr = document.createElement("tr");
  tr.className = "det";
  var td = document.createElement("td");
  td.colSpan = span;
  if (item) {
    marked(tr, item.field);
    var src = node("div", null, "row");
    src.appendChild(node("span", "the offer, as decoded from this archived transaction", "note"));
    src.appendChild(originChip(item.origin));
    td.appendChild(src);
  }
  var st = state.act.expand[key];
  if (!st || st.loading) td.appendChild(node("div", "reading the transaction…", "note"));
  else if (st.error) td.appendChild(node("div", st.error, "err"));
  else td.appendChild(offerDetail(st.doc, a));
  tr.appendChild(td);
  return tr;
}
function offerDetail(doc, a) {
  var wrap = node("div");
  var tx = normalizeTx(doc);
  var mine = [];
  for (var i = 0; i < tx.offers.length; i++) {
    var o = tx.offers[i];
    for (var j = 0; j < o.deltas.length; j++) {
      if (txt(o.deltas[j].color) === txt(a.color)) { mine.push(o); break; }
    }
  }
  if (mine.length === 0) mine = tx.offers;
  if (mine.length === 0) {
    wrap.appendChild(node("div", "this transaction carries no zswap offer", "note"));
    return wrap;
  }
  for (var k = 0; k < mine.length; k++) {
    var offer = mine[k];
    var head = node("div", null, "row");
    head.appendChild(node("div", "zswap offer · " + sectionLabel(offer.section, offer.segment), "note"));
    head.appendChild(countedChip(offer.counted));
    wrap.appendChild(head);
    var grid = node("div", null, "det-grid");
    var deltas = node("span");
    if (offer.deltas.length === 0) deltas.appendChild(node("span", "none — this offer is balanced and names no colour", "no"));
    for (var dd = 0; dd < offer.deltas.length; dd++) {
      if (dd > 0) deltas.appendChild(node("span", "  "));
      deltas.appendChild(colorLink(offer.deltas[dd].color, 1));
      deltas.appendChild(node("span", " "));
      deltas.appendChild(poolDeltaCell(offer.deltas[dd].delta));
    }
    detRow(grid, "deltas (colour and net amount; + enters the shielded pool)", deltas);
    detRow(grid, "inputs · nullifiers", hexListCell(offer.inputs, "nullifier"));
    detRow(grid, "outputs · commitments", hexListCell(offer.outputs, "commitment"));
    detRow(grid, "transients · commitments", hexListCell(offer.transients, "commitment"));
    detRow(grid, "contract addresses on this offer", contractsOfOffer(offer));
    wrap.appendChild(grid);
  }
  wrap.appendChild(node("div",
    "a commitment names a coin without naming its colour, its value or its owner; a nullifier "
    + "proves a coin was spent without naming which one. Only the deltas above are attributable.",
    "note"));
  return wrap;
}
function detRow(grid, label, valueNode) {
  grid.appendChild(node("div", label, "k"));
  var holder = node("div");
  holder.appendChild(valueNode);
  grid.appendChild(holder);
}
function contractsOfOffer(offer) {
  var seen = {};
  var list = [];
  var groups = [offer.inputs, offer.outputs, offer.transients];
  for (var g = 0; g < groups.length; g++) {
    for (var i = 0; i < groups[g].length; i++) {
      var addr = groups[g][i] ? groups[g][i].contractAddress : null;
      if (!addr || seen[addr]) continue;
      seen[addr] = true;
      list.push(addr);
    }
  }
  if (list.length === 0) return node("span", "none — every coin in this offer is user-owned", "no");
  var wrap = node("span");
  for (var k = 0; k < list.length; k++) {
    if (k > 0) wrap.appendChild(node("span", "  "));
    wrap.appendChild(contractLink(list[k]));
  }
  return wrap;
}

// US4, as the owner settled it: the reader of this page is an advanced user who already knows what
// a zswap offer does and does not publish, so the static two-column lecture is gone. What is left
// is the part only this index can supply — the two live counts, and the link that turns the second
// one into a list you can open. The per-delta "offer" expansion under each row and the one-line
// note under the transactions table carry the rest.
function disclosureSection(t, items) {
  var model = items || [];
  var sec = node("section");
  var counts = node("div", null, "counts");
  var disclosed = t.disclosedTransactions;
  var undisclosed = t.undisclosedShieldedOffers;
  if (undisclosed === null || undisclosed === undefined) undisclosed = counterOf(state.status, "undisclosedShieldedOffers");
  var line = node("div");
  var first = marked(node("span"), model[0] ? model[0].field : "disclosedTransactions");
  first.appendChild(node("b", disclosed === null || disclosed === undefined ? "-" : txt(disclosed)));
  first.appendChild(node("span", "  transactions disclose this colour  ", "note"));
  if (model[0]) first.appendChild(originChip(model[0].origin));
  line.appendChild(first);
  line.appendChild(node("span", "  ·  ", "note"));
  var second = marked(node("span"), model[1] ? model[1].field : "undisclosedShieldedOffers");
  second.appendChild(node("b", undisclosed === null || undisclosed === undefined ? "-" : txt(undisclosed)));
  second.appendChild(node("span", "  shielded offers on this chain publish no colour at all — any of "
    + "them may be this token  ", "note"));
  if (model[1]) second.appendChild(originChip(model[1].origin));
  line.appendChild(second);
  var link = node("a", "list them");
  link.href = "#/shielded-offers";
  line.appendChild(link);
  counts.appendChild(line);
  sec.appendChild(counts);
  return sec;
}

// Q13: DUST is the fee token, so it has no per-token list at all — and says so instead of
// showing an empty table that would read as "nothing happened".
function dustSection() {
  var sec = node("section");
  sec.appendChild(node("h2", "transactions"));
  var box = node("div", null, "warnnote");
  box.appendChild(node("b", "fees are not tracked per token"));
  box.appendChild(node("span",
    ". Every transaction on the chain pays a DUST fee, so a DUST activity list would be a list of "
    + "the whole chain. A transaction's own DUST spends and registrations are shown in its view, "
    + "where they belong."));
  sec.appendChild(box);
  return sec;
}

// US7 / Q4: for a ledger token there is no colour and no UTXO — its balances live in contract
// state this indexer cannot read. What is public is every call of its contract, listed here under
// the note the owner asked for.
function callsNote() {
  var box = node("div", null, "warnnote");
  box.appendChild(node("b", "only public data is listed — we do not have access to the code this executes"));
  box.appendChild(node("span",
    "; what a call means for this token's balances is defined by the contract and is not readable here."));
  return box;
}
function callsSection(page, heading, notes, items) {
  var model = items || [];
  var sec = node("section");
  sec.id = "calls";
  sec.appendChild(node("h2", heading));
  sec.appendChild(callsNote());
  if (!page) {
    sec.appendChild(node("div", "not loaded (see the banner above)", "empty"));
    return sec;
  }
  var items = page.items;
  if (items.length === 0) {
    sec.appendChild(node("div", "no call of this contract is archived yet", "empty"));
    return sec;
  }
  var tb = tableIn(sec, ["block", "pos", "tx", "segment", "call", "entry point", "section",
    "ops", "log", "gas (compute)", "effects", "", "origin"]);
  for (var i = 0; i < items.length; i++) {
    var c = items[i];
    var ci = model[i] || { field: "call:" + c.txHash + ":" + c.segment + ":" + c.callIndex,
      origin: callsModel({ items: [c] }, c.address)[0].origin };
    var sections = [["guaranteed", c.guaranteed], ["fallible", c.fallible]];
    var any = false;
    for (var s = 0; s < sections.length; s++) {
      var tr2 = sections[s][1];
      if (!tr2) continue;
      any = true;
      tb.appendChild(callRow(c, sections[s][0], tr2, ci));
    }
    if (!any) tb.appendChild(callRow(c, "-", null, ci));
  }
  if (page.nextCursor) {
    var more = node("button", "load more");
    more.addEventListener("click", function () {
      more.disabled = true;
      state.act.pages = state.act.pages + 1;
      refresh();
    });
    var holder = node("div", null, "row");
    holder.style.marginTop = "10px";
    holder.appendChild(more);
    sec.appendChild(holder);
  }
  sec.appendChild(node("div",
    "one row per transcript: a call may carry a guaranteed one, a fallible one or both · a row "
    + "marked not counted ran in a section that failed · click the transaction for the whole decode",
    "note"));
  if (notes) sec.appendChild(node("div", notes, "note"));
  return sec;
}
function callRow(c, section, transcript, item) {
  var tr = document.createElement("tr");
  if (item) marked(tr, item.field);
  cell(tr, orDash(c.blockHeight), "num");
  cell(tr, orDash(c.txPosition), "num");
  cell(tr, txLink(c.txHash));
  cell(tr, orDash(c.segment), "num");
  cell(tr, orDash(c.callIndex), "num");
  cell(tr, orDash(c.entryPoint));
  cell(tr, node("span", section, "note"));
  cell(tr, transcript ? orDash(transcript.ops) : "-", "num");
  cell(tr, transcript ? orDash(transcript.logOps) : "-", "num");
  cell(tr, gasCell(transcript ? transcript.gas : null), "num");
  cell(tr, node("span", effectsSummary(transcript ? transcript.effects : null), "wrapv"));
  cell(tr, countedChip(transcript ? transcript.counted : undefined));
  if (item) cell(tr, originChip(item.origin));
  return tr;
}
function gasCell(g) {
  if (!g) return node("span", "-", "no");
  var s = node("span", orDash(g.computeTime), "amt");
  s.title = "read " + orDash(g.readTime) + "  ·  compute " + orDash(g.computeTime)
    + "  ·  bytes written " + orDash(g.bytesWritten) + "  ·  bytes deleted " + orDash(g.bytesDeleted);
  return s;
}
// An effect map may arrive as a list of {color|domainSep, amount} or as a plain object keyed by
// hex; both read the same here, and neither is dropped silently (FR-015 is the decoder's rule, and
// this is its counterpart on screen).
function mapEntries(v) {
  var out = [];
  if (isArray(v)) {
    for (var i = 0; i < v.length; i++) {
      var e = v[i] || {};
      out.push({
        key: e.color || e.domainSep || e.token || e.type || null,
        text: e.domainSepText || e.tokenName || e.name || null,
        value: e.amount === undefined ? e.value : e.amount,
        isColor: e.color ? true : false
      });
    }
    return out;
  }
  if (v && typeof v === "object") {
    for (var k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      out.push({ key: k, text: null, value: v[k], isColor: false });
    }
  }
  return out;
}
var EFFECT_MAPS = [["shieldedMints", "shielded mints"], ["unshieldedMints", "unshielded mints"],
  ["unshieldedInputs", "received by the contract"], ["unshieldedOutputs", "paid by the contract"]];
var EFFECT_COUNTS = [["claimedShieldedReceives", "claimed shielded receives"],
  ["claimedShieldedSpends", "claimed shielded spends"], ["claimedNullifiers", "claimed nullifiers"],
  ["claimedContractCalls", "claimed contract calls"]];
function effectsSummary(e) {
  if (!e) return "-";
  var parts = [];
  for (var i = 0; i < EFFECT_MAPS.length; i++) {
    var n = mapEntries(e[EFFECT_MAPS[i][0]]).length;
    if (n > 0) parts.push(EFFECT_MAPS[i][1] + " " + n);
  }
  for (var j = 0; j < EFFECT_COUNTS.length; j++) {
    var c = count(e[EFFECT_COUNTS[j][0]]);
    if (c > 0) parts.push(EFFECT_COUNTS[j][1] + " " + c);
  }
  return parts.length === 0 ? "none" : parts.join(" · ");
}
function effectsBlock(e) {
  var wrap = node("div");
  if (!e) { wrap.appendChild(node("span", "-", "no")); return wrap; }
  var grid = node("div", null, "det-grid");
  var any = false;
  for (var i = 0; i < EFFECT_MAPS.length; i++) {
    var entries = mapEntries(e[EFFECT_MAPS[i][0]]);
    if (entries.length === 0) continue;
    any = true;
    var holder = node("span");
    for (var k = 0; k < entries.length; k++) {
      if (k > 0) holder.appendChild(node("span", "  "));
      var entry = entries[k];
      if (entry.isColor) holder.appendChild(colorLink(entry.key, 0));
      else if (entry.text) holder.appendChild(copyable(entry.key, entry.text, "txt"));
      else holder.appendChild(copyable(entry.key, shortHex(txt(entry.key), 8, 6), "hex"));
      holder.appendChild(node("span", " " + orDash(entry.value), "amt"));
    }
    detRow(grid, EFFECT_MAPS[i][1], holder);
  }
  for (var j = 0; j < EFFECT_COUNTS.length; j++) {
    var c = count(e[EFFECT_COUNTS[j][0]]);
    if (c === 0) continue;
    any = true;
    detRow(grid, EFFECT_COUNTS[j][1], node("span", txt(c), "amt"));
  }
  if (!any) { wrap.appendChild(node("span", "no effect declared by this transcript", "no")); return wrap; }
  wrap.appendChild(grid);
  return wrap;
}

// ── View: one transaction (US2, FR-010) ─────────────────────────────────────────────────────
//
// The document of spec §4, whatever spelling the API chose for its containers (question Q15): the
// shapes below are normalised once, here, so every renderer downstream reads one shape.

function normOffer(o, section, segment) {
  var v = o || {};
  return {
    section: v.section ? txt(v.section) : section,
    segment: v.segment === undefined || v.segment === null ? segment : v.segment,
    counted: v.counted === undefined ? true : v.counted,
    deltas: arr(v.deltas), inputs: arr(v.inputs), outputs: arr(v.outputs), transients: arr(v.transients)
  };
}
function normalizeTx(doc) {
  var d = doc || {};
  var offers = [];
  var listed = arr(d.offers);
  if (listed.length > 0) {
    for (var i = 0; i < listed.length; i++) offers.push(normOffer(listed[i], "guaranteed", 0));
  } else {
    if (d.guaranteedOffer) offers.push(normOffer(d.guaranteedOffer, "guaranteed", 0));
    var fallible = segList(d.fallibleOffers === undefined ? d.fallibleOffer : d.fallibleOffers);
    for (var f = 0; f < fallible.length; f++) offers.push(normOffer(fallible[f], "fallible", fallible[f].segment));
  }
  var intents = [];
  var rawIntents = segList(d.intents);
  for (var n = 0; n < rawIntents.length; n++) {
    var it = rawIntents[n];
    var unshielded = arr(it.unshieldedOffers);
    if (unshielded.length === 0) {
      if (it.guaranteedUnshieldedOffer) unshielded.push(normUnshielded(it.guaranteedUnshieldedOffer, "guaranteed"));
      if (it.fallibleUnshieldedOffer) unshielded.push(normUnshielded(it.fallibleUnshieldedOffer, "fallible"));
    } else {
      var fixed = [];
      for (var u = 0; u < unshielded.length; u++) fixed.push(normUnshielded(unshielded[u], "guaranteed"));
      unshielded = fixed;
    }
    intents.push({
      segment: it.segment, ttl: it.ttl, intentHash: it.intentHash,
      unshieldedOffers: unshielded,
      dustActions: it.dustActions || null,
      actions: arr(it.actions === undefined ? it.contractActions : it.actions)
    });
  }
  var rewards = [];
  if (d.rewards) rewards = isArray(d.rewards) ? d.rewards : [d.rewards];
  return {
    head: d, offers: offers, intents: intents, dustActions: d.dustActions || null,
    rewards: rewards, activity: arr(d.activity)
  };
}
function normUnshielded(o, section) {
  var v = o || {};
  return {
    section: v.section ? txt(v.section) : section,
    counted: v.counted === undefined ? true : v.counted,
    signatures: v.signatures === undefined ? null : v.signatures,
    inputs: arr(v.inputs), outputs: arr(v.outputs)
  };
}
function feeCell(feeSpeck) {
  var wrap = node("span");
  var value = node("span", orDash(feeSpeck) + " SPECK  ·  " + formatUnits(feeSpeck, 15) + " DUST", "amt");
  value.title = "the sum of this transaction's DUST spends (vFee): what the wallet offered for "
    + "fees, which is more than the ledger charged. The charged fee is not in the archived bytes.";
  wrap.appendChild(value);
  wrap.appendChild(node("span",
    "  offered by the wallet, not the fee the ledger charged", "note"));
  return wrap;
}
function segmentsText(segments) {
  var list = arr(segments);
  if (list.length === 0) return "-";
  var out = [];
  for (var i = 0; i < list.length; i++) {
    out.push(txt(list[i].id === undefined ? list[i].segment : list[i].id)
      + (list[i].success === false ? " failed" : " ok"));
  }
  return out.join(" · ");
}
function renderTx(main) {
  var crumb = node("div", null, "crumb");
  var back = node("a", "← all tokens");
  back.href = "#/";
  crumb.appendChild(back);
  main.appendChild(crumb);

  var holder = state.tx;
  if (!holder || !holder.doc) {
    var miss = node("section");
    miss.appendChild(node("h2", "transaction"));
    miss.appendChild(node("div", "not loaded (see the banner above). The hash is "
      + txt(state.route.hash), "empty"));
    main.appendChild(miss);
    return;
  }
  var tx = normalizeTx(holder.doc);
  var d = tx.head;

  var head = node("section");
  head.appendChild(node("h2", "transaction · decoded from the archived bytes on request"));
  var feeSpeck = d.feeSpeck === undefined ? d.fee : d.feeSpeck;
  kvInto(head, [
    ["hash", copyable(d.txHash, d.txHash ? txt(d.txHash) : "-", "hex")],
    ["block height", orDash(d.blockHeight)],
    ["block hash", copyable(d.blockHash, d.blockHash ? shortHex(txt(d.blockHash), 12, 10) : "-", "hex")],
    ["position in block", orDash(d.txPosition)],
    ["protocol version", orDash(d.protocolVersion)],
    ["result", node("span", orDash(d.result), d.result === "success" ? "txt" : "err")],
    ["segments", segmentsText(d.segments)],
    ["raw bytes", orDash(d.rawBytes)],
    ["identifiers", hexListCell(d.identifiers)],
    // Question Q18 (runner A, measured on four fixtures): this is the sum of the DUST spends'
    // vFee — what the wallet OFFERED, which runs about 1.25-1.5x what the ledger charged. The
    // number the ledger required is not derivable from the archived bytes, so the page names the
    // number it has rather than calling it "the fee" and disagreeing with every block explorer.
    ["DUST offered for fees", feeCell(feeSpeck)],
    ["binding randomness", d.bindingRandomness === undefined ? "-" : (d.bindingRandomness ? "present" : "absent")]
  ]);
  main.appendChild(head);

  // zswap offers
  var offers = node("section");
  offers.appendChild(node("h2", "zswap offers"));
  if (tx.offers.length === 0) {
    offers.appendChild(node("div", "this transaction carries no zswap offer", "empty"));
  } else {
    for (var i = 0; i < tx.offers.length; i++) {
      var o = tx.offers[i];
      var block = node("div", null, "txsec");
      var title = node("div", null, "row");
      title.appendChild(node("div", offerHeading(o.section, o.segment), "h"));
      title.appendChild(countedChip(o.counted));
      block.appendChild(title);
      var grid = node("div", null, "det-grid");
      var deltas = node("span");
      if (o.deltas.length === 0) {
        deltas.appendChild(node("span",
          "none — this offer is balanced, so the ledger does not say which colour moved", "no"));
      }
      for (var dd = 0; dd < o.deltas.length; dd++) {
        if (dd > 0) deltas.appendChild(node("span", "  "));
        deltas.appendChild(colorLink(o.deltas[dd].color, 1));
        deltas.appendChild(node("span", " "));
        deltas.appendChild(poolDeltaCell(o.deltas[dd].delta));
        if (o.deltas[dd].tokenName) deltas.appendChild(node("span", " " + txt(o.deltas[dd].tokenName), "txt"));
      }
      detRow(grid, "deltas (+ enters the shielded pool)", deltas);
      detRow(grid, "inputs · nullifiers", hexListCell(o.inputs, "nullifier"));
      detRow(grid, "outputs · commitments", hexListCell(o.outputs, "commitment"));
      detRow(grid, "transients · commitments", hexListCell(o.transients, "commitment"));
      detRow(grid, "contract addresses", contractsOfOffer(o));
      block.appendChild(grid);
      offers.appendChild(block);
    }
  }
  main.appendChild(offers);

  // intents
  for (var n = 0; n < tx.intents.length; n++) main.appendChild(intentSection(tx.intents[n]));
  if (tx.dustActions) main.appendChild(dustActionsSection(tx.dustActions, null));

  // rewards
  if (tx.rewards.length > 0) {
    var rw = node("section");
    rw.appendChild(node("h2", "rewards"));
    var rb = tableIn(rw, ["kind", "value", "owner", "nonce"]);
    for (var r = 0; r < tx.rewards.length; r++) {
      var reward = tx.rewards[r];
      var rr = document.createElement("tr");
      cell(rr, orDash(reward.kind));
      cell(rr, node("span", formatUnits(reward.value, 6), "amt"), "num");
      cell(rr, ownerCell(reward.owner));
      cell(rr, copyable(reward.nonce, shortHex(txt(reward.nonce), 8, 6), "hex"));
      rb.appendChild(rr);
    }
    main.appendChild(rw);
  }

  // this transaction's stored activity rows
  var act = node("section");
  act.appendChild(node("h2", "what this transaction did to tracked tokens"));
  if (tx.activity.length === 0) {
    act.appendChild(node("div",
      "no activity row: either nothing public in this transaction names a tracked colour, or the "
      + "sections that would have produced rows did not count (Q10).", "empty"));
  } else {
    var ab = tableIn(act, ["token", "what", "amount", "counterparty", "section"]);
    for (var a = 0; a < tx.activity.length; a++) {
      var row = tx.activity[a];
      var ar = document.createElement("tr");
      cell(ar, txTokenCell(row));
      cell(ar, roleCell(row));
      cell(ar, amountCell(row, row.token), "num");
      cell(ar, counterpartyCell(row));
      cell(ar, node("span", sectionLabel(row.section, row.segment), "note"));
      ab.appendChild(ar);
    }
  }
  main.appendChild(act);

  // the document as it arrived
  var raw = node("section");
  var bar = node("div", null, "row");
  var toggleRaw = node("button", holder.raw ? "hide raw JSON" : "raw JSON");
  toggleRaw.addEventListener("click", function () { holder.raw = !holder.raw; render(); });
  bar.appendChild(node("div", "the document this page rendered, exactly as the API returned it", "note"));
  bar.appendChild(toggleRaw);
  raw.appendChild(bar);
  if (holder.raw) {
    var pre = node("pre");
    try { pre.textContent = JSON.stringify(holder.doc, null, 2); } catch (e) { pre.textContent = txt(holder.doc); }
    raw.appendChild(pre);
  }
  main.appendChild(raw);
}
function txTokenCell(a) {
  var t = a.token;
  var label = t && t.name ? txt(t.name)
    : (t && t.symbol ? txt(t.symbol) : "colour " + shortHex(txt(a.color), 8, 6));
  var link = node("a", label);
  link.href = (t && t.address && t.domainSep ? hashToken(t) : hashColor(a.color, a.kind)) + "/activity";
  link.title = "open this token with its transactions";
  var wrap = node("span");
  wrap.appendChild(link);
  if (!t) wrap.appendChild(node("span", "unknown contract", "pill"));
  return wrap;
}
function intentSection(it) {
  var sec = node("section");
  sec.appendChild(node("h2", "intent · segment " + orDash(it.segment)));
  var ttl = node("span", orDash(it.ttl));
  ttl.title = "the wallet's own time-to-live for this intent — a value inside the transaction, "
    + "never the block's time (the archive stores no block time)";
  kvInto(sec, [
    ["intent hash", copyable(it.intentHash, it.intentHash ? txt(it.intentHash) : "-", "hex")],
    ["ttl (wallet-set, not the block time)", ttl]
  ]);
  for (var i = 0; i < it.unshieldedOffers.length; i++) {
    var offer = it.unshieldedOffers[i];
    var block = node("div", null, "txsec");
    var title = node("div", null, "row");
    title.appendChild(node("div", offer.section + " unshielded offer"
      + (offer.signatures === null ? "" : " · " + offer.signatures + " signature"
        + (Number(offer.signatures) === 1 ? "" : "s")), "h"));
    title.appendChild(countedChip(offer.counted));
    block.appendChild(title);
    if (offer.inputs.length > 0) {
      var ib = tableIn(block, ["input", "value", "colour", "owner", "spends intent", "out #"]);
      for (var n = 0; n < offer.inputs.length; n++) {
        var input = offer.inputs[n];
        var ir = document.createElement("tr");
        cell(ir, txt(n), "num");
        cell(ir, node("span", orDash(input.value), "amt"), "num");
        cell(ir, colorLink(input.color === undefined ? input.type : input.color, 0));
        cell(ir, ownerCell(input.ownerAddress === undefined ? input.owner : input.ownerAddress));
        cell(ir, copyable(input.spentIntentHash, shortHex(txt(input.spentIntentHash), 8, 6), "hex"));
        cell(ir, orDash(input.spentOutputNo === undefined ? input.outputNo : input.spentOutputNo), "num");
        ib.appendChild(ir);
      }
    }
    if (offer.outputs.length > 0) {
      var ob = tableIn(block, ["output", "value", "colour", "owner"]);
      for (var m = 0; m < offer.outputs.length; m++) {
        var output = offer.outputs[m];
        var or = document.createElement("tr");
        cell(or, orDash(output.index === undefined ? m : output.index), "num");
        cell(or, node("span", orDash(output.value), "amt"), "num");
        cell(or, colorLink(output.color === undefined ? output.type : output.color, 0));
        cell(or, ownerCell(output.owner));
        ob.appendChild(or);
      }
    }
    if (offer.inputs.length === 0 && offer.outputs.length === 0) {
      block.appendChild(node("div", "no input and no output", "empty"));
    }
    sec.appendChild(block);
  }
  for (var c = 0; c < it.actions.length; c++) sec.appendChild(actionBlock(it.actions[c]));
  if (it.dustActions) sec.appendChild(dustActionsBlock(it.dustActions));
  return sec;
}
function actionBlock(action) {
  var block = node("div", null, "txsec");
  var title = node("div", null, "row");
  title.appendChild(node("div", "contract " + (action.kind ? txt(action.kind) : "action")
    + " · index " + orDash(action.index), "h"));
  block.appendChild(title);
  var grid = node("div", null, "det-grid");
  detRow(grid, "address", contractLink(action.address, action.address ? txt(action.address) : null));
  if (action.entryPoint) detRow(grid, "entry point", node("span", txt(action.entryPoint)));
  if (action.communicationCommitment) {
    detRow(grid, "communication commitment",
      copyable(action.communicationCommitment, shortHex(txt(action.communicationCommitment), 10, 8), "hex"));
  }
  block.appendChild(grid);
  var transcripts = [["guaranteed", action.guaranteed], ["fallible", action.fallible]];
  for (var i = 0; i < transcripts.length; i++) {
    var t = transcripts[i][1];
    if (!t) continue;
    var line = node("div", null, "row");
    line.appendChild(node("div", transcripts[i][0] + " transcript · " + orDash(t.ops) + " ops · "
      + orDash(t.logOps) + " log", "h"));
    line.appendChild(node("span", "gas", "note"));
    line.appendChild(gasCell(t.gas));
    line.appendChild(countedChip(t.counted));
    block.appendChild(line);
    block.appendChild(effectsBlock(t.effects));
  }
  return block;
}
function dustActionsBlock(dust) {
  var block = node("div", null, "txsec");
  block.appendChild(node("div",
    "DUST actions — inside the transaction; not tracked per token (Q13)", "h"));
  var ctime = node("span", orDash(dust.ctime));
  ctime.title = "the wallet's own creation time for the DUST it spends — a value inside the "
    + "transaction, never the block's time";
  var grid = node("div", null, "det-grid");
  detRow(grid, "ctime (wallet-set, not the block time)", ctime);
  block.appendChild(grid);
  var spends = arr(dust.spends);
  if (spends.length > 0) {
    var sb = tableIn(block, ["spend", "vFee (SPECK)", "old nullifier", "new commitment"]);
    for (var i = 0; i < spends.length; i++) {
      var s = spends[i];
      var tr = document.createElement("tr");
      cell(tr, txt(i), "num");
      cell(tr, node("span", orDash(s.vFee), "amt"), "num");
      cell(tr, copyable(s.oldNullifier, shortHex(txt(s.oldNullifier), 8, 6), "hex"));
      cell(tr, copyable(s.newCommitment, shortHex(txt(s.newCommitment), 8, 6), "hex"));
      sb.appendChild(tr);
    }
  }
  var regs = arr(dust.registrations);
  if (regs.length > 0) {
    var rb = tableIn(block, ["registration", "night key", "DUST address", "may pay fees"]);
    for (var r = 0; r < regs.length; r++) {
      var g = regs[r];
      var rr = document.createElement("tr");
      cell(rr, txt(r), "num");
      cell(rr, copyable(g.nightKey, shortHex(txt(g.nightKey), 8, 6), "hex"));
      cell(rr, ownerCell(g.dustAddress));
      cell(rr, g.allowFeePayment === true ? "yes" : (g.allowFeePayment === false ? "no" : "-"));
      rb.appendChild(rr);
    }
  }
  if (spends.length === 0 && regs.length === 0) {
    block.appendChild(node("div", "no DUST spend and no registration in this intent", "empty"));
  }
  return block;
}
function dustActionsSection(dust) {
  var sec = node("section");
  sec.appendChild(node("h2", "DUST actions"));
  sec.appendChild(dustActionsBlock(dust));
  return sec;
}

// ── View: the shielded offers whose colour is undisclosed (FR-018, Q14) ─────────────────────

function renderOffers(main) {
  var crumb = node("div", null, "crumb");
  var back = node("a", "← all tokens");
  back.href = "#/";
  crumb.appendChild(back);
  main.appendChild(crumb);

  var sec = node("section");
  sec.appendChild(node("h2", "shielded offers whose colour is undisclosed"));
  sec.appendChild(node("div",
    "these shielded offers carry no colour: the ledger does not say which token moved. A zswap "
    + "offer publishes only its net imbalance per colour, and a balanced offer — a plain transfer "
    + "between two users — has none, so any of these may be any shielded token. This is the "
    + "measured form of the claim that Midnight is private: a number that comes from the chain.",
    "note"));
  var bar = node("div", null, "row");
  bar.appendChild(node("span", "show", "note"));
  var sel = document.createElement("select");
  var choices = [["true", "undisclosed only (no colour)"], ["false", "disclosed only (a colour and an amount)"],
    ["", "every zswap offer"]];
  for (var i = 0; i < choices.length; i++) {
    var opt = document.createElement("option");
    opt.value = choices[i][0];
    opt.textContent = choices[i][1];
    if (choices[i][0] === state.offers.undisclosed) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", function () {
    state.offers.undisclosed = sel.value;
    state.offers.pages = 1;
    state.offers.loaded = false;
    refresh();
  });
  bar.appendChild(sel);
  var items = state.offers.items;
  bar.appendChild(node("span", state.offers.loaded
    ? items.length + " offer" + (items.length === 1 ? "" : "s")
      + (state.offers.nextCursor ? " (more available)" : "")
    : "loading…", "note"));
  sec.appendChild(bar);

  if (!state.offers.loaded) {
    sec.appendChild(node("div", "loading…", "empty"));
    main.appendChild(sec);
    return;
  }
  if (items.length === 0) {
    sec.appendChild(node("div", "no offer matches", "empty"));
    main.appendChild(sec);
    return;
  }
  var tb = tableIn(sec, ["block", "pos", "tx", "section", "segment", "inputs", "outputs",
    "transients", "deltas", "colour"]);
  for (var r = 0; r < items.length; r++) {
    var o = items[r];
    var tr = document.createElement("tr");
    cell(tr, orDash(o.blockHeight), "num");
    cell(tr, orDash(o.txPosition), "num");
    cell(tr, txLink(o.txHash));
    cell(tr, node("span", orDash(o.section), "note"));
    cell(tr, orDash(o.segment), "num");
    cell(tr, orDash(o.inputs), "num");
    cell(tr, orDash(o.outputs), "num");
    cell(tr, orDash(o.transients), "num");
    cell(tr, orDash(o.deltas), "num");
    cell(tr, o.undisclosed === false
      ? node("span", "published", "txt")
      : node("span", "not published", "no"));
    tb.appendChild(tr);
  }
  if (state.offers.nextCursor) {
    var more = node("button", "load more");
    more.addEventListener("click", function () {
      more.disabled = true;
      state.offers.pages = state.offers.pages + 1;
      refresh();
    });
    var holder = node("div", null, "row");
    holder.style.marginTop = "10px";
    holder.appendChild(more);
    sec.appendChild(holder);
  }
  sec.appendChild(node("div",
    "one row per zswap offer on the chain · inputs are nullifiers, outputs are commitments, and "
    + "neither carries a colour or a value · click a transaction to see the offer itself", "note"));
  main.appendChild(sec);
}

// ── View: token ─────────────────────────────────────────────────────────────────────────────

function kvInto(parent, pairs) {
  var grid = node("div", null, "kv");
  for (var i = 0; i < pairs.length; i++) {
    grid.appendChild(node("div", pairs[i][0], "k"));
    var v = pairs[i][1];
    if (v !== null && typeof v === "object" && v.nodeType) {
      var holder = node("div");
      holder.appendChild(v);
      grid.appendChild(holder);
    } else {
      grid.appendChild(node("div", v === null || v === undefined || v === "" ? "-" : txt(v)));
    }
  }
  parent.appendChild(grid);
}
function renderToken(main) {
  var d = state.detail;
  var r = state.route;
  var crumb = node("div", null, "crumb");
  var back = node("a", "← all tokens");
  back.href = "#/";
  crumb.appendChild(back);
  // A colour route (US5) has no contract to point at — unless the colour's row names one (R4D).
  var known = d && d.token && d.token.address && !isZeroHex(txt(d.token.address)) ? txt(d.token.address) : null;
  var toAddress = r.address && !isZeroHex(r.address) ? r.address : known;
  if (toAddress) {
    crumb.appendChild(node("span", "  ·  "));
    var toContract = node("a", "its contract");
    toContract.href = hashContract(toAddress);
    crumb.appendChild(toContract);
  } else if (r.color) {
    // the colour and kind are values of this token: they are shown below, each with its origin
    crumb.appendChild(node("span", "  ·  a colour no contract has named"));
  }
  main.appendChild(crumb);

  if (!d || !d.token) {
    var miss = node("section");
    miss.appendChild(node("h2", "token"));
    miss.appendChild(node("div", "not loaded (see the banner above). The route is "
      + (r.color ? "colour " + r.color + " / kind " + r.kind
        : r.address + " / " + r.domainSep + " / " + r.kind), "empty"));
    main.appendChild(miss);
    return;
  }
  var t = d.token;
  // 00024-03: everything below is drawn from this one model, value by value with its origin.
  var m = tokenModel(d);

  var head = node("section");
  var title = node("h3");
  headingNodes(t, m, title);
  head.appendChild(title);
  var sub = node("div", null, "row");
  var st = marked(node("span", null, "vo"), "status");
  st.appendChild(statusBadge(t.status));
  st.appendChild(originChip(factOf(m, "status").origin));
  sub.appendChild(st);
  sub.appendChild(subtitleNode(t, m));
  head.appendChild(sub);
  if (t.status === "seen") {
    head.appendChild(node("div",
      "This row exists because this colour was seen moving in public transaction data, not because "
      + "a contract named it: its mint predates the archive's first block, and a colour is a "
      + "commitment — the contract address and domain separator behind it cannot be recovered from "
      + "it. Everything below is what the chain itself shows. A later mint or metadata event for "
      + "this colour completes this row in place (US5).", "note"));
  }
  if (t.status === "declared") {
    head.appendChild(node("div",
      t.storage === "ledger"
        ? "A ledger token is a claim the chain cannot corroborate: nothing is ever minted for it, so "
          + "this row stays declared for good (MIP 7.2)."
        : "Described but not yet minted: the chain has not seen this token, only the contract's claim "
          + "about it (MIP 7.2).", "note"));
  }
  // The contract's public interface beside the MIP-0018 values, neither overriding the other (P3):
  // its result here, its URL, files, keys and circuits on the contract view.
  var ifl = marked(node("div", null, "row"), m.iface.field);
  ifl.style.marginTop = "8px";
  ifl.appendChild(node("span", "public interface", "note"));
  if (m.iface.status) ifl.appendChild(ifaceBadge(m.iface.status));
  else ifl.appendChild(node("span", "none", "no"));
  ifl.appendChild(originChip(m.iface.origin));
  if (t.address && !isZeroHex(t.address) && m.iface.status) {
    var toIface = node("a", "URL, files, keys, circuits and history on the contract view");
    toIface.href = hashContract(t.address) + "/interface";
    ifl.appendChild(toIface);
  }
  head.appendChild(ifl);
  var links = marked(node("div", null, "row"), "tokenUri");
  links.style.marginTop = "8px";
  links.appendChild(node("span", "tokenUri", "note"));
  links.appendChild(uriLink(t.tokenUri));
  links.appendChild(originChip(factOf(m, "tokenUri").origin));
  var paths = resolverPaths(t);
  for (var i = 0; i < paths.length; i++) {
    links.appendChild(node("span", paths[i].label, "note"));
    var a = node("a", paths[i].short);
    a.href = paths[i].path;
    a.title = paths[i].path + " (opens the metadata document in a new tab)";
    a.rel = "noreferrer noopener";
    a.target = "_blank";
    links.appendChild(a);
  }
  head.appendChild(links);
  main.appendChild(head);

  var facts = node("section");
  facts.id = "facts";
  facts.appendChild(node("h2", "token · every value with where it came from"));
  factsTable(facts, m.facts, function (it) { return tokenFactValue(it, t); });
  facts.appendChild(node("div", ORIGIN_LEGEND, "note"));
  main.appendChild(facts);

  var meta = marked(node("section"), m.metadata.field);
  meta.id = "metadata";
  meta.appendChild(node("h2", "metadata JSON"));
  meta.appendChild(originBlock(m.metadata.origin));
  if (t.metadata === null || t.metadata === undefined) {
    meta.appendChild(node("div", "no metadata published (or a multi-part document is still incomplete)", "empty"));
  } else {
    var pre = node("pre");
    pre.textContent = shown(m.metadata.value);
    meta.appendChild(pre);
  }
  main.appendChild(meta);

  main.appendChild(traitsSection(m));

  // The other representations of the same asset: MIP section 4 lets a consumer link the rows that
  // share (contract address, domain separator). This is where a contract that declares a ledger
  // book and mints native UTXOs reads as one asset in two forms rather than as a contradiction.
  if (m.siblings.length > 0) {
    var linked = node("section");
    linked.appendChild(node("h2", "other rows under this domain separator"));
    linked.appendChild(node("div",
      "the same contract and the same domain separator under another kind byte: the standard treats "
      + "each as its own token and lets a consumer show them as representations of one asset",
      "note"));
    var lb = tableIn(linked, ["kind", "colour", "name", "symbol", "dec", "mints", "status"]);
    for (var o = 0; o < m.siblings.length; o++) {
      var ot = m.siblings[o].token;
      var lr = document.createElement("tr");
      lr.className = "pick";
      rowCells(lr, m.siblings[o].items, ot, SIBLING_FIELDS);
      (function (token) {
        lr.addEventListener("click", function () {
          go(hashToken({ address: t.address, domainSep: token.domainSep, kind: token.kind }));
        });
      })(ot);
      lb.appendChild(lr);
    }
    main.appendChild(linked);
  }

  var mints = node("section");
  mints.id = "mints";
  mints.appendChild(node("h2", "mint history"));
  if (m.mints.length === 0) {
    mints.appendChild(node("div", t.storage === "ledger"
      ? "a ledger token is never minted natively, so it has no mint rows by construction"
      : "no mint observed for this token yet", "empty"));
  } else {
    if (m.mintsMore) {
      // the note shows the token's mint count: an occurrence of it, with its origin
      var mc = factOf(m, "mintCount");
      var more = marked(node("div", null, "note err"), mc.field);
      more.appendChild(node("span", "the first " + groupDigits(m.mints.length) + " of " + orDash(t.mintCount)
        + " mints are listed — all of them: "));
      var all = node("a", "every mint (API, paginated)");
      all.href = t.address && t.domainSep ? tokenBase(t) + "/mints?limit=" + MINT_LIMIT : P_COLORS + "/" + enc(t.color);
      all.target = "_blank";
      all.rel = "noopener";
      more.appendChild(all);
      more.appendChild(node("span", "  "));
      more.appendChild(originChip(mc.origin));
      mints.appendChild(more);
    }
    var mb = tableIn(mints, ["block", "tx", "segment", "call", "entry point", "kind", "amount", "origin"]);
    for (var n = 0; n < m.mints.length; n++) {
      var mi = m.mints[n].row;
      var mr = marked(document.createElement("tr"), m.mints[n].field);
      cell(mr, orDash(mi.blockHeight), "num");
      cell(mr, txLink(mi.txHash));
      cell(mr, orDash(mi.segment), "num");
      cell(mr, orDash(mi.callIndex), "num");
      cell(mr, orDash(mi.entryPoint));
      cell(mr, orDash(mi.kind) + (mi.privacy ? " " + txt(mi.privacy) : ""));
      cell(mr, orDash(mi.amount), "num");
      cell(mr, originChip(m.mints[n].origin));
      mb.appendChild(mr);
    }
  }
  main.appendChild(mints);

  // Q12: the mint table stays and the transactions table joins it — one list carries everything,
  // and the mint history the owner has seen is still where it was. What follows the mints depends
  // on what the chain publishes about this token: a shielded row gets the disclosure panel above
  // its table (US4), a ledger row gets its contract's calls under the public-data note (US7), and
  // DUST gets the note alone (Q13).
  var vis = visibilityOf(t);
  if (vis === "disclosed-imbalances") main.appendChild(disclosureSection(t, m.disclosure));
  if (vis === "not-tracked") main.appendChild(dustSection());
  else if (vis === "calls-only") {
    main.appendChild(callsSection(d.calls, "contract calls · this is what a ledger token publishes",
      "a ledger token has no colour and no UTXO: its balances live in its contract's state, which "
      + "this indexer does not read. What is public is every call of the contract, listed above.", m.calls));
  } else {
    main.appendChild(activitySection(t, d, m.activity, factOf(m, "activityCount")));
  }

  if (t.address) {
    main.appendChild(eventsSection(m.events, t.domainSep, "raw token-metadata events of this contract (rejected ones included)",
      d.eventsMore === true ? t.address : null));
  }

  if (d.notes.length > 0) {
    var notes = node("section");
    notes.appendChild(node("h2", "partial data"));
    for (var q = 0; q < d.notes.length; q++) notes.appendChild(node("div", d.notes[q], "err"));
    main.appendChild(notes);
  }
}
function factOf(m, field) {
  for (var i = 0; i < m.facts.length; i++) if (m.facts[i].field === field) return m.facts[i];
  return { field: field, origin: originView(null, null) };
}
var ORIGIN_LEGEND = "every value carries where it came from: MIP-0018 declaration (the package that "
  + "declared it: transaction, block, position, segment, parts, phase, event ids) · Public interface "
  + "(the publication and the levels its bundle passed) · Chain observation (the transaction or mint "
  + "in the archive) · Derived by this indexer (the rule applied) · Not available (why). A dashed "
  + "label is this page's own, for a value the API serves without an origin.";
// One value of the token's "value | origin" table, drawn by what it is.
function tokenFactValue(it, t) {
  var f = it.field;
  if (it.value === null) return node("span", "-", "no");
  if (f === "address") return isHex(it.value) ? copyable(it.value, it.value, "hex") : node("span", it.value, "no");
  if (f === "domainSep") return isHex(it.value) ? domainCell(it.value) : node("span", it.value, "no");
  if (f === "color") return copyable(it.value, it.value, "hex");
  if (f === "status") return statusBadge(it.value);
  if (f === "tokenUri") return uriLink(it.value);
  if (f === "visibility") return visibilityCell(t);
  return node("span", it.value, "txt wrapv");
}
// The cells of a token row in another table, each value with its chip.
function rowCells(tr, items, t, fields) {
  for (var i = 0; i < fields.length; i++) {
    var it = null;
    for (var j = 0; j < items.length; j++) if (items[j].field.slice(items[j].field.lastIndexOf(":") + 1) === fields[i]) it = items[j];
    if (it === null) { cell(tr, "-"); continue; }
    var v;
    if (fields[i] === "domainSep") v = it.value === null ? node("span", "-", "no") : domainCell(it.value);
    else if (fields[i] === "kind") v = kindCell(t);
    else if (fields[i] === "color") v = colorCell(it.value, t ? t.storage : null);
    else if (fields[i] === "status") v = statusBadge(it.value);
    // a name or a symbol in a table row is drawn within NAME_MAX (whole on the token's own view, and
    // copied whole): 2 000 rows of 8 000 hidden characters each made 128 M characters (R4F)
    else if (fields[i] === "name") v = it.value === null ? node("span", "(undescribed)", "no") : boundedNode(it.value, NAME_MAX, "txt");
    else v = it.value === null ? node("span", "-", "no") : boundedNode(it.value, NAME_MAX, "txt");
    var td = cell(tr, withOrigin(v, it.origin));
    marked(td, it.field);
  }
}
// Every key of the token with the declaration that set it — and, under a key declared more than
// once, the earlier declarations (a Null included), newest first, with P1 named as the rule that
// picked the current one.
function traitsSection(m) {
  var traits = node("section");
  traits.id = "traits";
  traits.appendChild(node("h2", "traits: every key with the declaration that set it, and the earlier ones"));
  if (m.traits.length === 0) {
    traits.appendChild(node("div", "no key/value pairs recorded for this token", "empty"));
    return traits;
  }
  if (m.historyPartial) traits.appendChild(partialEventsNote(m.token.address, "the earlier declarations listed under a key"));
  if (m.traitsMore !== null) {
    var tm = marked(node("div", null, "note err"), m.traitsCount.field);
    tm.appendChild(node("span", "the first " + groupDigits(m.traits.length) + " of " + groupDigits(m.traitsMore)
      + " keys are listed — all of them: "));
    var ta = node("a", "every key (API)");
    ta.href = m.token.address && m.token.domainSep ? tokenBase(m.token) + "/metadata" : P_COLORS + "/" + enc(m.token.color);
    ta.target = "_blank";
    ta.rel = "noopener";
    tm.appendChild(ta);
    tm.appendChild(node("span", "  "));
    tm.appendChild(originChip(m.traitsCount.origin));
    traits.appendChild(tm);
  }
  var tb = tableIn(traits, ["key", "type", "value", "len", "parts · phase", "projection", "block", "tx", "event id", "origin"]);
  var anyError = false;
  var anyP1 = false;
  for (var k = 0; k < m.traits.length; k++) {
    var ti = m.traits[k];
    var kv = ti.trait;
    var row = marked(document.createElement("tr"), ti.field);
    cell(row, traitKeyCell(kv));
    cell(row, node("span", typeLabel(kv.valType), "vtype"));
    cell(row, traitValueCell(kv, ti.field));
    cell(row, orDash(kv.valLen), "num");
    cell(row, partsPhaseCell(kv.parts, kv.phase));
    if (kv.projectionError) {
      anyError = true;
      cell(row, node("span", txt(kv.projectionError), "perr wrapv"));
    } else {
      cell(row, node("span", "-", "no"));
    }
    cell(row, orDash(kv.updatedHeight), "num");
    cell(row, txLink(kv.updatedTxHash));
    cell(row, orDash(kv.eventId), "num");
    var oc = node("span");
    oc.appendChild(originChip(ti.origin));
    if (ti.origin.p1) { anyP1 = true; oc.appendChild(p1Mark()); }
    cell(row, oc);
    tb.appendChild(row);
    for (var h = 0; h < ti.history.length; h++) {
      var hi = ti.history[h];
      var hr = marked(document.createElement("tr"), hi.field);
      hr.className = "hist";
      cell(hr, node("span", "↳ earlier", "note"));
      cell(hr, node("span", typeLabel(hi.valType), "vtype"));
      // An earlier declaration and a raw event are drawn within HISTORY_MAX (copied whole): up to
      // 2 000 events of up to 64 KB each must not become hundreds of millions of characters (R2D).
      cell(hr, hi.value === null ? node("span", "-", "no")
        : boundedNode(hi.value, HISTORY_MAX, Number(hi.valType) === 5 ? "no" : "txt wrapv"));
      cell(hr, "-", "num");
      cell(hr, partsPhaseCell(hi.parts, hi.phase));
      cell(hr, node("span", "superseded", "no"));
      cell(hr, orDash(hi.blockHeight), "num");
      cell(hr, txLink(hi.txHash));
      cell(hr, orDash(hi.eventId), "num");
      cell(hr, originChip(hi.origin));
      tb.appendChild(hr);
    }
  }
  if (anyP1) {
    var p1 = node("div", null, "note");
    p1.appendChild(p1Mark());
    p1.appendChild(node("span", "  " + P1_RULE + ". The rows marked ↳ are the earlier declarations of the key above them."));
    traits.appendChild(p1);
  }
  if (anyError) {
    traits.appendChild(node("div",
      "a value in the projection column is a key this explorer projects into a column of its own "
      + "whose value the column cannot hold. The event was accepted and the trait is kept, only "
      + "the column it would have filled was not written - the standard's appendix A is "
      + "informative and a projection is this explorer's convention, never a verdict on the "
      + "contract",
      "note"));
  }
  return traits;
}

// ── Raw events (shared by the token and contract views) ─────────────────────────────────────

// Events of the whole contract, with this token's own lifted to the top: a five-piece collection
// emits five keys per piece, and hunting one piece's rename in 27 rows is not reading, it is work.
function orderEvents(events, markDomain) {
  var byId = events.slice().sort(function (a, b) {
    var x = Number(a.eventId === undefined ? a.id : a.eventId);
    var y = Number(b.eventId === undefined ? b.id : b.eventId);
    return (isNaN(x) ? 0 : x) - (isNaN(y) ? 0 : y);
  });
  if (!markDomain) return byId;
  var mine = [];
  var others = [];
  for (var i = 0; i < byId.length; i++) {
    var dom = byId[i].domainSep || byId[i].domain_sep;
    if (dom === markDomain) mine.push(byId[i]); else others.push(byId[i]);
  }
  return mine.concat(others);
}

// A contract with more events than the page reads: say so, and link the whole list (the API route,
// raw JSON, paginated by its cursor).
function partialEventsNote(address, what) {
  var n = node("div", null, "note err");
  n.appendChild(node("span", "this contract has more token-metadata events than " + eventsReadText() + ": "
    + what + " come from those read, oldest first — the rest: "));
  var a = node("a", "every event (API)");
  a.href = P_CONTRACTS + "/" + enc(address) + "/events?limit=" + EVENT_LIMIT;
  a.target = "_blank";
  a.rel = "noopener";
  n.appendChild(a);
  return n;
}
var EVENTS_ORDER_NOTE = "this token's own events first (highlighted), then the rest of the contract's, each in "
  + "event-id order — the order the scanner read them. Which declaration of a key is in force is rule P1's "
  + "choice among the APPLIED rows (block, transaction position, execution order; a multi-part package placed "
  + "by its first part); a rejected row never applies. The traits above show the result.";
function eventsSection(items, markDomain, heading, moreOf) {
  var sec = node("section");
  sec.id = "events";
  sec.appendChild(node("h2", heading));
  if (moreOf) sec.appendChild(partialEventsNote(moreOf, "the rows below"));
  if (!items || items.length === 0) {
    sec.appendChild(node("div", "no token-metadata event from this contract", "empty"));
    return sec;
  }
  if (markDomain) {
    // Not "the last row wins": the value in force is P1's choice among the applied rows (audit 03-E1a
    // finding R3J).
    sec.appendChild(node("div", EVENTS_ORDER_NOTE, "note"));
  }
  // One row per package: a multi-part declaration is one event row with its part count, and its
  // event id is its first part's (P1).
  var tb = tableIn(sec, ["event id", "block", "tx", "domainSep", "kind", "key", "type",
    "len", "value", "applied", "reject reason", "parts · phase", "origin"]);
  for (var i = 0; i < items.length; i++) {
    var e = items[i].row;
    var tr = marked(document.createElement("tr"), items[i].field);
    var dom = e.domainSep || e.domain_sep;
    if (markDomain && dom === markDomain) tr.className = "mark";
    cell(tr, orDash(e.eventId === undefined ? e.id : e.eventId), "num");
    cell(tr, orDash(e.blockHeight), "num");
    cell(tr, txLink(e.txHash));
    cell(tr, domainCell(dom));
    cell(tr, orDash(e.kindByte === undefined ? e.kind_byte : e.kindByte), "num");
    var key = e.keyText || (e.key ? hexText(e.key) : null) || e.key;
    cell(tr, orDash(key));
    cell(tr, node("span", typeLabel(e.valType), "vtype"));
    cell(tr, orDash(e.valLen === undefined ? e.len : e.valLen), "num");
    var value = e.text !== undefined && e.text !== null ? txt(e.text)
      : (e.value ? (hexText(e.value) || shortHex(e.value, 10, 8)) : null);
    cell(tr, value === null ? node("span", Number(e.valType) === 5 ? "Null" : "-", "no") : boundedNode(value, HISTORY_MAX, "wrapv"));
    cell(tr, e.applied === true ? node("span", "yes", "txt")
      : (e.applied === false ? node("span", "no", "err") : "-"));
    cell(tr, e.rejectReason ? node("span", txt(e.rejectReason), "err wrapv") : node("span", "-", "no"));
    cell(tr, partsPhaseCell(e.parts, e.phase));
    cell(tr, originChip(items[i].origin));
    tb.appendChild(tr);
  }
  return sec;
}

// ── View: contract ──────────────────────────────────────────────────────────────────────────

function renderContract(main) {
  var c = state.contract;
  var crumb = node("div", null, "crumb");
  var back = node("a", "← all tokens");
  back.href = "#/";
  crumb.appendChild(back);
  main.appendChild(crumb);

  if (!c || !c.contract) {
    var miss = node("section");
    miss.appendChild(node("h2", "contract"));
    miss.appendChild(node("div", "not loaded (see the banner above). Address " + state.route.address, "empty"));
    main.appendChild(miss);
    return;
  }
  var d = c.contract;
  // 00024-03: drawn from one model, every value with its origin (contractModel).
  var m = contractModel(c);
  var head = node("section");
  head.id = "facts";
  head.appendChild(node("h2", "contract · every value with where it came from"));
  factsTable(head, m.facts, function (it) {
    if (it.value === null) return node("span", "-", "no");
    if (it.field === "address") return copyable(it.value, it.value, "hex");
    if (it.field === "deployTxHash") return txLink(it.value);
    return node("span", it.value, "txt");
  });
  main.appendChild(head);

  main.appendChild(interfaceSection(m.face));

  var toks = node("section");
  toks.id = "tokens";
  toks.appendChild(node("h2", "tokens of this contract"));
  var list = itemsOf(d.tokens ? { items: d.tokens } : null);
  if (list.length === 0) {
    toks.appendChild(node("div", "no token row for this contract yet", "empty"));
  } else {
    var tb = tableIn(toks, ["domainSep", "kind", "colour", "name", "symbol", "dec",
      "mints", "status"]);
    for (var i = 0; i < m.tokens.length; i++) {
      var t = m.tokens[i].token;
      var tr = document.createElement("tr");
      tr.className = "pick";
      rowCells(tr, m.tokens[i].items, t, CONTRACT_TOKEN_FIELDS);
      (function (token) {
        tr.addEventListener("click", function () {
          go(hashToken({ address: d.address, domainSep: token.domainSep, kind: token.kind }));
        });
      })(t);
      tb.appendChild(tr);
    }
    if (m.tokensCount) {
      var tc = marked(node("div", null, "note err"), m.tokensCount.field);
      tc.appendChild(node("span", "the first " + groupDigits(m.tokens.length) + " of " + groupDigits(m.tokensCount.value)
        + " token rows are listed — all of them: "));
      var tca = node("a", "every token row (API)");
      tca.href = P_CONTRACTS + "/" + enc(d.address);
      tca.target = "_blank";
      tca.rel = "noopener";
      tc.appendChild(tca);
      tc.appendChild(node("span", "  "));
      tc.appendChild(originChip(m.tokensCount.origin));
      toks.appendChild(tc);
    }
    toks.appendChild(node("div", "each value carries its own origin; open a row for the token's whole page", "note"));
  }
  main.appendChild(toks);

  var pend = node("section");
  pend.appendChild(node("h2", "pending event lookups"));
  if (m.pending.length === 0) {
    pend.appendChild(node("div", "none: every emitting call of this contract has had its events read", "empty"));
  } else {
    pend.appendChild(pendingTable(d.pendingLookups, m.pending));
  }
  main.appendChild(pend);

  // US7: the same table a ledger token's page shows, under the same note — a contract's calls are
  // public whatever kind of token it issues.
  main.appendChild(callsSection(c.calls, "calls of this contract", null, m.calls));

  main.appendChild(eventsSection(m.events, null, "raw token-metadata events of this contract (rejected ones included)",
    c.eventsMore === true ? d.address : null));

  if (c.notes.length > 0) {
    var notes = node("section");
    notes.appendChild(node("h2", "partial data"));
    for (var n = 0; n < c.notes.length; n++) notes.appendChild(node("div", c.notes[n], "err"));
    main.appendChild(notes);
  }
}

// ── The contract's public interface (spec 00024 US1, US6; GET /v1/contracts/:address/interface) ─
//
// The current publication first — its result, the levels it passed or the level it failed, the
// Level 3 reason, the commitment, the URL (shortened for the eye, copied whole), where it was
// published, when it was checked and will be again — then what its checks established (files, keys,
// circuits with their argument types, witnesses), its check history, and the older publications
// with its own last result. Every value carries the publication as its origin.
function interfaceSection(face) {
  var sec = node("section");
  sec.id = "interface";
  sec.appendChild(node("h2", "public interface · the current publication, what its checks established, and the older ones"));
  if (!face.present) {
    var none = marked(node("div", null, "row"), face.rows[0].field);
    // A request that failed is not an answer: "none published" only on the API's own word (a 404, or
    // the contract route's null summary) — audit 03-E1a finding F10.
    none.appendChild(node("span", face.unavailable
      ? "the public interface could not be read (see “partial data” below); it is not known whether this contract published one"
      : "no public interface published by this contract", face.unavailable ? "err" : "no"));
    none.appendChild(originChip(face.rows[0].origin));
    sec.appendChild(none);
    return sec;
  }
  // The result at the top is another occurrence of the status row: marked as it, with its origin.
  var head = marked(node("div"), face.rows[0].field);
  var top = node("div", null, "row");
  top.appendChild(ifaceBadge(face.status));
  for (var n = 0; n < face.status.notes.length; n++) top.appendChild(node("span", face.status.notes[n], "note wrapv"));
  head.appendChild(top);
  head.appendChild(originBlock(face.rows[0].origin));
  sec.appendChild(head);

  var tb = tableIn(sec, ["", "value", "origin"]);
  for (var i = 0; i < face.rows.length; i++) {
    var r = face.rows[i];
    var tr = marked(document.createElement("tr"), r.field);
    cell(tr, r.label, "k");
    cell(tr, ifaceValue(r), "fv");
    cell(tr, originChip(r.origin));
    tb.appendChild(tr);
  }

  sec.appendChild(ifaceTable("files the bundle lists (Level 1)", face.files,
    ["path", "size (bytes)", "SHA-256", "origin"], function (tr, it) {
      cell(tr, boundedNode(it.label, NAME_MAX, "txt wrapv"));
      cell(tr, orDash(it.row.size), "num");
      cell(tr, copyable(it.row.sha256, shortHex(txt(it.row.sha256 || ""), 10, 8), "hex"));
    }, "no file: the check did not reach Level 1's file list"));
  sec.appendChild(ifaceTable("verifier keys (Level 2: equal to the contract's on-chain keys)", face.keys,
    ["circuit", "verifier key SHA-256", "Level 2", "origin"], function (tr, it) {
      cell(tr, boundedNode(it.label, NAME_MAX, "txt wrapv"));
      cell(tr, copyable(it.value, shortHex(txt(it.value || ""), 10, 8), "hex"));
      cell(tr, orDash(it.row.l2));
    }, "no key: the check did not reach Level 2"));
  sec.appendChild(ifaceTable("circuits the interface publishes, with their argument types", face.circuits,
    ["circuit", "signature", "pure", "on chain", "key SHA-256", "Level 2", "origin"], function (tr, it) {
      cell(tr, boundedNode(it.label, NAME_MAX, "txt wrapv"));
      cell(tr, boundedNode(it.value, SIG_MAX, "hex wrapv"));
      cell(tr, it.row.pure === true ? "yes" : (it.row.pure === false ? "no" : "-"));
      cell(tr, it.row.onChain === true ? "yes" : (it.row.onChain === false ? "no" : "-"));
      cell(tr, copyable(it.row.keySha256, shortHex(txt(it.row.keySha256 || ""), 10, 8), "hex"));
      cell(tr, orDash(it.row.l2));
    }, "no circuit: the check did not reach Level 2"));
  if (face.circuitsTruncated) {
    sec.appendChild(node("div", "the interface lists more named circuits than the indexer summarises: the first "
      + groupDigits(face.circuits.length) + " are shown (the verification report flags the rest: circuitsTruncated)", "note err"));
  }
  sec.appendChild(ifaceTable("witnesses the bundle's code declares", face.witnesses,
    ["witness", "origin"], function (tr, it) { cell(tr, boundedNode(it.value, NAME_MAX, "txt wrapv")); }, "no witness declared"));
  sec.appendChild(ifaceTable("check history (newest first)", face.checks,
    ["check", "checked at", "trigger", "result", "levels", "L3", "reason", "state block", "origin"], function (tr, it) {
      var ch = it.row;
      cell(tr, orDash(ch.checkNo), "num");
      cell(tr, orDash(ch.checkedAt));
      cell(tr, orDash(ch.trigger));
      cell(tr, ifaceBadge(it.status));
      cell(tr, levelsLine(ch.levels));
      cell(tr, node("span", ch.l3Reason ? txt(ch.l3Reason) : "-", ch.l3Reason ? "wrapv" : "no"));
      cell(tr, node("span", ch.reason ? txt(ch.reason) : "-", ch.reason ? "err wrapv diag" : "no"));
      cell(tr, orDash(ch.stateBlockHeight), "num");
    }, "never checked yet"));
  if (face.checksMore !== null) sec.appendChild(asOccurrence(moreNote(face.checks.length, face.checksMore, "checks", null, null), face, "checks"));
  sec.appendChild(ifaceTable("older publications (historical: each with its own last result, never current)", face.history,
    ["publication", "block", "tx", "parts · phase", "commitment", "URL", "role", "result", "reason", "checked at", "verified until", "origin"],
    function (tr, it) {
      var h = it.row;
      cell(tr, orDash(h.eventId), "num");
      cell(tr, orDash(h.blockHeight), "num");
      cell(tr, txLink(h.txHash));
      cell(tr, partsPhaseCell(h.parts, h.phase));
      cell(tr, copyable(h.commitment, shortHex(txt(h.commitment || ""), 8, 6), "hex"));
      cell(tr, h.url === null || h.url === undefined ? node("span", h.urlError ? "not decodable: " + h.urlError : "-", "no") : urlNode(it.url));
      marked(cell(tr, withOrigin(withTitle(node("span", orDash(h.role), "note"), ROLE_HELP[h.role] || ""), it.role.origin)), it.role.field);
      cell(tr, ifaceBadge(it.status));
      cell(tr, node("span", h.reason ? txt(h.reason) : "-", h.reason ? "err wrapv diag" : "no"));
      cell(tr, orDash(h.checkedAt));
      cell(tr, orDash(h.verifiedUntil));
    }, "none: this is the contract's only publication"));
  if (face.historyMore !== null) {
    sec.appendChild(asOccurrence(moreNote(face.history.length, face.historyMore, "older publications",
      P_CONTRACTS + "/" + enc(face.address) + "/interface/events?limit=" + EVENT_LIMIT, "every publication (API, paginated)"), face, "publications"));
  }
  return sec;
}
// One value of the interface's "value | origin" table, drawn by what it is.
function ifaceValue(r) {
  if (r.status) return ifaceBadge(r.status);
  if (r.value === null) return node("span", "-", "no");
  if (r.url) return urlNode(r.url);
  if (r.hex) return copyable(r.value, r.value, "hex");
  if (r.diagnostic) return node("span", r.value, "err wrapv diag");
  if (r.help) return withTitle(boundedNode(r.value, TEXT_MAX, "txt"), r.help);
  if (r.txHash) {
    var wrap = node("span", null, "wrapv");
    wrap.appendChild(boundedNode(r.value, TEXT_MAX, "txt"));
    wrap.appendChild(node("span", "  "));
    wrap.appendChild(txLink(r.txHash));
    return wrap;
  }
  return boundedNode(r.value, TEXT_MAX, "txt wrapv");
}
// A sub-table of the interface section: its heading, its rows (each with its chip), or why none.
function ifaceTable(heading, items, labels, fill, emptyText) {
  var box = node("div", null, "txsec");
  // no count in the caption: every row is drawn below with its origin (audit 03-E1a finding R4C)
  box.appendChild(node("div", heading, "h"));
  if (items.length === 0) {
    box.appendChild(node("div", emptyText, "empty"));
    return box;
  }
  var tb = tableIn(box, labels);
  for (var i = 0; i < items.length; i++) {
    var tr = marked(document.createElement("tr"), items[i].field);
    fill(tr, items[i]);
    cell(tr, originChip(items[i].origin));
    tb.appendChild(tr);
  }
  return box;
}

function pendingTable(plist, items) {
  var holder = node("div");
  var tb = tableIn(holder, ["tx", "address", "expected", "got", "attempts", "last error"].concat(items ? ["origin"] : []));
  for (var i = 0; i < plist.length; i++) {
    var p = plist[i];
    var tr = document.createElement("tr");
    if (items && items[i]) marked(tr, items[i].field);
    cell(tr, copyable(p.txHash, shortHex(p.txHash, 8, 6), "hex"));
    cell(tr, copyable(p.address, shortHex(p.address, 8, 6), "hex"));
    cell(tr, orDash(p.expected), "num");
    cell(tr, orDash(p.got), "num");
    cell(tr, orDash(p.attempts), "num");
    cell(tr, p.lastError ? node("span", txt(p.lastError), "err wrapv") : node("span", "-", "no"));
    if (items && items[i]) cell(tr, originChip(items[i].origin));
    tb.appendChild(tr);
  }
  return holder;
}

// ── View: status ────────────────────────────────────────────────────────────────────────────

function undisclosedCell(st) {
  var wrap = node("span");
  wrap.appendChild(node("span", orDash(counterOf(st, "undisclosedShieldedOffers")) + "  "));
  var link = node("a", "list them");
  link.href = "#/shielded-offers";
  wrap.appendChild(link);
  return wrap;
}
function renderStatus(main) {
  var st = state.status;
  var sec = node("section");
  sec.appendChild(node("h2", "indexer status  ·  " + P_STATUS));
  if (!st) {
    sec.appendChild(node("div", "the API did not answer (see the banner above)", "empty"));
    main.appendChild(sec);
    return;
  }
  var cur = st.decodeCursor || {};
  var counters = st.counters || {};
  kvInto(sec, [
    ["net", orDash(st.net)],
    // The strip carries two of these (the chain tip and, while it is not zero, the distance); the
    // index's own height and both raw positions live here and only here (Q21, narrowed by Q24).
    ["indexed", orDash(indexedHeight(st))],
    ["chain tip", st.chainHead === undefined || st.chainHead === null
      ? "unavailable — the indexer did not answer" : txt(st.chainHead)],
    ["behind", behindText(st)],
    ["archive tip — raw bytes fetched", orDash(st.archiveTip)],
    ["decode cursor height — bytes decoded; indexed above is the smaller of these two",
      orDash(cur.height)],
    ["decode cursor position", orDash(cur.position)],
    ["contracts", orDash(st.contracts)],
    ["mints", orDash(counters.mints)],
    ["events applied", orDash(counters.eventsApplied)],
    ["events rejected", orDash(counters.eventsRejected)],
    ["lookups ok", orDash(counters.lookupsOk)],
    ["lookups short", orDash(counters.lookupsShort)],
    // 00023, FR-013
    ["activity rows", orDash(counterOf(st, "activityRows"))],
    ["seen tokens (colours no contract has named)", orDash(counterOf(st, "seenTokens"))],
    ["shielded offers", orDash(counterOf(st, "shieldedOffers"))],
    ["undisclosed shielded offers", undisclosedCell(st)],
    ["contract calls", orDash(counterOf(st, "contractCalls"))],
    // 00024-01/02: the multi-part packages and the public interfaces (spec §5, additive).
    ["packages ([Y]): all · multi-part · mixed phase", orDash(counterOf(st, "packages")) + " · "
      + orDash(counterOf(st, "multipartPackages")) + " · " + orDash(counterOf(st, "mixedPackages"))],
    ["public interfaces · publications", orDash(counterOf(st, "interfaces")) + " · "
      + orDash(counterOf(st, "interfacePublications"))],
    ["current interfaces: verified · failed · waiting · unavailable · unreachable",
      orDash(counterOf(st, "interfacesVerified")) + " · " + orDash(counterOf(st, "interfacesFailed")) + " · "
      + orDash(counterOf(st, "interfacesWaiting")) + " · " + orDash(counterOf(st, "interfacesUnavailable"))
      + " · " + orDash(counterOf(st, "interfacesUnreachable"))]
  ]);
  main.appendChild(sec);

  var pend = node("section");
  var plist = st.pendingLookups && st.pendingLookups.length ? st.pendingLookups : [];
  pend.appendChild(node("h2", "pending event lookups (" + plist.length + ")"));
  if (plist.length === 0) {
    pend.appendChild(node("div",
      "none: the scanner has read every event the transcripts promised", "empty"));
  } else {
    pend.appendChild(pendingTable(plist));
  }
  main.appendChild(pend);

  var raw = node("section");
  raw.appendChild(node("h2", "raw"));
  var pre = node("pre");
  try { pre.textContent = JSON.stringify(st, null, 2); } catch (e) { pre.textContent = txt(st); }
  raw.appendChild(pre);
  main.appendChild(raw);
}

// ── Render ──────────────────────────────────────────────────────────────────────────────────

function render() {
  hideTip();
  renderBanner();
  renderStrip();
  renderTabs();
  var main = el("view");
  clear(main);
  // A render boundary: whatever a payload holds, a view that cannot be drawn says so instead of
  // leaving the page blank (audit 03-E1a finding F3); the banner and the tabs above still work.
  try {
    if (state.route.view === "token") renderToken(main);
    else if (state.route.view === "contract") renderContract(main);
    else if (state.route.view === "status") renderStatus(main);
    else if (state.route.view === "tx") renderTx(main);
    else if (state.route.view === "offers") renderOffers(main);
    else renderList(main);
  } catch (e) {
    clear(main);
    var failed = node("section");
    failed.appendChild(node("h2", "this view could not be drawn"));
    failed.appendChild(node("div", "a value in the answer could not be shown: " + txt(e && e.message ? e.message : e), "err"));
    main.appendChild(failed);
  }
  // US2 scenario 3: a token opened from a transaction's activity list lands on its transactions;
  // 00024-03: an origin's evidence link lands on the section it cites. The target is kept until the
  // view that holds it has loaded, so a link followed from another page still arrives.
  if (state.scrollTo) {
    var target = document.getElementById(state.scrollTo);
    if (target) {
      state.scrollTo = null;
      if (target.scrollIntoView) target.scrollIntoView();
    }
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────────────────────

function onHashChange() {
  var next = parseHash();
  var same = routeKey(next) === routeKey(state.route);
  state.route = next;
  // A section named in the route is scrolled to once drawn; a route without one forgets any
  // earlier target, so it cannot fire later on another view.
  state.scrollTo = next.focus ? next.focus : null;
  if (!same) {
    state.expandText = {};
    if (next.view === "token") {
      state.detail = null;
      // A different token starts with an unfiltered, one-page, all-collapsed transactions section.
      state.act = { role: "", pages: 1, expand: {} };
    }
    if (next.view === "contract") { state.contract = null; state.act.pages = 1; }
    if (next.view === "tx") state.tx = null;
    if (next.view === "offers") { state.offers.loaded = false; state.offers.pages = 1; }
    if (next.view === "list") state.list.loaded = false;
  }
  render();
  refresh();
}
function applyFilters() {
  state.filters.kind = el("f-kind").value;
  state.filters.storage = el("f-storage").value;
  state.filters.status = el("f-status").value;
  state.filters.q = el("q").value.trim();
  // Applied in the browser (see visibleListItems); it also widens the page listQuery asks for.
  state.filters.mip = el("f-mip").value;
  state.list.loaded = false;
  state.list.items = [];
  render();
  refresh();
}
function schedule() {
  if (state.timer !== null) { window.clearInterval(state.timer); state.timer = null; }
  if (!state.paused) state.timer = window.setInterval(refresh, REFRESH_MS);
  el("toggle").textContent = state.paused ? "resume auto-refresh" : "pause auto-refresh";
  // The strip's relative time has to move BETWEEN refreshes: on a healthy page it would otherwise
  // only ever read "just now", and on a broken one it would freeze at whatever it said when the
  // last refresh failed — exactly when the reader needs it to keep counting. Redrawing the strip
  // alone is a handful of nodes a second; no view is touched, and the 10 s data refresh above is
  // unchanged. One interval for the life of the page, never a second one.
  if (state.tick === null) state.tick = window.setInterval(renderStrip, STRIP_TICK_MS);
}
function toggle() { state.paused = !state.paused; schedule(); if (!state.paused) refresh(); }

// The proof-of-concept notice can be hidden. The choice is kept in localStorage when the browser
// allows it (a private window may not), and an "about" button in the tab bar brings it back.
var POC_KEY = "umbra.poc.hidden";
function pocHidden() {
  try { return window.localStorage.getItem(POC_KEY) === "1"; } catch (e) { return false; }
}
function setPoc(hidden) {
  el("poc").hidden = hidden;
  el("poc-show").hidden = !hidden;
  try {
    if (hidden) window.localStorage.setItem(POC_KEY, "1");
    else window.localStorage.removeItem(POC_KEY);
  } catch (e) { /* not persisted; still applied for this visit */ }
}

window.addEventListener("DOMContentLoaded", function () {
  state.route = parseHash();
  state.scrollTo = state.route.focus ? state.route.focus : null;
  setPoc(pocHidden());
  el("poc-hide").addEventListener("click", function () { setPoc(true); });
  el("poc-show").addEventListener("click", function () { setPoc(false); });
  el("now").addEventListener("click", function () { refresh(); });
  el("toggle").addEventListener("click", toggle);
  el("clear").addEventListener("click", function () {
    el("q").value = ""; el("f-kind").value = ""; el("f-storage").value = ""; el("f-status").value = "";
    el("f-mip").value = "";
    applyFilters();
  });
  el("f-kind").addEventListener("change", applyFilters);
  el("f-storage").addEventListener("change", applyFilters);
  el("f-status").addEventListener("change", applyFilters);
  el("f-mip").addEventListener("change", applyFilters);
  el("q").addEventListener("input", function () {
    if (state.debounce !== null) window.clearTimeout(state.debounce);
    state.debounce = window.setTimeout(function () { state.debounce = null; applyFilters(); }, 400);
  });
  el("q").addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter") return;
    if (state.debounce !== null) { window.clearTimeout(state.debounce); state.debounce = null; }
    applyFilters();
  });
  window.addEventListener("hashchange", onHashChange);
  render();
  schedule();
  refresh();
});
`;

// ── The document ─────────────────────────────────────────────────────────────────────────────

const BODY = `<aside id="poc" class="poc" role="note">
  <button id="poc-hide" class="poc-x" type="button" aria-controls="poc">HIDE</button>
  <div class="poc-h">Proof of concept</div>
  <p><b>This explorer lists every token on Midnight Stagenet</b>, with the name, symbol and
    decimals of each token whose contract publishes them.</p>
  <p>Midnight has no standard way for a token to publish its name, symbol or decimals.
    <!-- The MIP is merged, so the page points at the standard itself on main rather than at the
         pull request that proposed it: a PR link is a moment in the discussion, and the file on
         main is the document a reader of this page actually wants (owner, Phase G change 6). -->
    <b><a href="https://github.com/midnightntwrk/midnight-improvement-proposals/blob/main/mips/mip-0018-on-chain-token-metadata.md" target="_blank" rel="noopener noreferrer">MIP-0018</a>, On-Chain Token Metadata Emission</b>
    adds one: a contract announces its token's metadata by emitting <b>events</b>, and an indexer
    like this one collects them.</p>
  <!-- The placeholder-number history and the per-value "pre-MIP name" badge were removed at the
       owner's request after the live review: a reader of the page does not need to know which
       event name a value arrived under. The API still reports nameVariant for machines. -->
  <ul class="poc-links">
    <li>Indexer:
      <a href="https://github.com/acedward/UmbraDB/pull/19" target="_blank" rel="noopener noreferrer">UmbraDB PR&nbsp;#19</a></li>
    <li>Contracts:
      <a href="https://github.com/acedward/mip-erc7496-midnight-contracts" target="_blank" rel="noopener noreferrer">mip-erc7496-midnight-contracts</a></li>
    <li>Token addresses:
      <a href="https://github.com/effectstream/staging-tokens-addresses" target="_blank" rel="noopener noreferrer">staging-tokens-addresses</a></li>
  </ul>
</aside>
<header>
  <div class="brand">
    <svg viewBox="0 0 122.895 26.625" fill="currentColor" aria-hidden="true" focusable="false"> <g transform="translate(-42.52 -145.266)" fill-rule="evenodd"> <path d="M 55.832031 147.71875 C 61.816406 147.71875 66.6875 152.59375 66.6875 158.578125 C 66.6875 164.5625 61.816406 169.429688 55.832031 169.429688 C 49.847656 169.429688 44.972656 164.5625 44.972656 158.578125 C 44.972656 152.59375 49.847656 147.71875 55.832031 147.71875 Z M 55.832031 145.265625 C 48.480469 145.265625 42.519531 151.226562 42.519531 158.578125 C 42.519531 165.929688 48.480469 171.890625 55.832031 171.890625 C 63.183594 171.890625 69.144531 165.929688 69.144531 158.578125 C 69.144531 151.226562 63.183594 145.265625 55.832031 145.265625 Z M 55.832031 145.265625 "/> <path d="M 54.585938 157.328125 L 54.585938 159.824219 L 57.082031 159.824219 L 57.082031 157.328125 Z M 54.585938 157.328125 "/> <path d="M 54.585938 153.382812 L 54.585938 155.882812 L 57.082031 155.882812 L 57.082031 153.382812 Z M 54.585938 153.382812 "/> <path d="M 54.585938 149.4375 L 54.585938 151.933594 L 57.082031 151.933594 L 57.082031 149.4375 Z M 54.585938 149.4375 "/> <path d="M 82.28125 152.714844 C 81.414062 152.714844 80.636719 152.902344 79.953125 153.277344 C 79.570312 153.480469 79.226562 153.742188 78.929688 154.046875 L 78.929688 152.964844 L 75.792969 152.964844 L 75.792969 164.855469 L 78.929688 164.855469 L 78.929688 157.828125 C 78.929688 157.347656 79.035156 156.9375 79.246094 156.601562 C 79.464844 156.269531 79.742188 156.007812 80.089844 155.828125 C 80.433594 155.648438 80.828125 155.554688 81.269531 155.554688 C 81.929688 155.554688 82.480469 155.753906 82.921875 156.148438 C 83.371094 156.542969 83.59375 157.101562 83.59375 157.828125 L 83.59375 164.855469 L 86.722656 164.855469 L 86.722656 157.828125 C 86.722656 157.347656 86.828125 156.9375 87.046875 156.601562 C 87.257812 156.269531 87.542969 156.007812 87.894531 155.828125 C 88.25 155.648438 88.640625 155.554688 89.0625 155.554688 C 89.707031 155.554688 90.25 155.753906 90.695312 156.148438 C 91.136719 156.542969 91.359375 157.101562 91.359375 157.828125 L 91.359375 164.855469 L 94.515625 164.855469 L 94.515625 157.304688 C 94.515625 156.335938 94.308594 155.515625 93.898438 154.839844 C 93.488281 154.167969 92.929688 153.640625 92.222656 153.277344 C 91.515625 152.902344 90.726562 152.714844 89.859375 152.714844 C 88.980469 152.714844 88.167969 152.910156 87.449219 153.289062 C 86.859375 153.597656 86.367188 154.015625 85.957031 154.542969 C 85.585938 154 85.109375 153.574219 84.53125 153.261719 C 83.855469 152.902344 83.101562 152.714844 82.28125 152.714844 Z M 82.28125 152.714844 "/> <path d="M 95.984375 152.964844 L 95.984375 164.855469 L 99.113281 164.855469 L 99.113281 152.964844 Z M 95.984375 152.964844 "/> <path d="M 106.554688 155.605469 C 107.164062 155.605469 107.695312 155.746094 108.15625 156.039062 C 108.613281 156.324219 108.980469 156.707031 109.242188 157.191406 C 109.507812 157.683594 109.640625 158.253906 109.640625 158.914062 C 109.640625 159.570312 109.503906 160.117188 109.242188 160.613281 C 108.980469 161.105469 108.621094 161.488281 108.15625 161.769531 C 107.695312 162.046875 107.15625 162.191406 106.527344 162.191406 C 105.9375 162.191406 105.410156 162.054688 104.9375 161.78125 C 104.472656 161.515625 104.105469 161.125 103.839844 160.625 C 103.578125 160.125 103.449219 159.550781 103.449219 158.914062 C 103.449219 158.265625 103.578125 157.683594 103.839844 157.191406 C 104.105469 156.707031 104.472656 156.324219 104.9375 156.039062 C 105.410156 155.746094 105.945312 155.605469 106.554688 155.605469 Z M 109.441406 147.046875 L 109.441406 154.046875 C 109.125 153.726562 108.757812 153.46875 108.339844 153.25 C 107.660156 152.898438 106.882812 152.722656 106.011719 152.722656 C 104.910156 152.722656 103.921875 152.988281 103.050781 153.535156 C 102.183594 154.078125 101.492188 154.816406 100.996094 155.738281 C 100.492188 156.671875 100.238281 157.734375 100.238281 158.9375 C 100.238281 160.136719 100.492188 161.148438 100.996094 162.078125 C 101.492188 163.011719 102.183594 163.742188 103.050781 164.289062 C 103.925781 164.832031 104.910156 165.101562 106.011719 165.101562 C 106.863281 165.101562 107.644531 164.917969 108.339844 164.542969 C 108.769531 164.320312 109.144531 164.042969 109.464844 163.71875 L 109.464844 164.855469 L 112.570312 164.855469 L 112.570312 147.046875 Z M 109.441406 147.046875 "/> <path d="M 120.667969 152.722656 C 119.796875 152.722656 118.960938 152.914062 118.25 153.3125 C 117.847656 153.535156 117.5 153.808594 117.191406 154.132812 L 117.191406 152.964844 L 114.058594 152.964844 L 114.058594 164.855469 L 117.191406 164.855469 L 117.191406 158.023438 C 117.191406 157.546875 117.300781 157.117188 117.511719 156.738281 C 117.722656 156.359375 118.015625 156.070312 118.386719 155.863281 C 118.761719 155.660156 119.183594 155.558594 119.65625 155.558594 C 120.363281 155.558594 120.945312 155.789062 121.40625 156.25 C 121.871094 156.707031 122.101562 157.300781 122.101562 158.023438 L 122.101562 164.855469 L 125.230469 164.855469 L 125.230469 157.328125 C 125.230469 156.542969 125.03125 155.796875 124.640625 155.089844 C 124.242188 154.378906 123.703125 153.808594 123.011719 153.375 C 122.316406 152.941406 121.542969 152.722656 120.667969 152.722656 Z M 120.667969 152.722656 "/> <path d="M 126.675781 152.964844 L 126.675781 164.855469 L 129.804688 164.855469 L 129.804688 152.964844 Z M 126.675781 152.964844 "/> <path d="M 137.320312 155.578125 C 137.925781 155.578125 138.4375 155.714844 138.890625 155.976562 C 139.335938 156.238281 139.691406 156.597656 139.9375 157.050781 C 140.179688 157.503906 140.304688 158.03125 140.304688 158.640625 C 140.304688 159.25 140.179688 159.757812 139.9375 160.214844 C 139.691406 160.675781 139.34375 161.035156 138.890625 161.292969 C 138.4375 161.546875 137.902344 161.667969 137.292969 161.667969 C 136.683594 161.667969 136.183594 161.539062 135.730469 161.277344 C 135.277344 161.019531 134.921875 160.652344 134.667969 160.191406 C 134.414062 159.734375 134.289062 159.21875 134.289062 158.640625 C 134.289062 158.03125 134.414062 157.503906 134.667969 157.050781 C 134.921875 156.597656 135.277344 156.238281 135.730469 155.976562 C 136.183594 155.714844 136.710938 155.578125 137.320312 155.578125 Z M 136.679688 152.722656 C 135.628906 152.722656 134.671875 152.976562 133.816406 153.5 C 132.964844 154.015625 132.296875 154.714844 131.8125 155.605469 C 131.328125 156.492188 131.078125 157.496094 131.078125 158.613281 C 131.078125 159.734375 131.320312 160.738281 131.8125 161.640625 C 132.296875 162.53125 132.964844 163.242188 133.816406 163.769531 C 134.671875 164.296875 135.636719 164.558594 136.703125 164.558594 C 137.578125 164.558594 138.355469 164.382812 139.050781 164.03125 C 139.449219 163.824219 139.800781 163.570312 140.105469 163.269531 L 140.105469 164.316406 C 140.105469 165.214844 139.816406 165.929688 139.230469 166.445312 C 138.648438 166.964844 137.839844 167.21875 136.804688 167.21875 C 135.996094 167.21875 135.308594 167.078125 134.730469 166.792969 C 134.160156 166.5 133.636719 166.078125 133.175781 165.519531 L 131.179688 167.519531 C 131.753906 168.339844 132.523438 168.976562 133.488281 169.429688 C 134.449219 169.882812 135.566406 170.109375 136.851562 170.109375 C 138.136719 170.109375 139.207031 169.867188 140.167969 169.382812 C 141.132812 168.898438 141.882812 168.21875 142.429688 167.34375 C 142.96875 166.476562 143.242188 165.457031 143.242188 164.289062 L 143.242188 152.964844 L 140.132812 152.964844 L 140.132812 154.007812 C 139.828125 153.710938 139.472656 153.457031 139.0625 153.25 C 138.363281 152.898438 137.566406 152.722656 136.679688 152.722656 Z M 136.679688 152.722656 "/> <path d="M 144.578125 147.046875 L 144.578125 164.855469 L 147.707031 164.855469 L 147.707031 158.023438 C 147.707031 157.546875 147.816406 157.117188 148.03125 156.738281 C 148.242188 156.359375 148.539062 156.070312 148.90625 155.863281 C 149.277344 155.660156 149.699219 155.554688 150.179688 155.554688 C 150.878906 155.554688 151.464844 155.789062 151.929688 156.25 C 152.386719 156.707031 152.617188 157.300781 152.617188 158.023438 L 152.617188 164.855469 L 155.746094 164.855469 L 155.746094 157.328125 C 155.746094 156.429688 155.554688 155.628906 155.167969 154.925781 C 154.785156 154.230469 154.238281 153.683594 153.542969 153.300781 C 152.839844 152.914062 152.039062 152.714844 151.140625 152.714844 C 150.234375 152.714844 149.433594 152.914062 148.730469 153.3125 C 148.347656 153.53125 148.003906 153.796875 147.707031 154.105469 L 147.707031 147.046875 Z M 144.578125 147.046875 "/> <path d="M 159.496094 148.011719 L 159.496094 152.964844 L 156.683594 152.964844 L 156.683594 155.703125 L 159.496094 155.703125 L 159.496094 164.855469 L 162.632812 164.855469 L 162.632812 155.703125 L 165.414062 155.703125 L 165.414062 152.964844 L 162.632812 152.964844 L 162.632812 148.011719 Z M 159.496094 148.011719 "/> <path d="M 97.539062 147.414062 C 96.558594 147.414062 95.761719 148.207031 95.761719 149.191406 C 95.761719 150.171875 96.558594 150.964844 97.539062 150.964844 C 98.519531 150.964844 99.3125 150.171875 99.3125 149.191406 C 99.3125 148.207031 98.519531 147.414062 97.539062 147.414062 Z M 97.539062 147.414062 "/> <path d="M 128.242188 147.414062 C 127.261719 147.414062 126.464844 148.207031 126.464844 149.191406 C 126.464844 150.171875 127.261719 150.964844 128.242188 150.964844 C 129.222656 150.964844 130.015625 150.171875 130.015625 149.191406 C 130.015625 148.207031 129.222656 147.414062 128.242188 147.414062 Z M 128.242188 147.414062 "/> </g> </svg>
    <span class="rule"></span>
    <h1>Token explorer</h1>
  </div>
  <nav class="tabs">
    <a id="nav-list" href="#/">tokens</a>
    <a id="nav-offers" href="#/shielded-offers">shielded offers</a>
    <a id="nav-status" href="#/status">status</a>
    <span class="sep"></span>
    <span id="strip" class="strip"></span>
    <button id="poc-show" type="button" aria-controls="poc" hidden>about</button>
    <!-- Owner decision Q24: the two refresh controls and the cadence note are hidden, not deleted.
         The 10 s auto-refresh they described keeps running (it is the page's own interval, not
         these buttons), and the strip's "last updated" now says what the cadence note said, on the
         only occasion it matters. They stay in the document, hidden and still wired, because the
         decision is a presentation one and hiding it is the change that can be undone by deleting
         one word. -->
    <button id="now" hidden>refresh now</button>
    <button id="toggle" hidden>pause auto-refresh</button>
    <span class="note" hidden>every 10&nbsp;s</span>
  </nav>
</header>
<div id="banner" class="banner" hidden></div>
<section id="filters" class="filters">
  <label>search
    <input id="q" type="search" size="30" spellcheck="false" autocomplete="off"
           placeholder="name, symbol, colour or address">
  </label>
  <label>kind
    <select id="f-kind">
      <option value="">any</option>
      <option value="0">0 &middot; unshielded &middot; native</option>
      <option value="1">1 &middot; shielded &middot; native</option>
      <option value="2">2 &middot; unshielded &middot; ledger</option>
      <option value="3">3 &middot; shielded &middot; ledger</option>
    </select>
  </label>
  <label>storage
    <select id="f-storage">
      <option value="">any</option>
      <option value="native">native</option>
      <option value="ledger">ledger</option>
    </select>
  </label>
  <label>status
    <select id="f-status">
      <option value="">any</option>
      <option value="builtin">builtin</option>
      <option value="seen">seen</option>
      <option value="observed">observed</option>
      <option value="declared">declared</option>
      <option value="described">described</option>
    </select>
  </label>
  <!-- The one filter applied in the browser: "has metadata published under MIP-0018" is a rule
       over the row's status (declared or described, under either event name), not a column the
       list route filters on. The bar is static markup and only the table re-renders, so the
       selection survives the 10 s auto-refresh like every other control here. -->
  <label>MIP-0018
    <select id="f-mip">
      <option value="">all</option>
      <option value="only">only with MIP-0018</option>
    </select>
  </label>
  <button id="clear">clear</button>
  <span id="count" class="note"></span>
</section>
<main id="view"></main>
<template id="icon-link"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 9.5l3-3"/><path d="M7.2 4.6l1.1-1.1a2.6 2.6 0 0 1 3.7 3.7l-1.1 1.1"/><path d="M8.8 11.4l-1.1 1.1a2.6 2.6 0 0 1-3.7-3.7l1.1-1.1"/></svg></template>`;

function sha256Source(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

/**
 * The page's Content Security Policy.
 *
 * Computed from the very bytes served below, so the hashes cannot drift from the code they
 * authorise — the same construction as the 00009 dashboard, and stricter than the
 * `script-src 'unsafe-inline'` floor the sub-plan allows: a policy that admits all inline code
 * would be a decoration, one that names this page's own two blocks is a control.
 *
 * `default-src 'none'` is the clause that makes "no external resource" a property of the browser
 * rather than a promise of this file: no script, style, image, font, frame or connection is
 * permitted unless a directive below names it. `connect-src 'self'` keeps every `fetch` on this
 * origin (the §5 routes); `img-src 'self' data:` allows a token's inline `data:` image from its
 * metadata document without allowing a remote tracking pixel; `form-action 'none'` and
 * `base-uri 'none'` remove the two ways an injected element could redirect a submission.
 */
export const DASHBOARD_CSP = [
  "default-src 'none'",
  `script-src ${sha256Source(SCRIPT)}`,
  `style-src ${sha256Source(STYLE)}`,
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** The whole explorer: one document, no external reference, no build step. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Midnight token explorer</title>
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/ui/favicon.svg" type="image/svg+xml">
<style>${STYLE}</style>
</head>
<body>
${BODY}
<script>${SCRIPT}</script>
</body>
</html>
`;

const HTML_BYTES = Buffer.byteLength(DASHBOARD_HTML, "utf8");

/** The path of the page, and the one path that redirects to it. */
const UI_PATH = "/ui";
const ROOT_PATH = "/";

/** `/ui` and `/ui/` are the same page; a query string is ignored. */
function pathOf(url: string): string {
  const noHash = url.split("#")[0] ?? "";
  const noQuery = noHash.split("?")[0] ?? "";
  if (noQuery === "") return ROOT_PATH;
  if (noQuery.length > 1 && noQuery.endsWith("/")) return noQuery.slice(0, -1);
  return noQuery;
}

/**
 * Serves the explorer.
 *
 * The token API (`token-indexer/api/server.ts`) calls this first for every request:
 *
 * - `GET|HEAD /ui` (and `/ui/`) → 200, the page, with {@link DASHBOARD_CSP} — returns `true`.
 * - `GET|HEAD /ui/outfit.woff2` → 200, the vendored brand font (cached for a day) — returns `true`.
 * - `GET|HEAD /ui/favicon.svg` and `/favicon.ico` → 200, the Midnight mark — returns `true`.
 * - `GET|HEAD /` → 302 to `/ui`, so typing the bare host and port lands on the page while the
 *   page itself keeps exactly one URL — returns `true`.
 * - anything else → returns `false` **without touching `res`**, so the API's own router answers
 *   it (including a non-GET method on `/ui`, which is the router's 405 to give, not this
 *   module's — the page has no business deciding the API's method policy).
 *
 * The headers are the whole security story of this route, because the page is static:
 * `content-security-policy` (above), `x-content-type-options: nosniff` (the payload is declared
 * HTML and must be read as HTML), `referrer-policy: no-referrer` (there is no external origin to
 * leak to today and there must not be one tomorrow) and `cache-control: no-store` (the page is
 * one string in the process; caching buys nothing and a stale explorer after an upgrade is a
 * support call).
 */
/** The favicon: the Midnight mark (style kit, p.32 vector) in white on a black rounded square,
 *  so it reads on light and dark tab bars alike. A standalone SVG document, so it carries its own
 *  namespace — it is served at its own path, never inlined into the page. */
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0a0a0a"/><g transform="translate(4.5 4.5) scale(0.863850) translate(-42.52 -145.266)" fill="#ffffff" fill-rule="evenodd"><path d="M 55.832031 147.71875 C 61.816406 147.71875 66.6875 152.59375 66.6875 158.578125 C 66.6875 164.5625 61.816406 169.429688 55.832031 169.429688 C 49.847656 169.429688 44.972656 164.5625 44.972656 158.578125 C 44.972656 152.59375 49.847656 147.71875 55.832031 147.71875 Z M 55.832031 145.265625 C 48.480469 145.265625 42.519531 151.226562 42.519531 158.578125 C 42.519531 165.929688 48.480469 171.890625 55.832031 171.890625 C 63.183594 171.890625 69.144531 165.929688 69.144531 158.578125 C 69.144531 151.226562 63.183594 145.265625 55.832031 145.265625 Z M 55.832031 145.265625"/><path d="M 54.585938 157.328125 L 54.585938 159.824219 L 57.082031 159.824219 L 57.082031 157.328125 Z M 54.585938 157.328125"/><path d="M 54.585938 153.382812 L 54.585938 155.882812 L 57.082031 155.882812 L 57.082031 153.382812 Z M 54.585938 153.382812"/><path d="M 54.585938 149.4375 L 54.585938 151.933594 L 57.082031 151.933594 L 57.082031 149.4375 Z M 54.585938 149.4375"/></g></svg>';
const FAVICON_SVG_PATH = "/ui/favicon.svg";
/** The same mark as a 16/32/48 px ICO, for browsers and tools that only ask for `/favicon.ico`. */
const FAVICON_ICO_PATH = "/favicon.ico";
let icoCache: Buffer | null | undefined;
function icoBytes(): Buffer | null {
  if (icoCache === undefined) {
    try {
      icoCache = readFileSync(new URL("./favicon.ico", import.meta.url));
    } catch {
      icoCache = null;
    }
  }
  return icoCache;
}

/** The brand font, read once. `null` when the file is absent, so the route falls through to the
 *  API's 404 and the page renders in its fallback stack. */
const FONT_PATH = "/ui/outfit.woff2";
let fontCache: Buffer | null | undefined;
function fontBytes(): Buffer | null {
  if (fontCache === undefined) {
    try {
      fontCache = readFileSync(new URL("./fonts/Outfit-Variable-latin.woff2", import.meta.url));
    } catch {
      fontCache = null;
    }
  }
  return fontCache;
}

export function serveUi(req: IncomingMessage, res: ServerResponse): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  const path = pathOf(req.url ?? ROOT_PATH);

  if (path === UI_PATH) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(HTML_BYTES),
      "content-security-policy": DASHBOARD_CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    });
    if (method === "HEAD") res.end();
    else res.end(DASHBOARD_HTML);
    return true;
  }

  if (path === FAVICON_SVG_PATH) {
    res.writeHead(200, {
      "content-type": "image/svg+xml",
      "content-length": String(Buffer.byteLength(FAVICON_SVG, "utf8")),
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=86400",
    });
    if (method === "HEAD") res.end();
    else res.end(FAVICON_SVG);
    return true;
  }

  if (path === FAVICON_ICO_PATH) {
    const ico = icoBytes();
    if (ico === null) return false;
    res.writeHead(200, {
      "content-type": "image/x-icon",
      "content-length": String(ico.length),
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=86400",
    });
    if (method === "HEAD") res.end();
    else res.end(ico);
    return true;
  }

  if (path === FONT_PATH) {
    const font = fontBytes();
    if (font === null) return false;
    res.writeHead(200, {
      "content-type": "font/woff2",
      "content-length": String(font.length),
      "x-content-type-options": "nosniff",
      "cache-control": "public, max-age=86400",
    });
    if (method === "HEAD") res.end();
    else res.end(font);
    return true;
  }

  if (path === ROOT_PATH) {
    res.writeHead(302, { location: UI_PATH, "cache-control": "no-store", "content-length": "0" });
    res.end();
    return true;
  }

  return false;
}
