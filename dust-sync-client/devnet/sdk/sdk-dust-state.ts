/**
 * The SDK's own DUST state, and how long its own sync took (plan D3.3 step 5; spec Story 5).
 *
 * This is the baseline the whole project is measured against: the wallet SDK builds the same
 * `DustLocalState` by replaying every DUST ledger event of the chain through its indexer
 * subscription — 123 minutes on preprod (spec §0) — and this script records what it ended up with
 * so the client's state can be compared to it field by field.
 *
 * It is `resources/00013-preprod-sync-tools/wallet-sync-timing.ts` plus the three things that
 * harness does not do (its gaps are written up as question Q-17): it reaches the DUST state
 * through `wallet.dust.serializeState()` rather than through a cache nothing writes, it reads the
 * DUST balance through `state.dust.balance(date)` (the member this SDK line actually has), and it
 * prices that balance at a caller-fixed `BALANCE_AT` so the comparison with `dust:sync` is made at
 * the SAME instant — DUST generates continuously, so two states read a minute apart differ
 * legitimately and the comparison would be worthless.
 *
 * Env: `SEED` (hex, never printed), `BALANCE_AT` (unix seconds, default now), `OUT_NAME`,
 * `MN_ENV`, the `MN_*` endpoint overrides, `SYNC_TIMEOUT_MS`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { Buffer } from 'buffer';
import { networkFor, isEnvName } from '../test/support/network.js';
import { buildWallet, waitForSync } from '../test/support/wallet-builder.js';

const OUT = process.env.OUT_DIR ?? '/out';
const OUT_NAME = process.env.OUT_NAME ?? 'sdk-dust-state.json';
const env = process.env.MN_ENV ?? 'undeployed';
if (!isEnvName(env)) throw new Error(`MN_ENV must be undeployed|preprod|preview|qanet, got ${env}`);
const SEED = must('SEED');
const BALANCE_AT = Number(process.env.BALANCE_AT ?? Math.floor(Date.now() / 1000));
const SYNC_TIMEOUT_MS = Number(process.env.SYNC_TIMEOUT_MS ?? 30 * 60_000);

function must(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const log = (m: string): void => {
  console.log(`[sdk-dust-state] ${new Date().toISOString()} ${m}`);
};
/** The SDK's `progress` carries `bigint`s, which `JSON.stringify` refuses outright. Decimal
 *  strings, the same encoding spec §4 uses for every other magnitude. */
const json = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString(10) : item), 2);

async function main(): Promise<void> {
  const cfg = networkFor(env);
  mkdirSync(OUT, { recursive: true });
  log(`env=${cfg.networkId} indexer=${cfg.indexer} node=${cfg.node} balanceAt=${BALANCE_AT}`);

  const t0 = Date.now();
  const ctx: any = await buildWallet(cfg, SEED);
  const built = Date.now();
  log(`wallet built in ${built - t0} ms (restoredFromCache=${ctx.restoredFromCache})`);
  const state: any = await waitForSync(ctx.wallet, SYNC_TIMEOUT_MS);
  const synced = Date.now();
  log(`SYNCED after ${synced - t0} ms`);

  // The SDK's serialized DUST wallet (`wallet-sdk-dust-wallet/dist/v1/Serialization.js`):
  // `{ publicKey: { publicKey }, state: <hex of DustLocalState.serialize()>, protocolVersion,
  //    networkId, offset }` — `offset` being the INDEXER's dustLedgerEvents id it has applied.
  const serialized = JSON.parse(await ctx.wallet.dust.serializeState());
  const local = ledger.DustLocalState.deserialize(new Uint8Array(Buffer.from(serialized.state, 'hex')));
  const at = new Date(BALANCE_AT * 1000);
  const utxos = (local.utxos as any[])
    .map((utxo) => ({
      initialValue: String(utxo.initialValue),
      owner: String(utxo.owner),
      nonce: String(utxo.nonce),
      seq: Number(utxo.seq),
      ctime: Math.floor(new Date(utxo.ctime).getTime() / 1000),
      backingNight: String(utxo.backingNight),
      mtIndex: String(utxo.mtIndex),
    }))
    .sort((a, b) => a.mtIndex.localeCompare(b.mtIndex));

  const report = {
    source: 'wallet SDK, its own sync',
    net: cfg.networkId,
    publicKey: String(serialized.publicKey.publicKey),
    protocolVersion: String(serialized.protocolVersion),
    networkId: String(serialized.networkId),
    /** The SDK's own `appliedIndex`: the indexer's dustLedgerEvents id it stopped at (§5.6). */
    appliedIndex: serialized.offset === undefined ? null : String(serialized.offset),
    buildMs: built - t0,
    syncMs: synced - built,
    elapsedMs: synced - t0,
    progress: {
      dust: state?.dust?.progress ?? null,
      unshielded: state?.unshielded?.progress ?? null,
      shielded: state?.shielded?.progress ?? null,
    },
    balanceAt: BALANCE_AT,
    /** Computed from the restored `DustLocalState`, so it is the SAME function the client's
     *  report uses — `state.dust.balance(at)` is recorded next to it as a cross-check. */
    balance: local.walletBalance(at).toString(10),
    balanceViaFacade: String(state?.dust?.balance ? state.dust.balance(at) : ''),
    roots: {
      commitment: utxosOrTree(local.commitmentTreeRoot()),
      generation: utxosOrTree(local.generatingTreeRoot()),
    },
    utxos,
    nightStars: String(state?.unshielded?.balances?.[ledger.unshieldedToken().raw] ?? '0'),
  };
  writeFileSync(`${OUT}/${OUT_NAME}`, `${json(report)}\n`);
  // The serialized wrapper itself, so the hand-off (§5.6) can be driven from a real SDK snapshot.
  writeFileSync(`${OUT}/${OUT_NAME.replace(/\.json$/, '')}-wrapper.json`, `${json(serialized)}\n`, { mode: 0o600 });
  log(`${utxos.length} live UTxO(s); appliedIndex ${report.appliedIndex}; written to ${OUT}/${OUT_NAME}`);
  console.log(json({ ...report, utxos: utxos.length }));
  local.free();
  await ctx.wallet.stop().catch(() => undefined);
}

function utxosOrTree(root: unknown): string | null {
  return root === undefined || root === null ? null : String(root);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('[sdk-dust-state] FAILED:', error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
