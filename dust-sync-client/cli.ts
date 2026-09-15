#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { loadLedgerV8 } from "../chain-archive-sync/tx-replay-decoder.js";
import { secondsFromDate } from "./src/encode.js";
import { DustSyncError } from "./src/errors.js";
import { DUST_KEY_PATH, dustSecretKeyFromSeed, readSeedFile } from "./src/keys.js";
import type { DustLocalStateLike, DustQdo } from "./src/ledger.js";
import { syncDust, type DustSyncResult } from "./src/sync.js";
import { sdkWrapper } from "./src/wrapper.js";

/**
 * `npm run dust:sync` — the measurement CLI of `spec/00016-dust-wallet-sync.md` Story 6 and plan
 * D3.5.
 *
 * It derives the wallet's DUST secret key from a mode-600 seed file, runs {@link syncDust} against
 * a balancer, and prints ONE JSON object: the phase timings of §5.5 step 10, the request and byte
 * counts, the proved roots, the live UTxOs and `walletBalance` at an instant the caller fixes with
 * `--balance-at`. That last flag is what makes the golden comparison possible at all — the SDK's
 * own state and this one must be priced at the SAME second or their balances differ legitimately.
 *
 * ── What it will not do ─────────────────────────────────────────────────────────────────────
 * Print the seed, the derived key, or any nullifier. The seed file must be mode 600 or the run
 * refuses to start (`keys.ts`). The DUST public key IS printed: it is the identity the wallet
 * sends the node (Q-1) and the golden comparison needs it.
 */

const USAGE = `dust:sync — build a wallet's DUST state from the shielded-monitor node

Usage:
  npm run dust:sync -- --seed-file <path> --url <balancer> --net <net> [options]

Required:
  --seed-file <path>   hex seed, mode 600 (the DUST key is derived at ${DUST_KEY_PATH})
  --url <url>          balancer (or node) base URL, e.g. http://127.0.0.1:12345
  --net <net>          the archive net the node serves, e.g. undeployed / preprod

Options:
  --rtt-ms <n>         client-side delay before every request (spec §7's simulated RTT)
  --balance-at <unix>  price walletBalance at this unix second (default: now)
  --repeat <n>         run the whole sync n times and report every run (default 1)
  --out <path>         write the JSON report here as well as to stdout
  --sdk-wrapper <path> also write the SDK's serialized DUST wallet (§5.6) here, mode 600
  --network-id <id>    SDK networkId for the wrapper (default: --net)
  --protocol-version <n>  SDK protocolVersion for the wrapper (default 1)
  --applied-index <n>  the INDEXER's dustLedgerEvents id of the last applied event; default 0,
                       which makes the SDK replay history rather than risk skipping events
  --max-lag-ms <n>     how long to wait for the mirror to catch up (default 60000)
  --quiet              do not write phase lines to stderr
  --help
`;

interface Args {
  readonly seedFile: string;
  readonly url: string;
  readonly net: string;
  readonly rttMs: number;
  readonly balanceAt: number;
  readonly repeat: number;
  readonly out: string | undefined;
  readonly wrapperOut: string | undefined;
  readonly networkId: string | undefined;
  readonly protocolVersion: bigint;
  readonly appliedIndex: bigint;
  readonly maxLagMs: number;
  readonly quiet: boolean;
}

function parseArgs(argv: readonly string[]): Args | undefined {
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) return undefined;
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const required = (name: string): string => {
    const found = value(name);
    if (found === undefined || found.startsWith("--")) throw new Error(`${name} is required`);
    return found;
  };
  return {
    seedFile: required("--seed-file"),
    url: required("--url"),
    net: required("--net"),
    rttMs: Number(value("--rtt-ms") ?? 0),
    balanceAt: Number(value("--balance-at") ?? Math.floor(Date.now() / 1000)),
    repeat: Number(value("--repeat") ?? 1),
    out: value("--out"),
    wrapperOut: value("--sdk-wrapper"),
    networkId: value("--network-id"),
    protocolVersion: BigInt(value("--protocol-version") ?? "1"),
    appliedIndex: BigInt(value("--applied-index") ?? "0"),
    maxLagMs: Number(value("--max-lag-ms") ?? 60_000),
    quiet: argv.includes("--quiet"),
  };
}

/** A live UTxO in §4's encodings, so the report can be diffed against the SDK's state field by
 *  field (Story 5 / SC-005). */
function utxoView(utxo: DustQdo): Record<string, string | number> {
  return {
    initialValue: utxo.initialValue.toString(10),
    owner: utxo.owner.toString(10),
    nonce: utxo.nonce.toString(10),
    seq: utxo.seq,
    ctime: secondsFromDate(utxo.ctime),
    backingNight: utxo.backingNight,
    mtIndex: utxo.mtIndex.toString(10),
  };
}

function report(
  args: Args,
  publicKey: bigint,
  result: DustSyncResult,
  state: DustLocalStateLike,
): Record<string, unknown> {
  const balanceAt = new Date(args.balanceAt * 1000);
  return {
    net: args.net,
    baseUrl: args.url,
    rttMs: args.rttMs,
    publicKey: publicKey.toString(10),
    keyPath: DUST_KEY_PATH,
    provedAt: result.provedAt,
    roots: result.roots,
    balanceAt: args.balanceAt,
    balance: state.walletBalance(balanceAt).toString(10),
    utxos: [...state.utxos].map(utxoView).sort((a, b) => String(a.mtIndex).localeCompare(String(b.mtIndex))),
    timing: result.timing,
    stats: result.stats,
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args === undefined) {
    process.stdout.write(USAGE);
    return argv.includes("--help") || argv.includes("-h") ? 0 : 2;
  }
  const seed = await readSeedFile(args.seedFile);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ledger: any = await loadLedgerV8();
  const secretKey = dustSecretKeyFromSeed(ledger, seed);
  seed.fill(0);
  const publicKey = secretKey.publicKey;
  const log = args.quiet
    ? undefined
    : (line: string): void => {
        process.stderr.write(`[dust:sync] ${line}\n`);
      };

  const runs: Record<string, unknown>[] = [];
  let last: { result: DustSyncResult; state: DustLocalStateLike } | undefined;
  for (let run = 0; run < Math.max(1, args.repeat); run += 1) {
    last?.state.free();
    const result = await syncDust({
      ledger,
      secretKey,
      baseUrl: args.url,
      net: args.net,
      rttDelayMs: args.rttMs,
      maxLagMs: args.maxLagMs,
      ...(log === undefined ? {} : { logger: log }),
    });
    last = { result, state: result.state };
    runs.push(report(args, publicKey, result, result.state));
  }
  /* c8 ignore next */
  if (last === undefined) return 1;

  const output = runs.length === 1 ? runs[0] : { runs };
  const text = `${JSON.stringify(output, null, 2)}\n`;
  process.stdout.write(text);
  if (args.out !== undefined) writeFileSync(args.out, text);
  if (args.wrapperOut !== undefined) {
    // Mode 600: the wrapper carries no secret, but it IS a wallet's whole state, and the plan's
    // custody rule treats wallet artefacts as owner-only on this shared host.
    writeFileSync(
      args.wrapperOut,
      `${JSON.stringify(
        sdkWrapper(last.state, {
          publicKey,
          networkId: args.networkId ?? args.net,
          protocolVersion: args.protocolVersion,
          appliedIndex: args.appliedIndex,
        }),
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }
  last.state.free();
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof DustSyncError) {
      process.stderr.write(`[dust:sync] FAILED ${error.code}: ${error.message} ${JSON.stringify(error.detail)}\n`);
    } else {
      process.stderr.write(`[dust:sync] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(1);
  },
);
