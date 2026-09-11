# Design — 00009-06: dashboard, list endpoint, key derivation

> Cites `design/design.md` §0 (scope and module boundaries) and §7 (dependency minimalism);
> `design/design-interfaces.md` §1.1 (the single-error idiom), §1.4 (boundary validation) and §2
> (storage interfaces); `Formal/STORAGE_ALGEBRA.md` §1 (the store's read laws) and §3 (ordering);
> and the sibling changes `openspec/changes/00009-02-monitor-store/design.md` §§1–2 and §6 (the
> monitor record and the fenced advance) and `openspec/changes/00009-04-private-api-cli/design.md`
> §1 (why `node:http`), §2 (the client's import audit) and §4 (the redaction rules).
>
> Nothing here contradicts those sections; where this change adds to one, the section is named.

## 1. Why the dashboard is served by the API process, and why it is one file

`design/design.md` §7 makes dependency minimalism a rule of this repository, and
`00009-04/design.md` §1 already applied it to the HTTP surface: eight routes over four path
shapes did not earn a framework. The same reasoning decides this change's shape, and it decides
it harder, because a front end is where dependency creep is *expected* and therefore unremarked.

The page is **one HTML string in one TypeScript module** (`shielded-monitor/api/ui/page.ts`),
served by the existing server. That choice is not aesthetic minimalism; it buys four properties
that matter to this specific project:

1. **`npm run build` stays one `tsc` invocation.** A bundler would add a second build graph, a
   lockfile's worth of transitive dependencies to `SECURITY.md`'s supply-chain section, and a new
   way for `npm pack` to ship something the tests never saw. `scripts/copy-cli-assets.mjs` exists
   because `tsc` emits only TypeScript; a `.html` file read at startup would have to be added to
   it, and would then be a runtime file that can go missing in a packed artifact. A string
   constant cannot go missing.
2. **Same origin, no network.** The page fetches only this API's own JSON from its own origin, so
   there is no CORS surface, no third-party origin in the threat model, and nothing to pin.
3. **The CSP is honest.** `default-src 'self'` is only meaningful if it is true; a page pulling a
   CDN would need `script-src` widened, and the header would then document the opposite of what it
   is for. See §3.
4. **It is reviewable.** A reviewer can read the whole front end in one file, in the same PR, in
   the same language they review the server in.

The cost is real and is accepted: no component model, no hot reload, hand-written DOM updates,
and a hard size discipline (the page is kept under ~600 lines). If the dashboard ever grows past
what one file can carry, that is the moment to propose a build step — as a change, with its
supply-chain section, not as a quiet import.

**Route shape.** `GET /ui` and `GET /ui/` both serve the page; `GET /` answers `302` to `/ui`.
The redirect exists because an operator types the bare host and port, and answering `404` there —
while a page exists one path segment away — is a papercut with no upside. It is a redirect rather
than serving the page at `/` so there is exactly one URL for the page, which keeps the CSP,
caching and the "did the dashboard load?" question single-valued.

## 2. `GET /v1/monitors`: what the list shows, and the one asymmetry it creates

The item shape is **exactly** `MonitorView` — the same builder `GET /v1/monitors/:id` uses
(`shielded-monitor/api/views.ts`). Not a summary, not a new shape. A dashboard that rendered a
different set of fields from the detail route would drift from it, and the drift would show up as
a UI bug rather than as a contract change. `views.ts` builds by naming fields explicitly, so the
FR-003 guarantee (no fingerprint, no key material on the wire) is inherited rather than restated.

Ordering is `createdAt, id` — `createdAt` because that is the order an operator registered them
in and the only order that is stable as states change, and `id` as the tiebreak so a page boundary
cannot repeat or drop a row when two monitors share a timestamp (`Formal/STORAGE_ALGEBRA.md` §3's
total-order requirement for paged reads). The store method is `listAll(limit)`, placed beside
`listActive(limit)` and sharing its bound (`z.number().int().positive().max(10_000)`); the API's
page cap is the existing `API_MAX_PAGE`, so this route introduces no new limit and no new
configuration.

**Deleted monitors are excluded. Revoked monitors are included, with `state: "revoked"`.** That
is an asymmetry with `GET /v1/monitors/:id`, which answers `410` for a revoked monitor, and the
sub-plan requires it to be picked deliberately and recorded. It is picked this way because the two
routes answer different questions:

- `GET /v1/monitors/:id` is **a consumer reading a monitor's data**. US3 scenario 3 says a revoked
  monitor's status and matches are refused, and the `410` is that refusal.
- `GET /v1/monitors` is **an operator asking what exists**. Hiding revoked monitors from it would
  mean the operator revokes a monitor and it vanishes from the only view they have — with no way
  to then delete it, because `DELETE /v1/monitors/:id` needs the id the list just stopped showing.
  The dashboard would have a button that makes its own follow-up action unreachable.

The list item for a revoked monitor carries nothing a revoked monitor's `410` protects: no
matches, no coverage the operator can act on, no key, no fingerprint — only the id, the state and
the timestamps. Deleted monitors are a different case and stay excluded: US3 scenario 4 requires a
deleted monitor to be indistinguishable from one that never existed, and listing a tombstone would
break that literally. This asymmetry is documented in `docs/shielded-monitor-api.md` and asserted
by a test, so it is a contract rather than an accident.

## 3. The viewing key on the dashboard's path

FR-023/SC-004 say no viewing key appears in a log line or an error body, and the required id
`shielded-monitor.api.key-never-logged` enforces it. The dashboard adds one new way for a key to
reach the server, so it adds the corresponding rules:

- The key is typed into **one** `<input type="password" autocomplete="off" spellcheck="false">`
  and is sent **only** as the `viewingKey` field of a `POST /v1/monitors` body — the same route,
  the same schema, the same scrubbing. It never becomes a query parameter, never a path segment,
  never a header.
- The field is **cleared on success and on failure**, and its value is never written back into the
  DOM, never stored in `localStorage`/`sessionStorage`, and never included in the page's own error
  rendering (a failed registration renders the server's `error.code`, which FR-001 already makes
  one generic value).
- The page sets `autocomplete="off"` on the form and the field so a browser does not persist the
  key in its own form store.
- The server's logging is untouched: the create route already logs the route pattern, the status
  and the byte count, and no message. Registering through the page produces the **same** log record
  as registering through `curl`, which is why the existing required test still covers it — and the
  test is extended to register through the page's exact request shape so that stays true by
  assertion rather than by argument.

`Content-Security-Policy: default-src 'self'; base-uri 'none'; form-action 'none'` is served with
the page. `form-action 'none'` is the one that matters for the key: it makes a browser refuse to
submit a form anywhere, so even an injected `<form action="https://…">` cannot exfiltrate the
field.

The page's script and style are inline, and `'self'` does **not** admit inline code — that needs
`'unsafe-inline'` or a hash. `'unsafe-inline'` would make the policy a decoration, so the module
instead computes the **SHA-256 hash** of the one script text and the one style text at load time
(they are separate string constants, concatenated into the page), and emits
`script-src 'sha256-…'` / `style-src 'sha256-…'`. The policy then admits exactly this page's own
code, byte for byte, and nothing an injection could add. The hashes cannot drift from the served
bytes because they are computed from the same constants the page is built from.

## 4. `derive-viewing-key`: what it computes, and what proves it

The command is a separate bin, `umbradb-shielded-monitor-derive-key`, because
`shielded-monitor/client/cli.ts` is governed by the import audit in `00009-04/design.md` §2 and
this command must import the ledger (organizer question Q20, default applied).

**Raw mode** (`--seed-file <path>`): read a 64-hex-character (32-byte) seed from a file, hand it to
the vendored ledger v8 `ZswapSecretKeys.fromSeed`, take
`encryptionSecretKey.yesIKnowTheSecurityImplicationsOfThis_serialize()`, and encode it with the
repository's own `encodeViewingKey` — the same function every test vector goes through, so the CLI
cannot diverge from the service's HRP rule. Then `clear()` the key handles.

**HD mode** (`--hd`): apply BIP32 `m/44'/2400'/<account>'/3/<index>` to the seed first, then the
same steps. Implemented in `shielded-monitor/hd.ts` with **Node built-ins only** —
`createHmac("sha512")` for `CKDpriv`, `createECDH("secp256k1")` for the parent public key the
non-hardened steps need, and `BigInt` for `(IL + kpar) mod n`.

Two independent things make that implementation checkable rather than plausible, and both are
tests:

1. **It is BIP32.** `test/shielded-monitor/hd.test.ts` walks all six nodes of **BIP-0032 official
   test vector 1** and compares serialized `xprv` strings. An implementation that is subtly wrong
   at the hardened/non-hardened boundary, or in the mod-n addition, fails there.
2. **It is *Midnight's* BIP32.** Three vectors captured from
   `@midnightntwrk/wallet-sdk-hd@3.0.3` (which is `@scure/bip32@2.4.0`,
   `m/44'/2400'/<account>'/<role>/<index>`, `Roles.Zswap = 3`) are committed as a fixture, and
   `test/shielded-monitor/derive-key.test.ts` asserts this repository reproduces the SDK's **coin
   public key and encryption public key** for each. The SDK was read and run **out of tree**, in a
   one-off container, exactly as `00009-05` did for the live transfer; `package.json` gains
   nothing.

   **The fixture records only public keys, and that is a deliberate constraint, not an omission.**
   The seeds are named by a recipe and constructed in
   `test/shielded-monitor/fixtures/wallet-sdk-hd-vectors.ts` (the shape `helpers.ts`'s
   `fixtureSeed(n)` already uses); the derived Zswap role seed and the serialized encryption secret
   key are committed in no form. This repository's own gitleaks rule `umbradb-wallet-seed-hex`
   catches a 64-hex value in a seed- or secret-named field, and `.gitleaks.toml` records as a fixed
   audit finding that a path allowlist is a permanent global exemption and must not exist — so
   committing synthetic secret material and then suppressing the scanner would disarm that rule for
   every future secret on that path. The vectors lose no strength: a wrong role seed cannot produce
   a right public key, and the public keys are also the thing an operator actually uses. The
   consequence for the test split is that the end-to-end "it derives what a wallet derives" claim
   lives in `derive-key.test.ts` (which already loads the ledger), while `hd.test.ts` stays
   ledger-free and covers BIP-0032 conformance plus the path and hardening structure.

**Why print the two public keys.** The operator has to send funds to the wallet whose key they
just registered, and `coinPublicKey` + `encryptionPublicKey` are the two halves of a Midnight
shielded address. Both are public by construction. The command prints them, and prints the viewing
key, and prints **nothing derived from the seed beyond that** — no seed echo, no role seed, no
coin secret key.

**Why the seed comes from a file and never from `argv`.** Same rule the client and the harness
already follow: an argument lands in shell history and in every `ps` listing on a shared host, and
neither can be un-written. Passing `--seed` is a usage error with an explicit message, not a
silently accepted convenience.

## 5. Auto-refresh, and why the page must never present a gap as emptiness

The page polls `GET /v1/monitors` every 3 s (pausable). Two rendering rules come straight from
FR-011/FR-020 and are the reason the page is worth building at all:

- `scannedFrom`/`scannedThrough` render as **"not scanned"** when `null`, never as `0`, and
  `sourceTip` renders as **"unknown"** when `null`, never as `0`. The coverage bar is drawn only
  when both `scannedThrough` and `sourceTip` are known; otherwise the page says which one it is
  missing.
- The matches panel never shows "no matches" on its own. It shows the coverage line beside it, so
  an empty page reads as "scanned 0…122 of 158, nothing matched" or "not scanned yet" — never as
  a bare emptiness the operator could take for "you received nothing".

A monitor in `failed` or `stale_source` renders its `lastError.code` beside the badge, which is
the only error information the wire carries (`views.ts`, deliberately).

## 6. What this change does not touch

The scanner, the store's write path, the fenced advance, the cursor encoding, the match shape, the
crash guarantees and every existing route's behaviour are unchanged. The store gains one read
method; the server gains three routes, two of which return HTML and a redirect. No migration, no
new table, no new column, no new environment variable with a behavioural default.
