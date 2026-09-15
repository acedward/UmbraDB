import { readFileSync } from "node:fs";
import { LedgerReplay } from "../../chain-archive-sync/ledger-replay.js";
import { DUST_EVENT_TAGS, mapDustEvents } from "../../chain-archive-sync/dust-events.js";
import { loadLedgerV8 } from "../../chain-archive-sync/tx-replay-decoder.js";

/**
 * SC-007 (`spec/00016-dust-wallet-sync.md`): the DUST capture must cost at most **2 % of block
 * apply time**.
 *
 * WHAT IS MEASURED. The same block applied through `LedgerReplay.applyBlock` twice: once with no
 * capture configured (the behaviour before 00016, byte for byte) and once capturing the three DUST
 * tags. Only the `applyBlock` call is timed; building the replay engine is outside it and common
 * to both arms anyway. The mapping to rows (`mapDustEvents`, including the ledger's own
 * `dustCommitment` per initial UTxO) is timed as a third arm, because it is real ingest work even
 * though it happens after the fold.
 *
 * WHICH BLOCK. The real genesis block: five system transactions producing **78** DUST events. That
 * is the densest block this repo has bytes for, and roughly 130x denser than preprod's average
 * (1.49 M DUST events over ~2.56 M blocks ≈ 0.58 events per block), so the ratio it reports is a
 * hard upper bound rather than a typical case. The per-event figure is printed alongside so the
 * bound can be applied to any other density.
 *
 * NOT A GATE, and NOT a vitest file (no `.test.ts` suffix, so `vitest run` never picks it up):
 * it prints numbers for a human and exits 0. Run it with
 * `npx tsx test/chain-archive-sync/dust-capture-overhead.ts [iterations]`.
 *
 * It lives here rather than under `bench/` because it must import `chain-archive-sync/`, and
 * `test/postgres/no-consumer-import-in-bench.test.ts` forbids exactly that from `bench/` -- that
 * boundary is the indexer-agnostic one, and a measurement is not a reason to open it.
 */

const ITERATIONS = Number(process.argv[2] ?? 200);

const FIXTURE = readFileSync(
  new URL("../fixtures/ledger-vectors/genesis-system-tx-hashes.txt", import.meta.url),
  "utf8",
).trim().split("\n").map((line) => line.trim().split(/\s+/));

const SYSTEM_TXS = FIXTURE.map((f) => ({
  kind: "system" as const,
  rawBytes: new Uint8Array(Buffer.from(f[3]!, "hex")),
}));

const BLOCK = {
  transactions: SYSTEM_TXS,
  blockTimestampMs: 1754395200000,
  parentBlockHashHex: "00".repeat(32),
  parentBlockTimestampMs: 0,
};

/** Median plus mean: a WASM run's mean is dragged by occasional GC pauses, and a 2 % claim decided
 *  by a garbage collection would not be a claim about this code. */
function stats(samples: number[]): { mean: number; p50: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
    p50: sorted[Math.floor(sorted.length / 2)]!,
  };
}

async function main(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ledger: any = await loadLedgerV8();
  const now = (): number => Number(process.hrtime.bigint()) / 1e6;

  const applyArm = (capture: boolean, iterations: number): number[] => {
    const samples: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const replay = LedgerReplay.fromGenesis(
        ledger, "undeployed", capture ? { captureEventTags: DUST_EVENT_TAGS } : {},
      );
      const t0 = now();
      replay.applyBlock(BLOCK);
      samples.push(now() - t0);
    }
    return samples;
  };

  // Warm the WASM and the JIT before either arm is measured; a first-call cost attributed to
  // whichever arm ran first would be the entire result. Interleaved afterwards, so a machine that
  // gets busier partway through does not silently become "the capture is slower".
  applyArm(false, 2);
  applyArm(true, 2);
  const offSamples: number[] = [];
  const onSamples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    offSamples.push(...applyArm(false, 1));
    onSamples.push(...applyArm(true, 1));
  }
  const applyOff = stats(offSamples);
  const applyOn = stats(onSamples);

  // The mapping arms run over ONE captured event list, many times: they are pure CPU on JS objects
  // and need no fresh fold, so paying for 200 more genesis applies to measure them would only add
  // noise. The no-op-commitment arm isolates the ledger's own `dustCommitment` hash, which is the
  // one part of the mapping that is not arithmetic.
  const captureReplay = LedgerReplay.fromGenesis(ledger, "undeployed", {
    captureEventTags: DUST_EVENT_TAGS,
  });
  captureReplay.applyBlock(BLOCK);
  const captured = [...captureReplay.lastBlockEvents!];
  const initialUtxos = captured.filter((e) => e.tag === "dustInitialUtxo").length;
  const mapArm = (commitment: (output: unknown) => bigint | string): number[] => {
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = now();
      mapDustEvents(
        { net: "bench", blockHeight: 0, blockHash: "ab".repeat(32) }, captured, commitment,
      );
      samples.push(now() - t0);
    }
    return samples;
  };
  mapArm(ledger.dustCommitment);
  const mapFull = stats(mapArm(ledger.dustCommitment));
  const mapWithoutCommitment = stats(mapArm(() => 0n));

  const overheadP50 = ((applyOn.p50 - applyOff.p50) / applyOff.p50) * 100;
  const overheadWithMappingP50 = ((applyOn.p50 + mapFull.p50 - applyOff.p50) / applyOff.p50) * 100;

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    iterations: ITERATIONS,
    block: "1.0.0 devnet genesis: 5 system transactions",
    dustEventsPerBlock: captured.length,
    initialUtxosPerBlock: initialUtxos,
    applyMsWithoutCapture: applyOff,
    applyMsWithCapture: applyOn,
    mapMs: mapFull,
    mapMsWithoutDustCommitment: mapWithoutCommitment,
    captureOverheadPercentP50: Number(overheadP50.toFixed(3)),
    captureAndMappingOverheadPercentP50: Number(overheadWithMappingP50.toFixed(3)),
    captureUsPerEvent: Number((((applyOn.p50 - applyOff.p50) / captured.length) * 1000).toFixed(2)),
    mapUsPerEvent: Number(((mapFull.p50 / captured.length) * 1000).toFixed(2)),
    dustCommitmentUsPerInitialUtxo:
      Number((((mapFull.p50 - mapWithoutCommitment.p50) / initialUtxos) * 1000).toFixed(2)),
    sc007Limit: "2 % of block apply time",
  }, null, 1));
}

await main();
