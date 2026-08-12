from __future__ import annotations

import unittest
import duckdb
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from replay_engine.minute_replay import (
    MinuteReplayStore,
    TDX_HOSTS,
    TdxMinuteReplayProvider,
    build_hybrid_replay_scenario,
    build_minute_replay_scenario,
)


class MinuteReplayScenarioTest(unittest.TestCase):
    def test_uses_complete_one_minute_cache_when_tdx_is_unavailable(self):
        with TemporaryDirectory() as directory:
            provider = TdxMinuteReplayProvider(Path(directory) / "minute.duckdb")
            start = datetime(2026, 7, 30, 9, 31)
            rows = [
                {
                    "datetime": start + timedelta(minutes=index),
                    "open": 10 + index / 100,
                    "high": 10.2 + index / 100,
                    "low": 9.8 + index / 100,
                    "close": 10.1 + index / 100,
                    "vol": 1000 + index,
                    "amount": 10000 + index,
                }
                for index in range(255)
            ]
            provider.store.save("600000.SH", "stock", rows)
            provider.store.save("000001.SH", "index", rows)

            with patch("easy_tdx.client.TdxClient", side_effect=OSError("network down")):
                scenario = provider.create_scenario(
                    ts_code="600000.SH",
                    name="浦发银行",
                    benchmark_code="000001.SH",
                    game_length=5,
                    seed=7,
                )

            self.assertEqual(scenario["interval"], "1m")
            self.assertIn("tdx-minute-cache", scenario["sourceDataVersion"])

    def test_uses_complete_five_minute_cache_without_connecting_to_tdx(self):
        with TemporaryDirectory() as directory:
            provider = TdxMinuteReplayProvider(Path(directory) / "minute.duckdb")
            daily_start = datetime(2025, 1, 1)
            daily_rows = [
                {
                    "datetime": daily_start + timedelta(days=index),
                    "open": 10 + index / 100,
                    "high": 10.2 + index / 100,
                    "low": 9.8 + index / 100,
                    "close": 10.1 + index / 100,
                    "vol": 1000 + index,
                    "amount": 10000 + index,
                }
                for index in range(250)
            ]
            minute_start = datetime(2026, 7, 30, 9, 35)
            minute_rows = [
                {
                    "datetime": minute_start + timedelta(minutes=index * 5),
                    "open": 20 + index / 100,
                    "high": 20.2 + index / 100,
                    "low": 19.8 + index / 100,
                    "close": 20.1 + index / 100,
                    "vol": 2000 + index,
                    "amount": 20000 + index,
                }
                for index in range(48)
            ]
            provider.store.save("600000.SH", "stock-day", daily_rows)
            provider.store.save("000001.SH", "index-day", daily_rows)
            provider.store.save("600000.SH", "stock-5m", minute_rows)
            provider.store.save("000001.SH", "index-5m", minute_rows)
            provider.store.mark_full_history("600000.SH", "stock-5m")
            provider.store.mark_full_history("000001.SH", "index-5m")

            with patch(
                "easy_tdx.client.TdxClient",
                side_effect=OSError("network must not be used"),
            ) as client_class:
                scenario = provider.create_scenario(
                    ts_code="600000.SH",
                    name="浦发银行",
                    benchmark_code="000001.SH",
                    game_length=1,
                    seed=7,
                    hybrid=True,
                )

            self.assertEqual(scenario["interval"], "hybrid")
            self.assertIn("tdx-hybrid-cache", scenario["sourceDataVersion"])
            client_class.assert_not_called()

    def test_hybrid_download_is_bounded_and_reuses_cached_index_and_daily_rows(self):
        with TemporaryDirectory() as directory:
            provider = TdxMinuteReplayProvider(Path(directory) / "minute.duckdb")
            daily_start = datetime(2025, 1, 1)
            daily_rows = [
                {
                    "datetime": daily_start + timedelta(days=index),
                    "open": 10 + index / 100,
                    "high": 10.2 + index / 100,
                    "low": 9.8 + index / 100,
                    "close": 10.1 + index / 100,
                    "vol": 1000 + index,
                    "amount": 10000 + index,
                }
                for index in range(250)
            ]
            minute_start = datetime(2026, 7, 1, 9, 35)
            minute_rows = [
                {
                    "datetime": minute_start
                    + timedelta(days=day_offset, minutes=minute_offset * 5),
                    "open": 20 + day_offset + minute_offset / 100,
                    "high": 20.2 + day_offset + minute_offset / 100,
                    "low": 19.8 + day_offset + minute_offset / 100,
                    "close": 20.1 + day_offset + minute_offset / 100,
                    "vol": 2000 + minute_offset,
                    "amount": 20000 + minute_offset,
                }
                for day_offset in range(20)
                for minute_offset in range(48)
            ]
            provider.store.save("000001.SH", "index-5m", minute_rows)
            provider.store.mark_full_history("000001.SH", "index-5m")

            with (
                patch("easy_tdx.client.TdxClient"),
                patch.object(provider, "_fetch", return_value=minute_rows) as fetch,
            ):
                scenario = provider.create_scenario(
                    ts_code="600000.SH",
                    name="浦发银行",
                    benchmark_code="000001.SH",
                    game_length=20,
                    seed=7,
                    hybrid=True,
                    stock_daily_rows=daily_rows,
                    benchmark_daily_rows=daily_rows,
                )

            self.assertEqual(scenario["interval"], "hybrid")
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(fetch.call_args.args[2], "stock-5m")
            self.assertEqual(fetch.call_args.kwargs["maximum_bars"], 23520)

    def test_merge_preserves_existing_partition_rows(self):
        with TemporaryDirectory() as directory:
            store = MinuteReplayStore(Path(directory) / "minute.duckdb")
            first = datetime(2026, 8, 4, 9, 35)
            make_row = lambda timestamp, close: {
                "datetime": timestamp,
                "open": close,
                "high": close + 1,
                "low": close - 1,
                "close": close,
                "vol": 100,
                "amount": 1000,
            }
            store.save("600000.SH", "stock-5m", [make_row(first, 10)])
            store.merge(
                "600000.SH",
                "stock-5m",
                [make_row(first + timedelta(minutes=5), 11)],
            )

            rows = store.load("600000.SH", "stock-5m")
            self.assertEqual([row["close"] for row in rows], [10, 11])

    def test_marks_a_completed_full_history_download(self):
        with TemporaryDirectory() as directory:
            store = MinuteReplayStore(Path(directory) / "minute.duckdb")

            self.assertFalse(store.has_full_history("600000.SH", "stock-5m"))
            store.mark_full_history("600000.SH", "stock-5m")

            self.assertTrue(store.has_full_history("600000.SH", "stock-5m"))
            self.assertFalse(store.has_full_history("000001.SH", "index-5m"))

    def test_reports_minute_cache_volume_by_granularity(self):
        with TemporaryDirectory() as directory:
            store = MinuteReplayStore(Path(directory) / "minute.duckdb")
            first = datetime(2026, 8, 4, 9, 35)
            row = {
                "datetime": first,
                "open": 10,
                "high": 11,
                "low": 9,
                "close": 10.5,
                "vol": 100,
                "amount": 1000,
            }
            store.save("600000.SH", "stock", [row])
            store.save("600000.SH", "stock-5m", [row])
            store.save("000001.SH", "index-5m", [row])

            stats = store.statistics()

            self.assertEqual(stats["oneMinuteInstrumentCount"], 1)
            self.assertEqual(stats["oneMinuteBarCount"], 1)
            self.assertEqual(stats["fiveMinuteInstrumentCount"], 2)
            self.assertEqual(stats["fiveMinuteBarCount"], 2)

    def test_reports_statistics_while_a_write_connection_is_open(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "minute.duckdb"
            store = MinuteReplayStore(path)
            connection = duckdb.connect(str(path))
            try:
                connection.execute(
                    """
                    CREATE TABLE minute_bars (
                        instrument_code VARCHAR,
                        instrument_type VARCHAR,
                        bar_time TIMESTAMP,
                        open DOUBLE,
                        high DOUBLE,
                        low DOUBLE,
                        close DOUBLE,
                        volume DOUBLE,
                        amount DOUBLE
                    )
                    """
                )

                stats = store.statistics()

                self.assertEqual(stats["fiveMinuteBarCount"], 0)
            finally:
                connection.close()

    def test_replaces_an_existing_cached_instrument_partition(self):
        with TemporaryDirectory() as directory:
            store = MinuteReplayStore(Path(directory) / "minute.duckdb")
            first = datetime(2026, 8, 4, 9, 35)
            make_row = lambda timestamp: {
                "datetime": timestamp,
                "open": 10,
                "high": 11,
                "low": 9,
                "close": 10.5,
                "vol": 100,
                "amount": 1000,
            }
            store.save("000001.SH", "index-5m", [
                make_row(first),
                make_row(first + timedelta(minutes=5)),
            ])
            store.save("000001.SH", "index-5m", [make_row(first)])

            self.assertEqual(len(store.load("000001.SH", "index-5m")), 1)

    def test_hybrid_provider_requests_unshifted_five_minute_timestamps(self):
        with TemporaryDirectory() as directory:
            provider = TdxMinuteReplayProvider(Path(directory) / "minute.duckdb")
            provider_rows = [{"datetime": datetime(2026, 8, 4, 9, 35)}]
            with (
                patch("easy_tdx.client.TdxClient") as client_class,
                patch.object(provider, "_fetch", return_value=provider_rows) as fetch,
                patch(
                    "replay_engine.minute_replay.build_hybrid_replay_scenario",
                    return_value={"interval": "hybrid"},
                ),
            ):
                client_class.return_value.__enter__.return_value = object()
                provider.create_scenario(
                    ts_code="600000.SH",
                    name="浦发银行",
                    benchmark_code="000001.SH",
                    game_length=20,
                    seed=7,
                    hybrid=True,
                )

            first_two_calls = fetch.call_args_list[:2]
            self.assertEqual(
                type(first_two_calls[0].args[0]).__name__,
                "_FailoverTdxClient",
            )
            self.assertEqual(first_two_calls[0].args[0].hosts[:3], TDX_HOSTS)
            self.assertEqual(
                [call.kwargs.get("bar_time") for call in first_two_calls],
                ["start", "start"],
            )

    def test_builds_hybrid_scenario_with_daily_context_and_minute_execution_steps(self):
        daily_start = datetime(2025, 1, 1)
        stock_daily_rows = []
        benchmark_daily_rows = []
        for index in range(250):
            timestamp = daily_start + timedelta(days=index)
            row = {
                "date": timestamp,
                "open": 10 + index / 100,
                "high": 10.2 + index / 100,
                "low": 9.8 + index / 100,
                "close": 10.1 + index / 100,
                "vol": 1000 + index,
                "amount": 10000 + index,
                "adjust_factor": 1,
            }
            stock_daily_rows.append(row)
            benchmark_daily_rows.append(
                {
                    **row,
                    "open": 3000 + index,
                    "high": 3002 + index,
                    "low": 2998 + index,
                    "close": 3001 + index,
                }
            )

        for day_offset in range(2):
            timestamp = datetime(2026, 7, 30) + timedelta(days=day_offset)
            stock_daily_rows.append({
                "date": timestamp,
                "open": 20 + day_offset,
                "high": 20.2 + day_offset,
                "low": 19.8 + day_offset,
                "close": 20.1 + day_offset,
                "vol": 2000,
                "amount": 20000,
                "adjust_factor": 1 + day_offset,
            })
            benchmark_daily_rows.append({
                "date": timestamp,
                "open": 4000 + day_offset,
                "high": 4002 + day_offset,
                "low": 3998 + day_offset,
                "close": 4001 + day_offset,
                "vol": 2000,
                "amount": 20000,
            })

        minute_start = datetime(2026, 7, 30, 9, 35)
        stock_minute_rows = []
        benchmark_minute_rows = []
        for day_offset in range(2):
            for minute_offset in range(48):
                timestamp = minute_start + timedelta(
                    days=day_offset,
                    minutes=minute_offset * 5,
                )
                row = {
                    "datetime": timestamp,
                    "open": 20 + day_offset + minute_offset / 10,
                    "high": 20.2 + day_offset + minute_offset / 10,
                    "low": 19.8 + day_offset + minute_offset / 10,
                    "close": 20.1 + day_offset + minute_offset / 10,
                    "vol": 2000 + minute_offset,
                    "amount": 20000 + minute_offset,
                }
                stock_minute_rows.append(row)
                benchmark_minute_rows.append(
                    {
                        **row,
                        "open": 4000 + day_offset + minute_offset,
                        "high": 4002 + day_offset + minute_offset,
                        "low": 3998 + day_offset + minute_offset,
                        "close": 4001 + day_offset + minute_offset,
                    }
                )

        scenario = build_hybrid_replay_scenario(
            stock_daily_rows=stock_daily_rows,
            benchmark_daily_rows=benchmark_daily_rows,
            stock_minute_rows=stock_minute_rows,
            benchmark_minute_rows=benchmark_minute_rows,
            ts_code="600000.SH",
            name="浦发银行",
            benchmark_code="000001.SH",
            training_days=2,
            seed=7,
        )

        self.assertEqual(scenario["interval"], "hybrid")
        self.assertEqual(scenario["trainingDays"], 2)
        self.assertEqual(scenario["stepMinutes"], 5)
        self.assertEqual(scenario["observationBars"], 250)
        self.assertEqual(scenario["gameLength"], 96)
        self.assertEqual(len(scenario["bars"]), 346)
        self.assertNotIn("tradeTime", scenario["bars"][249])
        self.assertEqual(scenario["bars"][250]["tradeTime"], "2026-07-30 09:35")
        self.assertEqual(scenario["bars"][298]["tradeDate"], "2026-07-31")
        self.assertEqual(scenario["bars"][298]["open"], 42)
        self.assertEqual(
            scenario["priceAdjustment"]["factorSource"],
            "stock_adj_factors.adj_factor",
        )

    def test_aligns_stock_and_benchmark_and_keeps_minute_metadata(self):
        start = datetime(2026, 7, 30, 9, 31)
        stock_rows = []
        benchmark_rows = []
        for index in range(255):
            timestamp = start + timedelta(minutes=index)
            row = {
                "datetime": timestamp,
                "open": 10 + index / 100,
                "high": 10.1 + index / 100,
                "low": 9.9 + index / 100,
                "close": 10.05 + index / 100,
                "vol": 1000 + index,
                "amount": 10000 + index,
            }
            stock_rows.append(row)
            benchmark_rows.append(
                {
                    **row,
                    "open": 3000 + index,
                    "high": 3001 + index,
                    "low": 2999 + index,
                    "close": 3000.5 + index,
                }
            )

        scenario = build_minute_replay_scenario(
            stock_rows=stock_rows,
            benchmark_rows=benchmark_rows,
            ts_code="600000.SH",
            name="浦发银行",
            benchmark_code="000001.SH",
            game_length=5,
            seed=7,
        )

        self.assertEqual(scenario["interval"], "1m")
        self.assertEqual(scenario["observationBars"], 250)
        self.assertEqual(scenario["gameLength"], 5)
        self.assertEqual(len(scenario["bars"]), 255)
        self.assertEqual(scenario["bars"][0]["tradeDate"], "2026-07-30")
        self.assertEqual(scenario["bars"][0]["tradeTime"], "2026-07-30 09:31")
        self.assertEqual(scenario["bars"][0]["sequence"], 1)
        self.assertEqual(len(scenario["benchmark"]["bars"]), 6)


if __name__ == "__main__":
    unittest.main()
