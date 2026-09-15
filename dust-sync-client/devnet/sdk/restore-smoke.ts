/**
 * The hand-off: the SDK's own deserializer accepts the wrapper this client emits, and the
 * `appliedIndex` in it means what `spec/00016-dust-wallet-sync.md` §5.6 says it means (FR-032,
 * plan D3.4, Story 4 scenario 4).
 *
 * Runs INSIDE the SDK image. Env: `WRAPPER` (path under /out to the JSON `dust:sync --sdk-wrapper`
 * wrote), `INDEXER_MAX_ID` (optional, the indexer's current `maxId`), `OUT_NAME`.
 *
 * ── What it checks, and why this and not a live facade ──────────────────────────────────────
 * It calls the SDK's **own** `makeDefaultV1SerializationCapability().deserialize`, which is the
 * exact function `DustWallet(config).restore(json)` delegates to
 * (`wallet-sdk-dust-wallet/dist/DustWallet.js:81`). If our JSON is wrong in any way the SDK cares
 * about — a field name, a bigint encoded as a number, a state that will not deserialize — this
 * fails here with the SDK's own error. Then it asserts three things about the result:
 *
 *   1. the restored `DustLocalState`'s two roots equal the ones the client proved against the
 *      node, so the hand-off transports the STATE and not merely a well-formed envelope;
 *   2. the restored `progress.appliedIndex` equals the `offset` we emitted — the value `Sync.js`
 *      resubscribes from (`appliedIndex − 1`, inclusive) and drops updates below;
 *   3. how many events the SDK would replay on restore: `maxId − appliedIndex`. That number IS
 *      the hand-off's value. Zero (or a handful) means the wallet resumes at the tip; a number
 *      near `maxId` means our offset was 0 and the SDK will replay history — correct, but the
 *      thing hand-off exists to avoid.
 *
 * Building a live `WalletFacade` instead would prove the same points plus an indexer round trip,
 * at the cost of also needing a shielded and an unshielded snapshot this project does not produce
 * — and the DUST hand-off is what is under test.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { Buffer } from 'buffer';

const OUT = process.env.OUT_DIR ?? '/out';
const OUT_NAME = process.env.OUT_NAME ?? 'restore-smoke.json';
const WRAPPER = process.env.WRAPPER ?? `${OUT}/sdk-wrapper.json`;
const INDEXER_MAX_ID = process.env.INDEXER_MAX_ID === undefined ? undefined : Number(process.env.INDEXER_MAX_ID);

const log = (m: string): void => {
  console.log(`[restore-smoke] ${new Date().toISOString()} ${m}`);
};

/**
 * `Serialization.js` is not re-exported from the package's `./v1` entry (checked: `dist/v1/index.js`
 * exports CoreWallet, DustWallet, Keys, Sync, Transacting, … but not it), so it is imported by its
 * absolute path inside the image. That is deliberate rather than a workaround: this script's whole
 * point is to run the SDK's OWN deserializer, and reimplementing it here would test nothing.
 */
const SERIALIZATION = '/app/node_modules/@midnightntwrk/wallet-sdk-dust-wallet/dist/v1/Serialization.js';

async function main(): Promise<void> {
  const { makeDefaultV1SerializationCapability } = (await import(SERIALIZATION)) as any;
  mkdirSync(OUT, { recursive: true });
  const text = readFileSync(WRAPPER, 'utf8');
  const wrapper = JSON.parse(text);
  log(`wrapper ${WRAPPER}: networkId=${wrapper.networkId} protocolVersion=${wrapper.protocolVersion} offset=${wrapper.offset}`);

  const capability: any = makeDefaultV1SerializationCapability();
  const result = capability.deserialize(undefined, text);
  // `effect`'s Either: `_tag` is 'Right' on success.
  if (result?._tag !== 'Right') {
    throw new Error(`the SDK refused the wrapper: ${JSON.stringify(result?.left ?? result, null, 2)}`);
  }
  const core: any = result.right;
  const restored: ledger.DustLocalState = core.state;
  const appliedIndex = String(core.progress?.appliedIndex ?? '');

  const roots = {
    commitment: String(restored.commitmentTreeRoot()),
    generation: String(restored.generatingTreeRoot()),
  };
  const ours = ledger.DustLocalState.deserialize(new Uint8Array(Buffer.from(wrapper.state, 'hex')));
  const oursRoots = {
    commitment: String(ours.commitmentTreeRoot()),
    generation: String(ours.generatingTreeRoot()),
  };
  const report = {
    wrapper: WRAPPER,
    accepted: true,
    networkId: String(wrapper.networkId),
    protocolVersion: String(wrapper.protocolVersion),
    offsetEmitted: String(wrapper.offset),
    appliedIndexAfterRestore: appliedIndex,
    appliedIndexMatchesOffset: appliedIndex === String(wrapper.offset),
    roots,
    rootsMatchWrapperState: roots.commitment === oursRoots.commitment && roots.generation === oursRoots.generation,
    utxos: (restored.utxos as any[]).length,
    indexerMaxId: INDEXER_MAX_ID ?? null,
    /** What the SDK would replay on restore. The point of the whole hand-off. */
    eventsTheSdkWouldReplay: INDEXER_MAX_ID === undefined ? null : INDEXER_MAX_ID - Number(appliedIndex || '0'),
    resumesFrom: `${Number(appliedIndex || '0') - 1} (inclusive, Sync.js 105–135)`,
  };
  writeFileSync(`${OUT}/${OUT_NAME}`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (!report.appliedIndexMatchesOffset) throw new Error('the restored appliedIndex is not the offset we emitted');
  if (!report.rootsMatchWrapperState) throw new Error('the restored state has different roots');
  restored.free();
  ours.free();
  log('the SDK accepted the wrapper, kept both roots and took our appliedIndex');
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('[restore-smoke] FAILED:', error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
