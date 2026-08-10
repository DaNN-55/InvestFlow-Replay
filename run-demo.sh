#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export INVESTFLOW_REPLAY_MARKET_PROVIDER="fixture"
export INVESTFLOW_REPLAY_STORAGE_ROOT="${APP_DIR}/.demo-storage"
export INVESTFLOW_REPLAY_RUNTIME_DIR="${APP_DIR}/.runtime-demo"
export INVESTFLOW_REPLAY_ENGINE_PORT="8875"
export INVESTFLOW_REPLAY_BACKEND_PORT="3210"
export INVESTFLOW_REPLAY_WEB_PORT="5280"

exec "${APP_DIR}/run.sh"
