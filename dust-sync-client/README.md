# `dust-sync-client` — a wallet builds its DUST state in seconds

A Midnight wallet's DUST sync costs **123 minutes** on preprod: the SDK replays all 1.49 M DUST
ledger events of the chain through its indexer subscription, at ≈ 4.8 ms per event, to find the few
that are its own. Every wallet pays that, every time, for the same work.

This client does it differently. The shielded-monitor node has already replayed those events **once**
and keeps the chain's two DUST Merkle trees in RAM (`shielded-monitor/node/dust/`). A wallet asks it
for three things — its own rows, the spend rows for nullifiers it computes itself, and collapsed
Merkle updates for the parts of the trees it does not own — and rebuilds exactly the same
`DustLocalState` locally, in a handful of round trips.

The DUST **secret key never leaves the wallet**. It is used for two ledger calls, `dustNullifier`
and `successorUtxo`, both in this process. What the node sees is a list of nullifiers (the leak the
owner accepted for this project, spec §1 "Accepted leak") and a DUST public key.

Spec: `spec/00016-dust-wallet-sync.md` (Story 4, FR-030…FR-032, §5.5 is this library's algorithm,
§5.6 the hand-off). Plan: `plans/00016-dust-wallet-sync.md` §5.

## Use it

```ts
import { syncDust } from "./dust-sync-client/src/index.js";

const { state, timing, stats, roots, provedAt } = await syncDust({
  ledger,                 // the loaded @midnight-ntwrk/ledger-v8 module (see "The ledger" below)
  secretKey,              // a DustSecretKey — never serialized, never logged
  baseUrl: "http://127.0.0.1:8080",   // the balancer
  net: "preprod",
});
state.walletBalance(new Date());      // the wallet's DUST balance
state.free();                         // the caller owns the handle
```

`syncDust` either returns a state whose **two Merkle roots equal the node's** at one mirror tip, or
it throws. There is no third outcome: a DUST state whose commitment root does not match the chain's
has wrong Merkle paths, and a wallet that spent from it would build a transaction the node rejects,
after paying for the proof.

Errors (`DustSyncError.code`): `DUST_SYNC_ROOT_MISMATCH`, `DUST_SYNC_INDEX_LAG`,
`DUST_SYNC_NONLINEAR`, `DUST_SYNC_RESTART_LIMIT`, `DUST_SYNC_HTTP`, `DUST_SYNC_INVALID_INPUT`.

## The CLI

```bash
npm run dust:sync -- --seed-file <path> --url <balancer> --net preprod \
  [--rtt-ms 40] [--balance-at <unix seconds>] [--repeat 3] [--out report.json] \
  [--sdk-wrapper wrapper.json --applied-index <indexer event id>]
```

It prints one JSON object: `timing` (the phase split of §5.5 step 10), `stats` (requests, bytes,
rounds, segments), `roots`, `provedAt`, the live UTxOs and `walletBalance` at `--balance-at`.

The seed file must be **mode 600** or the run refuses to start; the seed and the derived key are
never printed. The DUST key is derived at `m/44'/2400'/0'/2/0` — the wallet SDK's own path, proved
against the SDK's own public keys in `test/keys.test.ts`.

`--balance-at` matters more than it looks: DUST generates continuously, so two correct states
priced a minute apart have different balances. Pass the same instant to both sides of a comparison.

## What it does, in order (spec §5.5)

| step | what | why in this order |
|---|---|---|
| 1 | `GET /v1/dust/tip` | the chain's DUST parameters, so the local state is built with them |
| 2 | `initial-utxos`, `generation` by DUST public key | the wallet's own rows |
| 3 | build the **generation** tree | `successorUtxo` looks `backingNight` up in `night_indices`, which only `insertGenerationInfo(…, initialNonce)` fills — step 5 cannot run before this |
| 4–5 | follow the spend chains | a successor's nonce is `hash(backingNight, seq+1, sk)` and its value depends on the fee, so it is computable only after its predecessor's spend row is known. One round per *generation* of the chain, not per spend — the whole frontier goes in one request |
| 6 | build the **commitment** tree | once the node's trees have caught up with every row its table already returned |
| 7–8 | converge | bring both trees to ONE mirror tip and compare both roots there; a state whose trees sit at different chain positions is not a snapshot of anything |
| 9 | confirm | one more lookup of the live nullifiers; lookups read the table, which is never behind the trees |

Cost, measured on the devnet: a wallet with one initial UTxO and no spends syncs in **≈ 0.14 s** over
11 requests; the WASM cost is ≈ 19 ms per applied segment and per own leaf (one Merkle rehash each).

## The ledger, and why it is a parameter

`syncDust` takes the loaded `@midnight-ntwrk/ledger-v8` module rather than importing it. Two
reasons, and the second is a correctness rule:

1. this repository loads the WASM through a computed `import(…)` (`chain-archive-sync/tx-replay-decoder.ts`),
   so `tsc` types it and the repo builds without the artifact present; and a browser wallet can pass
   its own copy;
2. **the client may use only the STANDARD published 8.1.0 surface.** In this repository
   `@midnight-ntwrk/ledger-v8` resolves to the vendored FORK build, which carries three exports no
   published package has (`replayRawEventsRetainingAll`, `collapsedCommitmentUpdate`,
   `collapsedGenerationUpdate`) — they exist for the NODE's mirror. A client that used one would
   work in every test here and fail in every real wallet. `src/ledger.ts` lists every member this
   client touches and `test/published-surface.test.ts` checks each against the published 8.1.0
   declaration file, copied out of the wallet SDK image and committed at
   `test/published-ledger-v8-8.1.0.d.ts`.

## Hand-off to the SDK (§5.6)

`--sdk-wrapper` writes the JSON `DustWallet.restore` consumes:
`{ publicKey: { publicKey }, state: <hex>, protocolVersion, networkId, offset }`.

`offset` is the **indexer's** `dustLedgerEvents.id` of the last applied event. `Sync.js` resubscribes
from `appliedIndex − 1` and drops updates at or below it, so an offset that is too low replays
history (slow but correct) and one that is too high **skips events** (silent corruption). Our event
ids are the archive's own sequence; equality with the indexer's numbering is measured, never
assumed — `devnet/sdk/golden-at-event-id.ts` reports the indexer's id for our tip event, and the
default `--applied-index` is `0`, which replays.

## The devnet golden run

`devnet/` brings up a whole stack and proves the client against the SDK on a real chain:

```bash
node dust-sync-client/devnet/devnet.mjs up      # compose devnet + ingest + dust_reader + node + balancer
bash dust-sync-client/devnet/sdk-run.sh create-and-fund.ts --seed-file <seed> --seed-env NEW_SEED
bash dust-sync-client/devnet/sdk-run.sh self-transfers.ts --seed-file <seed> COUNT=100
bash dust-sync-client/devnet/sdk-run.sh sdk-dust-state.ts --seed-file <seed> BALANCE_AT=<unix>
npm run dust:sync -- --seed-file <seed> --url <balancer> --net undeployed --balance-at <unix> --out client.json
node dust-sync-client/devnet/compare.mjs client.json <out>/sdk-dust-state.json
node dust-sync-client/devnet/devnet.mjs down
```

Every port is random and loopback-only, the compose project is `umbra-00016-devnet-<random>`, and
everything it writes goes under `/media/eddie/mn-nvme/00016/devnet/`. `down` touches only what `up`
recorded. The SDK-side scripts under `devnet/sdk/` run inside `midnight-1-offers/shielded-night-deploy:local`
— UmbraDB never depends on the wallet SDK.
