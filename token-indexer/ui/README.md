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
| **Public interface** (", L1/L2/L3" / ", failed at L1" / ", unchecked" …) | the token's interface summary and every value of the contract's interface section (status, levels, commitment, URL, files, keys, circuits, witnesses, checks, older publications) | the publication — transaction, block, segment, parts, commitment, levels, checked at — linked to the contract's interface section (`#/contract/<address>/interface`) and to the publication transaction |
| **Chain observation** | mints, activity rows, contract calls, the deploy facts | the transaction (or the section that lists the rows) |
| **Derived by this indexer** | colour, status, the kind byte's two bits, heights computed from other rows | the rule applied; a MIP-0018 key declared more than once also names **P1** — "last write, positioned by the first part" — as the rule that picked the current value |
| **Not available** (reason) | a value no source provides | the reason (a Null declaration also links the declaration) |

A few values reach the page with **no** origin in the API (the token's identity, some heights and
counts, a contract's deploy facts and its calls): the page labels them with a fixed rule of its own,
drawn with a dashed edge and saying so in its evidence line (organizer question Q28). The labels come
from one pure view model in the page script (`tokenModel`, `contractModel`, `originView`); the
governed test `[[token-ui-origin]]` evaluates the served script in `node:vm` on recorded payloads
(`../test/fixtures/ui/`) and checks that every value is drawn with its label and that every evidence link
resolves.

What else the page shows:

- **The list** gains an `interface` column: the current publication's status — `pending`, `verified`
  with the levels passed (`L1/L2` or `L1/L2/L3`), `failed at L<n>`, `unchecked`, `unfetchable`,
  `unreachable`, `stale` — and a part badge when the bundle URL was a multi-part package; the
  MIP-0018 column adds a part badge (and the phase, when it is not `guaranteed`) on multi-part values.
- **The contract view** gains a "public interface" section from `GET /v1/contracts/:address/interface`:
  status, role, levels, the failure and its level, the Level 3 reason, commitment, the URL (shortened
  for the eye — head … tail, its length — and copied whole; a URL may be 262 112 bytes), the
  publication, the package payload's length and SHA-256, check times (`checkedAt`, `lastVerifiedAt`,
  `verifiedUntil`, `nextCheckAt`), the contract state used, compiler and build, the files, keys,
  circuits (with argument types) and witnesses, the check history, and every older publication
  (`historical`) with its own result. Diagnostics are shown exactly as served (bounded by the indexer).
- **The token view** gains its contract's interface summary (status and levels; the URL is on the
  contract view), the parts and phase of every trait, and, under a key declared more than once, its
  earlier declarations — a Null included — newest first.
- Routes may end in a section (`#/contract/<address>/interface`, `#/token/…/mints`, …), scrolled to
  once drawn. The raw-events table asks for every event of the contract (`/events?limit=500`): the
  route's `applied=false` means "rejected only", which the page had asked for since 00020.
