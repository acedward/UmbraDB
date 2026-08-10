export interface FoldUtxo {
  owner: string;
  tokenType: string;
  value: bigint;
  intentHash: string;
  outputIndex: number;
  createdTransactionId: number;
  spentTransactionId?: number;
}

export interface UtxoDelta {
  created: readonly FoldUtxo[];
  spent: readonly FoldUtxo[];
}

export interface FoldResult {
  utxos: Map<string, FoldUtxo>;
  balances: Map<string, bigint>;
}

export function utxoIdentity(utxo: Pick<FoldUtxo, "intentHash" | "outputIndex">): string {
  return `${utxo.intentHash.toLowerCase()}:${utxo.outputIndex}`;
}

export function balanceIdentity(utxo: Pick<FoldUtxo, "owner" | "tokenType">): string {
  return `${utxo.owner}:${utxo.tokenType.toLowerCase()}`;
}

/** Pure idempotent fold used as the monitor's executable balance model. */
export function foldUtxos(previous: Iterable<FoldUtxo>, delta: UtxoDelta): FoldResult {
  const utxos = new Map<string, FoldUtxo>();
  for (const utxo of previous) utxos.set(utxoIdentity(utxo), { ...utxo });

  for (const created of delta.created) {
    const key = utxoIdentity(created);
    const existing = utxos.get(key);
    // A delayed duplicate creation event must never resurrect an output already marked spent.
    utxos.set(key, { ...created, spentTransactionId: existing?.spentTransactionId ?? created.spentTransactionId });
  }
  for (const spent of delta.spent) {
    const key = utxoIdentity(spent);
    const existing = utxos.get(key);
    utxos.set(key, {
      ...(existing ?? spent),
      spentTransactionId: existing?.spentTransactionId ?? spent.spentTransactionId,
    });
  }

  const balances = new Map<string, bigint>();
  for (const utxo of utxos.values()) {
    if (utxo.spentTransactionId !== undefined) continue;
    const key = balanceIdentity(utxo);
    balances.set(key, (balances.get(key) ?? 0n) + utxo.value);
  }
  return { utxos, balances };
}
