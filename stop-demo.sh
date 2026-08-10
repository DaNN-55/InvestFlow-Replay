#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export INVESTFLOW_REPLAY_RUNTIME_DIR="${APP_DIR}/.runtime-demo"
export INVESTFLOW_REPLAY_INSTANCE_NAME="InvestFlow Replay Demo"

exec "${APP_DIR}/stop.sh"
