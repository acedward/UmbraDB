#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * `umbradb-shielded-monitor-client` — the reference consumer (organizer spec US1–US3, SC-008;
 * owner decision Q4: "the one application for acceptance is a minimal reference CLI shipped in
 * the repository").
 *
 * ── This file imports nothing but Node built-ins, on purpose ────────────────────────────────
 * No store, no `postgres`, no schema name, no shared type from `shielded-monitor/`. The whole
 * point of the acceptance exercise is that an application with **no database credentials and no
 * schema knowledge** can complete the entire flow over HTTP. If this client could import
 * `PgShieldedMonitorStore`, a later refactor could quietly turn the "end-to-end" test into a
 * function call and the evidence would evaporate without a single failing assertion. The rule is
 * therefore enforced by an import audit in
 * `test/shielded-monitor/client-cli.integration.test.ts`, not by this comment.
 *
 * ── Key handling ────────────────────────────────────────────────────────────────────────────
 * The viewing key is read ONLY from a file (`--key-file`), never from `argv`: a key on a command
 * line lands in the shell history and in every `ps` listing on a shared host, and neither can be
 * un-written. Nothing this client prints ever contains the key — `register` echoes back only what
 * the service returns, and the service never returns a key.
 *
 * ── What it prints ──────────────────────────────────────────────────────────────────────────
 * Monitor ids, coverage, and per match the block height, position, transaction hash, matched
 * segments and `appliedOutcome`. The last two are in because organizer spec US1 scenarios 2 and 3
 * are about exactly them: a consumer must be able to see which segment matched and that the
 * service is NOT claiming the transaction applied. Nothing else is printed.
 */

const USAGE = `umbradb-shielded-monitor-client — reference consumer for the private shielded-monitor API

Usage: umbradb-shielded-monitor-client <command> [--flag value]

Global flags
  --api <url>                 base URL of the private API (default: $UMBRADB_API or http://127.0.0.1:8787)

Commands
  register --key-file <path> [--start <height|earliest>]
                              register the Bech32m viewing key held in FILE (never on argv)
  status --id <uuid>          state and coverage
  poll --id <uuid> --cursor-file <path> [--limit <n>]
                              read the next page of matches and persist the cursor (idempotent resume)
  pause   --id <uuid>
  resume  --id <uuid>
  revoke  --id <uuid>
  delete  --id <uuid>

Exit codes
  0  success
  1  the service refused the request, or a local error (message on stderr)
  2  usage error
`;

interface Args {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string>;
}

function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined) {
      throw new UsageError(`malformed argument near ${JSON.stringify(flag ?? "")}; every flag needs a value`);
    }
    flags.set(flag.slice(2), value);
  }
  return { command: command ?? "help", flags };
}

class UsageError extends Error {}

/** A refusal from the service, carrying its stable code so a caller can branch without parsing
 *  prose. The code — not the message — is the contract. */
class ApiRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`${status} ${code}: ${message}`);
    this.name = "ApiRefusal";
  }
}

function requireFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) throw new UsageError(`missing required flag --${name}`);
  return value;
}

interface Coverage {
  requestedStart: string;
  scannedFrom: string | null;
  scannedThrough: string | null;
  sourceTip: string | null;
}

interface MonitorView {
  monitorId: string;
  net: string;
  state: string;
  coverage: Coverage;
  lastError?: { code: string; atHeight?: string };
}

interface MatchItem {
  cursor: string;
  blockHeight: string;
  position: number;
  txHash: string;
  matchedSegments: number[];
  appliedOutcome: string;
}

interface MatchPage {
  items: MatchItem[];
  nextCursor: string;
  coverage: Coverage;
}

/** Renders coverage for a human. `not scanned` and `unknown` are spelled out rather than shown
 *  as `0`, which is the whole point of organizer spec FR-020: a consumer must never read an
 *  unscanned range as a completed empty one. */
function renderCoverage(coverage: Coverage): Record<string, string> {
  return {
    requestedStart: coverage.requestedStart,
    scannedFrom: coverage.scannedFrom ?? "not scanned",
    scannedThrough: coverage.scannedThrough ?? "not scanned",
    sourceTip: coverage.sourceTip ?? "unknown",
  };
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function request(base: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(new URL(path, base), {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });

  if (response.status === 204) return undefined;

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    throw new Error(`the service returned a non-JSON response (status ${response.status})`);
  }

  if (!response.ok) {
    const error = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiRefusal(response.status, error?.code ?? "UNKNOWN", error?.message ?? "no message");
  }
  return parsed;
}

/** {@link request} for the endpoints that must answer with a body. A 2xx with no body from one
 *  of those is a protocol violation by the service, not something to paper over with `?.`. */
async function requestJson<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
  const parsed = await request(base, method, path, body);
  if (parsed === undefined || typeof parsed !== "object") {
    throw new Error(`the service answered ${method} ${path} without a JSON object`);
  }
  return parsed as T;
}

/** Reads a persisted cursor, treating "no file yet" as "start from the beginning". Any other
 *  failure (a directory, a permission error) is reported rather than swallowed — silently
 *  restarting a consumer's stream from zero because its cursor file was unreadable would replay
 *  its whole history and look like duplicate matches. */
async function readCursorFile(path: string): Promise<string | undefined> {
  try {
    const text = (await readFile(path, "utf8")).trim();
    return text === "" ? undefined : text;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Persists a cursor atomically: write a sibling temp file, then rename over the target.
 *
 * A plain `writeFile` truncates first, so a crash between truncate and write leaves an EMPTY
 * cursor file — which on the next run reads as "start from the beginning" and replays the
 * consumer's entire history. `rename` within the same directory is atomic on POSIX, so the file
 * is either the old cursor or the new one.
 */
async function writeCursorFile(path: string, cursor: string): Promise<void> {
  const temp = join(dirname(path), `.${Date.now().toString(36)}.cursor.tmp`);
  await writeFile(temp, `${cursor}\n`, "utf8");
  await rename(temp, path);
}

export async function runClient(argv: readonly string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  const base = flags.get("api") ?? process.env.UMBRADB_API ?? "http://127.0.0.1:8787";

  switch (command) {
    case "register": {
      const encodedKey = (await readFile(requireFlag(flags, "key-file"), "utf8")).trim();
      const start = flags.get("start") ?? "earliest";
      const monitor = await requestJson<MonitorView>(base, "POST", "/v1/monitors", {
        viewingKey: encodedKey,
        startHeight: start === "earliest" ? "earliest" : start,
      });
      print({ monitorId: monitor.monitorId, state: monitor.state, coverage: renderCoverage(monitor.coverage) });
      return 0;
    }

    case "status": {
      const id = requireFlag(flags, "id");
      const monitor = await requestJson<MonitorView>(base, "GET", `/v1/monitors/${id}`);
      print({
        monitorId: monitor.monitorId,
        state: monitor.state,
        coverage: renderCoverage(monitor.coverage),
        ...(monitor.lastError !== undefined ? { lastError: monitor.lastError.code } : {}),
      });
      return 0;
    }

    case "poll": {
      const id = requireFlag(flags, "id");
      const cursorFile = requireFlag(flags, "cursor-file");
      const cursor = await readCursorFile(cursorFile);
      const query = new URLSearchParams();
      if (cursor !== undefined) query.set("cursor", cursor);
      const limit = flags.get("limit");
      if (limit !== undefined) query.set("limit", limit);
      const suffix = query.size === 0 ? "" : `?${query.toString()}`;

      const page = await requestJson<MatchPage>(base, "GET", `/v1/monitors/${id}/matches${suffix}`);
      // The cursor is persisted BEFORE anything is printed, so a crash between the two re-reads
      // a page the consumer has already stored rather than skipping one it has not. Duplicate
      // delivery is recoverable; a skipped match is not.
      if (page.nextCursor !== cursor) await writeCursorFile(cursorFile, page.nextCursor);
      print({
        monitorId: id,
        matches: page.items.map((item) => ({
          blockHeight: item.blockHeight,
          position: item.position,
          txHash: item.txHash,
          matchedSegments: item.matchedSegments,
          appliedOutcome: item.appliedOutcome,
        })),
        coverage: renderCoverage(page.coverage),
      });
      return 0;
    }

    case "pause":
    case "resume":
    case "revoke": {
      const id = requireFlag(flags, "id");
      const monitor = await requestJson<MonitorView>(base, "POST", `/v1/monitors/${id}/${command}`);
      print({ monitorId: monitor.monitorId, state: monitor.state, coverage: renderCoverage(monitor.coverage) });
      return 0;
    }

    case "delete": {
      const id = requireFlag(flags, "id");
      await request(base, "DELETE", `/v1/monitors/${id}`);
      print({ monitorId: id, deleted: true });
      return 0;
    }

    default: {
      process.stderr.write(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
      return 2;
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runClient(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(err instanceof UsageError ? 2 : 1);
    },
  );
}
