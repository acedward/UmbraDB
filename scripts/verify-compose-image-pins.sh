#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 )); then
  set -- test/compose/docker-compose.yml
fi

compose_args=()
for file in "$@"; do
  compose_args+=(--file "$file")
done

# Parse Compose's resolved model, not YAML source text. Quoting, indentation, anchors, and
# environment interpolation are syntax details; `config --images` reports the image references
# Docker will actually run after all of those have been resolved.
mapfile -t images < <(docker compose "${compose_args[@]}" config --images)
if (( ${#images[@]} == 0 )); then
  echo "compose configuration resolved no images; refusing a vacuous pin check" >&2
  exit 1
fi

bad=()
for image in "${images[@]}"; do
  if [[ ! $image =~ @sha256:[0-9a-f]{64}$ ]]; then
    bad+=("$image")
  fi
done

if (( ${#bad[@]} > 0 )); then
  echo "compose resolves unpinned image reference(s):" >&2
  printf '  %s\n' "${bad[@]}" >&2
  echo "every resolved image must end in @sha256:<64 lowercase hex digits>" >&2
  exit 1
fi

printf 'all %d resolved compose images are digest-pinned\n' "${#images[@]}"
