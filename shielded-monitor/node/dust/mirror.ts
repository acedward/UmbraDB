import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { LEDGER_BUILD_ID, loadLedger } from "../../offers.js";
import type { DustConfig } from "./config.js";
import type { DustDb } from "./db.js";

/**
 * `DustStateMirror` — one key-less `DustLocalState` holding the chain's two DUST trees, folded
 * once from `dust_events` so that no wallet has to fold them again
 * (`spec/00016-dust-wallet-sync.md` Story 2, FR-011, FR-012, FR-013, FR-014; plan 00016 D2.2,
 * D2.5b).
 *
 * ── THE ONE RULE THIS FILE MUST NOT GET WRONG ───────────────────────────────────────────────
 * The replay is `replayRawEventsRetainingAll`, **never** `replayRawEvents`.
 *
 * The stock replay collapses every leaf the secret key does not own, and `MerkleTreeNode::collapse`
 * merges collapsed siblings upward, so a key-less mirror ends up holding a handful of large
 * aligned collapsed subtrees and none of the interior nodes a cut needs. Measured on the first
 * 5 000 preprod events (question Q-12): a stock mirror can serve the two segments around a
 * uniformly random wallet leaf in **0 of 200** draws; a retained mirror in **200 of 200**.
 *
 * And the two replays reach **identical roots**. So this mistake is invisible to every root
 * comparison — to the fixture's recorded roots, to a golden run against the SDK, to
 * `GET /v1/dust/tip` — and surfaces only the first time a real wallet asks for a segment. That is
 * why `dust-mirror.test.ts` cuts a random single-leaf range instead of comparing roots.
 *
 * ── Why the state is leased rather than simply swapped ──────────────────────────────────────
 * FR-014 requires one request to read one immutable state reference: a `DustLocalState` value
 * never changes, and the mirror publishes a new reference after each batch. But the retained
 * trees cost ≈ 2 KB of WebAssembly heap per leaf (question Q-14), and wasm-bindgen handles are
 * not collected promptly by V8 — so a mirror that merely dropped the old reference would hold
 * several copies of a multi-gigabyte tree until a GC it cannot schedule.
 *
 * Freeing the old handle eagerly is therefore mandatory, and freeing it while a segments request
 * is still cutting from it is a use-after-free that surfaces as `null pointer passed to rust`.
 * The two requirements meet at a lease count: a reader takes a lease, the mirror retires the old
 * state when it swaps, and whoever drops the last lease frees it. No request ever sees a tree
 * change under it, and no superseded tree outlives its last reader.
 *
 * ── What "ready" and "producer" mean ────────────────────────────────────────────────────────
 * `producer: "none"` means the table holds no DUST events for this net at all — an archive whose
 * ingest ran with `REPLAY_VALIDATION=0`. That is a deployment mistake, not a transient state, and
 * the routes say so with `503 DUST_NO_PRODUCER` (Story 2 scenario 4) rather than pretending to be
 * an empty chain.
 *
 * `ready` means the mirror has caught up with the table at least once. Before that the routes
 * answer `503 DUST_NOT_READY` (Story 2 scenario 3) — serving a tree that is missing the last
 * hundred thousand leaves would hand a wallet segments that cannot reproduce the chain's root,
 * which is worse than saying "not yet".
 */

/** How far the mirror's trees have been folded (FR-013). */
export interface DustMirrorApplied {
  readonly eventId: bigint;
  readonly height: bigint;
}

/** What is written at the head of a snapshot file (FR-012). */
export interface DustSnapshotHeader {
  readonly net: string;
  readonly ledgerVersion: string;
  readonly eventId: string;
  readonly height: string;
}

/**
 * A borrowed reference to the mirror's current trees. Call {@link DustMirrorLease.release} in a
 * `finally`, exactly once: the state is unusable afterwards if this was the last lease on a
 * retired reference.
 */
export interface DustMirrorLease {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly state: any;
  readonly applied: DustMirrorApplied;
  release(): void;
}

export type DustProducer = "ingest" | "none";

export interface DustMirrorStatus {
  readonly producer: DustProducer;
  readonly ready: boolean;
  readonly applied: { readonly eventId: string; readonly height: string };
  readonly snapshotEventId: string | null;
  readonly lastError: string | null;
}

export interface DustStateMirrorDeps {
  readonly db: DustDb;
  readonly net: string;
  readonly config: DustConfig;
  readonly logger?: (line: string) => void;
  /** Injected in tests so a mirror can run against a loaded module without re-importing the WASM;
   *  production leaves it out and the memoized `loadLedger()` answers. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly ledger?: any;
  /** Injected so a test can drive the loop turn by turn instead of racing a timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Retained so the reference cannot be freed while a request is still cutting from it. */
interface HeldState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly state: any;
  readonly applied: DustMirrorApplied;
  leases: number;
  retired: boolean;
}

const SNAPSHOT_MAGIC = Buffer.from("UMBRADUST1", "utf8");

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class DustStateMirror {
  readonly #deps: DustStateMirrorDeps;
  readonly #log: (line: string) => void;
  readonly #sleep: (ms: number) => Promise<void>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #ledger: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #key: any;
  #held: HeldState | undefined;
  #producer: DustProducer = "none";
  #ready = false;
  #lastError: string | undefined;
  #snapshotEventId: bigint | undefined;
  #eventsSinceSnapshot = 0n;
  #running = false;
  #loop: Promise<void> | undefined;

  constructor(deps: DustStateMirrorDeps) {
    this.#deps = deps;
    this.#log = deps.logger ?? (() => undefined);
    this.#sleep = deps.sleep ?? defaultSleep;
  }

  /**
   * Loads the newest usable snapshot (or starts from an empty state) and begins following the
   * table.
   *
   * `loops: false` boots the mirror WITHOUT the poll timer so a suite can call
   * {@link DustStateMirror.pumpOnce} and observe each batch, exactly as `MonitorNode.start` does
   * for its queues. It is the same mirror either way.
   */
  async start(opts: { readonly loops?: boolean } = {}): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#ledger = this.#deps.ledger ?? (await loadLedger());
    this.#key = this.#ledger.sampleDustSecretKey();
    const restored = await this.#loadSnapshot();
    if (restored === undefined) {
      this.#publish(this.#blankState(), { eventId: 0n, height: 0n });
    } else {
      this.#publish(restored.state, restored.applied);
      this.#snapshotEventId = restored.applied.eventId;
    }
    if (opts.loops !== false) this.#loop = this.#runLoop();
  }

  /** Stops following, writes a final snapshot, and frees the trees. */
  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    await this.#loop?.catch(() => undefined);
    this.#loop = undefined;
    // A clean shutdown snapshots (FR-012) so a restart replays at most `DUST_STATE_SNAPSHOT_EVERY`
    // events rather than the whole chain. A failure here is logged and swallowed: refusing to shut
    // down because a disk is full would be worse than replaying on the next start.
    try {
      if (this.#held !== undefined && this.#held.applied.eventId > 0n) await this.#writeSnapshot(this.#held);
    } catch (err) {
      this.#log(`[dust] final snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const held = this.#held;
    this.#held = undefined;
    if (held !== undefined) {
      held.retired = true;
      if (held.leases === 0) held.state.free();
    }
    // The mirror's key is a random sample that matches nothing on chain, but it is still key
    // material in the WASM heap and this repository zeroes those rather than dropping them.
    try {
      this.#key?.clear?.();
    } catch {
      // `clear()` on an already-cleared handle throws; a shutdown must not fail on it.
    }
    this.#key?.free?.();
    this.#key = undefined;
  }

  /** `dust` for `/internal/status` (spec §4). Counts, heights and codes — nothing else. */
  status(): DustMirrorStatus {
    const applied = this.#held?.applied ?? { eventId: 0n, height: 0n };
    return {
      producer: this.#producer,
      ready: this.#ready,
      applied: { eventId: applied.eventId.toString(10), height: applied.height.toString(10) },
      snapshotEventId: this.#snapshotEventId === undefined ? null : this.#snapshotEventId.toString(10),
      lastError: this.#lastError ?? null,
    };
  }

  get producer(): DustProducer {
    return this.#producer;
  }

  get ready(): boolean {
    return this.#ready;
  }

  /**
   * Borrows the current trees for the duration of one request (FR-014).
   *
   * `undefined` before {@link DustStateMirror.start} has published anything. The caller MUST
   * release, in a `finally`.
   */
  acquire(): DustMirrorLease | undefined {
    const held = this.#held;
    if (held === undefined) return undefined;
    held.leases += 1;
    let released = false;
    return {
      state: held.state,
      applied: held.applied,
      release: () => {
        // Idempotent: a double release would drop another reader's claim and free a tree in use.
        if (released) return;
        released = true;
        held.leases -= 1;
        if (held.retired && held.leases === 0) held.state.free();
      },
    };
  }

  /**
   * One turn: read the next batch and fold it. Returns how many events were applied.
   *
   * Public so tests can drive it; the loop below is nothing but this plus a sleep.
   */
  async pumpOnce(): Promise<number> {
    const { db, net, config } = this.#deps;
    const held = this.#held;
    if (held === undefined) return 0;
    let events;
    try {
      events = await db.selectEventsAfter(net, held.applied.eventId, config.replayBatch);
      if (events.length === 0) {
        // Nothing new. Distinguish "the table is empty for this net" (a deployment whose ingest
        // never captured anything) from "we are at the tip", because the two answer differently.
        const tip = await db.selectTableTip(net);
        this.#producer = tip === undefined ? "none" : "ingest";
        if (tip !== undefined) this.#ready = true;
        this.#lastError = undefined;
        return 0;
      }
      this.#producer = "ingest";
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err);
      return 0;
    }

    const bytes = Buffer.concat(events.map((event) => Buffer.from(event.raw)));
    const last = events[events.length - 1]!;
    let withChanges;
    try {
      // THE retain-all call. See the class note: `replayRawEvents` would reach the same roots and
      // leave the trees uncuttable.
      withChanges = held.state.replayRawEventsRetainingAll(this.#key, new Uint8Array(bytes));
    } catch (err) {
      // A refusal here is not transient — the same bytes will be read again next turn and fail
      // the same way — so it is recorded and the mirror stops advancing rather than spinning
      // silently. `NonLinearInsertion` is the expected shape when a table has a gap.
      this.#lastError = err instanceof Error ? err.message : String(err);
      this.#log(`[dust] replay refused at event ${held.applied.eventId.toString(10)}: ${this.#lastError}`);
      return 0;
    }
    // `.state` mints a NEW handle on every access, so it is read exactly once.
    const next = withChanges.state;
    withChanges.free();
    this.#publish(next, { eventId: last.id, height: last.blockHeight });
    this.#lastError = undefined;
    this.#eventsSinceSnapshot += BigInt(events.length);

    if (this.#eventsSinceSnapshot >= BigInt(config.snapshotEvery)) {
      this.#eventsSinceSnapshot = 0n;
      try {
        await this.#writeSnapshot(this.#held!);
      } catch (err) {
        // A snapshot is an optimisation: losing one costs replay time on the next start, never
        // correctness, so it must not stop the fold.
        this.#log(`[dust] snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return events.length;
  }

  // ── Internals ──────────────────────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #blankState(): any {
    // D2.6: the mirror's parameters are the ledger's own initial DUST parameters, asserted against
    // the archive's at start-up by the module (see `index.ts`).
    return new this.#ledger.DustLocalState(this.#ledger.LedgerParameters.initialParameters().dust);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #publish(state: any, applied: DustMirrorApplied): void {
    const previous = this.#held;
    this.#held = { state, applied, leases: 0, retired: false };
    if (previous === undefined) return;
    previous.retired = true;
    // Free NOW if nobody is reading it; otherwise the last reader's `release()` does it. Either
    // way the superseded trees do not wait for a garbage collection this process cannot schedule.
    if (previous.leases === 0) previous.state.free();
  }

  async #runLoop(): Promise<void> {
    while (this.#running) {
      try {
        const applied = await this.pumpOnce();
        // A full batch means there is almost certainly more: keep folding rather than sleeping a
        // poll interval per 1 000 events, which would make a cold start take days.
        if (applied >= this.#deps.config.replayBatch) continue;
      } catch (err) {
        this.#lastError = err instanceof Error ? err.message : String(err);
      }
      await this.#sleep(this.#deps.config.pollMs);
    }
  }

  #snapshotPath(): string {
    return path.join(this.#deps.config.snapshotDir, `${this.#deps.net}.dust-state`);
  }

  /**
   * Writes `magic ‖ u32be(headerLength) ‖ header JSON ‖ DustLocalState.serialize()` to a temp
   * file in the same directory and renames it over the old one (FR-012).
   *
   * Same directory, because `rename` is only atomic within a filesystem; a temp file in `/tmp`
   * would degrade to copy-then-delete across a mount and could leave a half-written snapshot that
   * passes its own header check.
   */
  async #writeSnapshot(held: HeldState): Promise<void> {
    const dir = this.#deps.config.snapshotDir;
    await mkdir(dir, { recursive: true });
    const header: DustSnapshotHeader = {
      net: this.#deps.net,
      ledgerVersion: LEDGER_BUILD_ID,
      eventId: held.applied.eventId.toString(10),
      height: held.applied.height.toString(10),
    };
    const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(headerBytes.byteLength, 0);
    const body = Buffer.from(held.state.serialize() as Uint8Array);
    const target = this.#snapshotPath();
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, Buffer.concat([SNAPSHOT_MAGIC, length, headerBytes, body]));
    try {
      await rename(temp, target);
    } catch (err) {
      await unlink(temp).catch(() => undefined);
      throw err;
    }
    this.#snapshotEventId = held.applied.eventId;
    this.#log(`[dust] snapshot at event ${header.eventId} height ${header.height} (${body.byteLength} B)`);
  }

  /**
   * Reads the snapshot, or `undefined` when there is none or it cannot be trusted.
   *
   * Every refusal is the same outcome — replay from zero — and each is LOGGED with its reason,
   * because "the node took 40 minutes to start" is otherwise indistinguishable from "the node
   * silently ignored a snapshot written by a different ledger build". A snapshot from another
   * `net` or another `ledgerVersion` is refused rather than migrated: serialized ledger state is
   * a ledger-internal encoding, and a build that reads it differently produces wrong trees rather
   * than an error.
   */
  async #loadSnapshot(): Promise<{ state: unknown; applied: DustMirrorApplied } | undefined> {
    const target = this.#snapshotPath();
    let file: Buffer;
    try {
      file = await readFile(target);
    } catch {
      return undefined; // no snapshot yet: the ordinary first start
    }
    const refuse = (reason: string): undefined => {
      this.#log(`[dust] ignoring ${target}: ${reason}; replaying from zero`);
      return undefined;
    };
    if (file.byteLength < SNAPSHOT_MAGIC.byteLength + 4) return refuse("truncated");
    if (!file.subarray(0, SNAPSHOT_MAGIC.byteLength).equals(SNAPSHOT_MAGIC)) return refuse("not a DUST snapshot");
    const headerLength = file.readUInt32BE(SNAPSHOT_MAGIC.byteLength);
    const headerStart = SNAPSHOT_MAGIC.byteLength + 4;
    if (headerLength > 4096 || file.byteLength < headerStart + headerLength) return refuse("truncated header");
    let header: DustSnapshotHeader;
    try {
      header = JSON.parse(file.subarray(headerStart, headerStart + headerLength).toString("utf8")) as DustSnapshotHeader;
    } catch {
      return refuse("unreadable header");
    }
    if (header.net !== this.#deps.net) return refuse(`net ${String(header.net)} is not ${this.#deps.net}`);
    if (header.ledgerVersion !== LEDGER_BUILD_ID) {
      return refuse(`ledgerVersion ${String(header.ledgerVersion)} is not ${LEDGER_BUILD_ID}`);
    }
    try {
      const state = this.#ledger.DustLocalState.deserialize(
        new Uint8Array(file.subarray(headerStart + headerLength)),
      );
      const applied = { eventId: BigInt(header.eventId), height: BigInt(header.height) };
      this.#log(`[dust] resumed from ${target} at event ${header.eventId} height ${header.height}`);
      return { state, applied };
    } catch (err) {
      return refuse(`state did not deserialize (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}
