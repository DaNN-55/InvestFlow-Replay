from __future__ import annotations

from datetime import date, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import duckdb
import pandas as pd

from replay_engine.minute_replay import MinuteReplayStore, TDX_PAGE_SIZE, TdxMinuteReplayProvider
from replay_engine.replay_cache_coverage import cache_coverage
from replay_engine.replay_cache_policy import (
    BOARDS,
    board_for_code,
    latest_completed_date,
    maintenance_key,
    reserve_targets,
)
from replay_engine.service import ReplayMarketSupply
from replay_engine.tdx_market_cache import (
    TdxMarketCache,
    TdxMarketDataProvider,
    build_index_history,
    build_stock_history,
)


def daily_frame(start: str = "2024-01-02", count: int = 4, base: float = 10) -> pd.DataFrame:
    return pd.DataFrame([
        {
            "datetime": day,
            "open": base + index,
            "high": base + index + 1,
            "low": base + index - 1,
            "close": base + index + 0.5,
            "vol": 1000 + index,
            "amount": 10000 + index,
        }
        for index, day in enumerate(pd.bdate_range(start, periods=count))
    ])


def seed_stock(cache: TdxMarketCache, code: str, *, base: float = 10) -> None:
    updated = datetime(2024, 1, 10, 16)
    rows, factors = build_stock_history(code, daily_frame(base=base), pd.DataFrame(), updated_at=updated)
    cache.upsert_stock_history(rows, factors)
    symbol, suffix = code.split(".")
    market = "科创板" if symbol.startswith("688") else "创业板" if symbol.startswith(("300", "301")) else "主板"
    cache.upsert_instruments([{
        "ts_code": code, "symbol": symbol, "name": code, "industry": None, "area": None,
        "market": market, "list_status": "L", "list_date": rows[0]["trade_date"],
        "delist_date": None, "updated_at": updated,
    }])


class TestSampleMaintenancePolicy:
    def test_board_mapping_and_even_reserve(self):
        assert board_for_code("600000.SH") == "main"
        assert board_for_code("300001.SZ") == "chinext"
        assert board_for_code("688001.SH") == "star"
        assert board_for_code("430001.BJ") is None
        assert reserve_targets(12) == {"main": 4, "chinext": 4, "star": 4}
        assert reserve_targets(3) == {"main": 1, "chinext": 1, "star": 1}

    def test_completion_date_waits_for_beijing_close_grace(self):
        dates = [date(2026, 10, 19), date(2026, 10, 20)]
        assert latest_completed_date(dates, datetime(2026, 10, 20, 15, 9)) == date(2026, 10, 19)
        assert latest_completed_date(dates, datetime(2026, 10, 20, 15, 10)) == date(2026, 10, 20)
        assert maintenance_key(datetime(2026, 10, 20, 15, 9)).endswith(":open")
        assert maintenance_key(datetime(2026, 10, 20, 15, 10)).endswith(":closed")


class TestSampleCoverage:
    def test_coverage_reports_each_board_dates_failures_and_unseen_reserve(self):
        daily = [
            {"code": "600000.SH", "board": "main", "barCount": 400, "eligible": True, "latestDate": "2026-10-20", "error": ""},
            {"code": "300001.SZ", "board": "chinext", "barCount": 20, "eligible": False, "latestDate": "2026-10-19", "error": ""},
            {"code": "688001.SH", "board": "star", "barCount": 0, "eligible": False, "latestDate": None, "error": "下载失败"},
        ]
        minute = [
            {"code": "000001.SH", "kind": "index-5m", "barCount": 100, "full": True, "latestTime": datetime(2026, 10, 20, 14, 55), "error": ""},
            {"code": "600000.SH", "kind": "stock-5m", "barCount": 100, "full": True, "latestTime": datetime(2026, 10, 20, 14, 55), "error": ""},
            {"code": "300001.SZ", "kind": "stock-5m", "barCount": 100, "full": True, "latestTime": datetime(2026, 10, 19, 14, 55), "error": ""},
            {"code": "688001.SH", "kind": "stock-5m", "barCount": 0, "full": False, "latestTime": None, "error": "timeout"},
        ]
        result = cache_coverage(
            daily, minute, excluded=("600000.SH",), target_date=date(2026, 10, 20), minimum_bars=370
        )
        boards = {item["key"]: item for item in result["boards"]}
        assert result["benchmarkCurrent"] is True
        assert boards["main"]["daily"]["unseenCount"] == 0
        assert boards["chinext"]["fiveMinute"]["staleCount"] == 1
        assert boards["star"]["daily"]["failedCount"] == 1
        assert boards["star"]["fiveMinute"]["failedCount"] == 1
        assert boards["main"]["fiveMinute"]["earliestDataDate"] == "2026-10-20"


class TestSampleDailyMaintenance:
    def test_stock_quality_cache_is_invalidated_when_same_timestamp_history_is_revised(self):
        with TemporaryDirectory() as directory:
            cache = TdxMarketCache(Path(directory) / "market.duckdb")
            updated = datetime(2024, 1, 5, 16)
            index_rows, calendar = build_index_history(
                "000001.SH", "SSE", daily_frame(count=4, base=3000), updated_at=updated
            )
            cache.replace_index_history("000001.SH", "SSE", index_rows, calendar)
            stock_rows, factors = build_stock_history(
                "600000.SH", daily_frame(count=4), pd.DataFrame(), updated_at=updated
            )
            cache.upsert_stock_history(stock_rows, factors)
            cache.upsert_instruments([{
                "ts_code": "600000.SH", "symbol": "600000", "name": "浦发银行", "industry": None,
                "area": None, "market": "主板", "list_status": "L", "list_date": date(2024, 1, 2),
                "delist_date": None, "updated_at": updated,
            }])
            before = next(item for item in cache.sample_inventory(3) if item["code"] == "600000.SH")
            assert before["eligible"] is True

            revised = [dict(row) for row in stock_rows]
            revised[1]["vol"] = -1
            cache.upsert_stock_history(revised, factors)
            after = next(item for item in cache.sample_inventory(3) if item["code"] == "600000.SH")
            assert after["eligible"] is False
            assert after["continuousBars"] == 2

    def test_stock_with_oldest_upstream_page_is_recorded_as_stale_failure(self):
        with TemporaryDirectory() as directory:
            cache = TdxMarketCache(Path(directory) / "market.duckdb")
            benchmark, calendar = build_index_history(
                "000001.SH", "SSE", daily_frame(count=4, base=3000), updated_at=datetime(2024, 1, 5, 16)
            )
            cache.replace_index_history("000001.SH", "SSE", benchmark, calendar)
            provider = TdxMarketDataProvider(
                cache, minimum_replay_bars=3, benchmark_codes=("000001.SH",),
                now=lambda: datetime(2024, 1, 5, 16),
            )

            class OldClient:
                def get_security_bars(self, *_args, **_kwargs):
                    return daily_frame(count=3, base=10)

                def get_xdxr_info(self, *_args, **_kwargs):
                    return pd.DataFrame()

            metadata = {
                "ts_code": "600000.SH", "symbol": "600000", "name": "浦发银行", "market": "主板",
                "list_status": "L", "list_date": date(2024, 1, 2),
            }
            try:
                provider._sync_stock(OldClient(), "600000.SH", metadata, datetime(2024, 1, 5, 16))
            except ValueError as exc:
                assert "尚未覆盖" in str(exc)
            else:
                raise AssertionError("旧日线不应被标记为成功")
            item = next(item for item in cache.sample_inventory(3) if item["code"] == "600000.SH")
            assert item["barCount"] == 3
            assert item["lastSuccessAt"] is None
            assert "尚未覆盖" in item["error"]

    def test_sync_updates_all_cached_stocks_beyond_daily_batch_and_continues_after_failure(self):
        with TemporaryDirectory() as directory:
            cache = TdxMarketCache(Path(directory) / "market.duckdb")
            for index, code in enumerate(
                ["600000.SH", "600001.SH", "600002.SH", "600003.SH", "600004.SH", "600005.SH",
                 "000001.SZ", "000002.SZ", "000003.SZ", "300001.SZ", "300002.SZ", "688001.SH", "688002.SH"]
            ):
                seed_stock(cache, code, base=10 + index)
            benchmark, calendar = build_index_history(
                "000001.SH", "SSE", daily_frame(base=3000), updated_at=datetime(2024, 1, 10, 16)
            )
            cache.replace_index_history("000001.SH", "SSE", benchmark, calendar)
            provider = TdxMarketDataProvider(
                cache, initial_stock_count=1, minimum_replay_bars=3, benchmark_codes=("000001.SH",),
                now=lambda: datetime(2026, 10, 20, 16),
            )
            instruments = cache.sample_inventory(3)
            metadata = [{
                "ts_code": item["code"], "symbol": item["code"].split(".")[0], "name": item["code"],
                "industry": None, "area": None, "market": "主板", "list_status": "L",
                "list_date": date(2024, 1, 2), "delist_date": None, "updated_at": datetime(2026, 10, 20, 16),
            } for item in instruments]
            calls = []

            def sync(_client, code, _metadata, _timestamp):
                calls.append(code)
                if code == "600005.SH":
                    raise OSError("one stock failed")

            with patch.object(provider, "_fetch_instruments", return_value=metadata), patch.object(
                provider, "_fetch_daily_pages", return_value=daily_frame(base=3000)
            ), patch.object(provider, "_sync_stock", side_effect=sync):
                result = provider.sync_with_client(object())
            assert len(calls) == 13
            assert calls[-1] == "688002.SH"
            assert result["state"] == "partial"
            assert "失败" in result["error"]

    def test_failed_stock_resource_is_visible_without_bars_and_can_be_retried(self):
        with TemporaryDirectory() as directory:
            cache = TdxMarketCache(Path(directory) / "market.duckdb")
            provider = TdxMarketDataProvider(cache, minimum_replay_bars=3, now=lambda: datetime(2026, 10, 20, 16))
            metadata = {"ts_code": "300001.SZ", "symbol": "300001", "name": "创业板样本", "market": "创业板", "list_status": "L"}

            class BrokenClient:
                def get_security_bars(self, *_args, **_kwargs):
                    raise OSError("temporary timeout")

            try:
                provider._sync_stock(BrokenClient(), "300001.SZ", metadata, datetime(2026, 10, 20, 16))
            except OSError:
                pass
            item = next(item for item in cache.sample_inventory(3) if item["code"] == "300001.SZ")
            assert item["barCount"] == 0
            assert item["eligible"] is False
            assert item["error"] == "temporary timeout"


class TestSampleMinuteMaintenance:
    def test_incremental_refresh_resumes_persisted_boundary_after_restart(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "minute.duckdb"
            old_anchor = {
                "datetime": datetime(2026, 10, 19, 14, 55),
                "open": 10, "high": 11, "low": 9, "close": 10, "vol": 1, "amount": 1,
            }
            first_page = [
                {
                    "datetime": datetime(2026, 10, 20, 9, 35) + timedelta(minutes=5 * index),
                    "open": 11, "high": 12, "low": 10, "close": 11, "vol": 1, "amount": 1,
                }
                for index in range(TDX_PAGE_SIZE)
            ]
            bridge_page = [old_anchor] + [
                {
                    "datetime": datetime(2026, 10, 19, 14, 50) - timedelta(minutes=5 * index),
                    "open": 9, "high": 10, "low": 8, "close": 9, "vol": 1, "amount": 1,
                }
                for index in range(TDX_PAGE_SIZE - 1)
            ]

            store = MinuteReplayStore(path)
            store.save("600000.SH", "stock-5m", [old_anchor])
            store.mark_full_history("600000.SH", "stock-5m")

            class Client:
                def __init__(self, *, fail_bridge):
                    self.fail_bridge = fail_bridge
                    self.starts = []

                def get_security_bars(self, *args, **_kwargs):
                    start = int(args[3])
                    self.starts.append(start)
                    if start == 0:
                        return pd.DataFrame(first_page)
                    if self.fail_bridge:
                        raise OSError("断点页暂时失败")
                    return pd.DataFrame(bridge_page)

            from replay_engine.tdx_api import KlineCategory

            first_client = Client(fail_bridge=True)
            first_provider = TdxMinuteReplayProvider(path)
            try:
                first_provider._fetch(
                    first_client, "600000.SH", "stock-5m", category=KlineCategory.MIN_5,
                    maximum_bars=TDX_PAGE_SIZE * 2, incremental=True,
                )
            except ValueError as exc:
                assert "中断" in str(exc)
            else:
                raise AssertionError("第一页之后中断应保留 partial 状态")
            assert first_client.starts == [0, TDX_PAGE_SIZE]
            partial = next(item for item in first_provider.store.history_inventory() if item["code"] == "600000.SH")
            assert partial["error"] == "分钟行情下载中断，已保存部分缓存"
            assert partial["barCount"] == TDX_PAGE_SIZE + 1
            with duckdb.connect(str(path), read_only=True) as connection:
                resume_from = connection.execute(
                    "SELECT resume_from FROM minute_refresh_state WHERE instrument_code = '600000.SH' AND instrument_type = 'stock-5m'"
                ).fetchone()[0]
            assert resume_from == old_anchor["datetime"]

            second_client = Client(fail_bridge=False)
            restarted_provider = TdxMinuteReplayProvider(path)
            rows = restarted_provider._fetch(
                second_client, "600000.SH", "stock-5m", category=KlineCategory.MIN_5,
                maximum_bars=TDX_PAGE_SIZE * 2, incremental=True,
            )
            assert second_client.starts == [0, TDX_PAGE_SIZE]
            assert len(rows) == TDX_PAGE_SIZE * 2
            current = next(item for item in restarted_provider.store.history_inventory() if item["code"] == "600000.SH")
            assert current["full"] is True
            assert current["error"] == ""
            assert restarted_provider.store.history_current("600000.SH", "stock-5m") is True
            with duckdb.connect(str(path), read_only=True) as connection:
                resume_from = connection.execute(
                    "SELECT resume_from FROM minute_refresh_state WHERE instrument_code = '600000.SH' AND instrument_type = 'stock-5m'"
                ).fetchone()[0]
            assert resume_from is None

    def test_full_marker_does_not_make_old_history_current(self):
        with TemporaryDirectory() as directory:
            store = MinuteReplayStore(Path(directory) / "minute.duckdb")
            row = {"datetime": datetime(2026, 10, 19, 14, 55), "open": 10, "high": 11, "low": 9, "close": 10, "vol": 1, "amount": 1}
            store.save("600000.SH", "stock-5m", [row])
            store.mark_full_history("600000.SH", "stock-5m")
            assert store.has_full_history("600000.SH", "stock-5m")
            assert store.history_current("600000.SH", "stock-5m", date(2026, 10, 20)) is False

    def test_incremental_failure_preserves_rows_and_records_error(self):
        with TemporaryDirectory() as directory:
            provider = TdxMinuteReplayProvider(Path(directory) / "minute.duckdb")
            old = {"datetime": datetime(2026, 10, 19, 14, 55), "open": 10, "high": 11, "low": 9, "close": 10, "vol": 1, "amount": 1}
            provider.store.save("600000.SH", "stock-5m", [old])
            provider.store.mark_full_history("600000.SH", "stock-5m")

            class Client:
                def get_security_bars(self, *args, **_kwargs):
                    start = int(args[3]) if len(args) > 3 else 0
                    if start:
                        raise OSError("second page timeout")
                    return pd.DataFrame([
                        {
                            "datetime": datetime(2026, 10, 20, 9, 35) + timedelta(minutes=5 * index),
                            "open": 11, "high": 12, "low": 10, "close": 11, "vol": 1, "amount": 1,
                        }
                        for index in range(TDX_PAGE_SIZE)
                    ])

            from replay_engine.tdx_api import KlineCategory
            try:
                provider._fetch(Client(), "600000.SH", "stock-5m", category=KlineCategory.MIN_5,
                    maximum_bars=TDX_PAGE_SIZE * 2, incremental=True)
            except ValueError as exc:
                assert "中断" in str(exc)
            rows = provider.store.load("600000.SH", "stock-5m")
            inventory = next(item for item in provider.store.history_inventory() if item["code"] == "600000.SH")
            assert len(rows) == TDX_PAGE_SIZE + 1
            assert inventory["full"] is True
            assert inventory["error"] == "分钟行情下载中断，已保存部分缓存"


class TestMaintenanceScheduling:
    def test_maintenance_runs_once_per_phase_then_retries_after_cooldown(self):
        class Market:
            minimum_replay_bars = 3

            def __init__(self):
                self.clock = datetime(2026, 10, 20, 15, 0)

            def now(self):
                return self.clock

            def prepare_replay_cache(self, **_kwargs):
                return {"state": "ready", "ready": True}

            def background_retry_due(self):
                return False

            def completed_trade_date(self):
                return date(2026, 10, 19)

            def pool_status(self):
                return {"state": "idle"}

        class Minute:
            required_trade_date = None

            def __init__(self):
                self.calls = 0

            def refresh_cached(self):
                self.calls += 1
                return {"state": "partial" if self.calls == 1 else "ready", "message": "refresh", "error": "temporary" if self.calls == 1 else ""}

        market, minute = Market(), Minute()
        supply = ReplayMarketSupply(store=object(), market_data_provider=market, minute_replay_provider=minute)
        assert supply.maintain_once()["state"] == "partial"
        assert supply.maintain_once()["state"] == "partial"
        assert minute.calls == 1
        market.clock = datetime(2026, 10, 20, 15, 4)
        assert supply.maintain_once()["state"] == "partial"
        assert minute.calls == 1
        market.clock = datetime(2026, 10, 20, 15, 5)
        assert supply.maintain_once()["state"] == "ready"
        assert minute.calls == 2
        market.clock = datetime(2026, 10, 20, 15, 10)
        assert supply.maintain_once()["state"] == "ready"
        assert minute.calls == 3
        market.clock = datetime(2026, 10, 20, 15, 15)
        assert supply.maintain_once()["state"] == "ready"
        assert minute.calls == 3
        market.clock = datetime(2026, 10, 20, 15, 15) + timedelta(days=1)
        assert supply.maintain_once()["state"] == "ready"
        assert minute.calls == 4
