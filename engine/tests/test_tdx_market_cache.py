from __future__ import annotations

import tempfile
import threading
import time
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import duckdb
import pandas as pd

from replay_engine.data_store import DuckDbBarStore
from replay_engine.tdx_market_cache import (
    TdxMarketDataProvider,
    TdxMarketCache,
    TdxMarketUnavailableError,
    build_index_history,
    build_stock_history,
)


class TdxMarketCacheTransformTest(unittest.TestCase):
    def test_builds_forward_factors_and_ex_right_reference_price(self) -> None:
        bars = pd.DataFrame(
            [
                {
                    "datetime": "2024-06-03",
                    "open": 20.0,
                    "high": 20.2,
                    "low": 19.8,
                    "close": 20.0,
                    "vol": 1000,
                    "amount": 20000,
                },
                {
                    "datetime": "2024-06-04",
                    "open": 10.0,
                    "high": 10.1,
                    "low": 9.9,
                    "close": 10.0,
                    "vol": 2000,
                    "amount": 20000,
                },
            ]
        )
        xdxr = pd.DataFrame(
            [
                {
                    "date": "2024-06-04",
                    "category": 1,
                    "fenhong": 0.0,
                    "peigujia": 0.0,
                    "songzhuangu": 1.0,
                    "peigu": 0.0,
                }
            ]
        )

        stock_rows, factor_rows = build_stock_history(
            "600000.SH",
            bars,
            xdxr,
            updated_at=datetime(2024, 6, 4, 16, 0),
        )

        self.assertEqual([row["trade_date"].isoformat() for row in stock_rows], ["2024-06-03", "2024-06-04"])
        self.assertAlmostEqual(factor_rows[0]["adj_factor"], 0.5)
        self.assertAlmostEqual(factor_rows[1]["adj_factor"], 1.0)
        self.assertAlmostEqual(stock_rows[1]["pre_close"], 10.0)
        self.assertAlmostEqual(stock_rows[1]["pct_chg"], 0.0)

    def test_index_history_derives_open_calendar_without_inventing_suspension_rows(self) -> None:
        bars = pd.DataFrame(
            [
                {
                    "datetime": "2024-01-02",
                    "open": 3000,
                    "high": 3010,
                    "low": 2990,
                    "close": 3005,
                    "vol": 100,
                    "amount": 1000,
                },
                {
                    "datetime": "2024-01-04",
                    "open": 3010,
                    "high": 3020,
                    "low": 3000,
                    "close": 3015,
                    "vol": 120,
                    "amount": 1200,
                },
            ]
        )

        index_rows, calendar_rows = build_index_history(
            "000001.SH",
            "SSE",
            bars,
            updated_at=datetime(2024, 1, 4, 16, 0),
        )

        self.assertEqual([row["trade_date"].isoformat() for row in index_rows], ["2024-01-02", "2024-01-04"])
        self.assertEqual([row["cal_date"].isoformat() for row in calendar_rows], ["2024-01-02", "2024-01-04"])
        self.assertIsNone(calendar_rows[0]["pretrade_date"])
        self.assertEqual(calendar_rows[1]["pretrade_date"].isoformat(), "2024-01-02")
        self.assertTrue(all(row["is_open"] == 1 for row in calendar_rows))


class TdxMarketCacheSchemaTest(unittest.TestCase):
    def test_empty_cache_creates_replay_tables_and_incremental_upsert_preserves_other_rows(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "market.duckdb"
            cache = TdxMarketCache(path)
            cache.ensure_schema()

            connection = duckdb.connect(str(path))
            try:
                tables = {
                    row[0]
                    for row in connection.execute(
                        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'"
                    ).fetchall()
                }
            finally:
                connection.close()

            self.assertTrue(
                {
                    "stock_daily_bars",
                    "stock_adj_factors",
                    "stock_instruments",
                    "index_daily_bars",
                    "trade_calendar",
                }.issubset(tables)
            )

            updated_at = datetime(2024, 1, 3, 16, 0)
            first_rows = [
                {
                    "ts_code": "600000.SH",
                    "trade_date": pd.Timestamp("2024-01-02").date(),
                    "open": 10.0,
                    "high": 10.2,
                    "low": 9.8,
                    "close": 10.1,
                    "pre_close": 10.0,
                    "change": 0.1,
                    "pct_chg": 1.0,
                    "vol": 1000.0,
                    "amount": 10000.0,
                    "updated_at": updated_at,
                }
            ]
            cache.upsert_stock_history(
                first_rows,
                [
                    {
                        "ts_code": "600000.SH",
                        "trade_date": pd.Timestamp("2024-01-02").date(),
                        "adj_factor": 1.0,
                        "updated_at": updated_at,
                    }
                ],
            )
            cache.upsert_stock_history(
                [{**first_rows[0], "ts_code": "000001.SZ"}],
                [
                    {
                        "ts_code": "000001.SZ",
                        "trade_date": pd.Timestamp("2024-01-02").date(),
                        "adj_factor": 1.0,
                        "updated_at": updated_at,
                    }
                ],
            )

            connection = duckdb.connect(str(path), read_only=True)
            try:
                codes = connection.execute(
                    "SELECT DISTINCT ts_code FROM stock_daily_bars ORDER BY ts_code"
                ).fetchall()
            finally:
                connection.close()
            self.assertEqual(codes, [("000001.SZ",), ("600000.SH",)])

    def test_secondary_benchmark_update_does_not_replace_canonical_calendar(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache = TdxMarketCache(Path(directory) / "market.duckdb")
            updated_at = datetime(2024, 1, 4, 16, 0)
            canonical_rows, calendar_rows = build_index_history(
                "000001.SH",
                "SSE",
                make_daily_frame("2024-01-02", 3, 3000),
                updated_at=updated_at,
            )
            secondary_rows, _ = build_index_history(
                "000300.SH",
                "SSE",
                make_daily_frame("2024-01-03", 2, 3500),
                updated_at=updated_at,
            )
            cache.replace_index_history("000001.SH", "SSE", canonical_rows, calendar_rows)

            cache.replace_index_history("000300.SH", "SSE", secondary_rows, None)

            connection = duckdb.connect(str(cache.path), read_only=True)
            try:
                dates = connection.execute(
                    "SELECT cal_date FROM trade_calendar WHERE exchange = 'SSE' ORDER BY cal_date"
                ).fetchall()
            finally:
                connection.close()
            self.assertEqual(len(dates), 3)


class FakeTdxClient:
    def __init__(self, bars_by_code: dict[str, pd.DataFrame]) -> None:
        self.bars_by_code = bars_by_code
        self.security_bar_starts: list[tuple[str, int]] = []

    def get_security_list(self, market, start):
        if start:
            return pd.DataFrame()
        suffix = "SH" if int(market) == 1 else "SZ"
        rows = [
            {"code": code, "name": name}
            for code, name in (
                (("600000", "浦发银行"),) if suffix == "SH" else (("000001", "平安银行"),)
            )
        ]
        return pd.DataFrame(rows)

    def get_security_bars(self, market, code, category, start, count, **_kwargs):
        self.security_bar_starts.append((code, start))
        frame = self.bars_by_code[code]
        newest_first = frame.sort_values("datetime", ascending=False).reset_index(drop=True)
        return newest_first.iloc[start : start + count].sort_values("datetime").reset_index(drop=True)

    def get_index_bars(self, market, code, category, start, count, **_kwargs):
        frame = self.bars_by_code[code]
        newest_first = frame.sort_values("datetime", ascending=False).reset_index(drop=True)
        return newest_first.iloc[start : start + count].sort_values("datetime").reset_index(drop=True)

    def get_xdxr_info(self, market, code):
        return pd.DataFrame()


class ContextFakeTdxClient(FakeTdxClient):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None


class HostAwareContextClient(ContextFakeTdxClient):
    def __init__(self, host, bars_by_code, index_calls):
        super().__init__(bars_by_code)
        self.host = host
        self.index_calls = index_calls

    def get_index_bars(self, market, code, category, start, count, **kwargs):
        self.index_calls.append((code, self.host, start))
        if self.host == "host-a" and code == "399001":
            raise OSError("host-a index timeout")
        return super().get_index_bars(market, code, category, start, count, **kwargs)


class BlockingBackfillClient(FakeTdxClient):
    def __init__(self, bars_by_code):
        super().__init__(bars_by_code)
        self.backfill_started = threading.Event()
        self.release_backfill = threading.Event()

    def _wait_for_backfill(self, start):
        if start >= 800:
            self.backfill_started.set()
            self.release_backfill.wait(timeout=5)

    def get_security_bars(self, market, code, category, start, count, **kwargs):
        self._wait_for_backfill(start)
        return super().get_security_bars(market, code, category, start, count, **kwargs)

    def get_index_bars(self, market, code, category, start, count, **kwargs):
        self._wait_for_backfill(start)
        return super().get_index_bars(market, code, category, start, count, **kwargs)


def make_daily_frame(start: str, count: int, base: float) -> pd.DataFrame:
    dates = pd.bdate_range(start, periods=count)
    return pd.DataFrame(
        [
            {
                "datetime": trade_date,
                "open": base + index,
                "high": base + index + 1,
                "low": base + index - 1,
                "close": base + index + 0.5,
                "vol": 1000 + index,
                "amount": 10000 + index,
            }
            for index, trade_date in enumerate(dates)
        ]
    )


class TdxMarketDataProviderTest(unittest.TestCase):
    def test_bootstrap_cache_becomes_ready_before_full_history_backfill_finishes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            cache = TdxMarketCache(Path(directory) / "market.duckdb")
            client = BlockingBackfillClient(
                {
                    "600000": make_daily_frame("2020-01-02", 900, 10),
                    "000001": make_daily_frame("2020-01-02", 900, 3000),
                    "399001": make_daily_frame("2020-01-02", 900, 9000),
                }
            )
            provider = TdxMarketDataProvider(
                cache,
                initial_stock_count=1,
                minimum_replay_bars=3,
                benchmark_codes=("000001.SH", "399001.SZ"),
            )
            failure = []

            def run_sync():
                try:
                    provider.sync_with_client(client)
                except Exception as exc:  # pragma: no cover - surfaced by assertion
                    failure.append(exc)

            thread = threading.Thread(target=run_sync)
            provider._sync_thread = thread
            thread.start()
            self.assertTrue(client.backfill_started.wait(timeout=10))
            try:
                self.assertTrue(
                    cache.is_replay_ready(("000001.SH", "399001.SZ"), 3)
                )
                result = provider.ensure_ready()
                self.assertEqual(result["mode"], "cache")
                self.assertIn("后台", result["message"])
            finally:
                client.release_backfill.set()
                thread.join(timeout=10)
            self.assertFalse(failure)

    def test_prepare_cache_returns_running_status_and_deduplicates_background_sync(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            provider = TdxMarketDataProvider(
                TdxMarketCache(Path(directory) / "market.duckdb"),
                minimum_replay_bars=3,
                benchmark_codes=("000001.SH",),
            )
            started = threading.Event()
            release = threading.Event()
            calls = []

            def blocking_ensure_ready(**_kwargs):
                calls.append("sync")
                started.set()
                release.wait(timeout=5)
                return {"mode": "tdx", "message": "done"}

            provider.ensure_ready = blocking_ensure_ready

            first = provider.prepare_replay_cache()
            self.assertTrue(started.wait(timeout=1))
            second = provider.prepare_replay_cache()

            self.assertEqual(first["state"], "running")
            self.assertEqual(second["state"], "running")
            self.assertEqual(calls, ["sync"])

            release.set()
            for _ in range(50):
                status = provider.replay_cache_status()
                if status["state"] == "ready":
                    break
                time.sleep(0.01)
            self.assertEqual(status["state"], "ready")

    def test_failed_benchmark_switches_host_without_restarting_successful_benchmarks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            bars_by_code = {
                "600000": make_daily_frame("2024-01-02", 3, 10),
                "000001": make_daily_frame("2024-01-02", 3, 3000),
                "399001": make_daily_frame("2024-01-02", 3, 9000),
            }
            index_calls = []

            def factory(*, host, **_kwargs):
                return HostAwareContextClient(host, bars_by_code, index_calls)

            provider = TdxMarketDataProvider(
                TdxMarketCache(Path(directory) / "market.duckdb"),
                hosts=("host-a", "host-b"),
                client_factory=factory,
                initial_stock_count=1,
                minimum_replay_bars=3,
                benchmark_codes=("000001.SH", "399001.SZ"),
            )

            result = provider.ensure_ready(force_refresh=True)

            self.assertEqual(result["mode"], "tdx")
            first_page_hosts = [
                host
                for code, host, start in index_calls
                if code == "000001" and start == 0
            ]
            self.assertEqual(set(first_page_hosts), {"host-a"})
            self.assertIn(("399001", "host-a", 0), index_calls)
            self.assertIn(("399001", "host-b", 0), index_calls)

    def test_default_connection_uses_easy_tdx_hosts_and_reconnects(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            captured = {}

            def factory(**kwargs):
                captured.update(kwargs)
                return ContextFakeTdxClient({})

            provider = TdxMarketDataProvider(
                TdxMarketCache(Path(directory) / "market.duckdb"),
                hosts=None,
                client_factory=factory,
            )
            with patch("easy_tdx.config.get_known_hosts", return_value=["dynamic-host"]):
                result = provider.ensure_instruments()

            self.assertEqual(result["mode"], "tdx")
            self.assertEqual(captured["host"], "dynamic-host")
            self.assertTrue(captured["auto_reconnect"])

    def test_initializes_names_stock_history_benchmarks_and_calendars(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "market.duckdb"
            client = FakeTdxClient(
                {
                    "600000": make_daily_frame("2024-01-02", 3, 10),
                    "000001": make_daily_frame("2024-01-02", 3, 3000),
                    "399001": make_daily_frame("2024-01-02", 3, 9000),
                }
            )
            provider = TdxMarketDataProvider(
                TdxMarketCache(path),
                initial_stock_count=1,
                minimum_replay_bars=3,
                benchmark_codes=("000001.SH", "399001.SZ"),
            )

            result = provider.sync_with_client(client)

            self.assertEqual(result["stockCount"], 1)
            connection = duckdb.connect(str(path), read_only=True)
            try:
                instrument = connection.execute(
                    "SELECT name, list_date FROM stock_instruments WHERE ts_code = '600000.SH'"
                ).fetchone()
                index_codes = connection.execute(
                    "SELECT DISTINCT ts_code FROM index_daily_bars ORDER BY ts_code"
                ).fetchall()
                calendar_counts = dict(
                    connection.execute(
                        "SELECT exchange, COUNT(*) FROM trade_calendar GROUP BY exchange"
                    ).fetchall()
                )
            finally:
                connection.close()
            self.assertEqual(instrument, ("浦发银行", pd.Timestamp("2024-01-02").date()))
            self.assertEqual(index_codes, [("000001.SH",), ("399001.SZ",)])
            self.assertEqual(calendar_counts, {"SSE": 3, "SZSE": 3})

            store = DuckDbBarStore(
                db_path=path,
                source_db_path=path,
                catalog_db_path=Path(directory) / "catalog.duckdb",
            )
            catalog = store.query_instrument_catalog(
                page=1,
                page_size=20,
                keyword="浦发",
                adjust="qfq",
            )
            self.assertEqual(catalog["meta"]["total"], 1)
            self.assertEqual(catalog["items"][0]["name"], "浦发银行")

    def test_incremental_sync_stops_after_page_overlaps_cached_history(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "market.duckdb"
            initial_client = FakeTdxClient(
                {
                    "600000": make_daily_frame("2020-01-02", 900, 10),
                    "000001": make_daily_frame("2020-01-02", 900, 3000),
                    "399001": make_daily_frame("2020-01-02", 900, 9000),
                }
            )
            provider = TdxMarketDataProvider(
                TdxMarketCache(path),
                initial_stock_count=1,
                minimum_replay_bars=3,
                benchmark_codes=("000001.SH", "399001.SZ"),
            )
            provider.sync_with_client(initial_client)
            updated_client = FakeTdxClient(
                {
                    "600000": make_daily_frame("2020-01-02", 901, 10),
                    "000001": make_daily_frame("2020-01-02", 901, 3000),
                    "399001": make_daily_frame("2020-01-02", 901, 9000),
                }
            )

            provider.sync_with_client(updated_client)

            stock_starts = [start for code, start in updated_client.security_bar_starts if code == "600000"]
            self.assertEqual(stock_starts, [0])
            connection = duckdb.connect(str(path), read_only=True)
            try:
                count = connection.execute(
                    "SELECT COUNT(*) FROM stock_daily_bars WHERE ts_code = '600000.SH'"
                ).fetchone()[0]
            finally:
                connection.close()
            self.assertEqual(count, 901)

    def test_offline_uses_complete_cache_but_empty_cache_reports_clear_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            ready_path = Path(directory) / "ready.duckdb"
            ready_provider = TdxMarketDataProvider(
                TdxMarketCache(ready_path),
                initial_stock_count=1,
                minimum_replay_bars=3,
                benchmark_codes=("000001.SH", "399001.SZ"),
            )
            ready_provider.sync_with_client(
                FakeTdxClient(
                    {
                        "600000": make_daily_frame("2024-01-02", 3, 10),
                        "000001": make_daily_frame("2024-01-02", 3, 3000),
                        "399001": make_daily_frame("2024-01-02", 3, 9000),
                    }
                )
            )
            ready_provider.client_factory = lambda **_kwargs: (_ for _ in ()).throw(OSError("network down"))

            cached = ready_provider.ensure_ready(force_refresh=True)

            self.assertEqual(cached["mode"], "cache")
            self.assertIn("network down", cached["message"])

            empty_provider = TdxMarketDataProvider(
                TdxMarketCache(Path(directory) / "empty.duckdb"),
                minimum_replay_bars=3,
                client_factory=lambda **_kwargs: (_ for _ in ()).throw(OSError("network down")),
            )
            with self.assertRaisesRegex(
                TdxMarketUnavailableError,
                "本地缓存不足.*network down",
            ):
                empty_provider.ensure_ready(force_refresh=True)


if __name__ == "__main__":
    unittest.main()
