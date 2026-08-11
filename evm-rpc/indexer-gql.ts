export class IndexerGqlError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "IndexerGqlError";
  }
}

export interface IndexerBlockTransaction {
  readonly hash: string;
}

export interface IndexerBlock {
  readonly hash: string;
  readonly height: number;
  readonly timestamp: number;
  readonly author: string | null;
  readonly parent: { readonly hash: string } | null;
  readonly transactions: readonly IndexerBlockTransaction[];
}

export interface IndexerTransaction {
  readonly __typename?: string;
  readonly hash: string;
  readonly raw?: string;
  readonly fee?: string | null;
  readonly identifiers?: readonly string[];
  readonly transactionResult?: {
    readonly status: "SUCCESS" | "PARTIAL_SUCCESS" | "FAILURE" | string;
    readonly segments: readonly { readonly id: number; readonly success: boolean }[] | null;
  };
  readonly block: { readonly height: number; readonly hash: string; readonly timestamp: number };
}

export interface IndexerTransactionLookup {
  readonly transaction: IndexerTransaction | undefined;
  readonly matchCount: number;
}

export interface IndexerReader {
  getLatestBlock(): Promise<IndexerBlock | undefined>;
  getBlockByHeight(height: number): Promise<IndexerBlock | undefined>;
  getBlockByHash(hash: string): Promise<IndexerBlock | undefined>;
  getTransactionByHash(hash: string): Promise<IndexerTransactionLookup>;
}

export interface IndexerGqlClientOptions {
  readonly url: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface GraphQlEnvelope<T> {
  readonly data?: T;
  readonly errors?: readonly { readonly message: string }[];
}

const BLOCK_FIELDS = `
  hash height timestamp author
  parent { hash }
  transactions { hash }
`;

export class IndexerGqlClient implements IndexerReader {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: IndexerGqlClientOptions) {
    this.#url = options.url;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
  }

  async #query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new IndexerGqlError(`GraphQL request to ${this.#url} failed`, error);
    }
    if (!response.ok) throw new IndexerGqlError(`GraphQL HTTP ${response.status} from ${this.#url}`);

    let body: GraphQlEnvelope<T>;
    try {
      body = (await response.json()) as GraphQlEnvelope<T>;
    } catch (error) {
      throw new IndexerGqlError(`GraphQL response from ${this.#url} was not valid JSON`, error);
    }
    if (body.errors !== undefined && body.errors.length > 0) {
      throw new IndexerGqlError(`GraphQL error: ${body.errors.map(({ message }) => message).join("; ")}`);
    }
    if (body.data === undefined) throw new IndexerGqlError("GraphQL response did not contain data");
    return body.data;
  }

  async getLatestBlock(): Promise<IndexerBlock | undefined> {
    const data = await this.#query<{ block: IndexerBlock | null }>(`{ block { ${BLOCK_FIELDS} } }`);
    return data.block ?? undefined;
  }

  async getBlockByHeight(height: number): Promise<IndexerBlock | undefined> {
    const data = await this.#query<{ block: IndexerBlock | null }>(
      `query($height: Int!) { block(offset: { height: $height }) { ${BLOCK_FIELDS} } }`,
      { height },
    );
    return data.block ?? undefined;
  }

  async getBlockByHash(hash: string): Promise<IndexerBlock | undefined> {
    const data = await this.#query<{ block: IndexerBlock | null }>(
      `query($hash: HexEncoded!) { block(offset: { hash: $hash }) { ${BLOCK_FIELDS} } }`,
      { hash },
    );
    return data.block ?? undefined;
  }

  async getTransactionByHash(hash: string): Promise<IndexerTransactionLookup> {
    const data = await this.#query<{ transactions: IndexerTransaction[] }>(
      `query($hash: HexEncoded!) {
        transactions(offset: { hash: $hash }) {
          __typename hash
          block { height hash timestamp }
          ... on RegularTransaction {
            raw fee identifiers
            transactionResult { status segments { id success } }
          }
        }
      }`,
      { hash },
    );
    return { transaction: data.transactions[0], matchCount: data.transactions.length };
  }
}

