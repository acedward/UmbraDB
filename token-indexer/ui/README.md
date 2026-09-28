# The explorer page — project 00024-03: where every value came from

This note lives beside the page (`ui/page.ts`) rather than in `token-indexer/README.md`: project
00024-03 changes the page and its tests only, and its guard keeps every other file of
`token-indexer/` untouched.

Spec 00024 US6 / FR-016: the explorer page (`ui/page.ts`, one document, a hash-based CSP, the DOM
through `textContent` only) now draws the interface results and, on the token and contract views,
**every value with its origin**. The API is unchanged; the page reads the `origin` fields 00024-01
and 00024-02 added (FR-016b).

| Origin label | Drawn for | Its evidence link |
|---|---|---|
| **MIP-0018 declaration** (", N parts" when the package has more than one) | name, symbol, decimals, tokenUri, metadata, every trait and each earlier declaration of a key, every raw event | the package — transaction, block, position, segment, parts, phase, event ids — linked to the transaction view |
| **Public interface** (", L1/L2/L3" / ", failed at L1" / ", unchecked" …) | the token's interface summary and every value of the contract's interface section (status, levels, commitment, URL, files, keys, circuits, witnesses, checks, older publications) except a publication's role, which is Derived (P2) | the publication — transaction, block, segment, parts, commitment, levels, checked at — linked to the contract's interface section (`#/contract/<address>/interface`) and to the publication transaction |
| **Chain observation** | mints, activity rows, contract calls, the deploy facts | the transaction (or the section that lists the rows) |
| **Derived by this indexer** | colour, status, the kind byte's two bits, heights computed from other rows, the role of a publication (`current` / `historical`, rule P2 — audit 03-E1a F9) | the rule applied and a link to the inputs it names (the contract, the mint history, the declarations, the interface section — F7); a MIP-0018 key declared more than once also names **P1** — "last write, positioned by the first part" — as the rule that picked the current value |
| **Not available** (reason) | a value no source provides | the reason (a Null declaration also links the declaration) |

A few values reach the page with **no** origin in the API (the token's identity, some heights and
counts, a contract's deploy facts and its calls): the page labels them with a fixed rule of its own,
drawn with a dashed edge and saying so in its evidence line (organizer question Q28). The labels come
from one pure view model in the page script (`tokenModel`, `contractModel`, `originView`); the
governed test `[[token-ui-origin]]` evaluates the served script in `node:vm` on recorded payloads
(`../test/fixtures/ui/`) and checks that every value is drawn with its label and that every evidence link
resolves.

What else the page shows:

- **The list** is an index: its note says that each value's origin and evidence link are on the token
  view, one click away (organizer question Q29, default (a); audit 03-E1a finding F1 — the owner may
  choose per-cell origin marks instead).
- **The list** gains an `interface` column: the current publication's status — `pending`, `verified`
  with the levels passed (`L1/L2` or `L1/L2/L3`), `failed at L<n>`, `unchecked`, `unfetchable`,
  `unreachable`, `stale`; the MIP-0018 column adds a part badge (and the phase, when it is not
  `guaranteed`) on multi-part values. The interface column shows no part badge: only
  `GET /v1/interfaces` carries a publication's part count, as whole publications with URLs of up to
  262 112 bytes each, so the list does not ask it (audit 03-E1a finding F4, question Q30); the part
  count and phase are on the contract view.
- **The contract view** gains a "public interface" section from `GET /v1/contracts/:address/interface`:
  status, role, levels, the failure and its level, the Level 3 reason, commitment, the URL (shortened
  for the eye — head … tail, its length — and copied whole; a URL may be 262 112 bytes), the
  publication, the package payload's length and SHA-256, check times (`checkedAt`, `lastVerifiedAt`,
  `verifiedUntil`, `nextCheckAt`), the contract state used, compiler and build, the files, keys,
  circuits (with argument types) and witnesses, the check history, and the older publications
  (`historical`), each with its own result. The API serves the newest 100 checks and older
  publications: when more exist the section says "the newest N of M" and links the paginated
  `GET /v1/contracts/:address/interface/events` (audit 03-E1a finding F6). Diagnostics are shown
  exactly as served (bounded by the indexer). The keys, the circuits and the witnesses are read at
  Level 2, and the API sends `[]` whether or not they were: an empty key list says "none" only when
  Level 2 ran (passed or failed); an empty circuit or witness list only when Level 2 read the bundle's
  contract information (it passed, or failed with its report showing that file read — no
  `(contract-info)` row); otherwise they are "not known" (audit 03-E1a findings R6B, R7A). The
  indexer keeps a bundle's file list only when Level 1 passes: an empty one says so (R8C). The API's
  `not_run` means no result at that level — the level may have started and stopped at a deadline or
  a limit — so no text claims a level never ran (R9A).
- **The heading** of the token view draws every value it shows as its own marked occurrence with its
  own chip: the family badge (a derived value: ledger / dual / collection / privacy, linking the
  contract whose rows decide it), the name (or, for a colour no contract has named, the colour), the
  status and each part of the summary line; the breadcrumb and the other summary lines repeat no
  value without its origin (audit 03-E1a findings R2E, R3B).
- **The token view** gains its contract's interface summary (status and levels; the URL is on the
  contract view), the parts and phase of every trait, and, under a key declared more than once, its
  earlier declarations — a Null included — newest first.
- A package in more than one part, or not in the guaranteed phase, carries a chip with its part count
  and phase — on traits, earlier declarations, raw events and every publication, the current one
  included; a `mixed` package's chip says "a publisher error (FR-002)" in its text (audit 03-E1a
  finding R7D).
- Every answer is read up to 64 MiB (`MAX_RESPONSE_BYTES`: a longer announced length is refused, a
  longer stream cancelled), and the contract view reads `/interface` again only when the contract
  route's summary of the publication changed or the kept document is a minute old (audit 03-E1a
  findings F4, R2C).
- An earlier declaration of a key and a raw event's value are drawn within 160 characters (head …
  tail, the length, copy the whole value — for opaque bytes, every byte: audit 03-E1a finding R6D;
  a Null says it cleared its key only when it was applied — a rejected one shows its bytes, R8A); a current value is drawn whole up to 2 048 drawn
  characters — every realistic long value, e.g. a 677-byte metadata document — and past that on the
  reader's request ("show all", kept across refreshes); at most 500 keys of a token are drawn, the
  rest named with a link to all of them; a name or a symbol in a table row (the contract's token rows
  — at most 500, the count named —, the rows sharing a domain separator, the list) is drawn within
  160 characters, whole on the token's own view. Every budget counts the drawn marks of hidden
  characters too (audit 03-E1a findings R2D, R3E, R4F).
- Text a bundle chooses — circuit, argument and witness names, file paths, build fields — is drawn
  as its head … tail with its length and copied whole (160 characters for a name or a path, 400 for
  a signature, 1 000 for other interface values); interface items are keyed by position, so no
  published name reaches an attribute (audit 03-E1a finding F5).
- A failed read of `/interface` (e.g. a 503) is drawn as "could not be read", never as "no public
  interface published" — that is said only on the API's own word (a 404, or the contract route's
  null summary) (audit 03-E1a finding F10).
- Any other read that fails — the mints, the traits, the raw events, the transactions, the contract's
  calls, its token rows — is not an answer either: its section says it "could not be read" (never
  "no mint observed" or the like), no value cites it (the token's or the contract's row as the API
  serves it is cited instead), and the family is not guessed without the contract's rows (audit
  03-E1a findings R5C, R6A, S2).
- A token's identity (domain separator, kind) cites the raw events only when some of the token's own
  events are among those read; otherwise the API's row of it (audit 03-E1a finding R8B).
- The metadata-updated height cites the traits only when the key its declaration set is among the
  keys drawn (the first 500); otherwise that declaration's transaction, the raw events, or the API's
  row (audit 03-E1a finding R9B).
- A URL (bundle URL, tokenUri) is parsed by the browser's own URL parser: its destination host —
  percent-decoded, IDNA-mapped, as the browser will go to it — is always shown beside the shortened
  text; a URL the parser refuses, or one with user information before its host, is not a link; a
  `localhost` tokenUri rewritten to this origin keeps exactly one leading slash (audit 03-E1a F13,
  R2B, R3F). A tokenUri is drawn within 160 characters in a list row and 1 000 on the token view —
  past that as head … tail with its length, where it leads ("this page's origin" for a rewritten
  `localhost` URI) and a copy of the whole URI; its link is the whole URI (audit 03-E1a findings R6E,
  R7C).
- Characters that change the layout of the text around them or cannot be seen (bidi controls such as
  U+202E, zero-width characters, C0/C1 controls, tag characters) are drawn as a visible mark
  `⟨U+202E⟩` in text and tooltips; copying keeps the original; every piece of published text is a
  bidi-isolated island (`unicode-bidi: isolate`) (audit 03-E1a F14).
- Routes may end in a section (`#/contract/<address>/interface`, `#/token/…/mints`, …), scrolled to
  once drawn. The raw-events table asks for every event of the contract (`/events?limit=500`): the
  route's `applied=false` means "rejected only", which the page had asked for since 00020.
- The contract's events (the raw-events table and a key's earlier declarations) are read up to four
  pages of 500, following the API's cursor. When more exist, the page says it stops at its first
  2 000; when a later page fails, it says that page could not be read instead — an interrupted read
  is not the read budget (audit 03-E1a findings F2, R6C).
