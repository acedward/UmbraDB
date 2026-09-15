#!/usr/bin/env bash
# Runs one script inside the wallet-SDK image, attached to THIS devnet's compose network
# (plan D3.3). The image is the only place the Midnight wallet SDK exists — UmbraDB never depends
# on it — so every step of the golden run that needs a real wallet goes through here.
#
#   dust-sync-client/devnet/sdk-run.sh <script.ts> [--seed-file <path>] [ENV=VALUE ...]
#
# `<script.ts>` is resolved in `dust-sync-client/devnet/sdk/` (mounted at /app/live16) unless it is
# one of the 00009 wallet demo scripts, which live in the organizer's `resources/` and are mounted
# read-only at /app/live.
#
# ── Every container it starts has a NAME, and that is not cosmetic ────────────────────────────
# On 2026-09-15 this session removed another runner's 2.5-hour measurement container by selecting
# it with `docker ps | grep <image>` and `docker rm -f <the one id that printed>` — both containers
# were the same image, and `docker ps`'s `{{.Command}}` truncates
# `sh -c 'cd /app && bun run live16/<script>.ts'` to the SAME string for every script in this
# directory, so the output could not have distinguished them (questions file Q-18). The rule that
# would have prevented it, and the rule now: **select a container by the name you gave it or the id
# you recorded at launch — never by image, never by a `ps | grep`.** Hence `--name`. A `--rm`
# container needs no cleanup at all; a hung one is left to its own timeout.
#
# ── Custody ────────────────────────────────────────────────────────────────────────────────────
# `--seed-file` reads a mode-600 seed and passes it through `--env-file`, NOT on the command line:
# an `-e SEED=<hex>` would put a wallet's master seed in this host's process table for anyone to
# read with `ps`. The env file is created mode 600 in a private temp dir and removed on exit.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ORGANIZER_ROOT="$(cd "${REPO_ROOT}/../.." && pwd)"
STATE_FILE="${DEVNET_STATE_FILE:-/media/eddie/mn-nvme/00016/devnet/state.json}"
IMAGE="${SDK_IMAGE:-midnight-1-offers/shielded-night-deploy:local}"

if [ $# -lt 1 ]; then
  echo "usage: $0 <script.ts> [--seed-file <path>] [--seed-env NAME] [ENV=VALUE ...]" >&2
  exit 2
fi
SCRIPT="$1"; shift

if [ ! -f "${STATE_FILE}" ]; then
  echo "no devnet recorded at ${STATE_FILE}; run: node dust-sync-client/devnet/devnet.mjs up" >&2
  exit 2
fi
PROJECT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["project"])' "${STATE_FILE}")"
OUT_DIR="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["dir"])' "${STATE_FILE}")/out"
mkdir -p "${OUT_DIR}"

SEED_FILE=""
SEED_ENV="SEED"
ENV_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --seed-file) SEED_FILE="$2"; shift 2 ;;
    --seed-env) SEED_ENV="$2"; shift 2 ;;
    *) ENV_ARGS+=("-e" "$1"); shift ;;
  esac
done

TMPDIR_RUN="$(mktemp -d)"
chmod 700 "${TMPDIR_RUN}"
cleanup() { rm -rf "${TMPDIR_RUN}"; }
trap cleanup EXIT
ENV_FILE="${TMPDIR_RUN}/env"
: > "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
if [ -n "${SEED_FILE}" ]; then
  # Never echoed, never in argv: read the file and write one KEY=VALUE line into a 600 env file.
  printf '%s=%s\n' "${SEED_ENV}" "$(tr -d '[:space:]' < "${SEED_FILE}")" >> "${ENV_FILE}"
fi

# The 00009 demo scripts live in the organizer's resources and are used unmodified.
MOUNTS=(
  -v "${REPO_ROOT}/dust-sync-client/devnet/sdk:/app/live16:ro"
  -v "${OUT_DIR}:/out"
)
if [ -d "${ORGANIZER_ROOT}/resources/00009-wallet-demo-scripts" ]; then
  MOUNTS+=(-v "${ORGANIZER_ROOT}/resources/00009-wallet-demo-scripts:/app/live:ro")
fi

case "${SCRIPT}" in
  create-and-fund.ts|snight-txs.ts) MOUNT_POINT="live" ;;
  *) MOUNT_POINT="live16" ;;
esac

CONTAINER_NAME="umbra-00016-devnet-sdk-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
echo "container ${CONTAINER_NAME} (remove it by THAT name, never by image)" >&2

exec docker run --rm \
  --name "${CONTAINER_NAME}" \
  --network "${PROJECT}_default" \
  --user "$(id -u):$(id -g)" \
  -e HOME=/tmp \
  --env-file "${ENV_FILE}" \
  -e MN_ENV=undeployed \
  -e OUT_DIR=/out \
  -e MN_NODE_URL=http://node:9944 \
  -e MN_INDEXER_URL=http://indexer:8088/api/v4/graphql \
  -e MN_INDEXER_WS_URL=ws://indexer:8088/api/v4/graphql/ws \
  -e MN_PROOF_SERVER_URL=http://proof-server:6300 \
  "${ENV_ARGS[@]}" \
  "${MOUNTS[@]}" \
  --entrypoint sh \
  "${IMAGE}" \
  -c "cd /app && bun run ${MOUNT_POINT}/${SCRIPT}"
