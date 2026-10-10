/**
 * The indexer's modules as the overview's Modules section lists them: the modules of the UmbraDB indexer roadmap, each
 * with its name and a one-line description. Two have a working switch (`module` in `protocol.ts`): Token Indexer
 * (MIP-0018; off, the engine's MIP-0018 scan stops while the chain archive keeps syncing) and JSON RPC (the EVM JSON-RPC
 * module's read-only methods, called from its tab; off, its requests are refused), with a second line saying what the
 * build has of it now. The others are planned: listed, never switchable.
 */
import type { ModuleId } from "./protocol.ts";

export interface IndexerModule {
  /** The roadmap's id of the module. */
  id: string;
  name: string;
  description: string;
  /** The engine's id of an available module (its `module` request); `null` for a planned one. */
  engineModule: ModuleId | null;
  /** What this build has of the module now, when that is less than its description (one line). */
  now?: string;
}

/** Token Indexer first (the available one), then the planned modules in the roadmap's order. */
export const INDEXER_MODULES: readonly IndexerModule[] = [
  {
    id: "token-indexer",
    name: "Token Indexer MIP-0018",
    description: "MIP-0018 token metadata over the contract events: tokens, contracts, colors, activity and events, with its read-only API.",
    engineModule: "token-indexer",
  },
  {
    id: "api-wallets",
    name: "Public API Part 1 (wallets)",
    description: "The queries and streams the wallet SDK reads: blocks, transactions, zswap and DUST ledger events, unshielded transactions.",
    engineModule: null,
  },
  {
    id: "api-dapps",
    name: "Public API Part 2 (dApps)",
    description: "Contract actions, state and events for midnight-js, contract zswap state and TEE registration lookups.",
    engineModule: null,
  },
  {
    id: "api-spo",
    name: "Public API Part 3 (SPO)",
    description: "Committee, D-parameter, candidates and registrations from the node, with optional Cardano pool metadata.",
    engineModule: null,
  },
  {
    id: "fast-dust",
    name: "Fast Dust Sync",
    description: "Spend-ready DUST for a fresh wallet from pinned public trees and a private nullifier walk.",
    engineModule: null,
  },
  {
    id: "fast-shielded",
    name: "Fast Shielded Sync",
    description: "A faster shielded sync than replaying every zswap event: a compact output stream and server-assisted sync.",
    engineModule: null,
  },
  {
    id: "shielded-state",
    name: "Shielded Token State & Discovery MIP-0006",
    description: "MIP-0011 shielded token state, prefix-limited nullifier lookups and MIP-0006 offer discovery.",
    engineModule: null,
  },
  {
    id: "unshielded-state",
    name: "Unshielded Token State MIP-0006",
    description: "MIP-0014 token state over the public UTXO tables: balances, minted totals, holders and burns.",
    engineModule: null,
  },
  {
    id: "jsonrpc",
    name: "JSON RPC",
    description: "A JSON-RPC for external wallets such as Passport: token balances from a viewing key, in a TEE.",
    engineModule: "jsonrpc",
    now: "Now: the read-only eth_* methods of npm run evm-rpc, called from the JSON RPC tab; no external wallet can connect.",
  },
  {
    id: "explorer",
    name: "Explorer POC",
    description: "A proof-of-concept explorer over the public API: blocks, transactions, tokens and contracts.",
    engineModule: null,
  },
];
