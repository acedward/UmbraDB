/**
 * N fee-paying unshielded NIGHT self-transfers, one after another, each awaited until the wallet
 * itself has seen the fee spend (plan D3.3 step 4, spec §7's wallet (b)).
 *
 * Every transfer pays its fee in DUST, so every transfer produces exactly one
 * `dustSpendProcessed` for this wallet — which is the point: it builds the 100-link spend chain
 * the client has to follow, and the SDK has to replay. The NIGHT goes to the wallet's own
 * unshielded address, so nothing but the fee is consumed and the run can be repeated.
 *
 * Runs INSIDE the SDK image (`midnight-1-offers/shielded-night-deploy:local`), attached to the
 * devnet's compose network:
 *
 *   docker run --rm --network <project>_default \
 *     -v <repo>/dust-sync-client/devnet/sdk:/app/live16:ro -v <out>:/out \
 *     -e MN_NODE_URL=http://node:9944 -e MN_INDEXER_URL=http://indexer:8088/api/v4/graphql \
 *     -e MN_INDEXER_WS_URL=ws://indexer:8088/api/v4/graphql/ws \
 *     -e MN_PROOF_SERVER_URL=http://proof-server:6300 \
 *     -e SEED=<hex> -e COUNT=100 --entrypoint sh midnight-1-offers/shielded-night-deploy:local \
 *     -c 'cd /app && bun run live16/self-transfers.ts'
 *
 * ── Awaiting "finality" honestly ────────────────────────────────────────────────────────────
 * `submitTransaction` returns as soon as the node accepts the transaction. What this script waits
 * for instead is the wallet's OWN DUST state changing — the set of DUST UTxO nonces it holds —
 * which happens only after the block is produced AND the indexer has streamed the resulting
 * `dustSpendProcessed` back. That is the same event the archive will capture, so a transfer this
 * script counts as done is one the measurement can actually see.
 *
 * ── Custody ─────────────────────────────────────────────────────────────────────────────────
 * `SEED` arrives in the environment and is never printed, never written to `/out`, and never put
 * in a log line. What is written is public: transaction ids, heights, fees and timings.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { getNetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { MidnightBech32m, UnshieldedAddress } from '@midnightntwrk/wallet-sdk';
import { networkFor, isEnvName } from '../test/support/network.js';
import {
  awaitWalletReady,
  buildWallet,
  deriveUnshieldedAddressFromSeed,
  firstSyncedState,
} from '../test/support/wallet-builder.js';
import { getDustBalance, getNightBalance } from '../test/support/wallet-observations.js';

const OUT = process.env.OUT_DIR ?? '/out';
const env = process.env.MN_ENV ?? 'undeployed';
if (!isEnvName(env)) throw new Error(`MN_ENV must be undeployed|preprod|preview|qanet, got ${env}`);
const SEED = must('SEED');
const COUNT = Number(process.env.COUNT ?? '100');
const AMOUNT = BigInt(process.env.AMOUNT ?? '1000000'); // stars; 1 NIGHT
const SETTLE_TIMEOUT_MS = Number(process.env.SETTLE_TIMEOUT_MS ?? 180_000);
const DUST_WAIT_TIMEOUT_MS = Number(process.env.DUST_WAIT_TIMEOUT_MS ?? 900_000);

function must(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const log = (m: string): void => {
  console.log(`[self-transfers] ${new Date().toISOString()} ${m}`);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The wallet's own DUST UTxO nonces — the thing that changes when a fee is paid. */
const dustNonces = async (ctx: any): Promise<string> => {
  const state: any = await firstSyncedState(ctx.wallet);
  const coins = (state.dust?.availableCoins ?? state.dust?.totalCoins ?? []) as { nonce: bigint }[];
  return coins
    .map((coin) => String(coin.nonce))
    .sort()
    .join(',');
};

async function main(): Promise<void> {
  const cfg = networkFor(env);
  setNetworkId(cfg.networkId);
  mkdirSync(OUT, { recursive: true });
  log(`node=${cfg.node} indexer=${cfg.indexer} proof=${cfg.proofServer} net=${cfg.networkId} count=${COUNT}`);

  const ctx: any = await awaitWalletReady(await buildWallet(cfg, SEED), { requireFunds: true });
  const night = await getNightBalance(ctx);
  log(`NIGHT ${night} stars`);

  // Wait until DUST has generated at all. The exact fee is not knowable before the first
  // transfer, so the budget check below is made against the fee the first one actually paid.
  const dustDeadline = Date.now() + DUST_WAIT_TIMEOUT_MS;
  let dust = await getDustBalance(ctx);
  while (dust === 0n && Date.now() < dustDeadline) {
    log(`DUST 0 specks; waiting for generation…`);
    await sleep(10_000);
    dust = await getDustBalance(ctx);
  }
  if (dust === 0n) throw new Error('the wallet generated no DUST within the timeout');
  log(`DUST ${dust} specks`);

  const ownAddress = deriveUnshieldedAddressFromSeed(SEED);
  let receiver: unknown;
  try {
    receiver = MidnightBech32m.parse(ownAddress.encoded).decode(UnshieldedAddress, getNetworkId());
  } catch {
    receiver = ownAddress.encoded;
  }
  const wallet = ctx.wallet as {
    transferTransaction: (o: unknown, k: unknown, opts: unknown) => Promise<unknown>;
    signRecipe: (r: unknown, sign: (p: Uint8Array) => unknown) => Promise<unknown>;
    finalizeRecipe: (r: unknown) => Promise<unknown>;
    submitTransaction: (t: unknown) => Promise<string>;
  };

  const transfers: Record<string, unknown>[] = [];
  const startedAt = Date.now();
  let feeSeen = 0n;
  for (let i = 0; i < COUNT; i += 1) {
    const before = Date.now();
    const dustBefore = await getDustBalance(ctx);
    if (feeSeen > 0n && dustBefore < feeSeen * 2n) {
      log(`DUST ${dustBefore} is below twice the observed fee ${feeSeen}; waiting for generation…`);
      await sleep(30_000);
    }
    const noncesBefore = await dustNonces(ctx);
    let txId: string;
    try {
      const recipe = await wallet.transferTransaction(
        [{ type: 'unshielded', outputs: [{ type: unshieldedToken().raw, receiverAddress: receiver, amount: AMOUNT }] }],
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl: new Date(Date.now() + 30 * 60_000) },
      );
      const signed = await wallet.signRecipe(recipe, (p: Uint8Array) => ctx.unshieldedKeystore.signData(p));
      const finalized = await wallet.finalizeRecipe(signed);
      txId = await wallet.submitTransaction(finalized);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`transfer ${i + 1} FAILED to submit: ${message}`);
      transfers.push({ index: i + 1, error: message, at: new Date().toISOString() });
      writeFileSync(`${OUT}/transfers.json`, `${JSON.stringify({ count: COUNT, transfers }, null, 2)}\n`);
      throw error;
    }
    const submitted = Date.now();

    // Settle: the wallet's own DUST UTxO set must change, which only happens once the block is
    // produced and the indexer has streamed the spend back.
    const settleDeadline = Date.now() + SETTLE_TIMEOUT_MS;
    let settled = false;
    while (Date.now() < settleDeadline) {
      await sleep(2_000);
      if ((await dustNonces(ctx)) !== noncesBefore) {
        settled = true;
        break;
      }
    }
    const done = Date.now();
    const dustAfter = await getDustBalance(ctx);
    // DUST also GENERATES while the transfer settles, so this is a lower bound on the fee, not the
    // fee. It is recorded because it is the only figure available in the image; the exact `vFee`
    // is in the archive's own spend row.
    const spent = dustBefore > dustAfter ? dustBefore - dustAfter : 0n;
    if (spent > feeSeen) feeSeen = spent;
    transfers.push({
      index: i + 1,
      txId,
      settled,
      submitMs: submitted - before,
      settleMs: done - submitted,
      totalMs: done - before,
      dustBefore: dustBefore.toString(),
      dustAfter: dustAfter.toString(),
      at: new Date(done).toISOString(),
    });
    writeFileSync(`${OUT}/transfers.json`, `${JSON.stringify({ count: COUNT, transfers }, null, 2)}\n`);
    log(
      `transfer ${i + 1}/${COUNT} ${settled ? 'settled' : 'NOT SETTLED (timed out)'} in ${done - before} ms ` +
        `(submit ${submitted - before} ms) tx ${txId}`,
    );
    if (!settled) throw new Error(`transfer ${i + 1} did not settle within ${SETTLE_TIMEOUT_MS} ms`);
  }

  const elapsed = Date.now() - startedAt;
  const summary = {
    net: cfg.networkId,
    count: COUNT,
    amountStars: AMOUNT.toString(),
    elapsedMs: elapsed,
    meanMsPerTransfer: Math.round(elapsed / Math.max(1, COUNT)),
    nightStars: (await getNightBalance(ctx)).toString(),
    dustSpecks: (await getDustBalance(ctx)).toString(),
    transfers,
  };
  writeFileSync(`${OUT}/transfers.json`, `${JSON.stringify(summary, null, 2)}\n`);
  log(`DONE ${COUNT} transfers in ${elapsed} ms (${Math.round(elapsed / Math.max(1, COUNT))} ms each)`);
  await ctx.wallet.stop().catch(() => undefined);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('[self-transfers] FAILED:', error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
