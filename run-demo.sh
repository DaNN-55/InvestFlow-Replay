#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEMO_STORAGE="${APP_DIR}/.demo-storage"

if [[ -L "${DEMO_STORAGE}" ]]; then
  echo "拒绝启动：.demo-storage 是符号链接。" >&2
  exit 1
fi
if [[ -e "${DEMO_STORAGE}" && ! -d "${DEMO_STORAGE}" ]]; then
  echo "拒绝启动：.demo-storage 不是目录。" >&2
  exit 1
fi
mkdir -p -- "${DEMO_STORAGE}"

export INVESTFLOW_REPLAY_MARKET_PROVIDER="fixture"
export INVESTFLOW_REPLAY_STORAGE_ROOT="${DEMO_STORAGE}"
export INVESTFLOW_REPLAY_RUNTIME_DIR="${APP_DIR}/.runtime-demo"
export INVESTFLOW_REPLAY_ENGINE_PORT="8875"
export INVESTFLOW_REPLAY_BACKEND_PORT="3210"
export INVESTFLOW_REPLAY_WEB_PORT="5280"

exec "${APP_DIR}/run.sh"
