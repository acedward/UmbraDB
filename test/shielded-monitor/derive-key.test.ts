import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveViewingKey, runDeriveKey } from "../../shielded-monitor/derive-key-cli.js";
import { deriveMidnightRoleSeed } from "../../shielded-monitor/hd.js";
import { parseViewingKey } from "../../shielded-monitor/viewing-key.js";
import { seedFor, walletHdVectors } from "./fixtures/wallet-sdk-hd-vectors.js";
import { fixtureSeed, fixtureViewingKeyEncoded } from "./helpers.js";

/**
 * `umbradb-shielded-monitor-derive-key` (organizer sub-plan 00009-06; FR-001's key shape, FR-023's
 * hygiene rule applied to a command line).
 *
 * The load-bearing case is the first one: the key this command prints must be **the same string**
 * the repository's own test fixtures produce for the same seed. A derivation that is
 * self-consistent but different from what the service accepts would be discovered by an operator,
 * at the register form, with no way to tell which side was wrong.
 *
 * No Docker and no database: this command talks to the ledger WASM and to nothing else.
 */
describe("derive-viewing-key CLI", () => {
  let dir: string;
  const lines: string[] = [];
  const collect = (line: string): void => {
    lines.push(line);
  };

  function seedFile(name: string, contents: string): string {
    const file = path.join(dir, name);
    writeFileSync(file, contents, { encoding: "utf8", mode: 0o600 });
    return file;
  }

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "umbradb-derive-key-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ── The key is the one the service accepts ──────────────────────────────────────────────────

  it("[[shielded-monitor.derive-key.matches-the-service-encoding]] derives exactly the key the repository's own fixture path produces for the same seed", async () => {
    // `fixtureViewingKeyEncoded(n)` is `ZswapSecretKeys.fromSeed(fixtureSeed(n))` -> serialize ->
    // `encodeViewingKey`, i.e. the path every other suite's key vectors travel. If this command
    // ever diverges from it, the two strings stop matching here rather than in production.
    for (const n of [1, 4242, 65_535]) {
      const derived = await deriveViewingKey(fixtureSeed(n), { net: "undeployed", hd: false });
      expect(derived.viewingKey).toBe(await fixtureViewingKeyEncoded(n));
    }
  }, 60_000);

  it("produces a key the service's own intake accepts, for a non-default network too", async () => {
    const derived = await deriveViewingKey(fixtureSeed(7), { net: "preview", hd: false });
    expect(derived.viewingKey.startsWith("mn_shield-esk_preview1")).toBe(true);
    await expect(parseViewingKey(derived.viewingKey, "preview")).resolves.toBeDefined();
    // ...and only for that network: the HRP binds the key to the deployment (FR-001).
    await expect(parseViewingKey(derived.viewingKey, "undeployed")).rejects.toThrow();
  }, 60_000);

  it("prints the two public halves of the shielded address, and they are not the viewing key", async () => {
    const derived = await deriveViewingKey(fixtureSeed(11), { net: "undeployed", hd: false });
    expect(derived.coinPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(derived.encryptionPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(derived.coinPublicKey).not.toBe(derived.encryptionPublicKey);
    expect(derived.viewingKey).not.toContain(derived.coinPublicKey);
  }, 60_000);

  // ── HD mode ─────────────────────────────────────────────────────────────────────────────────

  /**
   * `--hd`, and the end-to-end claim that it derives what a REAL wallet derives.
   *
   * This is where that claim lives (rather than in `hd.test.ts`) for two reasons: turning a role
   * seed into an address needs the ledger, which this suite already loads; and the intermediate
   * role seed is secret-shaped material this repository deliberately commits in no form, so the
   * only committed expectation is the pair of PUBLIC keys — which is also the thing an operator
   * actually uses. A wrong role seed cannot produce a right public key.
   */
  describe("--hd", () => {
    const fixture = walletHdVectors;

    it("has vectors to check (a fixture that emptied itself must not pass silently)", () => {
      expect(fixture.vectors.length).toBeGreaterThanOrEqual(3);
    });

    it.each(fixture.vectors.map((v) => [v.seedRecipe, v] as const))(
      "reproduces the wallet's own Zswap address for the %s seed",
      async (_recipe, vector) => {
        const derived = await deriveViewingKey(seedFor(vector.seedRecipe), {
          net: "undeployed",
          hd: true,
        });
        // These two strings came out of `@midnightntwrk/wallet-sdk-hd` + the Midnight ledger, in a
        // container, not out of this repository. Matching them is the evidence that `--hd` derives
        // the key a real wallet would.
        expect(derived.coinPublicKey).toBe(vector.coinPublicKey);
        expect(derived.encryptionPublicKey).toBe(vector.encryptionPublicKey);
        expect(derived.path).toBe(fixture.path);
      },
      60_000,
    );

    it("raw mode on the derived role seed equals HD mode on the wallet seed", async () => {
      const seed = seedFor(fixture.vectors[0]!.seedRecipe);
      const viaHd = await deriveViewingKey(seed, { net: "undeployed", hd: true });
      const viaRaw = await deriveViewingKey(deriveMidnightRoleSeed(seed), { net: "undeployed", hd: false });
      expect(viaRaw.viewingKey).toBe(viaHd.viewingKey);
      // ...and the two modes are genuinely different operations on the SAME input.
      const rawOnWalletSeed = await deriveViewingKey(seed, { net: "undeployed", hd: false });
      expect(rawOnWalletSeed.viewingKey).not.toBe(viaHd.viewingKey);
    }, 60_000);

    it("--account and --index imply --hd and change the key", async () => {
      lines.length = 0;
      const file = seedFile("hd-account.hex", `${"11".repeat(32)}\n`);
      expect(await runDeriveKey(["--seed-file", file, "--account", "3", "--quiet"], collect)).toBe(0);
      const withAccount = lines[0]!;
      lines.length = 0;
      expect(await runDeriveKey(["--seed-file", file, "--hd", "--quiet"], collect)).toBe(0);
      expect(lines[0]).not.toBe(withAccount);
    }, 60_000);
  });

  // ── The seed never reaches a command line or an output stream ────────────────────────────────

  it.each([
    ["with a value", ["--seed", "00".repeat(32)]],
    ["with no value", ["--seed"]],
    ["after other flags", ["--hd", "--seed", "00".repeat(32)]],
  ])("refuses a seed passed on the command line %s, naming the file flag", async (_name, argv) => {
    await expect(runDeriveKey(argv, collect)).rejects.toThrow(/--seed-file/);
    // And the refusal does not echo the thing it refused.
    await expect(runDeriveKey(argv, collect)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("00".repeat(32)) as unknown as string }),
    );
  });

  it("prints neither the seed nor the derived role seed, in any mode", async () => {
    const seedHex = "5a".repeat(32);
    const file = seedFile("quiet.hex", `${seedHex}\n`);
    const roleSeed = deriveMidnightRoleSeed(Buffer.from(seedHex, "hex")).toString("hex");

    for (const argv of [
      ["--seed-file", file],
      ["--seed-file", file, "--hd"],
      ["--seed-file", file, "--quiet"],
    ]) {
      lines.length = 0;
      expect(await runDeriveKey(argv, collect)).toBe(0);
      const output = lines.join("\n");
      expect(output, `${argv.join(" ")} leaked the seed`).not.toContain(seedHex);
      expect(output, `${argv.join(" ")} leaked the role seed`).not.toContain(roleSeed);
      // Positive control: the scan above is capable of finding those strings when they are there.
      expect(`${output}\n${seedHex}`).toContain(seedHex);
    }
  }, 60_000);

  it("--quiet prints the key and nothing else, so it can be redirected into a key file", async () => {
    lines.length = 0;
    const file = seedFile("redirect.hex", `${"07".repeat(32)}\n`);
    expect(await runDeriveKey(["--seed-file", file, "--quiet"], collect)).toBe(0);
    expect(lines).toHaveLength(1);
    await expect(parseViewingKey(lines[0]!, "undeployed")).resolves.toBeDefined();
  }, 60_000);

  // ── Seed-file strictness ────────────────────────────────────────────────────────────────────

  it("accepts whitespace and an 0x prefix, because a seed file is written by a human", async () => {
    const plain = seedFile("plain.hex", "23".repeat(32));
    const decorated = seedFile("decorated.hex", `  0x${"23".repeat(32)}  \n\n`);
    lines.length = 0;
    await runDeriveKey(["--seed-file", plain, "--quiet"], collect);
    const a = lines[0];
    lines.length = 0;
    await runDeriveKey(["--seed-file", decorated, "--quiet"], collect);
    expect(lines[0]).toBe(a);
  }, 60_000);

  it.each([
    ["too short", "ab".repeat(31)],
    ["too long", "ab".repeat(33)],
    ["not hexadecimal", `${"ab".repeat(31)}zz`],
    ["empty", ""],
    ["a Bech32m key by mistake", "mn_shield-esk_undeployed1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"],
  ])("refuses a seed file that is %s", async (name, contents) => {
    const file = seedFile(`bad-${name.replace(/\W+/g, "-")}.hex`, contents);
    // A usage error, never a silently different key: every one of these would derive SOMETHING.
    await expect(runDeriveKey(["--seed-file", file], collect)).rejects.toThrow(/64 hexadecimal characters/);
  });

  it("never quotes the rejected file's contents back at the caller", async () => {
    const secretish = "not-a-seed-but-would-be-embarrassing-in-scrollback";
    const file = seedFile("secretish.hex", secretish);
    await expect(runDeriveKey(["--seed-file", file], collect)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secretish) as unknown as string }),
    );
  });

  // ── Argument handling ───────────────────────────────────────────────────────────────────────

  it("requires --seed-file", async () => {
    await expect(runDeriveKey(["--hd"], collect)).rejects.toThrow(/missing required flag --seed-file/);
  });

  it("rejects a value flag with no value, rather than swallowing the next flag", async () => {
    await expect(runDeriveKey(["--seed-file", "--hd"], collect)).rejects.toThrow(/--seed-file needs a value/);
  });

  it("rejects a bare positional argument", async () => {
    await expect(runDeriveKey(["seed.hex"], collect)).rejects.toThrow(/unexpected argument/);
  });

  it("rejects an unusable network before it touches the ledger", async () => {
    await expect(runDeriveKey(["--seed-file", "/nonexistent", "--net", "not a net"], collect)).rejects.toThrow();
  });

  it("reports an unreadable seed file by path, without a stack trace", async () => {
    await expect(runDeriveKey(["--seed-file", path.join(dir, "absent.hex")], collect)).rejects.toThrow(
      /cannot read the seed file/,
    );
  });

  it("prints usage for --help and exits 0", async () => {
    lines.length = 0;
    expect(await runDeriveKey(["--help"], collect)).toBe(0);
    expect(lines.join("\n")).toContain("--seed-file");
    expect(lines.join("\n")).toContain("NEVER accepted on the command line");
  });
});
