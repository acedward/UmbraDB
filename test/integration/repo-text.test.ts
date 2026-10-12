/**
 * Repository text carries no character a reader cannot see. Bidi controls can make source read differently from how it
 * runs ("Trojan Source"), and zero-width characters and raw control bytes hide in plain sight; a test value that needs
 * one writes it as an escape (`\u202e`, `\u0000`), which runs the same.
 *
 * - `[[repo.text.no-invisible-characters]]` — no text file of the repository (sources, tests, docs, data, workflows:
 *   every file whose extension marks it as text; recorded tapes and other binary files are not text) holds a bidi
 *   control (U+202A–U+202E, U+2066–U+2069), a zero-width character (U+200B–U+200F, or U+FEFF anywhere but as a
 *   byte-order mark at the very start) or a control character other than tab, line feed and carriage return
 *   (U+0000–U+001F, U+007F).
 *
 * The files are git's tracked files when the tree is a git checkout; otherwise (a `git archive` copy) every file under
 * the repository root that the `.gitignore` files do not exclude (so build output, `node_modules` and test reports are
 * left out).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Extensions of the repository's text files. */
const TEXT = /\.(?:[cm]?[jt]s|md|json|html|css|ya?ml|sh|py|toml|txt|lean)$/;

/** Characters a reader cannot see (see the module documentation); a BOM at offset 0 is allowed separately. */
const INVISIBLE = /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export interface Finding {
  line: number;
  column: number;
  code: string;
}

/** Every invisible character in `text`, with its line and column (1-based) and code point. */
export function invisibleCharacters(text: string): Finding[] {
  const found: Finding[] = [];
  const lines = text.split("\n");
  for (let l = 0; l < lines.length; l++) {
    for (const m of lines[l]!.matchAll(INVISIBLE)) {
      if (l === 0 && m.index === 0 && m[0] === "\uFEFF") continue;
      found.push({ line: l + 1, column: m.index! + 1, code: `U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}` });
    }
  }
  return found;
}

interface IgnoreRule {
  /** The directory the rule's `.gitignore` is in, relative to the root ("" for the root). */
  base: string;
  regex: RegExp;
  /** Matches the path relative to `base` (the pattern has a slash) or any one name in it. */
  anchored: boolean;
  dirOnly: boolean;
}

const globRegex = (glob: string): RegExp =>
  new RegExp(`^${glob.split("**").map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`);

/** The rules of a `.gitignore` file: comments, blank lines and negations aside; a trailing slash means directories. */
function readIgnore(dir: string, base: string): IgnoreRule[] {
  const file = join(dir, ".gitignore");
  if (!existsSync(file)) return [];
  const rules: IgnoreRule[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    rules.push({ base, regex: globRegex(line), anchored, dirOnly });
  }
  return rules;
}

function ignored(rules: readonly IgnoreRule[], path: string, isDir: boolean): boolean {
  return rules.some((r) => {
    if (r.dirOnly && !isDir) return false;
    if (r.base !== "" && !path.startsWith(`${r.base}/`)) return false;
    const rel = r.base === "" ? path : path.slice(r.base.length + 1);
    return r.anchored ? r.regex.test(rel) : r.regex.test(rel.slice(rel.lastIndexOf("/") + 1));
  });
}

/** Every file under the root that the `.gitignore` files do not exclude (`.git` aside). */
function walk(): string[] {
  const files: string[] = [];
  const visit = (rel: string, rules: readonly IgnoreRule[]): void => {
    const dir = rel === "" ? ROOT : join(ROOT, rel);
    const here = [...rules, ...readIgnore(dir, rel)];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) {
        if (!ignored(here, path, true)) visit(path, here);
      } else if (entry.isFile() && !ignored(here, path, false)) files.push(path);
    }
  };
  visit("", []);
  return files;
}

/** The repository's files: git's tracked files in a checkout, else the walk. */
function repositoryFiles(): { files: string[]; source: "git" | "walk" } {
  if (existsSync(join(ROOT, ".git"))) {
    try {
      const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return { files: out.split("\0").filter((f) => f !== ""), source: "git" };
    } catch {
      // not a usable checkout: walk instead
    }
  }
  return { files: walk(), source: "walk" };
}

describe("repository text", () => {
  it("[[repo.text.no-invisible-characters]] no text file holds a bidi control, a zero-width character or a control character other than tab, line feed and carriage return", () => {
    // The detector itself, on values built from code points (so this file holds none of them).
    const c = (...codes: number[]): string => String.fromCharCode(...codes);
    expect(invisibleCharacters(`plain\ttext\r\nnext line`)).toEqual([]);
    expect(invisibleCharacters(`${c(0xfeff)}starts with a byte-order mark`)).toEqual([]);
    const sample = `a${c(0x202e)}b\nc${c(0x200b)}d${c(0x2066)}\n${c(0x00)}${c(0x1b)}${c(0x7f)}e${c(0xfeff)}`;
    expect(invisibleCharacters(sample).map((f) => `${f.line}:${f.column} ${f.code}`)).toEqual([
      "1:2 U+202E", "2:2 U+200B", "2:4 U+2066", "3:1 U+0000", "3:2 U+001B", "3:3 U+007F", "3:5 U+FEFF",
    ]);

    const { files, source } = repositoryFiles();
    const text = files.filter((f) => TEXT.test(f));
    // The scan sees the repository, not an empty or partial list.
    expect(text.length, `text files found (${source})`).toBeGreaterThan(500);
    for (const known of ["vitest.config.ts", "README.md", "package.json", "token-indexer/browser/engine.html", "token-indexer/test/engine-telemetry.test.ts"])
      expect(text, `${known} is scanned (${source})`).toContain(known);
    expect(text.some((f) => f.startsWith("node_modules/") || f.startsWith("dist/") || f.startsWith("dist-browser/"))).toBe(false);

    const findings: string[] = [];
    for (const f of text) {
      for (const x of invisibleCharacters(readFileSync(join(ROOT, f), "utf8"))) findings.push(`${f}:${x.line}:${x.column} ${x.code}`);
    }
    expect(findings, "write such a character as an escape (\\uXXXX) instead").toEqual([]);
  });
});
