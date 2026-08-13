/* tslint:disable */
/* eslint-disable */
export function partitionTranscripts(calls: any[], params: LedgerParameters): Array<any>;
export function createCoinInfo(type_: string, value: any): any;
export function sampleDustSecretKey(): DustSecretKey;
export function updatedValue(ctime: Date, initial_value: bigint, gen_info: any, now: Date, params: any): bigint;
export function sampleEncryptionPublicKey(): string;
export function createCheckPayload(serialized_preimage: Uint8Array, ir?: Uint8Array | null): Uint8Array;
export function feeToken(): any;
export function dustNullifier(utxo: any, sk: DustSecretKey): bigint;
export function createShieldedCoinInfo(type_: string, value: any): any;
export function coinCommitment(coin: any, coin_public_key: string): string;
export function unshieldedToken(): any;
export function sampleCoinPublicKey(): string;
export function dustInitialNonce(output_no: bigint, intent_hash: string): string;
export function shieldedToken(): any;
export function createProvingPayload(serialized_preimage: Uint8Array, overwrite_binding_input: bigint | null | undefined, key_material: any): Uint8Array;
export function dustCommitment(utxo: any): bigint;
export function parseCheckResult(result: Uint8Array): Array<any>;
export function addressFromKey(key: string): string;
export function dustNonce(initial_nonce: string, seq: bigint, sk: DustSecretKey): bigint;
export function createProvingTransactionPayload(tx: Transaction, proving_data: Map<any, any>): Uint8Array;
export function nativeToken(): any;
export function sampleIntentHash(): string;
export function coinNullifier(coin_info: any, coin_secret_key: CoinSecretKey): string;
export function encodeUserAddress(addr: string): Uint8Array;
export function encodeContractAddress(addr: string): Uint8Array;
export function decodeRawTokenType(tt: Uint8Array): string;
export function encodeQualifiedShieldedCoinInfo(coin: any): any;
export function decodeShieldedCoinInfo(coin: any): any;
export function decodeUserAddress(addr: Uint8Array): string;
export function encodeShieldedCoinInfo(coin: any): any;
export function decodeQualifiedShieldedCoinInfo(coin: any): any;
export function encodeRawTokenType(tt: string): Uint8Array;
export function decodeCoinPublicKey(pk: Uint8Array): string;
export function encodeCoinPublicKey(pk: string): Uint8Array;
export function decodeContractAddress(addr: Uint8Array): string;
export function proofDataIntoSerializedPreimage(input: any, output: any, public_transcript: any, private_transcript_outputs: any, key_location?: string | null): Uint8Array;
export function sampleRawTokenType(): string;
export function communicationCommitment(input: any, output: any, rand: string): string;
export function persistentCommit(align: any, val: any, opening: any): any;
export function ecAdd(a: any, b: any): any;
export function ecMul(a: any, b: any): any;
export function maxAlignedSize(alignment: any): bigint;
export function dummyContractAddress(): string;
export function communicationCommitmentRandomness(): string;
export function sampleUserAddress(): string;
export function signatureVerifyingKey(key: string): string;
export function bigIntModFr(x: bigint): bigint;
export function runtimeCoinCommitment(coin: any, recipient: any): any;
export function verifySignature(key: string, data: Uint8Array, signature: string): boolean;
export function rawTokenType(domain_sep: Uint8Array, contract: string): string;
export function upgradeFromTransient(transient: any): any;
export function bigIntToValue(x: bigint): any;
export function hashToCurve(align: any, val: any): any;
export function runtimeCoinNullifier(coin: any, sender_evidence: any): any;
export function dummyUserAddress(): string;
export function transientHash(align: any, val: any): any;
export function persistentHash(align: any, val: any): any;
export function transientCommit(align: any, val: any, opening: any): any;
export function leafHash(value: any): any;
export function sampleSigningKey(): string;
export function valueToBigInt(x: any): bigint;
export function degradeToTransient(persistent: any): any;
export function signData(key: string, data: Uint8Array): string;
export function entryPointHash(entry_point: any): string;
export function ecMulGenerator(val: any): any;
export function maxField(): bigint;
export function signingKeyFromBip340(bytes: Uint8Array): string;
export function sampleContractAddress(): string;
export function runProgram(initial: VmStack, ops: any, cost_model: CostModel, gas_limit: any): VmResults;
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */
type ReadableStreamType = "bytes";
export class AuthorizedClaim {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(proof_marker: string, raw: Uint8Array): AuthorizedClaim;
  eraseProof(): AuthorizedClaim;
  constructor();
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  readonly coin: any;
  readonly recipient: string;
}
export class Binding {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): Binding;
  constructor(binding: string);
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  readonly instance: string;
}
export class ChargedState {
  free(): void;
  [Symbol.dispose](): void;
  constructor(state: StateValue);
  toString(compact?: boolean | null): string;
  readonly state: StateValue;
}
export class ClaimRewardsTransaction {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(signature_marker: string, raw: Uint8Array): ClaimRewardsTransaction;
  addSignature(signature: string): ClaimRewardsTransaction;
  eraseSignatures(): ClaimRewardsTransaction;
  static new(network_id: string, value: bigint, owner: string, nonce: string, kind: string): ClaimRewardsTransaction;
  constructor(signature_marker: string, network_id: string, value: bigint, owner: string, nonce: string, signature: any, kind: any);
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  readonly dataToSign: Uint8Array;
  readonly kind: string;
  readonly nonce: string;
  readonly owner: string;
  readonly value: bigint;
  readonly signature: any;
}
export class CoinSecretKey {
  free(): void;
  [Symbol.dispose](): void;
  public_key(): string;
  constructor();
  clear(): void;
  yesIKnowTheSecurityImplicationsOfThis_serialize(): Uint8Array;
}
export class ContractCall {
  free(): void;
  [Symbol.dispose](): void;
  constructor();
  toString(compact?: boolean | null): string;
  readonly entryPoint: any;
  readonly fallibleTranscript: any;
  readonly guaranteedTranscript: any;
  readonly communicationCommitment: string;
  readonly proof: any;
  readonly address: string;
}
export class ContractCallPrototype {
  free(): void;
  [Symbol.dispose](): void;
  constructor(address: string, entry_point: any, op: ContractOperation, guaranteed_public_transcript: any, fallible_public_transcript: any, private_transcript_outputs: any[], input: any, output: any, communication_commitment_rand: string, key_location: string);
  intoCall(_parent_binding: any): ContractCall;
  toString(compact?: boolean | null): string;
}
export class ContractDeploy {
  free(): void;
  [Symbol.dispose](): void;
  constructor(initial_state: ContractState);
  toString(compact?: boolean | null): string;
  readonly initialState: ContractState;
  readonly address: string;
}
export class ContractMaintenanceAuthority {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): ContractMaintenanceAuthority;
  constructor(committee: Array<any>, threshold: number, counter?: bigint | null);
  serialize(): any;
  toString(compact?: boolean | null): string;
  readonly counter: bigint;
  readonly committee: Array<any>;
  readonly threshold: number;
}
export class ContractOperation {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): ContractOperation;
  constructor();
  serialize(): any;
  toString(compact?: boolean | null): string;
  get verifierKey(): any;
  set verifierKey(value: Uint8Array);
}
export class ContractOperationVersion {
  free(): void;
  [Symbol.dispose](): void;
  constructor(version: string);
  toString(compact?: boolean | null): string;
  readonly version: string;
}
export class ContractOperationVersionedVerifierKey {
  free(): void;
  [Symbol.dispose](): void;
  constructor(version: string, raw_vk: Uint8Array);
  toString(compact?: boolean | null): string;
  readonly rawVk: Uint8Array;
  readonly version: string;
}
export class ContractState {
  free(): void;
  [Symbol.dispose](): void;
  operations(): any[];
  static deserialize(raw: Uint8Array): ContractState;
  setOperation(operation: any, value: ContractOperation): void;
  constructor();
  query(query: any, cost_model: CostModel): any;
  operation(operation: any): ContractOperation | undefined;
  serialize(): any;
  toString(compact?: boolean | null): string;
  balance: Map<any, any>;
  maintenanceAuthority: ContractMaintenanceAuthority;
  data: ChargedState;
}
export class CostModel {
  free(): void;
  [Symbol.dispose](): void;
  static initialCostModel(): CostModel;
  constructor();
  toString(compact?: boolean | null): string;
}
export class DustActions {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(signature_marker: string, proof_marker: string, raw: Uint8Array): DustActions;
  constructor(signature_marker: string, proof_marker: string, ctime: Date, spends: any, registrations: any);
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  get spends(): DustSpend[];
  set spends(value: any);
  get registrations(): DustRegistration[];
  set registrations(value: any);
  ctime: Date;
}
export class DustGenerationState {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): DustGenerationState;
  constructor();
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
}
export class DustLocalState {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): DustLocalState;
  removeUtxo(nullifier: bigint): DustLocalState;
  processTtls(time: Date): DustLocalState;
  replayEvents(sk: DustSecretKey, events: Event[]): DustLocalState;
  successorUtxo(utxo: any, now: Date, subtract_fee: bigint, new_commitment_index: bigint, sk: DustSecretKey): any;
  walletBalance(time: Date): bigint;
  generationInfo(qdo: any): any;
  insertCommitment(commitment_index: bigint, qdo: any, own_qdo: boolean): DustLocalState;
  removeCommitment(commitment_index: bigint): DustLocalState;
  replayRawEvents(sk: DustSecretKey, raw_events: Uint8Array): DustLocalStateWithChanges;
  commitmentTreeRoot(): any;
  generatingTreeRoot(): any;
  findUtxoByNullifier(nullifier: bigint): any;
  insertGenerationInfo(generation_index: bigint, generation: any, initial_nonce?: string | null): DustLocalState;
  removeGenerationInfo(generation_index: bigint, generation: any): DustLocalState;
  collapseCommitmentTree(commitment_index_start: bigint, commitment_index_end: bigint): DustLocalState;
  collapseGenerationTree(generation_index_start: bigint, generation_index_end: bigint): DustLocalState;
  replayEventsWithChanges(sk: DustSecretKey, events: Event[]): DustLocalStateWithChanges;
  applyCommitmentCollapsedUpdate(update: DustStateMerkleTreeCollapsedUpdate): DustLocalState;
  applyGenerationCollapsedUpdate(update: DustStateMerkleTreeCollapsedUpdate): DustLocalState;
  constructor(params: DustParameters);
  spend(sk: DustSecretKey, utxo: any, v_fee: bigint, ctime: Date): Array<any>;
  addUtxo(nullifier: bigint, utxo: any, pending_until?: Date | null): DustLocalState;
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  readonly utxos: any[];
  readonly params: DustParameters;
  readonly syncTime: Date;
}
export class DustLocalStateWithChanges {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly state: DustLocalState;
  readonly changes: DustStateChanges[];
}
export class DustParameters {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): DustParameters;
  constructor(night_dust_ratio: bigint, generation_decay_rate: bigint, dust_grace_period_seconds: bigint);
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  nightDustRatio: bigint;
  readonly timeToCapSeconds: bigint;
  generationDecayRate: bigint;
  dustGracePeriodSeconds: bigint;
}
export class DustRegistration {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(signature_marker: string, raw: Uint8Array): DustRegistration;
  constructor(signature_marker: string, night_key: string, dust_address: bigint | null | undefined, allow_fee_payment: bigint, signature: any);
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  get dustAddress(): bigint | undefined;
  set dustAddress(value: bigint | null | undefined);
  nightKey: string;
  signature: any;
  allowFeePayment: bigint;
}
export class DustSecretKey {
  free(): void;
  [Symbol.dispose](): void;
  static fromBigint(bigint: bigint): DustSecretKey;
  constructor();
  clear(): void;
  static fromSeed(seed: Uint8Array): DustSecretKey;
  readonly publicKey: bigint;
}
export class DustSpend {
  free(): void;
  [Symbol.dispose](): void;
  constructor();
  toString(compact?: boolean | null): string;
  readonly oldNullifier: bigint;
  readonly newCommitment: bigint;
  readonly proof: any;
  readonly vFee: bigint;
}
export class DustState {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): DustState;
  constructor();
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  readonly generation: DustGenerationState;
  readonly utxo: DustUtxoState;
}
export class DustStateChanges {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly spentUtxos: Array<any>;
  readonly receivedUtxos: Array<any>;
  readonly source: string;
}
export class DustStateMerkleTreeCollapsedUpdate {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): DustStateMerkleTreeCollapsedUpdate;
  static newFromCommitmentTree(state: DustUtxoState, start: bigint, end: bigint): DustStateMerkleTreeCollapsedUpdate;
  static newFromGenerationTree(state: DustGenerationState, start: bigint, end: bigint): DustStateMerkleTreeCollapsedUpdate;
  constructor();
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
}
export class DustUtxoState {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): DustUtxoState;
  constructor();
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
}
export class EncryptionSecretKey {
  free(): void;
  [Symbol.dispose](): void;
  public_key(): string;
  static deserialize(raw: Uint8Array): EncryptionSecretKey;
  yesIKnowTheSecurityImplicationsOfThis_taggedSerialize(): Uint8Array;
  static taggedDeserialize(raw: Uint8Array): EncryptionSecretKey;
  constructor();
  test(offer: ZswapOffer): boolean;
  clear(): void;
  yesIKnowTheSecurityImplicationsOfThis_serialize(): Uint8Array;
}
export class Event {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): Event;
  constructor();
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  readonly source: any;
  readonly content: any;
}
export class Intent {
  free(): void;
  [Symbol.dispose](): void;
  addDeploy(deploy: ContractDeploy): Intent;
  static deserialize(signature_marker: string, proof_marker: string, binding_marker: string, raw: Uint8Array): Intent;
  intentHash(segment_id: number): string;
  eraseProofs(): Intent;
  signatureData(segment_id: number): Uint8Array;
  eraseSignatures(): Intent;
  has_fallible_offers(): boolean;
  addMaintenanceUpdate(update: MaintenanceUpdate): Intent;
  has_contract_deployments(): boolean;
  has_fallible_transcripts(): boolean;
  static new(ttl: Date): Intent;
  bind(segment_id: number): Intent;
  addCall(call: ContractCallPrototype): Intent;
  constructor();
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  actions: any[];
  dustActions: any;
  get fallibleUnshieldedOffer(): UnshieldedOffer | undefined;
  set fallibleUnshieldedOffer(value: any);
  get guaranteedUnshieldedOffer(): UnshieldedOffer | undefined;
  set guaranteedUnshieldedOffer(value: any);
  ttl: Date;
  readonly binding: any;
}
export class IntoUnderlyingByteSource {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  pull(controller: ReadableByteStreamController): Promise<any>;
  start(controller: ReadableByteStreamController): void;
  cancel(): void;
  readonly autoAllocateChunkSize: number;
  readonly type: ReadableStreamType;
}
export class IntoUnderlyingSink {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  abort(reason: any): Promise<any>;
  close(): Promise<any>;
  write(chunk: any): Promise<any>;
}
export class IntoUnderlyingSource {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  pull(controller: ReadableStreamDefaultController): Promise<any>;
  cancel(): void;
}
export class LedgerParameters {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): LedgerParameters;
  static initialParameters(): LedgerParameters;
  normalizeFullness(fullness: any): any;
  maxPriceAdjustment(): number;
  /**
   * Normalize a block's fullness, clamping each dimension to its limit first.
   *
   * `normalizeFullness` returns `None` -- and so throws here -- when any dimension exceeds its
   * limit. That is not what the node does. The node clamps to the limits and then normalizes,
   * reporting an overfull block as exactly full rather than failing the block; see
   * `clamp_and_normalize` in the node's ledger helpers, which `post_block_update` calls on
   * every block. A consumer replaying blocks must match that behaviour or it will throw where
   * the chain proceeded, and diverge from the chain's own recorded state.
   *
   * Blocks should never exceed the limits -- validation is supposed to prevent it -- so this
   * differs from `normalizeFullness` only in the case that ought to be impossible. It is the
   * one to use when reproducing the chain; `normalizeFullness` is the one to use when you
   * want to be told that an input was over the limits.
   */
  clampAndNormalizeFullness(fullness: any): any;
  constructor();
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  readonly feePrices: any;
  /**
   * The per-block limit for each cost dimension.
   *
   * This is the denominator `normalizeFullness` divides by. Exposing it lets a consumer see
   * how close a block came to each limit, and lets a clamping normalizer be checked against
   * the same numbers the ledger used.
   */
  readonly blockLimits: any;
  readonly transactionCostModel: TransactionCostModel;
  readonly dust: DustParameters;
}
export class LedgerState {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): LedgerState;
  updateIndex(address: string, state: ChargedState, balances_map: Map<any, any>): LedgerState;
  applySystemTx(tx: SystemTransaction, tblock: Date): Array<any>;
  bridgeReceiving(recipient: string): bigint;
  testingDistributeNight(user_address: string, amount: bigint, tblock: Date): LedgerState;
  treasuryBalance(token_type: any): bigint;
  postBlockUpdate(tblock: Date, detailed_fullness: any, overall_fullness: any): LedgerState;
  unclaimedBlockRewards(recipient: string): bigint;
  constructor(network_id: string, zswap: ZswapChainState);
  apply(transaction: VerifiedTransaction, context: TransactionContext): any;
  static blank(network_id: string): LedgerState;
  index(address: string): ContractState | undefined;
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  parameters: LedgerParameters;
  readonly lockedPool: bigint;
  readonly reservePool: bigint;
  readonly blockRewardPool: bigint;
  readonly dust: DustState;
  readonly utxo: UtxoState;
  readonly zswap: ZswapChainState;
}
export class MaintenanceUpdate {
  free(): void;
  [Symbol.dispose](): void;
  addSignature(idx: bigint, signature: string): MaintenanceUpdate;
  constructor(address: string, updates: any[], counter: bigint);
  toString(compact?: boolean | null): string;
  readonly signatures: any[];
  readonly dataToSign: Uint8Array;
  readonly address: string;
  readonly counter: bigint;
  readonly updates: any[];
}
export class MerkleTreeCollapsedUpdate {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): MerkleTreeCollapsedUpdate;
  constructor(state: ZswapChainState, start: bigint, end: bigint);
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
}
export class NoBinding {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): NoBinding;
  constructor(binding: string);
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  readonly instance: string;
}
export class NoProof {
  free(): void;
  [Symbol.dispose](): void;
  constructor();
  toString(_compact?: boolean | null): string;
  readonly instance: string;
}
export class PreBinding {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): PreBinding;
  constructor(binding: string);
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  readonly instance: string;
}
export class PrePartitionContractCall {
  free(): void;
  [Symbol.dispose](): void;
  constructor(address: string, entry_point: any, op: ContractOperation, pre_transcript: PreTranscript, private_transcript_outputs: any[], input: any, output: any, communication_commitment_rand: string, key_location: string);
  toString(compact?: boolean | null): string;
}
export class PreProof {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): PreProof;
  constructor(data: string);
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  readonly instance: string;
}
export class PreTranscript {
  free(): void;
  [Symbol.dispose](): void;
  constructor(context: QueryContext, program: any, comm_comm: any);
  toString(compact?: boolean | null): string;
}
export class Proof {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): Proof;
  constructor(data: string);
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  readonly instance: string;
}
export class QueryContext {
  free(): void;
  [Symbol.dispose](): void;
  toVmStack(): VmStack;
  runTranscript(transcript: any, cost_model: CostModel): QueryContext;
  insertCommitment(comm: string, index: bigint): QueryContext;
  constructor(state: ChargedState, address: string);
  query(ops: any, cost_model: CostModel, gas_limit: any): QueryResults;
  qualify(coin: any): any;
  toString(compact?: boolean | null): string;
  readonly comIndices: any;
  effects: any;
  block: any;
  readonly state: ChargedState;
  readonly address: string;
}
export class QueryResults {
  free(): void;
  [Symbol.dispose](): void;
  constructor();
  toString(compact?: boolean | null): string;
  readonly events: any;
  readonly context: QueryContext;
  readonly gasCost: any;
}
export class ReplaceAuthority {
  free(): void;
  [Symbol.dispose](): void;
  constructor(authority: ContractMaintenanceAuthority);
  toString(compact?: boolean | null): string;
  readonly authority: ContractMaintenanceAuthority;
}
export class SignatureEnabled {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): SignatureEnabled;
  constructor(signature: string);
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  readonly instance: string;
}
export class SignatureErased {
  free(): void;
  [Symbol.dispose](): void;
  constructor();
  toString(_compact?: boolean | null): string;
  readonly instance: string;
}
export class StateBoundedMerkleTree {
  free(): void;
  [Symbol.dispose](): void;
  pathForLeaf(index: bigint, leaf: any): any;
  findPathForLeaf(leaf: any, index_start?: bigint | null, index_end?: bigint | null, already_hashed?: boolean | null): any;
  root(): any;
  constructor(height: number);
  rehash(): StateBoundedMerkleTree;
  update(index: bigint, leaf: any): StateBoundedMerkleTree;
  collapse(start: bigint, end: bigint): StateBoundedMerkleTree;
  toString(compact?: boolean | null): string;
  readonly height: number;
}
export class StateMap {
  free(): void;
  [Symbol.dispose](): void;
  get(key: any): StateValue | undefined;
  constructor();
  keys(): any[];
  insert(key: any, value: StateValue): StateMap;
  remove(key: any): StateMap;
  toString(compact?: boolean | null): string;
}
export class StateValue {
  free(): void;
  [Symbol.dispose](): void;
  arrayPush(value: StateValue): StateValue;
  asBoundedMerkleTree(): StateBoundedMerkleTree | undefined;
  static newBoundedMerkleTree(tree: StateBoundedMerkleTree): StateValue;
  constructor();
  type(): string;
  asMap(): StateMap | undefined;
  static decode(value: any): StateValue;
  encode(): any;
  asCell(): any;
  static newMap(map: StateMap): StateValue;
  asArray(): any[] | undefined;
  logSize(): number;
  static newCell(value: any): StateValue;
  static newNull(): StateValue;
  static newArray(): StateValue;
  toString(compact?: boolean | null): string;
}
export class SystemTransaction {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): SystemTransaction;
  /**
   * The transaction hash, hex-encoded.
   *
   * Mirrors `Transaction::transactionHash` above, and delegates to the same ledger method
   * (`ledger::structure::SystemTransaction::transaction_hash`) that non-WASM consumers already
   * use -- `midnight-indexer` calls it directly on the Rust type to key its archived system
   * transactions.
   *
   * Without this, a JavaScript consumer can deserialize a system transaction and read its
   * bytes but cannot obtain its identity, so it cannot store one under the same key everything
   * else uses. Unlike the regular `Transaction`, there are no proof-state variants here: a
   * `SystemTransaction` is always hashable, so this returns no error case of its own.
   */
  transactionHash(): string;
  constructor();
  /**
   * The synthetic cost of applying this system transaction under `params`.
   *
   * Mirrors `Transaction::cost` above, and delegates to the same ledger method
   * (`ledger::structure::SystemTransaction::cost`) the node calls while folding a block:
   * `apply_system_tx` adds this to the running block fullness exactly as the regular path
   * adds a transaction's cost.
   *
   * Unlike the regular `Transaction` sibling there is no `enforceTimeToDismiss` argument and
   * no error case -- the Rust method is infallible. A system transaction is authored by the
   * chain itself, so the time-to-dismiss check that can reject a user transaction does not
   * apply to it.
   *
   * Without this, a JavaScript consumer replaying a block can cost that block's regular
   * transactions but not its system transactions, so it cannot reconstruct block fullness --
   * and genesis, which is *only* system transactions, would always appear empty.
   */
  cost(params: LedgerParameters): any;
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
}
export class Transaction {
  free(): void;
  [Symbol.dispose](): void;
  addIntent(segment: any, raw_intent: any): Transaction;
  static fromParts(network_id: string, guaranteed: any, fallible: any, intent: any): Transaction;
  imbalances(segment: number, fees?: bigint | null): Map<any, any>;
  mockProve(): Transaction;
  static deserialize(signature_marker: string, proof_marker: string, binding_marker: string, raw: Uint8Array): Transaction;
  identifiers(): string[];
  wellFormed(ref_state: LedgerState, strictness: WellFormedStrictness, tblock: Date): VerifiedTransaction;
  eraseProofs(): Transaction;
  static fromRewards(rewards: ClaimRewardsTransaction): Transaction;
  addZswapOffer(segment: any, raw_offer: any): Transaction;
  eraseSignatures(): Transaction;
  feesWithMargin(params: LedgerParameters, n: number): bigint;
  transactionHash(): string;
  static fromPartsRandomized(network_id: string, guaranteed: any, fallible: any, intent: any): Transaction;
  constructor();
  bind(): Transaction;
  cost(params: LedgerParameters, enforce_time_to_dismiss?: boolean | null): any;
  fees(params: LedgerParameters, enforce_time_to_dismiss?: boolean | null): bigint;
  merge(other: Transaction): Transaction;
  prove(provider: any, cost_model: CostModel): Promise<Transaction>;
  addCalls(segment: any, calls: Array<any>, params: LedgerParameters, ttl: Date, zswap_inputs?: Array<any> | null, zswap_outputs?: Array<any> | null, zswap_transient?: Array<any> | null): Transaction;
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  get intents(): Map<any, any> | undefined;
  set intents(value: Map<any, any> | null | undefined);
  get fallibleOffer(): Map<any, any> | undefined;
  set fallibleOffer(value: Map<any, any> | null | undefined);
  get guaranteedOffer(): ZswapOffer | undefined;
  set guaranteedOffer(value: any);
  readonly bindingRandomness: bigint;
  readonly rewards: ClaimRewardsTransaction | undefined;
}
export class TransactionContext {
  free(): void;
  [Symbol.dispose](): void;
  constructor(ref_state: LedgerState, block_context: any, whitelist: any);
  toString(compact?: boolean | null): string;
}
export class TransactionCostModel {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): TransactionCostModel;
  static initialTransactionCostModel(): TransactionCostModel;
  constructor();
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  readonly baselineCost: any;
  readonly runtimeCostModel: CostModel;
}
export class TransactionResult {
  free(): void;
  [Symbol.dispose](): void;
  constructor();
  toString(compact?: boolean | null): string;
  readonly successfulSegments: Map<any, any> | undefined;
  readonly error: string | undefined;
  readonly type: string;
  readonly events: Event[];
}
export class UnshieldedOffer {
  free(): void;
  [Symbol.dispose](): void;
  addSignatures(signatures: string[]): UnshieldedOffer;
  eraseSignatures(): UnshieldedOffer;
  static new(inputs: any[], outputs: any[], signatures: string[]): UnshieldedOffer;
  constructor();
  toString(compact?: boolean | null): string;
  readonly signatures: string[];
  readonly inputs: any[];
  readonly outputs: any[];
}
export class UtxoMeta {
  free(): void;
  [Symbol.dispose](): void;
  constructor(ctime: Date);
  ctime: Date;
}
export class UtxoState {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  lookupMeta(utxo: any): UtxoMeta | undefined;
  static new(utxo_map: Map<any, any>): UtxoState;
  delta(prior: UtxoState, filter_by?: Function | null): Array<any>;
  filter(user_address: string): Set<any>;
  readonly utxos: Set<any>;
}
export class VerifiedTransaction {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly transaction: Transaction;
}
export class VerifierKeyInsert {
  free(): void;
  [Symbol.dispose](): void;
  constructor(operation: any, vk: ContractOperationVersionedVerifierKey);
  toString(compact?: boolean | null): string;
  readonly vk: ContractOperationVersionedVerifierKey;
  readonly operation: any;
}
export class VerifierKeyRemove {
  free(): void;
  [Symbol.dispose](): void;
  constructor(operation: any, version: ContractOperationVersion);
  toString(compact?: boolean | null): string;
  readonly version: ContractOperationVersion;
  readonly operation: any;
}
export class VmResults {
  free(): void;
  [Symbol.dispose](): void;
  constructor();
  toString(compact?: boolean | null): string;
  readonly stack: VmStack;
  readonly events: any;
  readonly gasCost: any;
}
export class VmStack {
  free(): void;
  [Symbol.dispose](): void;
  removeLast(): void;
  get(idx: number): StateValue | undefined;
  constructor();
  push(value: StateValue, is_strong: boolean): void;
  length(): number;
  isStrong(idx: number): boolean | undefined;
  toString(compact?: boolean | null): string;
}
export class WellFormedStrictness {
  free(): void;
  [Symbol.dispose](): void;
  constructor();
  enforceLimits: boolean;
  enforceBalancing: boolean;
  verifySignatures: boolean;
  verifyNativeProofs: boolean;
  verifyContractProofs: boolean;
}
export class ZswapChainState {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): ZswapChainState;
  postBlockUpdate(tblock: Date): ZswapChainState;
  static deserializeFromLedgerState(raw: Uint8Array): ZswapChainState;
  constructor();
  filter(contract_address: string): ZswapChainState;
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  tryApply(offer: ZswapOffer, whitelist: any): any;
  readonly firstFree: bigint;
}
export class ZswapInput {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(proof_marker: string, raw: Uint8Array): ZswapInput;
  static newContractOwned(coin: any, segment: number | null | undefined, contract: string, state: ZswapChainState): ZswapInput;
  constructor();
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  readonly contractAddress: string | undefined;
  readonly proof: any;
  readonly nullifier: string;
}
export class ZswapLocalState {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(raw: Uint8Array): ZswapLocalState;
  insertCoin(secret_keys: ZswapSecretKeys, coin: any): ZswapLocalState;
  applyFailed(offer: ZswapOffer): ZswapLocalState;
  clearPending(_time: Date): ZswapLocalState;
  replayEvents(secret_keys: ZswapSecretKeys, events: Event[]): ZswapLocalState;
  replayRawEvents(secret_keys: ZswapSecretKeys, raw_events: Uint8Array): ZswapLocalStateWithChanges;
  spendFromOutput(secret_keys: ZswapSecretKeys, coin: any, segment: number | null | undefined, output: ZswapOutput, _ttl?: Date | null): any;
  applyWithChanges(secret_keys: ZswapSecretKeys, offer: ZswapOffer): ZswapLocalStateWithChanges;
  revertTransaction(tx: Transaction): ZswapLocalState;
  applyCollapsedUpdate(update: MerkleTreeCollapsedUpdate): ZswapLocalState;
  removeCoinByNullifier(nullifier: string): ZswapLocalState;
  replayEventsWithChanges(secret_keys: ZswapSecretKeys, events: Event[]): ZswapLocalStateWithChanges;
  constructor();
  apply(secret_keys: ZswapSecretKeys, offer: ZswapOffer): ZswapLocalState;
  spend(secret_keys: ZswapSecretKeys, coin: any, segment?: number | null, _ttl?: Date | null): any;
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  watchFor(coin_public_key: string, coin: any): ZswapLocalState;
  readonly firstFree: bigint;
  readonly pendingSpends: Map<any, any>;
  readonly pendingOutputs: Map<any, any>;
  readonly merkleTreeRoot: any;
  readonly coins: Set<any>;
}
export class ZswapLocalStateWithChanges {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly state: ZswapLocalState;
  readonly changes: ZswapStateChanges[];
}
export class ZswapOffer {
  free(): void;
  [Symbol.dispose](): void;
  static fromInput(input: ZswapInput, _type?: string | null, _value?: bigint | null): ZswapOffer;
  static deserialize(proof_marker: string, raw: Uint8Array): ZswapOffer;
  static fromOutput(output: ZswapOutput, _type?: string | null, _value?: bigint | null): ZswapOffer;
  static fromTransient(transient: ZswapTransient): ZswapOffer;
  constructor();
  merge(other: ZswapOffer): ZswapOffer;
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  readonly transients: any[];
  readonly deltas: Map<any, any>;
  readonly inputs: any[];
  readonly outputs: any[];
}
export class ZswapOutput {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(proof_marker: string, raw: Uint8Array): ZswapOutput;
  static newContractOwned(coin: any, segment: number | null | undefined, contract: string): ZswapOutput;
  static new(coin: any, segment: number | null | undefined, target_cpk: string, target_epk: string): ZswapOutput;
  constructor();
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  readonly commitment: string;
  readonly contractAddress: string | undefined;
  readonly proof: any;
}
export class ZswapSecretKeys {
  free(): void;
  [Symbol.dispose](): void;
  static fromSeedRng(seed: Uint8Array): ZswapSecretKeys;
  constructor();
  clear(): void;
  static fromSeed(seed: Uint8Array): ZswapSecretKeys;
  readonly coinPublicKey: string;
  readonly coinSecretKey: CoinSecretKey;
  readonly encryptionPublicKey: string;
  readonly encryptionSecretKey: EncryptionSecretKey;
}
/**
 * WASM wrapper for ZswapStateChanges (used by Zswap)
 */
export class ZswapStateChanges {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly spentCoins: Array<any>;
  readonly receivedCoins: Array<any>;
  readonly source: string;
}
export class ZswapTransient {
  free(): void;
  [Symbol.dispose](): void;
  static deserialize(proof_marker: string, raw: Uint8Array): ZswapTransient;
  static newFromContractOwnedOutput(coin: any, segment: number | null | undefined, output: ZswapOutput): ZswapTransient;
  constructor();
  serialize(): Uint8Array;
  toString(compact?: boolean | null): string;
  readonly commitment: string;
  readonly inputProof: any;
  readonly outputProof: any;
  readonly contractAddress: string | undefined;
  readonly nullifier: string;
}
