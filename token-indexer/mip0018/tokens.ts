/**
 * Read side of the scan tables (the API builds on these): the MIP's color table (`color → (contractAddress,
 * domainSep)`, kinds minted), the native tokens seen in public data or minted (a color seen before its mint is completed
 * in place — same row, now with its contract and domainSep), and the NIGHT/DUST rows. Pure queries; no writes.
 */
import { MIP0018_SCHEMA } from "../../src/postgres/migrations/mip0018/index.js";
import { hexToBytes, toHex } from "./bytes.ts";
import type { Queryable } from "./fields.ts";

export interface MintRef {
  height: number;
  txIndex: number;
  /** lowercase hex */
  txHash: string;
}

export interface ColorEntry {
  /** 32 bytes, lowercase hex */
  color: string;
  contractAddress: string;
  domainSep: string;
  /** First and count of the kind-1 (shielded) and kind-2 (unshielded) mints in the scanned range. */
  shielded?: { firstMint: MintRef; mints: number; amount: string };
  unshielded?: { firstMint: MintRef; mints: number; amount: string };
}

export type SightingEvidence = "unshielded-utxo" | "shielded-offer" | "contract-unshielded";

export interface NativeToken {
  color: string;
  /** Where the color first appeared in public data (a mint included). */
  firstSeen: MintRef;
  /** The kinds of public evidence seen so far (mints excluded). */
  evidence: SightingEvidence[];
  /** `undefined` while no mint of the color was found in the scanned range ("seen" token). */
  minted?: ColorEntry;
}

export interface BuiltinToken {
  symbol: "NIGHT" | "DUST";
  name: string;
  decimals: number;
  color: string | undefined;
  note: string;
}

const hex = toHex;
const buf = (h: string): Uint8Array => hexToBytes(h.replace(/^0x/, ""));

interface MintAgg {
  color: Uint8Array;
  contract_address: Uint8Array;
  domain_sep: Uint8Array;
  kind: number;
  mints: string;
  amount: string;
  first_height: string;
  first_tx_index: number;
  first_tx_hash: Uint8Array;
}

async function colorEntries(sql: Queryable, schema: string, network: string, color?: string): Promise<Map<string, ColorEntry>> {
  const rows = await sql<MintAgg[]>`
    SELECT DISTINCT ON (color, kind)
           color, contract_address, domain_sep, kind,
           (count(*) OVER w)::text AS mints, (sum(amount) OVER w)::text AS amount,
           block_height::text AS first_height, tx_index AS first_tx_index, tx_hash AS first_tx_hash
    FROM ${sql(schema)}.mip0018_mints
    WHERE network = ${network} ${color === undefined ? sql`` : sql`AND color = ${buf(color)}`}
    WINDOW w AS (PARTITION BY color, kind)
    ORDER BY color, kind, block_height, tx_index, mint_index`;
  const out = new Map<string, ColorEntry>();
  for (const r of rows) {
    const c = hex(r.color);
    const e = out.get(c) ?? { color: c, contractAddress: hex(r.contract_address), domainSep: hex(r.domain_sep) };
    const stats = { firstMint: { height: Number(r.first_height), txIndex: r.first_tx_index, txHash: hex(r.first_tx_hash) }, mints: Number(r.mints), amount: r.amount };
    if (r.kind === 1) e.shielded = stats;
    else e.unshielded = stats;
    out.set(c, e);
  }
  return out;
}

/** The MIP's Lookup table: every color minted in the scanned range, by color. */
export async function listColors(sql: Queryable, network: string, schema = MIP0018_SCHEMA): Promise<ColorEntry[]> {
  return [...(await colorEntries(sql, schema, network)).values()];
}

/**
 * Resolves a held color (MIP "Lookup"): the (contract, domainSep) that minted it, and the kinds minted. The kind of a
 * holding is what the user holds (a shielded coin → kind 1, an unshielded UTXO → kind 2), not the color.
 * `found: false` = not minted in the scanned range.
 */
export async function lookupColor(sql: Queryable, network: string, color: string, schema = MIP0018_SCHEMA): Promise<{ found: boolean; entry?: ColorEntry }> {
  const entry = (await colorEntries(sql, schema, network, color.toLowerCase())).get(color.replace(/^0x/, "").toLowerCase());
  return entry === undefined ? { found: false } : { found: true, entry };
}

/** Every native token color seen in public data or minted, ordered by first appearance. */
export async function nativeTokens(sql: Queryable, network: string, schema = MIP0018_SCHEMA): Promise<NativeToken[]> {
  const rows = await sql<{ color: Uint8Array; block_height: bigint; tx_index: number; tx_hash: Uint8Array; evidence: string | null }[]>`
    SELECT color, block_height, tx_index, tx_hash, evidence FROM ${sql(schema)}.mip0018_color_sightings WHERE network = ${network}
    UNION ALL
    SELECT color, block_height, tx_index, tx_hash, NULL FROM ${sql(schema)}.mip0018_mints WHERE network = ${network}
    ORDER BY block_height, tx_index, color`;
  const colors = await colorEntries(sql, schema, network);
  const out = new Map<string, NativeToken>();
  for (const r of rows) {
    const c = hex(r.color);
    const t = out.get(c) ?? { color: c, firstSeen: { height: Number(r.block_height), txIndex: r.tx_index, txHash: hex(r.tx_hash) }, evidence: [] };
    if (r.evidence !== null && !t.evidence.includes(r.evidence as SightingEvidence)) t.evidence.push(r.evidence as SightingEvidence);
    const minted = colors.get(c);
    if (minted !== undefined) t.minted = minted;
    out.set(c, t);
  }
  for (const t of out.values()) t.evidence.sort();
  return [...out.values()];
}

/** NIGHT and DUST (outside MIP-0018; seeded per network by the scanner). */
export async function builtinTokens(sql: Queryable, network: string, schema = MIP0018_SCHEMA): Promise<BuiltinToken[]> {
  const rows = await sql<{ symbol: "NIGHT" | "DUST"; name: string; decimals: number; color: Uint8Array | null; note: string }[]>`
    SELECT symbol, name, decimals, color, note FROM ${sql(schema)}.mip0018_builtin_tokens
    WHERE network = ${network} ORDER BY CASE symbol WHEN 'NIGHT' THEN 0 ELSE 1 END`;
  return rows.map((r) => ({ symbol: r.symbol, name: r.name, decimals: r.decimals, color: r.color === null ? undefined : hex(r.color), note: r.note }));
}
