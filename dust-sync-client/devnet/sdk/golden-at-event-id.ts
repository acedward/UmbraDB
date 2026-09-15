/**
 * The golden DUST state **at exactly our tip event**, replayed from the indexer's own
 * `dustLedgerEvents` stream (plan D3.3 step 5b; Phase 4's gate G3 depends on it).
 *
 * ── Why this exists, and why it is not just "sync the SDK wallet" ───────────────────────────
 * The SDK syncs to the CHAIN TIP. Our archive sits wherever its ingest has reached — on preprod
 * that will be a height well below the tip for the whole of this project (plan §6, gate G3). A
 * comparison between a state at the chain tip and a state at our height would differ for a
 * completely uninteresting reason, and would hide any real difference underneath it.
 *
 * So this script replays the indexer's events with the wallet's own key and STOPS at the event
 * that corresponds to our mirror's tip — producing the state the SDK would have had at exactly
 * that point. Both roots, every live UTxO field and `walletBalance` at a caller-fixed instant are
 * then comparable with `dust:sync`'s output, one for one.
 *
 * ── How the target event is named ───────────────────────────────────────────────────────────
 * By its RAW BYTES, not by an id. Plan D3.3 says `(txHash, eventIndex)`; the indexer's
 * `DustLedgerEvent` turns out to expose only `{ id, raw, maxId, protocolVersion }` (introspected
 * on the devnet indexer, 2026-09-15), so a transaction hash is not available on this stream at
 * all. The raw bytes are a strictly better identifier anyway: they are exactly what the archive
 * stores (`dust_events.raw` is `Event.serialize()`, FR-002) and they are what both sides replay,
 * so matching on them compares the two systems' CONTENT rather than trusting either's numbering.
 *
 * That numbering question is the other thing this script answers: it reports the indexer's own
 * `id` for the target event and the ordinal of that event in the stream, which is what §5.6's
 * `appliedIndex` hand-off needs and what plan D3.4 asks to be VERIFIED rather than assumed.
 *
 * Env: `SEED` (hex, from a mode-600 file — never printed), `TARGET_RAW` (hex of our tip event's
 * raw bytes; optional — without it the whole stream is replayed), `TARGET_ORDINAL` (1-based
 * position of that event in OUR sequence, optional, cross-checked against the match),
 * `BALANCE_AT` (unix seconds, default now), `OUT_NAME` (file name under OUT_DIR),
 * `MN_INDEXER_WS_URL`, `STREAM_TIMEOUT_MS`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { HDWallet, Roles } from '@midnightntwrk/wallet-sdk';
import { Buffer } from 'buffer';

const OUT = process.env.OUT_DIR ?? '/out';
const OUT_NAME = process.env.OUT_NAME ?? 'golden-at-event.json';
const SEED = must('SEED');
const TARGET_RAW = process.env.TARGET_RAW?.trim().toLowerCase() ?? '';
const TARGET_ORDINAL = process.env.TARGET_ORDINAL === undefined ? undefined : Number(process.env.TARGET_ORDINAL);
const BALANCE_AT = Number(process.env.BALANCE_AT ?? Math.floor(Date.now() / 1000));
const WS_URL = must('MN_INDEXER_WS_URL');
const STREAM_TIMEOUT_MS = Number(process.env.STREAM_TIMEOUT_MS ?? 300_000);
const BATCH = Number(process.env.REPLAY_BATCH ?? 1_000);

function must(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const log = (m: string): void => {
  console.log(`[golden-at-event] ${new Date().toISOString()} ${m}`);
};

function dustSecretKey(seedHex: string): ledger.DustSecretKey {
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hd.type !== 'seedOk') throw new Error('HDWallet.fromSeed failed');
  const derived = hd.hdWallet.selectAccount(0).selectRoles([Roles.Dust]).deriveKeysAt(0);
  if (derived.type !== 'keysDerived') throw new Error('deriveKeysAt failed');
  const sk = ledger.DustSecretKey.fromSeed(derived.keys[Roles.Dust] as Uint8Array);
  hd.hdWallet.clear();
  return sk;
}

interface StreamEvent {
  readonly id: number;
  readonly raw: string;
  readonly maxId: number;
}

/** One subscription, from the very start, stopped as soon as the target has been seen. */
async function collect(): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(WS_URL, 'graphql-transport-ws');
    const timer = setTimeout(() => {
      log(`stream timeout after ${STREAM_TIMEOUT_MS} ms with ${events.length} event(s)`);
      try {
        socket.close();
      } catch {
        /* closing anyway */
      }
      resolve();
    }, STREAM_TIMEOUT_MS);
    const finish = (): void => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* closing anyway */
      }
      resolve();
    };
    socket.on('open', () => socket.send(JSON.stringify({ type: 'connection_init' })));
    socket.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'connection_ack') {
        socket.send(
          JSON.stringify({
            id: '1',
            type: 'subscribe',
            payload: { query: 'subscription { dustLedgerEvents { id raw maxId } }' },
          }),
        );
        return;
      }
      if (message.type === 'next') {
        const event = message.payload.data.dustLedgerEvents as StreamEvent;
        events.push({ id: event.id, raw: String(event.raw).toLowerCase(), maxId: event.maxId });
        if (events.length % 500 === 0) log(`…${events.length} events (indexer id ${event.id}/${event.maxId})`);
        if (TARGET_RAW !== '' && events[events.length - 1]!.raw === TARGET_RAW) finish();
        else if (TARGET_RAW === '' && event.id >= event.maxId) finish();
        return;
      }
      if (message.type === 'error') {
        clearTimeout(timer);
        reject(new Error(JSON.stringify(message.payload)));
      }
    });
    socket.on('error', (error: unknown) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
  return events;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  log(`ws=${WS_URL} target=${TARGET_RAW === '' ? '(whole stream)' : `${TARGET_RAW.slice(0, 16)}… (${TARGET_RAW.length / 2} B)`}`);
  const t0 = Date.now();
  const events = await collect();
  const streamMs = Date.now() - t0;
  if (events.length === 0) throw new Error('the indexer produced no DUST events');
  const last = events[events.length - 1]!;
  if (TARGET_RAW !== '' && last.raw !== TARGET_RAW) {
    throw new Error(`the target event was not reached; the stream ended at indexer id ${last.id}`);
  }
  if (TARGET_ORDINAL !== undefined && TARGET_ORDINAL !== events.length) {
    // Not fatal: it is exactly the finding this script exists to report. A mismatch means the two
    // systems do not count the same events, and the hand-off's `appliedIndex` must NOT be taken
    // from our numbering.
    log(`WARNING: our ordinal for this event is ${TARGET_ORDINAL}, the indexer's stream position is ${events.length}`);
  }

  const sk = dustSecretKey(SEED);
  const params = ledger.LedgerParameters.initialParameters().dust;
  let state = new ledger.DustLocalState(params);
  const replayStart = Date.now();
  for (let i = 0; i < events.length; i += BATCH) {
    const batch = events.slice(i, i + BATCH).map((event) => Buffer.from(event.raw, 'hex'));
    const next = state.replayRawEvents(sk, Buffer.concat(batch)).state;
    state.free();
    state = next;
  }
  const replayMs = Date.now() - replayStart;

  const at = new Date(BALANCE_AT * 1000);
  const utxos = (state.utxos as any[])
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
    source: 'indexer dustLedgerEvents replay, stopped at the target event',
    publicKey: (sk.publicKey as bigint).toString(10),
    events: events.length,
    indexerFirstId: events[0]!.id,
    indexerLastId: last.id,
    indexerMaxId: last.maxId,
    /** What §5.6's `appliedIndex` must be for THIS state. */
    appliedIndex: last.id,
    ourOrdinal: TARGET_ORDINAL ?? null,
    /** `indexerLastId − ourOrdinal`: 0 means the two numberings agree. */
    offsetVsOurOrdinal: TARGET_ORDINAL === undefined ? null : last.id - TARGET_ORDINAL,
    streamMs,
    replayMs,
    balanceAt: BALANCE_AT,
    balance: state.walletBalance(at).toString(10),
    roots: {
      commitment: events.length === 0 ? null : String(state.commitmentTreeRoot()),
      generation: events.length === 0 ? null : String(state.generatingTreeRoot()),
    },
    utxos,
  };
  writeFileSync(`${OUT}/${OUT_NAME}`, `${JSON.stringify(report, null, 2)}\n`);
  log(
    `replayed ${events.length} event(s) in ${replayMs} ms (stream ${streamMs} ms); ` +
      `${utxos.length} live UTxO(s); indexer id of the target: ${last.id}`,
  );
  console.log(JSON.stringify(report, null, 2));
  state.free();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('[golden-at-event] FAILED:', error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
