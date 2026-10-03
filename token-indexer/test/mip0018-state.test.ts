/**
 * UmbraDB's MIP-0018 state rules (MIP PR #340 head `274a84f`), beyond what the vectors cover: per-key tombstones at row
 * level, "not referenced at all", chain order, rollback, common fields, display and the mark.
 */
import { describe, expect, it } from "vitest";
import { EVENT_NAME, encodePayload, type MetadataRecord, record } from "../vendor/mip0018/codec/src/index.ts";
import {
  ChainOrderError,
  COMMON_KEY_HEX,
  fieldUsable,
  formatAmount,
  MetadataState,
  parseStandards,
  recordEffects,
  tokenMark,
  toHex,
  type IdentityRef,
  UNRESOLVED_LOG_REASON,
} from "../mip0018/state.ts";

const NET = "testnet-a";
const A = "aa".repeat(32);
const B = "bb".repeat(32);
const DS1 = "11".repeat(32);
const DS2 = "22".repeat(32);
const DS3 = "33".repeat(32);
const ds = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, "hex"));
const ref = (kind: number, domainSep = DS1, contractAddress = A): IdentityRef => ({ network: NET, contractAddress, domainSep, kind });
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function emitter(state: MetadataState) {
  let block = 0;
  return (kind: number, records: MetadataRecord[], opts: { domainSep?: string; contract?: string; payload?: Uint8Array } = {}) =>
    state.apply({
      network: NET,
      position: { block: ++block, tx: 0, event: 0 },
      contractAddress: opts.contract ?? A,
      type: "Misc",
      name: EVENT_NAME,
      payload: opts.payload ?? encodePayload({ domainSep: ds(opts.domainSep ?? DS1), kind }, records),
    });
}

const keys = (s: MetadataState, r: IdentityRef): string[] =>
  [...(s.identity(r)?.fields.keys() ?? [])].map((k) => Buffer.from(k, "hex").toString("utf8"));

describe("per-key tombstones (MIP 274a84f Applying records)", () => {
  it("[[mip0018.state.per-key-tombstone]] a Null deletes only its key; a Null for a missing key is a no-op; deleting every key withdraws the identity everywhere; a later record revives only that field", () => {
    const s = new MetadataState();
    const emit = emitter(s);
    emit(1, [record.utf8("name", "Gold"), record.utf8("symbol", "ACME"), record.uint("decimals", 6), record.utf8("standards", "mip-0011")]);
    emit(1, [record.utf8("name", "Two"), record.utf8("symbol", "ACME")], { domainSep: DS2 });
    emit(1, [record.utf8("symbol", "ACME")], { domainSep: DS3 }); // a third member: the group outlives one member's Null
    expect(s.groups()).toHaveLength(1);
    expect(s.groups()[0]!.members).toHaveLength(3);

    emit(1, [record.tombstone("name")]);
    expect(keys(s, ref(1))).toEqual(["symbol", "decimals", "standards"]);

    emit(1, [record.tombstone("retire"), record.tombstone("name")]);
    expect(keys(s, ref(1))).toEqual(["symbol", "decimals", "standards"]);

    emit(1, [record.tombstone("symbol")]);
    // A Null at its symbol removes ONLY that member from the group (S9); the two others keep it.
    expect(s.groups().map((g) => g.members)).toEqual([[{ domainSep: DS2, kind: 1 }, { domainSep: DS3, kind: 1 }]]);

    const held = s.identity(ref(1))!.fields; // a snapshot: later events never change it
    emit(1, [record.tombstone("decimals"), record.tombstone("standards")]);
    expect(held.size).toBe(2);
    expect(s.identity(ref(1))).toBeUndefined();
    expect(s.identities().map((i) => i.domainSep)).toEqual([DS2, DS3]);
    expect(s.display(ref(1), 100n)).toBeUndefined();
    expect(JSON.stringify(s.identities())).not.toContain(DS1);

    emit(1, [record.utf8("name", "New")]);
    expect(keys(s, ref(1))).toEqual(["name"]);
    expect(Buffer.from(s.identity(ref(1))!.fields.get(COMMON_KEY_HEX.name)!.value).toString()).toBe("New");
  });

  it("records apply in order within one event, and a non-Null record replaces the value without history", () => {
    const s = new MetadataState();
    const emit = emitter(s);
    emit(3, [record.utf8("name", "A"), record.tombstone("name"), record.utf8("name", "B"), record.utf8("symbol", "X"), record.utf8("symbol", "Y")]);
    const id = s.identity(ref(3))!;
    expect([...id.fields.keys()]).toEqual([COMMON_KEY_HEX.name, COMMON_KEY_HEX.symbol]);
    expect(Buffer.from(id.fields.get(COMMON_KEY_HEX.symbol)!.value).toString()).toBe("Y");
    expect(id.fields.get(COMMON_KEY_HEX.symbol)!.position).toEqual({ block: 1, tx: 0, event: 0, record: 4 });
  });

  it("an event of one contract never touches another contract's identity with the same header", () => {
    const s = new MetadataState();
    const emit = emitter(s);
    emit(3, [record.utf8("name", "Mine")]);
    emit(3, [record.tombstone("name")], { contract: B });
    expect(keys(s, ref(3))).toEqual(["name"]);
    expect(s.identity(ref(3, DS1, B))).toBeUndefined();
  });

  it("a rejected event applies none of its records and is stored as the contract's rejection", () => {
    const s = new MetadataState();
    const emit = emitter(s);
    emit(3, [record.utf8("name", "Kept")]);
    const bad = encodePayload({ domainSep: ds(DS1), kind: 3 }, [record.tombstone("name")]);
    bad[38] = 6; // the Null record's valType byte → reserved valType 6
    expect(emit(3, [], { payload: bad }).result).toBe("reject");
    expect(keys(s, ref(3))).toEqual(["name"]);
    expect(s.rejections(NET, A)).toEqual([{ position: { block: 2, tx: 0, event: 0 }, reason: "reserved-valtype" }]);
    expect(s.hasEvents(NET, A)).toBe(true);
    expect(s.hasEvents(NET, B)).toBe(false);
  });

  it("refuses events that do not follow the previous one on their network, and recomputes after a rollback", () => {
    const s = new MetadataState();
    const at = (block: number, records: MetadataRecord[]) =>
      s.apply({ network: NET, position: { block, tx: 0, event: 0 }, contractAddress: A, type: "Misc", name: EVENT_NAME, payload: encodePayload({ domainSep: ds(DS1), kind: 3 }, records) });
    at(1, [record.utf8("name", "One"), record.utf8("symbol", "ONE")]);
    at(2, [record.tombstone("name"), record.tombstone("symbol")]);
    expect(s.identity(ref(3))).toBeUndefined();
    expect(() => at(2, [record.utf8("name", "x")])).toThrow(ChainOrderError);
    s.rollbackTo(NET, 1);
    expect(keys(s, ref(3))).toEqual(["name", "symbol"]);
    expect(() => at(1, [record.utf8("name", "x")])).toThrow(ChainOrderError);
    at(2, [record.tombstone("symbol")]);
    expect(keys(s, ref(3))).toEqual(["name"]);
  });
});

describe("common fields (MIP 274a84f Common fields)", () => {
  it("usable forms, no fallback to an earlier usable value, no defaults", () => {
    expect(fieldUsable(COMMON_KEY_HEX.name, 1, enc("Acme"))).toBe(true);
    expect(fieldUsable(COMMON_KEY_HEX.name, 1, enc(""))).toBe(false);
    expect(fieldUsable(COMMON_KEY_HEX.symbol, 0, enc("ACME"))).toBe(false);
    expect(fieldUsable(COMMON_KEY_HEX.decimals, 2, Uint8Array.of(6))).toBe(true);
    expect(fieldUsable(COMMON_KEY_HEX.decimals, 1, enc("6"))).toBe(false);
    expect(fieldUsable(COMMON_KEY_HEX.standards, 1, enc(""))).toBe(true);
    expect(fieldUsable(toHex(enc("SYMBOL")), 1, enc("ACME"))).toBeUndefined();

    const s = new MetadataState();
    const emit = emitter(s);
    emit(3, [record.utf8("name", "Good"), record.uint("decimals", 6)]);
    emit(3, [record.utf8("name", ""), record.utf8("decimals", "6")]);
    const f = s.identity(ref(3))!.fields;
    expect(f.get(COMMON_KEY_HEX.name)!.usable).toBe(false);
    expect(f.get(COMMON_KEY_HEX.decimals)!.usable).toBe(false);
    expect(s.display(ref(3), 123456n)).toBeUndefined(); // no default decimals
  });

  it("standards: single-space separated identifiers without control bytes; empty claims nothing; malformed is unusable", () => {
    expect(parseStandards(enc(""))).toEqual([]);
    expect(parseStandards(enc("mip-0004 mip-0004 erc-20"))).toEqual(["mip-0004", "mip-0004", "erc-20"]);
    expect(parseStandards(enc("mip-0004  mip-0011"))).toBeUndefined();
    expect(parseStandards(enc(" mip-0004"))).toBeUndefined();
    expect(parseStandards(enc("mip-0004 "))).toBeUndefined();
    expect(parseStandards(enc("mip-0004\tmip-0011"))).toBeUndefined();
    expect(parseStandards(enc("a\u007fb"))).toBeUndefined();
    expect(parseStandards(enc("x y x\u0085y"))).toEqual(["x y", "x\u0085y"]);
  });

  it("formatAmount is exact for every width and bounded for absurd decimals", () => {
    expect(formatAmount(123456n, 2n)).toBe("1234.56");
    expect(formatAmount(1234567n, 6n)).toBe("1.234567");
    expect(formatAmount(5n, 3n)).toBe("0.005");
    expect(formatAmount(100n, 2n)).toBe("1.00");
    expect(formatAmount(7n, 0n)).toBe("7");
    const max = (1n << 248n) - 1n;
    expect(formatAmount(max, 0n)).toBe(max.toString());
    expect(formatAmount(1n, 1000n)).toBe(`0.${"0".repeat(999)}1`);
    expect(formatAmount(42n, max)).toBe(`42e-${max.toString()}`);
  });

  it("recordEffects keeps 31-byte integers lossless and marks only common keys", () => {
    const max = (1n << 248n) - 1n;
    const effects = recordEffects([
      { key: enc("decimals"), valType: 2, value: new Uint8Array(31).fill(0xff), offset: 33, integer: max },
      { key: Uint8Array.of(0xff, 0x6b), valType: 0, value: Uint8Array.of(1, 0, 0), offset: 70 },
      { key: enc("symbol\u0000"), valType: 5, value: new Uint8Array(0), offset: 76 },
    ]);
    expect(effects[0]).toMatchObject({ op: "set", integer: max, usable: true, record: 0 });
    expect(effects[1]).toMatchObject({ op: "set", keyHex: "ff6b", record: 1 });
    expect("usable" in (effects[1] as object)).toBe(false);
    expect(effects[2]).toMatchObject({ op: "delete", keyHex: "73796d626f6c00", record: 2 });
  });
});

describe("marks (one function)", () => {
  const fieldsOf = (s: MetadataState, r: IdentityRef) => s.identity(r)?.fields;

  it("[[mip0018.state.marks]] ✓ complete, ⚠ partial, ⚠ incorrect (contract rejection, reasons shown), ⚠ unresolved (the contract has unresolved logs: reason unresolved-log, never a clean ✓), no mark without events or after withdrawal; usable standards as tags", () => {
    const s = new MetadataState();
    const emit = emitter(s);
    emit(3, [record.utf8("name", "Acme"), record.utf8("symbol", "ACME"), record.uint("decimals", 6), record.utf8("standards", "mip-0004 mip-0004 x")]);
    expect(tokenMark({ fields: fieldsOf(s, ref(3)), contractRejections: [] })).toEqual({ mark: "ok", reasons: [], missing: [], tags: ["mip-0004", "x"] });

    emit(3, [record.utf8("name", "Half")], { domainSep: DS2 });
    expect(tokenMark({ fields: fieldsOf(s, ref(3, DS2)), contractRejections: [] })).toMatchObject({ mark: "partial", missing: ["symbol", "decimals"] });

    emit(3, [record.utf8("symbol", "")], { domainSep: DS2 });
    expect(tokenMark({ fields: fieldsOf(s, ref(3, DS2)), contractRejections: [] }).missing).toEqual(["symbol", "decimals"]);

    expect(tokenMark({ fields: fieldsOf(s, ref(3)), contractRejections: ["reserved-valtype", "invalid-utf8"] })).toEqual({
      mark: "incorrect",
      reasons: ["reserved-valtype", "invalid-utf8"],
      missing: [],
      tags: ["mip-0004", "x"],
    });
    expect(tokenMark({ fields: undefined, contractRejections: ["no-records"] }).mark).toBe("incorrect");

    expect(tokenMark({ fields: undefined, contractRejections: [] })).toEqual({ mark: "none", reasons: [], missing: [], tags: [] });

    emit(3, [record.tombstone("name"), record.tombstone("symbol"), record.tombstone("decimals"), record.tombstone("standards")]);
    expect(tokenMark({ fields: fieldsOf(s, ref(3)), contractRejections: [] }).mark).toBe("none");

    emit(3, [record.utf8("standards", "mip-0004  x")]);
    expect(tokenMark({ fields: fieldsOf(s, ref(3)), contractRejections: [] })).toMatchObject({ mark: "partial", tags: [] });

    // Unresolved logs of the contract — ⚠ unresolved for a complete, a partial and an absent
    // identity (the unresolved log may have described, renamed or withdrawn it); ⚠ incorrect wins, its reasons end with
    // `unresolved-log`; zero unresolved logs change nothing.
    expect(tokenMark({ fields: fieldsOf(s, ref(3, DS2)), contractRejections: [], contractUnresolvedLogs: 0 }).mark).toBe("partial");
    emit(3, [record.utf8("name", "Acme"), record.utf8("symbol", "ACME"), record.uint("decimals", 6)], { domainSep: DS3 });
    expect(tokenMark({ fields: fieldsOf(s, ref(3, DS3)), contractRejections: [] }).mark).toBe("ok");
    expect(tokenMark({ fields: fieldsOf(s, ref(3, DS3)), contractRejections: [], contractUnresolvedLogs: 2 }))
      .toEqual({ mark: "unresolved", reasons: [UNRESOLVED_LOG_REASON], missing: [], tags: [] });
    expect(tokenMark({ fields: fieldsOf(s, ref(3, DS2)), contractRejections: [], contractUnresolvedLogs: 1 }))
      .toEqual({ mark: "unresolved", reasons: ["unresolved-log"], missing: ["symbol", "decimals"], tags: [] });
    expect(tokenMark({ fields: undefined, contractRejections: [], contractUnresolvedLogs: 1 }))
      .toEqual({ mark: "unresolved", reasons: ["unresolved-log"], missing: [], tags: [] });
    expect(tokenMark({ fields: fieldsOf(s, ref(3, DS3)), contractRejections: ["no-records"], contractUnresolvedLogs: 1 }))
      .toEqual({ mark: "incorrect", reasons: ["no-records", "unresolved-log"], missing: [], tags: [] });
  });

  it("[[mip0018.state.marks-current-state]] a withdrawn identity is marked exactly like one never described (current state only): ⚠ incorrect from its contract's rejections, otherwise none; an empty field map is the same as none", () => {
    const s = new MetadataState();
    const emit = emitter(s);
    emit(3, [record.utf8("name", "Gone"), record.utf8("symbol", "GONE"), record.uint("decimals", 2), record.utf8("standards", "mip-0004")]);
    emit(3, [record.tombstone("name"), record.tombstone("symbol"), record.tombstone("decimals"), record.tombstone("standards")]);
    const withdrawn = fieldsOf(s, ref(3));
    const never = fieldsOf(s, ref(3, DS3));
    expect(withdrawn).toBeUndefined();
    expect(never).toBeUndefined();
    for (const rejections of [[], ["reserved-valtype"]]) {
      const forms = [withdrawn, never, new Map()].map((fields) => tokenMark({ fields, contractRejections: rejections }));
      expect(forms[0]).toEqual(rejections.length === 0
        ? { mark: "none", reasons: [], missing: [], tags: [] }
        : { mark: "incorrect", reasons: ["reserved-valtype"], missing: [], tags: [] });
      expect(forms[1]).toEqual(forms[0]);
      expect(forms[2]).toEqual(forms[0]);
    }
  });
});
