import { describe, expect, it, vi } from "vitest";
import type { ArchiveReadContract } from "../../src/interfaces/archive-read-contract.js";
import { openArchiveSource } from "../../shielded-monitor/archive-source.js";
import { HttpArchiveReadContract } from "../../shielded-monitor/archive-http-client.js";
import { loadApiConfig } from "../../shielded-monitor/api/config.js";
import { readScannerConfig } from "../../shielded-monitor/scanner-config.js";

/**
 * The one decision that makes project B a distinct deployable: WHERE the archive comes from
 * (organizer sub-plan 00009-08; `spec/00009` FR-025).
 *
 * Two claims are under test, and only the second needs a spy:
 *
 *  1. `ARCHIVE_URL` selects the HTTP client and the SSE wake-up; its absence selects the
 *     in-process PostgreSQL reader and `LISTEN`.
 *  2. **On the HTTP path the PostgreSQL implementation is never loaded at all.** That is the
 *     deployment property `import-boundary.test.ts` cannot show — a dynamic import is invisible to
 *     a static walk — and it is the property a TEE profile actually depends on: the attested
 *     process holds no archive storage code and no archive credential (organizer question Q24).
 */

const FAKE_SQL = {
  listen: async () => ({ unlisten: async () => undefined }),
};

describe("openArchiveSource", () => {
  it("ARCHIVE_URL selects the HTTP client, marks the source REMOTE, and never loads A's storage", async () => {
    const loader = vi.fn(async () => {
      throw new Error("the PostgreSQL archive reader must not be loaded on the HTTP path");
    });
    const source = await openArchiveSource({
      archiveUrl: "http://archive-read-api:8790/",
      archiveSchema: "chain_archive",
      sql: FAKE_SQL,
      loadPgArchiveReadContract: loader as never,
    });
    expect(loader).not.toHaveBeenCalled();
    expect(source.archive).toBeInstanceOf(HttpArchiveReadContract);
    expect(source.remote).toBe(true);
    expect(source.wake.describe).toContain("/v1/archive/events");
    expect(source.describe).toContain("http://archive-read-api:8790");
  });

  it("without ARCHIVE_URL it loads the in-process reader, with B's own handle and the archive schema", async () => {
    const constructed: { schema: string }[] = [];
    class FakePg implements ArchiveReadContract {
      constructor(_sql: never, schema: string) { constructed.push({ schema }); }
      async readBlocksSince() { return { blocks: [] }; }
      async getArchiveIdentity() { return undefined; }
    }
    const source = await openArchiveSource({
      archiveSchema: "chain_archive",
      sql: FAKE_SQL,
      loadPgArchiveReadContract: async () => FakePg as never,
    });
    expect(constructed).toStrictEqual([{ schema: "chain_archive" }]);
    expect(source.remote).toBe(false);
    expect(source.wake.describe).toBe("LISTEN chain_archive_progress");
  });

  it("refuses to build a source with neither a URL nor a connection, rather than idling forever", async () => {
    // The failure this prevents is the quiet one: a scanner with no archive would report itself
    // healthy and permanently at the tip.
    await expect(openArchiveSource({ archiveSchema: "chain_archive" })).rejects.toThrow(/no archive source/);
  });

  it("`wake: false` leaves polling as the only trigger (what the API process asks for)", async () => {
    const source = await openArchiveSource({
      archiveUrl: "http://archive-read-api:8790",
      archiveSchema: "chain_archive",
      wake: false,
    });
    expect(source.wake.describe).toBe("polling only");
  });
});

describe("the scanner refuses an ambiguous archive configuration", () => {
  const base = { MONITOR_PG: "postgres://u:p@h:5432/db" };

  it("accepts ARCHIVE_URL alone and normalises it", () => {
    const config = readScannerConfig({ ...base, ARCHIVE_URL: "http://archive-read-api:8790/" }, []);
    expect(config.archiveUrl).toBe("http://archive-read-api:8790");
  });

  it("accepts an archive schema alone (the single-host mode this repository already shipped)", () => {
    const config = readScannerConfig({ ...base, ARCHIVE_SCHEMA: "chain_archive" }, []);
    expect(config.archiveUrl).toBeUndefined();
    expect(config.archiveSchema).toBe("chain_archive");
  });

  it.each(["ARCHIVE_SCHEMA", "ARCHIVE_PG"])(
    "REFUSES ARCHIVE_URL together with %s, naming both",
    (variable) => {
      expect(() => readScannerConfig({ ...base, ARCHIVE_URL: "http://a:8790", [variable]: "x" }, []))
        .toThrow(new RegExp(`ARCHIVE_URL is set[\\s\\S]*${variable}`));
    },
  );

  it("refuses an ARCHIVE_URL that is not a usable base URL", () => {
    expect(() => readScannerConfig({ ...base, ARCHIVE_URL: "http://a:8790/?net=x" }, []))
      .toThrow(/bare base URL/);
    expect(() => readScannerConfig({ ...base, ARCHIVE_URL: "not-a-url" }, [])).toThrow(/ARCHIVE_URL/);
  });

  it("gives every instance a distinct lease owner by default, and honours SCAN_INSTANCE_ID", () => {
    // Two containers started from ONE image and ONE environment must not share an owner string:
    // each would renew the other's lease and both would scan the same monitor.
    const a = readScannerConfig(base, []);
    const b = readScannerConfig(base, []);
    expect(a.instanceId).not.toBe(b.instanceId);
    expect(readScannerConfig({ ...base, SCAN_INSTANCE_ID: "scanner-1" }, []).instanceId).toBe("scanner-1");
    expect(readScannerConfig(base, []).leaseTtlMs).toBe(30_000);
    expect(readScannerConfig({ ...base, SCAN_LEASE_TTL_MS: "5000" }, []).leaseTtlMs).toBe(5_000);
  });
});

describe("the API refuses an ambiguous archive configuration", () => {
  it("accepts ARCHIVE_URL alone", () => {
    expect(loadApiConfig({ ARCHIVE_URL: "http://archive-read-api:8790" }).archiveUrl)
      .toBe("http://archive-read-api:8790");
  });

  it.each(["ARCHIVE_SCHEMA", "ARCHIVE_PG"])("REFUSES ARCHIVE_URL together with %s", (variable) => {
    expect(() => loadApiConfig({ ARCHIVE_URL: "http://a:8790", [variable]: "x" }))
      .toThrow(new RegExp(`invalid ARCHIVE_URL[\\s\\S]*${variable}`));
  });

  it("keeps SOURCE_TIP=off as the opt-out for an API with no archive access at all", () => {
    expect(loadApiConfig({ SOURCE_TIP: "off" }).sourceTipDisabled).toBe(true);
    expect(loadApiConfig({}).sourceTipDisabled).toBe(false);
    expect(loadApiConfig({}).archiveSchema).toBe("chain_archive");
  });
});
