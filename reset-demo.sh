#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEMO_STORAGE="${APP_DIR}/.demo-storage"

if [[ -L "${DEMO_STORAGE}" ]]; then
  echo "拒绝重置：.demo-storage 是符号链接。" >&2
  exit 1
fi
if [[ -e "${DEMO_STORAGE}" && ! -d "${DEMO_STORAGE}" ]]; then
  echo "拒绝重置：.demo-storage 不是目录。" >&2
  exit 1
fi

rm -rf -- "${DEMO_STORAGE}"
mkdir -p -- "${DEMO_STORAGE}"
echo "Demo 数据已重置：${DEMO_STORAGE}"
