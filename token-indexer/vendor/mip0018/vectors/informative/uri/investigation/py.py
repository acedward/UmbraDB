import json, urllib.parse, rfc3986, rfc3987
cases = json.load(open('cases.json'))
out = {}
for cid, s in cases:
    try:
        p = urllib.parse.urlparse(s); ul = bool(p.scheme)
    except Exception: ul = False
    v = rfc3986.validators.Validator().require_presence_of('scheme')
    try:
        ref = rfc3986.uri_reference(s); v.validate(ref); r86 = ref.is_valid(require_scheme=True)
    except Exception: r86 = False
    def m(rule):
        try: return rfc3987.match(s, rule=rule) is not None
        except Exception: return False
    out[cid] = {"pyUrlparse": ul, "pyRfc3986": r86, "pyRfc3987_URI": m('URI'), "pyRfc3987_absURI": m('absolute_URI'), "pyRfc3987_IRI": m('IRI')}
print(json.dumps(out))
