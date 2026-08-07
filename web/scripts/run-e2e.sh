#!/usr/bin/env bash
set -euo pipefail

WEB_PORT="${INVESTFLOW_REPLAY_WEB_PORT:-5180}"
BASE_URL="http://127.0.0.1:${WEB_PORT}"

npm run dev -- --host 127.0.0.1 --port "${WEB_PORT}" > /tmp/investflow-replay-e2e-vite.log 2>&1 &
VITE_PID=$!
trap 'kill "${VITE_PID}" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  if curl --silent --fail "${BASE_URL}" >/dev/null; then
    break
  fi
  sleep 0.1
done

PLAYWRIGHT_BASE_URL="${BASE_URL}" npx playwright test tests/e2e
