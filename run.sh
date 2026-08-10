#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${APP_DIR}/.runtime"
PYTHON_BIN="${APP_DIR}/.venv/bin/python"
ENGINE_PORT="${INVESTFLOW_REPLAY_ENGINE_PORT:-8775}"
BACKEND_PORT="${INVESTFLOW_REPLAY_BACKEND_PORT:-3110}"
WEB_PORT="${INVESTFLOW_REPLAY_WEB_PORT:-5180}"

port_is_listening() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

cleanup_started_processes() {
  for pid in "${started_pids[@]:-}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
    fi
  done
  rm -f \
    "${RUNTIME_DIR}/engine.pid" \
    "${RUNTIME_DIR}/backend.pid" \
    "${RUNTIME_DIR}/web.pid"
}

show_startup_failure() {
  local service="$1"
  local log_file="$2"
  echo "${service} 启动失败，最近日志：" >&2
  tail -n 20 "${log_file}" >&2 || true
  cleanup_started_processes
  exit 1
}

wait_for_service() {
  local service="$1"
  local pid="$2"
  local url="$3"
  local log_file="$4"

  for _ in {1..100}; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      show_startup_failure "${service}" "${log_file}"
    fi
    if curl --fail --silent --show-error --max-time 1 "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done

  show_startup_failure "${service}" "${log_file}"
}

if [[ ! -x "${PYTHON_BIN}" ]]; then
  echo "缺少独立 Python 环境，请先在当前目录运行：./install.sh" >&2
  exit 1
fi
if [[ ! -x "${APP_DIR}/web/node_modules/.bin/vite" ]]; then
  echo "缺少前端依赖，请先在当前目录运行：./install.sh" >&2
  exit 1
fi
if ! command -v lsof >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo "启动检查需要 lsof 和 curl，请先安装后重试。" >&2
  exit 1
fi

mkdir -p "${RUNTIME_DIR}"
blocked=0
for entry in \
  "Engine:${ENGINE_PORT}" \
  "Backend:${BACKEND_PORT}" \
  "Web:${WEB_PORT}"; do
  service="${entry%%:*}"
  port="${entry##*:}"
  if port_is_listening "${port}"; then
    echo "${service} 端口 ${port} 已被占用。请先运行 ./stop.sh；若仍占用，请检查该端口上的遗留进程。" >&2
    blocked=1
  fi
done
if [[ "${blocked}" -ne 0 ]]; then
  exit 1
fi

rm -f \
  "${RUNTIME_DIR}/engine.pid" \
  "${RUNTIME_DIR}/backend.pid" \
  "${RUNTIME_DIR}/web.pid"

started_pids=()
trap 'cleanup_started_processes; exit 130' INT TERM

PYTHONPATH="${APP_DIR}/engine" "${PYTHON_BIN}" -m uvicorn replay_engine.app:app \
  --host 127.0.0.1 --port "${ENGINE_PORT}" \
  >"${RUNTIME_DIR}/engine.log" 2>&1 &
engine_pid=$!
started_pids+=("${engine_pid}")
echo "${engine_pid}" >"${RUNTIME_DIR}/engine.pid"

(
  cd "${APP_DIR}/backend"
  export INVESTFLOW_REPLAY_ENGINE_URL="http://127.0.0.1:${ENGINE_PORT}"
  export INVESTFLOW_REPLAY_BACKEND_PORT="${BACKEND_PORT}"
  exec node --no-warnings src/standalone-server.js
) \
  >"${RUNTIME_DIR}/backend.log" 2>&1 &
backend_pid=$!
started_pids+=("${backend_pid}")
echo "${backend_pid}" >"${RUNTIME_DIR}/backend.pid"

(
  cd "${APP_DIR}/web"
  export INVESTFLOW_REPLAY_BACKEND_PORT="${BACKEND_PORT}"
  export INVESTFLOW_REPLAY_WEB_PORT="${WEB_PORT}"
  exec node node_modules/vite/bin/vite.js --strictPort
) \
  >"${RUNTIME_DIR}/web.log" 2>&1 &
web_pid=$!
started_pids+=("${web_pid}")
echo "${web_pid}" >"${RUNTIME_DIR}/web.pid"

wait_for_service \
  "Engine" \
  "${engine_pid}" \
  "http://127.0.0.1:${ENGINE_PORT}/internal/health" \
  "${RUNTIME_DIR}/engine.log"
wait_for_service \
  "Backend" \
  "${backend_pid}" \
  "http://127.0.0.1:${BACKEND_PORT}/api/quant/replay/cache/status" \
  "${RUNTIME_DIR}/backend.log"
wait_for_service \
  "Web" \
  "${web_pid}" \
  "http://127.0.0.1:${WEB_PORT}/decision/market-replay" \
  "${RUNTIME_DIR}/web.log"

trap - INT TERM

echo "InvestFlow Replay 已启动：http://127.0.0.1:${WEB_PORT}/decision/market-replay"
echo "首次进入会由通达信初始化日线缓存；分钟数据按需下载并落入本地缓存。"
