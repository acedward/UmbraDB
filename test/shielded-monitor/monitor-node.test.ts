import { describe, expect, it } from "vitest";
import type {
  ArchiveBlockPage, ArchiveIdentity, ArchiveReadContract, ArchivedBlock,
} from "../../src/interfaces/archive-read-contract.js";
import { MonitorNotFoundError } from "../../shielded-monitor/errors.js";
import type { EncryptionSecretKeyHandle } from "../../shielded-monitor/offers.js";
import { MonitorNode } from "../../shielded-monitor/node/monitor-node.js";
import { MonitorKeyStore } from "../../shielded-monitor/node/key-store.js";
import { NO_WAKE } from "../../shielded-monitor/wake.js";
import type {
  AdvanceBatchItem, AdvanceBatchResult, AdvanceResult, AssociationInput, FillGapInput,
  FillGapResult, LifecycleEventRecord, MonitorGap, MonitorLastError, MonitorRecord,
  RegisterMonitorInput, RevocationRecord, ShieldedMonitorStore,
} from "../../shielded-monitor/store.js";
import { ShieldedViewingKey } from "../../shielded-monitor/viewing-key.js";
import { fixtureViewingKey } from "./helpers.js";

/**
 * **The monitor-node's queues and its key custody**, without a database and without the ledger
 * (00009-09).
 *
 * The split-topology suite proves the node against real PostgreSQL, a real archive and a real
 * balancer. This file exists for the properties that suite cannot make happen on demand:
 *
 *  - the `HAS_SCANNED_ONCE` desync detector firing, which needs a monitor whose stored coverage
 *    is deliberately BEHIND the height being scanned — a state a healthy run never reaches;
 *  - `clear()` being called on every path a key leaves by, which is a call-sequence fact;
 *  - a paused key being KEPT while a revoked one is destroyed (OP-3);
 *  - exactly one `advance-batch` per block, whatever the key count.
 *
 * Those are the reasons a double is the right instrument here rather than a weaker substitute for
 * the real thing.
 */

const NET = "undeployed";

function hex(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

/** A block of system transactions: the node skips them without asking the ledger to decode the
 *  placeholder bytes, so a case about CONTROL FLOW is not also a case about the predicate. */
function systemBlock(height: number, txCount = 1): ArchivedBlock {
  return {
    net: NET,
    height,
    hash: hex(height),
    parentHash: hex(height - 1),
    transactions: Array.from({ length: txCount }, (_, position) => ({
      txHash: hex(1000 + height * 10 + position),
      position,
      kind: "system" as const,
      protocolVersion: 1_000_000,
      rawBytes: new TextEncoder().encode(`tx/${height}/${position}`),
    })),
  };
}

class FakeArchive implements ArchiveReadContract {
  constructor(public blocks: ArchivedBlock[]) {}
  identity: ArchiveIdentity | undefined = { net: NET, genesisHash: hex(0), archiveInstanceId: "a".repeat(32) };

  async readBlocksSince(_net: string, afterHeight: number, maxBlocks: number): Promise<ArchiveBlockPage> {
    const after = this.blocks.filter((b) => b.height > afterHeight).slice(0, maxBlocks);
    const tip = this.blocks[this.blocks.length - 1];
    return {
      blocks: after,
      ...(tip === undefined ? {} : { sourceTip: { height: tip.height, hash: tip.hash } }),
    };
  }

  async getArchiveIdentity(): Promise<ArchiveIdentity | undefined> {
    return this.identity;
  }
}

interface BatchCall {
  readonly height: bigint;
  readonly items: readonly AdvanceBatchItem[];
}

/** A store double recording every call the node makes. Only the methods a node reaches are real;
 *  the rest throw, so a node that started using one would fail loudly rather than silently. */
class FakeStore implements ShieldedMonitorStore {
  readonly monitors = new Map<string, MonitorRecord>();
  readonly batches: BatchCall[] = [];
  readonly fills: { monitorId: string; from: bigint; to: bigint }[] = [];
  /** What `advanceBatch` should answer for a given monitor, instead of advancing it. */
  readonly fencedAs = new Map<string, "epoch" | "state" | "not-found" | "already-advanced">();
  nextId = 1;

  record(over: Partial<MonitorRecord> = {}): MonitorRecord {
    const id = `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, "0")}`;
    const record: MonitorRecord = {
      id,
      net: NET,
      state: "backfilling",
      epoch: 0n,
      coverage: { requestedStart: 0n },
      gaps: [],
      matchingRuleVersion: "shielded-monitor/relevance/v1",
      ledgerBuild: "ledger-v8@8.1.0-syshash.4",
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...over,
    };
    this.monitors.set(record.id, record);
    return record;
  }

  async register(input: RegisterMonitorInput): Promise<MonitorRecord> {
    const fingerprintHex = Buffer.from(input.fingerprint).toString("hex");
    for (const monitor of this.monitors.values()) {
      if ((monitor as { fingerprintHex?: string }).fingerprintHex === fingerprintHex) return monitor;
    }
    const record = this.record({ coverage: { requestedStart: input.requestedStartHeight } });
    this.monitors.set(record.id, Object.assign(record, { fingerprintHex }));
    return record;
  }

  async get(id: string): Promise<MonitorRecord> {
    const record = this.monitors.get(id);
    if (record === undefined) throw new MonitorNotFoundError(id);
    return record;
  }

  async getIncludingRevoked(id: string): Promise<MonitorRecord | undefined> {
    return this.monitors.get(id);
  }

  async advanceBatch(
    _net: string, height: bigint, _blockHash: Uint8Array, items: readonly AdvanceBatchItem[],
  ): Promise<AdvanceBatchResult> {
    this.batches.push({ height, items });
    const advanced: string[] = [];
    const fenced: { id: string; reason: "epoch" | "state" | "not-found" | "already-advanced" }[] = [];
    for (const item of items) {
      const forced = this.fencedAs.get(item.monitorId);
      if (forced !== undefined) {
        fenced.push({ id: item.monitorId, reason: forced });
        continue;
      }
      const monitor = this.monitors.get(item.monitorId);
      if (monitor === undefined) {
        fenced.push({ id: item.monitorId, reason: "not-found" });
        continue;
      }
      const gaps: MonitorGap[] = [
        ...monitor.gaps,
        ...(item.newGaps ?? []).map((g) => ({ from: g.from, to: g.to, recordedAt: new Date(0) })),
      ];
      this.monitors.set(item.monitorId, {
        ...monitor,
        coverage: { ...monitor.coverage, scannedFrom: monitor.coverage.scannedFrom ?? 0n, scannedThrough: height },
        gaps,
      });
      advanced.push(item.monitorId);
    }
    return { advanced, fenced };
  }

  async fillGap(monitorId: string, input: FillGapInput): Promise<FillGapResult> {
    this.fills.push({ monitorId, from: input.from, to: input.to });
    const monitor = await this.get(monitorId);
    const gaps = monitor.gaps.flatMap((gap) => {
      if (input.from > gap.to || input.to < gap.from) return [gap];
      const out: MonitorGap[] = [];
      if (gap.from < input.from) out.push({ ...gap, to: input.from - 1n });
      if (gap.to > input.to) out.push({ ...gap, from: input.to + 1n });
      return out;
    });
    this.monitors.set(monitorId, { ...monitor, gaps });
    return { written: input.associations.length, gaps };
  }

  async advance(
    monitorId: string, _epoch: bigint, throughHeight: bigint, _associations: readonly AssociationInput[],
  ): Promise<AdvanceResult> {
    const monitor = await this.get(monitorId);
    this.monitors.set(monitorId, {
      ...monitor,
      coverage: { ...monitor.coverage, scannedFrom: monitor.coverage.scannedFrom ?? 0n, scannedThrough: throughHeight },
    });
    return { applied: true, firstSeq: 1n, lastSeq: 0n, coverage: (await this.get(monitorId)).coverage };
  }

  async goLive(id: string): Promise<MonitorRecord> {
    const monitor = await this.get(id);
    const next = { ...monitor, state: "live" as const, epoch: monitor.epoch + 1n };
    this.monitors.set(id, next);
    return next;
  }

  async bindArchiveSource(
    id: string, _epoch: bigint, source: { genesisHash: string; instanceId: string },
  ): Promise<{ applied: boolean; monitor: MonitorRecord }> {
    const monitor = await this.get(id);
    const next = { ...monitor, sourceGenesisHash: source.genesisHash, sourceInstanceId: source.instanceId };
    this.monitors.set(id, next);
    return { applied: true, monitor: next };
  }

  async pause(id: string): Promise<MonitorRecord> {
    const monitor = await this.get(id);
    const next = { ...monitor, state: "paused" as const, epoch: monitor.epoch + 1n };
    this.monitors.set(id, next);
    return next;
  }

  /** Resume goes to `backfilling`, never straight to `live`: the tip moved while the monitor
   *  slept, so `live` would be false at the moment it was claimed (see `lifecycle.ts`). */
  async resume(id: string): Promise<MonitorRecord> {
    const monitor = await this.get(id);
    const next = { ...monitor, state: "backfilling" as const, epoch: monitor.epoch + 1n };
    this.monitors.set(id, next);
    return next;
  }

  // ── Not reached by a node; loud rather than silent if one ever does ─────────────────────────
  private nope(name: string): never {
    throw new Error(`FakeStore.${name} was not expected to be called`);
  }
  async getByFingerprint(): Promise<MonitorRecord | undefined> { return this.nope("getByFingerprint"); }
  async listActive(): Promise<MonitorRecord[]> { return this.nope("listActive"); }
  async listAll(): Promise<MonitorRecord[]> { return this.nope("listAll"); }
  async listGaps(): Promise<MonitorGap[]> { return this.nope("listGaps"); }
  async readAssociations(): Promise<never> { return this.nope("readAssociations"); }
  async readAssociationsMissingDetails(): Promise<never> { return this.nope("readAssociationsMissingDetails"); }
  async listLifecycleEvents(): Promise<LifecycleEventRecord[]> { return this.nope("listLifecycleEvents"); }
  async updateAssociationDetails(): Promise<never> { return this.nope("updateAssociationDetails"); }
  async markFailed(_id: string, _actor: string, _error: MonitorLastError): Promise<MonitorRecord> {
    return this.nope("markFailed");
  }
  async markStaleSource(): Promise<MonitorRecord> { return this.nope("markStaleSource"); }
  async revoke(): Promise<MonitorRecord> { return this.nope("revoke"); }
  async delete(): Promise<MonitorRecord | undefined> { return this.nope("delete"); }
  async recordAudit(): Promise<void> { return this.nope("recordAudit"); }
  async listRevocations(): Promise<RevocationRecord[]> { return this.nope("listRevocations"); }
}

/** A key double that records what was done to it. */
function fakeKey(state: { cleared: number }): EncryptionSecretKeyHandle {
  return { test: () => false, clear: () => { state.cleared += 1; } };
}

function nodeWith(archive: FakeArchive, store: FakeStore, deserialized: EncryptionSecretKeyHandle): MonitorNode {
  return new MonitorNode(archive, store, NO_WAKE, {
    net: NET,
    nodeId: "node-under-test",
    deserializeKey: async () => deserialized,
    verifyTxIdentity: false,
  });
}

describe("the monitor-node's key custody (00009-09)", () => {
  it("[[shielded-monitor.node.key-bytes-are-zeroed-the-moment-the-handle-exists]] zeroes the serialized key as soon as it becomes a handle, and clears the handle on every removal path", async () => {
    // "Keys only in RAM" has to mean more than "not written to disk": a plain byte array of key
    // material reachable from a request handler's closure is what a heap dump or a core file
    // carries. So the bytes are zero-filled the instant the ledger has them, and the handle is
    // destroyed on every path a key leaves by.
    const real = await fixtureViewingKey(7171, NET);
    const bytesBefore = Buffer.from(real.yesIKnowTheSecurityImplicationsOfThis_serialized());
    expect(bytesBefore.some((b) => b !== 0), "the fixture key must not already be zeros").toBe(true);

    const lifecycle = { cleared: 0 };
    let handedBytes: Uint8Array | undefined;
    const keys = new MonitorKeyStore(async (bytes) => {
      // The array the store hands the ledger — kept so the zero-fill can be observed on the very
      // buffer the deserializer saw.
      handedBytes = bytes;
      return fakeKey(lifecycle);
    });
    const held = await keys.add(real, "monitor-1");
    expect(handedBytes).toBeDefined();
    expect([...handedBytes!].every((b) => b === 0), "the buffer handed to the ledger must be zeroed").toBe(true);
    expect(held.phase).toBe("syncing");

    // Adding the same key twice keeps ONE handle: a second would double the WASM allocations and
    // make `clear()` a lie about the first.
    const again = await keys.add(real, "monitor-1");
    expect(again).toBe(held);

    expect(keys.remove(held.fingerprintHex)).toBe(true);
    expect(lifecycle.cleared).toBe(1);
    expect(keys.get(held.fingerprintHex)).toBeUndefined();
    expect(keys.byMonitorId("monitor-1")).toBeUndefined();
    // Removing a key that is gone is not an error and does not clear anything twice.
    expect(keys.remove(held.fingerprintHex)).toBe(false);
    expect(lifecycle.cleared).toBe(1);
  });

  it("shreds the caller's key object on registration, whether or not the storage call succeeds", async () => {
    const store = new FakeStore();
    const archive = new FakeArchive([systemBlock(0)]);
    const lifecycle = { cleared: 0 };
    const node = nodeWith(archive, store, fakeKey(lifecycle));
    await node.start({ loops: false });

    const real = await fixtureViewingKey(7272, NET);
    await node.register(real, 0n);
    expect([...real.yesIKnowTheSecurityImplicationsOfThis_serialized()].every((b) => b === 0)).toBe(true);

    // The failure path too: the object must not survive a refused registration holding a key.
    const other = await fixtureViewingKey(7373, NET);
    const failing = new FakeStore();
    failing.register = async () => { throw new Error("storage is down"); };
    const failingNode = nodeWith(archive, failing, fakeKey(lifecycle));
    await failingNode.start({ loops: false });
    await expect(failingNode.register(other, 0n)).rejects.toThrow("storage is down");
    expect([...other.yesIKnowTheSecurityImplicationsOfThis_serialized()].every((b) => b === 0)).toBe(true);

    await node.stop();
    await failingNode.stop();
  });

  it("clears every held key on shutdown", async () => {
    const store = new FakeStore();
    const lifecycle = { cleared: 0 };
    const node = nodeWith(new FakeArchive([systemBlock(0)]), store, fakeKey(lifecycle));
    await node.start({ loops: false });
    await node.register(await fixtureViewingKey(7474, NET), 0n);
    expect(node.keys.size).toBe(1);

    await node.stop();

    // SIGTERM is about to replace this process; the keys it held must not survive into whatever
    // reads its memory afterwards.
    expect(lifecycle.cleared).toBe(1);
    expect(node.keys.size).toBe(0);
  });
});

describe("the monitor-node's queues (00009-09)", () => {
  /** Boots a node whose archive holds `heights + 1` blocks, with one key already live. */
  async function liveNode(heights: number): Promise<{
    node: MonitorNode; store: FakeStore; archive: FakeArchive; monitor: MonitorRecord;
    key: ShieldedViewingKey; lifecycle: { cleared: number };
  }> {
    const archive = new FakeArchive(Array.from({ length: heights + 1 }, (_, h) => systemBlock(h)));
    const store = new FakeStore();
    const lifecycle = { cleared: 0 };
    const node = nodeWith(archive, store, fakeKey(lifecycle));
    await node.start({ loops: false });
    const key = await fixtureViewingKey(8181, NET);
    const fingerprintHex = key.fingerprint.toString("hex");
    const monitor = await node.register(key, 0n);
    // Registration queues `sync-key`; running it is what takes the key from `syncing` to `live`,
    // and running it HERE rather than flipping the field is what leaves Queue B genuinely empty
    // — which the cases below then measure.
    expect(await node.runQueueBOnce()).toBe(true);
    expect(node.keys.get(fingerprintHex)!.phase).toBe("live");
    expect(node.status().queueB).toBe(0);
    return { node, store, archive, monitor, key, lifecycle };
  }

  it("commits exactly ONE advance-batch per block, carrying every live key (Rule B)", async () => {
    const { node, store, archive } = await liveNode(2);
    // A second live key on the same node: one block, one commit, BOTH monitors in it.
    const second = store.record();
    await node.keys.add(await fixtureViewingKey(8282, NET), second.id);
    node.keys.get([...node.keys.all()].find((k) => k.monitorId === second.id)!.fingerprintHex)!.phase = "live";

    // Boot set the watermark to the archive tip, which is the design (a node holds no keys at
    // boot, so there is nothing to scan history for). Rewind it so there are blocks to commit.
    archive.blocks.push(systemBlock(3), systemBlock(4));
    const turn = await node.runQueueAOnce();

    expect(turn.blocks).toBe(2);
    expect(store.batches.map((b) => b.height)).toStrictEqual([3n, 4n]);
    for (const batch of store.batches) {
      expect(batch.items.map((i) => i.monitorId).sort()).toStrictEqual(
        node.keys.live().map((k) => k.monitorId).sort(),
      );
    }
    expect(node.liveWatermark).toBe(4n);
    await node.stop();
  });

  it("[[shielded-monitor.node.gap-detected-and-back-synced]] records the range a key missed on its FIRST live block, and back-syncs it", async () => {
    // The injected desync: the key joins the live set while its stored coverage stands well
    // below the watermark — the window between Queue B finishing and Queue A taking over, which
    // a healthy run closes too fast to observe. The node must notice on the key's first pass,
    // write the hole in the SAME transaction that moves coverage, and queue a back-sync.
    const { node, store, archive, monitor } = await liveNode(2);
    store.monitors.set(monitor.id, {
      ...(await store.get(monitor.id)),
      coverage: { requestedStart: 0n, scannedFrom: 0n, scannedThrough: 1n },
    });
    archive.blocks.push(systemBlock(3), systemBlock(4), systemBlock(5));

    await node.runQueueAOnce();

    // The gap travelled in the first batch, and it is exactly `[coverage + 1, H - 1]`.
    const first = store.batches[0]!;
    expect(first.height).toBe(3n);
    expect(first.items[0]!.newGaps).toStrictEqual([{ from: 2n, to: 2n }]);
    // And ONLY in the first: `hasScannedOnce` makes this a once-per-key check, not a per-block one.
    for (const batch of store.batches.slice(1)) {
      expect(batch.items[0]!.newGaps).toBeUndefined();
    }
    expect((await store.get(monitor.id)).gaps.map((g) => `${g.from}-${g.to}`)).toStrictEqual(["2-2"]);

    // Queue B now holds the back-sync, and running it fills the range without moving coverage.
    expect(node.status().queueB).toBe(1);
    expect(await node.runQueueBOnce()).toBe(true);
    expect(store.fills).toStrictEqual([{ monitorId: monitor.id, from: 2n, to: 2n }]);
    const after = await store.get(monitor.id);
    expect(after.gaps).toStrictEqual([]);
    expect(after.coverage.scannedThrough, "a back-sync never moves coverage").toBe(5n);
    await node.stop();
  });

  it("records no gap at all when the key's coverage is already at the watermark", async () => {
    // The normal case, and the reason the check is a comparison rather than an unconditional
    // record: `sync-key` usually lands the key exactly where Queue A is about to continue.
    const { node, store, archive, monitor } = await liveNode(2);
    store.monitors.set(monitor.id, {
      ...(await store.get(monitor.id)),
      coverage: { requestedStart: 0n, scannedFrom: 0n, scannedThrough: 2n },
    });
    archive.blocks.push(systemBlock(3));

    await node.runQueueAOnce();

    expect(store.batches[0]!.items[0]!.newGaps).toBeUndefined();
    expect(node.status().queueB).toBe(0);
    expect((await store.get(monitor.id)).gaps).toStrictEqual([]);
    await node.stop();
  });

  it("[[shielded-monitor.node.paused-keeps-the-key-and-revoked-clears-it]] keeps a paused key in RAM and destroys a revoked one (OP-3)", async () => {
    const { node, store, monitor, lifecycle } = await liveNode(1);
    const fingerprintHex = node.keys.byMonitorId(monitor.id)!.fingerprintHex;

    // Paused: the key stays, marked, so a resume needs no re-send from the client.
    await store.pause(monitor.id);
    store.fencedAs.set(monitor.id, "state");
    await node.refreshHeldMonitor(node.keys.byMonitorId(monitor.id)!);
    expect(node.keys.get(fingerprintHex)?.phase).toBe("paused");
    expect(lifecycle.cleared, "a paused key must NOT be cleared").toBe(0);
    expect(node.keys.live()).toStrictEqual([]);
    expect(node.status()).toMatchObject({ keysHeld: 1, paused: 1, live: 0 });

    // Deleted: there is nothing left to resume, so the key is destroyed.
    store.monitors.delete(monitor.id);
    await node.refreshHeldMonitor(node.keys.get(fingerprintHex)!);
    expect(node.keys.get(fingerprintHex)).toBeUndefined();
    expect(lifecycle.cleared).toBe(1);
    await node.stop();
  });

  it("[[shielded-monitor.node.resume-in-storage-is-noticed-on-the-next-block]] re-enters sync for a paused key whose monitor was resumed in storage, with no event at all", async () => {
    // Organizer question Q31, measured on the live demo. A paused key is deliberately outside the
    // live set, so it has no `advance-batch` item — and the fence in that batch is how every OTHER
    // lifecycle change reaches a holder. Without the per-block re-read below, a resumed monitor
    // stays `paused` inside the node that holds its key until the process restarts and the client
    // re-sends the key, which is precisely what pausing was meant to make unnecessary.
    const { node, store, archive, monitor, lifecycle } = await liveNode(1);
    const fingerprintHex = node.keys.byMonitorId(monitor.id)!.fingerprintHex;

    await store.pause(monitor.id);
    archive.blocks.push(systemBlock(2));
    await node.runQueueAOnce();
    expect(node.keys.get(fingerprintHex)!.phase).toBe("paused");
    expect(lifecycle.cleared, "a paused key is kept").toBe(0);

    // The resume happens in STORAGE and nowhere else: `onEvent` is never called here, no key is
    // re-sent, and the node is told nothing.
    await store.resume(monitor.id);
    expect(node.keys.get(fingerprintHex)!.phase, "still paused until a block is processed").toBe("paused");

    archive.blocks.push(systemBlock(3));
    await node.runQueueAOnce();

    const held = node.keys.get(fingerprintHex)!;
    expect(held.phase).toBe("syncing");
    // Re-armed, because the key rejoins the live set behind the watermark the pause let run on.
    expect(held.hasScannedOnce).toBe(false);
    expect(node.status().queueB, "a sync-key was queued").toBe(1);

    // And the sync takes it back to live from its own coverage — no re-send anywhere in this test.
    expect(await node.runQueueBOnce()).toBe(true);
    expect(node.keys.get(fingerprintHex)!.phase).toBe("live");
    expect((await store.get(monitor.id)).coverage.scannedThrough).toBe(3n);
    expect(lifecycle.cleared).toBe(0);
    await node.stop();
  });

  it("[[shielded-monitor.node.sync-key-queues-a-back-sync-for-a-recorded-gap]] picks up a gap the record already carries when it takes a hold of the key", async () => {
    // Organizer question Q32, use case 3: a gap is DISCOVERED once, by the HAS_SCANNED_ONCE
    // check, and the job that fills it used to exist only in the RAM of the node that found it.
    // A node that died, or a back-sync whose transport failed, therefore left a row in
    // `monitor_gaps` with nothing anywhere scheduled to clear it. Taking a hold is the moment to
    // pick those up: it is exactly when a node has the key the range must be re-read with.
    const archive = new FakeArchive(Array.from({ length: 4 }, (_, h) => systemBlock(h)));
    const store = new FakeStore();
    const node = nodeWith(archive, store, fakeKey({ cleared: 0 }));
    await node.start({ loops: false });
    const monitor = await node.register(await fixtureViewingKey(9191, NET), 0n);
    const fingerprintHex = node.keys.byMonitorId(monitor.id)!.fingerprintHex;
    store.monitors.set(monitor.id, {
      ...(await store.get(monitor.id)),
      gaps: [{ from: 1n, to: 2n, recordedAt: new Date(0) }],
    });

    // The registration's own `sync-key`, and nothing else, is in the queue.
    expect(node.status().queueB).toBe(1);
    expect(await node.runQueueBOnce()).toBe(true);
    expect(node.keys.get(fingerprintHex)!.phase).toBe("live");
    expect(node.status().queueB, "the recorded gap is now queued").toBe(1);

    // Queued once, not once per hold: a second sync of the same key must not grow Queue B.
    await node.runQueueBJob({ kind: "sync-key", fingerprintHex });
    expect(node.status().queueB).toBe(1);

    expect(await node.runQueueBOnce()).toBe(true);
    expect(store.fills).toStrictEqual([
      { monitorId: monitor.id, from: 1n, to: 1n },
      { monitorId: monitor.id, from: 2n, to: 2n },
    ]);
    expect((await store.get(monitor.id)).gaps).toStrictEqual([]);
    await node.stop();
  });

  it("drops a key whose monitor the batch reports as not-found, and keeps one merely fenced on epoch", async () => {
    const { node, store, archive, monitor, lifecycle } = await liveNode(1);
    archive.blocks.push(systemBlock(2));

    // `epoch` means "re-read it", not "give up": the next turn loads the current epoch.
    store.fencedAs.set(monitor.id, "epoch");
    await node.runQueueAOnce();
    expect(node.keys.byMonitorId(monitor.id)).toBeDefined();
    expect(lifecycle.cleared).toBe(0);

    // `not-found` is terminal: the monitor is gone, so the key is destroyed.
    archive.blocks.push(systemBlock(3));
    store.fencedAs.set(monitor.id, "not-found");
    await node.runQueueAOnce();
    expect(node.keys.byMonitorId(monitor.id)).toBeUndefined();
    expect(lifecycle.cleared).toBe(1);
    await node.stop();
  });

  it("answers /internal/holds by fingerprint and by monitor id, and reports its own load", async () => {
    const { node, monitor, key } = await liveNode(1);
    const fingerprintHex = key.fingerprint.toString("hex");
    expect(node.holds(fingerprintHex)).toStrictEqual({ holds: true, phase: "live" });
    expect(node.holds("f".repeat(64))).toStrictEqual({ holds: false });
    expect(node.holdsMonitor(monitor.id)).toStrictEqual({ holds: true, phase: "live" });
    expect(node.holdsMonitor("00000000-0000-4000-8000-999999999999")).toStrictEqual({ holds: false });
    expect(node.heldMonitors()).toStrictEqual([{ monitorId: monitor.id, phase: "live" }]);
    expect(node.status()).toMatchObject({ nodeId: "node-under-test", net: NET, keysHeld: 1, live: 1 });
    // Nothing in the status is derived from a key: it is counts, heights and this node's name.
    expect(JSON.stringify(node.status())).not.toContain(fingerprintHex);
    await node.stop();
  });
});
