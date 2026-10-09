/**
 * The PostgreSQL-only list (`test/helpers/postgresql-only.ts`) against the repository: every entry names a real file
 * and a reason, every listed test and part is marked where it lives, every marker is listed, and every test file that
 * starts PostgreSQL by itself is a listed file (on PGlite such a file would otherwise fail, see
 * `test/helpers/no-postgresql-container.ts`).
 */
import { existsSync, globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { onPostgresql, POSTGRESQL_ONLY, POSTGRESQL_ONLY_FILES, skipOnPglite, testBackendFrom } from "../helpers/postgresql-only.ts";

const ROOT = new URL("../../", import.meta.url);
const read = (file: string): string => readFileSync(new URL(file, ROOT), "utf8");
const SELF = "test/integration/postgresql-only.test.ts";
const testFiles = globSync("**/*.test.ts", { cwd: fileURLToPath(ROOT), exclude: (f) => /(^|\/)(node_modules|dist|coverage)$/.test(f) })
  .map((f) => f.replaceAll("\\", "/"))
  .filter((f) => f !== SELF)
  .sort();

describe("the PostgreSQL-only list", () => {
  it("names existing files, each with a reason; a listed file has no listed test or part (it is not run at all)", () => {
    for (const [file, reason] of Object.entries(POSTGRESQL_ONLY.files)) {
      expect(existsSync(new URL(file, ROOT)), file).toBe(true);
      expect(reason.length, file).toBeGreaterThan(20);
    }
    for (const [id, t] of Object.entries(POSTGRESQL_ONLY.tests)) {
      expect(existsSync(new URL(t.file, ROOT)), id).toBe(true);
      expect(t.reason.length, id).toBeGreaterThan(20);
      expect(POSTGRESQL_ONLY_FILES, id).not.toContain(t.file);
    }
    for (const p of POSTGRESQL_ONLY.parts) {
      expect(p.reason.length, p.part).toBeGreaterThan(20);
      expect(POSTGRESQL_ONLY_FILES, p.part).not.toContain(p.file);
    }
    expect(new Set(POSTGRESQL_ONLY.parts.map((p) => p.part)).size).toBe(POSTGRESQL_ONLY.parts.length);
  });

  it("every listed test carries its [[id]] and is skipped on PGlite through skipOnPglite in its file; every listed part is marked with onPostgresql in the file of its test", () => {
    for (const [id, t] of Object.entries(POSTGRESQL_ONLY.tests)) {
      const src = read(t.file);
      expect(src, id).toContain(`skipOnPglite("${id}"))("[[${id}]]`);
    }
    for (const p of POSTGRESQL_ONLY.parts) {
      const src = read(p.file);
      expect(src, p.part).toContain(p.test);
      expect(src, p.part).toContain(`onPostgresql("${p.part}")`);
    }
  });

  it("every skipOnPglite and onPostgresql marker in a test file is listed", () => {
    const skips: string[] = [];
    const parts: string[] = [];
    for (const file of testFiles) {
      const src = read(file);
      for (const m of src.matchAll(/skipOnPglite\("([^"]+)"\)/g)) skips.push(`${file} ${m[1]}`);
      for (const m of src.matchAll(/onPostgresql\("([^"]+)"\)/g)) parts.push(`${file} ${m[1]}`);
    }
    expect(skips.sort()).toEqual(Object.entries(POSTGRESQL_ONLY.tests).map(([id, t]) => `${t.file} ${id}`).sort());
    expect(parts.sort()).toEqual(POSTGRESQL_ONLY.parts.map((p) => `${p.file} ${p.part}`).sort());
  });

  it("every test file that starts PostgreSQL by itself (its own container, the shared wallet-storage container, or a server by URL) is a listed file", () => {
    const starts = testFiles.filter((f) => /@testcontainers\/postgresql|registerSuiteLifecycle|getTestContainer|startTestDatabase\(|crash-harness/.test(read(f)));
    expect(starts.length).toBeGreaterThan(30);
    expect(starts.filter((f) => !POSTGRESQL_ONLY_FILES.includes(f))).toEqual([]);
  });

  it("UMBRADB_BACKEND is postgres (also when unset) or pglite; anything else is refused; the markers follow the backend and refuse an unlisted name", () => {
    expect([testBackendFrom(undefined), testBackendFrom(""), testBackendFrom("postgres"), testBackendFrom("pglite")]).toEqual(["postgres", "postgres", "postgres", "pglite"]);
    for (const bad of ["PGlite", "postgresql", "pg", " pglite"]) expect(() => testBackendFrom(bad), bad).toThrow(/UMBRADB_BACKEND/);
    const [id] = Object.keys(POSTGRESQL_ONLY.tests);
    expect([skipOnPglite(id!, "postgres"), skipOnPglite(id!, "pglite")]).toEqual([false, true]);
    expect(() => skipOnPglite("no.such.test", "postgres")).toThrow(/not in POSTGRESQL_ONLY.tests/);
    const { part } = POSTGRESQL_ONLY.parts[0]!;
    expect([onPostgresql(part, "postgres"), onPostgresql(part, "pglite")]).toEqual([true, false]);
    expect(() => onPostgresql("no-such-part", "postgres")).toThrow(/not in POSTGRESQL_ONLY.parts/);
  });
});
