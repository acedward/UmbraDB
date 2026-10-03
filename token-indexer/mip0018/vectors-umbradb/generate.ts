#!/usr/bin/env node
/**
 * Generates UmbraDB's own versions of the eight MIP-0018 state vectors whose Testing text differs between the vendored
 * reference vectors (MIP PR #340 @ `78ecbb4`, whole-identity tombstones) and the MIP text UmbraDB implements
 * (PR #340 head `274a84f`, per-key tombstones): S1a, S3a, S3b, S3c, S3d, S4a, S4b, S9d.
 *
 *   node token-indexer/mip0018/vectors-umbradb/generate.ts           # write state/*.json, manifest.json, SHA256SUMS
 *   node token-indexer/mip0018/vectors-umbradb/generate.ts --check   # fail on any difference (CI)
 *
 * Same JSON format and runner contract as the vendored vectors (`token-indexer/vendor/mip0018/vectors/README.md`),
 * so the vendored runner runs them with `--dir`. Like the reference generator, this file is an independent oracle:
 * payloads are built by explicit byte arithmetic and every expectation is written by hand from the `274a84f` Testing
 * text — nothing is imported from the codec or from UmbraDB's state module. S9d starts from the vendored S9a
 * (its steps and its hand-written expectation), as the MIP's S9 sentences build on one another.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDORED = join(HERE, "..", "..", "vendor", "mip0018", "vectors");

type Json = Record<string, unknown>;

/** The MIP text these vectors implement. */
const MIP = {
  id: "MIP-0018",
  repository: "midnightntwrk/midnight-improvement-proposals",
  commit: "274a84f221bcfc17e4b73e2c8b32fd8c028ea092",
  path: "mips/mip-0018-on-chain-token-metadata.md",
  sha256: "e64fe1429b9f7589077f1323572cf5c3ffa90c7c96690242a9e76d2658058d8b",
  url: "https://github.com/midnightntwrk/midnight-improvement-proposals/blob/274a84f221bcfc17e4b73e2c8b32fd8c028ea092/mips/mip-0018-on-chain-token-metadata.md",
  pr: "https://github.com/midnightntwrk/midnight-improvement-proposals/pull/340",
};
const BASIS =
  "UmbraDB's own version: written from the Testing text of MIP-0018 PR #340 head 274a84f (per-key tombstones); the vendored reference vector of the same id implements 78ecbb4 (whole-identity tombstones).";

const NAME_HEX = "6d69702d303031383a746f6b656e2d6d657461646174615b76315d0000000000";
const A = "aa".repeat(32);
const DS1 = "11".repeat(32);
const NET = "testnet-a";

const enc = new TextEncoder();
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const utf8Hex = (s: string): string => hex(enc.encode(s));

/** One record: key text, valType, value bytes (hex). */
type Rec = [key: string, valType: number, valueHex: string];
const utf8 = (key: string, value: string): Rec => [key, 1, utf8Hex(value)];
const uint8 = (key: string, value: number): Rec => [key, 2, value.toString(16).padStart(2, "0")];
const nul = (key: string): Rec => [key, 5, ""];

/** header (domainSep ‖ kind) ‖ records ‖ zero padding to 256 bytes; returns the payload hex and each record's offset. */
function payload(domainSepHex: string, kind: number, recs: Rec[]): { hex: string; offsets: number[] } {
  const bytes = new Uint8Array(256);
  let at = 0;
  const put = (b: number): void => {
    if (at >= 256) throw new Error("payload longer than 256 bytes");
    bytes[at++] = b;
  };
  for (let i = 0; i < 64; i += 2) put(Number.parseInt(domainSepHex.slice(i, i + 2), 16));
  put(kind);
  const offsets: number[] = [];
  for (const [key, valType, valueHex] of recs) {
    offsets.push(at);
    const k = enc.encode(key);
    put(k.length);
    for (const b of k) put(b);
    put(valType);
    put(valueHex.length / 2);
    for (let i = 0; i < valueHex.length; i += 2) put(Number.parseInt(valueHex.slice(i, i + 2), 16));
  }
  return { hex: hex(bytes), offsets };
}

function apply(block: number, tx: number, event: number, kind: number, recs: Rec[]): Json {
  return {
    op: "apply",
    network: NET,
    block,
    tx,
    event,
    contractAddress: A,
    type: "Misc",
    name_hex: NAME_HEX,
    payload_hex: payload(DS1, kind, recs).hex,
  };
}

/** An expected field of a common key (`usable` is given for the four common keys, as in the reference vectors). */
function textField(key: string, value: string, usable: boolean): [string, Json] {
  return [utf8Hex(key), { key_text: key, valType: 1, value_hex: utf8Hex(value), value_text: value, usable }];
}
function uintField(key: string, value: number, usable: boolean): [string, Json] {
  return [utf8Hex(key), { key_text: key, valType: 2, value_hex: value.toString(16).padStart(2, "0"), usable }];
}
function identity(kind: number, fields: Array<[string, Json]>): Json {
  return { network: NET, contractAddress: A, domainSep: DS1, kind, visible: true, fields: Object.fromEntries(fields) };
}

// The S3 publication: name, symbol, decimals and standards for kinds 1 and 3 under one domainSep (block 1).
const PUBLISH_1 = apply(1, 0, 0, 1, [utf8("name", "Gold"), utf8("symbol", "GLD"), uint8("decimals", 6), utf8("standards", "mip-0011")]);
const PUBLISH_3 = apply(1, 0, 1, 3, [utf8("name", "Gold"), utf8("symbol", "GLD"), uint8("decimals", 6), utf8("standards", "mip-0004")]);
const NULL_NAME_1 = apply(2, 0, 0, 1, [nul("name")]);
const NULL_NAME_AGAIN_1 = apply(3, 0, 0, 1, [nul("name")]);
const NULL_RETIRE_1 = apply(4, 0, 0, 1, [nul("retire")]);
const NULL_REST_1 = apply(5, 0, 0, 1, [nul("symbol"), nul("decimals"), nul("standards")]);
const REVIVE_1 = apply(6, 0, 0, 1, [utf8("name", "New")]);

const KIND3_UNCHANGED = identity(3, [
  textField("name", "Gold", true),
  textField("symbol", "GLD", true),
  uintField("decimals", 6, true),
  textField("standards", "mip-0004", true),
]);
const KIND1_WITHOUT_NAME = identity(1, [textField("symbol", "GLD", true), uintField("decimals", 6, true), textField("standards", "mip-0011", true)]);
/**
 * MIP S9 ("Kinds 1 and 3 of one contract with symbol = "ACME" form one group"): while kinds 1 and 3 both carry the
 * usable symbol "GLD", they are one group. When kind 1 has no fields (S3c, S3d — whose kind 1 has no
 * symbol —, S4b) there is no group of two or more; the vendored comparer cannot compare an empty group list without
 * marking it not applicable, so those three state the absence through their identities and the vector test asserts
 * the adapter's empty group list directly.
 */
const GLD_GROUP = {
  network: NET,
  contractAddress: A,
  symbol_hex: utf8Hex("GLD"),
  symbol_text: "GLD",
  members: [{ domainSep: DS1, kind: 1 }, { domainSep: DS1, kind: 3 }],
};

function vector(id: string, testId: string, description: string, steps: Json[], expect: Json): Json {
  return { id, mip: { commit: MIP.commit, testId }, normative: true, description, basis: BASIS, steps, expect };
}

function s1a(): Json {
  const recs = [utf8("name", "A"), nul("name"), utf8("name", "B")];
  const { offsets } = payload(DS1, 1, recs);
  if (offsets.join("/") !== "33/41/48") throw new Error(`S1 offsets ${offsets.join("/")} differ from the MIP's 33/41/48`);
  return vector(
    "S1a",
    "S1",
    'Order within an event (MIP 274a84f S1): for kind 1, name = "A" (33), a Null record at key "name" (41) and name = "B" (48) leave the identity with only name = "B".',
    [apply(1, 0, 0, 1, recs)],
    { identities: [identity(1, [textField("name", "B", true)])] },
  );
}

function s9d(): Json {
  const s9a = JSON.parse(readFileSync(join(VENDORED, "state", "S9a.json"), "utf8")) as Json;
  const steps = [...(s9a.steps as Json[])];
  const nullSymbol = apply(2, 0, 0, 3, [nul("symbol")]);
  steps.push(nullSymbol);
  const expect = JSON.parse(JSON.stringify(s9a.expect)) as { identities: Json[]; groups: Json[] };
  const symbolHex = utf8Hex("symbol");
  let touched = 0;
  for (const i of expect.identities) {
    if (i.network === NET && i.contractAddress === A && i.domainSep === DS1 && i.kind === 3) {
      delete (i.fields as Json)[symbolHex];
      touched++;
    }
  }
  for (const g of expect.groups) {
    if (g.network === NET && g.contractAddress === A && g.symbol_hex === utf8Hex("ACME")) {
      const before = (g.members as Json[]).length;
      g.members = (g.members as Json[]).filter((m) => !(m.domainSep === DS1 && m.kind === 3));
      touched += before - (g.members as Json[]).length;
    }
  }
  if (touched !== 2) throw new Error(`S9d: expected to change one identity and one group membership, changed ${touched}`);
  return vector(
    "S9d",
    "S9",
    'Symbol grouping (MIP 274a84f S9): after S9a, a Null record at the kind-3 member\'s "symbol" (block 2) removes it from the group of contract A\'s "ACME"; that identity keeps its name and stays ungrouped.',
    steps,
    expect,
  );
}

function build(): Map<string, Json> {
  const v = new Map<string, Json>();
  v.set("S1a", s1a());
  v.set(
    "S3a",
    vector(
      "S3a",
      "S3",
      'Tombstone (MIP 274a84f S3): name/symbol/decimals/standards for kinds 1 and 3 under one domainSep (block 1), then a Null record at key "name" for kind 1 (block 2): kind 1 keeps symbol, decimals and standards and has no name; kind 3 is unchanged; kinds 1 and 3 share the usable symbol "GLD" and form one group (S9).',
      [PUBLISH_1, PUBLISH_3, NULL_NAME_1],
      { identities: [KIND1_WITHOUT_NAME, KIND3_UNCHANGED], groups: [GLD_GROUP] },
    ),
  );
  v.set(
    "S3b",
    vector(
      "S3b",
      "S3",
      'Tombstone (MIP 274a84f S3): after S3a, a second Null at "name" (block 3) and a Null at a key with no value, "retire" (block 4), change nothing.',
      [PUBLISH_1, PUBLISH_3, NULL_NAME_1, NULL_NAME_AGAIN_1, NULL_RETIRE_1],
      { identities: [KIND1_WITHOUT_NAME, KIND3_UNCHANGED], groups: [GLD_GROUP] },
    ),
  );
  v.set(
    "S3c",
    vector(
      "S3c",
      "S3",
      "Tombstone (MIP 274a84f S3): after S3b, Null records for kind 1's remaining keys (symbol, decimals, standards) in one event (block 5) leave kind 1 with no fields, so it is not referenced anywhere (absent from the expectation); kind 3 is unchanged.",
      [PUBLISH_1, PUBLISH_3, NULL_NAME_1, NULL_NAME_AGAIN_1, NULL_RETIRE_1, NULL_REST_1],
      { identities: [KIND3_UNCHANGED] },
    ),
  );
  v.set(
    "S3d",
    vector(
      "S3d",
      "S3",
      'Tombstone (MIP 274a84f S3): after S3c, a kind-1 name = "New" (block 6) describes kind 1 again with only name; standards reads as empty (no field) and nothing from before the tombstones returns.',
      [PUBLISH_1, PUBLISH_3, NULL_NAME_1, NULL_NAME_AGAIN_1, NULL_RETIRE_1, NULL_REST_1, REVIVE_1],
      { identities: [identity(1, [textField("name", "New", true)]), KIND3_UNCHANGED] },
    ),
  );
  v.set(
    "S4a",
    vector(
      "S4a",
      "S4",
      "Reorganization (MIP 274a84f S4): S3c, then the block that deleted kind 1's last fields (block 5) is removed: those fields (symbol, decimals, standards) are restored; name stays deleted (its Null is in block 2); kinds 1 and 3 form the 'GLD' group again (S9).",
      [PUBLISH_1, PUBLISH_3, NULL_NAME_1, NULL_NAME_AGAIN_1, NULL_RETIRE_1, NULL_REST_1, { op: "rollback", network: NET, toBlock: 4 }],
      { identities: [KIND1_WITHOUT_NAME, KIND3_UNCHANGED], groups: [GLD_GROUP] },
    ),
  );
  v.set(
    "S4b",
    vector(
      "S4b",
      "S4",
      "Reorganization (MIP 274a84f S4): S4a, then block 5 is added again: kind 1's last fields are deleted again and kind 1 is not referenced anywhere; kind 3 is unchanged.",
      [
        PUBLISH_1,
        PUBLISH_3,
        NULL_NAME_1,
        NULL_NAME_AGAIN_1,
        NULL_RETIRE_1,
        NULL_REST_1,
        { op: "rollback", network: NET, toBlock: 4 },
        NULL_REST_1,
      ],
      { identities: [KIND3_UNCHANGED] },
    ),
  );
  v.set("S9d", s9d());
  return v;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const text = (j: unknown): string => `${JSON.stringify(j, null, 2)}\n`;

function render(): Map<string, string> {
  const vectors = build();
  const files = new Map<string, string>();
  const entries: Json[] = [];
  for (const [id, data] of vectors) {
    const file = `state/${id}.json`;
    files.set(file, text(data));
    entries.push({ id, kind: "state", file, testId: (data.mip as Json).testId, normative: true });
  }
  files.set(
    "manifest.json",
    text({
      format: "mip0018-vectors/1",
      mip: MIP,
      eventName: { text: "mip-0018:token-metadata[v1]", hex: NAME_HEX },
      generator: "token-indexer/mip0018/vectors-umbradb/generate.ts",
      counts: { "normative-payload": 0, "normative-state": entries.length, "informative-payload": 0, "informative-state": 0, total: entries.length },
      vectors: entries,
    }),
  );
  const sums = [...files.keys()]
    .sort()
    .map((f) => `${sha256(files.get(f) as string)}  ${f}`)
    .join("\n");
  files.set("SHA256SUMS", `${sums}\n`);
  return files;
}

function main(): number {
  const check = process.argv.includes("--check");
  const files = render();
  const stale: string[] = [];
  for (const [rel, content] of files) {
    const abs = join(HERE, rel);
    if (check) {
      let onDisk: string | undefined;
      try {
        onDisk = readFileSync(abs, "utf8");
      } catch {
        onDisk = undefined;
      }
      if (onDisk !== content) stale.push(rel);
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  }
  if (check && stale.length > 0) {
    console.error(`vectors-umbradb: out of date: ${stale.join(", ")}`);
    return 1;
  }
  console.log(`vectors-umbradb: ${check ? "checked" : "wrote"} ${files.size} files`);
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main();

export { render };
