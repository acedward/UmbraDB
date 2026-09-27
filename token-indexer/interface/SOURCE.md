# `token-indexer/interface/` — provenance

Project 00024-02 (spec `/home/eddie/todo/Umbra/spec/00024-indexer-public-interface-multipart.md`, US1,
FR-010–FR-013b; plan `plans/00024-02-public-interface.md`, phase 02-C). The public-interface standard is
[B] — the Public Interfaces for Compact Contracts draft, `acedward/public-interfaces-for-compact-contracts`
PR #6 @ `1cf947786d55739ec4e89aef9258ebef0d8687fa` (normative: `MIP-SPEC-DRAFT.md`; operator guide:
`README.md`). Its MIP names the reference module as the definition of the `ecmh-jubjub-grouphash` profile
("The pinned reference module defines the profile and contains its implementation details").

## Ported from

| Upstream file (PR #6 `1cf9477`) | SHA-256 | Ported into |
|---|---|---|
| `src/hash.mjs` | `8f004e54385b11a534edbdccdd77165f70f7d9d6e8625fd6d74c1454832d48d2` | `commitment.ts` (commitment, index rules, `compilerOf`/`sameCompiler`, the index writer); `event.ts` (the payload layout) |
| `src/fetch.mjs` | `c03dc809c1460b4fc5d1b3909a4d13753d7c4083be94af2e779a12a5cb83446a` | `level1.ts` (`fileUrl`, caps, listed-files-only); `fetch-guard.ts` (task C4) |
| `src/verify.mjs` | `acfb75b04faa424948ffa7c18ef1e2f9c5fecc7e72df03a6e74532cf1a9c9fe9` | `level1.ts` (`levelOne`, `compilerProblem`); `level2.ts`, `level3.ts` (tasks C5, C6) |
| `test/hash.test.mjs` | `e6c77b74d85b367292cdcbf03a978ccc4553b6f7cf29df8518349fa2ad49120d` | its vectors and table: `test/interface-commitment.test.ts` (`[[interface-commitment-vectors]]`, `[[interface-index-rules]]`) |

The multi-part publication format (UC-2) and witness circuits (UC-3) follow the project's PATCHED copy of
the tools, `acedward/mip-public-interfaces` `feat/00024-02-public-interface` @ `c47e64e` —
`tools/public-interface/src/hash.mjs` `fe30c75d…9a8d` (`256·k` payloads), `src/indexer.mjs` `a72b36f9…c62`
(publications as packages, newest by P2), `src/verify.mjs` `04ce1642…5b60` (witnesses recorded, never
executed); `src/fetch.mjs` is unchanged there. The bundle fixture the tests use was built by those tools
(`test/fixtures/interfaces/SOURCE.md`).

## What differs from the reference, and why

- **One implementation, TypeScript**: same functions, same order, same messages where a message is a
  result; typed.
- **`show()` survives hostile nesting** (`commitment.ts`): the reference formats offending values with a
  bare `JSON.stringify`, which overflows the stack on a deeply nested value that `JSON.parse` accepts; here
  that value is named by its type, so the index is refused with an `IndexError` instead of crashing the
  verification job (the 01-D audit's F2 class).
- **The file-versus-directory rule is checked in linear time** (`commitment.ts`, audit 02 E2-F3): the
  reference (`src/hash.mjs:176`) joins every prefix of every path, quadratic in the depth — one entry
  `"a/".repeat(120000) + "a"` fits a 256 KiB index and takes minutes, before the hash is compared.
  Here each path is walked once in a tree of segments; the rule and the first conflict reported are
  the reference's.
- **Level 3 has a read boundary before the compile** (`level3.ts` `outsideDirectiveProblem`, audit 02
  E2-F6): the reference relies on `--trace-search` alone, i.e. it finds out AFTER the compiler read a
  file outside the bundle; here a listed source whose quoted `import` / `include` can only name a file
  outside the bundle (absolute, `..` leaving it, a backslash) is refused before the compiler starts.
  The trace check is kept. `compact.interface` is resolved as the reference resolves it (E2-F5).
- **Level 1 takes an injected transport** (`BundleTransport`) instead of `fetch` or a directory: the
  indexer's transport is the guarded one of `fetch-guard.ts` (http(s) only, private destinations refused
  after DNS, redirects capped, a deadline), which the reference does not have.
- **Four outcomes instead of one failure**: the reference reports every problem as a Level 1 failure.
  Here only evidence that the bytes do not match is `failed`; a local limit is `unchecked`, a refused
  source (scheme, private destination) is `unfetchable` ([B] `src/fetch.mjs` SIZING_GUIDANCE: "report it
  as unchecked, never as invalid"; spec US1 scenarios 5–6), and a host that did not deliver (DNS, refused
  or reset connection, non-2xx — a listed file missing included —, too many redirects, an unexpected
  `Content-Encoding`) is `unreachable`: delivery is handled before the [B] levels, no level is claimed,
  and it is retried with exponential backoff (owner decision Q25, 00024 upstream log UC-13). Audit F4:
  these policies are asserted against the spec, not compared with the reference.
- **Caps are this indexer's** (`DEFAULT_LEVEL1_LIMITS`: index 256 KiB, 1 000 files, 8 MiB per file,
  16 MiB in all — [B]'s SIZING_GUIDANCE estimates; the reference only caps the whole bundle at 64 MiB).
  They are checked after the hash comparison and the commitment recomputation, so a bundle the reference
  fails without downloading is failed here too; nothing past `index.json` is requested before them.
- **The bundle stays in memory** (path → bytes) through Levels 1–2; only Level 3 writes it to a private
  directory, to compile it.
