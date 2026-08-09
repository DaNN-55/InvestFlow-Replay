from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from replay_engine.data_store import DuckDbBarStore
from replay_engine.service import ReplayMarketSupply
from replay_engine.tdx_market_cache import TdxMarketCache


class RecordingMarketProvider:
    def __init__(self) -> None:
        self.ensure_calls = 0
        self.prepare_calls = 0

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

    def ensure_unseen_stock_available(self, excluded_ts_codes, *, target_count):
        self.prefetch_call = (excluded_ts_codes, target_count)
        return True

    def load_hybrid_daily_history(self, ts_code, benchmark_code):
        def row(code):
            return {
                "datetime": "2026-08-04",
                "open": 10,
                "high": 11,
                "low": 9,
                "close": 10.5,
                "vol": 100,
                "amount": 1000,
                "code": code,
            }

        return {"stock": [row(ts_code)], "benchmark": [row(benchmark_code)]}


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


class RecordingMinuteProvider:
    def __init__(self):
        self.calls = []

    def create_scenario(self, **kwargs):
        self.calls.append(kwargs)
        return {"interval": "hybrid", "sourceDataVersion": "minute-cache"}


class CacheStatusMarketProvider(RecordingMarketProvider):
    def __init__(self, path: Path):
        super().__init__()
        self._snapshot = {
            "statistics": {
                "instrumentCount": 12,
                "lastSuccessAt": "2026-08-09T10:00:00",
            },
            "storageBytes": path.stat().st_size,
        }

    def cache_snapshot(self):
        return self._snapshot

    def replay_cache_status(self):
        return {"state": "ready", "ready": True, "message": "ready"}

    def pool_status(self):
        return {"state": "running", "completed": 2, "total": 4}


class CacheStatusMinuteProvider(RecordingMinuteProvider):
    def __init__(self, path: Path):
        super().__init__()
        self._snapshot = {
            "statistics": {"fiveMinuteBarCount": 2400},
            "storageBytes": path.stat().st_size,
        }

    def cache_snapshot(self):
        return self._snapshot


class TdxRuntimeIntegrationTest(unittest.TestCase):
    def test_supply_owns_cache_status_and_stock_reserve(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            market_path = root / "market.duckdb"
            minute_path = root / "minute.duckdb"
            market_path.write_bytes(b"market")
            minute_path.write_bytes(b"minute-bars")
            provider = CacheStatusMarketProvider(market_path)
            supply = ReplayMarketSupply(
                store=ReplayStoreStub(),
                market_data_provider=provider,
                minute_replay_provider=CacheStatusMinuteProvider(minute_path),
            )

            status = supply.cache_status()
            reserve = supply.prefetch_replay_stocks(
                ("600000.SH",), target_reserve=8
            )

            self.assertEqual(status["state"], "running")
            self.assertEqual(status["activeTask"], status["stockPool"])
            self.assertEqual(status["storage"]["marketBytes"], 6)
            self.assertEqual(status["storage"]["minuteBytes"], 11)
            self.assertEqual(status["lastSuccessAt"], "2026-08-09T10:00:00")
            self.assertEqual(reserve, {"available": True, "targetReserve": 8})
            self.assertEqual(provider.prefetch_call, (("600000.SH",), 8))

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
            supply = ReplayMarketSupply(
                store=ReplayStoreStub(),
                market_data_provider=provider,
            )

            benchmarks = supply.benchmarks()
            scenario = supply.create_scenario(
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
            supply = ReplayMarketSupply(
                store=ReplayStoreStub(),
                market_data_provider=provider,
            )

            benchmarks = supply.benchmarks()

            self.assertEqual(benchmarks["items"], [])
            self.assertEqual(benchmarks["initialization"]["completed"], 3)
            self.assertEqual(benchmarks["initialization"]["total"], 21)
            self.assertEqual(provider.ensure_calls, 0)

    def test_hybrid_replay_passes_local_daily_history_to_minute_provider(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            provider = RecordingMarketProvider()
            minute_provider = RecordingMinuteProvider()
            supply = ReplayMarketSupply(
                store=ReplayStoreStub(),
                market_data_provider=provider,
                minute_replay_provider=minute_provider,
            )

            scenario = supply.create_scenario(
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
            supply = ReplayMarketSupply(
                store=ReplayStoreStub(),
                market_data_provider=provider,
            )

            result = supply.search_instruments("浦发", limit=8)

            self.assertEqual(result["items"][0]["name"], "浦发银行")
            self.assertEqual(result["items"][0]["orderBookId"], "600000.XSHG")
            self.assertEqual(provider.ensure_calls, 1)


if __name__ == "__main__":
    unittest.main()
