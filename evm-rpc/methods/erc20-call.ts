/**
 * `eth_call` for the ERC20 view functions, answered from the `evm_rpc.logs` table.
 *
 * This is what lets a browser wallet IMPORT a watched token: MetaMask's "Import tokens" flow
 * calls `symbol()`, `decimals()` and `balanceOf(you)`, and its Send flow then produces
 * `transfer(address,uint256)` calldata (selector `0xa9059cbb`) — the only shape Part E's
 * relayer accepts. Without this, MetaMask cannot see the token and its Send button falls back
 * to a NATIVE transfer, whose empty calldata the relayer rejects.
 *
 * Balances are folded from Transfer logs (received − sent), the same computation an EVM
 * explorer performs and the same one the dashboard's "Token balance" button uses. There is no
 * contract execution here: Midnight contract state is a ledger blob, not EVM storage, so a
 * genuine `eth_call` into contract code is not possible — the log fold is the honest analogue.
 * Non-ERC20-view calldata returns `0x` (the previous stub's behavior).
 *
 * **decimals()** defaults to **0**: the Compact contracts store `Uint<128>` WHOLE units and the
 * events carry those units verbatim, so a mint of 100 is 100 tokens, not 100 wei-equivalents.
 * A token's `deployment.json` may nominally declare `decimals: 18` (ERC20 convention copied at
 * deploy time); that value does NOT describe the emitted amounts, so it is deliberately ignored
 * unless a watch entry sets `evmDecimals` explicitly.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { defaultAddressMapper, toHex } from "../logs/event-map.js";
import type { MethodRegistry } from "../registry.js";
import type { SqlLike } from "../logs/address-map.js";

const SELECTORS = {
  balanceOf: "70a08231",
  decimals: "313ce567",
  symbol: "95d89b41",
  name: "06fdde03",
  totalSupply: "18160ddd",
} as const;

/** `keccak256("Transfer(address,address,uint256)")`, unprefixed — the only topic0 we fold. */
const TRANSFER_TOPIC0 = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface TokenMeta {
  /** 20-byte EVM address of the token contract, lowercase unprefixed hex. */
  evmAddr: string;
  name: string;
  symbol: string;
  decimals: number;
}

function abiUint(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function abiString(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  const len = bytes.length.toString(16).padStart(64, "0");
  const padded = Buffer.concat([bytes, Buffer.alloc((32 - (bytes.length % 32)) % 32)]).toString("hex");
  return `0x${(32).toString(16).padStart(64, "0")}${len}${padded}`;
}

/** Reads watch entries + optional deployment files into token metadata keyed by EVM address. */
export function loadTokenMeta(watchFile: string): TokenMeta[] {
  const raw = JSON.parse(readFileSync(watchFile, "utf8")) as Array<{
    address: string;
    profile?: string;
    deploymentFile?: string;
    name?: string;
    symbol?: string;
    evmDecimals?: number;
  }>;
  const base = dirname(resolve(watchFile));
  return raw.map((entry) => {
    let name = entry.name;
    let symbol = entry.symbol;
    if ((name === undefined || symbol === undefined) && entry.deploymentFile !== undefined) {
      try {
        const dep = JSON.parse(readFileSync(resolve(base, entry.deploymentFile), "utf8")) as {
          name?: string;
          symbol?: string;
        };
        name ??= dep.name;
        symbol ??= dep.symbol;
      } catch {
        // A missing/unreadable deployment file is not fatal — fall through to defaults.
      }
    }
    const evmAddr = toHex(defaultAddressMapper({ kind: "contract", hex: entry.address })).replace(/^0x/, "").toLowerCase();
    return {
      evmAddr,
      name: name ?? `Umbra Token ${entry.address.slice(0, 6)}`,
      symbol: symbol ?? "UMBRA",
      decimals: entry.evmDecimals ?? 0,
    };
  });
}

export interface Erc20CallOptions {
  registry: MethodRegistry;
  sql: SqlLike;
  schema: string;
  tokens: readonly TokenMeta[];
}

export function registerErc20Call(options: Erc20CallOptions): void {
  const { registry, sql, schema, tokens } = options;
  const byAddr = new Map(tokens.map((t) => [t.evmAddr, t]));

  async function balanceOf(token: TokenMeta, holder: string): Promise<bigint> {
    const rows = await sql<{ t1: string | null; t2: string | null; d: string | null }[]>`
      SELECT encode(l.topic1, 'hex') AS t1, encode(l.topic2, 'hex') AS t2, encode(l.data, 'hex') AS d
      FROM ${sql(schema)}.logs l
      JOIN ${sql(schema)}.address_map am ON am.id = l.address_id
      WHERE am.evm_addr = decode(${token.evmAddr}, 'hex')
        AND encode(l.topic0, 'hex') = ${TRANSFER_TOPIC0}
    `;
    const padded = holder.padStart(64, "0");
    let balance = 0n;
    for (const row of rows) {
      const amount = row.d ? BigInt(`0x${row.d}`) : 0n;
      if (row.t2 === padded) balance += amount;
      if (row.t1 === padded) balance -= amount;
    }
    return balance;
  }

  async function totalSupply(token: TokenMeta): Promise<bigint> {
    const rows = await sql<{ t1: string | null; t2: string | null; d: string | null }[]>`
      SELECT encode(l.topic1, 'hex') AS t1, encode(l.topic2, 'hex') AS t2, encode(l.data, 'hex') AS d
      FROM ${sql(schema)}.logs l
      JOIN ${sql(schema)}.address_map am ON am.id = l.address_id
      WHERE am.evm_addr = decode(${token.evmAddr}, 'hex')
        AND encode(l.topic0, 'hex') = ${TRANSFER_TOPIC0}
    `;
    const zero = "0".repeat(64);
    let supply = 0n;
    for (const row of rows) {
      const amount = row.d ? BigInt(`0x${row.d}`) : 0n;
      if (row.t1 === zero) supply += amount; // mint
      if (row.t2 === zero) supply -= amount; // burn
    }
    return supply;
  }

  registry.registerMethod(
    "eth_call",
    async (params) => {
      const list = Array.isArray(params) ? params : params === undefined ? [] : [params];
      const call = list[0] as { to?: string; data?: string } | undefined;
      const to = (call?.to ?? "").replace(/^0x/, "").toLowerCase();
      const data = (call?.data ?? "").replace(/^0x/, "").toLowerCase();
      const token = byAddr.get(to);
      if (token === undefined || data.length < 8) return "0x";

      const selector = data.slice(0, 8);
      switch (selector) {
        case SELECTORS.decimals:
          return abiUint(BigInt(token.decimals));
        case SELECTORS.symbol:
          return abiString(token.symbol);
        case SELECTORS.name:
          return abiString(token.name);
        case SELECTORS.totalSupply:
          return abiUint(await totalSupply(token));
        case SELECTORS.balanceOf: {
          const holder = data.slice(8 + 24, 8 + 64); // last 20 bytes of the padded argument
          if (holder.length !== 40) return "0x";
          return abiUint(await balanceOf(token, holder));
        }
        default:
          return "0x";
      }
    },
    { replace: true },
  );
}
