import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { extractStringLiterals } from "./no-chain-sync-import-guard.test.js";

/**
 * The mirror of `no-chain-sync-import-guard.test.ts` for project B: nothing under `src/` may
 * import `shielded-monitor/`.
 *
 * Why this matters here specifically. `src/` is the published storage surface; `shielded-monitor/`
 * is a consumer of it, exactly as `chain-archive-sync/` is. If a module under `src/` reached into
 * project B, three things would break at once: the published package would start pulling in the
 * ledger WASM and key-handling code it has no business shipping; project A would acquire a
 * build-time dependency on project B, which organizer spec FR-025 forbids in as many words ("A
 * MUST NOT depend on B at build, boot or run time"); and the later TEE split — B running in a
 * separate process with no schema access to A — would stop being possible without an unwind.
 *
 * The scanner is reused verbatim from the existing guard (its `extractStringLiterals`, which
 * skips comments so a doc comment naming the directory does not false-positive) rather than
 * re-implemented, so the two guards cannot drift apart in what they consider a string literal.
 *
 * **Scope note, mirroring the existing guard's own documented gaps.** The rules below key on the
 * literal text `shielded-monitor`. A tsconfig path alias, a specifier assembled from split
 * literals, or an import routed through an external barrel would evade the path rules; the
 * symbol rule is the backstop, and it fires only when a guarded name appears verbatim. This
 * repository defines no path aliases today, so the gap is latent. The migration directory
 * `src/postgres/migrations/shielded_monitor/` legitimately lives under `src/` and does NOT trip
 * these rules, because the schema name is underscored where the module name is hyphenated —
 * the same split `chain_archive` and `chain-archive-sync` already use.
 */

interface GuardViolation {
  rule: "import-specifier" | "string-literal" | "symbol-name";
  detail: string;
}

/** The three rules, mirroring the chain-sync guard's (a)/(b)/(c). */
export function findShieldedMonitorViolations(source: string): GuardViolation[] {
  const violations: GuardViolation[] = [];
  const importSpecifier = source.match(
    /\b(?:from|import)\s*\(?\s*["'`][^"'`\n]*shielded-monitor[^"'`\n]*["'`]/,
  );
  if (importSpecifier !== null) violations.push({ rule: "import-specifier", detail: importSpecifier[0] });

  for (const literal of extractStringLiterals(source)) {
    if (literal.includes("shielded-monitor")) violations.push({ rule: "string-literal", detail: literal });
  }

  const symbol = source.match(
    /\b(?:PgShieldedMonitorStore|ShieldedViewingKey|parseViewingKey|bootstrapShieldedMonitorSchema|monitorFingerprint)\b/,
  );
  if (symbol !== null) violations.push({ rule: "symbol-name", detail: symbol[0] });

  return violations;
}

function walkTsFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((p) => p.endsWith(".ts"))
    .map((rel) => path.join(dir, rel));
}

function scanDirectory(dir: string): Map<string, GuardViolation[]> {
  const result = new Map<string, GuardViolation[]>();
  for (const file of walkTsFiles(dir)) {
    const violations = findShieldedMonitorViolations(readFileSync(file, "utf8"));
    if (violations.length > 0) result.set(file, violations);
  }
  return result;
}

describe("no module under src/ imports project B (organizer spec FR-025)", () => {
  const srcDir = fileURLToPath(new URL("../../src", import.meta.url));

  it("the src/ walk finds source files and every one is violation-free", () => {
    const files = walkTsFiles(srcDir);
    expect(files.length).toBeGreaterThan(0); // sanity: the walk actually found source files
    const violations = scanDirectory(srcDir);
    expect(
      [...violations.entries()].map(([f, v]) => `${f}: ${v.map((x) => `${x.rule}(${x.detail})`).join(", ")}`),
    ).toStrictEqual([]);
  });

  it("the migration lineage under src/ is scanned and is clean (the underscore/hyphen split works)", () => {
    const migrationDir = fileURLToPath(new URL("../../src/postgres/migrations/shielded_monitor", import.meta.url));
    const files = walkTsFiles(migrationDir);
    // The file list is PINNED, not globbed, so a migration added to this lineage cannot slip past
    // the scan below by being written after this test was: adding one is a deliberate edit here.
    // `002_association_details.ts` (00009-07) joined `001_core.ts` and `index.ts`;
    // `003_monitor_leases.ts` (00009-08) joined them.
    expect(files.map((f) => path.basename(f)).sort()).toStrictEqual([
      "001_core.ts", "002_association_details.ts", "003_monitor_leases.ts", "index.ts",
    ]);
    for (const file of files) {
      expect(findShieldedMonitorViolations(readFileSync(file, "utf8"))).toStrictEqual([]);
    }
  });

  describe("fixture: the scanner catches each violation shape against real files", () => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "umbradb-b-guard-fixture-"));
    afterAll(() => {
      rmSync(fixtureDir, { recursive: true, force: true });
    });

    const FIXTURES: { name: string; source: string; expectedRules: GuardViolation["rule"][] }[] = [
      {
        name: "static-import.ts",
        source: 'import { PgShieldedMonitorStore } from "../../shielded-monitor/store.js";\nexport const x = 1;\n',
        expectedRules: ["import-specifier", "string-literal", "symbol-name"],
      },
      {
        name: "re-export.ts",
        source: 'export { parseViewingKey } from "../../shielded-monitor/viewing-key.js";\n',
        expectedRules: ["import-specifier", "string-literal", "symbol-name"],
      },
      {
        name: "computed-dynamic-import.ts",
        source: "const dir = `../../shielded-monitor`;\nexport const mod = await import(`${dir}/store.js`);\n",
        expectedRules: ["string-literal"],
      },
      {
        name: "require-call.ts",
        source: 'const s = require("../../shielded-monitor/store.js");\nexport default s;\n',
        expectedRules: ["string-literal"],
      },
      {
        name: "symbol-only.ts",
        source: "// routed through an external barrel, but the class is named\ndeclare const s: PgShieldedMonitorStore;\nexport const store = s;\n",
        expectedRules: ["symbol-name"],
      },
    ];

    for (const fixture of FIXTURES) {
      it(`flags ${fixture.name} via ${fixture.expectedRules.join("+")}`, () => {
        writeFileSync(path.join(fixtureDir, fixture.name), fixture.source);
        const violations = scanDirectory(fixtureDir).get(path.join(fixtureDir, fixture.name));
        expect(violations, `${fixture.name} was not flagged at all`).toBeDefined();
        for (const rule of fixture.expectedRules) {
          expect(violations!.map((v) => v.rule), `${fixture.name} missing rule ${rule}`).toContain(rule);
        }
      });
    }

    it("does NOT flag a clean file, including one whose COMMENTS name the module", () => {
      writeFileSync(
        path.join(fixtureDir, "clean.ts"),
        "// project B lives in shielded-monitor/ and is not imported from here\n" +
          "/* the migration lineage under src/postgres/migrations/shielded_monitor/ is fine */\n" +
          'export const fine = "no violations here";\n',
      );
      expect(scanDirectory(fixtureDir).has(path.join(fixtureDir, "clean.ts"))).toBe(false);
    });

    /**
     * The same known gap the chain-sync guard documents, asserted so it cannot rot: an aliased
     * import of a symbol that is not one of the guarded names evades all three rules.
     */
    it("KNOWN GAP: an aliased import of a non-guarded symbol evades all three rules", () => {
      writeFileSync(
        path.join(fixtureDir, "alias-factory.ts"),
        'import { createStore } from "@monitor/store.js";\nexport const s = createStore();\n',
      );
      expect(
        scanDirectory(fixtureDir).has(path.join(fixtureDir, "alias-factory.ts")),
        "if this now FAILS the alias gap has been closed — update the doc block above and this test",
      ).toBe(false);
    });
  });
});
