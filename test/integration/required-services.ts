/**
 * Turn "skip because a service is missing" into "fail" where the services are supposed to exist.
 *
 * THE PROBLEM. The live suites -- source parity, real-node ingest -- gate themselves on whether a
 * node, an indexer and the patched ledger are reachable, and skip otherwise. Locally that is
 * right: a developer without a devnet should not see a wall of red. In CI it is the worst possible
 * behaviour, because a container that failed to start produces a GREEN run in which the archive's
 * only acceptance gate never executed. A visible skip is better than a vacuous pass, but it is not
 * acceptance evidence for a required gate (sprint plan §5.6).
 *
 * THE MECHANISM. `REQUIRE_LIVE_SERVICES=1` -- set by the workflow that provisions the compose
 * stack, unset everywhere else. With it, a missing prerequisite throws at module load with a
 * message naming what was absent, so the job fails on the real cause rather than reporting success
 * for tests that never ran.
 *
 * Deliberately opt-IN rather than opt-out. A default-strict flag would have to be disabled in
 * every local run and would eventually be disabled in CI too, by whoever was debugging that day.
 */
const REQUIRED = process.env.REQUIRE_LIVE_SERVICES === "1";

/**
 * Returns whether to skip. When `REQUIRE_LIVE_SERVICES=1` and the prerequisite is absent, throws
 * instead of returning `true`.
 *
 * @param what human-readable name of the prerequisite, used in the failure message
 * @param available whether it is actually available
 * @param hint how to provide it -- an error naming only the problem leaves the reader stuck
 */
export function skipUnlessRequired(what: string, available: boolean, hint: string): boolean {
  if (available) return false;
  if (REQUIRED) {
    throw new Error(
      `REQUIRE_LIVE_SERVICES=1 but ${what} is unavailable. This suite is a required gate here, so ` +
        `it fails rather than skipping -- a skipped acceptance gate reports success for a ` +
        `comparison that never happened. ${hint}`,
    );
  }
  return true;
}

/** Whether live services are being required, for suites that need to state it in their own output. */
export const liveServicesRequired = REQUIRED;
