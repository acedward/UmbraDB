/**
 * The archive's current tip, as project B is allowed to see it (organizer spec FR-011, FR-020;
 * organizer question Q14).
 *
 * `sourceTip` is the fourth member of the coverage object and the only one this phase cannot
 * compute. It belongs to the archive (project A) and reaches B through Phase 1's
 * `ArchiveReadContract`, which is on a different branch — and owner Rule B forbids B from reading
 * `chain_archive` directly in any case.
 *
 * Rather than omit the field (whose absence a consumer cannot distinguish from a proxy dropping
 * it, and whose later addition would change a frozen contract) or fake it as `0` (which reads as
 * *caught up* — exactly the "unscanned range presented as complete" FR-020 forbids), the field is
 * always present and nullable, served through this one-method seam.
 *
 * The seam is deliberately narrower than the archive contract: one method taking a network id and
 * returning a height. Phase 3 implements it over `ArchiveReadContract` without any part of
 * `chain_archive`'s shape entering this module.
 */

import type { ArchiveReadContract } from "../../src/interfaces/archive-read-contract.js";

/** Reports the highest canonical finalized block height the archive currently holds for `net`,
 *  or `undefined` when this deployment cannot observe it. */
export interface SourceTipProvider {
  sourceTip(net: string): Promise<bigint | undefined>;
}

/**
 * The provider this phase ships: it reports nothing.
 *
 * Every response then carries `sourceTip: null`, which is the honest answer on a stack with no
 * scanner and no archive reader — nothing is advancing coverage, so "how far behind am I?" has no
 * answer that is not a guess.
 */
export function unknownSourceTip(): SourceTipProvider {
  return { sourceTip: async () => undefined };
}

/** A fixed tip. Test and local-development support: it lets the coverage contract be exercised
 *  end to end before Phase 3 exists, without pretending the archive is wired in. */
export function staticSourceTip(height: bigint): SourceTipProvider {
  return { sourceTip: async () => height };
}

/**
 * The provider the merged stack ships (00009-05): the archive's real tip, read through Phase 1's
 * `ArchiveReadContract` and nothing else.
 *
 * Phases 3 and 4 were developed on separate branches, so the API process was left with
 * `unknownSourceTip()` — correct on a scanner-less stack, and wrong the moment the archive is in
 * the same deployment, because every status then reports `sourceTip: null` while the archive sits
 * right there with a tip. A consumer cannot answer "am I caught up?" from that, which is the one
 * question FR-011/FR-020 exist to keep answerable.
 *
 * Rule B is not weakened by this: the API reaches the archive ONLY through the read contract's
 * interface (no `chain_archive` name, no SQL, no write method in reach), exactly as the scanner
 * does. `maxBlocks: 1` with an `afterHeight` past any possible tip makes this two cheap `SELECT`s
 * in one repeatable-read snapshot that return no block rows at all — the tip is read, the page is
 * not.
 *
 * A fault is not swallowed here: `createShieldedMonitorApi` already degrades a provider failure to
 * "unknown" rather than failing the request, and doing it twice would hide a permanently broken
 * reader behind a field that looks merely unobserved.
 */
export function archiveSourceTip(archive: ArchiveReadContract): SourceTipProvider {
  return {
    async sourceTip(net: string): Promise<bigint | undefined> {
      const page = await archive.readBlocksSince(net, Number.MAX_SAFE_INTEGER - 1, 1);
      return page.sourceTip === undefined ? undefined : BigInt(page.sourceTip.height);
    },
  };
}
