import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pad32 } from "../color.js";
import {
  MAX_PACKAGE_PARTS, MULTIPART_OPT_INS, PackageReadError, readPackages, restorePart,
  type PartEvent,
} from "../ingest/packages.js";
import { LEGACY_NAME_HEX, MIP_0018_NAME_HEX } from "../ingest/payload.js";

/**
 * Project 00024-01 task B3 — the multi-part reader at the READER level: every normative vector of
 * [Y] (`compact-multi-part-event` PR #1 @ `f2425f2`, `MIP-SPEC-DRAFT.md` "Testing"), fed as the
 * valid, decoded, applied events the vectors start from, plus the reader's own boundaries.
 *
 * The governed `[[multipart-vector-<case>]]` ids run the same vectors THROUGH the scanner — fake
 * ledger transcripts, the real HTTP event source, the barrier and the fold — in
 * `multipart-vectors.test.ts`. This file pins the port itself against [Y]'s table.
 */

const A = new Uint8Array(256).fill(0xaa);
const B = (() => { const b = new Uint8Array(256).fill(0xbb); b[255] = 0; return b; })();
const C = new Uint8Array(256).fill(0xcc);
const Z = new Uint8Array(256);

const NET = "undeployed";
const CONTRACT = "c0".repeat(32);
const T1 = "71".repeat(32);
const T2 = "72".repeat(32);
const NAME = MIP_0018_NAME_HEX;

/** The ledger trims trailing zeros from a logged value; a source may hand a part over that way. */
function trimmed(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return bytes.slice(0, end);
}

function part(
  payload: Uint8Array, position: number,
  o: { segment?: number; tx?: string; phase?: "guaranteed" | "fallible"; contract?: string; nameHex?: string; network?: string } = {},
): PartEvent {
  return {
    network: o.network ?? NET, contract: o.contract ?? CONTRACT, nameHex: o.nameHex ?? NAME,
    transactionHash: o.tx ?? T1, segment: o.segment ?? 7, position, payload,
    phase: o.phase ?? "guaranteed",
  };
}

const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.length * 256);
  parts.forEach((p, i) => out.set(p, i * 256));
  return out;
};
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

describe("multi-part reader — [Y] §4 normative vectors (reader level)", () => {
  it("empty filtered input → no package", () => {
    expect(readPackages([]).packages).toEqual([]);
    // Events of names that did not opt in are the same as none, and are counted as ignored.
    const other = Buffer.from(pad32("example:message[v1]")).toString("hex");
    const out = readPackages([part(A, 0, { nameHex: other }), part(A, 1, { nameHex: LEGACY_NAME_HEX })]);
    expect(out.packages).toEqual([]);
    expect(out.ignored).toBe(2);
  });

  it("all-zero part → one part, payload Z, length 256 (delivered fully trimmed)", () => {
    const [pkg, ...rest] = readPackages([part(trimmed(Z), 0)]).packages;
    expect(rest).toEqual([]);
    expect(pkg!.parts).toHaveLength(1);
    expect(hex(pkg!.payload)).toBe(hex(Z));
    expect(pkg!.payload).toHaveLength(256);
  });

  it("trailing zero → one part, payload B, its final zero kept", () => {
    const [pkg] = readPackages([part(trimmed(B), 0)]).packages;
    expect(hex(pkg!.payload)).toBe(hex(B));
    expect(pkg!.payload[255]).toBe(0);
  });

  it("guaranteed multipart → one package A || B, 512 bytes, guaranteed", () => {
    const out = readPackages([part(A, 0), part(B, 1)]).packages;
    expect(out).toHaveLength(1);
    expect(hex(out[0]!.payload)).toBe(hex(cat(A, B)));
    expect(out[0]!.payload).toHaveLength(512);
    expect(out[0]!.phase).toBe("guaranteed");
  });

  it("fallible success → one package C || B, fallible", () => {
    const [pkg] = readPackages([part(C, 0, { phase: "fallible" }), part(B, 1, { phase: "fallible" })]).packages;
    expect(hex(pkg!.payload)).toBe(hex(cat(C, B)));
    expect(pkg!.phase).toBe("fallible");
  });

  it("fallible failure → no applied matching event → no package", () => {
    expect(readPackages([]).packages).toEqual([]);
  });

  it("same-group separate intentions → one package A || B, flagged mixed (publisher error), not dropped", () => {
    const [pkg, ...rest] = readPackages([part(A, 0), part(B, 1, { phase: "fallible" })]).packages;
    expect(rest).toEqual([]);
    expect(hex(pkg!.payload)).toBe(hex(cat(A, B)));
    expect(pkg!.phase).toBe("mixed");
  });

  it("mixed-phase failure → one package A only; the reader does not infer B", () => {
    const [pkg, ...rest] = readPackages([part(A, 0)]).packages;
    expect(rest).toEqual([]);
    expect(hex(pkg!.payload)).toBe(hex(A));
    expect(pkg!.phase).toBe("guaranteed");
  });

  it("upstream order → delivered B, A with ledger order 1, 0 → A || B", () => {
    const [pkg] = readPackages([part(B, 11), part(A, 10)]).packages;
    expect(pkg!.positions).toEqual([10, 11]);
    expect(hex(pkg!.payload)).toBe(hex(cat(A, B)));
  });

  it("equal distinct events → two parts A || A", () => {
    const [pkg] = readPackages([part(A, 0), part(A, 1)]).packages;
    expect(pkg!.parts).toHaveLength(2);
    expect(hex(pkg!.payload)).toBe(hex(cat(A, A)));
  });

  it("multiple logs per call → two parts A || C", () => {
    const [pkg] = readPackages([part(A, 0), part(C, 1)]).packages;
    expect(hex(pkg!.payload)).toBe(hex(cat(A, C)));
  });

  it("two intents → two packages, never joined", () => {
    const out = readPackages([part(A, 0, { segment: 7 }), part(B, 1, { segment: 8 })]).packages;
    expect(out.map((p) => [p.segment, hex(p.payload)])).toEqual([[7, hex(A)], [8, hex(B)]]);
  });

  it("repeated publication → (T1, 7) and (T2, 7) each A → two packages despite equal bytes", () => {
    const out = readPackages([part(A, 0, { tx: T1 }), part(A, 1, { tx: T2 })]).packages;
    expect(out.map((p) => [p.transactionHash, p.segment, hex(p.payload)])).toEqual([
      [T1, 7, hex(A)], [T2, 7, hex(A)],
    ]);
  });

  it("no hidden framing → A and C intended separately in one intent → one package A || C", () => {
    const out = readPackages([part(A, 0), part(C, 1)]).packages;
    expect(out).toHaveLength(1);
    expect(hex(out[0]!.payload)).toBe(hex(cat(A, C)));
  });
});

describe("multi-part reader — its own boundaries", () => {
  it("opts in exactly the standard's name — never the superseded draft name — and groups every contract on its own", () => {
    expect(MULTIPART_OPT_INS).toEqual([MIP_0018_NAME_HEX]);
    expect(MULTIPART_OPT_INS).not.toContain(LEGACY_NAME_HEX);
    const other = "d0".repeat(32);
    const out = readPackages([
      part(A, 0), part(C, 1, { contract: other }), part(B, 2), part(A, 3, { network: "stagenet" }),
    ]).packages;
    expect(out.map((p) => [p.network, p.contract, hex(p.payload)])).toEqual([
      ["stagenet", CONTRACT, hex(A)],
      [NET, CONTRACT, hex(cat(A, B))],
      [NET, other, hex(C)],
    ]);
    // A network filter leaves the other network's events alone.
    expect(readPackages([part(A, 0), part(A, 1, { network: "stagenet" })], { network: NET }))
      .toMatchObject({ ignored: 1, packages: [{ network: NET }] });
  });

  it("a test configuration may opt in another name (the recorded [Y] Stagenet example)", () => {
    const example = Buffer.from(pad32("example:message[v1]")).toString("hex");
    const events = [part(A, 0, { nameHex: example }), part(C, 1, { nameHex: example })];
    expect(readPackages(events).packages).toEqual([]);
    const [pkg] = readPackages(events, { optIns: [example] }).packages;
    expect(hex(pkg!.payload)).toBe(hex(cat(A, C)));
    expect(createHash("sha256").update(pkg!.payload).digest("hex")).toHaveLength(64);
  });

  it("an identical redelivery of one identity is tolerated; the same identity with two contents stops the lookup", () => {
    const [pkg] = readPackages([part(A, 0), part(C, 1), part(A, 0)]).packages;
    expect(pkg!.positions).toEqual([0, 1]);
    expect(hex(pkg!.payload)).toBe(hex(cat(A, C)));
    expect(() => readPackages([part(A, 0), part(C, 0)])).toThrow(PackageReadError);
    try {
      readPackages([part(A, 0), part(A, 0, { phase: "fallible" })]);
      expect.unreachable();
    } catch (error) {
      expect((error as PackageReadError).reason).toBe("conflicting_delivery");
    }
  });

  it("accepts a package at the 1 024-part safety ceiling whole, and refuses one part more as an error — never a truncation", () => {
    const events = Array.from({ length: MAX_PACKAGE_PARTS }, (_v, i) => part(C, i));
    const [pkg] = readPackages(events).packages;
    expect(pkg!.parts).toHaveLength(1024);
    expect(pkg!.payload).toHaveLength(1024 * 256);
    const over = [...events, part(C, MAX_PACKAGE_PARTS)];
    expect(() => readPackages(over)).toThrow(/safety ceiling/);
    try {
      readPackages(over);
    } catch (error) {
      expect((error as PackageReadError).reason).toBe("part_ceiling");
    }
  });

  it("refuses a part longer than 256 bytes and a source field outside [Y]'s input", () => {
    expect(() => restorePart(new Uint8Array(257))).toThrow(PackageReadError);
    expect(() => readPackages([part(new Uint8Array(257), 0)])).toThrow(/at most 256/);
    expect(() => readPackages([part(A, 0, { segment: 0 })])).toThrow(/segment 0/);
    expect(() => readPackages([part(A, -1)])).toThrow(/non-negative/);
    expect(() => readPackages([part(A, 0, { tx: "" })])).toThrow(/empty network or transaction/);
  });
});
