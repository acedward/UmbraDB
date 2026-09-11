import { createHash } from "node:crypto";

/**
 * The registration identity of a viewing key (organizer spec FR-003/FR-004).
 *
 * `fingerprint = SHA-256( DOMAIN ‖ 0x00 ‖ utf8(net) ‖ 0x00 ‖ serialized )`
 *
 * **Domain separation.** `DOMAIN` pins the hash to this one use, so a value computed here can
 * never be confused with — or replayed as — a hash computed anywhere else in this repository or
 * by the reference indexer.
 *
 * **Why the two `0x00` bytes.** The organizer plan writes the formula as bare concatenation,
 * `SHA-256(domain ‖ net ‖ key)`. The separators are an unambiguous-encoding refinement of that,
 * not a change of substance: with variable-length inputs, plain concatenation is not injective
 * (`net="a", key=Xb…` and `net="aX", key=b…` would hash the same), and a collision across
 * networks would merge two monitors that must stay distinct. `0x00` cannot occur in the UTF-8
 * encoding of a network id, because {@link assertNetworkId} restricts ids to `[A-Za-z0-9_-]`, so
 * the framing is injective and the refinement costs nothing.
 *
 * **Not keyed.** A keyed fingerprint (HMAC under a server secret) would stop someone with
 * database access from confirming a guessed key by recomputing its fingerprint. That is deferred
 * with User Story 4 by owner decision of 2026-09-10, together with at-rest encryption — which
 * matters more here, since the same database row holds the key itself in plaintext. When US4
 * returns, this is the only file that changes.
 *
 * Fingerprints are never returned to callers (organizer spec FR-003); they exist only as the
 * unique key of `shielded_monitor.monitors`.
 */

/** The domain-separation string. Changing it re-identifies every monitor, so
 *  `test/shielded-monitor/fingerprint.test.ts` pins a computed vector against it. */
export const FINGERPRINT_DOMAIN = "umbradb/shielded-monitor/fp/v1";

/** Network ids are restricted so the `0x00` framing above is injective, and so a network id can
 *  never smuggle a separator or a NUL into a hash pre-image or a SQL identifier. Matches the
 *  `net` CHECK in `src/postgres/migrations/shielded_monitor/001_core.ts`. */
export const NETWORK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Throws a plain `Error` for a network id outside {@link NETWORK_ID_PATTERN}. Deliberately not a
 *  typed `StorageError`: a bad network id is a deployment configuration fault, not a request the
 *  store could classify for a caller. */
export function assertNetworkId(net: string): void {
  if (!NETWORK_ID_PATTERN.test(net)) {
    throw new Error(`invalid network id: ${JSON.stringify(net)} (must match ${NETWORK_ID_PATTERN})`);
  }
}

/**
 * Computes the 32-byte registration fingerprint for a serialized encryption secret key on one
 * network.
 *
 * The `serialized` argument is secret material. This function does not retain it, does not log
 * it, and does not put it in any thrown error.
 */
export function monitorFingerprint(net: string, serialized: Uint8Array): Buffer {
  assertNetworkId(net);
  if (serialized.length === 0) throw new Error("monitorFingerprint: empty serialized key");
  return createHash("sha256")
    .update(Buffer.from(FINGERPRINT_DOMAIN, "utf8"))
    .update(Buffer.of(0x00))
    .update(Buffer.from(net, "utf8"))
    .update(Buffer.of(0x00))
    .update(Buffer.from(serialized))
    .digest();
}
