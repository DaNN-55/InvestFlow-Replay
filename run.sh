#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${INVESTFLOW_REPLAY_RUNTIME_DIR:-${APP_DIR}/.runtime}"
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
for service in engine backend web; do
  pid_file="${RUNTIME_DIR}/${service}.pid"
  if [[ -f "${pid_file}" ]]; then
    pid="$(tr -cd '0-9' < "${pid_file}")"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      echo "${service} 已在运行（PID ${pid}），请先停止当前实例。" >&2
      exit 1
    fi
  fi
done

PYTHONPATH="${APP_DIR}/engine" "${PYTHON_BIN}" -m uvicorn replay_engine.app:app \
  --host 127.0.0.1 --port "${ENGINE_PORT}" \
  >"${RUNTIME_DIR}/engine.log" 2>&1 &
echo $! >"${RUNTIME_DIR}/engine.pid"

(
  cd "${APP_DIR}/backend"
  INVESTFLOW_REPLAY_ENGINE_URL="http://127.0.0.1:${ENGINE_PORT}" \
  INVESTFLOW_REPLAY_BACKEND_PORT="${BACKEND_PORT}" \
    exec node --no-warnings src/standalone-server.js
) >"${RUNTIME_DIR}/backend.log" 2>&1 &
echo $! >"${RUNTIME_DIR}/backend.pid"

(
  cd "${APP_DIR}/web"
  INVESTFLOW_REPLAY_BACKEND_PORT="${BACKEND_PORT}" \
  INVESTFLOW_REPLAY_WEB_PORT="${WEB_PORT}" \
    exec node node_modules/vite/bin/vite.js --strictPort
) >"${RUNTIME_DIR}/web.log" 2>&1 &
echo $! >"${RUNTIME_DIR}/web.pid"

sleep 1
startup_failed=0
for service in engine backend web; do
  pid="$(tr -cd '0-9' < "${RUNTIME_DIR}/${service}.pid")"
  if [[ -z "${pid}" ]] || ! kill -0 "${pid}" 2>/dev/null; then
    echo "${service} 启动失败，请检查 ${RUNTIME_DIR}/${service}.log。" >&2
    startup_failed=1
  fi
done
if [[ "${startup_failed}" -ne 0 ]]; then
  for service in engine backend web; do
    pid="$(tr -cd '0-9' < "${RUNTIME_DIR}/${service}.pid")"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}"
    fi
    rm -f -- "${RUNTIME_DIR}/${service}.pid"
  done
  exit 1
fi

echo "InvestFlow Replay 已启动：http://127.0.0.1:${WEB_PORT}/decision/market-replay"
if [[ "${INVESTFLOW_REPLAY_MARKET_PROVIDER:-tdx}" == "fixture" ]]; then
  echo "当前使用离线合成行情；会话、订单、事件和复盘仍保存到独立 Demo 存储。"
else
  echo "首次进入会由通达信初始化日线缓存；分钟数据按需下载并落入本地缓存。"
fi
