import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadLedgerV9 } from "../../chain-archive-sync/tx-replay-decoder.js";
import { pad32 } from "../color.js";
import { decodeTokenFlows } from "../ingest/decode.js";
import {
  emissionByAddress, multipartPartEvents, normalizeEvent, type IndexerContractEvent, type LookupPair,
} from "../ingest/events.js";
import { readPackages } from "../ingest/packages.js";

/**
 * Project 00024-01 task B2 — `[[multipart-segment-from-raw]]`: each event's intent comes from its
 * OWN `raw` ledger event (`EventSource.physicalSegment`, spec Q4/FR-003), decoded with the real
 * ledger-v9 — checked against the raw TRANSACTION it came from, on the live [Y] examples recorded
 * read-only from the public Stagenet indexer (`fixtures/multipart-stagenet/SOURCE.md`).
 *
 * `example:message[v1]` is not a name this indexer opts in; it is opted in HERE, in a test
 * configuration (spec US2), so the recorded packages can be reproduced with the SHA-256s [Y] PR #1
 * reports. The whole production path runs: `normalizeEvent` (the GraphQL shape), the emission plan
 * from the scanner's own decoder (`decodeTokenFlows` → `emissionByAddress`), `multipartPartEvents`
 * (raw decode, typed-field agreement, phase), `readPackages`.
 */

const CONTRACT = "27a8be750856ace6276eef6be2e456947c395364ae08f6cf2c1ace5dd319a2c8";
const EXAMPLE = Buffer.from(pad32("example:message[v1]")).toString("hex");
const T1 = "3a4c54e93bb80ecc7574738e06fd82ef7f8ff3265a6bddc350c225bd92fafcdd";
const T2 = "dacd193039b14f8833a17c7964923de2c95dd18eaec5dcd62ac5166772553074";

const read = (file: string): any => // eslint-disable-line @typescript-eslint/no-explicit-any
  JSON.parse(readFileSync(new URL(`./fixtures/multipart-stagenet/${file}`, import.meta.url), "utf8"));

describe("[Y] packages from recorded Stagenet raw events", () => {
  let ledger: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  beforeAll(async () => { ledger = await loadLedgerV9(); }, 60_000);

  function load(txHash: string) {
    const tx = read(`tx-${txHash}.json`).data.transactions[0];
    const events: IndexerContractEvent[] = read(`events-${txHash}.json`).data.contractEvents
      .map((e: Record<string, unknown>) => normalizeEvent(e));
    const raw = new Uint8Array(Buffer.from(tx.raw, "hex"));
    const flows = decodeTokenFlows(ledger, raw, "success", null, txHash);
    const emission = emissionByAddress(flows.calls).get(CONTRACT) ?? [];
    const pair: LookupPair = {
      txHash, address: CONTRACT, blockHeight: tx.block.height, txPosition: 0,
      expected: flows.logOpsByAddress.get(CONTRACT) ?? 0, emission,
    };
    return { tx, raw, events, pair };
  }

  it("[[multipart-segment-from-raw]] every event's physicalSegment, decoded from its own raw, is the key of the intent that logged it in the raw transaction; the packages and SHA-256s are [Y]'s", () => {
    const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
    const all = [];

    for (const txHash of [T1, T2]) {
      const { tx, raw, events, pair } = load(txHash);
      expect(tx.hash).toBe(txHash);
      expect(tx.transactionResult.status).toBe("SUCCESS");

      // ── the raw TRANSACTION: which intents call the contract, and how many events each logs ──
      const decoded = ledger.Transaction.deserialize("signature", "proof", "binding", raw);
      expect(decoded.transactionHash()).toBe(txHash);
      const logsPerIntent = new Map<number, number>();
      for (const [segment, intent] of decoded.intents) {
        for (const action of intent.actions) {
          if (!(action instanceof ledger.ContractCall) || action.address !== CONTRACT) continue;
          const logs = (action.guaranteedTranscript?.program ?? []).filter((op: unknown) => op === "log").length
            + (action.fallibleTranscript?.program ?? []).filter((op: unknown) => op === "log").length;
          logsPerIntent.set(Number(segment), (logsPerIntent.get(Number(segment)) ?? 0) + logs);
        }
      }
      // The scanner's own emission plan says the same (every call is guaranteed-only here).
      expect(new Map(pair.emission.map((e) => [e.segment, e.guaranteed + e.fallible]))).toEqual(logsPerIntent);
      expect(pair.emission.every((e) => e.fallible === 0)).toBe(true);
      expect(events).toHaveLength(pair.expected);

      // ── each event's own raw → its intent ─────────────────────────────────────────────────
      const eventsPerIntent = new Map<number, number>();
      for (const event of events) {
        expect(event.rawHex, `event ${event.eventId} has raw`).toBeDefined();
        const ledgerEvent = ledger.Event.deserialize(new Uint8Array(Buffer.from(event.rawHex!, "hex")));
        expect(String(ledgerEvent.source.transactionHash)).toBe(txHash);
        // logicalSegment is 0 for contract events of BOTH phases — which is why the phase is read
        // from the transcripts and never from here (evidence note §01-B research).
        expect(ledgerEvent.source.logicalSegment).toBe(0);
        const segment = ledgerEvent.source.physicalSegment;
        expect(logsPerIntent.has(segment), `event ${event.eventId} intent ${segment}`).toBe(true);
        eventsPerIntent.set(segment, (eventsPerIntent.get(segment) ?? 0) + 1);
      }
      expect(eventsPerIntent).toEqual(logsPerIntent);

      // ── the production path: raw → parts → packages ───────────────────────────────────────
      const parts = multipartPartEvents(events, pair, "stagenet", { ledger, optIns: [EXAMPLE] });
      expect(parts.every((p) => p.phase === "guaranteed")).toBe(true);
      const { packages } = readPackages(parts, { optIns: [EXAMPLE], network: "stagenet" });
      all.push(...packages);
      // Not opted in by default: this indexer groups only its own standards' names.
      expect(readPackages(parts).packages).toEqual([]);
    }

    expect(all.map((p) => ({
      tx: p.transactionHash, segment: p.segment, parts: p.parts.length, bytes: p.payload.length,
      positions: p.positions, phase: p.phase, sha256: sha(p.payload),
    }))).toEqual([
      { tx: T1, segment: 5392, parts: 1, bytes: 256, positions: [45258], phase: "guaranteed",
        sha256: "40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880" },
      { tx: T1, segment: 45345, parts: 3, bytes: 768, positions: [45259, 45260, 45261], phase: "guaranteed",
        sha256: "f5d7cc3852a3ae6f9948a8a84062358c722e2c0415e1490615b2fa4185023ebf" },
      // Repeated publication: the same 256 bytes in a new intent of a new transaction.
      { tx: T2, segment: 54287, parts: 1, bytes: 256, positions: [45275], phase: "guaranteed",
        sha256: "40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880" },
    ]);
    // [Y]: "Those 768 bytes were exactly a 700-byte input, including its 17 trailing zero bytes,
    // followed by 68 padding zero bytes" — every byte kept, trailing zeros included.
    const long = all[1]!.payload;
    expect(long[682]).not.toBe(0);
    expect(long.subarray(683).every((b) => b === 0)).toBe(true);
    expect(long.length - 683).toBe(17 + 68);
  });
});
