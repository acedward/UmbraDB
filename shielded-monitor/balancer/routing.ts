import { decodeBech32m } from "../bech32m.js";
import { hrpForNetwork, monitorFingerprint } from "../fingerprint.js";

/**
 * **The balancer's half of registration routing** (00009-09 §4.1, §7) — kept in its own module
 * because of what it must NOT reach.
 *
 * ── Why this file exists, and what it deliberately cannot do ────────────────────────────────
 * A monitor-node validates a viewing key with the ledger WASM. The balancer must not: it is a
 * reverse proxy that has to answer "which node already holds this key?" in microseconds, on every
 * registration, and loading a WASM ledger to do it would be absurd. So it does exactly the two
 * steps that are pure arithmetic — Bech32m decode, then the SHA-256 the fingerprint always was —
 * and leaves every judgement about whether the bytes are a real key to the node.
 *
 * That split is sound because of what the two computations are FOR. The balancer's fingerprint is
 * a ROUTING KEY: it decides which node receives the request. The node then computes the same
 * fingerprint from the key's canonical re-serialization and registers THAT. For a key the node
 * will accept, the two agree by construction — `parseViewingKey` requires the payload to equal the
 * ledger's own re-serialization, so "canonical" and "as submitted" are the same bytes. For a key
 * the node will reject, the routing was irrelevant: the node answers 400 wherever it was sent.
 *
 * ── OP-1: the balancer touches the key ──────────────────────────────────────────────────────
 * It decodes the submitted string, which means the key exists in this process for the length of
 * one function call. That is a real widening of the trust boundary and it is recorded as OP-1
 * with the owner's default accepted: for now the balancer sits INSIDE the boundary alongside the
 * nodes, and the TEE step decides whether it moves into the enclave or starts taking a
 * client-computed fingerprint header instead. Nothing here retains the bytes, and nothing here
 * logs them — the balancer's request log records a route and a status, never a body.
 */

/** Why a submitted registration body could not be turned into a routing key. Diagnostic only: the
 *  balancer never renders these to a client, because the NODE owns the client-facing error and
 *  FR-001 requires every intake failure to look the same. */
export type RoutingKeyRejection = "not-json" | "no-viewing-key" | "bech32m" | "network-hrp";

export type RoutingKey =
  | { readonly ok: true; readonly fingerprintHex: string }
  | { readonly ok: false; readonly rejection: RoutingKeyRejection };

/**
 * Computes the routing fingerprint of a `POST /v1/monitors` body.
 *
 * Returns a rejection rather than throwing, and the caller forwards a rejected body to a node
 * ANYWAY — unrouted, to whichever node the ordinary load-balancing picks. That is deliberate: the
 * node produces the one generic `INVALID_VIEWING_KEY` the contract promises, with the status, the
 * headers and the request id a client expects, and the balancer inventing its own 400 would create
 * a second, subtly different error shape for exactly the input a client is most likely to get
 * wrong.
 *
 * The bytes are not retained: `data` goes out of scope with this call, and the only thing that
 * survives is 32 bytes of hash.
 */
export function routingKeyFor(body: string, net: string): RoutingKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return { ok: false, rejection: "not-json" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, rejection: "not-json" };
  const viewingKey = (parsed as { viewingKey?: unknown }).viewingKey;
  if (typeof viewingKey !== "string" || viewingKey === "") {
    return { ok: false, rejection: "no-viewing-key" };
  }
  let hrp: string;
  let data: Uint8Array;
  try {
    ({ hrp, data } = decodeBech32m(viewingKey));
  } catch {
    return { ok: false, rejection: "bech32m" };
  }
  if (hrp !== hrpForNetwork(net)) return { ok: false, rejection: "network-hrp" };
  if (data.length === 0) return { ok: false, rejection: "bech32m" };
  return { ok: true, fingerprintHex: monitorFingerprint(net, data).toString("hex") };
}

/** The fingerprint as it travels in `GET /internal/holds?fp=` — base64url, so it needs no
 *  percent-encoding and cannot be mangled by a proxy that normalises query strings. */
export function fingerprintHexToBase64Url(fingerprintHex: string): string {
  return Buffer.from(fingerprintHex, "hex").toString("base64url");
}

/**
 * **One mutex per fingerprint** (§4.1 step 1).
 *
 * Two simultaneous registrations of the SAME key must not be routed independently, or they can
 * land on two different nodes and both take custody — and then two nodes scan one monitor, each
 * believing it is the holder, with the balancer's hint pointing at whichever answered last. The
 * storage API would keep the data correct (the fence and the monotonic coverage guard see to
 * that), but the waste is real and the `heldBy` a client is shown would be a coin flip.
 *
 * Serialising per fingerprint rather than globally is the point: registrations of DIFFERENT keys
 * are independent and must stay concurrent, because each one costs a fan-out.
 *
 * Entries are removed when the last waiter leaves, so the map does not grow with the number of
 * keys ever registered.
 */
export class FingerprintLocks {
  readonly #chains = new Map<string, Promise<void>>();
  readonly #waiting = new Map<string, number>();

  async run<T>(fingerprintHex: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(fingerprintHex) ?? Promise.resolve();
    this.#waiting.set(fingerprintHex, (this.#waiting.get(fingerprintHex) ?? 0) + 1);
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    this.#chains.set(fingerprintHex, previous.then(() => mine));
    await previous;
    try {
      return await fn();
    } finally {
      release();
      const left = (this.#waiting.get(fingerprintHex) ?? 1) - 1;
      if (left <= 0) {
        this.#waiting.delete(fingerprintHex);
        this.#chains.delete(fingerprintHex);
      } else {
        this.#waiting.set(fingerprintHex, left);
      }
    }
  }

  /** How many fingerprints are currently locked or queued. For the tests and a status line. */
  get size(): number {
    return this.#chains.size;
  }
}
