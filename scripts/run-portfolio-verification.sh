#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUTPUT_DIR="${1:-}"

if [[ -z "${OUTPUT_DIR}" ]]; then
  echo "用法：$0 /absolute/output/directory" >&2
  exit 2
fi
if [[ "${OUTPUT_DIR}" != /* ]]; then
  echo "输出目录必须是绝对路径：${OUTPUT_DIR}" >&2
  exit 2
fi
OUTPUT_PARENT="$(cd "$(dirname "${OUTPUT_DIR}")" && pwd -P)"
OUTPUT_DIR="${OUTPUT_PARENT}/$(basename "${OUTPUT_DIR}")"
case "${OUTPUT_DIR}/" in
  "${PROJECT_DIR}/"*)
    echo "输出目录必须位于项目目录之外，避免写入 storage 或提交运行产物：${OUTPUT_DIR}" >&2
    exit 2
    ;;
esac
if [[ -d "${OUTPUT_DIR}" ]] && [[ -n "$(find "${OUTPUT_DIR}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "输出目录必须不存在或为空：${OUTPUT_DIR}" >&2
  exit 2
fi

REPORT_DIR="${OUTPUT_DIR}/reports"
LOG_DIR="${OUTPUT_DIR}/logs"
SCREENSHOT_DIR="${OUTPUT_DIR}/screenshots"
FAILURE_SCREENSHOT="${SCREENSHOT_DIR}/market-cache-insufficient.png"
mkdir -p -- "${REPORT_DIR}" "${LOG_DIR}" "${SCREENSHOT_DIR}"

cd "${PROJECT_DIR}"

SMOKE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/investflow-portfolio-smoke.XXXXXX")"
SMOKE_STORAGE="${SMOKE_ROOT}/storage"
SMOKE_RUNTIME="${SMOKE_ROOT}/runtime"
SMOKE_ENGINE_PORT="${PORTFOLIO_SMOKE_ENGINE_PORT:-18775}"
SMOKE_BACKEND_PORT="${PORTFOLIO_SMOKE_BACKEND_PORT:-13110}"
SMOKE_WEB_PORT="${PORTFOLIO_SMOKE_WEB_PORT:-15180}"
SMOKE_RUNNING=0

cleanup_smoke() {
  if [[ "${SMOKE_RUNNING}" -eq 1 ]]; then
    INVESTFLOW_REPLAY_RUNTIME_DIR="${SMOKE_RUNTIME}" \
      INVESTFLOW_REPLAY_INSTANCE_NAME="InvestFlow Replay portfolio smoke" \
      "${PROJECT_DIR}/stop.sh" >>"${LOG_DIR}/offline-smoke.txt" 2>&1 || true
    SMOKE_RUNNING=0
  fi
  rm -rf -- "${SMOKE_ROOT}"
}
trap cleanup_smoke EXIT

mkdir -p -- "${SMOKE_STORAGE}" "${SMOKE_RUNTIME}"
INVESTFLOW_REPLAY_MARKET_PROVIDER="fixture" \
INVESTFLOW_REPLAY_STORAGE_ROOT="${SMOKE_STORAGE}" \
INVESTFLOW_REPLAY_RUNTIME_DIR="${SMOKE_RUNTIME}" \
INVESTFLOW_REPLAY_ENGINE_PORT="${SMOKE_ENGINE_PORT}" \
INVESTFLOW_REPLAY_BACKEND_PORT="${SMOKE_BACKEND_PORT}" \
INVESTFLOW_REPLAY_WEB_PORT="${SMOKE_WEB_PORT}" \
  "${PROJECT_DIR}/run.sh" >"${LOG_DIR}/offline-smoke.txt" 2>&1
SMOKE_RUNNING=1

INVESTFLOW_DEMO_BASE_URL="http://127.0.0.1:${SMOKE_WEB_PORT}" \
INVESTFLOW_DEMO_SMOKE_ONLY=1 \
INVESTFLOW_DEMO_TIME_SCALE=0.001 \
  node scripts/record-portfolio-demo.mjs >>"${LOG_DIR}/offline-smoke.txt" 2>&1

for service in engine backend web; do
  cp "${SMOKE_RUNTIME}/${service}.log" "${LOG_DIR}/offline-smoke-${service}.txt"
done
cleanup_smoke

PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=engine \
  .venv/bin/python -m pytest -p no:cacheprovider engine/tests \
  --junitxml="${REPORT_DIR}/engine-junit.xml" \
  2>&1 | tee "${LOG_DIR}/engine.txt"

(
  cd backend
  node --no-warnings --test --test-concurrency=1 \
    --test-reporter=spec \
    --test-reporter-destination="${LOG_DIR}/backend.txt" \
    --test-reporter=junit \
    --test-reporter-destination="${REPORT_DIR}/backend-junit.xml" \
    src/replay-*.test.js src/standalone-*.test.js src/trade-license*.test.js
)

(
  cd web
  node --test \
    --test-reporter=spec \
    --test-reporter-destination="${LOG_DIR}/web-unit.txt" \
    --test-reporter=junit \
    --test-reporter-destination="${REPORT_DIR}/web-unit-junit.xml" \
    tests/unit/**/*.test.js
)

PORTFOLIO_FAILURE_SCREENSHOT="${FAILURE_SCREENSHOT}" \
  npm run test:e2e --prefix web 2>&1 | tee "${LOG_DIR}/e2e.txt"
if [[ ! -s "${FAILURE_SCREENSHOT}" ]]; then
  echo "缓存不足可视证据未生成：${FAILURE_SCREENSHOT}" >&2
  exit 1
fi
npm run lint --prefix web >"${LOG_DIR}/lint.txt" 2>&1
npm run build --prefix web >"${LOG_DIR}/build.txt" 2>&1

export PORTFOLIO_PROJECT_DIR="${PROJECT_DIR}"
export PORTFOLIO_OUTPUT_DIR="${OUTPUT_DIR}"
node <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const projectDir = process.env.PORTFOLIO_PROJECT_DIR;
const outputDir = process.env.PORTFOLIO_OUTPUT_DIR;
const run = (command, args = []) => execFileSync(command, args, {
  cwd: projectDir,
  encoding: "utf8",
}).trim();
const packageLock = (relativePath) => JSON.parse(
  fs.readFileSync(path.join(projectDir, relativePath), "utf8"),
).lockfileVersion;

const manifest = {
  generatedAt: new Date().toISOString(),
  git: {
    commit: run("git", ["rev-parse", "HEAD"]),
    branch: run("git", ["branch", "--show-current"]),
    dirtyPaths: run("git", ["status", "--porcelain"]).split("\n").filter(Boolean),
  },
  environment: {
    platform: `${os.platform()}-${os.arch()}`,
    node: process.version,
    npm: run("npm", ["--version"]),
    python: run(path.join(projectDir, ".venv/bin/python"), ["--version"]),
  },
  lockfiles: {
    backend: packageLock("backend/package-lock.json"),
    web: packageLock("web/package-lock.json"),
  },
  dataModes: {
    offlineSmoke: "fixture browser flow with real Web, Backend, Engine, and SQLite",
    browserE2E: "API-mocked interaction contracts",
    onlineTdx: "adapter behavior covered by Engine tests; no live network claim",
  },
  artifacts: {
    cacheInsufficientScreenshot: "screenshots/market-cache-insufficient.png",
  },
};

fs.writeFileSync(
  path.join(outputDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
NODE

echo "作品证据验证通过：${OUTPUT_DIR}"
