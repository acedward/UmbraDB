import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UmbraDBSql } from "../../src/postgres/client.js";
import { loadApiConfig } from "../../shielded-monitor/api/config.js";
import {
  createShieldedMonitorApi,
  silentLogger,
  type ShieldedMonitorApi,
} from "../../shielded-monitor/api/server.js";
import { staticSourceTip } from "../../shielded-monitor/api/source-tip.js";
import { runClient } from "../../shielded-monitor/client/cli.js";
import type { PgShieldedMonitorStore } from "../../storage-api/monitor-store-pg.js";
import { association, fixtureViewingKeyEncoded, freshStore, uniqueSchema } from "./helpers.js";

/**
 * **This phase's exit criterion, executed** (organizer spec SC-008, US1–US3; owner decision Q4):
 * the reference consumer completes register → status → poll → pause → resume → revoke → delete
 * against a **real HTTP server over a real socket**, backed by a real PostgreSQL 17.
 *
 * ── What stands in for the scanner, and why that is honest ──────────────────────────────────
 * Phase 3's relevance scanner does not exist on this branch (`origin/feat/00009-03-…` is absent
 * at the time of writing), so nothing here computes relevance. Matches are seeded through
 * `PgShieldedMonitorStore.advance` — the same trusted path Phase 2's harness uses — and that is
 * exactly the right stand-in for THIS change: the client's contract is that it can discover,
 * page and act on whatever the service holds, not that the service found it correctly. The
 * Compose run with a real shielded transaction is recorded as deferred to Phase 5 rather than
 * quietly claimed here.
 *
 * ── In-process, but not in-band ─────────────────────────────────────────────────────────────
 * The client is invoked through `runClient(argv)` rather than as a spawned child, so stdout can
 * be captured exactly and asserted against (including "no key ever appears"). That is not a
 * shortcut around the network: `runClient` reaches the service through `fetch` on a loopback
 * socket, so the routing, status codes, content types and JSON encoding are all really
 * exercised. The one thing in-process invocation could hide — a hidden import of the store —
 * is closed by the import audit below, which reads the client's source.
 */
describe("reference consumer CLI end to end", () => {
  let container: StartedPostgreSqlContainer;
  let sql: UmbraDBSql;
  let store: PgShieldedMonitorStore;
  let api: ShieldedMonitorApi;
  let base: string;
  let workDir: string;
  let keyFile: string;
  let cursorFile: string;
  let encodedKey: string;
  const schema = uniqueSchema("sm_client");
  const allOutput: string[] = [];

  /** Runs one client command with stdout captured. */
  async function client(...argv: string[]): Promise<{ code: number; out: string }> {
    const out: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runClient([...argv, "--api", base]);
      return { code, out: out.join("") };
    } finally {
      process.stdout.write = realWrite;
      allOutput.push(...out);
    }
  }

  function parse(out: string): Record<string, unknown> {
    return JSON.parse(out) as Record<string, unknown>;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    ({ sql, store } = await freshStore(container, schema));
    api = createShieldedMonitorApi({
      store,
      config: loadApiConfig({ API_PORT: "0", STORAGE_URL: "http://storage-api:8788" }),
      // A real tip so the client's coverage rendering is exercised in both directions.
      sourceTipProvider: staticSourceTip(500n),
      logger: silentLogger(),
    });
    const address = await api.listen();
    base = `http://127.0.0.1:${address.port}`;

    workDir = mkdtempSync(path.join(tmpdir(), "umbradb-client-"));
    keyFile = path.join(workDir, "viewing.key");
    cursorFile = path.join(workDir, "monitor.cursor");
    encodedKey = await fixtureViewingKeyEncoded(7777);
    // The key reaches the client ONLY through a file — never argv, which would land it in shell
    // history and in every `ps` listing on a shared host.
    writeFileSync(keyFile, `${encodedKey}\n`, "utf8");
  }, 240_000);

  afterAll(async () => {
    rmSync(workDir, { recursive: true, force: true });
    await api?.close();
    await sql?.end({ timeout: 5 });
    await container?.stop();
  }, 60_000);

  it("[[shielded-monitor.client.end-to-end-lifecycle]] completes register → status → poll → pause → resume → revoke → delete", async () => {
    // ── register ────────────────────────────────────────────────────────────────────────────
    const registered = await client("register", "--key-file", keyFile, "--start", "earliest");
    expect(registered.code).toBe(0);
    const monitorId = parse(registered.out).monitorId as string;
    expect(monitorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(parse(registered.out).state).toBe("backfilling");
    // "not scanned" spelled out, never a zero (organizer spec FR-020).
    expect(parse(registered.out).coverage).toEqual({
      requestedStart: "0",
      scannedFrom: "not scanned",
      scannedThrough: "not scanned",
      sourceTip: "500",
    });

    // ── status ──────────────────────────────────────────────────────────────────────────────
    const status = await client("status", "--id", monitorId);
    expect(status.code).toBe(0);
    expect(parse(status.out).state).toBe("backfilling");

    // ── poll, before anything has been scanned ──────────────────────────────────────────────
    const emptyPoll = await client("poll", "--id", monitorId, "--cursor-file", cursorFile);
    expect(emptyPoll.code).toBe(0);
    expect(parse(emptyPoll.out).matches).toEqual([]);
    // The gap is visible as three separate numbers — an unscanned range is NOT "no matches"
    // (organizer spec US2 scenario 3).
    expect(parse(emptyPoll.out).coverage).toMatchObject({
      scannedThrough: "not scanned",
      sourceTip: "500",
    });
    expect(existsSync(cursorFile)).toBe(true);
    const cursorAfterEmpty = readFileSync(cursorFile, "utf8");

    // ── the scanner's job, performed by the store (see the file note) ───────────────────────
    const loaded = await store.getIncludingRevoked(monitorId);
    await store.advance(monitorId, loaded!.epoch, 120n, [
      association(100n, 0),
      association(100n, 4),
      association(118n, 2, { matchedSegments: [0, 2], sourceOutcome: "partial_success" }),
    ]);

    // ── poll, with matches ──────────────────────────────────────────────────────────────────
    const poll = await client("poll", "--id", monitorId, "--cursor-file", cursorFile);
    expect(poll.code).toBe(0);
    const matches = parse(poll.out).matches as Array<Record<string, unknown>>;
    expect(matches).toHaveLength(3);
    expect(matches.map((m) => `${m.blockHeight as string}:${m.position as number}`)).toEqual([
      "100:0",
      "100:4",
      "118:2",
    ]);
    expect(matches.every((m) => m.appliedOutcome === "unknown")).toBe(true);
    expect(matches[2]!.matchedSegments).toEqual([0, 2]);
    expect(parse(poll.out).coverage).toMatchObject({ scannedFrom: "0", scannedThrough: "120" });
    const cursorAfterMatches = readFileSync(cursorFile, "utf8");
    expect(cursorAfterMatches).not.toBe(cursorAfterEmpty);

    // ── poll again: idempotent resume ───────────────────────────────────────────────────────
    const resumePoll = await client("poll", "--id", monitorId, "--cursor-file", cursorFile);
    expect(resumePoll.code).toBe(0);
    expect(parse(resumePoll.out).matches).toEqual([]);
    // Byte-identical cursor file: a poller that keeps polling an idle monitor must not drift.
    expect(readFileSync(cursorFile, "utf8")).toBe(cursorAfterMatches);
    // And no transaction hash is printed twice across the two polls.
    const firstHashes = matches.map((m) => m.txHash as string);
    for (const hash of firstHashes) expect(resumePoll.out).not.toContain(hash);

    // ── pause and resume ────────────────────────────────────────────────────────────────────
    const paused = await client("pause", "--id", monitorId);
    expect(parse(paused.out).state).toBe("paused");
    // Matches stay readable while paused (US3 scenario 1).
    const pausedPoll = await client("poll", "--id", monitorId, "--cursor-file", cursorFile);
    expect(pausedPoll.code).toBe(0);
    expect(parse(pausedPoll.out).coverage).toMatchObject({ scannedThrough: "120" });

    const resumed = await client("resume", "--id", monitorId);
    expect(parse(resumed.out).state).toBe("backfilling");

    // ── revoke: reads are refused afterwards ────────────────────────────────────────────────
    const revoked = await client("revoke", "--id", monitorId);
    expect(parse(revoked.out).state).toBe("revoked");
    await expect(client("status", "--id", monitorId)).rejects.toThrow(/410 MONITOR_REVOKED/);
    await expect(
      client("poll", "--id", monitorId, "--cursor-file", cursorFile),
    ).rejects.toThrow(/410 MONITOR_REVOKED/);

    // ── delete: as if it never existed ──────────────────────────────────────────────────────
    const deleted = await client("delete", "--id", monitorId);
    expect(deleted.code).toBe(0);
    expect(parse(deleted.out)).toEqual({ monitorId, deleted: true });
    await expect(client("status", "--id", monitorId)).rejects.toThrow(/404 MONITOR_NOT_FOUND/);
    await expect(client("delete", "--id", monitorId)).rejects.toThrow(/404 MONITOR_NOT_FOUND/);

    // The key never appears in anything the client printed, across the whole run.
    expect(allOutput.join("")).not.toBe("");
    expect(allOutput.join("")).not.toContain(encodedKey);
    expect(allOutput.join("")).not.toContain(encodedKey.slice(encodedKey.lastIndexOf("1") + 1));
  }, 180_000);

  it("resumes from a cursor file written by an earlier process, without replaying", async () => {
    const secondKeyFile = path.join(workDir, "second.key");
    const secondCursor = path.join(workDir, "second.cursor");
    writeFileSync(secondKeyFile, `${await fixtureViewingKeyEncoded(7778)}\n`, "utf8");

    const registered = await client("register", "--key-file", secondKeyFile);
    const id = parse(registered.out).monitorId as string;
    const loaded = await store.getIncludingRevoked(id);
    await store.advance(loaded!.id, loaded!.epoch, 10n, [association(10n, 0), association(10n, 1)]);

    const first = await client("poll", "--id", id, "--cursor-file", secondCursor, "--limit", "1");
    expect((parse(first.out).matches as unknown[]).length).toBe(1);
    const persisted = readFileSync(secondCursor, "utf8").trim();

    // A "restart": the cursor file is all the state a new process has.
    const second = await client("poll", "--id", id, "--cursor-file", secondCursor, "--limit", "1");
    const secondMatches = parse(second.out).matches as Array<Record<string, unknown>>;
    expect(secondMatches).toHaveLength(1);
    expect(secondMatches[0]!.position).toBe(1);
    expect(readFileSync(secondCursor, "utf8").trim()).not.toBe(persisted);

    // A third poll with no new data leaves the file alone.
    const third = await client("poll", "--id", id, "--cursor-file", secondCursor, "--limit", "1");
    expect(parse(third.out).matches).toEqual([]);
  }, 120_000);

  it("refuses a cursor file belonging to a different monitor rather than paging the wrong stream", async () => {
    const otherKeyFile = path.join(workDir, "third.key");
    writeFileSync(otherKeyFile, `${await fixtureViewingKeyEncoded(7779)}\n`, "utf8");
    const registered = await client("register", "--key-file", otherKeyFile);
    const id = parse(registered.out).monitorId as string;

    const crossedCursor = path.join(workDir, "crossed.cursor");
    // A cursor minted for the SECOND monitor, pointed at this one — the "crossed cursor files"
    // mistake the binding in the cursor exists to catch.
    const foreign = readFileSync(path.join(workDir, "second.cursor"), "utf8").trim();
    writeFileSync(crossedCursor, `${foreign}\n`, "utf8");

    await expect(
      client("poll", "--id", id, "--cursor-file", crossedCursor),
    ).rejects.toThrow(/400 INVALID_CURSOR/);
  }, 120_000);

  it("exits with a usage code, not a crash, on a missing flag or an unknown command", async () => {
    await expect(client("status")).rejects.toThrow(/missing required flag --id/);
    const unknown = await client("nonsense");
    expect(unknown.code).toBe(2);
  });

  /**
   * The import audit (this change's design §2).
   *
   * The client must be usable by an application holding **no database credentials and no schema
   * knowledge**. If it could import `PgShieldedMonitorStore`, a later refactor could quietly turn
   * this whole "end-to-end" suite into a set of function calls and the acceptance evidence would
   * evaporate without one failing assertion. So the rule is a test, not a comment.
   */
  it("imports nothing but Node built-ins — no store, no driver, no schema name", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../shielded-monitor/client/cli.ts", import.meta.url)),
      "utf8",
    );

    const specifiers = [
      ...source.matchAll(/(?:^|\s)(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g),
      ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
      ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
      ...source.matchAll(/(?:^|\s)import\s+["']([^"']+)["']/g),
    ].map((m) => m[1]!);

    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier, `${specifier} is not a Node built-in`).toMatch(/^node:/);
    }

    // Belt and braces: the names that would matter even if the regexes above missed a form.
    for (const forbidden of ["shielded-monitor/store", "src/postgres", "postgres", "shielded_monitor"]) {
      expect(source, `the client must not mention ${forbidden}`).not.toContain(`"${forbidden}"`);
    }
    // A positive control for the audit itself: the regexes DO find the built-in imports the file
    // really has, so an audit that silently matched nothing cannot pass.
    expect(specifiers).toContain("node:fs/promises");
  });
});
