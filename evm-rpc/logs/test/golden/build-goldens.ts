/**
 * Regenerates the `*.golden.json` files in this directory:
 *
 *   npx tsx evm-rpc/logs/test/golden/build-goldens.ts
 *
 * The INPUT half of each fixture (the `events` array and `profile`) is hand-authored here and is
 * the actual specification input. The `expected` half is produced by running `mapEvents` over it.
 *
 * A golden generated from the implementation cannot, on its own, prove the implementation right —
 * it only locks behaviour against regression. The correctness half of the argument lives in
 * `../event-map.test.ts`, which re-derives the interesting fields from INDEPENDENT oracles
 * (`ethers.keccak256` for the address mapping and topic0s, `ethers.Interface.parseLog` for the
 * ERC20 Transfer decode) rather than from this module. Regenerate, then READ THE DIFF: an expected
 * value that changes without a deliberate `LOGMAP.md` change is a bug being blessed.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mapEvents, toHex, type AbiProfile, type MapWarning, type MidnightEvent } from "../../event-map.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- fixture vocabulary: distinct, obviously-synthetic 32-byte values -------------------------
const CONTRACT = "11".repeat(32);
const ALICE = "a1".repeat(32);
const BOB = "b0".repeat(32);
const CAROL = "c2".repeat(32);
const VAULT_CONTRACT = "07".repeat(32);
const DOMAIN_SEP = "d5".repeat(32);
const TOKEN_TYPE = "77".repeat(32);
const TOKEN_ID_42 = `${"00".repeat(31)}2a`;
const BLOCK_HASH = "bb".repeat(32);
const OTHER_TX = "0e".repeat(32);
const TX_HASH = "e1".repeat(32);

/** The block carries an earlier unrelated transaction, so a correct `tx_index` is 1, not 0. */
const BLOCK = {
  height: 12,
  hash: BLOCK_HASH,
  transactions: [{ hash: OTHER_TX }, { hash: TX_HASH }],
};

const TX = { hash: TX_HASH, block: BLOCK };

function unshielded(
  typename: "UnshieldedSpendEvent" | "UnshieldedReceiveEvent",
  id: number,
  party: string,
  amount: string,
  overrides: Partial<MidnightEvent> = {},
): MidnightEvent {
  const either = { kind: "USER" as const, userAddress: party, contractAddress: null };
  return {
    __typename: typename,
    id,
    maxId: id,
    contractAddress: CONTRACT,
    transactionId: 7,
    transaction: TX,
    ...(typename === "UnshieldedSpendEvent" ? { sender: either } : { recipient: either }),
    domainSep: DOMAIN_SEP,
    tokenType: TOKEN_TYPE,
    amount,
    ...overrides,
  };
}

interface Fixture {
  name: string;
  description: string;
  profile: AbiProfile;
  events: MidnightEvent[];
  /** Warning codes the mapping is expected to raise, in order. */
  expectedWarnings?: string[];
}

const FIXTURES: Fixture[] = [
  {
    name: "erc20-pair",
    description:
      "A Spend + Receive pair in one transaction with identical domainSep/tokenType/amount maps to " +
      "exactly ONE ERC20 Transfer log: topic1=from (spend sender), topic2=to (receive recipient), " +
      "data=amount as a uint256 word. tx_index is 1 because the block's first transaction is another one.",
    profile: "erc20",
    events: [
      unshielded("UnshieldedSpendEvent", 100, ALICE, "1000"),
      unshielded("UnshieldedReceiveEvent", 101, BOB, "1000"),
    ],
  },
  {
    name: "erc721-pair",
    description:
      "The same pair under the erc721 profile: tokenType becomes topic3 (the tokenId) and data is " +
      "empty. topic0 is the SAME hash as erc20 — ERC721's Transfer shares ERC20's signature.",
    profile: "erc721",
    events: [
      unshielded("UnshieldedSpendEvent", 200, ALICE, "1", { tokenType: TOKEN_ID_42 }),
      unshielded("UnshieldedReceiveEvent", 201, BOB, "1", { tokenType: TOKEN_ID_42 }),
    ],
  },
  {
    name: "mint-unpaired-receive",
    description:
      "An UNPAIRED UnshieldedReceiveEvent is a mint: Transfer(from = address(0), to = recipient). " +
      "The recipient here is a CONTRACT branch, exercising the other side of AddressOrContract.",
    profile: "erc20",
    events: [
      unshielded("UnshieldedReceiveEvent", 300, BOB, "5000", {
        recipient: { kind: "CONTRACT", userAddress: null, contractAddress: VAULT_CONTRACT },
      }),
    ],
  },
  {
    name: "burn-unpaired-spend",
    description:
      "An UNPAIRED UnshieldedSpendEvent is a burn: Transfer(from = sender, to = address(0)).",
    profile: "erc20",
    events: [unshielded("UnshieldedSpendEvent", 400, ALICE, "250")],
  },
  {
    name: "misc-contract-event",
    description:
      "MiscContractEvent: topic0 = keccak256(name_bytes32) — the hash of the NAME BYTES, not of a " +
      "signature string — data = payload verbatim, and no topic1-3.",
    profile: "erc20",
    events: [
      {
        __typename: "MiscContractEvent",
        id: 500,
        maxId: 500,
        contractAddress: CONTRACT,
        transactionId: 7,
        transaction: TX,
        name: `${"00".repeat(24)}4170707200766564`, // ascii "Appr\0ved"-ish filler, 32 bytes
        payload: "deadbeef",
      },
    ],
  },
  {
    name: "pairing-ambiguity",
    description:
      "ONE spend and TWO receives with identical (domainSep, tokenType, amount): the spend pairs " +
      "FIFO with the LOWER-id receive (id 601) and a `pair-ambiguous` warning is raised; the " +
      "leftover receive (602) becomes a mint. Deterministic, never a coin flip.",
    profile: "erc20",
    events: [
      unshielded("UnshieldedSpendEvent", 600, ALICE, "70"),
      unshielded("UnshieldedReceiveEvent", 601, BOB, "70"),
      unshielded("UnshieldedReceiveEvent", 602, CAROL, "70"),
    ],
  },
  {
    name: "multi-event-tx-log-index",
    description:
      "One transaction emitting a Transfer pair (700/701), a Misc event (702) and a second Transfer " +
      "pair (703/704). log_index is 0,1,2 assigned by the source event id each log is KEYED on " +
      "(700, 702, 703) — the pair takes the lower id of its two events.",
    profile: "erc20",
    events: [
      unshielded("UnshieldedSpendEvent", 700, ALICE, "11"),
      unshielded("UnshieldedReceiveEvent", 701, BOB, "11"),
      {
        __typename: "MiscContractEvent",
        id: 702,
        maxId: 704,
        contractAddress: CONTRACT,
        transactionId: 7,
        transaction: TX,
        name: "ab".repeat(32),
        payload: "c0ffee",
      },
      unshielded("UnshieldedSpendEvent", 703, BOB, "12"),
      unshielded("UnshieldedReceiveEvent", 704, CAROL, "12"),
    ],
  },
  {
    name: "misc-profile-unshielded",
    description:
      "Under the `misc` profile nothing is paired — the contract makes no ERC20/721 claim, so its " +
      "Spend/Receive keep the lossless Midnight<TypeName>() form with raw bytes32 identities. Two " +
      "logs out, not one.",
    profile: "misc",
    events: [
      unshielded("UnshieldedSpendEvent", 800, ALICE, "9"),
      unshielded("UnshieldedReceiveEvent", 801, BOB, "9"),
    ],
  },
  {
    name: "standard-completeness-events",
    description:
      "The completeness types that exist so nothing is silently dropped: Shielded spend/receive/" +
      "mint/burn, Unshielded mint/burn, Paused/Unpaused. Each takes a keccak256(\"Midnight<Type>()\") " +
      "topic0 with the per-type layout LOGMAP.md tabulates.",
    profile: "erc20",
    events: [
      { __typename: "ShieldedSpendEvent", id: 900, contractAddress: CONTRACT, transactionId: 9, transaction: TX, nullifier: "31".repeat(32) },
      { __typename: "ShieldedReceiveEvent", id: 901, contractAddress: CONTRACT, transactionId: 9, transaction: TX, commitment: "32".repeat(32), ciphertext: "aabbcc", receivingContractAddress: VAULT_CONTRACT },
      { __typename: "ShieldedMintEvent", id: 902, contractAddress: CONTRACT, transactionId: 9, transaction: TX, commitment: "33".repeat(32), domainSep: DOMAIN_SEP, amount: "42" },
      { __typename: "ShieldedBurnEvent", id: 903, contractAddress: CONTRACT, transactionId: 9, transaction: TX, nullifier: "34".repeat(32), amount: null },
      { __typename: "UnshieldedMintEvent", id: 904, contractAddress: CONTRACT, transactionId: 9, transaction: TX, domainSep: DOMAIN_SEP, tokenType: TOKEN_TYPE, amount: "77" },
      { __typename: "UnshieldedBurnEvent", id: 905, contractAddress: CONTRACT, transactionId: 9, transaction: TX, sender: { kind: "CONTRACT", userAddress: null, contractAddress: VAULT_CONTRACT }, tokenType: TOKEN_TYPE, amount: "8" },
      { __typename: "PausedEvent", id: 906, contractAddress: CONTRACT, transactionId: 9, transaction: TX },
      { __typename: "UnpausedEvent", id: 907, contractAddress: CONTRACT, transactionId: 9, transaction: TX },
    ],
  },
  {
    name: "tx-index-unavailable",
    description:
      "When the caller did not select block.transactions, tx_index falls back to 0 and a " +
      "`tx-index-unavailable` warning is raised rather than a wrong index being invented silently.",
    profile: "erc20",
    events: [
      unshielded("UnshieldedSpendEvent", 1000, ALICE, "3", {
        transaction: { hash: TX_HASH, block: { height: 12, hash: BLOCK_HASH } },
      }),
    ],
  },
];

for (const fixture of FIXTURES) {
  const warnings: MapWarning[] = [];
  const rows = mapEvents(fixture.events, fixture.profile, undefined, {
    onWarning: (w) => warnings.push(w),
  });
  const golden = {
    description: fixture.description,
    profile: fixture.profile,
    events: fixture.events,
    expected: rows.map((row) => ({
      address: toHex(row.address),
      blockNumber: row.blockNumber,
      blockHash: toHex(row.blockHash),
      txHash: toHex(row.txHash),
      txIndex: row.txIndex,
      logIndex: row.logIndex,
      topics: row.topics.map(toHex),
      data: toHex(row.data),
      sourceEventId: row.sourceEventId,
      removed: row.removed,
    })),
    expectedWarnings: warnings.map((w) => w.code),
  };
  const path = join(HERE, `${fixture.name}.golden.json`);
  writeFileSync(path, `${JSON.stringify(golden, null, 2)}\n`, "utf8");
  console.log(`wrote ${fixture.name}.golden.json — ${golden.expected.length} row(s), ${warnings.length} warning(s)`);
}
