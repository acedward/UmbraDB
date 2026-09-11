# Demo runbook — watch the shielded monitor work

> Change: `openspec/changes/00009-06-dashboard/`. API reference:
> [`shielded-monitor-api.md`](shielded-monitor-api.md). Scanner:
> [`shielded-monitor-scanner.md`](shielded-monitor-scanner.md). Backup and restore:
> [`shielded-monitor-restore.md`](shielded-monitor-restore.md).

This brings the whole alpha up on a private Midnight devnet, registers a viewing key, and ends
with a dashboard in your browser showing coverage advancing and — if you run the optional wallet
half — a real shielded transaction appearing as a match.

Every command below is exactly what was run for the acceptance evidence, with the project name and
the ports parameterised so several of these can run side by side on one machine.

---

## Read this first

- **The API has no authentication.** Anyone who can reach the port can register a key, read every
  monitor's matches and delete any monitor. The dashboard changes nothing about that; it only
  makes it visible. Bind loopback (the default), and do not expose the port. See
  [`shielded-monitor-api.md`](shielded-monitor-api.md#read-this-before-you-deploy-it).
- **Never point any of this at `127.0.0.1:9944`.** On a shared machine that is very likely a
  *different* devnet that also calls itself `undeployed1`. This runbook gives its own stack a
  unique project name and its own randomised, loopback-only ports for exactly that reason, and
  every command below names its port explicitly rather than relying on a default.
- **Seeds and viewing keys are secrets.** Keep them in a directory outside the repository, `chmod
  600`, and never commit one. The repository's own `.gitignore` does not know about your scratch
  directory.

### What needs what

| Step | Needs |
|---|---|
| 1–6 (stack, ingest, scan, API, dashboard, lifecycle) | Docker, Node ≥ 24. **No wallet, no proof server work, no funds.** |
| 7 (a real shielded transfer that produces a match) | Additionally: the Midnight wallet SDK **out of tree**, the proof server (~30–60 s per proof), and patience |

Steps 1–6 are the wallet-free half. They are what `npm run demo:shielded-monitor` automates, and
they are enough to see the system ingest, scan, report coverage and drive the lifecycle. Step 7 is
what turns "coverage is advancing" into "a real shielded payment to my key showed up".

---

## 0. Pick a project name and a port block

```bash
cd /path/to/UmbraDB
npm ci

export DEMO_SHA="$(git rev-parse --short HEAD)"
export DEMO_PROJECT="umbradb-00009-06-${DEMO_SHA}"

# Loopback-only, above 10000, and randomised so two demos never collide.
export NODE_HOST_PORT=$((10000 + RANDOM % 50000))
export INDEXER_HOST_PORT=$((10000 + RANDOM % 50000))
export PROOF_HOST_PORT=$((10000 + RANDOM % 50000))
export POSTGRES_HOST_PORT=$((10000 + RANDOM % 50000))
export API_PORT=$((10000 + RANDOM % 50000))

export DEMO_DIR="$(mktemp -d)"          # seeds, keys, logs — outside the repository
chmod 700 "$DEMO_DIR"

echo "project=$DEMO_PROJECT node=$NODE_HOST_PORT indexer=$INDEXER_HOST_PORT" \
     "proof=$PROOF_HOST_PORT postgres=$POSTGRES_HOST_PORT api=$API_PORT dir=$DEMO_DIR"
```

Write those numbers down. Every later command uses them.

## 1. Bring the devnet up

```bash
docker compose -p "$DEMO_PROJECT" \
  -f test/compose/docker-compose.yml \
  -f test/compose/docker-compose.hostports.yml \
  up -d node postgres
```

The base compose file publishes **nothing**; the `hostports` overlay publishes each service on
`127.0.0.1:<your port>` only. Images are pinned by digest.

The `indexer` and `proof-server` services are **not** started here. UmbraDB's ingest is node-only,
which is the repository's headline claim, and starting an indexer for a demo of node-only ingest
would quietly contradict it. Start them only for step 7, where the wallet needs them.

Wait for the node, and confirm it is **yours**:

```bash
until curl -fs -H 'Content-Type: application/json' \
  -d '{"id":1,"jsonrpc":"2.0","method":"system_chain","params":[]}' \
  "http://127.0.0.1:${NODE_HOST_PORT}" >/dev/null; do sleep 2; done

curl -s -H 'Content-Type: application/json' \
  -d '{"id":1,"jsonrpc":"2.0","method":"system_chain","params":[]}' \
  "http://127.0.0.1:${NODE_HOST_PORT}"
# {"jsonrpc":"2.0","id":1,"result":"undeployed1"}
```

`undeployed1` is also what a foreign devnet reports. The thing that makes this yours is the port,
which is why it is spelled out in every command.

## 2. Ingest, node-only

```bash
export ARCHIVE_PG="postgres://umbra:umbra@127.0.0.1:${POSTGRES_HOST_PORT}/umbra"

NET=undeployed \
NODE_URL="http://127.0.0.1:${NODE_HOST_PORT}" \
NODE_ONLY=1 \
ARCHIVE_PG="$ARCHIVE_PG" \
npx tsx chain-archive-sync/sync-cli.ts > "$DEMO_DIR/archive-sync.log" 2>&1 &
echo $! > "$DEMO_DIR/archive-sync.pid"
```

This bootstraps the `chain_archive` schema and ingests finalized blocks from genesis, continuously.
Watch it with `tail -f "$DEMO_DIR/archive-sync.log"`.

## 3. Derive a viewing key

```bash
# A demo seed. Generate a real one for anything you intend to fund.
openssl rand -hex 32 > "$DEMO_DIR/seed.hex"
chmod 600 "$DEMO_DIR/seed.hex"

npx tsx shielded-monitor/derive-key-cli.ts --seed-file "$DEMO_DIR/seed.hex" --hd
```

```json
{
  "viewingKey": "mn_shield-esk_undeployed1...",
  "coinPublicKey": "1bd4f827...",
  "encryptionPublicKey": "b62e630a...",
  "net": "undeployed",
  "path": "m/44'/2400'/0'/3/0"
}
```

- `--hd` derives the **wallet's** Zswap role key (BIP-0032 over secp256k1, the path
  `@midnightntwrk/wallet-sdk-hd` uses). Use it when the seed is a wallet seed — which is the case
  for step 7. Drop it to treat the file as a raw Zswap seed.
- `coinPublicKey` and `encryptionPublicKey` are the two halves of the shielded address. They are
  public: this is what you give someone so they can pay you.
- `viewingKey` is **secret** — it grants read access to that wallet's shielded history. The seed
  is never read from `argv` and never printed.

For a key file the CLI and the dashboard can both use:

```bash
npx tsx shielded-monitor/derive-key-cli.ts --seed-file "$DEMO_DIR/seed.hex" --hd --quiet \
  > "$DEMO_DIR/viewing-key.txt"
chmod 600 "$DEMO_DIR/viewing-key.txt"
```

Once installed, the same command is `umbradb-shielded-monitor-derive-key`.

## 4. Start the scanner and the API

```bash
MONITOR_PG="$ARCHIVE_PG" \
NET=undeployed \
SCAN_BATCH_BLOCKS=8 \
SCAN_POLL_MS=2000 \
npx tsx shielded-monitor/scanner-cli.ts > "$DEMO_DIR/scanner.log" 2>&1 &
echo $! > "$DEMO_DIR/scanner.pid"

SHIELDED_MONITOR_PG="$ARCHIVE_PG" \
SHIELDED_MONITOR_NET=undeployed \
SHIELDED_MONITOR_BOOTSTRAP=1 \
API_HOST=127.0.0.1 \
API_PORT="$API_PORT" \
npx tsx shielded-monitor/api/server-cli.ts > "$DEMO_DIR/api.log" 2>&1 &
echo $! > "$DEMO_DIR/api.pid"

curl -s "http://127.0.0.1:${API_PORT}/v1/health"
# {"status":"ok","net":"undeployed"}
```

Three processes, one database, three roles: the archive writes `chain_archive`, the scanner writes
`shielded_monitor` and reads the archive through the read contract only, and the API serves.

## 5. Open the dashboard

```
http://127.0.0.1:$API_PORT/ui
```

(`http://127.0.0.1:$API_PORT/` redirects there.)

The page shows, refreshing every 3 seconds:

- **service** — reachability, the network, the archive's tip, the monitor count.
- **monitors** — one row per monitor with its state badge, a coverage bar of
  `scannedThrough / sourceTip`, the four coverage heights spelled out, the last error class, and
  pause / resume / revoke / delete buttons.
- **register a viewing key** — paste the `mn_shield-esk_undeployed1…` string from step 3 and press
  **register**. The field is a password field, is cleared the moment the request is issued, and the
  key travels only in the request body. It is never put in a URL and never written to a log.
- **matches** — the selected monitor's matches, newest first. Each row is **expandable**: the
  collapsed line shows the block time, `height / pos`, the transaction hash (click to copy), the
  matched segments and a one-line summary such as
  `1 of 2 yours · 3 commitments · 1 nullifier · 1 transient`. Click the row (or its caret) to open
  it. **Load more** pages further back.

### What the expanded row shows

- the block time in UTC plus a relative age, the `appliedOutcome` (always `unknown`), the
  archive's `sourceOutcome` when it recorded one, and the protocol version;
- one section **per zswap segment** — segment 0 is the guaranteed section, every other id is a
  fallible segment — headed with whether that segment matched and, when it did but no single entry
  could be pinned, *one of these N is yours*;
- within a segment, up to three tables, each hash click-to-copy: **outputs** (index, commitment,
  contract address if any, `mine`), **inputs** (index, spent nullifier, contract address) and
  **transients** (index, commitment, nullifier, contract address, `mine`);
- a legend: *commitment = a new shielded coin · nullifier = a coin this transaction spent · a
  transient is created and spent in the same transaction · only outputs encrypted to your key are
  yours*, followed by the ledger build and the details-rule version that produced the row.

`mine` is three-valued on purpose. **yours** means the ledger entails it; a dash means it is
provably not yours (its segment did not match at all, or it is delivered to a contract and carries
no ciphertext for anyone); **?** means the ledger cannot attribute that entry from a viewing key
alone, and the segment line says how many candidates it is one of. See
[`shielded-monitor-api.md`](shielded-monitor-api.md#mine-is-three-valued-and-every-value-is-entailed-by-the-ledger).

A match recorded before this data was stored shows **"Details not recorded yet — run the
backfill"** instead. Fill them in with:

```bash
MONITOR_PG="$MONITOR_PG" NET=undeployed \
  npx tsx shielded-monitor/scanner-cli.ts --backfill-details
```

It is idempotent — running it twice fills nothing the second time — and it only ever writes the
two detail columns. Stop the tailing scanner first or run it alongside; either is safe, because
every write is epoch-fenced and predicated on `details IS NULL`.

Register from the command line instead if you prefer:

```bash
# The COMMAND comes first; every flag, `--api` included, follows it.
npx tsx shielded-monitor/client/cli.ts register \
  --api "http://127.0.0.1:${API_PORT}" \
  --key-file "$DEMO_DIR/viewing-key.txt" --start 0
```

Either way, watch coverage advance:

```bash
watch -n2 "curl -s http://127.0.0.1:${API_PORT}/v1/monitors | head -c 2000"
```

```json
{
  "items": [
    {
      "monitorId": "…",
      "net": "undeployed",
      "state": "live",
      "coverage": { "requestedStart": "0", "scannedFrom": "0", "scannedThrough": "94", "sourceTip": "94" },
      "matchingRuleVersion": "shielded-monitor/v1",
      "ledgerBuild": "ledger-v8@8.1.0-syshash.4",
      "createdAt": "…",
      "updatedAt": "…"
    }
  ],
  "sourceTip": "94",
  "net": "undeployed"
}
```

**Read the coverage object, not the match count.** `scannedThrough: null` renders as *not scanned*
and `sourceTip: null` as *unknown*; neither is ever drawn as `0`. An empty match list next to
`scannedThrough 94 / sourceTip 94` means "looked at everything, nothing was yours". An empty match
list next to `scannedThrough: not scanned` means nothing has been looked at yet. The page never
lets you confuse the two, and neither should you.

## 6. Drive the lifecycle

Use the row's buttons, or the CLI:

```bash
ID=$(curl -s "http://127.0.0.1:${API_PORT}/v1/monitors" | sed -n 's/.*"monitorId":"\([^"]*\)".*/\1/p' | head -1)

curl -s -XPOST "http://127.0.0.1:${API_PORT}/v1/monitors/$ID/pause"   # coverage freezes, tip keeps moving
curl -s -XPOST "http://127.0.0.1:${API_PORT}/v1/monitors/$ID/resume"  # resumes with no gap and no duplicate
curl -s -XPOST "http://127.0.0.1:${API_PORT}/v1/monitors/$ID/revoke"  # 410 on its own reads from now on
curl -s -XDELETE "http://127.0.0.1:${API_PORT}/v1/monitors/$ID"       # 204; afterwards every route answers 404
```

Pausing is the most instructive one: `scannedThrough` stops while `sourceTip` keeps climbing, and
the coverage bar visibly falls behind. That gap is the thing FR-011 exists to keep visible.

A **revoked** monitor stays in the list, with state `revoked`, even though `GET /v1/monitors/<id>`
answers `410` — otherwise revoking would hide the monitor you still need to name in order to delete
it. A **deleted** monitor is gone from the list entirely. See
[`shielded-monitor-api.md`](shielded-monitor-api.md#get-v1monitors--list-monitors).

## 7. Optional: a real shielded transaction (needs a wallet, out of tree)

This is the step that produces an actual match, and it is the one this repository deliberately does
**not** ship code for: the Midnight wallet SDK is not a dependency of UmbraDB and must not become
one. What follows is the sequence the acceptance run used, recorded so it can be repeated.

Start the two services the wallet needs:

```bash
docker compose -p "$DEMO_PROJECT" \
  -f test/compose/docker-compose.yml \
  -f test/compose/docker-compose.hostports.yml \
  up -d indexer proof-server
```

The wallet SDK has no node-only sync path, which is why the indexer appears here. **UmbraDB's own
ingest never reads it.**

Then, from a container or checkout that already holds a coherent pinned Midnight 1.0.0 SDK — the
acceptance run used a sibling project's image, attached to this project's compose network and
pointed at these node / indexer / proof-server endpoints and nothing else:

1. **Deploy the `shielded-night` wrapper contract.** Shielded tokens on Midnight 1.x are
   contract-minted: the ledger has no direct unshielded→shielded operation, so no plain wallet
   transfer produces a zswap output, and an output-only offer is unbalanced and the node refuses it.
2. **`convertToShielded(1_000_000)`** — NIGHT → sNight for the sender.
3. **`transferShielded`** to the recipient's `ShieldedAddress`, built from the `coinPublicKey` and
   `encryptionPublicKey` step 3 printed.

Only step 3 is what the acceptance criterion is about: a wallet-to-wallet shielded transfer whose
zswap output carries a ciphertext the registered encryption secret key can trial-decrypt.

Each proof takes roughly 30–60 seconds. Then watch the dashboard. In the recorded run the match
appeared **12 ms** after the archive logged the block, and the consumer's next poll returned it —
well inside one polling interval on every cadence in the chain.

The match, as the page and the API show it:

```json
{
  "blockHeight": "122",
  "position": 0,
  "txHash": "55c6cb99dcaa816cd30c3d88d93cf2bb258fb814b5d919d770987b86c4fbce86",
  "matchedSegments": [0],
  "appliedOutcome": "unknown",
  "matchingRuleVersion": "shielded-monitor/v1",
  "ledgerBuild": "ledger-v8@8.1.0-syshash.4"
}
```

`appliedOutcome` is `"unknown"` and always will be in this alpha. The service tells you a
transaction is *relevant to your key*. It does not claim funds arrived; deciding that needs ledger
application state this project does not compute.

## 8. Tear down

```bash
for p in api scanner archive-sync; do
  [ -f "$DEMO_DIR/$p.pid" ] && kill "$(cat "$DEMO_DIR/$p.pid")" 2>/dev/null
done

docker compose -p "$DEMO_PROJECT" \
  -f test/compose/docker-compose.yml \
  -f test/compose/docker-compose.hostports.yml \
  down -v --remove-orphans

docker ps -a --filter "name=${DEMO_PROJECT}"   # expect: nothing
rm -rf "$DEMO_DIR"                             # the seed and the viewing key live here
```

`-p "$DEMO_PROJECT"` scopes the teardown to this demo. Any other stack on the machine — including
one that also calls its chain `undeployed1` — is untouched.

---

## The wallet-free half as one command

```bash
npm run demo:shielded-monitor            # steps 0–5, then prints the dashboard URL
npm run demo:shielded-monitor -- --down  # step 8
npm run demo:shielded-monitor -- --help
```

It picks its own project name and random loopback ports, brings up `node` and `postgres` only,
starts the archive sync, the scanner and the API as child processes, derives a demo key into its
working directory, registers it, waits for coverage to reach the tip, and prints the URL. It does
**not** do step 7 — that needs a wallet, and a wallet needs a decision about funds.

## If something is not moving

| Symptom | Look at |
|---|---|
| Dashboard says "API unreachable" | `$DEMO_DIR/api.log`; is `API_PORT` the one you opened? |
| `sourceTip` is `unknown` | The archive has no block 0 yet, or the API cannot read the archive schema. Check `$DEMO_DIR/archive-sync.log`; `SOURCE_TIP=off` also disables the reader deliberately. |
| `sourceTip` climbs, `scannedThrough` does not | The scanner is not running or the monitor is not scannable. Check `$DEMO_DIR/scanner.log` and the monitor's state badge — `paused`, `failed` and `stale_source` all stop coverage, and the row says which. |
| Registration answers `INVALID_VIEWING_KEY` | The key's network does not match `SHIELDED_MONITOR_NET`. One generic error covers every intake failure by design (FR-001), so re-derive with `--net` matching the deployment. |
| Coverage reaches the tip, no matches | Expected until step 7. Nothing on a fresh devnet is encrypted to your key. |
| Node answers on 9944 and you did not start it there | That is someone else's devnet. Use your `$NODE_HOST_PORT`. |
