import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runHarness } from "../../storage-api/harness-cli.js";
import { fixtureViewingKeyEncoded } from "./helpers.js";

/**
 * **This phase's exit criterion**, executed: a trusted harness drives register → advance →
 * status → pause → resume → revoke → delete → export/apply revocations end to end, with **no
 * scanner and no HTTP API anywhere in the process** (organizer sub-plan 00009-02, "Exit").
 *
 * The harness is invoked in-process through `runHarness(argv)` rather than as a spawned child.
 * That is deliberate: it lets the test capture stdout and stderr exactly and assert the key
 * never appears in either (organizer spec FR-023, SC-004), which a spawned process's buffered
 * pipes make fiddlier without proving anything more.
 *
 * The assertion that no scanner or API is involved is structural, not a claim: the harness's own
 * imports are checked below, and the repository contains no scanner or server module at this
 * point in the stack.
 */
describe("trusted harness (no scanner, no API)", () => {
  let container: StartedPostgreSqlContainer;
  let workDir: string;
  let keyFile: string;
  let dsn: string;
  const schema = "shielded_monitor_harness";
  const captured: { out: string[]; err: string[] } = { out: [], err: [] };

  /** Runs one harness command with stdout/stderr captured. The command word comes first, then
   *  this suite's connection flags, then the caller's — the same shape a real invocation has. */
  async function harness(command: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await runHarness([command, "--dsn", dsn, "--schema", schema, ...argv]);
      return { code, out: out.join(""), err: err.join("") };
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
      captured.out.push(...out);
      captured.err.push(...err);
    }
  }

  function parse(out: string): Record<string, unknown> {
    return JSON.parse(out) as Record<string, unknown>;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    dsn = container.getConnectionUri();
    workDir = mkdtempSync(path.join(tmpdir(), "umbradb-harness-"));
    keyFile = path.join(workDir, "viewing.key");
    // The key reaches the harness ONLY through a file — never argv, which would land it in shell
    // history and in every `ps` listing on a shared host.
    writeFileSync(keyFile, (await fixtureViewingKeyEncoded(4242)) + "\n", "utf8");
  }, 240_000);

  afterAll(async () => {
    rmSync(workDir, { recursive: true, force: true });
    await container?.stop();
  }, 60_000);

  it("runs the whole lifecycle without a scanner or an API", async () => {
    const encodedKey = readFileSync(keyFile, "utf8").trim();

    const bootstrap = await harness("bootstrap");
    expect(bootstrap.code).toBe(0);
    expect(parse(bootstrap.out).bootstrapped).toBe(schema);

    const registered = await harness("register", "--key-file", keyFile, "--start", "0");
    expect(registered.code).toBe(0);
    const monitor = parse(registered.out) as { id: string; state: string; epoch: string };
    expect(monitor.state).toBe("backfilling");
    expect(monitor.epoch).toBe("0");

    // Idempotent through the harness too.
    const again = await harness("register", "--key-file", keyFile, "--start", "0");
    expect((parse(again.out) as { id: string }).id).toBe(monitor.id);

    const listed = await harness("list");
    expect((parse(listed.out) as unknown as { id: string }[]).map((m) => m.id)).toContain(monitor.id);

    // A block height's associations plus the coverage advance, from a file.
    const associationsFile = path.join(workDir, "associations.json");
    writeFileSync(
      associationsFile,
      JSON.stringify([
        {
          blockHeight: "12",
          blockHashHex: "aa".repeat(32),
          position: 0,
          txHashHex: "bb".repeat(32),
          protocolVersion: "1",
          matchedSegments: [0, 3],
          sourceOutcome: "success",
        },
      ]),
      "utf8",
    );
    const advanced = await harness(
      "advance", "--id", monitor.id, "--epoch", "0", "--through", "12",
      "--associations", associationsFile,
    );
    expect(parse(advanced.out)).toMatchObject({ applied: true, firstSeq: "1", lastSeq: "1" });

    const status = await harness("status", "--id", monitor.id);
    expect(parse(status.out)).toMatchObject({
      state: "backfilling",
      coverage: { requestedStart: "0", scannedFrom: "0", scannedThrough: "12" },
    });

    const associations = await harness("associations", "--id", monitor.id);
    const rows = parse(associations.out) as unknown as {
      seq: string; matchedSegments: number[]; appliedOutcome: string; sourceOutcome: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: "1", appliedOutcome: "unknown", sourceOutcome: "success" });
    expect(rows[0]!.matchedSegments).toStrictEqual([0, 3]);

    const live = await harness("go-live", "--id", monitor.id, "--epoch", "0");
    expect(parse(live.out)).toMatchObject({ state: "live", epoch: "1" });

    const paused = await harness("pause", "--id", monitor.id);
    expect(parse(paused.out)).toMatchObject({ state: "paused", epoch: "2" });

    // A worker holding the pre-pause epoch is fenced, through the harness.
    const fenced = await harness("advance", "--id", monitor.id, "--epoch", "1", "--through", "13")
      .catch((e: unknown) => e);
    expect(String(fenced)).toMatch(/fenced|rejected a fenced write/i);

    const resumed = await harness("resume", "--id", monitor.id);
    expect(parse(resumed.out)).toMatchObject({ state: "backfilling", epoch: "3" });

    const events = await harness("events", "--id", monitor.id);
    expect((parse(events.out) as unknown as { event: string }[]).map((e) => e.event))
      .toStrictEqual(["register", "go_live", "pause", "resume"]);

    // ── revocation list round trip, the operator half of the restore procedure ────────────
    const revoked = await harness("revoke", "--id", monitor.id);
    expect(parse(revoked.out)).toMatchObject({ state: "revoked" });

    const listFile = path.join(workDir, "revocations.json");
    const exported = await harness("export-revocations", "--out", listFile);
    expect(parse(exported.out)).toMatchObject({ exported: 1 });
    expect(JSON.parse(readFileSync(listFile, "utf8")) as { revocations: { monitorId: string }[] })
      .toMatchObject({ revocations: [{ monitorId: monitor.id }] });

    const applied = await harness("apply-revocations", "--in", listFile);
    expect(parse(applied.out)).toMatchObject({ examined: 1, reapplied: [], alreadyRefused: [monitor.id] });

    // A revoked monitor refuses `status`, and `inspect` is the administrative way to see it.
    await expect(harness("status", "--id", monitor.id)).rejects.toThrow(/revoked/i);
    const inspected = await harness("inspect", "--id", monitor.id);
    expect(parse(inspected.out)).toMatchObject({ state: "revoked" });

    const deleted = await harness("delete", "--id", monitor.id);
    expect(parse(deleted.out)).toMatchObject({ state: "deleted" });
    const gone = await harness("inspect", "--id", monitor.id);
    expect(parse(gone.out)).toMatchObject({ state: "deleted" });
    // A deleted monitor is indistinguishable from one that never existed, harness included.
    await expect(harness("associations", "--id", monitor.id)).rejects.toThrow(/no such monitor/);
    await expect(harness("status", "--id", monitor.id)).rejects.toThrow(/no such monitor/);

    // ── the key never appeared in any output ─────────────────────────────────────────────
    const allOutput = captured.out.join("") + captured.err.join("");
    expect(allOutput.length).toBeGreaterThan(0); // the capture is not vacuous
    expect(allOutput).not.toContain(encodedKey);
    expect(allOutput).not.toContain(encodedKey.slice(-24));
    expect(allOutput).not.toContain("mn_shield-esk");
    expect(allOutput).not.toMatch(/fingerprint/i);
  }, 300_000);

  it("refuses an invalid key with the one generic message and never echoes it", async () => {
    const badKeyFile = path.join(workDir, "bad.key");
    writeFileSync(badKeyFile, "mn_shield-esk_undeployed1thisisnotavalidkeyatall\n", "utf8");
    const failure = await harness("register", "--key-file", badKeyFile).catch((e: unknown) => e);
    expect(String(failure)).toContain("invalid viewing key for this deployment's network");
    expect(String(failure)).not.toContain("thisisnotavalidkey");
  }, 120_000);

  it("prints usage for --help and exits non-zero for an unknown command", async () => {
    const help = await harness("help");
    expect(help.code).toBe(0);
    expect(help.out).toContain("trusted; no scanner, no API");

    const unknown = await harness("frobnicate");
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("unknown command");
  }, 120_000);

  it("rejects a malformed flag rather than guessing what was meant", async () => {
    await expect(harness("status", "--id")).rejects.toThrow(/every flag needs a value/);
    await expect(harness("status")).rejects.toThrow(/missing required flag --id/);
  }, 120_000);

  it("STRUCTURAL: the harness imports no scanner and no server", async () => {
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      fileURLToPath(new URL("../../storage-api/harness-cli.ts", import.meta.url)),
      "utf8",
    );
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier).not.toMatch(/scanner|server|http|express|fastify/i);
    }
    expect(source).not.toMatch(/\blisten\s*\(/);
  });
});
