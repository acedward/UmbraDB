#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT

# The regression is two-sided throughout: every bad input below must FAIL the verifier, and the
# real stack must still PASS -- a verifier that rejects every Compose file cannot report success
# either, and would look identical to a working one if only the negative cases were checked.

# (1) This exact unquoted/indented form bypassed the old grep, whose pattern required a quote
# directly after `image:`.
fixture="$fixture_dir/unquoted-unpinned.yml"
printf '%s\n' \
  'services:' \
  '  bypass:' \
  '      image: alpine:latest' > "$fixture"

if "$repo_root/scripts/verify-compose-image-pins.sh" "$fixture"; then
  echo "unquoted, indented, unpinned image unexpectedly passed" >&2
  exit 1
fi

# (2) `config --images` omits services under a `profiles:` key unless that profile is activated,
# so before `--profile '*'` this fixture PASSED while hiding an unpinned image -- the verifier
# reported "all 1 resolved compose images are digest-pinned" and never saw `alpine:latest`. The
# pinned service is present deliberately: without it the file resolves to zero images and the
# vacuous-check guard would fail this for the wrong reason, which would still be green here.
fixture="$fixture_dir/profiled-unpinned.yml"
printf '%s\n' \
  'services:' \
  '  visible:' \
  '    image: alpine@sha256:0000000000000000000000000000000000000000000000000000000000000000' \
  '  hidden:' \
  "    profiles: ['debug']" \
  '    image: alpine:latest' > "$fixture"

if "$repo_root/scripts/verify-compose-image-pins.sh" "$fixture"; then
  echo "unpinned image behind a profiles: key unexpectedly passed" >&2
  exit 1
fi

# The real pinned stack must still pass.
"$repo_root/scripts/verify-compose-image-pins.sh" \
  "$repo_root/test/compose/docker-compose.yml"
