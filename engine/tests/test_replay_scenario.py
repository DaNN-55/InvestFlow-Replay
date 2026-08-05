from __future__ import annotations

import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

import duckdb

from replay_engine.data_store import (
    DuckDbBarStore,
    ReplayAlignedSourceBar,
    ReplayBenchmarkSourceBar,
    ReplayStockSourceBar,
)


BENCHMARK_CODE = "000300.SH"


def trading_dates(start: date, count: int) -> list[date]:
    result: list[date] = []
    current = start
    while len(result) < count:
        if current.weekday() < 5:
            result.append(current)
        current += timedelta(days=1)
    return result


class ReplayScenarioTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.source_path = root / "staging.duckdb"
        connection = duckdb.connect(str(self.source_path))
        try:
            connection.execute(
                """
                CREATE TABLE stock_daily_bars (
                    ts_code VARCHAR,
                    trade_date DATE,
                    open DOUBLE,
                    high DOUBLE,
                    low DOUBLE,
                    close DOUBLE,
                    pre_close DOUBLE,
                    change DOUBLE,
                    pct_chg DOUBLE,
                    vol DOUBLE,
                    amount DOUBLE,
                    updated_at TIMESTAMP
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE limit_list_d (
                    ts_code VARCHAR,
                    trade_date DATE,
                    limit_type VARCHAR,
                    open_times INTEGER
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE stock_adj_factors (
                    ts_code VARCHAR,
                    trade_date DATE,
                    adj_factor DOUBLE,
                    updated_at TIMESTAMP
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE trade_calendar (
                    exchange VARCHAR,
                    cal_date DATE,
                    is_open INTEGER,
                    pretrade_date DATE,
                    updated_at TIMESTAMP
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE stock_instruments (
                    ts_code VARCHAR,
                    name VARCHAR,
                    list_date DATE,
                    delist_date DATE
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE index_daily_bars (
                    ts_code VARCHAR,
                    trade_date DATE,
                    open DOUBLE,
                    high DOUBLE,
                    low DOUBLE,
                    close DOUBLE,
                    pre_close DOUBLE,
                    change DOUBLE,
                    pct_chg DOUBLE,
                    vol DOUBLE,
                    amount DOUBLE,
                    updated_at TIMESTAMP
                )
                """
            )
            rows = []
            factor_rows = []
            limit_rows = []
            all_dates = trading_dates(date(2022, 1, 3), 400)
            for ts_code, count, base in (
                ("600000.SH", 300, 10.0),
                ("000001.SZ", 400, 20.0),
            ):
                dates = all_dates[:count]
                for index, trade_date in enumerate(dates):
                    close = base + index / 100
                    rows.append(
                        (
                            ts_code,
                            trade_date,
                            close - 0.1,
                            close + 0.2,
                            close - 0.2,
                            close,
                            close - 0.05,
                            0.05,
                            0.1,
                            1000 + index,
                            10000 + index,
                            "2024-01-01 00:00:00",
                        )
                    )
                    factor_rows.append(
                        (
                            ts_code,
                            trade_date,
                            1.0,
                            "2024-01-01 00:00:00",
                        )
                    )
                if ts_code == "000001.SZ":
                    limit_rows.extend(
                        [
                            (ts_code, dates[100], "U", 0),
                            (ts_code, dates[200], "D", 0),
                            (ts_code, dates[300], "Z", 1),
                        ]
                    )
            connection.executemany(
                "INSERT INTO stock_daily_bars VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                rows,
            )
            connection.executemany(
                "INSERT INTO limit_list_d VALUES (?, ?, ?, ?)",
                limit_rows,
            )
            connection.executemany(
                "INSERT INTO stock_adj_factors VALUES (?, ?, ?, ?)",
                factor_rows,
            )
            connection.executemany(
                "INSERT INTO trade_calendar VALUES (?, ?, 1, ?, ?)",
                [
                    (
                        exchange,
                        trade_date,
                        all_dates[index - 1] if index > 0 else None,
                        "2024-01-01 00:00:00",
                    )
                    for exchange in ("SSE", "SZSE")
                    for index, trade_date in enumerate(all_dates)
                ],
            )
            connection.executemany(
                "INSERT INTO stock_instruments VALUES (?, ?, ?, ?)",
                [
                    ("600000.SH", "浦发银行", date(1999, 11, 10), None),
                    ("000001.SZ", "平安银行", date(1991, 4, 3), None),
                ],
            )
            benchmark_rows = []
            for ts_code, base, count in (
                (BENCHMARK_CODE, 4000.0, 400),
                ("399001.SZ", 12000.0, 400),
                ("000016.SH", 2500.0, 280),
            ):
                previous_close = base
                for index, trade_date in enumerate(all_dates[:count]):
                    close = base + index
                    pct_chg = ((close / previous_close) - 1) * 100
                    benchmark_rows.append(
                        (
                            ts_code,
                            trade_date,
                            close - 2,
                            close + 5,
                            close - 5,
                            close,
                            previous_close,
                            close - previous_close,
                            pct_chg,
                            100000 + index,
                            1000000 + index,
                            "2024-01-01 00:00:00",
                        )
                    )
                    previous_close = close
            connection.executemany(
                "INSERT INTO index_daily_bars VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                benchmark_rows,
            )
        finally:
            connection.close()
        self.store = DuckDbBarStore(
            source_db_path=self.source_path,
            catalog_db_path=root / "market.duckdb",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def create_replay_scenario(
        self,
        *,
        game_length: int = 120,
        seed: int | None = 42,
        benchmark_code: str = BENCHMARK_CODE,
        excluded_ts_codes: tuple[str, ...] = (),
        recent_window_end_dates: tuple[date, ...] = (),
    ) -> dict:
        return self.store.create_replay_scenario(
            game_length=game_length,
            benchmark_code=benchmark_code,
            seed=seed,
            excluded_ts_codes=excluded_ts_codes,
            recent_window_end_dates=recent_window_end_dates,
        )

    def test_excludes_previously_trained_symbols_from_normal_selection(self) -> None:
        scenario = self.create_replay_scenario(
            game_length=20,
            excluded_ts_codes=("000001.SZ",),
        )

        self.assertEqual(scenario["tsCode"], "600000.SH")

    def test_prefers_a_window_far_from_recent_training_periods(self) -> None:
        recent_end = trading_dates(date(2022, 1, 3), 400)[-1]
        scenario = self.create_replay_scenario(
            game_length=20,
            seed=42,
            excluded_ts_codes=("600000.SH",),
            recent_window_end_dates=(recent_end,),
        )

        self.assertLess(date.fromisoformat(scenario["bars"][-1]["tradeDate"]), recent_end)

    def test_seed_reproduces_a_complete_private_daily_scenario(self) -> None:
        first = self.create_replay_scenario()
        second = self.create_replay_scenario()

        self.assertEqual(first, second)
        self.assertEqual(first["observationBars"], 250)
        self.assertEqual(first["gameLength"], 120)
        self.assertEqual(len(first["bars"]), 370)
        self.assertEqual(first["tsCode"], "000001.SZ")
        self.assertIn("tradeDate", first["bars"][0])
        self.assertIn("preClose", first["bars"][0])
        self.assertIn("pctChange", first["bars"][0])
        self.assertIn("limitType", first["bars"][0])
        self.assertIn("openTimes", first["bars"][0])
        self.assertIn("weekIndex", first["bars"][0])
        self.assertIn("monthIndex", first["bars"][0])
        self.assertEqual(first["bars"][0]["sequence"], 1)
        self.assertGreater(first["bars"][-1]["weekIndex"], first["bars"][0]["weekIndex"])
        self.assertGreater(first["bars"][-1]["monthIndex"], first["bars"][0]["monthIndex"])
        self.assertEqual(
            [bar["tradeDate"] for bar in first["bars"]],
            sorted(bar["tradeDate"] for bar in first["bars"]),
        )
        limit_bars = [bar for bar in first["bars"] if bar["limitType"] is not None]
        self.assertEqual(
            {bar["limitType"] for bar in limit_bars},
            {"U", "D", "Z"},
        )
        self.assertEqual(
            {bar["openTimes"] for bar in limit_bars},
            {0, 1},
        )
        benchmark = first["benchmark"]
        self.assertEqual(benchmark["code"], BENCHMARK_CODE)
        self.assertEqual(len(benchmark["bars"]), 121)
        self.assertEqual(benchmark["bars"][0]["sequence"], 250)
        self.assertEqual(benchmark["bars"][-1]["sequence"], 370)
        self.assertEqual(
            benchmark["bars"][0]["tradeDate"],
            first["bars"][249]["tradeDate"],
        )
        self.assertEqual(
            benchmark["bars"][-1]["tradeDate"],
            first["bars"][-1]["tradeDate"],
        )

    def test_uses_adjust_factors_to_remove_a_split_price_discontinuity(self) -> None:
        dates = trading_dates(date(2022, 1, 3), 400)
        split_date = dates[300]
        connection = duckdb.connect(str(self.source_path))
        try:
            connection.execute(
                """
                UPDATE stock_daily_bars
                SET
                    open = CASE WHEN trade_date < ? THEN 20.0 ELSE 10.0 END,
                    high = CASE WHEN trade_date < ? THEN 20.2 ELSE 10.1 END,
                    low = CASE WHEN trade_date < ? THEN 19.8 ELSE 9.9 END,
                    close = CASE WHEN trade_date < ? THEN 20.0 ELSE 10.0 END,
                    pre_close = CASE WHEN trade_date < ? THEN 20.0 ELSE 10.0 END,
                    change = 0.0,
                    pct_chg = 0.0
                WHERE ts_code = '000001.SZ'
                """,
                [split_date] * 5,
            )
            connection.execute(
                """
                UPDATE stock_adj_factors
                SET adj_factor = CASE WHEN trade_date < ? THEN 1.0 ELSE 2.0 END
                WHERE ts_code = '000001.SZ'
                """,
                [split_date],
            )
        finally:
            connection.close()

        scenario = self.create_replay_scenario()
        split_bar = next(
            bar for bar in scenario["bars"] if bar["tradeDate"] == split_date.isoformat()
        )
        previous_bar = scenario["bars"][split_bar["sequence"] - 2]

        self.assertAlmostEqual(previous_bar["close"], 20.0)
        self.assertAlmostEqual(split_bar["open"], 20.0)
        self.assertAlmostEqual(split_bar["close"], 20.0)
        self.assertAlmostEqual(split_bar["rawClose"], 10.0)
        self.assertAlmostEqual(split_bar["adjustFactor"], 2.0)
        self.assertEqual(
            scenario["priceAdjustment"]["method"],
            "scenario-start-total-return",
        )

    def test_uses_adjust_factors_to_remove_a_cash_dividend_discontinuity(self) -> None:
        dates = trading_dates(date(2022, 1, 3), 400)
        ex_date = dates[300]
        connection = duckdb.connect(str(self.source_path))
        try:
            connection.execute(
                """
                UPDATE stock_daily_bars
                SET
                    open = CASE WHEN trade_date < ? THEN 10.0 ELSE 9.0 END,
                    high = CASE WHEN trade_date < ? THEN 10.2 ELSE 9.18 END,
                    low = CASE WHEN trade_date < ? THEN 9.8 ELSE 8.82 END,
                    close = CASE WHEN trade_date < ? THEN 10.0 ELSE 9.0 END,
                    pre_close = CASE WHEN trade_date < ? THEN 10.0 ELSE 9.0 END,
                    change = 0.0,
                    pct_chg = 0.0
                WHERE ts_code = '000001.SZ'
                """,
                [ex_date] * 5,
            )
            connection.execute(
                """
                UPDATE stock_adj_factors
                SET adj_factor = CASE
                    WHEN trade_date < ? THEN 1.0
                    ELSE 1.1111111111111112
                END
                WHERE ts_code = '000001.SZ'
                """,
                [ex_date],
            )
        finally:
            connection.close()

        scenario = self.create_replay_scenario()
        ex_bar = next(
            bar for bar in scenario["bars"] if bar["tradeDate"] == ex_date.isoformat()
        )
        previous_bar = scenario["bars"][ex_bar["sequence"] - 2]

        self.assertAlmostEqual(previous_bar["close"], 10.0)
        self.assertAlmostEqual(ex_bar["close"], 10.0)
        self.assertAlmostEqual(ex_bar["rawClose"], 9.0)

    def test_excludes_a_window_with_a_duplicate_trade_date(self) -> None:
        dates = trading_dates(date(2022, 1, 3), 400)
        connection = duckdb.connect(str(self.source_path))
        try:
            row = connection.execute(
                """
                SELECT *
                FROM stock_daily_bars
                WHERE ts_code = '000001.SZ' AND trade_date = ?
                """,
                [dates[200]],
            ).fetchone()
            connection.execute(
                "INSERT INTO stock_daily_bars VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                row,
            )
        finally:
            connection.close()

        with self.assertRaisesRegex(ValueError, "没有满足数据质量要求"):
            self.create_replay_scenario()

    def test_excludes_a_window_with_invalid_ohlc(self) -> None:
        dates = trading_dates(date(2022, 1, 3), 400)
        connection = duckdb.connect(str(self.source_path))
        try:
            connection.execute(
                """
                UPDATE stock_daily_bars
                SET high = low - 1
                WHERE ts_code = '000001.SZ' AND trade_date = ?
                """,
                [dates[200]],
            )
        finally:
            connection.close()

        with self.assertRaisesRegex(ValueError, "没有满足数据质量要求"):
            self.create_replay_scenario()

    def test_excludes_a_window_with_a_null_required_price(self) -> None:
        dates = trading_dates(date(2022, 1, 3), 400)
        connection = duckdb.connect(str(self.source_path))
        try:
            connection.execute(
                """
                UPDATE stock_daily_bars
                SET close = NULL
                WHERE ts_code = '000001.SZ' AND trade_date = ?
                """,
                [dates[200]],
            )
        finally:
            connection.close()

        with self.assertRaisesRegex(ValueError, "没有满足数据质量要求"):
            self.create_replay_scenario()

    def test_excludes_a_window_with_a_missing_open_market_day(self) -> None:
        dates = trading_dates(date(2022, 1, 3), 400)
        connection = duckdb.connect(str(self.source_path))
        try:
            connection.execute(
                """
                DELETE FROM stock_daily_bars
                WHERE ts_code = '000001.SZ' AND trade_date = ?
                """,
                [dates[200]],
            )
        finally:
            connection.close()

        with self.assertRaisesRegex(ValueError, "没有满足数据质量要求"):
            self.create_replay_scenario()

    def test_uses_the_symbols_own_exchange_calendar(self) -> None:
        dates = trading_dates(date(2022, 1, 3), 400)
        connection = duckdb.connect(str(self.source_path))
        try:
            connection.execute(
                """
                DELETE FROM trade_calendar
                WHERE exchange = 'SZSE' AND cal_date = ?
                """,
                [dates[200]],
            )
        finally:
            connection.close()

        with self.assertRaisesRegex(ValueError, "没有满足数据质量要求"):
            self.create_replay_scenario()

    def test_excludes_rows_before_the_instrument_list_date(self) -> None:
        dates = trading_dates(date(2022, 1, 3), 400)
        connection = duckdb.connect(str(self.source_path))
        try:
            connection.execute(
                """
                UPDATE stock_instruments
                SET list_date = ?
                WHERE ts_code = '000001.SZ'
                """,
                [dates[31]],
            )
        finally:
            connection.close()

        with self.assertRaisesRegex(ValueError, "没有满足数据质量要求"):
            self.create_replay_scenario()

    def test_excludes_rows_after_the_instrument_delist_date(self) -> None:
        dates = trading_dates(date(2022, 1, 3), 400)
        connection = duckdb.connect(str(self.source_path))
        try:
            connection.execute(
                """
                UPDATE stock_instruments
                SET delist_date = ?
                WHERE ts_code = '000001.SZ'
                """,
                [dates[368]],
            )
        finally:
            connection.close()

        with self.assertRaisesRegex(ValueError, "没有满足数据质量要求"):
            self.create_replay_scenario()

    def test_rejects_an_unknown_exchange_suffix(self) -> None:
        with self.assertRaisesRegex(ValueError, "未知交易所后缀"):
            DuckDbBarStore._replay_calendar_exchange("000001.XX")

    def test_excludes_a_window_without_a_matching_positive_adjust_factor(self) -> None:
        dates = trading_dates(date(2022, 1, 3), 400)
        connection = duckdb.connect(str(self.source_path))
        try:
            connection.execute(
                """
                DELETE FROM stock_adj_factors
                WHERE ts_code = '000001.SZ' AND trade_date = ?
                """,
                [dates[200]],
            )
        finally:
            connection.close()

        with self.assertRaisesRegex(ValueError, "没有满足数据质量要求"):
            self.create_replay_scenario()

    def test_excludes_a_window_with_a_non_positive_adjust_factor(self) -> None:
        dates = trading_dates(date(2022, 1, 3), 400)
        connection = duckdb.connect(str(self.source_path))
        try:
            connection.execute(
                """
                UPDATE stock_adj_factors
                SET adj_factor = 0
                WHERE ts_code = '000001.SZ' AND trade_date = ?
                """,
                [dates[200]],
            )
        finally:
            connection.close()

        with self.assertRaisesRegex(ValueError, "没有满足数据质量要求"):
            self.create_replay_scenario()

    def test_excludes_a_window_with_a_positive_but_inconsistent_adjust_factor(
        self,
    ) -> None:
        dates = trading_dates(date(2022, 1, 3), 400)
        connection = duckdb.connect(str(self.source_path))
        try:
            connection.execute(
                """
                UPDATE stock_adj_factors
                SET adj_factor = 1.5
                WHERE ts_code = '000001.SZ' AND trade_date = ?
                """,
                [dates[200]],
            )
        finally:
            connection.close()

        with self.assertRaisesRegex(ValueError, "没有满足数据质量要求"):
            self.create_replay_scenario()

    def test_lists_only_usable_benchmarks_with_supported_game_lengths(
        self,
    ) -> None:
        items = self.store.list_replay_benchmarks()

        self.assertEqual(
            [item["code"] for item in items],
            ["000016.SH", BENCHMARK_CODE, "399001.SZ"],
        )
        by_code = {item["code"]: item for item in items}
        self.assertEqual(by_code["000016.SH"]["supportedGameLengths"], [20])
        self.assertEqual(
            by_code[BENCHMARK_CODE]["supportedGameLengths"],
            [20, 60, 120],
        )
        self.assertEqual(by_code[BENCHMARK_CODE]["barCount"], 400)
        self.assertEqual(by_code[BENCHMARK_CODE]["name"], "沪深300")

    def test_rejects_an_unknown_benchmark_code(self) -> None:
        with self.assertRaisesRegex(ValueError, "找不到基准指数"):
            self.create_replay_scenario(benchmark_code="999999.SH")

    def test_rejects_a_benchmark_with_a_duplicate_date(self) -> None:
        dates = trading_dates(date(2022, 1, 3), 400)
        connection = duckdb.connect(str(self.source_path))
        try:
            row = connection.execute(
                """
                SELECT *
                FROM index_daily_bars
                WHERE ts_code = ? AND trade_date = ?
                """,
                [BENCHMARK_CODE, dates[200]],
            ).fetchone()
            connection.execute(
                "INSERT INTO index_daily_bars VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                row,
            )
        finally:
            connection.close()

        with self.assertRaisesRegex(ValueError, "重复日期"):
            self.create_replay_scenario()

    def test_rejects_a_benchmark_with_invalid_ohlc(self) -> None:
        dates = trading_dates(date(2022, 1, 3), 400)
        connection = duckdb.connect(str(self.source_path))
        try:
            connection.execute(
                """
                UPDATE index_daily_bars
                SET high = low - 1
                WHERE ts_code = ? AND trade_date = ?
                """,
                [BENCHMARK_CODE, dates[200]],
            )
        finally:
            connection.close()

        with self.assertRaisesRegex(ValueError, "非法行情"):
            self.create_replay_scenario()

    def test_rejects_a_benchmark_with_inconsistent_daily_return(self) -> None:
        dates = trading_dates(date(2022, 1, 3), 400)
        connection = duckdb.connect(str(self.source_path))
        try:
            connection.execute(
                """
                UPDATE index_daily_bars
                SET pct_chg = pct_chg + 1
                WHERE ts_code = ? AND trade_date = ?
                """,
                [BENCHMARK_CODE, dates[200]],
            )
        finally:
            connection.close()

        with self.assertRaisesRegex(ValueError, "收益字段不一致"):
            self.create_replay_scenario()

    def test_rejects_a_benchmark_that_cannot_align_every_stock_date(
        self,
    ) -> None:
        dates = trading_dates(date(2022, 1, 3), 400)
        connection = duckdb.connect(str(self.source_path))
        try:
            connection.execute(
                """
                DELETE FROM index_daily_bars
                WHERE ts_code = ? AND trade_date < ?
                """,
                [BENCHMARK_CODE, dates[30]],
            )
            connection.execute(
                """
                DELETE FROM stock_daily_bars
                WHERE ts_code = '000001.SZ' AND trade_date >= ?
                """,
                [dates[370]],
            )
        finally:
            connection.close()

        with self.assertRaisesRegex(ValueError, "无法与股票窗口逐日完整对齐"):
            self.create_replay_scenario()

    def test_requires_the_adjust_factor_data_contract(self) -> None:
        connection = duckdb.connect(str(self.source_path))
        try:
            connection.execute("DROP TABLE stock_adj_factors")
        finally:
            connection.close()

        with self.assertRaisesRegex(ValueError, "stock_adj_factors"):
            self.create_replay_scenario()


class ReplayAlignedRunTest(unittest.TestCase):
    @staticmethod
    def stock_bar(
        trade_date: date,
        sequence: int,
        pretrade_date: date | None,
    ) -> ReplayStockSourceBar:
        return ReplayStockSourceBar(
            trade_date=trade_date,
            open=10,
            high=11,
            low=9,
            close=10,
            pre_close=10,
            pct_chg=0,
            volume=100,
            amount=1000,
            adjust_factor=1,
            calendar_sequence=sequence,
            calendar_pretrade_date=pretrade_date,
        )

    @staticmethod
    def benchmark_bar(
        trade_date: date,
        sequence: int,
        pretrade_date: date | None,
    ) -> ReplayBenchmarkSourceBar:
        return ReplayBenchmarkSourceBar(
            trade_date=trade_date,
            open=100,
            high=101,
            low=99,
            close=100,
            pre_close=100,
            pct_chg=0,
            volume=1000,
            amount=10000,
            calendar_sequence=sequence,
            calendar_pretrade_date=pretrade_date,
        )

    def test_stock_calendar_break_splits_an_aligned_run(self) -> None:
        first_date = date(2026, 1, 5)
        second_date = date(2026, 1, 6)
        rows = [
            ReplayAlignedSourceBar(
                stock=self.stock_bar(first_date, 1, None),
                benchmark=self.benchmark_bar(first_date, 1, None),
            ),
            ReplayAlignedSourceBar(
                stock=self.stock_bar(second_date, 3, first_date),
                benchmark=self.benchmark_bar(second_date, 2, first_date),
            ),
        ]

        self.assertEqual(
            DuckDbBarStore._replay_aligned_continuous_runs(rows),
            [(0, 1), (1, 1)],
        )

    def test_benchmark_calendar_break_splits_an_aligned_run(self) -> None:
        first_date = date(2026, 1, 5)
        second_date = date(2026, 1, 6)
        rows = [
            ReplayAlignedSourceBar(
                stock=self.stock_bar(first_date, 1, None),
                benchmark=self.benchmark_bar(first_date, 1, None),
            ),
            ReplayAlignedSourceBar(
                stock=self.stock_bar(second_date, 2, first_date),
                benchmark=self.benchmark_bar(second_date, 3, first_date),
            ),
        ]

        self.assertEqual(
            DuckDbBarStore._replay_aligned_continuous_runs(rows),
            [(0, 1), (1, 1)],
        )


if __name__ == "__main__":
    unittest.main()
