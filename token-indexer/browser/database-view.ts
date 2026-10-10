/**
 * The Database tab of the static build (`index.html`): the store's tables and a page of the rows of the one picked,
 * read-only, through the engine (`tables` and `rows` of `protocol.ts`; no SQL is written here and no `/v1` route is
 * used).
 *
 * - The list: each schema's tables with their kind, estimated rows and size (catalog statistics), read when the tab is
 *   first shown and on "refresh". Picking a table (its row in the list, or the picker) reads its first page.
 * - A page: the table's columns (type in the tooltip), {@link ROWS_LIMITS}`.defaultLimit` rows newest first (by the
 *   primary key), "newer" and "older" to page, up to the engine's deepest offset. A `bytea` value is the hex of its first
 *   bytes with its length; a long value is cut, with its length, and what the engine sent of it is in the cell's tooltip
 *   (`database-model.ts`).
 * - The table is named to the engine by the schema and name the engine listed; the engine checks them against the
 *   store's catalog and refuses anything else, whose reason is shown.
 *
 * Every value, name and message is drawn with the explorer's hidden-character rules (`visible-text.ts`), as text nodes;
 * nothing is parsed as markup and no `style` attribute is set.
 */
import { type EngineClient } from "./client.ts";
import { cellText, kindText, orderText, pageText, rowsEstimateText, sizeText, tableLabel, tablesSummary } from "./database-model.ts";
import { messageOf } from "./engine-panel.ts";
import { ROWS_LIMITS, type RowsResult, type TablesResult } from "./protocol.ts";
import { dataNode, visibleText } from "./visible-text.ts";

export interface DatabaseViewOptions {
  client: EngineClient;
  /** The view is appended to this element. */
  parent: Element;
}

export interface DatabaseView {
  readonly element: HTMLElement;
  /** Reads the list of tables when it has not been read yet (the tab is shown). */
  shown(): void;
  /** Reads the list of tables again (and the page shown). */
  refresh(): Promise<void>;
  /** What the view drew last (for scripted checks). */
  latest(): { tables: TablesResult | null; rows: RowsResult | null };
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** A cell (`td`) holding `text` as data. */
function dataCell(text: string, cls?: string, field?: string): HTMLTableCellElement {
  const td = node("td", cls);
  if (field !== undefined) td.setAttribute("data-field", field);
  td.append(dataNode(document, text));
  return td;
}

export function mountDatabaseView(opts: DatabaseViewOptions): DatabaseView {
  const { client } = opts;

  // ── Markup ────────────────────────────────────────────────────────────────────────────────────────────────────────
  const root = node("section", "database-view");
  root.id = "database-view";
  root.setAttribute("aria-label", "database");
  const head = node("div", "row head");
  head.append(node("h2", undefined, "database"));
  const refreshButton = node("button", "mini", "refresh");
  refreshButton.type = "button";
  refreshButton.setAttribute("data-action", "db-refresh");
  head.append(refreshButton);
  root.append(head);
  const summary = node("div", "note");
  summary.setAttribute("data-field", "db-summary");
  summary.textContent = "reading the store's tables…";
  root.append(summary);

  const pickRow = node("div", "row picker");
  const pickLabel = node("label", "note", "table");
  const picker = node("select");
  picker.id = "db-table";
  pickLabel.htmlFor = picker.id;
  picker.setAttribute("data-input", "db-table");
  pickRow.append(pickLabel, picker);
  root.append(pickRow);

  const listWrap = node("div", "scroll table-list");
  const list = node("table");
  list.setAttribute("data-field", "db-tables");
  const listHead = node("tr");
  for (const c of ["schema", "table", "kind", "estimated rows", "size"]) listHead.append(node("th", c === "estimated rows" || c === "size" ? "num" : undefined, c));
  list.appendChild(node("thead")).append(listHead);
  const listBody = list.appendChild(node("tbody"));
  listWrap.append(list);
  root.append(listWrap);

  const page = node("section", "rows");
  page.setAttribute("data-field", "db-rows");
  page.hidden = true;
  const pageHead = node("div", "row head");
  const pageTitle = node("h2");
  pageTitle.setAttribute("data-field", "db-rows.title");
  const newer = node("button", "mini", "newer");
  newer.type = "button";
  newer.setAttribute("data-action", "db-newer");
  const older = node("button", "mini", "older");
  older.type = "button";
  older.setAttribute("data-action", "db-older");
  pageHead.append(pageTitle, newer, older);
  const pageNote = node("div", "note");
  pageNote.setAttribute("data-field", "db-rows.page");
  const rowsWrap = node("div", "scroll");
  const rowsTable = node("table");
  rowsTable.setAttribute("data-field", "db-rows.table");
  rowsWrap.append(rowsTable);
  page.append(pageHead, pageNote, rowsWrap);
  root.append(page);

  const message = node("div", "note");
  message.setAttribute("data-field", "db-message");
  message.setAttribute("role", "status");
  root.append(message);
  opts.parent.append(root);

  // ── State ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  let tables: TablesResult | null = null;
  let rows: RowsResult | null = null;
  let picked: { schema: string; table: string; offset: number } | null = null;
  let loading = false;
  let read = false;

  const say = (text: string): void => {
    message.replaceChildren(dataNode(document, text));
  };

  function drawTables(t: TablesResult): void {
    summary.replaceChildren(dataNode(document, tablesSummary(t)));
    const options: HTMLElement[] = [];
    const none = node("option", undefined, "pick a table");
    none.value = "";
    options.push(none);
    const lines: HTMLTableRowElement[] = [];
    for (const s of t.schemas) {
      const group = node("optgroup");
      group.label = visibleText(s.name);
      for (const x of s.tables) {
        const o = node("option");
        o.value = JSON.stringify([s.name, x.name]);
        o.textContent = visibleText(tableLabel(x));
        group.append(o);
        const tr = node("tr", "pick");
        tr.setAttribute("data-table", `${s.name}.${x.name}`);
        tr.append(
          dataCell(s.name, undefined, "db-tables.schema"),
          dataCell(x.name, undefined, "db-tables.name"),
          dataCell(kindText(x), undefined, "db-tables.kind"),
          dataCell(rowsEstimateText(x.estimatedRows), "num", "db-tables.estimatedRows"),
          dataCell(sizeText(x.totalBytes), "num", "db-tables.totalBytes"),
        );
        tr.addEventListener("click", () => void pick(s.name, x.name, 0));
        lines.push(tr);
      }
      options.push(group);
    }
    picker.replaceChildren(...options);
    picker.value = picked === null ? "" : JSON.stringify([picked.schema, picked.table]);
    listBody.replaceChildren(...lines);
  }

  function drawRows(r: RowsResult): void {
    page.hidden = false;
    pageTitle.replaceChildren(dataNode(document, `${r.schema}.${r.table}`));
    pageNote.replaceChildren(dataNode(document, `${pageText(r)} · ${orderText(r)} · up to ${r.limit} rows a page`));
    const headRow = node("tr");
    for (const c of r.columns) {
      const th = node("th");
      th.append(dataNode(document, c.name));
      th.title = visibleText(c.type);
      headRow.append(th);
    }
    const body = node("tbody");
    for (const values of r.rows) {
      const tr = node("tr");
      for (const v of values) {
        const { text, title, isNull } = cellText(v);
        const td = dataCell(text, isNull ? "no" : v.kind === "bytes" ? "hex" : undefined, "db-rows.cell");
        if (title !== null) td.title = visibleText(title);
        tr.append(td);
      }
      body.append(tr);
    }
    const thead = node("thead");
    thead.append(headRow);
    rowsTable.replaceChildren(thead, body);
    newer.disabled = r.offset === 0;
    older.disabled = !r.more || r.offset + r.limit > ROWS_LIMITS.maxOffset;
  }

  async function loadTables(): Promise<void> {
    read = true;
    try {
      tables = await client.request("tables", {});
      drawTables(tables);
    } catch (e) {
      say(`the tables could not be read · ${messageOf(e)}`);
    }
  }

  async function pick(schema: string, table: string, offset: number): Promise<void> {
    if (loading) return;
    loading = true;
    for (const b of [newer, older]) b.disabled = true;
    say(`reading ${schema}.${table}…`);
    try {
      rows = await client.request("rows", { schema, table, limit: ROWS_LIMITS.defaultLimit, offset });
      picked = { schema, table, offset };
      picker.value = JSON.stringify([schema, table]);
      drawRows(rows);
      say("");
    } catch (e) {
      say(`${schema}.${table} could not be read · ${messageOf(e)}`);
      if (rows !== null) drawRows(rows);
    } finally {
      loading = false;
    }
  }

  picker.addEventListener("change", () => {
    if (picker.value === "") return;
    let named: unknown;
    try {
      named = JSON.parse(picker.value);
    } catch {
      named = null;
    }
    if (Array.isArray(named) && named.length === 2 && typeof named[0] === "string" && typeof named[1] === "string") void pick(named[0], named[1], 0);
  });
  newer.addEventListener("click", () => {
    if (picked !== null) void pick(picked.schema, picked.table, Math.max(0, picked.offset - ROWS_LIMITS.defaultLimit));
  });
  older.addEventListener("click", () => {
    if (picked !== null) void pick(picked.schema, picked.table, picked.offset + ROWS_LIMITS.defaultLimit);
  });

  async function refresh(): Promise<void> {
    await loadTables();
    if (picked !== null) await pick(picked.schema, picked.table, picked.offset);
  }
  refreshButton.addEventListener("click", () => void refresh());

  return {
    element: root,
    shown(): void {
      if (!read) void loadTables();
    },
    refresh,
    latest: () => ({ tables, rows }),
  };
}
