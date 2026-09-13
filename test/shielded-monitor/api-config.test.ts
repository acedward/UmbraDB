import { describe, expect, it } from "vitest";
import {
  ApiConfigError,
  DEFAULT_API_HOST,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_PAGE,
  loadApiConfig,
} from "../../shielded-monitor/api/config.js";
import { MAX_ASSOCIATION_PAGE } from "../../shielded-monitor/store.js";

/**
 * API configuration (organizer spec FR-018, FR-021). No Docker: this is pure parsing.
 *
 * The point of every case below is that a misconfiguration is a **boot** failure naming the
 * variable, not a runtime surprise on the first request that happens to trip it.
 */
/** Project B has no database, so STORAGE_URL is required on every boot (owner question Q25).
 *  Every case below is about some OTHER variable, so the required one is supplied once here. */
const BASE = { STORAGE_URL: "http://storage-api:8788" } as const;

describe("loadApiConfig", () => {
  it("defaults to loopback — the only thing standing between an unauthenticated API and the network", () => {
    const config = loadApiConfig({ ...BASE });
    expect(config.host).toBe(DEFAULT_API_HOST);
    expect(config.host).toBe("127.0.0.1");
    expect(config.maxBodyBytes).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(config.maxPage).toBe(DEFAULT_MAX_PAGE);
    expect(config.net).toBe("undeployed");
    expect(config.storageUrl).toBe(BASE.STORAGE_URL);
  });

  it("refuses a page cap above the store's own cap, at boot", () => {
    // The store caps a page at MAX_ASSOCIATION_PAGE regardless (00009-02), so an API cap above it
    // would turn a request the API considers legal into a store-level VALIDATION_FAILED — a 400
    // whose real cause is a server misconfiguration.
    expect(() => loadApiConfig({ ...BASE, API_MAX_PAGE: String(MAX_ASSOCIATION_PAGE + 1) })).toThrowError(
      ApiConfigError,
    );
    expect(loadApiConfig({ ...BASE, API_MAX_PAGE: String(MAX_ASSOCIATION_PAGE) }).maxPage).toBe(
      MAX_ASSOCIATION_PAGE,
    );
  });

  it("clamps the default page to the configured cap rather than exceeding it", () => {
    expect(loadApiConfig({ ...BASE, API_MAX_PAGE: "10" }).defaultPage).toBe(10);
    expect(() => loadApiConfig({ ...BASE, API_MAX_PAGE: "10", API_DEFAULT_PAGE: "11" })).toThrowError(
      ApiConfigError,
    );
  });

  it.each([
    ["API_PORT", "70000"],
    ["API_PORT", "-1"],
    ["API_PORT", "8787 "],
    ["API_MAX_BODY_BYTES", "0"],
    ["API_MAX_BODY_BYTES", "1e6"],
    ["API_MAX_PAGE", "0"],
    ["API_MAX_PAGE", "0x10"],
    ["SHIELDED_MONITOR_NET", "under scored space"],
    ["API_HOST", ""],
  ])("refuses %s=%s and names the variable", (variable, value) => {
    // ` 8787 ` with a trailing space is admitted (trimmed) — the case above uses a trailing space
    // deliberately to prove trimming happens, so it must NOT throw; every other value must.
    if (variable === "API_PORT" && value === "8787 ") {
      expect(loadApiConfig({ ...BASE, [variable]: value }).port).toBe(8787);
      return;
    }
    try {
      loadApiConfig({ ...BASE, [variable]: value });
      expect.unreachable(`${variable}=${value} must be refused`);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiConfigError);
      expect((err as ApiConfigError).variable).toBe(variable);
    }
  });

  it("admits port 0 — the shared-host case where the kernel picks a free port", () => {
    expect(loadApiConfig({ ...BASE, API_PORT: "0" }).port).toBe(0);
  });
});
