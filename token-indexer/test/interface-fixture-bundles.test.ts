import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePublication } from "../interface/event.js";
import { DEFAULT_LEVEL1_LIMITS } from "../interface/level1.js";
import type { StateObservation, StateSource } from "../interface/level2.js";
import { verifyPublication, type PublicationToVerify, type VerifierDeps } from "../interface/verify.js";
import { startBundleHost, type BundleHost } from "./helpers/bundle-host.js";

/**
 * Project 00024-02 — the REAL fixture bundles of 02-B5 (`fixtures/interfaces/b5-bundles/`, copied
 * from `acedward/mip-public-interfaces` @ `dd9d95f`, see `fixtures/interfaces/SOURCE.md`): six cases
 * built from LSUNPI's FULL interface by the patched `public-interface-deploy-check`, and
 * `cases.json` — the outcome spec 00024 FR-010–FR-013 asks of an unattended verifier for each. This
 * is spec US1's Independent Test ("fixture bundles (valid, tampered file, wrong `hash`, over the size
 * cap, on a loopback host) end `verified`, `failed`, `failed`, `unchecked`, `unfetchable`") plus the
 * compiler that is not installed (`not_run`, US1 scenario 4b), through the indexer's whole pipeline
 * (`verifyPublication`: fetch guard, Level 1, Level 2 on LSUNPI's state, Level 3 tried).
 *
 * Each bundle is served by a real local host. The event URL in `cases.json` names the local stack's
 * host (`http://bundles/…`); here each case is published under the local host's address instead —
 * the URL is not part of the commitment, so the verification is the same — except `loopback-host`,
 * which keeps its exact URL and payload and runs with the production default (private hosts refused).
 * Level 3 runs on the stand-in compiler (CI has none); the real compiler on the valid case is in the
 * evidence note.
 */

const DIR = fileURLToPath(new URL("./fixtures/interfaces/b5-bundles/", import.meta.url));
const STAND_IN = fileURLToPath(new URL("./helpers/fake-compact.mjs", import.meta.url));
const LSUNPI = "5a".repeat(32); // a stand-in address: the fixtures are simulated, not deployed

interface Case {
  case: string;
  url: string;
  commitment: string;
  indexHash: string;
  eventPayloadHex: string;
  partsHex: string[];
  bundleBytes: number;
  files: number;
  limits?: { maxBundleBytes?: number };
  expected: { status: string; level1: string; level2: string; level3: string; reason: string | null };
}

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, base) : [p.slice(base.length + 1).split("\\").join("/")];
  });
}

class StubState implements StateSource {
  readonly description = "LSUNPI.state.hex (02-B5 simulated state)";
  constructor(private readonly state: Buffer) {}
  async stateOf(): Promise<StateObservation> { return { state: this.state, blockHeight: null, txHash: null }; }
}

describe("02-B5 fixture bundles through the indexer's pipeline", () => {
  let host: BundleHost;
  let scratch: string;
  const cases = JSON.parse(readFileSync(join(DIR, "cases.json"), "utf8")) as { stateSha256: string; cases: Case[] };
  const state = Buffer.from(readFileSync(join(DIR, "LSUNPI.state.hex"), "utf8").trim(), "hex");
  const bundleOf = (name: string): Map<string, Buffer> => {
    const root = join(DIR, name, "bundle");
    return new Map(walk(root).map((p) => [p, readFileSync(join(root, p))]));
  };

  beforeAll(async () => {
    host = await startBundleHost();
    scratch = mkdtempSync(join(tmpdir(), "umbradb-b5-test-"));
    for (const c of cases.cases) if (c.case !== "loopback-host") host.mount(`/fixtures/${c.case}/`, bundleOf(c.case));
  });
  afterAll(async () => {
    delete process.env.FAKE_COMPACT_OUTPUT;
    delete process.env.FAKE_COMPACT_TRACE;
    await host?.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  /** The stand-in compiler's recorded output for a bundle: its own artifacts (a reproducing compile). */
  function recordedCompile(bundle: Map<string, Buffer>): string {
    const out = mkdtempSync(join(scratch, "out-"));
    for (const d of ["keys", "contract", "compiler"]) mkdirSync(join(out, d), { recursive: true });
    for (const [p, body] of bundle) {
      if (p.startsWith("out/keys/") || p === "out/contract/index.js" || p === "out/compiler/contract-info.json") writeFileSync(join(out, p.slice(4)), body);
    }
    return out;
  }

  async function run(c: Case, overrides: Partial<VerifierDeps> = {}) {
    const bundle = bundleOf(c.case);
    process.env.FAKE_COMPACT_OUTPUT = recordedCompile(bundle);
    // LSUNPI's source imports its modules by name, so a real compile prints one `--trace-search`
    // line per module it reads; the stand-in prints the same (Level 3's positive control needs them).
    const entry = (JSON.parse(bundle.get("package.json")!.toString("utf8")) as { compact: { interface: string } }).compact.interface;
    process.env.FAKE_COMPACT_TRACE = JSON.stringify([...bundle.keys()]
      .filter((p) => p.endsWith(".compact") && p !== entry).sort().map((p) => `looking for ${p}...found`));
    const loopback = c.case === "loopback-host";
    const url = loopback ? c.url : `${host.origin}/fixtures/${c.case}/index.json`;
    const pointer = decodePublication(Buffer.from(c.eventPayloadHex, "hex"));
    const publication: PublicationToVerify = {
      eventId: 1, partEventIds: [1], address: LSUNPI, txHash: "ab".repeat(32), blockHeight: 1, txPosition: 0,
      segment: 1, parts: pointer.parts, phase: "guaranteed", commitment: Buffer.from(pointer.commitment), url, urlError: null,
    };
    const deps: VerifierDeps = {
      stateSource: new StubState(state),
      // Production default (private hosts refused) for the loopback case; the TEST-ONLY bypass for the
      // others, whose host is 127.0.0.1 here as it is the stack's bundle server in 02-D.
      fetchPolicy: { allowPrivateHosts: !loopback, deadlineMs: 10_000 },
      limits: { ...DEFAULT_LEVEL1_LIMITS, ...(c.limits ?? {}) },
      level3: { compactBin: STAND_IN, deadlineMs: 20_000, tmpRoot: scratch },
      ...overrides,
    };
    host.requests.length = 0;
    const result = await verifyPublication("undeployed", publication, deps, "initial", new Date());
    return { result, requests: host.requests.map((r) => r.path), pointer };
  }

  it("[[interface-fixture-bundles]] the six 02-B5 LSUNPI cases end exactly as cases.json expects: verified L1/L2/L3, failed (tampered file), failed after one request (wrong hash), unchecked (size cap), unfetchable (loopback, bypass OFF), verified with L3 not_run (compiler 0.33.0)", async () => {
    // The inputs are the ones 02-B5 recorded: the state's digest, each payload's commitment and URL.
    expect(createHash("sha256").update(state).digest("hex")).toBe(cases.stateSha256);
    expect(cases.cases.map((c) => c.case)).toEqual(["valid", "tampered-file", "wrong-hash", "over-size-cap", "loopback-host", "compiler-not-installed"]);
    for (const c of cases.cases) {
      const p = decodePublication(Buffer.from(c.eventPayloadHex, "hex"));
      expect(Buffer.from(p.commitment).toString("hex"), c.case).toBe(c.commitment);
      expect(p.url, c.case).toBe(c.url);
      expect(Buffer.concat(c.partsHex.map((h) => Buffer.from(h, "hex"))).toString("hex"), c.case).toBe(c.eventPayloadHex);
      const bundle = bundleOf(c.case);
      expect(JSON.parse(bundle.get("index.json")!.toString("utf8")).hash, c.case).toBe(c.indexHash);
      expect(bundle.size, c.case).toBe(c.files); // cases.json counts index.json too
      expect([...bundle.values()].reduce((n, b) => n + b.length, 0), c.case).toBe(c.bundleBytes);
    }

    const levels = (r: { l1: string; l2: string; l3: string }) => ({ level1: r.l1, level2: r.l2, level3: r.l3 });
    const byName = (name: string): Case => cases.cases.find((c) => c.case === name)!;

    // valid → verified, L1/L2/L3 passed.
    const valid = await run(byName("valid"));
    expect(valid.result.status).toBe(byName("valid").expected.status);
    expect(levels(valid.result)).toEqual({ level1: "passed", level2: "passed", level3: "passed" });
    expect(valid.result.level).toBe(3);
    expect(valid.result.circuits.map((c) => c.name).sort()).toEqual(
      ["balanceOf", "decimals", "mint", "name", "publishBundle", "publishRepository", "symbol", "totalSupply", "transfer"]);
    expect(valid.result.circuits.every((c) => c.l2 === "OK" && c.onChain)).toBe(true);
    expect(valid.requests).toHaveLength(21); // index.json + the 20 listed files, nothing else

    // tampered-file → failed at L1, naming the file.
    const tampered = await run(byName("tampered-file"));
    expect({ status: tampered.result.status, ...levels(tampered.result) }).toEqual({ status: "failed", level1: "failed", level2: "not_run", level3: "not_run" });
    // A line appended to the file: longer than its entry declares, so the transfer is stopped at the
    // declared size — the bytes do not match (the reference reports the same file).
    expect(tampered.result.reason).toMatch(/src\/generated\/LSUNPI\.compact: the host serves more than the \d+ bytes index\.json declares/);
    expect(tampered.result.failedLevel).toBe(1);

    // wrong-hash → failed at L1 after exactly ONE request.
    const wrong = await run(byName("wrong-hash"));
    expect({ status: wrong.result.status, ...levels(wrong.result) }).toEqual({ status: "failed", level1: "failed", level2: "not_run", level3: "not_run" });
    expect(wrong.result.reason).toMatch(/hash .* is not the event's commitment/);
    expect(wrong.requests).toEqual(["/fixtures/wrong-hash/index.json"]);

    // over-size-cap → unchecked under the 1 MiB cap it is built to exceed, nothing past index.json;
    // verified like `valid` when the cap is the default.
    const capped = await run(byName("over-size-cap"));
    expect({ status: capped.result.status, ...levels(capped.result) }).toEqual({ status: "unchecked", level1: "not_run", level2: "not_run", level3: "not_run" });
    expect(capped.result.reason).toMatch(/over the 1048576-byte bundle limit/);
    expect(capped.requests).toEqual(["/fixtures/over-size-cap/index.json"]);
    const uncapped = await run(byName("over-size-cap"), { limits: DEFAULT_LEVEL1_LIMITS });
    expect({ status: uncapped.result.status, level: uncapped.result.level }).toEqual({ status: "verified", level: 3 });

    // loopback-host → unfetchable with private hosts refused (the production default): no request.
    const loop = await run(byName("loopback-host"));
    expect({ status: loop.result.status, ...levels(loop.result) }).toEqual({ status: "unfetchable", level1: "not_run", level2: "not_run", level3: "not_run" });
    expect(loop.result.reason).toMatch(/127\.0\.0\.1 is a loopback address/);
    expect(loop.requests).toEqual([]);

    // compiler-not-installed → verified at L1/L2, L3 not_run: compiler 0.33.0 unavailable.
    const old = await run(byName("compiler-not-installed"));
    expect({ status: old.result.status, ...levels(old.result) }).toEqual({ status: "verified", level1: "passed", level2: "passed", level3: "not_run" });
    expect(old.result.level).toBe(2);
    expect(old.result.l3Reason).toMatch(/^compiler 0\.33\.0 unavailable/);

    // Every case ended as cases.json says (status and the three levels).
    const results: Record<string, { status: string; l1: string; l2: string; l3: string }> = {
      valid: valid.result, "tampered-file": tampered.result, "wrong-hash": wrong.result, "over-size-cap": capped.result,
      "loopback-host": loop.result, "compiler-not-installed": old.result,
    };
    for (const c of cases.cases) {
      const r = results[c.case]!;
      expect({ status: r.status, level1: r.l1, level2: r.l2, level3: r.l3 }, c.case).toEqual({
        status: c.expected.status, level1: c.expected.level1, level2: c.expected.level2, level3: c.expected.level3,
      });
    }
  }, 120_000);
});
