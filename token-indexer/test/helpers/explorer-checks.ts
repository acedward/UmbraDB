/**
 * The explorer page's checks shared by its two forms: the page `GET /ui` serves (`mip0018-ui-browser.test.ts`, the API
 * of a Node server on PostgreSQL) and the static browser build's explorer (`browser-explorer-chrome.test.ts`, the API of
 * the engine in the page's worker). A check runs on a page that is already open on the explorer; `api` reads the same
 * API the page reads (over HTTP, or through the engine), so every expectation is the API's own answer. What differs
 * between the two forms (the requests a page may send, its console) is checked by each test file.
 *
 * Also the pieces both use to read the page: {@link SNAP}, {@link LIST_ROWS}, {@link visit}, {@link crawl},
 * {@link mentions}, and the characters that must never reach the drawn text raw ({@link HIDDEN_RAW}).
 */
import { expect } from "vitest";
import { loadCaseIndex } from "../../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import type { Page } from "./cdp-browser.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export const NET = "stagenet";
export const WALLET_1 = "mn_addr_stagenet1vw57646su9y5z6myarm93m6kcn62j97z0yma94lfkhmta6pz5h5q6utr3k";
// Raw characters a value may carry that must never reach the drawn text or a tooltip (tab/newline excepted in
// innerText, which uses them for layout).
// The page's own rule by Unicode property (in Node's Unicode data): every control, format, private-use,
// unassigned and surrogate code point, line/paragraph separator and Default_Ignorable_Code_Point.
export const HIDDEN_RAW = /[\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
export const HIDDEN_RAW_ATTR = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

export interface Snap { route: string; state: string; view: string; text: string; attrs: string[]; hrefs: string[]; banner: string | null; strip: string }

/** What the page shows now: the drawn text, every attribute value inside the view/banner/strip, and the view's links. */
export const SNAP = `(() => {
  const view = document.getElementById('view');
  const banner = document.getElementById('banner');
  const strip = document.getElementById('strip');
  const attrs = [];
  for (const root of [view, banner, strip]) for (const e of [root, ...root.querySelectorAll('*')]) for (const a of e.attributes) attrs.push(a.value);
  return { route: document.body.getAttribute('data-route'), state: document.body.getAttribute('data-state'), view: view.innerText,
    text: document.body.innerText, attrs, hrefs: [...view.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
    banner: banner.hidden ? null : banner.innerText, strip: strip.innerText };
})()`;

/** The page's route key of a hash (mirrors `parseRoute`/`routeKey` in page.js). */
export function keyOf(hash: string): string {
  const p = hash.replace(/^#/, "").split("/").slice(1);
  if (hash === "#/" || hash === "#" || hash === "") return "list";
  if (p[0] === "token") return `identity/${p[1]}/${p[2]}/${p[3]}`;
  if (p[0] === "color" || p[0] === "contract" || p[0] === "tx") return `${p[0]}/${p[1]}`;
  if (p[0] === "builtin" && p[1] === "DUST") return "dust";
  if (p[0] === "status" && p.length === 1) return "status";
  return "unknown";
}

export async function visit(page: Page, hash: string): Promise<Snap> {
  const key = keyOf(hash);
  await page.eval(`location.hash = ${JSON.stringify(hash)}`);
  await page.waitFor(`document.body.getAttribute('data-route') === ${JSON.stringify(key)} && document.body.getAttribute('data-state') !== 'loading'`, 30_000, `route ${hash}`);
  return page.eval<Snap>(SNAP);
}

/** Every route reachable from `start` through the view's links (breadth first). */
export async function crawl(page: Page, start: readonly string[], limit = 120): Promise<Map<string, Snap>> {
  const seen = new Map<string, Snap>();
  const queue = [...start];
  while (queue.length > 0 && seen.size < limit) {
    const h = queue.shift()!;
    if (seen.has(h)) continue;
    const snap = await visit(page, h);
    seen.set(h, snap);
    for (const x of snap.hrefs) if (x.startsWith("#/") && !seen.has(x) && !queue.includes(x)) queue.push(x);
  }
  expect(queue, "crawl limit reached").toEqual([]);
  return seen;
}

/** The routes whose drawn text or attribute values contain `needle`. */
export function mentions(c: Map<string, Snap>, needle: string): string[] {
  return [...c].filter(([, s]) => s.text.includes(needle) || s.attrs.some((a) => a.includes(needle))).map(([h]) => h);
}

/** Rows of the page's token table (`#tokens`, or the first table of the view). */
export const LIST_ROWS = `[...document.querySelectorAll('#view section table')[0].querySelectorAll('tbody tr')].map((tr) => {
  const mk = tr.querySelector('td.mipcol .mk');
  return { mark: mk ? mk.getAttribute('data-mark') : null, markText: mk ? mk.textContent : null, title: mk ? mk.title : null,
    cells: [...tr.cells].map((c) => c.innerText), href: (tr.querySelector('a[href]') || {}).getAttribute ? tr.querySelector('a[href]').getAttribute('href') : null,
    domainSeps: [...tr.querySelectorAll('[data-domainsep]')].map((e) => e.getAttribute('data-domainsep')),
    nameTitle: (tr.cells[1].querySelector('.d') || {}).title || null };
})`;

/** The page's label of a domainSep (`asciiOf` in page.js): printable ASCII once trailing zero bytes are dropped. */
export function asciiLabel(hex: string): string | null {
  const b = [...Buffer.from(hex, "hex")];
  while (b.length > 0 && b[b.length - 1] === 0) b.pop();
  return b.length > 0 && b.every((x) => x >= 32 && x <= 126) ? Buffer.from(b).toString("latin1") : null;
}

const caseIndex = loadCaseIndex();
export const contractOf = (c: string): string => caseIndex.cases[c]!.contract!;
export const stepTx = (c: string, id: string): string => caseIndex.cases[c]!.steps.find((s) => s.id === id)!.txHash!;

/** An explorer page under test and the API it reads. */
export interface ExplorerTarget {
  page: Page;
  /** A GET of an API path, answered by the same API the page reads: the status and the parsed body. */
  api(path: string): Promise<{ status: number; json: Json }>;
  /** Saves a screenshot when the run asks for them. */
  shot?(name: string): Promise<void> | undefined;
}

/**
 * The recorded IDX range on the list, the token, color, built-in, contract, tx and status routes: every value is the
 * API's (`[[mip0018.ui.browser-routes]]`). The page is open on the explorer, the range fully scanned.
 */
export async function checkRecordedRoutes(t: ExplorerTarget): Promise<void> {
  const page = t.page;
    await page.waitFor("document.body.getAttribute('data-route') === 'list' && document.body.getAttribute('data-state') === 'ready'");
    expect(await page.eval("document.title")).toBe("MIP-0018 token explorer");
    const rows = await page.eval<Json[]>(LIST_ROWS);
    const api16 = (await t.api("/v1/tokens?limit=500")).json.items as Json[];
    expect(api16).toHaveLength(16);
    expect(rows).toHaveLength(api16.length);
    expect(rows.slice(0, 2).map((r) => [r.cells[1], r.cells[2], r.cells[3]])).toEqual([["NIGHT", "NIGHT", "built-in"], ["DUST", "DUST", "built-in"]]);
    for (const [i, t] of api16.entries()) {
      const r = rows[i]!;
      if (t.source === "builtin") {
        expect(r.mark, t.symbol).toBe(null);
        continue;
      }
      expect(r.mark, t.id).toBe(t.mark.mark);
      expect(r.markText, t.id).toBe({ ok: "\u2713", partial: "\u26a0", incorrect: "\u26a0", none: "" }[t.mark.mark as string]);
      expect(r.cells[1], t.id).toBe(t.name ?? "\u2014");
      expect(r.cells[2], t.id).toBe(t.symbol ?? "\u2014");
      expect(r.cells[3], t.id).toBe(`${t.kind} \u00b7 ${t.kindName}`);
      expect(r.cells[5], t.id).toBe(t.mark.tags.join(""));
      expect(r.href, t.id).toBe(`#/token/${t.contractAddress}/${t.domainSep}/${t.kind}`);
      // Every identity row shows its domainSep — the printable label, else the short hex.
      expect(r.domainSeps, t.id).toEqual([t.domainSep]);
      expect(r.cells[4], t.id).toContain(asciiLabel(t.domainSep) ?? `${t.domainSep.slice(0, 8)}\u2026${t.domainSep.slice(-6)}`);
    }
    // Identities sharing name, symbol and kind (C05's three "Acme Medals", kind 1) differ in the list by their label.
    const medals = rows.filter((_, i) => api16[i].contractAddress === contractOf("C05"));
    expect(medals).toHaveLength(3);
    expect(new Set(medals.map((r) => `${r.cells[1]}|${r.cells[2]}|${r.cells[3]}`)).size).toBe(1);
    expect(medals.map((r) => r.cells[4].split(" ")[1]).sort()).toEqual(
      ["mip-0018:example:family:bronze", "mip-0018:example:family:gold", "mip-0018:example:family:silver"]);
    const byContract = (c: string): Json[] => rows.filter((_, i) => api16[i].contractAddress === contractOf(c));
    expect(byContract("C01").map((r) => [r.mark, r.markText])).toEqual([["ok", "\u2713"]]);
    expect(byContract("C01")[0].title).toMatch(/^\u2713 correct: usable name, symbol and decimals/);
    expect(byContract("C04").map((r) => r.mark)).toEqual(["ok", "ok", "ok"]);
    const c07 = byContract("C07")[0];
    const c07Api = api16.find((t) => t.contractAddress === contractOf("C07"));
    expect([c07.mark, c07.markText]).toEqual(["incorrect", "\u26a0"]);
    expect(c07.title).toContain(`\u26a0 incorrect: its contract has ${c07Api.mark.reasonCount} rejected MIP-0018 events: ${c07Api.mark.reasons.slice(0, 3).join(", ")}`);
    const c08 = byContract("C08")[0];
    expect(c08.mark).toBe("incorrect");
    expect(c08.title.startsWith("\u26a0 incorrect: its contract has 1 rejected MIP-0018 event: reserved-valtype")).toBe(true);
    expect(byContract("C10")[0].cells[5]).toBe("mip-0004");
    const unmarked = rows.filter((_, i) => api16[i].source === "identity" && !api16[i].described);
    expect(unmarked.map((r) => [r.mark, r.markText, r.cells[1]])).toEqual([["none", "", "\u2014"]]);
    await t.shot?.("list.png");

    // Every row's route renders (and the built-in rows).
    for (const r of rows) {
      const s = await visit(page, r.href);
      expect(s.state, r.href).toBe("ready");
      expect(s.view, r.href).not.toMatch(/could not be read|no such/);
    }
    // C04 kind 1: identity, common fields, fields, group of three, mark; events of the contract.
    const C04 = contractOf("C04");
    const c04k1 = api16.find((t) => t.contractAddress === C04 && t.kind === 1);
    const d = (await t.api(`/v1/identities/${C04}/${c04k1.domainSep}/1`)).json;
    const s04 = await visit(page, `#/token/${C04}/${c04k1.domainSep}/1`);
    expect(s04.view).toContain("Acme Dollar");
    expect(s04.view).toContain(d.color);
    const fieldRows = await page.eval<string[][]>("[...document.querySelectorAll('#fields tbody tr')].map((tr) => [...tr.cells].map((c) => c.innerText))");
    expect(fieldRows.map((f) => f[0])).toEqual(d.fields.map((f: Json) => f.key.utf8));
    expect(fieldRows.map((f) => f[2])).toEqual(d.fields.map((f: Json) => f.value.text ?? f.value.integer));
    expect(fieldRows.every((f) => f[3] === "usable")).toBe(true);
    const groupLinks = await page.eval<string[]>("[...document.querySelectorAll('#view section')].find((s) => (s.querySelector('h2') || {}).textContent === 'symbol group').innerText");
    expect(groupLinks).toContain("ACD");
    expect(await page.eval<string | null>("document.querySelector('#view .badge[data-mark]').getAttribute('data-mark')")).toBe("ok");
    const ev04 = (await t.api(`/v1/events?contract=${C04}&limit=500`)).json.items as Json[];
    expect(await page.eval<number>("document.querySelectorAll('#events tbody tr').length")).toBe(ev04.length);
    await t.shot?.("token-c04.png");

    // C07: the reasons and 18 events (9 accepted, 9 rejected).
    const C07 = contractOf("C07");
    await visit(page, `#/token/${C07}/${c07Api.domainSep}/${c07Api.kind}`);
    expect(await page.eval<number>("[...document.querySelectorAll('#view ol li')].length")).toBe(c07Api.mark.reasons.length);
    expect(await page.eval<string[]>("[...document.querySelectorAll('#events [data-class]')].map((b) => b.getAttribute('data-class'))")).toEqual(
      ((await t.api(`/v1/events?contract=${C07}&limit=500`)).json.items as Json[]).map((e) => e.classification));

    // Activity of C03's unshielded token: as the API answers it.
    const C03 = contractOf("C03");
    const c03 = api16.find((t) => t.contractAddress === C03 && t.kind === 2);
    const act = await t.api(`/v1/tokens/${c03.color}/activity`);
    const s03 = await visit(page, `#/token/${C03}/${c03.domainSep}/2`);
    expect(act.status).toBe(200);
    expect(s03.view).not.toContain("activity is not served by this API");
    expect(await page.eval<number>("document.querySelectorAll('#activity tbody tr').length")).toBe(act.json.items.length);
    expect(await page.eval<string[]>("[...document.querySelectorAll('#activity .wallet')].map((w) => w.textContent)")).toContain(WALLET_1);

    // Contract view of C04: three identities, the ACD group with three member links; tx view of C08's emitTwo.
    const sc = await visit(page, `#/contract/${C04}`);
    expect(await page.eval<number>("document.querySelectorAll('#tokens tbody tr').length")).toBe(3);
    expect(sc.hrefs.filter((h) => h.startsWith(`#/token/${C04}/`)).length).toBeGreaterThanOrEqual(6);
    const tx = stepTx("C08", "emit-two");
    const st = await visit(page, `#/tx/${tx}`);
    expect(await page.eval<string[][]>("[...document.querySelectorAll('#events tbody tr')].map((tr) => [tr.cells[0].innerText, tr.cells[5].innerText, tr.cells[6].innerText])")).toEqual([
      ["715109", "accepted", ""], ["715109", "rejected", "reserved-valtype"],
    ]);
    expect(st.hrefs).toContain(`#/contract/${contractOf("C08")}`);
    // NIGHT (zero color), DUST, status, an unknown route.
    expect((await visit(page, `#/color/${"0".repeat(64)}`)).view).toMatch(/NIGHT[\s\S]*protocol|NIGHT/);
    expect((await visit(page, "#/builtin/DUST")).view).toContain("DUST has no color and no activity rows.");
    const ss = await visit(page, "#/status");
    expect(ss.view).toContain("715183");
    expect(ss.strip).toMatch(/net: stagenet\s+\u00b7\s+indexed 715183/);
    expect((await visit(page, "#/nope")).view).toContain("no such page");
}

/**
 * The activity sections on the recorded IDX range: C03's rows (UTXO and mint with wallet 1 in Bech32m, never its hex;
 * the publish as a metadata transaction), C06's five metadata transactions on the identity and contract views, NIGHT
 * with no activity (`[[mip0018.ui.browser-activity-shape]]`, part A). The page is open on the explorer.
 */
export async function checkRecordedActivity(t: ExplorerTarget): Promise<void> {
  const page = t.page;
    const list = (await t.api("/v1/tokens?limit=500")).json.items as Json[];
    const C03 = contractOf("C03");
    const c03 = list.find((t) => t.contractAddress === C03 && t.kind === 2);
    const act = await t.api(`/v1/tokens/${c03.color}/activity`);
    expect(act.status).toBe(200);
    await page.waitFor("document.body.getAttribute('data-state') === 'ready'");
    await visit(page, `#/token/${C03}/${c03.domainSep}/2`);
    await page.waitFor(`document.querySelectorAll('#activity tbody tr').length === ${act.json.items.length}`);
    const rowsNow = (): Promise<Json[]> => page.eval<Json[]>("[...document.querySelectorAll('#activity tbody tr')].map((tr) => ({ role: tr.getAttribute('data-role'), cells: [...tr.cells].map((c) => c.innerText), wallets: [...tr.querySelectorAll('.wallet')].map((w) => w.textContent), links: [...tr.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')) }))");
    const d03 = await rowsNow();
    expect(d03.map((r) => [r.role, r.cells[0]])).toEqual((act.json.items as Json[]).map((i) => [i.role, String(i.height)]));
    expect(d03.map((r) => [r.role, r.cells[0], r.cells[2]])).toEqual([["utxo-created", "714617", "UTXO created \u00b7 in"], ["mint", "714617", "mint \u00b7 in"], ["metadata-event", "714624", "metadata event"]]);
    expect(d03.flatMap((r) => r.wallets)).toEqual([WALLET_1, WALLET_1]);
    expect(d03[0]!.links).toContain(`#/tx/${stepTx("C03", "mint")}`);
    expect(d03[2]!.links).toContain(`#/tx/${stepTx("C03", "publish")}`);
    expect(d03[2]!.cells[5]).toBe("1 accepted \u00b7 0 rejected");
    expect(await page.eval<string>("document.body.innerText")).not.toContain("63a9ed57"); // wallet 1 as hex: never
    await t.shot?.("activity-c03.png");
    // C06 (kind 3, no color): its contract's metadata transactions, on the identity and on the contract view.
    const C06 = contractOf("C06");
    const c06Heights = ["714796", "714804", "714813", "714827", "714835"];
    for (const hash of [`#/token/${C06}/${"11".repeat(32)}/3`, `#/contract/${C06}`]) {
      await visit(page, hash);
      await page.waitFor("document.querySelectorAll('#activity tbody tr').length === 5", 30_000, hash);
      const d06 = await rowsNow();
      expect(d06.map((r) => [r.role, r.cells[0], r.cells[r.cells.length - 1]]), hash).toEqual(c06Heights.map((h) => ["metadata-event", h, "1 accepted \u00b7 0 rejected"]));
    }
    // NIGHT: known, no NIGHT UTXO in the recorded range → "no activity"; no "not served" note anywhere.
    await visit(page, `#/color/${"0".repeat(64)}`);
    expect(await page.eval<string>("document.querySelector('#activity [data-activity]').getAttribute('data-activity')")).toBe("empty");
}

/**
 * C06's lifecycle step by step with the page open and refreshing on its own (every 600 ms, never reloaded): the
 * withdrawn name is on no reachable view after the tombstone and stays absent after the revive
 * (`[[mip0018.ui.browser-withdrawn]]`, recorded part). The page is open on the explorer (`?refresh=600`) over a store
 * holding nothing scanned past 714789; `advance(h)` makes the API's indexed height `h`.
 */
export async function checkC06Lifecycle(t: ExplorerTarget, advance: (height: number) => Promise<void>): Promise<void> {
  const page = t.page;
  const C06 = contractOf("C06");
  const ds = "11".repeat(32);
    const at: Record<string, Map<string, Snap>> = {};
    for (const step of caseIndex.cases.C06!.steps.filter((x) => x.expectedAfter !== undefined)) {
      await advance(step.height!);
      await page.waitFor(`(/indexed (\\d+)/.exec(document.getElementById('strip').innerText) || [])[1] === '${step.height}'`, 30_000, `indexed ${step.height}`);
      at[step.id] = await crawl(page, ["#/", `#/contract/${C06}`, `#/token/${C06}/${ds}/3`]);
    }
    expect(Object.keys(at)).toEqual(["publish", "rename", "withdraw", "withdraw-again", "revive"]);
    expect(mentions(at.publish!, "Acme Token").length).toBeGreaterThan(0); // positive control
    expect(mentions(at.rename!, "Acme Prime").length).toBeGreaterThan(0);
    expect(mentions(at.rename!, "Acme Token")).toEqual([]);
    for (const step of ["withdraw", "withdraw-again", "revive"]) {
      expect(mentions(at[step]!, "Acme Prime"), step).toEqual([]);
      expect(mentions(at[step]!, "Acme Token"), step).toEqual([]);
      expect(at[step]!.size, step).toBeGreaterThan(3);
    }
    const w = at.withdraw!.get(`#/token/${C06}/${ds}/3`)!;
    expect(w.view).toContain("\u26a0 partial: missing or unusable: name");
    expect(w.view).toContain("unnamed token");
    expect(mentions(at.revive!, "Acme Again").length).toBeGreaterThan(0);
    await t.shot?.("c06-after-revive.png");
}
