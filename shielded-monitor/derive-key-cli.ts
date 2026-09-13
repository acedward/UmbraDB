#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { loadLedgerV8 } from "../chain-archive-sync/tx-replay-decoder.js";
import { deriveMidnightRoleSeed, midnightRolePath, MIDNIGHT_ROLES } from "./hd.js";
import { encodeViewingKey, hrpForNetwork, parseViewingKey } from "./viewing-key.js";

/**
 * `umbradb-shielded-monitor-derive-key` — turn a seed into the viewing key this service registers
 * and the address a funder pays (organizer sub-plan 00009-06;
 * `openspec/changes/00009-06-dashboard/design.md` §4).
 *
 * ── Why this is its own bin and not a subcommand of the reference client ────────────────────
 * `shielded-monitor/client/cli.ts` is governed by an import audit
 * (`test/shielded-monitor/client-cli.integration.test.ts`) that requires it to import **nothing
 * but Node built-ins**, because its value as acceptance evidence is that an application with no
 * database credentials and no repository types can complete the whole flow over HTTP. This command
 * must load the vendored ledger WASM and this repository's own Bech32m encoder, so putting it
 * there would mean editing that audit to carve out an exception — weakening a gate to satisfy a
 * naming preference. Recorded as organizer question Q20.
 *
 * ── What it prints, and what it never prints ────────────────────────────────────────────────
 * Prints: the Bech32m `mn_shield-esk_<net>` viewing key, the shielded **coin public key**, the
 * shielded **encryption public key**, the network, and — in `--hd` mode — the derivation path.
 * The two public keys are the halves of a Midnight shielded address: they are public by
 * construction and they are what the operator needs in order to send funds to the wallet whose
 * key they just registered.
 *
 * Never prints: the seed, the derived role seed, the coin secret key, or anything else from which
 * a spender could be reconstructed. The viewing key itself IS secret — it grants read access to
 * that wallet's history — and it is printed because printing it is the entire purpose of the
 * command; `--quiet` exists so it can be redirected into a file without the surrounding prose.
 *
 * ── Why the seed comes from a file ──────────────────────────────────────────────────────────
 * The same rule the reference client and the harness already follow: an argument lands in the
 * shell history and in every `ps` listing on a shared host, and neither can be un-written.
 * `--seed <hex>` is therefore a usage error with an explicit message, not a silently accepted
 * convenience.
 */

const USAGE = `umbradb-shielded-monitor-derive-key — derive a shielded viewing key from a seed

Usage: umbradb-shielded-monitor-derive-key --seed-file <path> [options]

Required
  --seed-file <path>     file holding a 32-byte seed as 64 hexadecimal characters
                         (whitespace and an optional 0x prefix are ignored).
                         The seed is NEVER accepted on the command line.

Options
  --net <id>             network the key is encoded for (default: $SHIELDED_MONITOR_NET or undeployed)
  --hd                   derive the wallet's Zswap role key first, i.e.
                         m/44'/2400'/<account>'/3/<index> (BIP-0032, secp256k1),
                         instead of using the seed directly
  --account <n>          HD account index, hardened (default: 0; implies --hd)
  --index <n>            HD address index (default: 0; implies --hd)
  --quiet                print only the Bech32m viewing key, for redirection into a key file

Output (default)
  a JSON object with viewingKey, coinPublicKey, encryptionPublicKey, net and (with --hd) path.

Exit codes
  0  success
  1  a local error (unreadable file, ledger unavailable)
  2  usage error
`;

class UsageError extends Error {}

interface Parsed {
  readonly flags: ReadonlyMap<string, string>;
  readonly switches: ReadonlySet<string>;
}

/** Flags that take a value; everything else with a `--` prefix is a switch. Written out rather
 *  than inferred from the next token, so `--hd --net undeployed` cannot silently read `--net` as
 *  the value of `--hd`. */
const VALUE_FLAGS = new Set(["seed-file", "net", "account", "index"]);

/** The message for the one mistake this command exists to make impossible. Raised from the
 *  parser, before the value is even looked at, so it fires whether or not a value follows. */
const SEED_ON_ARGV =
  "the seed is never read from the command line; write it to a file and pass --seed-file <path>";

function parseArgs(argv: readonly string[]): Parsed {
  const flags = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) throw new UsageError(`unexpected argument ${JSON.stringify(token)}`);
    const name = token.slice(2);
    // Checked here rather than after parsing, so `--seed <hex>` cannot be reported as "unexpected
    // argument <hex>" — a message that would put the seed in the caller's scrollback.
    if (name === "seed") throw new UsageError(SEED_ON_ARGV);
    if (VALUE_FLAGS.has(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      flags.set(name, value);
      i += 1;
    } else {
      switches.add(name);
    }
  }
  return { flags, switches };
}

/** Reads the seed from a file and rejects everything that is not exactly 32 bytes of hex.
 *
 *  The strictness is the point: a 31-byte seed, a seed with a stray character, or a file that
 *  happens to contain a Bech32m key would each derive *some* key, and the operator would discover
 *  the mistake only when funds sent to the derived address never showed up. */
async function readSeed(path: string): Promise<Buffer> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read the seed file ${JSON.stringify(path)}: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
  }
  const cleaned = text.trim().replace(/\s+/g, "").replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    // Deliberately says what was wrong WITHOUT quoting the contents: an error message that echoed
    // a malformed seed would put it in the shell's scrollback and in any log the caller keeps.
    throw new UsageError(
      `the seed file must hold exactly 64 hexadecimal characters (32 bytes); got ${cleaned.length} non-whitespace character(s)` +
        (/^[0-9a-fA-F]*$/.test(cleaned) ? "" : " including non-hexadecimal characters"),
    );
  }
  return Buffer.from(cleaned, "hex");
}

function readIndex(flags: ReadonlyMap<string, string>, name: string): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  if (!/^\d{1,10}$/.test(raw)) throw new UsageError(`--${name} must be a non-negative integer`);
  return Number(raw);
}

/** The slice of the ledger WASM this command uses (`vendor/ledger-v8-syshash/midnight_ledger_wasm.d.ts:943-954`). */
interface LedgerKeysApi {
  ZswapSecretKeys: {
    fromSeed(seed: Uint8Array): {
      readonly coinPublicKey: string;
      readonly encryptionPublicKey: string;
      readonly encryptionSecretKey: {
        yesIKnowTheSecurityImplicationsOfThis_serialize(): Uint8Array;
        clear?(): void;
        free?(): void;
      };
      clear?(): void;
      free?(): void;
    };
  };
}

export interface DerivedKey {
  readonly viewingKey: string;
  readonly coinPublicKey: string;
  readonly encryptionPublicKey: string;
  readonly net: string;
  readonly path?: string;
}

/**
 * The whole computation, separated from argument parsing and printing so a test can call it.
 *
 * The ledger handles are cleared and freed in a `finally`: they hold the spend authority for the
 * wallet this seed belongs to, and they exist here only long enough to read two public strings and
 * one serialized secret.
 */
export async function deriveViewingKey(
  seed: Uint8Array,
  options: { readonly net: string; readonly hd: boolean; readonly account?: number; readonly index?: number },
): Promise<DerivedKey> {
  const ledger = (await loadLedgerV8()) as unknown as LedgerKeysApi;
  const path = options.hd ? midnightRolePath({ account: options.account, index: options.index }) : undefined;
  const material = path === undefined
    ? Buffer.from(seed)
    : deriveMidnightRoleSeed(seed, { account: options.account, index: options.index });

  const keys = ledger.ZswapSecretKeys.fromSeed(material);
  try {
    const serialized = keys.encryptionSecretKey.yesIKnowTheSecurityImplicationsOfThis_serialize();
    // Encoded with the SERVICE's own encoder, and then put through the service's own intake
    // before it is printed. Deriving a key the deployment would refuse is a failure worth
    // catching here rather than in the register form.
    const viewingKey = encodeViewingKey(serialized, options.net);
    await parseViewingKey(viewingKey, options.net);
    return {
      viewingKey,
      coinPublicKey: keys.coinPublicKey,
      encryptionPublicKey: keys.encryptionPublicKey,
      net: options.net,
      ...(path !== undefined ? { path: path.text } : {}),
    };
  } finally {
    try {
      keys.encryptionSecretKey.clear?.();
    } catch {
      // best effort; see `viewing-key.ts`'s note on why a disposal fault may not escape
    }
    try {
      keys.clear?.();
    } catch {
      // best effort
    }
    // `material` is this process's copy of wallet-spending material in BOTH modes — the derived
    // role seed under `--hd`, a copy of the caller's seed otherwise. Zero it either way; the
    // caller zeroes its own seed buffer separately.
    material.fill(0);
  }
}

export async function runDeriveKey(
  argv: readonly string[],
  out: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<number> {
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    out(USAGE.trimEnd());
    return 0;
  }
  const { flags, switches } = parseArgs(argv);

  // Belt and braces: `parseArgs` already refuses `--seed`, and this is what keeps that true if the
  // parser is ever rewritten.
  if (flags.has("seed") || switches.has("seed")) throw new UsageError(SEED_ON_ARGV);
  const seedFile = flags.get("seed-file");
  if (seedFile === undefined) throw new UsageError("missing required flag --seed-file");

  const net = flags.get("net") ?? process.env.SHIELDED_MONITOR_NET?.trim() ?? "undeployed";
  // Fails here, with a named reason, rather than deep inside Bech32m encoding.
  hrpForNetwork(net);

  const account = readIndex(flags, "account");
  const index = readIndex(flags, "index");
  const hd = switches.has("hd") || account !== undefined || index !== undefined;

  const seed = await readSeed(seedFile);
  let derived: DerivedKey;
  try {
    derived = await deriveViewingKey(seed, { net, hd, ...(account !== undefined ? { account } : {}), ...(index !== undefined ? { index } : {}) });
  } finally {
    seed.fill(0);
  }

  if (switches.has("quiet")) {
    out(derived.viewingKey);
    return 0;
  }
  out(JSON.stringify(derived, null, 2));
  out("");
  out(`# role: ${derived.path ?? "raw seed (no HD derivation; pass --hd for the wallet's Zswap role key)"}`);
  if (derived.path !== undefined) out(`# role index ${MIDNIGHT_ROLES.Zswap} is the wallet's Zswap (shielded) role`);
  out("# viewingKey is SECRET: it grants read access to this wallet's shielded history.");
  out("# coinPublicKey and encryptionPublicKey are the two halves of the shielded address to fund.");
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runDeriveKey(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      if (err instanceof UsageError) process.stderr.write(`\n${USAGE}`);
      process.exit(err instanceof UsageError ? 2 : 1);
    },
  );
}
