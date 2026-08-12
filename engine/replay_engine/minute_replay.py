from __future__ import annotations

import math
import random
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable

import duckdb

from .tdx_market_cache import TDX_HOSTS, _FailoverTdxClient


MINUTE_OBSERVATION_BARS = 250
TDX_PAGE_SIZE = 800
TDX_MAX_BARS = 8000
TDX_5MIN_MAX_BARS = 23520
HYBRID_STEP_MINUTES = 5
HYBRID_BARS_PER_DAY = 48


def _row_value(row: Any, key: str) -> Any:
    if isinstance(row, dict):
        return row.get(key)
    return getattr(row, key, None)


def _normalize_timestamp(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value.replace(second=0, microsecond=0)
    return datetime.fromisoformat(str(value)).replace(second=0, microsecond=0)


def _normalize_rows(rows: Iterable[Any]) -> dict[datetime, dict[str, Any]]:
    normalized: dict[datetime, dict[str, Any]] = {}
    for row in rows:
        timestamp = _normalize_timestamp(
            _row_value(row, "datetime") or _row_value(row, "date")
        )
        values = {
            "datetime": timestamp,
            "open": float(_row_value(row, "open")),
            "high": float(_row_value(row, "high")),
            "low": float(_row_value(row, "low")),
            "close": float(_row_value(row, "close")),
            "volume": float(_row_value(row, "vol") or _row_value(row, "volume") or 0),
            "amount": float(_row_value(row, "amount") or 0),
            "adjust_factor": float(
                _row_value(row, "adjust_factor")
                or _row_value(row, "adj_factor")
                or 1
            ),
        }
        if not all(
            math.isfinite(values[field]) and values[field] > 0
            for field in ("open", "high", "low", "close")
        ):
            continue
        if values["high"] < max(values["open"], values["close"]):
            continue
        if values["low"] > min(values["open"], values["close"]):
            continue
        normalized[timestamp] = values
    return normalized


def _apply_daily_adjustment(
    rows: dict[datetime, dict[str, Any]],
    factors_by_day: dict[str, float],
    anchor_factor: float,
) -> None:
    for timestamp, row in rows.items():
        factor = factors_by_day.get(timestamp.date().isoformat())
        if factor is None:
            continue
        multiplier = factor / anchor_factor
        for field in ("open", "high", "low", "close"):
            row[field] *= multiplier


def _public_bar(row: dict[str, Any], sequence: int, previous_close: float | None) -> dict[str, Any]:
    timestamp = row["datetime"]
    pre_close = previous_close if previous_close and previous_close > 0 else row["open"]
    pct_change = ((row["close"] / pre_close) - 1) * 100 if pre_close else 0
    return {
        "sequence": sequence,
        "tradeDate": timestamp.date().isoformat(),
        "tradeTime": timestamp.strftime("%Y-%m-%d %H:%M"),
        "open": row["open"],
        "high": row["high"],
        "low": row["low"],
        "close": row["close"],
        "preClose": pre_close,
        "pctChange": pct_change,
        "volume": row["volume"],
        "amount": row["amount"],
        "weekIndex": timestamp.isocalendar().week,
        "monthIndex": timestamp.month,
    }


def build_minute_replay_scenario(
    *,
    stock_rows: Iterable[Any],
    benchmark_rows: Iterable[Any],
    ts_code: str,
    name: str,
    benchmark_code: str,
    game_length: int,
    seed: int | None = None,
    source_data_version: str = "tdx-minute-1m",
) -> dict[str, Any]:
    required_bars = MINUTE_OBSERVATION_BARS + int(game_length)
    stock = _normalize_rows(stock_rows)
    benchmark = _normalize_rows(benchmark_rows)
    aligned_times = sorted(set(stock) & set(benchmark))
    if len(aligned_times) < required_bars:
        raise ValueError(
            f"分钟行情不足：需要 {required_bars} 根对齐 K 线，当前只有 {len(aligned_times)} 根"
        )
    maximum_start = len(aligned_times) - required_bars
    rng = random.Random(seed) if seed is not None else random.SystemRandom()
    start = rng.randrange(maximum_start + 1) if maximum_start else 0
    selected_times = aligned_times[start : start + required_bars]

    bars: list[dict[str, Any]] = []
    benchmark_bars: list[dict[str, Any]] = []
    previous_stock_close: float | None = None
    previous_benchmark_close: float | None = None
    for sequence, timestamp in enumerate(selected_times, start=1):
        stock_bar = _public_bar(stock[timestamp], sequence, previous_stock_close)
        benchmark_bar = _public_bar(
            benchmark[timestamp], sequence, previous_benchmark_close
        )
        bars.append(stock_bar)
        if sequence >= MINUTE_OBSERVATION_BARS:
            benchmark_bars.append(benchmark_bar)
        previous_stock_close = stock_bar["close"]
        previous_benchmark_close = benchmark_bar["close"]

    symbol, exchange_suffix = str(ts_code).upper().split(".", 1)
    return {
        "sourceDataVersion": source_data_version,
        "tsCode": str(ts_code).upper(),
        "symbol": symbol,
        "exchange": "SSE" if exchange_suffix == "SH" else "SZSE",
        "name": name,
        "interval": "1m",
        "observationBars": MINUTE_OBSERVATION_BARS,
        "gameLength": int(game_length),
        "benchmark": {
            "code": str(benchmark_code).upper(),
            "bars": benchmark_bars,
        },
        "bars": bars,
    }


def build_hybrid_replay_scenario(
    *,
    stock_daily_rows: Iterable[Any],
    benchmark_daily_rows: Iterable[Any],
    stock_minute_rows: Iterable[Any],
    benchmark_minute_rows: Iterable[Any],
    ts_code: str,
    name: str,
    benchmark_code: str,
    training_days: int,
    seed: int | None = None,
    recent_window_end_dates: tuple[date, ...] = (),
    source_data_version: str = "tdx-hybrid-5m",
) -> dict[str, Any]:
    stock_daily = _normalize_rows(stock_daily_rows)
    benchmark_daily = _normalize_rows(benchmark_daily_rows)
    stock_minute = _normalize_rows(stock_minute_rows)
    benchmark_minute = _normalize_rows(benchmark_minute_rows)

    aligned_daily_times = sorted(set(stock_daily) & set(benchmark_daily))
    aligned_minute_times = sorted(set(stock_minute) & set(benchmark_minute))
    minute_days: dict[str, list[datetime]] = defaultdict(list)
    for timestamp in aligned_minute_times:
        minute_days[timestamp.date().isoformat()].append(timestamp)
    eligible_days = sorted(
        day
        for day, timestamps in minute_days.items()
        if len(timestamps) >= HYBRID_BARS_PER_DAY
        and sum(1 for timestamp in aligned_daily_times if timestamp.date().isoformat() < day)
        >= MINUTE_OBSERVATION_BARS
    )
    if len(eligible_days) < int(training_days):
        raise ValueError(
            f"日内行情不足：需要 {training_days} 个交易日，当前只有 {len(eligible_days)} 个"
        )
    maximum_start = len(eligible_days) - int(training_days)
    rng = random.Random(seed) if seed is not None else random.SystemRandom()
    candidates = list(range(maximum_start + 1))
    if recent_window_end_dates:
        minimum_gap_days = max(int(training_days) * 2, 30)
        separated_candidates = [
            candidate
            for candidate in candidates
            if min(
                abs(
                    (
                        datetime.fromisoformat(
                            eligible_days[candidate + int(training_days) - 1]
                        ).date()
                        - recent_date
                    ).days
                )
                for recent_date in recent_window_end_dates
            )
            >= minimum_gap_days
        ]
        if separated_candidates:
            candidates = separated_candidates
    start = rng.choice(candidates)
    selected_days = eligible_days[start : start + int(training_days)]
    selected_times = [
        timestamp
        for day in selected_days
        for timestamp in minute_days[day]
    ]
    first_day = selected_days[0]
    daily_context_times = [
        timestamp
        for timestamp in aligned_daily_times
        if timestamp.date().isoformat() < first_day
    ][-MINUTE_OBSERVATION_BARS:]
    if len(daily_context_times) < MINUTE_OBSERVATION_BARS:
        raise ValueError("日线背景不足 250 根")

    factors_by_day = {
        timestamp.date().isoformat(): row["adjust_factor"]
        for timestamp, row in stock_daily.items()
        if math.isfinite(row["adjust_factor"]) and row["adjust_factor"] > 0
    }
    anchor_factor = stock_daily[daily_context_times[0]]["adjust_factor"]
    if not factors_by_day or not math.isfinite(anchor_factor) or anchor_factor <= 0:
        raise ValueError("混合演练缺少有效的日线复权因子")
    _apply_daily_adjustment(stock_daily, factors_by_day, anchor_factor)
    _apply_daily_adjustment(stock_minute, factors_by_day, anchor_factor)

    bars: list[dict[str, Any]] = []
    previous_stock_close: float | None = None
    for sequence, timestamp in enumerate(daily_context_times, start=1):
        bar = _public_bar(stock_daily[timestamp], sequence, previous_stock_close)
        bar.pop("tradeTime", None)
        bars.append(bar)
        previous_stock_close = bar["close"]
    for sequence, timestamp in enumerate(
        selected_times,
        start=MINUTE_OBSERVATION_BARS + 1,
    ):
        bar = _public_bar(stock_minute[timestamp], sequence, previous_stock_close)
        bars.append(bar)
        previous_stock_close = bar["close"]

    benchmark_bars: list[dict[str, Any]] = []
    benchmark_context_time = daily_context_times[-1]
    benchmark_context = _public_bar(
        benchmark_daily[benchmark_context_time],
        MINUTE_OBSERVATION_BARS,
        None,
    )
    benchmark_context.pop("tradeTime", None)
    benchmark_bars.append(benchmark_context)
    previous_benchmark_close = benchmark_context["close"]
    for sequence, timestamp in enumerate(
        selected_times,
        start=MINUTE_OBSERVATION_BARS + 1,
    ):
        bar = _public_bar(
            benchmark_minute[timestamp],
            sequence,
            previous_benchmark_close,
        )
        benchmark_bars.append(bar)
        previous_benchmark_close = bar["close"]

    symbol, exchange_suffix = str(ts_code).upper().split(".", 1)
    return {
        "sourceDataVersion": source_data_version,
        "tsCode": str(ts_code).upper(),
        "symbol": symbol,
        "exchange": "SSE" if exchange_suffix == "SH" else "SZSE",
        "name": name,
        "interval": "hybrid",
        "stepMinutes": HYBRID_STEP_MINUTES,
        "priceAdjustment": {
            "method": "scenario-start-total-return",
            "factorSource": "stock_adj_factors.adj_factor",
            "anchorTradeDate": daily_context_times[0].date().isoformat(),
            "anchorFactor": anchor_factor,
        },
        "trainingDays": int(training_days),
        "observationBars": MINUTE_OBSERVATION_BARS,
        "gameLength": len(selected_times),
        "benchmark": {
            "code": str(benchmark_code).upper(),
            "bars": benchmark_bars,
        },
        "bars": bars,
    }


class MinuteReplayStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def save(self, instrument_code: str, instrument_type: str, rows: Iterable[Any]) -> None:
        normalized = _normalize_rows(rows)
        connection = duckdb.connect(str(self.path))
        try:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS minute_bars (
                    instrument_code VARCHAR NOT NULL,
                    instrument_type VARCHAR NOT NULL,
                    bar_time TIMESTAMP NOT NULL,
                    open DOUBLE NOT NULL,
                    high DOUBLE NOT NULL,
                    low DOUBLE NOT NULL,
                    close DOUBLE NOT NULL,
                    volume DOUBLE NOT NULL,
                    amount DOUBLE NOT NULL,
                    PRIMARY KEY (instrument_code, instrument_type, bar_time)
                )
                """
            )
            values = [
                (
                    instrument_code,
                    instrument_type,
                    timestamp,
                    row["open"],
                    row["high"],
                    row["low"],
                    row["close"],
                    row["volume"],
                    row["amount"],
                )
                for timestamp, row in normalized.items()
            ]
            connection.execute("BEGIN TRANSACTION")
            try:
                connection.execute(
                    """
                    DELETE FROM minute_bars
                    WHERE instrument_code = ? AND instrument_type = ?
                    """,
                    [instrument_code, instrument_type],
                )
                if values:
                    connection.executemany(
                        """
                        INSERT INTO minute_bars VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        values,
                    )
                connection.execute("COMMIT")
            except Exception:
                connection.execute("ROLLBACK")
                raise
        finally:
            connection.close()

    def merge(
        self,
        instrument_code: str,
        instrument_type: str,
        rows: Iterable[Any],
    ) -> None:
        normalized = _normalize_rows(rows)
        connection = duckdb.connect(str(self.path))
        try:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS minute_bars (
                    instrument_code VARCHAR NOT NULL,
                    instrument_type VARCHAR NOT NULL,
                    bar_time TIMESTAMP NOT NULL,
                    open DOUBLE NOT NULL,
                    high DOUBLE NOT NULL,
                    low DOUBLE NOT NULL,
                    close DOUBLE NOT NULL,
                    volume DOUBLE NOT NULL,
                    amount DOUBLE NOT NULL,
                    PRIMARY KEY (instrument_code, instrument_type, bar_time)
                )
                """
            )
            values = [
                (
                    instrument_code,
                    instrument_type,
                    timestamp,
                    row["open"],
                    row["high"],
                    row["low"],
                    row["close"],
                    row["volume"],
                    row["amount"],
                )
                for timestamp, row in normalized.items()
            ]
            if values:
                connection.executemany(
                    """
                    INSERT INTO minute_bars VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (instrument_code, instrument_type, bar_time)
                    DO UPDATE SET
                        open = EXCLUDED.open,
                        high = EXCLUDED.high,
                        low = EXCLUDED.low,
                        close = EXCLUDED.close,
                        volume = EXCLUDED.volume,
                        amount = EXCLUDED.amount
                    """,
                    values,
                )
        finally:
            connection.close()

    def load(self, instrument_code: str, instrument_type: str) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        connection = duckdb.connect(str(self.path))
        try:
            table_exists = connection.execute(
                """
                SELECT COUNT(*)
                FROM information_schema.tables
                WHERE table_name = 'minute_bars'
                """
            ).fetchone()[0]
            if not table_exists:
                return []
            rows = connection.execute(
                """
                SELECT bar_time, open, high, low, close, volume, amount
                FROM minute_bars
                WHERE instrument_code = ? AND instrument_type = ?
                ORDER BY bar_time
                """,
                [instrument_code, instrument_type],
            ).fetchall()
        finally:
            connection.close()
        return [
            {
                "datetime": row[0],
                "open": row[1],
                "high": row[2],
                "low": row[3],
                "close": row[4],
                "vol": row[5],
                "amount": row[6],
            }
            for row in rows
        ]

    def mark_full_history(self, instrument_code: str, instrument_type: str) -> None:
        connection = duckdb.connect(str(self.path))
        try:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS minute_history_sync (
                    instrument_code VARCHAR NOT NULL,
                    instrument_type VARCHAR NOT NULL,
                    synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (instrument_code, instrument_type)
                )
                """
            )
            connection.execute(
                """
                INSERT INTO minute_history_sync (instrument_code, instrument_type, synced_at)
                VALUES (?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT (instrument_code, instrument_type)
                DO UPDATE SET synced_at = EXCLUDED.synced_at
                """,
                [instrument_code, instrument_type],
            )
        finally:
            connection.close()

    def has_full_history(self, instrument_code: str, instrument_type: str) -> bool:
        if not self.path.exists():
            return False
        connection = duckdb.connect(str(self.path))
        try:
            table_exists = connection.execute(
                """
                SELECT COUNT(*)
                FROM information_schema.tables
                WHERE table_name = 'minute_history_sync'
                """
            ).fetchone()[0]
            if not table_exists:
                return False
            return bool(
                connection.execute(
                    """
                    SELECT COUNT(*)
                    FROM minute_history_sync
                    WHERE instrument_code = ? AND instrument_type = ?
                    """,
                    [instrument_code, instrument_type],
                ).fetchone()[0]
            )
        finally:
            connection.close()

    def statistics(self) -> dict[str, int]:
        empty = {
            "oneMinuteInstrumentCount": 0,
            "oneMinuteBarCount": 0,
            "fiveMinuteInstrumentCount": 0,
            "fiveMinuteBarCount": 0,
        }
        if not self.path.exists():
            return empty
        connection = duckdb.connect(str(self.path))
        try:
            table_exists = connection.execute(
                """
                SELECT COUNT(*)
                FROM information_schema.tables
                WHERE table_name = 'minute_bars'
                """
            ).fetchone()[0]
            if not table_exists:
                return empty
            rows = connection.execute(
                """
                SELECT
                    CASE WHEN instrument_type LIKE '%-5m' THEN '5m' ELSE '1m' END AS granularity,
                    COUNT(DISTINCT instrument_code),
                    COUNT(*)
                FROM minute_bars
                GROUP BY granularity
                """
            ).fetchall()
        finally:
            connection.close()
        result = dict(empty)
        for granularity, instrument_count, bar_count in rows:
            prefix = "fiveMinute" if granularity == "5m" else "oneMinute"
            result[f"{prefix}InstrumentCount"] = int(instrument_count)
            result[f"{prefix}BarCount"] = int(bar_count)
        return result


class TdxMinuteReplayProvider:
    def __init__(self, cache_path: Path):
        self.store = MinuteReplayStore(cache_path)

    def cache_snapshot(self) -> dict[str, Any]:
        try:
            storage_bytes = int(self.store.path.stat().st_size)
        except FileNotFoundError:
            storage_bytes = 0
        return {
            "statistics": self.store.statistics(),
            "storageBytes": storage_bytes,
        }

    @staticmethod
    def _market_for_code(ts_code: str):
        from easy_tdx.models.enums import Market

        return Market.SH if str(ts_code).upper().endswith(".SH") else Market.SZ

    @staticmethod
    def _symbol(ts_code: str) -> str:
        return str(ts_code).split(".", 1)[0]

    def _fetch(
        self,
        client: Any,
        ts_code: str,
        instrument_type: str,
        *,
        category: Any,
        maximum_bars: int,
        bar_time: str = "end",
    ) -> list[dict[str, Any]]:
        market = self._market_for_code(ts_code)
        symbol = self._symbol(ts_code)
        frames = []
        for start in range(0, maximum_bars, TDX_PAGE_SIZE):
            try:
                if instrument_type.startswith("index"):
                    frame = client.get_index_bars(
                        market,
                        symbol,
                        category,
                        start,
                        TDX_PAGE_SIZE,
                        bar_time=bar_time,
                    )
                else:
                    frame = client.get_security_bars(
                        market,
                        symbol,
                        category,
                        start,
                        TDX_PAGE_SIZE,
                        bar_time=bar_time,
                    )
            except Exception:
                if frames:
                    break
                raise
            if frame is None or frame.empty:
                break
            frames.extend(frame.to_dict("records"))
            if len(frame) < TDX_PAGE_SIZE:
                break
        if not frames:
            raise ValueError(f"通达信未返回 {ts_code} 的行情")
        self.store.merge(ts_code, instrument_type, frames)
        if instrument_type.endswith("-5m") and maximum_bars >= TDX_5MIN_MAX_BARS:
            self.store.mark_full_history(ts_code, instrument_type)
        return self.store.load(ts_code, instrument_type)

    @staticmethod
    def _hybrid_download_limit(_training_days: int) -> int:
        return TDX_5MIN_MAX_BARS

    @staticmethod
    def _minute_download_limit(game_length: int) -> int:
        requested = MINUTE_OBSERVATION_BARS + int(game_length) + TDX_PAGE_SIZE
        return min(requested, TDX_MAX_BARS)

    @staticmethod
    def _build_hybrid(
        *,
        stock_daily_rows: Iterable[Any],
        benchmark_daily_rows: Iterable[Any],
        stock_rows: Iterable[Any],
        benchmark_rows: Iterable[Any],
        ts_code: str,
        name: str,
        benchmark_code: str,
        game_length: int,
        seed: int | None,
        source_data_version: str,
        recent_window_end_dates: tuple[date, ...] = (),
    ) -> dict[str, Any]:
        return build_hybrid_replay_scenario(
            stock_daily_rows=stock_daily_rows,
            benchmark_daily_rows=benchmark_daily_rows,
            stock_minute_rows=stock_rows,
            benchmark_minute_rows=benchmark_rows,
            ts_code=ts_code,
            name=name,
            benchmark_code=benchmark_code,
            training_days=game_length,
            seed=seed,
            source_data_version=source_data_version,
            recent_window_end_dates=recent_window_end_dates,
        )

    def create_scenario(
        self,
        *,
        ts_code: str,
        name: str,
        benchmark_code: str,
        game_length: int,
        seed: int | None,
        hybrid: bool = False,
        stock_daily_rows: Iterable[Any] | None = None,
        benchmark_daily_rows: Iterable[Any] | None = None,
        recent_window_end_dates: tuple[date, ...] = (),
    ) -> dict[str, Any]:
        stock_type = "stock-5m" if hybrid else "stock"
        benchmark_type = "index-5m" if hybrid else "index"
        stock_rows = self.store.load(ts_code, stock_type)
        benchmark_rows = self.store.load(benchmark_code, benchmark_type)
        local_stock_daily = (
            list(stock_daily_rows)
            if stock_daily_rows is not None
            else self.store.load(ts_code, "stock-day")
        )
        local_benchmark_daily = (
            list(benchmark_daily_rows)
            if benchmark_daily_rows is not None
            else self.store.load(benchmark_code, "index-day")
        )
        cache_error: Exception | None = None
        hybrid_cache_complete = (
            self.store.has_full_history(ts_code, stock_type)
            and self.store.has_full_history(benchmark_code, benchmark_type)
        )
        try:
            if hybrid and not hybrid_cache_complete:
                raise ValueError("五分钟缓存尚未回填到近两年")
            if hybrid:
                return self._build_hybrid(
                    stock_daily_rows=local_stock_daily,
                    benchmark_daily_rows=local_benchmark_daily,
                    stock_rows=stock_rows,
                    benchmark_rows=benchmark_rows,
                    ts_code=ts_code,
                    name=name,
                    benchmark_code=benchmark_code,
                    game_length=game_length,
                    seed=seed,
                    source_data_version=f"tdx-hybrid-cache:{self.store.path}",
                    recent_window_end_dates=recent_window_end_dates,
                )
            return build_minute_replay_scenario(
                stock_rows=stock_rows,
                benchmark_rows=benchmark_rows,
                ts_code=ts_code,
                name=name,
                benchmark_code=benchmark_code,
                game_length=game_length,
                seed=seed,
                source_data_version=f"tdx-minute-cache:{self.store.path}",
            )
        except ValueError as exc:
            cache_error = exc

        try:
            from easy_tdx.client import TdxClient
        except ImportError as exc:
            raise RuntimeError("分钟演练依赖 easy-tdx，请先安装项目 Python 依赖") from exc

        from easy_tdx.models.enums import KlineCategory
        from easy_tdx.config import get_known_hosts

        hosts = tuple(dict.fromkeys([*TDX_HOSTS, *get_known_hosts()]))
        client = _FailoverTdxClient(TdxClient, hosts)
        last_error: Exception | None = None
        try:
            required_minute_rows = MINUTE_OBSERVATION_BARS + int(game_length)
            stock_needs_download = (
                not self.store.has_full_history(ts_code, stock_type)
                if hybrid
                else len(stock_rows) < required_minute_rows
            )
            benchmark_needs_download = (
                not self.store.has_full_history(benchmark_code, benchmark_type)
                if hybrid
                else len(benchmark_rows) < required_minute_rows
            )
            if not stock_needs_download and not benchmark_needs_download:
                stock_needs_download = True
                benchmark_needs_download = True
            if stock_needs_download:
                stock_rows = self._fetch(
                    client,
                    ts_code,
                    stock_type,
                    category=KlineCategory.MIN_5 if hybrid else KlineCategory.MIN_1,
                    maximum_bars=(
                        self._hybrid_download_limit(game_length)
                        if hybrid
                        else self._minute_download_limit(game_length)
                    ),
                    bar_time="start" if hybrid else "end",
                )
            if benchmark_needs_download:
                benchmark_rows = self._fetch(
                    client,
                    benchmark_code,
                    benchmark_type,
                    category=KlineCategory.MIN_5 if hybrid else KlineCategory.MIN_1,
                    maximum_bars=(
                        self._hybrid_download_limit(game_length)
                        if hybrid
                        else self._minute_download_limit(game_length)
                    ),
                    bar_time="start" if hybrid else "end",
                )
            if hybrid:
                if not local_stock_daily:
                    local_stock_daily = self._fetch(
                        client,
                        ts_code,
                        "stock-day",
                        category=KlineCategory.DAY,
                        maximum_bars=TDX_PAGE_SIZE,
                    )
                if not local_benchmark_daily:
                    local_benchmark_daily = self._fetch(
                        client,
                        benchmark_code,
                        "index-day",
                        category=KlineCategory.DAY,
                        maximum_bars=TDX_PAGE_SIZE,
                    )
        except Exception as exc:
            last_error = exc

        if last_error is not None:
            raise ValueError(
                "分钟行情下载失败且本地缓存不足："
                f"通达信错误={last_error}；"
                f"缓存错误={cache_error or '缓存数据不足'}"
            ) from last_error
        if hybrid:
            return self._build_hybrid(
                stock_daily_rows=local_stock_daily,
                benchmark_daily_rows=local_benchmark_daily,
                stock_rows=stock_rows,
                benchmark_rows=benchmark_rows,
                ts_code=ts_code,
                name=name,
                benchmark_code=benchmark_code,
                game_length=game_length,
                seed=seed,
                source_data_version=f"tdx-hybrid-5m:{self.store.path}",
                recent_window_end_dates=recent_window_end_dates,
            )
        return build_minute_replay_scenario(
            stock_rows=stock_rows,
            benchmark_rows=benchmark_rows,
            ts_code=ts_code,
            name=name,
            benchmark_code=benchmark_code,
            game_length=game_length,
            seed=seed,
            source_data_version=f"tdx-minute-1m:{self.store.path}",
        )
