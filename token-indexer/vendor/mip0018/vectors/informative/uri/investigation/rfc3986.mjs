// Strict RFC 3986 ABNF (URI = scheme ":" hier-part [ "?" query ] [ "#" fragment ]); ASCII only.
const unreserved="A-Za-z0-9\\-._~", subdelims="!$&'()*+,;=", pct="%[0-9A-Fa-f]{2}";
const pchar=`(?:[${unreserved}${subdelims}:@]|${pct})`;
const seg=`${pchar}*`, segnz=`${pchar}+`;
const dec="(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])", ipv4=`${dec}\\.${dec}\\.${dec}\\.${dec}`;
const h16="[0-9A-Fa-f]{1,4}", ls32=`(?:${h16}:${h16}|${ipv4})`;
const ipv6=`(?:(?:${h16}:){6}${ls32}|::(?:${h16}:){5}${ls32}|(?:${h16})?::(?:${h16}:){4}${ls32}|(?:(?:${h16}:){0,1}${h16})?::(?:${h16}:){3}${ls32}|(?:(?:${h16}:){0,2}${h16})?::(?:${h16}:){2}${ls32}|(?:(?:${h16}:){0,3}${h16})?::${h16}:${ls32}|(?:(?:${h16}:){0,4}${h16})?::${ls32}|(?:(?:${h16}:){0,5}${h16})?::${h16}|(?:(?:${h16}:){0,6}${h16})?::)`;
const ipfut=`v[0-9A-Fa-f]+\\.[${unreserved}${subdelims}:]+`;
const host=`(?:\\[(?:${ipv6}|${ipfut})\\]|${ipv4}|(?:[${unreserved}${subdelims}]|${pct})*)`;
const auth=`(?:(?:[${unreserved}${subdelims}:]|${pct})*@)?${host}(?::[0-9]*)?`;
const hier=`(?://${auth}(?:/${seg})*|/(?:${segnz}(?:/${seg})*)?|${segnz}(?:/${seg})*|)`;
const q=`(?:${pchar}|[/?])*`;
export const URI=new RegExp(`^[A-Za-z][A-Za-z0-9+\\-.]*:${hier}(?:\\?${q})?(?:#${q})?$`);
export const ABS=new RegExp(`^[A-Za-z][A-Za-z0-9+\\-.]*:${hier}(?:\\?${q})?$`);
