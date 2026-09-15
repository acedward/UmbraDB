#!/usr/bin/env node
/**
 * Story 5 / SC-005: the client's state and the SDK's are the same state, or this exits 1.
 *
 *   node dust-sync-client/devnet/compare.mjs <client.json> <golden.json>
 *
 * Compares, and prints a table of, exactly what the spec names: **both Merkle roots**, the **set
 * of live UTxOs with every field**, and **`walletBalance` at the same instant**. Nothing is
 * tolerated — no rounding, no "close enough" on the balance, no ignoring a field — because every
 * one of these values is a hash or an exact integer, and a difference in any of them means the two
 * sides disagree about the chain.
 *
 * ── The one comparison that is conditional, and why ─────────────────────────────────────────
 * `balanceAt` must be equal on both sides. DUST generates continuously, so two correct states
 * priced a minute apart have different balances; comparing them would produce a failure that says
 * nothing. If the two files were priced at different instants the balance row is reported as
 * SKIPPED with both instants named, rather than being quietly compared or quietly ignored.
 *
 * Both inputs are plain JSON produced by `npm run dust:sync -- --out` and by the SDK-side scripts
 * in `devnet/sdk/`. They carry no secret: a DUST public key, roots, public UTxO fields and a
 * balance.
 */
import { readFileSync } from "node:fs";

const [, , clientPath, goldenPath] = process.argv;
if (clientPath === undefined || goldenPath === undefined) {
  process.stdout.write("usage: compare.mjs <client.json> <golden.json>\n");
  process.exit(2);
}

const client = JSON.parse(readFileSync(clientPath, "utf8"));
const golden = JSON.parse(readFileSync(goldenPath, "utf8"));

const rows = [];
let failures = 0;

function check(name, a, b, { skip = false, note = "" } = {}) {
  if (skip) {
    rows.push({ field: name, client: String(a), golden: String(b), verdict: "SKIPPED", note });
    return;
  }
  const ok = String(a) === String(b);
  if (!ok) failures += 1;
  rows.push({ field: name, client: String(a), golden: String(b), verdict: ok ? "ok" : "DIFFERENT", note });
}

check("publicKey", client.publicKey, golden.publicKey);
check("roots.commitment", client.roots?.commitment, golden.roots?.commitment);
check("roots.generation", client.roots?.generation, golden.roots?.generation);

const sameInstant = Number(client.balanceAt) === Number(golden.balanceAt);
check("balanceAt", client.balanceAt, golden.balanceAt);
check("balance", client.balance, golden.balance, {
  skip: !sameInstant,
  note: sameInstant ? "" : "priced at different instants — rerun both with the same --balance-at",
});

const clientUtxos = [...(client.utxos ?? [])].sort((a, b) => String(a.mtIndex).localeCompare(String(b.mtIndex)));
const goldenUtxos = [...(golden.utxos ?? [])].sort((a, b) => String(a.mtIndex).localeCompare(String(b.mtIndex)));
check("utxos.count", clientUtxos.length, goldenUtxos.length);

const FIELDS = ["initialValue", "owner", "nonce", "seq", "ctime", "backingNight", "mtIndex"];
for (let i = 0; i < Math.max(clientUtxos.length, goldenUtxos.length); i += 1) {
  const a = clientUtxos[i] ?? {};
  const b = goldenUtxos[i] ?? {};
  for (const field of FIELDS) check(`utxos[${i}].${field}`, a[field], b[field]);
}

const width = (key) => Math.max(...rows.map((row) => String(row[key]).length), key.length);
const widths = { field: width("field"), client: Math.min(width("client"), 44), golden: Math.min(width("golden"), 44) };
const cell = (value, size) => {
  const text = String(value);
  return (text.length > size ? `${text.slice(0, size - 1)}…` : text).padEnd(size);
};
process.stdout.write(
  `${cell("field", widths.field)}  ${cell("client", widths.client)}  ${cell("golden", widths.golden)}  verdict\n`,
);
process.stdout.write(`${"-".repeat(widths.field + widths.client + widths.golden + 16)}\n`);
for (const row of rows) {
  process.stdout.write(
    `${cell(row.field, widths.field)}  ${cell(row.client, widths.client)}  ${cell(row.golden, widths.golden)}  ` +
      `${row.verdict}${row.note === "" ? "" : `  (${row.note})`}\n`,
  );
}
process.stdout.write(
  `\n${rows.length} field(s) compared, ${failures} different, ` +
    `${rows.filter((row) => row.verdict === "SKIPPED").length} skipped\n`,
);
process.exit(failures === 0 ? 0 : 1);
