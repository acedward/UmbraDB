# Informative URI vectors (`valType` 4)

**Not normative** (the MIP's Testing list has only R5's relative URI). The MIP's rule for a type-4 value (Value
types): "A URI as defined in RFC 3986: a scheme is required, a fragment is allowed, and relative references are not.
All characters are ASCII; characters outside ASCII MUST be percent-encoded, and host names converted to their ASCII
form, before emitting." It is the URI definition ERC-721 `tokenURI` uses. A value that breaks it rejects the whole
event, so two consumers whose URI parsers disagree would disagree on every record of that event; these cases fix the
verdict for 26 realistic inputs. Relative references are rejected, as normative vector R5e requires.

| File | Content |
|---|---|
| `INF-URI-c01.json` … `INF-URI-c26.json` (+ `.bin`) | One payload vector per case: header `0x11 × 32`, kind 3, one record `uri` (type 4) holding the case's UTF-8 bytes; `accept` or `reject` (`invalid-uri`) per the rule above |
| `verdicts.json` | The 26 cases with their verdict (16 accept, 10 reject) |
| `investigation/` | The investigation inputs and results: `cases.json` (inputs), `rfc3986.mjs` (strict RFC 3986 grammar, `URI` and `absolute-URI`), `node.mjs` + `node.json` (WHATWG `URL`, fast-uri, uri-js, strict grammar — Node 24.21.0), `py.py` + `py.json` (Python `urllib.parse`, `rfc3986` 2.0.0, `rfc3987` 1.3.8) |

The verdicts are the strict grammar's `rfc3986URI` column; the generator checks that they also equal Python
`rfc3987`'s rule `URI` (an independent implementation of the same grammar) for all 26 cases. The libraries that
diverge (WHATWG `URL`, fast-uri, uri-js, `urllib.parse`, `rfc3986`) disagree on 11 of the 26 inputs: fragments under
the `absolute-URI` reading, non-ASCII host/path/query, a space, a backslash, an empty authority, an out-of-range port,
a leading space and a bad percent-escape.

Note that `javascript:alert(1)` (c20) is a syntactically valid URI: validation is not a safety check, and the MIP
forbids fetching a URI without the precautions a consumer applies to any remote content.
