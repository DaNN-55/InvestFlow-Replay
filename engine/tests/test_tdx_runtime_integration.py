from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd

from replay_engine.data_store import DuckDbBarStore
from replay_engine.service import EngineService
from replay_engine.tdx_market_cache import TdxMarketCache


class RecordingMarketProvider:
    def __init__(self) -> None:
        self.ensure_calls = 0
        self.prepare_calls = 0
        self.cache = None

    def ensure_ready(self):
        self.ensure_calls += 1
        return {"mode": "cache", "message": "ready"}

    def ensure_instruments(self):
        self.ensure_calls += 1
        return {"mode": "cache", "message": "ready"}

    def prepare_replay_cache(self):
        self.prepare_calls += 1
        return {
            "state": "ready",
            "ready": True,
            "completed": 1,
            "total": 1,
            "message": "ready",
            "error": "",
        }


class InitializingMarketProvider(RecordingMarketProvider):
    def prepare_replay_cache(self):
        self.prepare_calls += 1
        return {
            "state": "running",
            "ready": False,
            "completed": 3,
            "total": 21,
            "message": "指数 000300.SH 已缓存",
            "error": "",
        }


class ReplayStoreStub:
    def source_data_version(self):
        return "tdx-version"

    def list_replay_benchmarks(self):
        return [{"code": "000001.SH"}]

    def create_replay_scenario(self, **_kwargs):
        return {
            "sourceDataVersion": "tdx-version",
            "tsCode": "600000.SH",
            "name": "浦发银行",
            "bars": [],
        }

    def source_instrument_name_map(self):
        return {"600000.XSHG": "浦发银行"}


class DailyHistoryCacheStub:
    def load_history(self, table_name, ts_code):
        return pd.DataFrame([
            {
                "datetime": "2026-08-04",
                "open": 10,
                "high": 11,
                "low": 9,
                "close": 10.5,
                "vol": 100,
                "amount": 1000,
                "table": table_name,
                "code": ts_code,
            }
        ])


class RecordingMinuteProvider:
    def __init__(self):
        self.calls = []

    def create_scenario(self, **kwargs):
        self.calls.append(kwargs)
        return {"interval": "hybrid", "sourceDataVersion": "minute-cache"}


class TdxRuntimeIntegrationTest(unittest.TestCase):
    def test_local_replay_cache_reports_tdx_source_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "market.duckdb"
            TdxMarketCache(path).ensure_schema()

            store = DuckDbBarStore(
                db_path=path,
                source_db_path=path,
                catalog_db_path=Path(directory) / "catalog.duckdb",
            )

            self.assertEqual(store.source_mode(), "tdx-cache")
            self.assertEqual(store.source_db_path_text(), str(path.resolve()))

    def test_replay_entry_points_prepare_tdx_cache_before_reading(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            provider = RecordingMarketProvider()
            service = EngineService(
                store=ReplayStoreStub(),
                runs_root=Path(directory) / "runs",
                market_data_provider=provider,
            )

            benchmarks = service.get_replay_benchmarks()
            scenario = service.create_replay_scenario(
                game_length=20,
                benchmark_code="000001.SH",
                seed=1,
            )

            self.assertEqual(benchmarks["items"], [{"code": "000001.SH"}])
            self.assertEqual(benchmarks["initialization"]["state"], "ready")
            self.assertEqual(scenario["sourceDataVersion"], "tdx-version")
            self.assertEqual(provider.prepare_calls, 1)
            self.assertEqual(provider.ensure_calls, 1)

    def test_replay_benchmarks_returns_initialization_progress_without_blocking(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            provider = InitializingMarketProvider()
            service = EngineService(
                store=ReplayStoreStub(),
                runs_root=Path(directory) / "runs",
                market_data_provider=provider,
            )

            benchmarks = service.get_replay_benchmarks()

            self.assertEqual(benchmarks["items"], [])
            self.assertEqual(benchmarks["initialization"]["completed"], 3)
            self.assertEqual(benchmarks["initialization"]["total"], 21)
            self.assertEqual(provider.ensure_calls, 0)

    def test_hybrid_replay_passes_local_daily_history_to_minute_provider(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            provider = RecordingMarketProvider()
            provider.cache = DailyHistoryCacheStub()
            minute_provider = RecordingMinuteProvider()
            service = EngineService(
                store=ReplayStoreStub(),
                runs_root=Path(directory) / "runs",
                market_data_provider=provider,
                minute_replay_provider=minute_provider,
            )

            scenario = service.create_replay_scenario(
                game_length=20,
                benchmark_code="000001.SH",
                seed=1,
                interval="hybrid",
            )

            call = minute_provider.calls[0]
            self.assertEqual(scenario["interval"], "hybrid")
            self.assertEqual(call["stock_daily_rows"][0]["code"], "600000.SH")
            self.assertEqual(call["benchmark_daily_rows"][0]["code"], "000001.SH")

    def test_instrument_search_uses_tdx_cached_names(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            provider = RecordingMarketProvider()
            service = EngineService(
                store=ReplayStoreStub(),
                runs_root=Path(directory) / "runs",
                market_data_provider=provider,
            )

            with patch("replay_engine.service._load_searchable_instruments", return_value=[]):
                result = service.search_instruments("浦发", limit=8)

            self.assertEqual(result["items"][0]["name"], "浦发银行")
            self.assertEqual(result["items"][0]["orderBookId"], "600000.XSHG")
            self.assertEqual(provider.ensure_calls, 1)


if __name__ == "__main__":
    unittest.main()
