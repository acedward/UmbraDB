#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
fixture_dir=$(mktemp -d)
trap 'rm -rf "$fixture_dir"' EXIT

fixture="$fixture_dir/unquoted-unpinned.yml"
printf '%s\n' \
  'services:' \
  '  bypass:' \
  '      image: alpine:latest' > "$fixture"

# This exact unquoted/indented form bypassed the old grep, whose pattern required a quote directly
# after `image:`. The regression is two-sided: bad input must fail and the real pinned stack must
# pass, so a verifier that rejects every Compose file cannot report success either.
if "$repo_root/scripts/verify-compose-image-pins.sh" "$fixture"; then
  echo "unquoted, indented, unpinned image unexpectedly passed" >&2
  exit 1
fi

"$repo_root/scripts/verify-compose-image-pins.sh" \
  "$repo_root/test/compose/docker-compose.yml"
