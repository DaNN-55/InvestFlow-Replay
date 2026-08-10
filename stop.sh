#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${INVESTFLOW_REPLAY_RUNTIME_DIR:-${APP_DIR}/.runtime}"
INSTANCE_NAME="${INVESTFLOW_REPLAY_INSTANCE_NAME:-InvestFlow Replay}"
found=0
stopped=0
failed=0

for service in web backend engine; do
  pid_file="${RUNTIME_DIR}/${service}.pid"
  if [[ -f "${pid_file}" ]]; then
    found=1
    pid="$(tr -cd '0-9' < "${pid_file}")"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}"
      for _ in {1..50}; do
        if ! kill -0 "${pid}" 2>/dev/null; then
          break
        fi
        sleep 0.1
      done
      if kill -0 "${pid}" 2>/dev/null; then
        echo "${service} 未能在 5 秒内停止（PID ${pid}）。" >&2
        failed=1
        continue
      fi
      stopped=1
    fi
    rm -f -- "${pid_file}"
  fi
done

if [[ "${failed}" -ne 0 ]]; then
  exit 1
fi
if [[ "${found}" -eq 0 ]]; then
  echo "${INSTANCE_NAME} 未在运行。"
elif [[ "${stopped}" -eq 0 ]]; then
  echo "${INSTANCE_NAME} 没有运行中的进程，已清理失效状态。"
else
  echo "${INSTANCE_NAME} 已停止。"
fi
