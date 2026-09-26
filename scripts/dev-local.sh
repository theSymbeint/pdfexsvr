#!/usr/bin/env bash
# Local dev: run pdfexsvr against a local PocketBase v0.40 instance.
#
# One-time setup (see README "Local development"):
#   ./pocketbase serve --http=127.0.0.1:8090 --dir ./pb_data   # PB v0.40+
#   node scripts/dev-pocketbase-setup.mjs                      # schema + seed
#
# The credentials below are throwaway values for a local-only PocketBase
# (127.0.0.1). Override any of them from the environment.
set -euo pipefail

export DBURL="${DBURL:-http://127.0.0.1:8090}"
export DBUSER="${DBUSER:-dandre@local.dev}"
export DBPASSWD="${DBPASSWD:-pdfexlocal123}"

if ! curl -fsS -m 5 "${DBURL}/api/health" >/dev/null; then
  echo "PocketBase is not reachable at ${DBURL}" >&2
  echo "Start it first:  ./pocketbase serve --http=127.0.0.1:8090 --dir ./pb_data" >&2
  exit 1
fi

exec pnpm dev
