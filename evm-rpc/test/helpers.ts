import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { emptyEvmRpcReader, type EvmRpcReader } from "../db.js";
import type { IndexerBlock, IndexerReader, IndexerTransactionLookup } from "../indexer-gql.js";
import type { RpcContext } from "../registry.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));

export async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(resolve(testDirectory, "fixtures", name), "utf8")) as T;
}

export async function assertJsonSchema(name: string, value: unknown): Promise<void> {
  const schema = JSON.parse(await readFile(resolve(testDirectory, name), "utf8")) as Record<string, unknown>;
  z.fromJSONSchema(schema).parse(value);
}

export function fakeIndexer(overrides: Partial<IndexerReader> = {}): IndexerReader {
  return {
    async getLatestBlock() { return undefined; },
    async getBlockByHeight() { return undefined; },
    async getBlockByHash() { return undefined; },
    async getTransactionByHash(): Promise<IndexerTransactionLookup> { return { transaction: undefined, matchCount: 0 }; },
    ...overrides,
  };
}

export function context(options: { indexer?: IndexerReader; db?: EvmRpcReader } = {}): RpcContext {
  return {
    chainId: 2400n,
    clientVersion: "umbradb-evm-rpc/0.9.5",
    indexer: options.indexer ?? fakeIndexer(),
    db: options.db ?? emptyEvmRpcReader,
  };
}

export type { EvmRpcReader, IndexerBlock };
