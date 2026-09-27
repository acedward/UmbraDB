import { DEFAULT_FETCH_POLICY, GuardedHttpTransport, type FetchPolicy } from "./fetch-guard.js";
import { DEFAULT_LEVEL1_LIMITS, levelOne, type Level1Limits, type Level1Result } from "./level1.js";
import { StateUnavailableError, levelTwo, type CircuitSummary, type Level2Result, type StateObservation, type StateSource } from "./level2.js";
import { DEFAULT_LEVEL3_OPTIONS, levelThree, type Level3Options, type Level3Result } from "./level3.js";

/**
 * Project 00024-02 task C7 — ONE verification of ONE publication: Level 1, then Level 2, then
 * Level 3 tried ([B] "Levels are cumulative. A failure or unavailable dependency stops every
 * stronger claim"; spec FR-011, FR-013), and the verification record [B] PR #6 asks for (consumer
 * step 6: "a verification record naming the publication and state, operations, artifact identity,
 * compiler/build inputs, completed levels, provider assumptions, and any failure or unavailable
 * prerequisite"). No database here: `drain.ts` stores the result; the scan never waits for it.
 *
 * ── Status (spec §4 Key Entities, US1 scenarios 3–6, Q14, Q25) ─────────────────────────────────
 * | outcome | status | level | l1 / l2 / l3 |
 * |---|---|---|---|
 * | URL not usable text, not http(s), refused (private / loopback / link-local) destination — policy | `unfetchable` | 0 | not_run × 3 |
 * | the host did not deliver (DNS, refused/reset connection, non-2xx incl. a listed file missing, > 3 redirects, unexpected `Content-Encoding`) — before the [B] levels (owner Q25, UC-13) | `unreachable` | 0 | not_run × 3 |
 * | a limit (deadline, a cap) at Level 1, or the provider's state unavailable at Level 2 | `unchecked` | 0 or 1 | … not_run |
 * | Level 1 fails | `failed` (failed_level 1) | 0 | failed / not_run / not_run |
 * | Level 2 fails | `failed` (failed_level 2) | 1 | passed / failed / not_run |
 * | Level 2 passes | `verified` | 2, or 3 when L3 passed | passed / passed / passed · failed · not_run |
 *
 * An L3 that runs and fails is shown, not a failure of the publication (spec Q7: "An L3 that runs
 * and fails is shown, not discarded"); `not_run` carries its reason.
 *
 * `unreachable` claims no level: Level 1 was begun but no conclusion was reached because the bytes
 * never arrived, so its reason names the delivery, not a level ("the host did not deliver: …"). The
 * drain retries it with exponential backoff; the next delivered check runs Level 1 from the start.
 */

export type InterfaceStatus = "verified" | "failed" | "unchecked" | "unfetchable" | "unreachable";
export type LevelOutcome = "passed" | "failed" | "not_run";
export type CheckTrigger = "initial" | "retry" | "recheck" | "stale" | "on_demand";

/** What a verification needs to know about the publication (a stored `public_interface_events` row). */
export interface PublicationToVerify {
  eventId: number;
  partEventIds: number[];
  address: string;
  txHash: string;
  blockHeight: number;
  txPosition: number;
  segment: number;
  parts: number;
  phase: string;
  commitment: Buffer;
  url: string | null;
  urlError: string | null;
}

export interface VerifierDeps {
  /** The event/state provider for Level 2 (the public indexer's `contractAction`). */
  stateSource: StateSource;
  /** The fetch guard's policy (TEST-ONLY `allowPrivateHosts`; the deadline). */
  fetchPolicy: Partial<FetchPolicy>;
  limits: Level1Limits;
  /** Level 3's options; `enabled: false` records `not_run` with that reason. */
  level3: Partial<Level3Options> & { enabled?: boolean };
}

export interface VerificationResult {
  status: InterfaceStatus;
  level: 0 | 1 | 2 | 3;
  l1: LevelOutcome;
  l2: LevelOutcome;
  l3: LevelOutcome;
  l3Reason: string | null;
  reason: string | null;
  failedLevel: 1 | 2 | null;
  report: Record<string, unknown>;
  circuits: CircuitSummary[];
  state: { blockHeight: number | null; txHash: string | null } | null;
}

/** The provider assumptions every record states ([B] consumer step 1; "provider limits"). */
export const PROVIDER_LIMITS: readonly string[] = Object.freeze([
  "the publication comes from the public indexer's contractEvents for its transaction and contract, grouped by this indexer ([Y] packages); the contract state from the same indexer's contractAction — two separate reads, not an authenticated common snapshot",
  "the publication order is this indexer's archive of finalized canonical blocks: block height, transaction position, then the first part's indexer event id (derivation P2)",
  "Level 2 compares against the contract's CURRENT state as the provider reports it at checkedAt, which may be later than the publication's block",
]);

/** The longest string kept in a stored verification record (`report`, `circuits`), and the longest
 *  stored diagnostic (`reason`, `l3_reason`, in every history row): bundle-controlled text can be as
 *  long as a bundle file (e.g. an 8 MiB `compact.compiler`), and a hundred history rows of it would
 *  make one response hundreds of megabytes (audit 02 E2-R4C). Longer text keeps its start and says
 *  how much was omitted. */
export const MAX_RECORD_STRING_CHARS = 8192;
export const MAX_DIAGNOSTIC_CHARS = 2000;

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} characters omitted]`;
}

/** U+0000 and lone surrogates (a cut may leave one) → U+FFFD. */
function cleanText(text: string): string {
  return text.replace(/\u0000/g, "�").replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�");
}

/**
 * A value safe for Postgres `jsonb`: every string (keys included) without U+0000 and without lone
 * surrogates — both are refused by `jsonb` and would fail the result's write on every retry. The
 * record is built here and is shallow; strings from a bundle can hold anything.
 */
export function jsonbSafe<T>(value: T, depth = 0): T {
  if (depth > 64) return null as T;
  if (typeof value === "string") return cleanText(bounded(value, MAX_RECORD_STRING_CHARS)) as T;
  if (typeof value === "bigint") return value.toString() as T;
  if (Array.isArray(value)) return value.map((v) => jsonbSafe(v, depth + 1)) as T;
  if (value !== null && typeof value === "object") {
    if (value instanceof Date) return value.toISOString() as T;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [jsonbSafe(k, depth + 1), jsonbSafe(v, depth + 1)])) as T;
  }
  return value;
}

/**
 * A diagnostic safe for a Postgres `text` column: at most {@link MAX_DIAGNOSTIC_CHARS} characters, U+0000
 * (which `text` refuses) and lone surrogates replaced by U+FFFD. Every `reason` / `l3_reason` passes here — they quote bundle-controlled text
 * (e.g. an uncommitted `index.json` `compiler.flags` entry holding a NUL), and a refused write would
 * otherwise fail the same publication on every drain pass (audit 02 E2-F1).
 */
export function textSafe(value: string | null): string | null {
  return value === null ? null : cleanText(bounded(value, MAX_DIAGNOSTIC_CHARS));
}

function packageJsonBuild(files: ReadonlyMap<string, Buffer> | undefined): Record<string, unknown> | null {
  const body = files?.get("package.json");
  if (body === undefined) return null;
  try {
    const compact = (JSON.parse(body.toString("utf8")) as { compact?: Record<string, unknown> }).compact ?? {};
    return { compiler: compact.compiler ?? null, language: compact.language ?? null, runtime: compact.runtime ?? null, interface: compact.interface ?? null, flags: compact.flags ?? [] };
  } catch {
    return null;
  }
}

/** Verifies one publication. Never throws for a check that does not pass; `deps.stateSource` errors
 *  other than {@link StateUnavailableError}, and bugs, propagate (the drain records them). */
export async function verifyPublication(
  net: string, publication: PublicationToVerify, deps: VerifierDeps, trigger: CheckTrigger, checkedAt: Date,
): Promise<VerificationResult> {
  const limits = deps.limits ?? DEFAULT_LEVEL1_LIMITS;
  const policy: FetchPolicy = { ...DEFAULT_FETCH_POLICY, ...deps.fetchPolicy };
  const transport = new GuardedHttpTransport(policy);
  let l1: Level1Result | undefined;
  let observation: StateObservation | undefined;
  let l2: Level2Result | undefined;
  let l3: Level3Result | undefined;

  const record = (result: Omit<VerificationResult, "report">): VerificationResult => {
    const files = l1?.outcome === "passed" ? l1.files : undefined;
    const report = jsonbSafe({
      record: "mip-xxxx:public-interface[v1] verification record ([B] PR #6, consumer step 6)",
      network: net,
      contract: publication.address,
      publication: {
        eventId: publication.eventId, partEventIds: publication.partEventIds, txHash: publication.txHash,
        blockHeight: publication.blockHeight, txPosition: publication.txPosition, segment: publication.segment,
        parts: publication.parts, phase: publication.phase, commitment: publication.commitment.toString("hex"),
        url: publication.url, urlError: publication.urlError,
      },
      observation: { checkedAt: checkedAt.toISOString(), trigger, stateSource: deps.stateSource.description },
      providerLimits: PROVIDER_LIMITS,
      state: observation === undefined ? null : { blockHeight: observation.blockHeight, txHash: observation.txHash, entryPoints: l2?.entryPoints ?? [] },
      operations: l2 === undefined ? [] : l2.rows,
      artifacts: {
        index: l1?.index ?? null,
        files: l1?.outcome === "passed" ? l1.entries.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })) : [],
      },
      compiler: l1?.index?.compiler ?? null,
      build: packageJsonBuild(files),
      witnesses: l2?.witnesses ?? [],
      levels: {
        l1: l1 === undefined ? { status: "not_run" } : {
          status: result.l1, outcome: l1.outcome, steps: l1.steps, ...(l1.outcome === "passed" ? {} : { reason: l1.reason, file: l1.file ?? null }),
          computed: l1.computed ?? null,
        },
        l2: l2 === undefined ? { status: result.l2 } : {
          status: result.l2, outcome: l2.outcome, reason: l2.reason ?? null, rows: l2.rows, wrapper: l2.wrapper, circuitsTruncated: l2.circuitsTruncated,
        },
        l3: l3 === undefined ? { status: result.l3, reason: result.l3Reason } : {
          status: result.l3, reason: l3.reason ?? null, compiler: l3.compiler, rows: l3.rows, generatedKeys: l3.generatedKeys, durationMs: l3.durationMs,
        },
      },
      completedLevel: result.level,
      status: result.status,
      reason: result.reason,
      limits: {
        ...limits, fetchDeadlineMs: policy.deadlineMs, maxRedirects: policy.maxRedirects,
        allowPrivateHosts: policy.allowPrivateHosts, l3DeadlineMs: deps.level3.deadlineMs ?? DEFAULT_LEVEL3_OPTIONS.deadlineMs,
      },
      transport: { requests: transport.requests, redirects: transport.redirects, bytes: l1?.bytes ?? 0 },
      executed: "nothing from the bundle was executed or imported (spec FR-013b)",
    });
    // The reasons quote bundle-controlled text (a path, a compiler flag, a compiler message): stored
    // in `text` columns, they get the same treatment as the report (a NUL fails the write).
    return { ...result, reason: textSafe(result.reason), l3Reason: textSafe(result.l3Reason), report, circuits: jsonbSafe(result.circuits) };
  };
  const base: Pick<VerificationResult, "l3Reason" | "reason" | "failedLevel" | "circuits" | "state"> =
    { l3Reason: null, reason: null, failedLevel: null, circuits: [], state: null };

  // --- the URL ----------------------------------------------------------------------------------
  if (publication.url === null) {
    return record({ ...base, status: "unfetchable", level: 0, l1: "not_run", l2: "not_run", l3: "not_run",
      reason: `the publication's URL is not usable text (${publication.urlError ?? "no URL"}); nothing was fetched` });
  }

  // --- Level 1 ------------------------------------------------------------------------------------
  l1 = await levelOne({ url: publication.url, commitment: publication.commitment }, transport, limits);
  if (l1.outcome === "unreachable") {
    // Delivery, before the [B] levels (owner Q25): no level claimed, not a Level 1 result.
    return record({ ...base, status: "unreachable", level: 0, l1: "not_run", l2: "not_run", l3: "not_run",
      reason: `the host did not deliver: ${l1.reason}` });
  }
  if (l1.outcome !== "passed") {
    return record({
      ...base, status: l1.outcome === "failed" ? "failed" : l1.outcome, level: 0,
      l1: l1.outcome === "failed" ? "failed" : "not_run", l2: "not_run", l3: "not_run",
      reason: `Level 1: ${l1.reason}`, failedLevel: l1.outcome === "failed" ? 1 : null,
    });
  }

  // --- Level 2 ------------------------------------------------------------------------------------
  try {
    observation = await deps.stateSource.stateOf(publication.address);
  } catch (error) {
    if (!(error instanceof StateUnavailableError)) throw error;
    return record({ ...base, status: "unchecked", level: 1, l1: "passed", l2: "not_run", l3: "not_run",
      reason: `Level 2: the contract state is unavailable (${error.message}); Level 2 was not run` });
  }
  const state = { blockHeight: observation.blockHeight, txHash: observation.txHash };
  l2 = levelTwo(l1.files, observation.state);
  if (l2.outcome === "unchecked") {
    return record({ ...base, state, status: "unchecked", level: 1, l1: "passed", l2: "not_run", l3: "not_run", reason: `Level 2: ${l2.reason}`, circuits: l2.circuits });
  }
  if (l2.outcome === "failed") {
    return record({ ...base, state, status: "failed", level: 1, l1: "passed", l2: "failed", l3: "not_run", reason: `Level 2: ${l2.reason}`, failedLevel: 2, circuits: l2.circuits });
  }

  // --- Level 3, tried ---------------------------------------------------------------------------
  if (deps.level3.enabled === false) {
    return record({ ...base, state, status: "verified", level: 2, l1: "passed", l2: "passed", l3: "not_run",
      l3Reason: "Level 3 is disabled in this indexer's configuration", circuits: l2.circuits });
  }
  l3 = await levelThree(l1.files, l1.entries.map((f) => f.path), deps.level3);
  return record({
    ...base, state, status: "verified", level: l3.outcome === "passed" ? 3 : 2, l1: "passed", l2: "passed",
    l3: l3.outcome, l3Reason: l3.reason ?? null, circuits: l2.circuits,
  });
}
