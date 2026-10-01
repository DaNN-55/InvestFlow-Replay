from __future__ import annotations

from dataclasses import dataclass
from datetime import date
import hashlib
import math
from pathlib import Path
import random
from typing import Any

import duckdb

from .config import MARKET_DB_PATH, REPLAY_SOURCE_DB_PATH


SOURCE_MODE_TDX_CACHE = "tdx-cache"
REPLAY_ADJUSTED_RETURN_TOLERANCE_PCT = 0.1
REPLAY_BENCHMARK_RETURN_TOLERANCE_PCT = 0.1
REPLAY_CALENDAR_EXCHANGE_BY_SUFFIX = {
    "SH": "SSE",
    "SZ": "SZSE",
}
REPLAY_BENCHMARK_NAMES_BY_CODE = {
    "000001.SH": "上证指数",
    "000002.SH": "上证A股指数",
    "000016.SH": "上证50",
    "000300.SH": "沪深300",
    "000688.SH": "科创50",
    "000852.SH": "中证1000",
    "000905.SH": "中证500",
    "000906.SH": "中证800",
    "399001.SZ": "深证成指",
}


@dataclass(frozen=True)
class ReplayBenchmarkQuality:
    code: str
    start_date: date
    end_date: date
    row_count: int
    distinct_date_count: int
    invalid_market_rows: int
    inconsistent_return_rows: int


@dataclass(frozen=True)
class ReplayStockSourceBar:
    trade_date: date
    open: float
    high: float
    low: float
    close: float
    pre_close: float
    pct_chg: float
    volume: float
    amount: float
    adjust_factor: float
    calendar_sequence: int
    calendar_pretrade_date: date | None


@dataclass(frozen=True)
class ReplayBenchmarkSourceBar:
    trade_date: date
    open: float
    high: float
    low: float
    close: float
    pre_close: float
    pct_chg: float
    volume: float
    amount: float
    calendar_sequence: int
    calendar_pretrade_date: date | None


@dataclass(frozen=True)
class ReplayAlignedSourceBar:
    stock: ReplayStockSourceBar
    benchmark: ReplayBenchmarkSourceBar


class DuckDbBarStore:
    def __init__(
        self,
        db_path: Path | None = None,
        source_db_path: Path | None = None,
        read_only: bool = False,
    ) -> None:
        self.read_only = read_only
        resolved_source_path = source_db_path if source_db_path is not None else REPLAY_SOURCE_DB_PATH
        self.source_db_path = (
            Path(resolved_source_path).resolve()
            if resolved_source_path is not None
            else None
        )
        resolved_db_path = (
            db_path
            if db_path is not None
            else (MARKET_DB_PATH if source_db_path is None else None)
        )
        self.db_path = (
            Path(resolved_db_path).resolve()
            if resolved_db_path is not None
            else None
        )
        if self.db_path is not None and not self.read_only:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            self._ensure_daily_bars_table()
            self._ensure_adjust_factors_table()
            self._ensure_fundamental_snapshots_table()

    def _connect(self, read_only: bool = False) -> duckdb.DuckDBPyConnection:
        if self.db_path is None:
            raise FileNotFoundError("当前实例未启用本地主市场库")
        return duckdb.connect(str(self.db_path), read_only=read_only)

    def _source_enabled(self) -> bool:
        return self.source_db_path is not None and self.source_db_path.exists()

    def _source_connect(self, read_only: bool = True) -> duckdb.DuckDBPyConnection:
        if not self._source_enabled():
            raise FileNotFoundError("未配置可用的外部原始库")
        del read_only
        return duckdb.connect(str(self.source_db_path))

    @staticmethod
    def _ts_code_to_symbol_exchange(ts_code: str) -> tuple[str, str]:
        value = str(ts_code or "").strip().upper()
        if "." not in value:
            return value, ""
        symbol, suffix = value.split(".", 1)
        exchange = {
            "SH": "SSE",
            "SZ": "SZSE",
            "BJ": "BSE",
        }.get(suffix.upper(), suffix.upper())
        return symbol, exchange

    @staticmethod
    def _ts_code_to_order_book_id(ts_code: str) -> str:
        symbol, exchange = DuckDbBarStore._ts_code_to_symbol_exchange(ts_code)
        suffix = {
            "SSE": "XSHG",
            "SZSE": "XSHE",
            "BSE": "XBSE",
        }.get(exchange, exchange)
        return f"{symbol}.{suffix}" if suffix else symbol

    def source_mode(self) -> str:
        return SOURCE_MODE_TDX_CACHE if self._source_enabled() else "local"

    def source_db_path_text(self) -> str | None:
        return str(self.source_db_path) if self._source_enabled() else None

    def source_instrument_name_map(self) -> dict[str, str]:
        if not self._source_enabled():
            return {}

        connection = self._source_connect()
        try:
            rows = connection.execute(
                """
                SELECT ts_code, name
                FROM stock_instruments
                UNION ALL
                SELECT ts_code, name
                FROM etf_instruments
                """
            ).fetchall()
        finally:
            connection.close()

        return {
            self._ts_code_to_order_book_id(str(row[0])): str(row[1] or "").strip()
            for row in rows
            if str(row[0] or "").strip()
        }

    def source_data_version(self) -> str:
        if self._source_enabled():
            active_path = self.source_db_path
            stat = active_path.stat()
            fingerprint = (
                f"{active_path.resolve()}:{stat.st_size}:{stat.st_mtime_ns}"
            ).encode("utf-8")
            return hashlib.sha256(fingerprint).hexdigest()
        if self.db_path is None or not self.db_path.exists():
            return "unavailable"
        connection = self._connect(read_only=True)
        try:
            daily_bars_state = connection.execute(
                """
                SELECT
                    COUNT(*),
                    COALESCE(CAST(MAX(trade_date) AS VARCHAR), ''),
                    COALESCE(CAST(MAX(updated_at) AS VARCHAR), '')
                FROM daily_bars
                """
            ).fetchone()
            adjust_factors_state = connection.execute(
                """
                SELECT
                    COUNT(*),
                    COALESCE(CAST(MAX(trade_date) AS VARCHAR), ''),
                    COALESCE(CAST(MAX(updated_at) AS VARCHAR), '')
                FROM adjust_factors
                """
            ).fetchone()
        finally:
            connection.close()
        fingerprint = repr(
            (
                "local-market",
                daily_bars_state,
                adjust_factors_state,
            )
        ).encode("utf-8")
        return hashlib.sha256(fingerprint).hexdigest()

    @staticmethod
    def _replay_source_tables(
        connection: duckdb.DuckDBPyConnection,
    ) -> set[str]:
        return {
            str(row[0])
            for row in connection.execute(
                """
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = 'main'
                """
            ).fetchall()
        }

    @staticmethod
    def _replay_benchmark_quality_rows(
        connection: duckdb.DuckDBPyConnection,
    ) -> list[ReplayBenchmarkQuality]:
        rows = connection.execute(
            """
            SELECT
                UPPER(ts_code) AS benchmark_code,
                MIN(trade_date) AS start_date,
                MAX(trade_date) AS end_date,
                COUNT(*) AS row_count,
                COUNT(DISTINCT trade_date) AS distinct_date_count,
                SUM(
                    CASE
                        WHEN open IS NULL
                          OR NOT ISFINITE(open)
                          OR open <= 0
                          OR high IS NULL
                          OR NOT ISFINITE(high)
                          OR high <= 0
                          OR low IS NULL
                          OR NOT ISFINITE(low)
                          OR low <= 0
                          OR close IS NULL
                          OR NOT ISFINITE(close)
                          OR close <= 0
                          OR low > LEAST(open, close)
                          OR high < GREATEST(open, close)
                          OR low > high
                          OR pre_close IS NULL
                          OR NOT ISFINITE(pre_close)
                          OR pre_close <= 0
                          OR pct_chg IS NULL
                          OR NOT ISFINITE(pct_chg)
                          OR vol IS NULL
                          OR NOT ISFINITE(vol)
                          OR vol < 0
                          OR amount IS NULL
                          OR NOT ISFINITE(amount)
                          OR amount < 0
                        THEN 1
                        ELSE 0
                    END
                ) AS invalid_market_rows,
                SUM(
                    CASE
                        WHEN close IS NOT NULL
                          AND ISFINITE(close)
                          AND close > 0
                          AND pre_close IS NOT NULL
                          AND ISFINITE(pre_close)
                          AND pre_close > 0
                          AND pct_chg IS NOT NULL
                          AND ISFINITE(pct_chg)
                          AND ABS(
                                (((close / pre_close) - 1) * 100) - pct_chg
                              ) > ?
                        THEN 1
                        ELSE 0
                    END
                ) AS inconsistent_return_rows
            FROM index_daily_bars
            GROUP BY UPPER(ts_code)
            ORDER BY benchmark_code
            """,
            [REPLAY_BENCHMARK_RETURN_TOLERANCE_PCT],
        ).fetchall()
        return [
            ReplayBenchmarkQuality(
                code=str(row[0]),
                start_date=row[1],
                end_date=row[2],
                row_count=int(row[3]),
                distinct_date_count=int(row[4]),
                invalid_market_rows=int(row[5] or 0),
                inconsistent_return_rows=int(row[6] or 0),
            )
            for row in rows
        ]

    @staticmethod
    def _replay_valid_benchmark_rows(
        connection: duckdb.DuckDBPyConnection,
        benchmark_code: str,
        calendar_exchange: str,
    ) -> list[ReplayBenchmarkSourceBar]:
        rows = connection.execute(
            """
            WITH unique_open_dates AS (
                SELECT
                    cal_date,
                    MAX(pretrade_date) AS pretrade_date
                FROM trade_calendar
                WHERE exchange = ?
                  AND is_open = 1
                GROUP BY cal_date
                HAVING COUNT(*) = 1
            ),
            market_calendar AS (
                SELECT
                    cal_date,
                    pretrade_date,
                    ROW_NUMBER() OVER (ORDER BY cal_date) AS calendar_sequence
                FROM unique_open_dates
            ),
            valid_index_bars AS (
                SELECT
                    trade_date,
                    MAX(open) AS open,
                    MAX(high) AS high,
                    MAX(low) AS low,
                    MAX(close) AS close,
                    MAX(pre_close) AS pre_close,
                    MAX(pct_chg) AS pct_chg,
                    MAX(vol) AS vol,
                    MAX(amount) AS amount
                FROM index_daily_bars
                WHERE UPPER(ts_code) = ?
                GROUP BY trade_date
                HAVING COUNT(*) = 1
                   AND BOOL_AND(
                        open IS NOT NULL
                        AND ISFINITE(open)
                        AND open > 0
                        AND high IS NOT NULL
                        AND ISFINITE(high)
                        AND high > 0
                        AND low IS NOT NULL
                        AND ISFINITE(low)
                        AND low > 0
                        AND close IS NOT NULL
                        AND ISFINITE(close)
                        AND close > 0
                        AND low <= LEAST(open, close)
                        AND high >= GREATEST(open, close)
                        AND low <= high
                        AND pre_close IS NOT NULL
                        AND ISFINITE(pre_close)
                        AND pre_close > 0
                        AND pct_chg IS NOT NULL
                        AND ISFINITE(pct_chg)
                        AND ABS(
                              (((close / pre_close) - 1) * 100) - pct_chg
                            ) <= ?
                        AND vol IS NOT NULL
                        AND ISFINITE(vol)
                        AND vol >= 0
                        AND amount IS NOT NULL
                        AND ISFINITE(amount)
                        AND amount >= 0
                    )
            )
            SELECT
                bars.trade_date,
                bars.open,
                bars.high,
                bars.low,
                bars.close,
                bars.pre_close,
                bars.pct_chg,
                bars.vol,
                bars.amount,
                calendar.calendar_sequence,
                calendar.pretrade_date
            FROM valid_index_bars AS bars
            INNER JOIN market_calendar AS calendar
                ON calendar.cal_date = bars.trade_date
            ORDER BY bars.trade_date
            """,
            [
                calendar_exchange,
                benchmark_code,
                REPLAY_BENCHMARK_RETURN_TOLERANCE_PCT,
            ],
        ).fetchall()
        return [
            ReplayBenchmarkSourceBar(
                trade_date=row[0],
                open=float(row[1]),
                high=float(row[2]),
                low=float(row[3]),
                close=float(row[4]),
                pre_close=float(row[5]),
                pct_chg=float(row[6]),
                volume=float(row[7]),
                amount=float(row[8]),
                calendar_sequence=int(row[9]),
                calendar_pretrade_date=row[10],
            )
            for row in rows
        ]

    @staticmethod
    def _replay_benchmark_continuous_runs(
        rows: list[ReplayBenchmarkSourceBar],
    ) -> list[tuple[int, int]]:
        if not rows:
            return []
        runs: list[tuple[int, int]] = []
        run_start = 0
        previous = rows[0]
        for index, row in enumerate(rows[1:], start=1):
            if (
                row.trade_date <= previous.trade_date
                or row.calendar_sequence != previous.calendar_sequence + 1
                or row.calendar_pretrade_date != previous.trade_date
            ):
                runs.append((run_start, index - run_start))
                run_start = index
            previous = row
        runs.append((run_start, len(rows) - run_start))
        return runs

    @classmethod
    def _replay_benchmark_supported_game_lengths(
        cls,
        rows: list[ReplayBenchmarkSourceBar],
    ) -> list[int]:
        maximum_run_length = max(
            (length for _, length in cls._replay_benchmark_continuous_runs(rows)),
            default=0,
        )
        return [
            game_length
            for game_length in (20, 60, 120)
            if maximum_run_length >= 250 + game_length
        ]

    @classmethod
    def _resolve_replay_benchmark(
        cls,
        connection: duckdb.DuckDBPyConnection,
        *,
        benchmark_code: str,
        game_length: int,
    ) -> tuple[str, list[ReplayBenchmarkSourceBar]]:
        normalized_code = str(benchmark_code or "").strip().upper()
        if not normalized_code:
            raise ValueError("benchmarkCode 不能为空")
        stats_by_code = {
            row.code: row
            for row in cls._replay_benchmark_quality_rows(connection)
        }
        stats = stats_by_code.get(normalized_code)
        if stats is None:
            raise ValueError(f"找不到基准指数：{normalized_code}")
        if stats.row_count != stats.distinct_date_count:
            raise ValueError(f"基准指数 {normalized_code} 存在重复日期")
        if stats.invalid_market_rows > 0:
            raise ValueError(f"基准指数 {normalized_code} 存在非法行情")
        if stats.inconsistent_return_rows > 0:
            raise ValueError(
                f"基准指数 {normalized_code} 的 close/pre_close 与 pct_chg "
                "收益字段不一致"
            )
        calendar_exchange = cls._replay_calendar_exchange(normalized_code)
        rows = cls._replay_valid_benchmark_rows(
            connection,
            normalized_code,
            calendar_exchange,
        )
        supported_game_lengths = cls._replay_benchmark_supported_game_lengths(rows)
        if int(game_length) not in supported_game_lengths:
            raise ValueError(
                f"基准指数 {normalized_code} 不支持 {int(game_length)} 日演练："
                "缺少本所交易日历上的连续完整行情"
            )
        return normalized_code, rows

    def list_replay_benchmarks(self) -> list[dict[str, Any]]:
        if not self._source_enabled():
            raise FileNotFoundError("历史行情演练需要外部原始库")
        connection = self._source_connect()
        try:
            available_tables = self._replay_source_tables(connection)
            required_tables = {"index_daily_bars", "trade_calendar"}
            missing_tables = sorted(required_tables - available_tables)
            if missing_tables:
                raise ValueError(
                    "历史行情演练缺少基准指数数据表："
                    + "、".join(missing_tables)
                )
            items: list[dict[str, Any]] = []
            for stats in self._replay_benchmark_quality_rows(connection):
                code = stats.code
                if (
                    stats.row_count != stats.distinct_date_count
                    or stats.invalid_market_rows > 0
                    or stats.inconsistent_return_rows > 0
                ):
                    continue
                try:
                    calendar_exchange = self._replay_calendar_exchange(code)
                except ValueError:
                    continue
                rows = self._replay_valid_benchmark_rows(
                    connection,
                    code,
                    calendar_exchange,
                )
                supported_game_lengths = (
                    self._replay_benchmark_supported_game_lengths(rows)
                )
                if not supported_game_lengths:
                    continue
                items.append(
                    {
                        "code": code,
                        "name": REPLAY_BENCHMARK_NAMES_BY_CODE.get(code, code),
                        "startDate": stats.start_date.isoformat(),
                        "endDate": stats.end_date.isoformat(),
                        "barCount": stats.row_count,
                        "supportedGameLengths": supported_game_lengths,
                    }
                )
            return items
        finally:
            connection.close()

    @staticmethod
    def _replay_length_candidates(
        connection: duckdb.DuckDBPyConnection,
        required_bars: int,
    ) -> list[str]:
        return [
            str(row[0])
            for row in connection.execute(
                """
                SELECT ts_code
                FROM stock_daily_bars
                GROUP BY ts_code
                HAVING COUNT(DISTINCT trade_date) >= ?
                ORDER BY ts_code
                """,
                [required_bars],
            ).fetchall()
        ]

    @staticmethod
    def _replay_calendar_exchange(ts_code: str) -> str:
        value = str(ts_code or "").strip().upper()
        if "." not in value:
            raise ValueError(f"行情代码缺少交易所后缀：{value or '<empty>'}")
        suffix = value.rsplit(".", 1)[1]
        exchange = REPLAY_CALENDAR_EXCHANGE_BY_SUFFIX.get(suffix)
        if exchange:
            return exchange
        if suffix == "BJ":
            raise ValueError("交易所后缀 BJ 暂无受支持的独立交易日历")
        raise ValueError(f"未知交易所后缀：{suffix}")

    @staticmethod
    def _replay_valid_source_rows(
        connection: duckdb.DuckDBPyConnection,
        ts_code: str,
        calendar_exchange: str,
    ) -> list[ReplayStockSourceBar]:
        rows = connection.execute(
            """
            WITH unique_open_dates AS (
                SELECT
                    cal_date,
                    MAX(pretrade_date) AS pretrade_date
                FROM trade_calendar
                WHERE exchange = ?
                  AND is_open = 1
                GROUP BY cal_date
                HAVING COUNT(*) = 1
            ),
            market_calendar AS (
                SELECT
                    cal_date,
                    pretrade_date,
                    ROW_NUMBER() OVER (ORDER BY cal_date) AS calendar_sequence
                FROM unique_open_dates
            ),
            valid_daily_bars AS (
                SELECT
                    trade_date,
                    MAX(open) AS open,
                    MAX(high) AS high,
                    MAX(low) AS low,
                    MAX(close) AS close,
                    MAX(pre_close) AS pre_close,
                    MAX(pct_chg) AS pct_chg,
                    MAX(vol) AS vol,
                    MAX(amount) AS amount
                FROM stock_daily_bars
                WHERE ts_code = ?
                GROUP BY trade_date
                HAVING COUNT(*) = 1
                   AND BOOL_AND(
                        open IS NOT NULL
                        AND ISFINITE(open)
                        AND open > 0
                        AND high IS NOT NULL
                        AND ISFINITE(high)
                        AND high > 0
                        AND low IS NOT NULL
                        AND ISFINITE(low)
                        AND low > 0
                        AND close IS NOT NULL
                        AND ISFINITE(close)
                        AND close > 0
                        AND low <= LEAST(open, close)
                        AND high >= GREATEST(open, close)
                        AND low <= high
                        AND pre_close IS NOT NULL
                        AND ISFINITE(pre_close)
                        AND pre_close > 0
                        AND pct_chg IS NOT NULL
                        AND ISFINITE(pct_chg)
                        AND vol IS NOT NULL
                        AND ISFINITE(vol)
                        AND vol >= 0
                        AND amount IS NOT NULL
                        AND ISFINITE(amount)
                        AND amount >= 0
                    )
            ),
            valid_adjust_factors AS (
                SELECT
                    trade_date,
                    MAX(adj_factor) AS adj_factor
                FROM stock_adj_factors
                WHERE ts_code = ?
                GROUP BY trade_date
                HAVING COUNT(*) = 1
                   AND BOOL_AND(
                        adj_factor IS NOT NULL
                        AND ISFINITE(adj_factor)
                        AND adj_factor > 0
                    )
            ),
            valid_instrument AS (
                SELECT
                    MAX(list_date) AS list_date,
                    MAX(delist_date) AS delist_date
                FROM stock_instruments
                WHERE ts_code = ?
                HAVING COUNT(*) = 1
                   AND BOOL_AND(
                        list_date IS NOT NULL
                        AND (
                            delist_date IS NULL
                            OR delist_date >= list_date
                        )
                    )
            )
            SELECT
                bars.trade_date,
                bars.open,
                bars.high,
                bars.low,
                bars.close,
                bars.pre_close,
                bars.pct_chg,
                bars.vol,
                bars.amount,
                factors.adj_factor,
                calendar.calendar_sequence,
                calendar.pretrade_date
            FROM valid_daily_bars AS bars
            INNER JOIN valid_adjust_factors AS factors
                ON factors.trade_date = bars.trade_date
            INNER JOIN market_calendar AS calendar
                ON calendar.cal_date = bars.trade_date
            CROSS JOIN valid_instrument AS instrument
            WHERE bars.trade_date >= instrument.list_date
              AND (
                    instrument.delist_date IS NULL
                    OR bars.trade_date <= instrument.delist_date
              )
            ORDER BY bars.trade_date
            """,
            [calendar_exchange, ts_code, ts_code, ts_code],
        ).fetchall()
        return [
            ReplayStockSourceBar(
                trade_date=row[0],
                open=float(row[1]),
                high=float(row[2]),
                low=float(row[3]),
                close=float(row[4]),
                pre_close=float(row[5]),
                pct_chg=float(row[6]),
                volume=float(row[7]),
                amount=float(row[8]),
                adjust_factor=float(row[9]),
                calendar_sequence=int(row[10]),
                calendar_pretrade_date=row[11],
            )
            for row in rows
        ]

    @staticmethod
    def _replay_adjusted_return_is_consistent(
        previous_row: ReplayStockSourceBar,
        current_row: ReplayStockSourceBar,
    ) -> bool:
        previous_adjusted_close = (
            previous_row.close * previous_row.adjust_factor
        )
        current_adjusted_close = current_row.close * current_row.adjust_factor
        if (
            not math.isfinite(previous_adjusted_close)
            or previous_adjusted_close <= 0
            or not math.isfinite(current_adjusted_close)
            or current_adjusted_close <= 0
        ):
            return False
        adjusted_return_pct = (
            (current_adjusted_close / previous_adjusted_close) - 1
        ) * 100
        source_return_pct = current_row.pct_chg
        return (
            math.isfinite(adjusted_return_pct)
            and math.isfinite(source_return_pct)
            and abs(adjusted_return_pct - source_return_pct)
            <= REPLAY_ADJUSTED_RETURN_TOLERANCE_PCT
        )

    @classmethod
    def _replay_stock_continuous_runs(
        cls,
        rows: list[ReplayStockSourceBar],
    ) -> list[tuple[int, int]]:
        if not rows:
            return []
        runs: list[tuple[int, int]] = []
        run_start = 0
        previous = rows[0]
        for index, row in enumerate(rows[1:], start=1):
            if (
                row.trade_date <= previous.trade_date
                or row.calendar_sequence != previous.calendar_sequence + 1
                or row.calendar_pretrade_date != previous.trade_date
                or not cls._replay_adjusted_return_is_consistent(
                    previous,
                    row,
                )
            ):
                runs.append((run_start, index - run_start))
                run_start = index
            previous = row
        runs.append((run_start, len(rows) - run_start))
        return runs

    @classmethod
    def _replay_aligned_continuous_runs(
        cls,
        rows: list[ReplayAlignedSourceBar],
    ) -> list[tuple[int, int]]:
        if not rows:
            return []
        runs: list[tuple[int, int]] = []
        run_start = 0
        previous = rows[0]
        for index, row in enumerate(rows[1:], start=1):
            stock_is_continuous = (
                row.stock.trade_date > previous.stock.trade_date
                and row.stock.calendar_sequence
                == previous.stock.calendar_sequence + 1
                and row.stock.calendar_pretrade_date
                == previous.stock.trade_date
                and cls._replay_adjusted_return_is_consistent(
                    previous.stock,
                    row.stock,
                )
            )
            benchmark_is_continuous = (
                row.benchmark.trade_date == row.stock.trade_date
                and previous.benchmark.trade_date
                == previous.stock.trade_date
                and row.benchmark.calendar_sequence
                == previous.benchmark.calendar_sequence + 1
                and row.benchmark.calendar_pretrade_date
                == previous.benchmark.trade_date
            )
            if not stock_is_continuous or not benchmark_is_continuous:
                runs.append((run_start, index - run_start))
                run_start = index
            previous = row
        runs.append((run_start, len(rows) - run_start))
        return runs

    @classmethod
    def _select_replay_source_rows(
        cls,
        connection: duckdb.DuckDBPyConnection,
        *,
        required_bars: int,
        benchmark_code: str,
        benchmark_rows: list[ReplayBenchmarkSourceBar],
        rng: random.Random,
        excluded_ts_codes: tuple[str, ...] = (),
        recent_window_end_dates: tuple[date, ...] = (),
    ) -> tuple[str, list[ReplayAlignedSourceBar]]:
        benchmark_by_date = {row.trade_date: row for row in benchmark_rows}
        excluded = {str(code).strip().upper() for code in excluded_ts_codes}
        candidates = []
        for ts_code in cls._replay_length_candidates(connection, required_bars):
            if str(ts_code).strip().upper().endswith(".BJ"):
                continue
            if str(ts_code).strip().upper() in excluded:
                continue
            cls._replay_calendar_exchange(ts_code)
            candidates.append(ts_code)
        rng.shuffle(candidates)
        has_eligible_stock_window = False
        for ts_code in candidates:
            calendar_exchange = cls._replay_calendar_exchange(ts_code)
            source_rows = cls._replay_valid_source_rows(
                connection,
                ts_code,
                calendar_exchange,
            )
            if any(
                length >= required_bars
                for _, length in cls._replay_stock_continuous_runs(source_rows)
            ):
                has_eligible_stock_window = True
            aligned_rows = [
                ReplayAlignedSourceBar(
                    stock=row,
                    benchmark=benchmark_by_date[row.trade_date],
                )
                for row in source_rows
                if row.trade_date in benchmark_by_date
            ]
            valid_runs = [
                (start, length)
                for start, length in cls._replay_aligned_continuous_runs(
                    aligned_rows
                )
                if length >= required_bars
            ]
            window_count = sum(
                length - required_bars + 1 for _, length in valid_runs
            )
            if window_count <= 0:
                continue
            if recent_window_end_dates:
                windows = [
                    aligned_rows[start : start + required_bars]
                    for run_start, run_length in valid_runs
                    for start in range(
                        run_start,
                        run_start + run_length - required_bars + 1,
                    )
                ]
                return ts_code, max(
                    windows,
                    key=lambda window: min(
                        abs((window[-1].stock.trade_date - recent_date).days)
                        for recent_date in recent_window_end_dates
                    ),
                )
            selected_window = rng.randrange(window_count)
            for run_start, run_length in valid_runs:
                run_window_count = run_length - required_bars + 1
                if selected_window < run_window_count:
                    start = run_start + selected_window
                    return ts_code, aligned_rows[start : start + required_bars]
                selected_window -= run_window_count
        if has_eligible_stock_window:
            raise ValueError(
                f"基准指数 {benchmark_code} 无法与股票窗口逐日完整对齐"
            )
        raise ValueError(
            "没有满足数据质量要求的连续演练窗口："
            "需要本所完整交易日历、有效上市区间、唯一日期、合法 OHLC、"
            "同日正复权因子及可核对的复权收益"
        )

    @staticmethod
    def _adjust_replay_price(
        raw_price: Any,
        adjustment_multiplier: float,
    ) -> float:
        adjusted_price = float(raw_price) * adjustment_multiplier
        if not math.isfinite(adjusted_price) or adjusted_price <= 0:
            raise ValueError("演练窗口复权价格无效")
        return adjusted_price

    def create_replay_scenario(
        self,
        *,
        game_length: int,
        benchmark_code: str,
        seed: int | None = None,
        excluded_ts_codes: tuple[str, ...] = (),
        recent_window_end_dates: tuple[date, ...] = (),
    ) -> dict[str, Any]:
        if not self._source_enabled():
            raise FileNotFoundError("历史行情演练需要外部原始库")
        observation_bars = 250
        required_bars = observation_bars + int(game_length)
        connection = self._source_connect()
        try:
            available_tables = self._replay_source_tables(connection)
            required_tables = {
                "stock_daily_bars",
                "stock_adj_factors",
                "stock_instruments",
                "index_daily_bars",
                "trade_calendar",
            }
            missing_tables = sorted(required_tables - available_tables)
            if missing_tables:
                raise ValueError(
                    "历史行情演练缺少必需数据表：" + "、".join(missing_tables)
                )
            resolved_benchmark_code, benchmark_rows = (
                self._resolve_replay_benchmark(
                    connection,
                    benchmark_code=benchmark_code,
                    game_length=int(game_length),
                )
            )
            rng = random.Random(seed) if seed is not None else random.SystemRandom()
            selected_code, rows = self._select_replay_source_rows(
                connection,
                required_bars=required_bars,
                benchmark_code=resolved_benchmark_code,
                benchmark_rows=benchmark_rows,
                rng=rng,
                excluded_ts_codes=excluded_ts_codes,
                recent_window_end_dates=recent_window_end_dates,
            )
            selected_start_date = rows[0].stock.trade_date
            selected_end_date = rows[-1].stock.trade_date
            limit_rows_by_date: dict[Any, tuple[Any, Any]] = {}
            if "limit_list_d" in available_tables:
                limit_rows = connection.execute(
                    """
                    SELECT trade_date, MAX(limit_type), MAX(open_times)
                    FROM limit_list_d
                    WHERE ts_code = ?
                      AND trade_date BETWEEN ? AND ?
                    GROUP BY trade_date
                    HAVING COUNT(*) = 1
                    """,
                    [selected_code, selected_start_date, selected_end_date],
                ).fetchall()
                limit_rows_by_date = {
                    row[0]: (row[1], row[2]) for row in limit_rows
                }
            instrument_name = ""
            if "stock_instruments" in available_tables:
                instrument_row = connection.execute(
                    """
                    SELECT name
                    FROM stock_instruments
                    WHERE ts_code = ?
                    LIMIT 1
                    """,
                    [selected_code],
                ).fetchone()
                instrument_name = str(instrument_row[0] or "") if instrument_row else ""
        finally:
            connection.close()

        week_index = 0
        month_index = 0
        previous_week = None
        previous_month = None
        bars = []
        private_benchmark_bars = []
        anchor_factor = rows[0].stock.adjust_factor
        for sequence, aligned_row in enumerate(rows, start=1):
            row = aligned_row.stock
            benchmark_row = aligned_row.benchmark
            trade_date = row.trade_date
            adjust_factor = row.adjust_factor
            adjustment_multiplier = adjust_factor / anchor_factor
            if (
                not math.isfinite(adjustment_multiplier)
                or adjustment_multiplier <= 0
            ):
                raise ValueError("演练窗口复权乘数无效")
            limit_type, open_times = limit_rows_by_date.get(
                trade_date,
                (None, None),
            )
            week_key = trade_date.isocalendar()[:2]
            month_key = (trade_date.year, trade_date.month)
            if week_key != previous_week:
                week_index += 1
                previous_week = week_key
            if month_key != previous_month:
                month_index += 1
                previous_month = month_key
            bars.append(
                {
                    "sequence": sequence,
                    "tradeDate": trade_date.isoformat(),
                    "open": self._adjust_replay_price(
                        row.open,
                        adjustment_multiplier,
                    ),
                    "high": self._adjust_replay_price(
                        row.high,
                        adjustment_multiplier,
                    ),
                    "low": self._adjust_replay_price(
                        row.low,
                        adjustment_multiplier,
                    ),
                    "close": self._adjust_replay_price(
                        row.close,
                        adjustment_multiplier,
                    ),
                    "preClose": self._adjust_replay_price(
                        row.pre_close,
                        adjustment_multiplier,
                    ),
                    "pctChange": row.pct_chg,
                    "volume": row.volume,
                    "amount": row.amount,
                    "rawOpen": row.open,
                    "rawHigh": row.high,
                    "rawLow": row.low,
                    "rawClose": row.close,
                    "rawPreClose": row.pre_close,
                    "adjustFactor": adjust_factor,
                    "adjustmentMultiplier": adjustment_multiplier,
                    "limitType": (
                        str(limit_type) if limit_type is not None else None
                    ),
                    "openTimes": (
                        int(open_times) if open_times is not None else None
                    ),
                    "weekIndex": week_index,
                    "monthIndex": month_index,
                }
            )
            if sequence >= observation_bars:
                private_benchmark_bars.append(
                    {
                        "sequence": sequence,
                        "tradeDate": trade_date.isoformat(),
                        "open": benchmark_row.open,
                        "high": benchmark_row.high,
                        "low": benchmark_row.low,
                        "close": benchmark_row.close,
                        "preClose": benchmark_row.pre_close,
                        "pctChange": benchmark_row.pct_chg,
                        "volume": benchmark_row.volume,
                        "amount": benchmark_row.amount,
                    }
                )
        symbol, exchange = self._ts_code_to_symbol_exchange(str(selected_code))
        return {
            "sourceDataVersion": self.source_data_version(),
            "tsCode": str(selected_code),
            "symbol": symbol,
            "exchange": exchange,
            "name": instrument_name,
            "observationBars": observation_bars,
            "gameLength": int(game_length),
            "benchmark": {
                "code": resolved_benchmark_code,
                "bars": private_benchmark_bars,
            },
            "priceAdjustment": {
                "method": "scenario-start-total-return",
                "factorSource": "stock_adj_factors.adj_factor",
                "calendarExchange": self._replay_calendar_exchange(
                    str(selected_code)
                ),
                "anchorTradeDate": rows[0].stock.trade_date.isoformat(),
                "anchorFactor": anchor_factor,
            },
            "bars": bars,
        }

    def _ensure_daily_bars_table(self) -> None:
        connection = self._connect()
        try:
            table_exists = bool(
                connection.execute(
                    """
                    SELECT COUNT(*)
                    FROM information_schema.tables
                    WHERE table_name = 'daily_bars'
                    """
                ).fetchone()[0]
            )
            if not table_exists:
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS daily_bars (
                        symbol TEXT NOT NULL,
                        exchange TEXT NOT NULL,
                        interval TEXT NOT NULL,
                        adjust TEXT NOT NULL,
                        trade_date DATE NOT NULL,
                        open DOUBLE NOT NULL,
                        high DOUBLE NOT NULL,
                        low DOUBLE NOT NULL,
                        close DOUBLE NOT NULL,
                        volume DOUBLE NOT NULL,
                        turnover DOUBLE NOT NULL,
                            amplitude DOUBLE,
                            change DOUBLE,
                            pct_chg DOUBLE,
                            turnover_rate DOUBLE,
                        provider TEXT NOT NULL,
                        updated_at TIMESTAMP NOT NULL,
                        PRIMARY KEY(symbol, exchange, interval, adjust, trade_date)
                    )
                    """
                )
                return

            table_info = connection.execute("PRAGMA table_info('daily_bars')").fetchall()
            columns = {row[1] for row in table_info}
            pk_columns = {row[1] for row in table_info if int(row[5] or 0) > 0}
            needs_migration = "adjust" not in columns or "adjust" not in pk_columns
            if not needs_migration:
                if "amplitude" not in columns:
                    connection.execute("ALTER TABLE daily_bars ADD COLUMN amplitude DOUBLE")
                if "change" not in columns:
                    connection.execute("ALTER TABLE daily_bars ADD COLUMN change DOUBLE")
                if "pct_chg" not in columns:
                    connection.execute("ALTER TABLE daily_bars ADD COLUMN pct_chg DOUBLE")
                if "turnover_rate" not in columns:
                    connection.execute("ALTER TABLE daily_bars ADD COLUMN turnover_rate DOUBLE")
                return

            connection.execute("DROP TABLE IF EXISTS daily_bars_migrated")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS daily_bars_migrated (
                    symbol TEXT NOT NULL,
                    exchange TEXT NOT NULL,
                    interval TEXT NOT NULL,
                    adjust TEXT NOT NULL,
                    trade_date DATE NOT NULL,
                    open DOUBLE NOT NULL,
                    high DOUBLE NOT NULL,
                    low DOUBLE NOT NULL,
                    close DOUBLE NOT NULL,
                    volume DOUBLE NOT NULL,
                    turnover DOUBLE NOT NULL,
                        amplitude DOUBLE,
                        change DOUBLE,
                        pct_chg DOUBLE,
                        turnover_rate DOUBLE,
                    provider TEXT NOT NULL,
                    updated_at TIMESTAMP NOT NULL,
                    PRIMARY KEY(symbol, exchange, interval, adjust, trade_date)
                )
                """
            )
            adjust_expr = "COALESCE(NULLIF(adjust, ''), 'qfq')" if "adjust" in columns else "'qfq'"
            connection.execute(
                f"""
                INSERT INTO daily_bars_migrated (
                    symbol,
                    exchange,
                    interval,
                    adjust,
                    trade_date,
                    open,
                    high,
                    low,
                    close,
                    volume,
                    turnover,
                    amplitude,
                    change,
                    pct_chg,
                    turnover_rate,
                    provider,
                    updated_at
                )
                SELECT
                    symbol,
                    exchange,
                    interval,
                    {adjust_expr},
                    trade_date,
                    open,
                    high,
                    low,
                    close,
                    volume,
                    turnover,
                    NULL,
                    NULL,
                    NULL,
                    NULL,
                    provider,
                    updated_at
                FROM daily_bars
                """
            )
            connection.execute("DROP TABLE daily_bars")
            connection.execute("ALTER TABLE daily_bars_migrated RENAME TO daily_bars")
            columns = {row[1] for row in connection.execute("PRAGMA table_info('daily_bars')").fetchall()}
            if "amplitude" not in columns:
                connection.execute("ALTER TABLE daily_bars ADD COLUMN amplitude DOUBLE")
            if "change" not in columns:
                connection.execute("ALTER TABLE daily_bars ADD COLUMN change DOUBLE")
            if "pct_chg" not in columns:
                connection.execute("ALTER TABLE daily_bars ADD COLUMN pct_chg DOUBLE")
            if "turnover_rate" not in columns:
                connection.execute("ALTER TABLE daily_bars ADD COLUMN turnover_rate DOUBLE")
        finally:
            connection.close()

    def _ensure_fundamental_snapshots_table(self) -> None:
        connection = self._connect()
        try:
            table_exists = bool(
                connection.execute(
                    """
                    SELECT COUNT(*)
                    FROM information_schema.tables
                    WHERE table_name = 'fundamental_snapshots'
                    """
                ).fetchone()[0]
            )
            if not table_exists:
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS fundamental_snapshots (
                        as_of_date DATE NOT NULL,
                        source_trade_date DATE,
                        report_period DATE,
                        symbol TEXT NOT NULL,
                        exchange TEXT NOT NULL,
                        order_book_id TEXT NOT NULL,
                        pe_ttm DOUBLE,
                        pb DOUBLE,
                        roe DOUBLE,
                        revenue_growth DOUBLE,
                        gross_margin DOUBLE,
                        operating_cashflow_ratio DOUBLE,
                        debt_to_asset DOUBLE,
                        eps_basic DOUBLE,
                        book_value_per_share DOUBLE,
                        provider TEXT NOT NULL,
                        updated_at TIMESTAMP NOT NULL,
                        PRIMARY KEY(as_of_date, order_book_id)
                    )
                    """
                )
                return

            table_info = connection.execute(
                "PRAGMA table_info('fundamental_snapshots')"
            ).fetchall()
            columns = {row[1] for row in table_info}
            if "eps_basic" not in columns:
                connection.execute(
                    "ALTER TABLE fundamental_snapshots ADD COLUMN eps_basic DOUBLE"
                )
            if "book_value_per_share" not in columns:
                connection.execute(
                    "ALTER TABLE fundamental_snapshots ADD COLUMN book_value_per_share DOUBLE"
                )
        finally:
            connection.close()

    def _ensure_adjust_factors_table(self) -> None:
        connection = self._connect()
        try:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS adjust_factors (
                    symbol TEXT NOT NULL,
                    exchange TEXT NOT NULL,
                    trade_date DATE NOT NULL,
                    factor DOUBLE NOT NULL,
                    provider TEXT NOT NULL,
                    updated_at TIMESTAMP NOT NULL,
                    PRIMARY KEY(symbol, exchange, trade_date)
                )
                """
            )
        finally:
            connection.close()
