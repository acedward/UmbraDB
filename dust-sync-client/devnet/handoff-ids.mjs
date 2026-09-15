#!/usr/bin/env node
/**
 * Answers §5.6's `appliedIndex` question with the whole data set instead of three samples
 * (`spec/00016-dust-wallet-sync.md` §5.6, plan D3.4's VERIFY).
 *
 *   node dust-sync-client/devnet/handoff-ids.mjs
 *
 * It streams the indexer's complete `dustLedgerEvents` (via `devnet/sdk/indexer-event-ids.ts`),
 * reads our own `chain_archive.dust_events` with the SAME hash function applied to the same bytes,
 * and joins the two on CONTENT. Then it reports, per our event and per block:
 *
 *   - whether every one of our events appears in the indexer's stream (it must: FR-002 says our
 *     `raw` is `Event.serialize()`, which is exactly what the indexer streams);
 *   - what the indexer's `id` is for each of our ids, and whether the difference is constant;
 *   - which events the indexer has that we do not (we capture three tags; the stream carries
 *     others — question Q-9);
 *   - the same comparison at the END of three blocks, which is the form plan D3.4 asks for.
 *
 * The output decides what `dust:sync --applied-index` may be given: our own id (only if the
 * numbering is identical), our id plus a constant, or — the safe answer — an id the indexer itself
 * reported, which is what `golden-at-event-id.ts` measures for one event.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STATE_FILE = process.env.DEVNET_STATE_FILE ?? "/media/eddie/mn-nvme/00016/devnet/state.json";
const log = (message) => process.stdout.write(`${message}\n`);

if (!existsSync(STATE_FILE)) {
  log(`no devnet recorded at ${STATE_FILE}`);
  process.exit(2);
}
const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
const out = join(state.dir, "out");

log("streaming the indexer's whole dustLedgerEvents…");
const stream = spawnSync(
  "bash",
  ["dust-sync-client/devnet/sdk-run.sh", "indexer-event-ids.ts", "OUT_NAME=indexer-event-ids.json"],
  { cwd: repoRoot, encoding: "utf8" },
);
if (stream.status !== 0) {
  log(stream.stdout ?? "");
  log(stream.stderr ?? "");
  process.exit(1);
}
const indexer = JSON.parse(readFileSync(join(out, "indexer-event-ids.json"), "utf8"));

function psql(sql) {
  const result = spawnSync(
    "docker",
    ["exec", "-i", `${state.project}-postgres-1`, "psql", "-At", "-F", "\t", "-U", "umbra", "-d", "umbra", "-f", "-"],
    { input: sql, encoding: "utf8" },
  );
  return (result.stdout ?? "").trim();
}

// The same bytes, the same hash: `raw` is `Event.serialize()` on both sides (FR-002).
const ours = psql(
  `select id, block_height, kind, encode(sha256(raw), 'hex') from chain_archive.dust_events ` +
    `where net = '${state.net}' order by id;`,
)
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => {
    const [id, height, kind, sha256] = line.split("\t");
    return { id: Number(id), height: Number(height), kind: Number(kind), sha256 };
  });

const indexerByHash = new Map();
for (const event of indexer.events) {
  if (!indexerByHash.has(event.sha256)) indexerByHash.set(event.sha256, []);
  indexerByHash.get(event.sha256).push(event.id);
}
const ourHashes = new Set(ours.map((row) => row.sha256));

const pairs = [];
let missing = 0;
for (const row of ours) {
  const candidates = indexerByHash.get(row.sha256) ?? [];
  if (candidates.length === 0) {
    missing += 1;
    continue;
  }
  // A duplicate raw is possible in principle; take the candidate in stream order.
  pairs.push({ ourId: row.id, indexerId: candidates.shift(), height: row.height, kind: row.kind });
}
const offsets = new Set(pairs.map((pair) => pair.indexerId - pair.ourId));
const extra = indexer.events.filter((event) => !ourHashes.has(event.sha256));

// Plan D3.4's own form: the comparison at the END of three blocks.
const heights = [...new Set(pairs.map((pair) => pair.height))].sort((a, b) => a - b);
const sampleHeights = [heights[0], heights[Math.floor(heights.length / 2)], heights[heights.length - 1]].filter(
  (height) => height !== undefined,
);
const atBlockEnds = sampleHeights.map((height) => {
  const inBlock = pairs.filter((pair) => pair.height === height);
  const last = inBlock[inBlock.length - 1];
  return {
    height,
    ourLastId: last?.ourId ?? null,
    indexerIdOfThatEvent: last?.indexerId ?? null,
    difference: last === undefined ? null : last.indexerId - last.ourId,
  };
});

const verdict =
  missing > 0
    ? "OUR EVENTS ARE NOT ALL IN THE INDEXER'S STREAM — investigate before trusting any mapping"
    : offsets.size === 1 && [...offsets][0] === 0
      ? "IDENTICAL: our id IS the indexer's id"
      : offsets.size === 1
        ? `CONSTANT OFFSET ${[...offsets][0]}: our id + offset is the indexer's id`
        : "UNRELATED: the difference is not constant — appliedIndex must come from the indexer";

const report = {
  ourEvents: ours.length,
  indexerEvents: indexer.streamed,
  indexerIdRange: [indexer.firstId, indexer.lastId],
  indexerIdsAreDenseOverItsOwnStream: indexer.idsAreDenseOverThisStream,
  matchedByContent: pairs.length,
  ourEventsMissingFromTheStream: missing,
  indexerEventsWeDoNotCapture: extra.length,
  distinctDifferences: [...offsets].sort((a, b) => a - b).slice(0, 20),
  atBlockEnds,
  verdict,
};
writeFileSync(join(out, "handoff-ids.json"), `${JSON.stringify({ ...report, pairs }, null, 2)}\n`);

log("");
log(`our events                    ${report.ourEvents}`);
log(`indexer events                ${report.indexerEvents} (ids ${indexer.firstId}…${indexer.lastId}, maxId ${indexer.maxId})`);
log(`indexer ids dense over stream ${report.indexerIdsAreDenseOverItsOwnStream}`);
log(`matched by content            ${report.matchedByContent}`);
log(`ours missing from the stream  ${report.ourEventsMissingFromTheStream}`);
log(`stream events we do not keep  ${report.indexerEventsWeDoNotCapture}`);
log(`distinct (indexerId − ourId)  ${report.distinctDifferences.join(", ")}`);
log("");
log("at three block ends (plan D3.4's own form):");
for (const row of atBlockEnds) {
  log(`  height ${row.height}: our last id ${row.ourLastId} ↔ indexer id ${row.indexerIdOfThatEvent} (difference ${row.difference})`);
}
log("");
log(`VERDICT: ${verdict}`);
log(`written to ${join(out, "handoff-ids.json")}`);
