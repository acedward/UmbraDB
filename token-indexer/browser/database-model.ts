/**
 * What the Database tab (`database-view.ts`) shows, computed from the engine's answers with no DOM: the summary of the
 * store's tables (`tables`), a table's line in the picker, and a page of rows (`rows`): its caption, its order, and each
 * value as text — `NULL`; a `bytea` value as the hex of its first {@link CELL_HEX_BYTES} bytes, `…` when it has more,
 * and its length; any other value as its first {@link CELL_CHARS} characters, `…` and its length in characters when it
 * is longer — with what the engine sent of the value (up to 16 bytes, up to 256 characters) in the tooltip when the cell
 * shows less. The page draws every value with the explorer's hidden-character rules (`visible-text.ts`).
 */
import type { Cell, RowsResult, TableEntry, TablesResult } from "./protocol.ts";
import { formatBytes } from "./panel-model.ts";
import { countText } from "./system-model.ts";

/** Bytes of a `bytea` value a cell shows as hex. */
export const CELL_HEX_BYTES = 8;
/** Characters of a value a cell shows. */
export const CELL_CHARS = 48;

const unit = (n: number, one: string, many: string): string => `${countText(n)} ${n === 1 ? one : many}`;

/** A value of a page as the tab draws it: its text, its tooltip (`null` when the cell shows all the engine sent), and
 *  whether it is SQL `NULL`. */
export function cellText(c: Cell): { text: string; title: string | null; isNull: boolean } {
  if (c.kind === "null") return { text: "NULL", title: null, isNull: true };
  if (c.kind === "bytes") {
    const sent = c.hex.length / 2;
    const shown = Math.min(sent, CELL_HEX_BYTES);
    const text = `${c.hex.slice(0, shown * 2)}${c.bytes > shown ? "…" : ""} · ${unit(c.bytes, "byte", "bytes")}`;
    return { text, title: c.bytes > shown ? `${c.hex}${c.bytes > sent ? "…" : ""} (${unit(c.bytes, "byte", "bytes")})` : null, isNull: false };
  }
  const sent = [...c.text];
  if (sent.length <= CELL_CHARS && c.chars <= sent.length) return { text: c.text, title: null, isNull: false };
  return {
    text: `${sent.slice(0, CELL_CHARS).join("")}… (${unit(c.chars, "character", "characters")})`,
    title: `${c.text}${c.chars > sent.length ? "…" : ""} (${unit(c.chars, "character", "characters")})`,
    isNull: false,
  };
}

/** A size: kilobytes below a megabyte, then `formatBytes`. */
export function sizeText(bytes: number): string {
  return bytes < 1e6 ? `${(bytes / 1e3).toFixed(1)} kB` : formatBytes(bytes);
}

/** Estimated rows: `~N rows`, or "no estimate" while the catalog has none. */
export function rowsEstimateText(estimatedRows: number | null): string {
  return estimatedRows === null ? "no estimate" : `~${countText(Math.round(estimatedRows))} rows`;
}

/** A table's kind in words. */
export function kindText(t: Pick<TableEntry, "kind" | "partitionOf">): string {
  return t.kind === "partition" ? `partition of ${t.partitionOf ?? "?"}` : t.kind === "partitioned" ? "partitioned" : "table";
}

/** A table's line in the picker: its name, estimated rows and size. */
export function tableLabel(t: TableEntry): string {
  return `${t.name} · ${rowsEstimateText(t.estimatedRows)} · ${sizeText(t.totalBytes)}`;
}

/** The line above the list: schemas, tables, the database's size. */
export function tablesSummary(t: TablesResult): string {
  const tables = t.schemas.reduce((a, s) => a + s.tables.length, 0);
  return `${t.schemas.length} schemas · ${tables} tables · ${formatBytes(t.databaseBytes)} in all · estimated rows and sizes from the catalog · read-only`;
}

/** Key columns that name the network: a store holds one, so an order that starts with them goes by what follows. */
const NETWORK_KEY = new Set(["net", "network"]);
/** Key columns that hold a block height. */
const HEIGHT_KEY = new Set(["height", "block_height"]);

/** The order of a page in words: the primary key's columns, descending — newest first when, after the network, the key
 *  leads with a block height; a table without a primary key in physical order. */
export function orderText(r: Pick<RowsResult, "orderBy">): string {
  if (r.orderBy.length === 0) return "newest first: the last written row first (the table has no primary key)";
  const lead = r.orderBy.find((c) => !NETWORK_KEY.has(c));
  return lead !== undefined && HEIGHT_KEY.has(lead)
    ? `newest first: by ${r.orderBy.join(", ")}, descending`
    : `by primary key (${r.orderBy.join(", ")}), descending`;
}

/** Which rows a page holds: `rows 1–25` (or "no rows"), and whether more follow. */
export function pageText(r: Pick<RowsResult, "offset" | "rows" | "more">): string {
  if (r.rows.length === 0) return r.offset === 0 ? "no rows" : `no rows from row ${r.offset + 1}`;
  return `rows ${countText(r.offset + 1)}–${countText(r.offset + r.rows.length)}${r.more ? ", more follow" : ""}`;
}
