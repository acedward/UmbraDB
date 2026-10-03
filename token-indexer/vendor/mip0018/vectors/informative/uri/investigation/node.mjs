import { readFileSync } from 'node:fs';
import fastUriMod from 'fast-uri'; const fastUri = fastUriMod.default ?? fastUriMod;
import uriJsMod from 'uri-js'; const uriJs = uriJsMod.default ?? uriJsMod;
import { URI, ABS } from './rfc3986.mjs';
const cases = JSON.parse(readFileSync('cases.json','utf8'));
const out = {};
for (const [id, s] of cases) {
  const whatwg = URL.canParse(s);
  const f = fastUri.parse(s); const fu = !f.error && !!f.scheme && f.reference !== 'relative';
  const u = uriJs.parse(s); const uj = !u.error && !!u.scheme && u.reference !== 'relative';
  out[id] = { whatwg, fastUri: fu, uriJs: uj, rfc3986URI: URI.test(s), rfc3986Absolute: ABS.test(s) };
}
console.log(JSON.stringify(out));
