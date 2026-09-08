from __future__ import annotations

import os
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
MARKET_PROVIDER = os.environ.get(
    "INVESTFLOW_REPLAY_MARKET_PROVIDER", "tdx"
).strip().lower()
STORAGE_ROOT = Path(
    os.environ.get("INVESTFLOW_REPLAY_STORAGE_ROOT", PROJECT_ROOT / "storage")
).resolve()
DEFAULT_MARKET_DB_PATH = (STORAGE_ROOT / "market" / "market.duckdb").resolve()
DEFAULT_CATALOG_DB_PATH = (STORAGE_ROOT / "market" / "catalog.duckdb").resolve()
MINUTE_REPLAY_DB_PATH = (STORAGE_ROOT / "market" / "minute_replay.duckdb").resolve()
MARKET_DB_PATH = Path(
    os.environ.get("INVESTFLOW_REPLAY_MARKET_DB_PATH", DEFAULT_MARKET_DB_PATH)
).resolve()
REPLAY_SOURCE_DB_PATH = MARKET_DB_PATH
CATALOG_DB_PATH = DEFAULT_CATALOG_DB_PATH
