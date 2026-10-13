/**
 * Development check of a live Stagenet range against the recorded fixtures (CI uses recorded fixtures; development
 * syncs FROM–TO ranges live). Not a CI test: it talks to the public Stagenet endpoints. CI compares a replay with the
 * digest this script records (`token-indexer/test/mip0018-live-range.test.ts`).
 *
 * Every run uses the REAL command-line programs as child processes — `chain-archive-sync/sync-cli.ts` (archive) and
 * `token-indexer/mip0018/scan-cli.ts` (MIP-0018 scan) — each run in its own pair of schemas
 * `live_range_<tag>_archive` / `live_range_<tag>_mip`:
 *
 *   PG_URL=postgres://… node --import tsx token-indexer/dev/live-range-check.ts live --tag a --from 714485 --to 715183 --out DIR
 *   PG_URL=… … live    --tag b --from 714485 --to 715183 --kill-archive-at 714800 --kill-scan-at 714850 --out DIR
 *   PG_URL=… … replay  --tag r --range idx --out DIR      (the recorded tape, served by the local fake chain, same programs)
 *   PG_URL=… … compare --tags a,r,b --out DIR            (every table of both schemas, wall-clock columns excluded)
 *
 * `live` is polite by construction: the sync program's own defaults (4 heights in flight, ≥ 250 ms between request
 * starts per public endpoint, back-off on 429/403/5xx). A kill is a SIGKILL of the child process once the archive
 * (or the scan cursor) has reached the given height; the same program is then started again and must resume.
 * Requests are counted by the `fetch-meter.ts` preload (one line per request, exact after a kill).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createClient, type UmbraDBSql } from "../../src/postgres/client.js";
import { startFakeChain } from "../../test/integration/fixtures/stagenet-archive/fake-chain-server.js";
import { loadRangeTape } from "../../test/integration/fixtures/stagenet-archive/stagenet-fixtures.js";
import { compareTables, firstDifference, rangeTables, type RangeTables } from "./range-tables.ts";

const REPO = resolve(new URL("../..", import.meta.url).pathname);
const METER = join(REPO, "token-indexer/dev/fetch-meter.ts");
const SYNC_CLI = join(REPO, "chain-archive-sync/sync-cli.ts");
const SCAN_CLI = join(REPO, "token-indexer/mip0018/scan-cli.ts");

const schemasOf = (tag: string): { archive: string; mip: string } => ({ archive: `live_range_${tag}_archive`, mip: `live_range_${tag}_mip` });
const now = (): number => Date.now();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ChildRun { args: string[]; startedAt: string; ms: number; exit: number | null; signal: string | null; killedAt?: number }

/** Runs one CLI as a child process; output appended to `log`; optional kill once `killWhen()` is true. */
async function runChild(args: string[], env: NodeJS.ProcessEnv, log: string, killWhen?: () => Promise<number | undefined>): Promise<ChildRun> {
  const startedAt = new Date().toISOString();
  const t0 = now();
  const out = createWriteStream(log, { flags: "a" });
  out.write(`# ${startedAt} ${args.join(" ")}\n`);
  const child: ChildProcess = spawn(process.execPath, args, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.pipe(out, { end: false });
  child.stderr!.pipe(out, { end: false });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once("exit", (code, signal) => r({ code, signal })));
  let killedAt: number | undefined;
  if (killWhen !== undefined) {
    for (;;) {
      const finished = await Promise.race([done.then(() => true), sleep(100).then(() => false)]);
      if (finished) break;
      const h = await killWhen();
      if (h !== undefined) {
        child.kill("SIGKILL");
        killedAt = h;
        break;
      }
    }
  }
  const { code, signal } = await done;
  await new Promise<void>((r) => out.end(r));
  return { args, startedAt, ms: now() - t0, exit: code, signal, ...(killedAt === undefined ? {} : { killedAt }) };
}

async function archivedHeight(sql: UmbraDBSql, schema: string, net: string): Promise<number | undefined> {
  const exists = await sql<{ r: string | null }[]>`SELECT to_regclass(${`${schema}.blocks`})::text AS r`;
  if (exists[0]?.r === null) return undefined;
  const r = await sql<{ h: string | null }[]>`SELECT max(height)::text AS h FROM ${sql(schema)}.blocks WHERE net = ${net}`;
  return r[0]?.h === null || r[0]?.h === undefined ? undefined : Number(r[0].h);
}

async function scanNext(sql: UmbraDBSql, schema: string, net: string): Promise<number | undefined> {
  const exists = await sql<{ r: string | null }[]>`SELECT to_regclass(${`${schema}.mip0018_scan`})::text AS r`;
  if (exists[0]?.r === null) return undefined;
  const r = await sql<{ h: string }[]>`SELECT next_height::text AS h FROM ${sql(schema)}.mip0018_scan WHERE network = ${net}`;
  return r[0] === undefined ? undefined : Number(r[0].h);
}

/** Summary of a fetch-meter log: requests per host and operation, statuses, throttled answers. */
function requestSummary(file: string): Record<string, unknown> {
  if (!existsSync(file)) return { total: 0 };
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { host: string; op: string; status: string; ms: number });
  const by: Record<string, Record<string, number>> = {};
  const statuses: Record<string, number> = {};
  for (const l of lines) {
    by[l.host] ??= {};
    by[l.host]![l.op] = (by[l.host]![l.op] ?? 0) + 1;
    statuses[l.status] = (statuses[l.status] ?? 0) + 1;
  }
  const throttled = lines.filter((l) => ["429", "403", "503"].includes(l.status)).length;
  const failed = lines.filter((l) => !l.status.startsWith("2")).length;
  return { total: lines.length, byHostAndOperation: by, statuses, throttledAnswers: throttled, nonSuccessAnswers: failed };
}

/** Sum of the sync program's own batch counters and back-off lines. */
function syncLogSummary(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let batches = 0;
  let retries = 0;
  let throttled = 0;
  let backoffs = 0;
  let errors = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const ev = o.event ?? o.msg;
      if (ev === "batch") {
        batches++;
        retries += Number(o.retries ?? 0);
        throttled += Number(o.throttled ?? 0);
      } else if (ev === "backoff") backoffs++;
      else if (ev === "error") errors++;
    } catch {
      // not a log line
    }
  }
  return { batches, retries, throttled, backoffLines: backoffs, loopErrors: errors };
}

async function main(): Promise<void> {
  const [phase, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: {
      tag: { type: "string" }, tags: { type: "string" }, from: { type: "string" }, to: { type: "string" },
      range: { type: "string", default: "idx" }, out: { type: "string" }, network: { type: "string", default: "stagenet" },
      node: { type: "string", default: "https://rpc.stagenet.shielded.tools" },
      indexer: { type: "string", default: "https://indexer.stagenet.shielded.tools/api/v4/graphql" },
      "kill-archive-at": { type: "string" }, "kill-scan-at": { type: "string" },
    },
  });
  const pg = process.env.PG_URL;
  if (pg === undefined || values.out === undefined) throw new Error("PG_URL and --out are required");
  const outDir = resolve(values.out);
  mkdirSync(outDir, { recursive: true });
  const net = values.network;
  const sql = createClient({ connectionString: pg, schema: "public" });
  try {
    if (phase === "live" || phase === "replay") {
      const tag = values.tag!;
      const { archive, mip } = schemasOf(tag);
      let from = Number(values.from);
      let to = Number(values.to);
      let nodeUrl = values.node;
      let indexerUrl = values.indexer;
      const fake = phase === "replay" ? await startFakeChain(loadRangeTape(values.range)) : undefined;
      if (fake !== undefined) {
        const tape = loadRangeTape(values.range);
        from = tape.heights[0]!;
        to = tape.heights[tape.heights.length - 1]!;
        nodeUrl = fake.nodeUrl;
        indexerUrl = fake.indexerUrl;
      }
      try {
        const meter = join(outDir, `${tag}-sync-requests.jsonl`);
        const env = { ...process.env, ARCHIVE_PG: pg, ARCHIVE_SCHEMA: archive, NET: net, NODE_URL: nodeUrl, INDEXER_URL: indexerUrl, FETCH_METER_OUT: meter };
        const syncArgs = ["--import", "tsx", "--import", METER, SYNC_CLI, "--from", String(from), "--to", String(to)];
        const runs: ChildRun[] = [];
        const killArchive = values["kill-archive-at"] === undefined ? undefined : Number(values["kill-archive-at"]);
        const t0 = now();
        runs.push(await runChild(syncArgs, env, join(outDir, `${tag}-sync.log`), killArchive === undefined ? undefined : async () => {
          const h = await archivedHeight(sql, archive, net);
          return h !== undefined && h >= killArchive ? h : undefined;
        }));
        let archivedAtKill: number | undefined;
        if (runs[0]!.killedAt !== undefined) {
          archivedAtKill = await archivedHeight(sql, archive, net);
          runs.push(await runChild(syncArgs, env, join(outDir, `${tag}-sync.log`)));
        }
        const syncMs = now() - t0;

        const scanEnv = { ...process.env, PG_URL: pg };
        const killScan = values["kill-scan-at"] === undefined ? undefined : Number(values["kill-scan-at"]);
        const scanArgs = ["--import", "tsx", SCAN_CLI, "--network", net, "--from", String(from), "--to", String(to),
          "--schema", mip, "--archive-schema", archive, "--max-blocks", killScan === undefined ? "100" : "5"];
        const scans: ChildRun[] = [];
        const t1 = now();
        scans.push(await runChild(scanArgs, scanEnv, join(outDir, `${tag}-scan.log`), killScan === undefined ? undefined : async () => {
          const h = await scanNext(sql, mip, net);
          return h !== undefined && h >= killScan ? h : undefined;
        }));
        let scanNextAtKill: number | undefined;
        if (scans[0]!.killedAt !== undefined) {
          scanNextAtKill = await scanNext(sql, mip, net);
          scans.push(await runChild(scanArgs, scanEnv, join(outDir, `${tag}-scan.log`)));
        }
        const scanMs = now() - t1;
        const result = {
          phase, tag, network: net, from, to, schemas: { archive, mip },
          endpoints: phase === "live" ? { node: nodeUrl, indexer: indexerUrl } : { replay: `${values.range} tape via the local fake chain` },
          sync: { ms: syncMs, runs, archivedHeightAtKill: archivedAtKill, finalArchivedHeight: await archivedHeight(sql, archive, net),
            log: syncLogSummary(join(outDir, `${tag}-sync.log`)), requests: requestSummary(meter) },
          scan: { ms: scanMs, runs: scans, scanNextAtKill, finalScanNext: await scanNext(sql, mip, net) },
        };
        writeFileSync(join(outDir, `${tag}-run.json`), `${JSON.stringify(result, null, 2)}\n`);
        console.log(JSON.stringify({ event: "run-done", tag, syncMs, scanMs, killedArchiveAt: runs[0]!.killedAt, killedScanAt: scans[0]!.killedAt }));
        if (runs.some((r) => r.exit !== 0 && r.signal !== "SIGKILL") || scans.some((r) => r.exit !== 0 && r.signal !== "SIGKILL")) process.exitCode = 1;
      } finally {
        await fake?.close();
      }
    } else if (phase === "compare") {
      const tags = values.tags!.split(",");
      const digests: Record<string, RangeTables> = {};
      const rows: Record<string, Map<string, string[]>> = {};
      for (const tag of tags) {
        const { archive, mip } = schemasOf(tag);
        const r = await rangeTables(sql, archive, mip);
        digests[tag] = r.digest;
        rows[tag] = r.rows;
        writeFileSync(join(outDir, `${tag}-tables.json`), `${JSON.stringify(r.digest, null, 2)}\n`);
      }
      const pairs: Record<string, { identical: boolean; differences: string[]; firstRows?: Record<string, string | undefined> }> = {};
      for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) {
        const [a, b] = [tags[i]!, tags[j]!];
        const differences = compareTables(digests[a]!, digests[b]!);
        const firstRows: Record<string, string | undefined> = {};
        for (const d of differences) {
          const t = d.split(":")[0]!;
          firstRows[t] = firstDifference(rows[a]!.get(t) ?? [], rows[b]!.get(t) ?? []);
        }
        pairs[`${a}=${b}`] = { identical: differences.length === 0, differences, ...(differences.length === 0 ? {} : { firstRows }) };
      }
      writeFileSync(join(outDir, "compare.json"), `${JSON.stringify({ tags, sha256: Object.fromEntries(tags.map((t) => [t, digests[t]!.sha256])), pairs }, null, 2)}\n`);
      console.log(JSON.stringify({ event: "compare-done", pairs: Object.fromEntries(Object.entries(pairs).map(([k, v]) => [k, v.identical])) }));
      if (Object.values(pairs).some((p) => !p.identical)) process.exitCode = 1;
    } else {
      throw new Error("phase must be live, replay or compare");
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1]?.endsWith("live-range-check.ts")) await main();
