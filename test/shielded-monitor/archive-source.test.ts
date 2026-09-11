import { describe, expect, it } from "vitest";
import { openArchiveSource } from "../../shielded-monitor/archive-source.js";
import { HttpArchiveReadContract } from "../../shielded-monitor/archive-http-client.js";
import { loadApiConfig } from "../../shielded-monitor/api/config.js";
import { databaseVariablesIn } from "../../shielded-monitor/no-database.js";
import { readScannerConfig } from "../../shielded-monitor/scanner-config.js";

/**
 * The decision that makes project B a distinct deployable: it reaches EVERYTHING over one base
 * URL, and it refuses to run any other way (sub-plan 00009-08 v2; owner question Q25;
 * `spec/00009` FR-025, FR-026).
 *
 * Three claims are under test:
 *
 *  1. the archive source is the HTTP client, always, and it is marked REMOTE (which is what turns
 *     on the transaction-identity check, organizer question Q23);
 *  2. `STORAGE_URL` is required, and `ARCHIVE_URL` merely overrides where `/v1/archive/*` is
 *     served — it defaults to the storage API, which serves both route families;
 *  3. **a database credential in the environment is a refusal, not a warning**, on BOTH entry
 *     points. That is the property the split topology exists to establish: a leftover
 *     `MONITOR_PG` is a live credential in a process that must not have one.
 */

const STORAGE = "http://storage-api:8788";

describe("openArchiveSource", () => {
  it("builds the HTTP client, marks the source REMOTE, and subscribes to the SSE stream", () => {
    const source = openArchiveSource({ archiveUrl: `${STORAGE}/` });
    expect(source.archive).toBeInstanceOf(HttpArchiveReadContract);
    expect(source.remote).toBe(true);
    expect(source.wake.describe).toContain("/v1/archive/events");
    expect(source.describe).toContain(STORAGE);
  });

  it("refuses an empty URL rather than idling forever", () => {
    // The failure this prevents is the quiet one: a scanner with no archive would report itself
    // healthy and permanently at the tip.
    expect(() => openArchiveSource({ archiveUrl: "" })).toThrow(/no archive source/);
  });

  it("`wake: false` leaves polling as the only trigger (what the API process asks for)", () => {
    expect(openArchiveSource({ archiveUrl: STORAGE, wake: false }).wake.describe).toBe("polling only");
  });
});

describe("the scanner's storage configuration", () => {
  const base = { STORAGE_URL: STORAGE };

  it("requires STORAGE_URL", () => {
    expect(() => readScannerConfig({}, [])).toThrow(/STORAGE_URL is required/);
  });

  it("normalises STORAGE_URL and defaults ARCHIVE_URL to it", () => {
    const config = readScannerConfig({ STORAGE_URL: `${STORAGE}/` }, []);
    expect(config.storageUrl).toBe(STORAGE);
    expect(config.archiveUrl).toBe(STORAGE);
  });

  it("lets ARCHIVE_URL point the archive routes at a standalone read API", () => {
    const config = readScannerConfig({ ...base, ARCHIVE_URL: "http://archive-read-api:8790/" }, []);
    expect(config.storageUrl).toBe(STORAGE);
    expect(config.archiveUrl).toBe("http://archive-read-api:8790");
  });

  it("refuses a URL that is not a bare base URL", () => {
    expect(() => readScannerConfig({ STORAGE_URL: `${STORAGE}/?net=x` }, [])).toThrow(/bare base URL/);
    expect(() => readScannerConfig({ STORAGE_URL: "not-a-url" }, [])).toThrow(/STORAGE_URL/);
  });

  it.each(["MONITOR_PG", "ARCHIVE_PG", "SHIELDED_MONITOR_PG", "ARCHIVE_SCHEMA", "MONITOR_SCHEMA"])(
    "REFUSES to start with %s in the environment, naming it",
    (variable) => {
      expect(() => readScannerConfig({ ...base, [variable]: "x" }, []))
        .toThrow(new RegExp(`database configuration in its environment[\\s\\S]*${variable}`));
    },
  );

  it("does NOT refuse libpq's own PG* family, which is inert here", () => {
    // B ships no driver to read them, they are commonly set in a developer's shell, and failing a
    // scanner because someone has `psql` configured would be a refusal with no security value.
    expect(databaseVariablesIn({ PGHOST: "localhost", PGUSER: "eddie" })).toStrictEqual([]);
    expect(() => readScannerConfig({ ...base, PGHOST: "localhost" }, [])).not.toThrow();
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

describe("the private API's storage configuration", () => {
  it("requires STORAGE_URL and defaults ARCHIVE_URL to it", () => {
    expect(() => loadApiConfig({})).toThrow(/invalid STORAGE_URL/);
    const config = loadApiConfig({ STORAGE_URL: STORAGE });
    expect(config.storageUrl).toBe(STORAGE);
    expect(config.archiveUrl).toBe(STORAGE);
  });

  it("lets ARCHIVE_URL override where /v1/archive/* is served", () => {
    expect(loadApiConfig({ STORAGE_URL: STORAGE, ARCHIVE_URL: "http://archive-read-api:8790" }).archiveUrl)
      .toBe("http://archive-read-api:8790");
  });

  it.each(["SHIELDED_MONITOR_PG", "MONITOR_PG", "ARCHIVE_SCHEMA"])(
    "REFUSES to start with %s in the environment",
    (variable) => {
      expect(() => loadApiConfig({ STORAGE_URL: STORAGE, [variable]: "x" }))
        .toThrow(new RegExp(`database configuration in its environment[\\s\\S]*${variable}`));
    },
  );

  it("keeps SOURCE_TIP=off as the opt-out for an API whose storage serves no archive routes", () => {
    expect(loadApiConfig({ STORAGE_URL: STORAGE, SOURCE_TIP: "off" }).sourceTipDisabled).toBe(true);
    expect(loadApiConfig({ STORAGE_URL: STORAGE }).sourceTipDisabled).toBe(false);
  });
});
