import { readFile, writeFile } from "node:fs/promises";
import { createClient } from "../src/postgres/client.js";
import { DEFAULT_SHIELDED_MONITOR_SCHEMA, bootstrapShieldedMonitorSchema } from "./bootstrap.js";
import { applyRevocationList, exportRevocationList, type RevocationListFile } from "./revocation-list.js";
import { PgShieldedMonitorStore, type AssociationInput } from "./store.js";
import { LEDGER_BUILD_ID, parseViewingKey } from "./viewing-key.js";

/**
 * The **trusted harness** for project B's store (organizer sub-plan 00009-02's exit criterion:
 * "harness can register/pause/revoke/delete/restore without scanner or API").
 *
 * This is deliberately not a product surface. It exists so the store's lifecycle, fencing and
 * restore behaviour can be driven and reviewed *before* a relevance scanner (Phase 3) or an HTTP
 * API (Phase 4) exists to confuse the review, and so an operator can run the documented restore
 * procedure by hand. It performs no scanning: the `advance` subcommand takes the associations it
 * is told to write, from a JSON file, and writes them — the relevance decision is not made here
 * and cannot be made here.
 *
 * ── Key handling ────────────────────────────────────────────────────────────────────────────
 * The viewing key is read ONLY from a file (`--key-file`), never from `argv`. A key on a command
 * line lands in the shell history and in every `ps` listing on a shared host, and neither is
 * something this repository can un-write. Nothing this command prints ever contains the key: the
 * key object redacts itself under every stringification path, and `register` prints only the
 * monitor id and coverage (organizer spec FR-023, SC-004).
 *
 * ── Not shipped as a package bin ────────────────────────────────────────────────────────────
 * `package.json`'s `bin` map is the published CLI surface and Phase 4 owns the entries a
 * deployment actually runs (`umbradb-shielded-monitor`, `…-api`, `…-client`). This harness is
 * reachable through the `shielded-monitor:harness` npm script instead, so it stays a development
 * and operations tool rather than something a consumer installs by accident.
 */

interface ParsedArgs {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string>;
}

const USAGE = `umbradb shielded-monitor harness (trusted; no scanner, no API)

Usage: npm run shielded-monitor:harness -- <command> [--flag value]

Global flags
  --dsn <postgres://…>       connection string (default: PG* environment variables)
  --schema <name>            schema to operate in (default: ${DEFAULT_SHIELDED_MONITOR_SCHEMA})
  --net <id>                 network id (default: undeployed)
  --actor <name>             recorded in the lifecycle log (default: harness)

Commands
  bootstrap                                    apply the migration lineage
  register --key-file <path> [--start <h>]     register a viewing key read from a FILE
  status --id <uuid>                           coverage and state (refuses a revoked monitor)
  inspect --id <uuid>                          state incl. revoked/deleted (administrative)
  list                                         active monitors
  advance --id <uuid> --epoch <n> --through <h> [--associations <path>]
  events --id <uuid>                           the lifecycle log
  associations --id <uuid> [--after <seq>] [--limit <n>]
  go-live --id <uuid> --epoch <n>
  pause|resume|revoke|delete --id <uuid>
  fail --id <uuid> --code <c> --message <m>
  stale-source --id <uuid> --code <c> --message <m>
  export-revocations --out <path>
  apply-revocations --in <path>
`;

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined) {
      throw new Error(`malformed argument near ${JSON.stringify(flag ?? "")}; every flag needs a value`);
    }
    flags.set(flag.slice(2), value);
  }
  return { command: command ?? "help", flags };
}

function requireFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) throw new Error(`missing required flag --${name}`);
  return value;
}

/** `JSON.stringify` replacer: `bigint` has no JSON representation, and heights and epochs are
 *  bigints throughout. Rendering them as decimal strings keeps the harness output machine-
 *  readable without silently losing precision through `Number`. */
function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Buffer) return value.toString("hex");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return value;
}

function print(value: unknown): void {
  process.stdout.write(JSON.stringify(value, jsonSafe, 2) + "\n");
}

/** The association file format the `advance` subcommand reads. Heights, hashes and versions are
 *  strings so the file is hand-writable and precision-safe. */
interface AssociationFileEntry {
  readonly net?: string;
  readonly blockHeight: string;
  readonly blockHashHex: string;
  readonly position: number;
  readonly txHashHex: string;
  readonly protocolVersion: string;
  readonly matchedSegments: readonly number[];
  readonly sourceOutcome?: string;
}

function toAssociationInput(entry: AssociationFileEntry, net: string): AssociationInput {
  return {
    net: entry.net ?? net,
    blockHeight: BigInt(entry.blockHeight),
    blockHash: Uint8Array.from(Buffer.from(entry.blockHashHex, "hex")),
    position: entry.position,
    txHash: Uint8Array.from(Buffer.from(entry.txHashHex, "hex")),
    protocolVersion: BigInt(entry.protocolVersion),
    matchedSegments: entry.matchedSegments,
    ...(entry.sourceOutcome !== undefined ? { sourceOutcome: entry.sourceOutcome } : {}),
  };
}

export async function runHarness(argv: readonly string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  const schema = flags.get("schema") ?? DEFAULT_SHIELDED_MONITOR_SCHEMA;
  const net = flags.get("net") ?? "undeployed";
  const actor = flags.get("actor") ?? "harness";
  const dsn = flags.get("dsn");
  const sql = createClient({ ...(dsn !== undefined ? { connectionString: dsn } : {}), schema });
  const store = new PgShieldedMonitorStore(sql, schema);

  try {
    switch (command) {
      case "bootstrap": {
        await bootstrapShieldedMonitorSchema(sql, schema);
        print({ bootstrapped: schema });
        return 0;
      }

      case "register": {
        // The key is read from a file and never echoed. `parseViewingKey` validates it against
        // the deployment network and the ledger before anything touches the database.
        const encoded = (await readFile(requireFlag(flags, "key-file"), "utf8")).trim();
        const key = await parseViewingKey(encoded, net);
        const monitor = await store.register({
          key,
          net,
          requestedStartHeight: BigInt(flags.get("start") ?? "0"),
          matchingRuleVersion: flags.get("matching-rule-version") ?? "shielded-monitor/v1",
          ledgerBuild: flags.get("ledger-build") ?? LEDGER_BUILD_ID,
          ...(flags.get("source-genesis-hash") !== undefined
            ? { sourceGenesisHash: flags.get("source-genesis-hash")! }
            : {}),
          ...(flags.get("source-instance-id") !== undefined
            ? { sourceInstanceId: flags.get("source-instance-id")! }
            : {}),
          actor,
        });
        print(monitor);
        return 0;
      }

      case "status": {
        print(await store.get(requireFlag(flags, "id")));
        return 0;
      }

      case "inspect": {
        print(await store.getIncludingRevoked(requireFlag(flags, "id")) ?? { found: false });
        return 0;
      }

      case "list": {
        print(await store.listActive(Number(flags.get("limit") ?? "100")));
        return 0;
      }

      case "advance": {
        const associationsPath = flags.get("associations");
        const entries: AssociationFileEntry[] = associationsPath === undefined
          ? []
          : (JSON.parse(await readFile(associationsPath, "utf8")) as AssociationFileEntry[]);
        const result = await store.advance(
          requireFlag(flags, "id"),
          BigInt(requireFlag(flags, "epoch")),
          BigInt(requireFlag(flags, "through")),
          entries.map((e) => toAssociationInput(e, net)),
          ...(flags.get("from") !== undefined ? [{ fromHeight: BigInt(flags.get("from")!) }] : []),
        );
        print(result);
        return 0;
      }

      case "events": {
        print(await store.listLifecycleEvents(requireFlag(flags, "id")));
        return 0;
      }

      case "associations": {
        print(await store.readAssociations(
          requireFlag(flags, "id"),
          BigInt(flags.get("after") ?? "0"),
          Number(flags.get("limit") ?? "100"),
        ));
        return 0;
      }

      case "go-live": {
        print(await store.goLive(requireFlag(flags, "id"), BigInt(requireFlag(flags, "epoch")), actor));
        return 0;
      }

      case "pause": {
        print(await store.pause(requireFlag(flags, "id"), actor));
        return 0;
      }

      case "resume": {
        print(await store.resume(requireFlag(flags, "id"), actor));
        return 0;
      }

      case "fail": {
        print(await store.markFailed(requireFlag(flags, "id"), actor, {
          code: requireFlag(flags, "code"),
          message: requireFlag(flags, "message"),
        }));
        return 0;
      }

      case "stale-source": {
        print(await store.markStaleSource(requireFlag(flags, "id"), actor, {
          code: requireFlag(flags, "code"),
          message: requireFlag(flags, "message"),
        }));
        return 0;
      }

      case "revoke": {
        print(await store.revoke(requireFlag(flags, "id"), actor));
        return 0;
      }

      case "delete": {
        print(await store.delete(requireFlag(flags, "id"), actor) ?? { found: false });
        return 0;
      }

      case "export-revocations": {
        const list = await exportRevocationList(store, schema);
        await writeFile(requireFlag(flags, "out"), JSON.stringify(list, null, 2) + "\n", "utf8");
        print({ exported: list.revocations.length, to: requireFlag(flags, "out") });
        return 0;
      }

      case "apply-revocations": {
        const list = JSON.parse(await readFile(requireFlag(flags, "in"), "utf8")) as RevocationListFile;
        print(await applyRevocationList(store, list, actor));
        return 0;
      }

      default: {
        process.stderr.write(`unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
        return 2;
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Entry point when run directly. Errors print their message only — never the key, never a
 *  request body, and (for `InvalidViewingKeyError`) never anything that says WHICH part of the
 *  key was wrong beyond the generic message. */
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runHarness(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
