#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${APP_DIR}/.runtime"

collect_descendants() {
  local parent_pid="$1"
  local child_pid

  if ! command -v pgrep >/dev/null 2>&1; then
    return
  fi
  for child_pid in $(pgrep -P "${parent_pid}" 2>/dev/null || true); do
    collect_descendants "${child_pid}"
    printf '%s\n' "${child_pid}"
  done
}

for service in web backend engine; do
  pid_file="${RUNTIME_DIR}/${service}.pid"
  if [[ -f "${pid_file}" ]]; then
    pid="$(tr -cd '0-9' < "${pid_file}")"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      descendants="$(collect_descendants "${pid}")"
      if [[ -n "${descendants}" ]]; then
        while IFS= read -r child_pid; do
          kill "${child_pid}" 2>/dev/null || true
        done <<<"${descendants}"
      fi
      kill "${pid}" 2>/dev/null || true
    fi
    rm -f "${pid_file}"
  fi
done

echo "InvestFlow Replay 已停止。"
