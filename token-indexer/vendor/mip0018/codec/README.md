# `@mip0018/codec`

Dependency-free TypeScript codec for MIP-0018 `TokenMetadata` events
([MIP-0018 @ `78ecbb4b`](https://github.com/midnightntwrk/midnight-improvement-proposals/blob/78ecbb4b1ba57371e84fe45f705991ab7b996a61/mips/mip-0018-on-chain-token-metadata.md), [PR #340](https://github.com/midnightntwrk/midnight-improvement-proposals/pull/340)).
It passes every payload vector in `vectors/` (normative and informative). Node ≥ 24 runs the TypeScript sources directly.

```ts
import { classifyEvent, encodePayload, commonRecords, record, EVENT_NAME } from '@mip0018/codec';

const payload = encodePayload({ domainSep, kind: 3 }, commonRecords({ name: 'Acme Token', symbol: 'ACME', decimals: 6, standards: ['mip-0004'] }));
// payload equals MIP Appendix A when domainSep = 0x11 × 32

const c = classifyEvent({ type: 'Misc', name: EVENT_NAME, payload });
// { result: 'accept', header, records, contentEnd } | { result: 'reject', reason, offset } | { result: 'ignore', reason }
```

| Export | What it does |
|---|---|
| `EVENT_NAME`, `EVENT_NAME_TEXT` | `pad(32, "mip-0018:token-metadata[v1]")` |
| `classifyEvent({type, name, payload})` | `ignore` unless a `Misc` event with exactly the v1 name; otherwise decode → `accept` or `reject` (whole event). A `name` shorter than 32 bytes and a `payload` shorter than 256 bytes are zero-extended first (MIP "Consuming": "consumers MUST treat missing trailing bytes as zero"); a longer name is another name, a longer payload is rejected |
| `decodePayload(bytes)` | The MIP's three checks and the value-type rules, after zero-extending a short payload to 256 bytes (`bad-payload-length` only for a longer one); `{ok:true, header, records, contentEnd}` or `{ok:false, reason, offset}`; never throws for a `Uint8Array` |
| `encodePayload(header, records)` | Exact bytes (header ‖ records ‖ zero padding); throws `InvalidHeader`, `InvalidRecord` or `PayloadTooLarge` rather than produce a payload a consumer would reject |
| `record.*`, `commonRecords(…)` | Record constructors (`utf8`, `bytes`, `uint` (LE, minimal or explicit width), `json`, `uri`, `tombstone`) |
| `checkValue`, `decodeUtf8`, `decodeUint`, `encodeUint`, `isRfc3986Uri` | The value-type rules on their own |
| `splitMiscData(data)` | Splits raw `name ‖ payload` log data, zero-extending it to 288 bytes first (sources that drop trailing zeros: raw ledger data, the Compact runtime; MIP "Consuming") |
| `zeroExtend(bytes, size)` | The zero extension on its own: a copy extended to `size`, the input when it already has `size` bytes, `undefined` when it is longer |

Value types, as implemented:

| `valType` | Rule |
|---:|---|
| 0 bytes | any |
| 1 UTF-8 | strict UTF-8 (RFC 3629: no overlongs, surrogates or code points above U+10FFFF); a BOM is kept as a character |
| 2 unsigned integer | 1–31 bytes, little-endian → `bigint` |
| 3 JSON | strict UTF-8, then the platform parser (`JSON.parse`) must accept the text as one value (owner ruling F2) |
| 4 URI | strict UTF-8, then the RFC 3986 `URI` rule: scheme required, fragment allowed, no relative references, ASCII only — the MIP's own text since `78ecbb4` (owner ruling Q20 followed ERC-721). Never fetched or normalised |
| 5 Null | `valLen` 0 (a tombstone) |
| 6–255 | reserved: reject |

Hardening: every length is checked before any byte is read; every read goes through a bounds-checked accessor; the
fuzz test (`npm test -w packages/codec -- fuzz`, 2 × 100 000 payloads, fixed + logged random seed) asserts that no
input throws, that every accepted payload is internally consistent, that `encode(decode(p)) == p`, and that the
payload with its trailing zero bytes dropped decodes exactly like `p` (zero extension; also
[`zero-extension.test.ts`](test/zero-extension.test.ts) and the informative vectors `INF-ZEXT-*`).

`@mip0018/codec/internal` exposes rule switches used only by the rule-mutation test; the public API always applies
every rule.
