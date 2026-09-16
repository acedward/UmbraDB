/**
 * Dumps the indexer's whole `dustLedgerEvents` stream as `(id, sha256(raw))` pairs, so the
 * hand-off's numbering question can be answered with data instead of a guess
 * (`spec/00016-dust-wallet-sync.md` §5.6, plan D3.4).
 *
 * The question is narrow and consequential: §5.6's `appliedIndex` is the INDEXER's event id, and
 * `Sync.js` drops every update at or below it. If our `chain_archive.dust_events.id` happened to
 * be the same number, the hand-off could use it directly; if it differs by a constant, the offset
 * can be applied; if the relationship is neither, the only safe `appliedIndex` is one the indexer
 * itself reported — and emitting our id would make a restored wallet SKIP events, which is silent
 * corruption of a balance, not a slow sync.
 *
 * Hashes rather than raw bytes so the output stays small and can be joined against
 * `encode(sha256(raw), 'hex')` computed in PostgreSQL over our own table: the join is on CONTENT,
 * which is the only thing the two systems provably share.
 *
 * Env: `MN_INDEXER_WS_URL`, `OUT_NAME`, `STREAM_TIMEOUT_MS`.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import { Buffer } from 'buffer';

const OUT = process.env.OUT_DIR ?? '/out';
const OUT_NAME = process.env.OUT_NAME ?? 'indexer-event-ids.json';
const WS_URL = process.env.MN_INDEXER_WS_URL ?? '';
const STREAM_TIMEOUT_MS = Number(process.env.STREAM_TIMEOUT_MS ?? 300_000);
if (WS_URL === '') throw new Error('MN_INDEXER_WS_URL is required');

const log = (m: string): void => {
  console.log(`[indexer-event-ids] ${new Date().toISOString()} ${m}`);
};

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const events: { id: number; sha256: string; bytes: number }[] = [];
  let maxId = 0;
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(WS_URL, 'graphql-transport-ws');
    const finish = (): void => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* closing anyway */
      }
      resolve();
    };
    const timer = setTimeout(() => {
      log(`stream timeout with ${events.length} event(s)`);
      finish();
    }, STREAM_TIMEOUT_MS);
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
        const event = message.payload.data.dustLedgerEvents;
        const raw = Buffer.from(String(event.raw), 'hex');
        events.push({ id: event.id, sha256: createHash('sha256').update(raw).digest('hex'), bytes: raw.length });
        maxId = event.maxId;
        if (event.id >= event.maxId) finish();
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

  const report = {
    source: 'indexer dustLedgerEvents',
    streamed: events.length,
    firstId: events[0]?.id ?? null,
    lastId: events[events.length - 1]?.id ?? null,
    maxId,
    /** True when the ids are 1,2,3,… over THIS stream — i.e. a per-stream counter rather than a
     *  shared ledger-event sequence. */
    idsAreDenseOverThisStream: events.every((event, index) => event.id === index + 1),
    events,
  };
  writeFileSync(`${OUT}/${OUT_NAME}`, `${JSON.stringify(report, null, 2)}\n`);
  log(
    `${events.length} event(s), ids ${report.firstId}…${report.lastId} (maxId ${maxId}); ` +
      `dense over this stream: ${report.idsAreDenseOverThisStream}`,
  );
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('[indexer-event-ids] FAILED:', error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  },
);
