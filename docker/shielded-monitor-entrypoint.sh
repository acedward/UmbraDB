#!/bin/sh
# The shielded-monitor image's command dispatcher (sub-plan 00009-08 v2).
#
# One image, five commands. `exec` so the process that ends up as PID 1 is the service itself and
# receives SIGTERM directly — every one of these installs its own handler and shuts down cleanly,
# and a shell in between would swallow the signal and leave the orchestrator to SIGKILL it.
set -eu

command="${1:-scanner}"
shift 2>/dev/null || true

case "$command" in
  scanner)     exec node /app/dist-cli/shielded-monitor/scanner-cli.js "$@" ;;
  api)         exec node /app/dist-cli/shielded-monitor/api/server-cli.js "$@" ;;
  balancer)    exec node /app/dist-cli/shielded-monitor/balancer/balancer-cli.js "$@" ;;
  derive-key)  exec node /app/dist-cli/shielded-monitor/derive-key-cli.js "$@" ;;
  storage)     exec node /app/dist-cli/storage-api/server-cli.js "$@" ;;
  archive-sync) exec node /app/dist-cli/chain-archive-sync/sync-cli.js "$@" ;;
  client)      exec node /app/dist-cli/shielded-monitor/client/cli.js "$@" ;;
  *)
    echo "unknown command: $command" >&2
    echo "usage: <scanner|api|balancer|derive-key|storage|archive-sync|client> [args]" >&2
    exit 64
    ;;
esac
