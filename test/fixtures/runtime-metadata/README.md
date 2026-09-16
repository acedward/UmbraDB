# Captured runtime metadata

SCALE-encoded runtime metadata, captured from a real node and committed so metadata-driven
decoding is testable **without a running node** — in CI, from a fresh clone, forever.

This matters beyond convenience. The reference indexer also captures metadata per node version
rather than resolving it at runtime (`midnight-indexer/get_node_metadata.sh`, `NODE_VERSIONS`,
`chain-indexer/build.rs`), so a committed artifact is the pattern being reproduced, not a shortcut
around it.

| File | Source | Metadata version |
|---|---|---|
| `midnight-node-1.0.0-protocol-1000000.scale` | `state_getMetadata` at genesis of a `midnightntwrk/midnight-node:1.0.0` devnet (chain `undeployed1`) | **V14**, 102,234 bytes |

## How it was captured

`state_getMetadata` accepts a block hash, which is what makes block-scoped decoding possible at
all — metadata must be resolved for the block being decoded, never the chain tip, or a block
spanning a runtime upgrade decodes against the wrong layout.

```bash
GEN=$(curl -s -X POST http://127.0.0.1:19944 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"chain_getBlockHash","params":[0]}' | jq -r .result)
curl -s -X POST http://127.0.0.1:19944 -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"state_getMetadata\",\"params\":[\"$GEN\"]}" \
  | jq -r .result | cut -c3- | xxd -r -p > midnight-node-1.0.0-protocol-1000000.scale
```

Verify integrity with `sha256sum -c SHA256SUMS`.

## What this fixture does and does not cover

On the devnet it came from, metadata is **byte-identical at genesis and at the finalized tip** —
that chain never performed a runtime upgrade. So this fixture exercises decoding, but it cannot
exercise a runtime-upgrade boundary: one captured artifact per runtime is needed for that, and no
reachable chain currently provides a second one. Recorded as U6 in the sprint plan rather than
implied by a lone file here.
