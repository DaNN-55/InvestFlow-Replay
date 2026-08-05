#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${APP_DIR}/.runtime"
PYTHON_BIN="${APP_DIR}/.venv/bin/python"
ENGINE_PORT="${INVESTFLOW_REPLAY_ENGINE_PORT:-8775}"
BACKEND_PORT="${INVESTFLOW_REPLAY_BACKEND_PORT:-3110}"
WEB_PORT="${INVESTFLOW_REPLAY_WEB_PORT:-5180}"

if [[ ! -x "${PYTHON_BIN}" ]]; then
  echo "缺少独立 Python 环境，请先在当前目录运行：./install.sh" >&2
  exit 1
fi
if [[ ! -x "${APP_DIR}/web/node_modules/.bin/vite" ]]; then
  echo "缺少前端依赖，请先在当前目录运行：./install.sh" >&2
  exit 1
fi

mkdir -p "${RUNTIME_DIR}"
PYTHONPATH="${APP_DIR}/engine" "${PYTHON_BIN}" -m uvicorn replay_engine.app:app \
  --host 127.0.0.1 --port "${ENGINE_PORT}" \
  >"${RUNTIME_DIR}/engine.log" 2>&1 &
echo $! >"${RUNTIME_DIR}/engine.pid"

INVESTFLOW_REPLAY_ENGINE_URL="http://127.0.0.1:${ENGINE_PORT}" \
INVESTFLOW_REPLAY_BACKEND_PORT="${BACKEND_PORT}" \
  npm start --prefix "${APP_DIR}/backend" \
  >"${RUNTIME_DIR}/backend.log" 2>&1 &
echo $! >"${RUNTIME_DIR}/backend.pid"

INVESTFLOW_REPLAY_BACKEND_PORT="${BACKEND_PORT}" \
INVESTFLOW_REPLAY_WEB_PORT="${WEB_PORT}" \
  npm run dev --prefix "${APP_DIR}/web" \
  >"${RUNTIME_DIR}/web.log" 2>&1 &
echo $! >"${RUNTIME_DIR}/web.pid"

echo "InvestFlow Replay 已启动：http://127.0.0.1:${WEB_PORT}/decision/market-replay"
echo "首次进入会由通达信初始化日线缓存；分钟数据按需下载并落入本地缓存。"
