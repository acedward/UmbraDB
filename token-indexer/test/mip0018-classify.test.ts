/**
 * UmbraDB's classification wrapper (`mip0018/classify.ts`): MIP-0018 "Keys MUST be valid UTF-8" (Testing R5: invalid
 * UTF-8 in a key rejects the whole event) on top of the vendored codec, which checks UTF-8 for values only.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classifyMip0018Event, isUtf8 } from "../mip0018/classify.ts";
import { MetadataState } from "../mip0018/state.ts";
import { classifyEvent, EVENT_NAME, encodePayload, type MetadataRecord, record } from "../vendor/mip0018/codec/src/index.ts";

const DS = new Uint8Array(32).fill(0x11);
const misc = (records: MetadataRecord[]) => ({ type: "Misc", name: EVENT_NAME, payload: encodePayload({ domainSep: DS, kind: 3 }, records) });
const hex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));

describe("MIP-0018 classification: keys MUST be valid UTF-8", () => {
  it("[[mip0018.classify.utf8-keys]] a non-UTF-8 key rejects the whole event (invalid-utf8 at that record) where the vendored codec alone accepts it; NUL and multi-byte keys stay accepted; the codec's own rejections pass through unchanged; every UmbraDB path classifies through the wrapper", () => {
    // The vendored codec accepts a non-UTF-8 key (it checks values only): the negative control the wrapper exists for.
    // A re-vendored codec that enforces the rule fails this line — then the wrapper's own check can go.
    const one = misc([record.utf8(hex("ff6b6579"), "ok")]);
    expect(classifyEvent(one).result).toBe("accept");
    expect(classifyMip0018Event(one)).toEqual({ result: "reject", reason: "invalid-utf8", offset: 33 });

    // Whole event: a valid record before the bad key is not applied either; the offset is the bad record's.
    const two = misc([record.utf8("name", "Acme"), record.utf8(hex("6e616d65ff"), "x")]);
    expect(classifyEvent(two).result).toBe("accept");
    expect(classifyMip0018Event(two)).toEqual({ result: "reject", reason: "invalid-utf8", offset: 33 + 1 + 4 + 2 + 4 });
    const s = new MetadataState();
    s.apply({ network: "n", position: { block: 1, tx: 0, event: 0 }, contractAddress: "aa".repeat(32), ...two });
    expect(s.identities()).toEqual([]);
    expect(s.rejections("n", "aa".repeat(32)).map((r) => r.reason)).toEqual(["invalid-utf8"]);

    // Ill-formed UTF-8 of every kind is refused; well-formed keys (NUL inside, multi-byte, 4-byte) are not.
    for (const bad of ["c0af", "eda080", "f4908080", "e282", "80", "ff"]) {
      expect(isUtf8(hex(bad)), bad).toBe(false);
      expect(classifyMip0018Event(misc([record.utf8(hex(bad), "v")])).result, bad).toBe("reject");
    }
    for (const good of ["73796d626f6c00", "00", "c3a9", "e282ac", "f09f988e", "efbbbf6b"]) {
      expect(isUtf8(hex(good)), good).toBe(true);
      expect(classifyMip0018Event(misc([record.utf8(hex(good), "v")])).result, good).toBe("accept");
    }

    // The codec's own result is returned unchanged when it does not accept (here: a reserved value type after the bad
    // key — the codec rejects first), and ignored events stay ignored.
    const reserved = encodePayload({ domainSep: DS, kind: 3 }, [record.utf8(hex("ff"), "v")]);
    const end = 33 + 1 + 1 + 2 + 1; // after the first record
    const withReserved = Uint8Array.from(reserved);
    withReserved.set([1, 0x6b, 9, 0], end); // key "k", valType 9 (reserved), valLen 0
    expect(classifyMip0018Event({ type: "Misc", name: EVENT_NAME, payload: withReserved })).toEqual(classifyEvent({ type: "Misc", name: EVENT_NAME, payload: withReserved }));
    expect(classifyMip0018Event({ type: "Misc", name: EVENT_NAME, payload: withReserved }).result).toBe("reject");
    expect(classifyMip0018Event({ ...one, type: "Contract" })).toEqual({ result: "ignore", reason: "not-misc" });

    // Every UmbraDB path classifies through the wrapper: no other module calls the codec's classifyEvent.
    const dir = join(fileURLToPath(new URL("../mip0018/", import.meta.url)));
    const callers = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "classify.ts")
      .filter((f) => /\bclassifyEvent\b/.test(readFileSync(join(dir, f), "utf8")));
    expect(callers).toEqual([]);
    for (const f of ["scan.ts", "fields.ts", "state.ts", "vector-adapter.ts", "vector-adapter-pg.ts"])
      expect(readFileSync(join(dir, f), "utf8"), f).toContain("classifyMip0018Event(");
  });
});
