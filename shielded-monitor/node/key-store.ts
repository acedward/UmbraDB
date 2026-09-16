import { monitorFingerprint } from "../fingerprint.js";
import { deserializeEncryptionSecretKey, type EncryptionSecretKeyHandle } from "../offers.js";
import type { ShieldedViewingKey } from "../viewing-key.js";

/**
 * **The viewing keys a monitor-node holds, and the only place they exist** (00009-09; owner
 * decision Q28).
 *
 * ── Why this is a module and not a `Map` in the node ────────────────────────────────────────
 * Because the hazardous operations are the ones that must be impossible to forget: a key is
 * deserialized exactly once, the serialized byte buffer is zero-filled the instant the WASM handle
 * exists, and every removal path — revoke, delete, a fenced drop, SIGTERM — goes through a single
 * method that calls `clear()`. Spreading those across the node's queues is how one of them ends up
 * missing a `clear()` in a year's time.
 *
 * ── What the database knows ─────────────────────────────────────────────────────────────────
 * The key's SHA-256 fingerprint, as the monitor's identity, and nothing else. So this store is not
 * a cache of something persistent: it IS the state. A node that restarts holds nothing, its
 * monitors show `key needed`, and the client re-sends the key — which is the design, not a
 * degradation of it (§4.6 of the 00009-09 design).
 *
 * ── Phases ─────────────────────────────────────────────────────────────────────────────────
 * - `syncing` — Queue B is catching this key up to the node's live watermark. Not in the live set,
 *   so Queue A skips it: a key whose history is still being read must not also be fed new blocks,
 *   or its coverage would move forward past a range it never read.
 * - `live` — in the block-centric pass. Every new block is committed for it.
 * - `failed` — the monitor STOPPED: an undecodable transaction, an unsupported protocol version,
 *   or an archive that was rebuilt underneath it. The key stays in RAM and is skipped, because
 *   the monitor's matches stay readable and nothing about a stopped scan is a reason to destroy a
 *   key its owner has not asked to delete. A DELETED monitor's key is cleared instead — that is
 *   the one operation a consumer has, and it means "destroy it" (owner decision Q33).
 */

export type KeyPhase = "syncing" | "live" | "failed";

/** One viewing key, as this node holds it. */
export interface HeldKey {
  readonly monitorId: string;
  /** Lowercase hex of the 32-byte fingerprint — the map key, and what the balancer asks about. */
  readonly fingerprintHex: string;
  /** The ledger WASM handle. The serialized bytes it was built from no longer exist. */
  readonly esk: EncryptionSecretKeyHandle;
  phase: KeyPhase;
  /**
   * `false` until this key's FIRST Queue A pass has compared its stored coverage with the height
   * being scanned (§4.3's `HAS_SCANNED_ONCE`). That single comparison is the whole desync
   * detector: a key that joined the live set while its coverage stood below `H − 1` has a hole,
   * and this flag is what makes the check happen once rather than on every block forever.
   */
  hasScannedOnce: boolean;
  readonly addedAt: Date;
}

/** A read-only view of a held key, for `/internal/status` and the node's own logging. Carries no
 *  handle, so nothing that renders one can reach the key. */
export interface HeldKeyView {
  readonly monitorId: string;
  readonly fingerprintHex: string;
  readonly phase: KeyPhase;
  readonly hasScannedOnce: boolean;
  readonly addedAt: Date;
}

function viewOf(held: HeldKey): HeldKeyView {
  return {
    monitorId: held.monitorId,
    fingerprintHex: held.fingerprintHex,
    phase: held.phase,
    hasScannedOnce: held.hasScannedOnce,
    addedAt: held.addedAt,
  };
}

/** How a serialized viewing key becomes a handle. A seam, not a mock hook: a TEE deployment
 *  supplies a handle backed by key material the process never sees in the clear, and the unit
 *  suite uses it to observe that `clear()` really is called on every removal path. */
export type DeserializeKey = (bytes: Uint8Array) => Promise<EncryptionSecretKeyHandle>;

export class MonitorKeyStore {
  readonly #keys = new Map<string, HeldKey>();
  /** `monitorId → fingerprintHex`. A second index rather than a scan: the lifecycle routes and
   *  `/internal/holds?monitorId=` both arrive with an id and no key. */
  readonly #byMonitor = new Map<string, string>();
  readonly #deserialize: DeserializeKey;

  constructor(deserialize: DeserializeKey = deserializeEncryptionSecretKey) {
    this.#deserialize = deserialize;
  }

  /**
   * Takes ownership of a validated viewing key.
   *
   * The serialized bytes are read once, handed to the ledger, and **zero-filled immediately** —
   * before this method returns, and whether or not the deserialization succeeded. From that point
   * the only representation of the key in this process is a WASM handle, which is exactly what
   * "keys only in RAM, never persisted" has to mean in practice: not merely "not written to disk",
   * but "not sitting in a JavaScript byte array that a heap dump or an error's `cause` could
   * carry".
   *
   * Adding a key this node already holds is idempotent: the existing handle is kept and returned,
   * and the new bytes are zeroed just the same. Minting a second handle for one key would double
   * the WASM allocations and make `clear()` a lie about the first one.
   */
  async add(key: ShieldedViewingKey, monitorId: string): Promise<HeldKey> {
    const fingerprintHex = Buffer.from(key.fingerprint).toString("hex");
    const existing = this.#keys.get(fingerprintHex);
    if (existing !== undefined) return existing;

    const bytes = key.yesIKnowTheSecurityImplicationsOfThis_serialized();
    let esk: EncryptionSecretKeyHandle;
    try {
      esk = await this.#deserialize(bytes);
    } finally {
      bytes.fill(0);
    }
    const held: HeldKey = {
      monitorId,
      fingerprintHex,
      esk,
      phase: "syncing",
      hasScannedOnce: false,
      addedAt: new Date(),
    };
    this.#keys.set(fingerprintHex, held);
    this.#byMonitor.set(monitorId, fingerprintHex);
    return held;
  }

  get(fingerprintHex: string): HeldKey | undefined {
    return this.#keys.get(fingerprintHex);
  }

  byMonitorId(monitorId: string): HeldKey | undefined {
    const fingerprintHex = this.#byMonitor.get(monitorId);
    return fingerprintHex === undefined ? undefined : this.#keys.get(fingerprintHex);
  }

  /**
   * Forgets a key and **zeroes it**.
   *
   * The one removal path. `clear()` is best effort — a WASM fault here is a runtime problem, not a
   * reason to leave the entry in the map pretending the key is still usable — so the map is
   * updated whether or not it threw, and the failure is returned rather than raised: a caller
   * draining keys on SIGTERM must clear the rest even if one of them misbehaves.
   */
  remove(fingerprintHex: string): boolean {
    const held = this.#keys.get(fingerprintHex);
    if (held === undefined) return false;
    this.#keys.delete(fingerprintHex);
    this.#byMonitor.delete(held.monitorId);
    try {
      held.esk.clear();
    } catch {
      // best effort — see the method note
    }
    return true;
  }

  removeByMonitorId(monitorId: string): boolean {
    const fingerprintHex = this.#byMonitor.get(monitorId);
    return fingerprintHex === undefined ? false : this.remove(fingerprintHex);
  }

  /** Clears every key. Called on SIGTERM/SIGINT, and by the tests. */
  clearAll(): number {
    const count = this.#keys.size;
    for (const fingerprintHex of [...this.#keys.keys()]) this.remove(fingerprintHex);
    return count;
  }

  /** The keys Queue A tests against each new block: `live` only. `syncing` keys belong to Queue B
   *  and `failed` keys are deliberately kept and skipped. */
  live(): HeldKey[] {
    return [...this.#keys.values()].filter((k) => k.phase === "live");
  }

  all(): HeldKey[] {
    return [...this.#keys.values()];
  }

  views(): HeldKeyView[] {
    return this.all().map(viewOf);
  }

  get size(): number {
    return this.#keys.size;
  }

  /** How many keys are in each phase, for `/internal/status`. */
  counts(): { readonly live: number; readonly syncing: number; readonly failed: number } {
    let live = 0;
    let syncing = 0;
    let failed = 0;
    for (const held of this.#keys.values()) {
      if (held.phase === "live") live += 1;
      else if (held.phase === "syncing") syncing += 1;
      else failed += 1;
    }
    return { live, syncing, failed };
  }
}

/** The fingerprint of a validated key, as this node and the balancer both spell it: lowercase hex
 *  of `monitorFingerprint(net, serialized)`. One spelling, one function, so a hint table written by
 *  the balancer and a key store written by a node cannot disagree about what a key is called. */
export function fingerprintHexOf(net: string, serialized: Uint8Array): string {
  return monitorFingerprint(net, serialized).toString("hex");
}
