import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type ContractAddress = { bytes: Uint8Array };

export type Either<A, B> = { is_left: boolean; left: A; right: B };

export type Maybe<T> = { is_some: boolean; value: T };

export type Witnesses<PS> = {
  emitterSecret(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  wit_FungibleTokenSK(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  symbol(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  decimals(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  totalSupply(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  balanceOf(context: __compactRuntime.CircuitContext<PS>,
            account_0: Either<Uint8Array, ContractAddress>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  transfer(context: __compactRuntime.CircuitContext<PS>,
           to_0: Either<Uint8Array, ContractAddress>,
           value_0: bigint): Promise<__compactRuntime.CircuitResults<PS, boolean>>;
  mint(context: __compactRuntime.CircuitContext<PS>,
       account_0: Either<Uint8Array, ContractAddress>,
       value_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  publishRepository(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  publishBundle(context: __compactRuntime.CircuitContext<PS>,
                payload_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type ProvableCircuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  symbol(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  decimals(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  totalSupply(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  balanceOf(context: __compactRuntime.CircuitContext<PS>,
            account_0: Either<Uint8Array, ContractAddress>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  transfer(context: __compactRuntime.CircuitContext<PS>,
           to_0: Either<Uint8Array, ContractAddress>,
           value_0: bigint): Promise<__compactRuntime.CircuitResults<PS, boolean>>;
  mint(context: __compactRuntime.CircuitContext<PS>,
       account_0: Either<Uint8Array, ContractAddress>,
       value_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  publishRepository(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  publishBundle(context: __compactRuntime.CircuitContext<PS>,
                payload_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  name(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  symbol(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, string>>;
  decimals(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  totalSupply(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  balanceOf(context: __compactRuntime.CircuitContext<PS>,
            account_0: Either<Uint8Array, ContractAddress>): Promise<__compactRuntime.CircuitResults<PS, bigint>>;
  transfer(context: __compactRuntime.CircuitContext<PS>,
           to_0: Either<Uint8Array, ContractAddress>,
           value_0: bigint): Promise<__compactRuntime.CircuitResults<PS, boolean>>;
  mint(context: __compactRuntime.CircuitContext<PS>,
       account_0: Either<Uint8Array, ContractAddress>,
       value_0: bigint): Promise<__compactRuntime.CircuitResults<PS, []>>;
  publishRepository(context: __compactRuntime.CircuitContext<PS>): Promise<__compactRuntime.CircuitResults<PS, []>>;
  publishBundle(context: __compactRuntime.CircuitContext<PS>,
                payload_0: Uint8Array): Promise<__compactRuntime.CircuitResults<PS, []>>;
}

export type Ledger = {
  readonly TM_emitterSecretHash: Uint8Array;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>,
               emitterSecretHash_0: Uint8Array,
               name__0: string,
               symbol__0: string): Promise<__compactRuntime.ConstructorResult<PS>>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
export declare const expectedVk: Record<string, string>;
