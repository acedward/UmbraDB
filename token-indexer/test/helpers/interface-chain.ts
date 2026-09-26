import { bootstrapChainArchiveSchema } from "../../../chain-archive-sync/bootstrap.js";
import { createClient, type UmbraDBSql } from "../../../src/postgres/client.js";
import { bootstrapTokenIndexSchema } from "../../bootstrap.js";
import { IndexerEventSource } from "../../ingest/events.js";
import { TokenScanner, type ScanBatchOutcome } from "../../ingest/scan.js";
import { PUBLIC_INTERFACE_NAME_HEX } from "../../interface/event.js";
import type { FakeEvent, FakeEventIndexer } from "./fake-event-indexer.js";
import { fakeLedgerPerTransaction, fakeRawEvent, type FakeCallSpec, type FakeLedgerSpecs } from "./fake-ledger.js";
import { seedSyntheticTransaction } from "./synthetic-archive.js";

/**
 * Project 00024-02 — synthetic chains that PUBLISH public interfaces, run through the real scanner:
 * fake ledger (the calls and their `log` counts per intent and phase) → real `TokenScanner` → real
 * `IndexerEventSource` over HTTP to the fake indexer (typed name + payload + `raw` per part) → the
 * [Y] reader → `applyInterfacePublication`.
 *
 * Payloads are built here by hand (commitment ‖ URL bytes, zero padded to 256·k) — never with the
 * decoder under test — so a test's expectations do not share the code they check.
 */

export const NET = "undeployed";

/** [B]'s pointer as the contract emits it: `commitment ‖ utf8(url)`, zero padded to `256 · k`. */
export function publicationPayload(commitment: Buffer, url: string | Buffer): Buffer {
  if (commitment.length !== 32) throw new Error("test payload: the commitment is 32 bytes");
  const urlBytes = typeof url === "string" ? Buffer.from(url, "utf8") : url;
  const parts = Math.max(1, Math.ceil((32 + urlBytes.length) / 256));
  const out = Buffer.alloc(256 * parts);
  commitment.copy(out, 0);
  urlBytes.copy(out, 32);
  return out;
}

/** The 256-byte parts of a payload, in order. */
export function partsOf(payload: Buffer): Buffer[] {
  return Array.from({ length: payload.length / 256 }, (_v, i) => payload.subarray(i * 256, (i + 1) * 256));
}

/** The ledger trims trailing zeros off a logged value; a source may serve a part that short. */
export function trimmed(part: Buffer): string {
  let end = part.length;
  while (end > 0 && part[end - 1] === 0) end--;
  return part.subarray(0, end).toString("hex");
}

export interface PartSpec {
  id: number;
  payload: Buffer;
  phase?: "guaranteed" | "fallible";
}

/** One publication: its parts in one intent (all parts share the segment — [Y] §4). */
export interface PublicationSpec {
  segment: number;
  parts: PartSpec[];
  /** Serve parts with trailing zeros trimmed (as the ledger stores them). */
  trimmed?: boolean;
}

export interface PublishTxSpec {
  txHash: string;
  blockHeight: number;
  position?: number;
  contract: string;
  publications: PublicationSpec[];
  /** Maintenance updates of these contracts in this transaction (task C7). */
  maintenance?: string[];
  /** Other calls in this transaction (a mint, say, so the contract has a token — task C8). */
  extraCalls?: FakeCallSpec[];
  result?: "success" | "partial_success" | "failure";
}

/** `publishBundle` calls: one per part, each logging one event in its part's phase. */
function callsOf(tx: PublishTxSpec): FakeCallSpec[] {
  const calls: FakeCallSpec[] = [];
  for (const pub of tx.publications) {
    for (const part of pub.parts) {
      const fallible = part.phase === "fallible";
      calls.push({
        address: tx.contract, entryPoint: "publishBundle", segment: pub.segment,
        guaranteed: { logOps: fallible ? 0 : 1 },
        ...(fallible ? { fallible: { logOps: 1 } } : {}),
      });
    }
  }
  return calls;
}

export class InterfaceChain {
  private counter = 0;
  readonly open: UmbraDBSql[] = [];

  constructor(private readonly pgUrl: () => string, private readonly indexer: () => FakeEventIndexer) {}

  async freshDb(prefix = "pi"): Promise<{ sql: UmbraDBSql; schema: string; archiveSchema: string }> {
    const id = this.counter++;
    const schema = `token_${prefix}_${id}`;
    const archiveSchema = `arch_${prefix}_${id}`;
    const sql = createClient({ connectionString: this.pgUrl(), schema });
    this.open.push(sql);
    await bootstrapChainArchiveSchema(sql, archiveSchema);
    await bootstrapTokenIndexSchema(sql, { schema, net: NET });
    return { sql, schema, archiveSchema };
  }

  async closeAll(): Promise<void> {
    while (this.open.length > 0) await this.open.pop()!.end({ timeout: 5 });
  }

  /** Registers every part of `tx` with the fake indexer: typed name and payload, and `raw`. */
  serve(tx: PublishTxSpec): void {
    const events: FakeEvent[] = [];
    for (const pub of tx.publications) {
      for (const part of pub.parts) {
        events.push({
          id: part.id, contractAddress: tx.contract, txHash: tx.txHash, blockHeight: tx.blockHeight,
          nameHex: PUBLIC_INTERFACE_NAME_HEX,
          payloadHex: pub.trimmed === true ? trimmed(part.payload) : part.payload.toString("hex"),
          rawHex: fakeRawEvent({
            txHash: tx.txHash, segment: pub.segment, address: tx.contract, nameHex: PUBLIC_INTERFACE_NAME_HEX,
            payloadHex: part.payload.toString("hex"), entryPoint: "publishBundle",
          }),
        });
      }
    }
    const key = `${tx.txHash}:${tx.contract}`;
    this.indexer().events.set(key, [...(this.indexer().events.get(key) ?? []), ...events]);
  }

  /** Archives every transaction, serves its events and scans until the scanner is at the tip. */
  async scan(
    db: { sql: UmbraDBSql; schema: string; archiveSchema: string }, txs: PublishTxSpec[],
  ): Promise<ScanBatchOutcome[]> {
    const specs: Record<string, FakeLedgerSpecs> = {};
    for (const tx of txs) {
      specs[tx.txHash] = {
        calls: [...callsOf(tx), ...(tx.extraCalls ?? [])],
        maintenance: (tx.maintenance ?? []).map((address) => ({ address, segment: 1 })),
      };
      await seedSyntheticTransaction(db.sql, db.archiveSchema, NET, {
        txHash: tx.txHash, blockHeight: tx.blockHeight, position: tx.position ?? 0,
        result: tx.result ?? "success", segments: null, marker: tx.txHash,
      });
      this.serve(tx);
    }
    const scanner = new TokenScanner({
      sql: db.sql, schema: db.schema, archiveSchema: db.archiveSchema, net: NET,
      eventSource: new IndexerEventSource({ url: this.indexer().url }),
      ledger: fakeLedgerPerTransaction(specs),
    });
    const outcomes: ScanBatchOutcome[] = [];
    for (let i = 0; i < 20; i++) {
      const outcome = await scanner.scanOnce();
      outcomes.push(outcome);
      if (outcome.atTip) break;
    }
    return outcomes;
  }
}

export interface PublicationRow {
  eventId: number;
  partEventIds: number[];
  parts: number;
  segment: number;
  phase: string;
  txHash: string;
  blockHeight: number;
  txPosition: number;
  commitment: string;
  url: string | null;
  urlError: string | null;
  status: string;
}

/** Every stored publication of `net`, in P2 order. */
export async function publications(db: { sql: UmbraDBSql; schema: string }): Promise<PublicationRow[]> {
  const rows = await db.sql<{
    event_id: string; part_event_ids: string[]; parts: number; segment: number; phase: string;
    tx_hash: Buffer; block_height: string; tx_position: number; commitment: Buffer;
    url: string | null; url_error: string | null; status: string;
  }[]>`
    SELECT event_id::text, part_event_ids::text[] AS part_event_ids, parts, segment, phase, tx_hash,
           block_height::text, tx_position, commitment, url, url_error, status
    FROM ${db.sql(db.schema)}.public_interface_events WHERE net = ${NET}
    ORDER BY block_height, tx_position, event_id
  `;
  return rows.map((r) => ({
    eventId: Number(r.event_id), partEventIds: r.part_event_ids.map(Number), parts: r.parts,
    segment: r.segment, phase: r.phase, txHash: r.tx_hash.toString("hex"),
    blockHeight: Number(r.block_height), txPosition: r.tx_position, commitment: r.commitment.toString("hex"),
    url: r.url, urlError: r.url_error, status: r.status,
  }));
}

/** The current publication (first part id) and publication count of one contract, if any. */
export async function currentOf(
  db: { sql: UmbraDBSql; schema: string }, contract: string,
): Promise<{ eventId: number; publications: number } | undefined> {
  const rows = await db.sql<{ event_id: string; publications: number }[]>`
    SELECT event_id::text, publications FROM ${db.sql(db.schema)}.public_interfaces
    WHERE net = ${NET} AND address = ${Buffer.from(contract, "hex")}
  `;
  return rows[0] === undefined ? undefined : { eventId: Number(rows[0].event_id), publications: rows[0].publications };
}
