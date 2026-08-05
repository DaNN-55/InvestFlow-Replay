#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python_is_supported() {
  "$1" -c 'import sys; raise SystemExit(0 if (3, 10) <= sys.version_info < (3, 14) else 1)' \
    >/dev/null 2>&1
}

PYTHON_SOURCE=""
for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "${candidate}" >/dev/null 2>&1 && python_is_supported "${candidate}"; then
    PYTHON_SOURCE="$(command -v "${candidate}")"
    break
  fi
done

if [[ -z "${PYTHON_SOURCE}" ]]; then
  echo "需要 Python 3.10–3.13。请先安装兼容版本后再运行 ./install.sh。" >&2
  exit 1
fi

if [[ ! -x "${APP_DIR}/.venv/bin/python" ]] || ! python_is_supported "${APP_DIR}/.venv/bin/python"; then
  "${PYTHON_SOURCE}" -m venv --clear "${APP_DIR}/.venv"
fi
"${APP_DIR}/.venv/bin/python" -m pip install --upgrade pip
"${APP_DIR}/.venv/bin/python" -m pip install -r "${APP_DIR}/engine/requirements.txt"
npm ci --prefix "${APP_DIR}/backend"
npm ci --prefix "${APP_DIR}/web"
PYTHONPATH="${APP_DIR}/engine" "${APP_DIR}/.venv/bin/python" "${APP_DIR}/engine/init_storage.py"

echo "安装完成。运行 ./run.sh 启动。"
