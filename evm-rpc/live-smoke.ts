/** Reproducible live checks for the source-checkout EVM RPC entrypoint. */

interface RpcEnvelope<T> {
  readonly result?: T;
  readonly error?: { readonly code: number; readonly message: string };
}

const endpoint = process.env.EVM_RPC ?? "http://127.0.0.1:10020";
const intervalMs = Number(process.env.EVM_RPC_SMOKE_INTERVAL_MS ?? "10000");
if (!Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 60_000) {
  throw new Error("EVM_RPC_SMOKE_INTERVAL_MS must be an integer from 0 through 60000");
}

let nextId = 1;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const body = await response.json() as RpcEnvelope<T>;
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.code} ${body.error.message}`);
  if (!("result" in body)) throw new Error(`${method}: response did not contain a result`);
  return body.result as T;
}

const first = await rpc<string>("eth_blockNumber", []);
const block = await rpc<Record<string, unknown>>("eth_getBlockByNumber", ["latest", false]);
await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
const second = await rpc<string>("eth_blockNumber", []);

if (BigInt(second) <= BigInt(first)) throw new Error(`block height did not advance: ${first} -> ${second}`);
if (typeof block.hash !== "string" || !/^0x[0-9a-f]{64}$/.test(block.hash)) throw new Error("latest block hash has the wrong shape");
if (typeof block.logsBloom !== "string" || block.logsBloom.length !== 514) throw new Error("latest block bloom is not 256 bytes");
if (Object.hasOwn(block, "baseFeePerGas")) throw new Error("latest block unexpectedly contains baseFeePerGas");

const evidence: Record<string, unknown> = { first, second, increased: true, blockNumber: block.number };
const address = process.env.EVM_RPC_TEST_ADDRESS;
if (address !== undefined) evidence.balance = await rpc<string>("eth_getBalance", [address, "earliest"]);
const txHash = process.env.EVM_RPC_TEST_TX_HASH;
if (txHash !== undefined) {
  evidence.transaction = await rpc<unknown>("eth_getTransactionByHash", [txHash]);
  evidence.receipt = await rpc<unknown>("eth_getTransactionReceipt", [txHash]);
}

// eslint-disable-next-line no-console
console.log(JSON.stringify(evidence));

