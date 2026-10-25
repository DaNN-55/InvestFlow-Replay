from __future__ import annotations

import math
import random
from collections import defaultdict
from contextlib import contextmanager, nullcontext
from datetime import date, datetime, time
from pathlib import Path
from threading import Condition, RLock
from typing import Any, Iterable

import duckdb

from .tdx_market_cache import TDX_HOSTS, _FailoverTdxClient
from .replay_cache_policy import market_now


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
        pre_close = _row_value(row, "pre_close")
        if pre_close is not None and math.isfinite(float(pre_close)) and float(pre_close) > 0:
            values["raw_daily_pre_close"] = float(pre_close)
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
            row[f"raw_{field}"] = row[field]
            row[field] *= multiplier
        row["adjustment_multiplier"] = multiplier
        row["adjusted_amount"] = row["amount"] * multiplier


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
        **{public: row[private] for private, public in (
            ("raw_open", "rawOpen"), ("raw_high", "rawHigh"),
            ("raw_low", "rawLow"), ("raw_close", "rawClose"),
            ("raw_daily_pre_close", "rawDailyPreClose"),
            ("adjustment_multiplier", "adjustmentMultiplier"),
        ) if private in row},
        **(
            {"adjustedAmount": row["adjusted_amount"]}
            if "adjusted_amount" in row
            else {}
        ),
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

    # Use the exchange's daily reference, never the previous five-minute close.
    # These inputs contain only the day's pre-close and the preceding daily close.
    previous_daily = None
    day_references = {}
    for timestamp in sorted(stock_daily):
        row = stock_daily[timestamp]
        reference = row.get("raw_daily_pre_close")
        if reference is None and previous_daily is not None:
            reference = previous_daily["raw_close"] * previous_daily["adjust_factor"] / row["adjust_factor"]
        if reference is not None:
            day_references[timestamp.date().isoformat()] = reference
        previous_daily = row
    for timestamp, row in stock_minute.items():
        reference = day_references.get(timestamp.date().isoformat())
        if reference is not None:
            row["raw_daily_pre_close"] = reference

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

    @staticmethod
    def _refresh_schema(connection) -> None:
        connection.execute("""CREATE TABLE IF NOT EXISTS minute_refresh_state (
            instrument_code VARCHAR NOT NULL, instrument_type VARCHAR NOT NULL,
            last_attempt_at TIMESTAMP NOT NULL, last_success_at TIMESTAMP, last_error VARCHAR NOT NULL DEFAULT '',
            resume_from TIMESTAMP,
            PRIMARY KEY (instrument_code, instrument_type))""")
        connection.execute("ALTER TABLE minute_refresh_state ADD COLUMN IF NOT EXISTS resume_from TIMESTAMP")

    def refresh_boundary(self, code: str, kind: str, latest: datetime | None) -> datetime | None:
        """Keep the pre-refresh boundary across interruptions, even after newer pages were saved."""
        with duckdb.connect(str(self.path)) as connection:
            self._refresh_schema(connection)
            row = connection.execute("SELECT resume_from FROM minute_refresh_state WHERE instrument_code = ? AND instrument_type = ?", [code, kind]).fetchone()
            if row and row[0] is not None:
                return row[0]
            if latest is not None:
                connection.execute("""INSERT INTO minute_refresh_state (instrument_code, instrument_type, last_attempt_at, resume_from)
                    VALUES (?, ?, ?, ?) ON CONFLICT (instrument_code, instrument_type) DO UPDATE SET
                    resume_from = EXCLUDED.resume_from""", [code, kind, market_now(), latest])
            return latest

    def record_refresh(self, code: str, kind: str, *, error: str = "") -> None:
        with duckdb.connect(str(self.path)) as connection:
            self._refresh_schema(connection)
            timestamp = market_now()
            connection.execute("""INSERT INTO minute_refresh_state (instrument_code, instrument_type, last_attempt_at, last_success_at, last_error) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (instrument_code, instrument_type) DO UPDATE SET
                last_attempt_at = EXCLUDED.last_attempt_at,
                last_success_at = COALESCE(EXCLUDED.last_success_at, minute_refresh_state.last_success_at),
                last_error = EXCLUDED.last_error,
                resume_from = CASE WHEN EXCLUDED.last_error = '' THEN NULL ELSE minute_refresh_state.resume_from END""", [code, kind, timestamp, timestamp if not error else None, error])

    def history_inventory(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        with duckdb.connect(str(self.path)) as connection:
            tables = {row[0] for row in connection.execute("SELECT table_name FROM information_schema.tables").fetchall()}
            histories = {tuple(row[:2]): row[2] for row in connection.execute("SELECT instrument_code, instrument_type, synced_at FROM minute_history_sync").fetchall()} if 'minute_history_sync' in tables else {}
            refresh = {tuple(row[:2]): row[2:] for row in connection.execute("SELECT instrument_code, instrument_type, last_attempt_at, last_success_at, last_error FROM minute_refresh_state").fetchall()} if 'minute_refresh_state' in tables else {}
            rows = connection.execute("SELECT instrument_code, instrument_type, COUNT(*), MAX(bar_time) FROM minute_bars GROUP BY instrument_code, instrument_type").fetchall() if 'minute_bars' in tables else []
        result = []
        for code, kind, count, latest in rows:
            attempted, succeeded, error = refresh.get((code, kind), (None, histories.get((code, kind)), ''))
            result.append({"code": code, "kind": kind, "barCount": int(count), "latestTime": latest,
                "full": (code, kind) in histories, "lastAttemptAt": attempted, "lastSuccessAt": succeeded, "error": error})
        present = {(item['code'], item['kind']) for item in result}
        for (code, kind), (attempted, succeeded, error) in refresh.items():
            if (code, kind) not in present:
                result.append({'code': code, 'kind': kind, 'barCount': 0, 'latestTime': None,
                    'full': False, 'lastAttemptAt': attempted, 'lastSuccessAt': succeeded, 'error': error})
        return result

    def history_current(self, code: str, kind: str, target_date: date | None = None) -> bool:
        item = next((item for item in self.history_inventory() if item['code'] == code and item['kind'] == kind), None)
        return self.item_current(item, target_date)

    @staticmethod
    def item_current(item: dict[str, Any] | None, target_date: date | None = None) -> bool:
        if not item or not item['full'] or item['error'] or item['latestTime'] is None:
            return False
        latest = item['latestTime']
        return target_date is None or latest.date() > target_date or (latest.date() == target_date and latest.time() >= time(14, 55))

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
                VALUES (?, ?, ?)
                ON CONFLICT (instrument_code, instrument_type)
                DO UPDATE SET synced_at = EXCLUDED.synced_at
                """,
                [instrument_code, instrument_type, market_now()],
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
        self._priority = Condition()
        self._foreground = 0
        self._io = RLock()
        self.required_trade_date: date | None = None

    @contextmanager
    def _background_slot(self):
        with self._priority:
            self._priority.wait_for(lambda: self._foreground == 0)
            self._io.acquire()
        try:
            yield
        finally:
            self._io.release()

    def create_scenario(self, **options) -> dict[str, Any]:
        with self._priority:
            self._foreground += 1
        try:
            with self._io:
                return self._create_scenario(**options)
        finally:
            with self._priority:
                self._foreground -= 1
                self._priority.notify_all()

    @staticmethod
    def download_client():
        from .tdx_api import TdxClient, get_known_hosts
        hosts = tuple(dict.fromkeys([*TDX_HOSTS, *get_known_hosts()]))
        return _FailoverTdxClient(TdxClient, hosts)

    def prefetch(self, ts_code: str, benchmark_code: str, *, client=None) -> None:
        from .tdx_api import KlineCategory

        with nullcontext(client) if client is not None else self.download_client() as client:
            for code, kind in [(ts_code, "stock-5m"), (benchmark_code, "index-5m")]:
                with self._background_slot():
                    current = self.store.history_current(code, kind, self.required_trade_date)
                    complete = self.store.has_full_history(code, kind)
                if not current:
                    self._fetch(client, code, kind, category=KlineCategory.MIN_5,
                                maximum_bars=TDX_5MIN_MAX_BARS, bar_time="start", background=True, incremental=complete)
                    with self._background_slot():
                        current = self.store.history_current(code, kind, self.required_trade_date)
                    if not current:
                        message = "五分钟缓存尚未覆盖基准的已收盘数据日"
                        with self._background_slot():
                            self.store.record_refresh(code, kind, error=message)
                        raise ValueError(message)

    def prefetched_codes(self, benchmark_code: str) -> set[str]:
        with self._background_slot():
            inventory = self.store.history_inventory()
            benchmark = next((item for item in inventory if item['code'] == benchmark_code and item['kind'] == 'index-5m'), None)
            if not self.store.item_current(benchmark, self.required_trade_date):
                return set()
            return {item['code'] for item in inventory if item['kind'] == 'stock-5m' and self.store.item_current(item, self.required_trade_date)}

    def refresh_cached(self) -> dict[str, Any]:
        from .tdx_api import KlineCategory
        with self._background_slot():
            inventory = self.store.history_inventory()
        stale = [item for item in inventory if item['kind'].endswith('-5m') and not self.store.item_current(item, self.required_trade_date)]
        if not stale:
            return {'state': 'ready', 'completed': 0, 'total': 0, 'message': '已有五分钟缓存无需续更', 'error': ''}
        completed = 0
        errors = []
        with self.download_client() as client:
            for item in stale:
                try:
                    self._fetch(client, item['code'], item['kind'], category=KlineCategory.MIN_5,
                        maximum_bars=TDX_5MIN_MAX_BARS, bar_time='start', background=True, incremental=item['full'])
                    with self._background_slot():
                        current = self.store.history_current(item['code'], item['kind'], self.required_trade_date)
                    if not current:
                        raise ValueError('五分钟缓存尚未覆盖基准的已收盘数据日')
                    completed += 1
                except Exception as exc:
                    with self._background_slot():
                        self.store.record_refresh(item['code'], item['kind'], error=str(exc))
                    errors.append(str(exc))
        return {'state': 'partial' if errors else 'ready', 'completed': completed, 'total': len(stale),
            'message': f'五分钟续更完成 {completed}/{len(stale)} 项', 'error': '部分五分钟资源更新失败，将自动重试' if errors else ''}

    def cache_snapshot(self) -> dict[str, Any]:
        try:
            storage_bytes = int(self.store.path.stat().st_size)
        except FileNotFoundError:
            storage_bytes = 0
        return {
            "statistics": self.store.statistics(),
            "storageBytes": storage_bytes,
            "inventory": self.store.history_inventory(),
        }

    @staticmethod
    def _market_for_code(ts_code: str):
        from .tdx_api import Market

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
        background: bool = False,
        incremental: bool = False,
    ) -> list[dict[str, Any]]:
        market = self._market_for_code(ts_code)
        symbol = self._symbol(ts_code)
        frames = []
        complete = True
        with self._background_slot() if background else self._io:
            cached = self.store.load(ts_code, instrument_type) if incremental else []
            latest_cached = max((row['datetime'] for row in cached), default=None)
            if incremental:
                latest_cached = self.store.refresh_boundary(ts_code, instrument_type, latest_cached)
        for start in range(0, maximum_bars, TDX_PAGE_SIZE):
            try:
                with self._background_slot() if background else self._io:
                    fetch = client.get_index_bars if instrument_type.startswith("index") else client.get_security_bars
                    frame = fetch(market, symbol, category, start, TDX_PAGE_SIZE, bar_time=bar_time)
            except Exception:
                if frames:
                    complete = False
                    break
                with self._background_slot() if background else self._io:
                    self.store.record_refresh(ts_code, instrument_type, error="五分钟行情下载失败")
                raise
            if frame is None or frame.empty:
                complete = bool(frames)
                break
            frames.extend(frame.to_dict("records"))
            if latest_cached is not None and min(_normalize_rows(frame.to_dict('records')), default=datetime.max) <= latest_cached:
                break
            if len(frame) < TDX_PAGE_SIZE:
                break
        if not frames:
            with self._background_slot() if background else self._io:
                self.store.record_refresh(ts_code, instrument_type, error="通达信未返回分钟行情")
            raise ValueError(f"通达信未返回 {ts_code} 的行情")
        with self._background_slot() if background else self._io:
            self.store.merge(ts_code, instrument_type, frames)
            if complete and instrument_type.endswith("-5m") and maximum_bars >= TDX_5MIN_MAX_BARS:
                self.store.mark_full_history(ts_code, instrument_type)
            self.store.record_refresh(ts_code, instrument_type, error="分钟行情下载中断，已保存部分缓存" if not complete else '')
        if not complete:
            raise ValueError(f"{ts_code} 行情下载中断，已保存部分缓存，下次继续补齐")
        with self._io:
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

    def _create_scenario(
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
        cached_scenario = None
        hybrid_cache_complete = (
            self.store.has_full_history(ts_code, stock_type)
            and self.store.has_full_history(benchmark_code, benchmark_type)
        )
        try:
            if hybrid and not hybrid_cache_complete:
                raise ValueError("五分钟缓存尚未回填到近两年")
            if hybrid:
                cached_scenario = self._build_hybrid(
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
                if self.store.history_current(ts_code, stock_type, self.required_trade_date) and self.store.history_current(benchmark_code, benchmark_type, self.required_trade_date):
                    return cached_scenario
                raise ValueError('五分钟完整历史已过期，尝试增量续更')
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
            from .tdx_api import TdxClient
        except ImportError as exc:
            raise RuntimeError("分钟演练依赖 pytdxdata，请先安装项目 Python 依赖") from exc

        from .tdx_api import KlineCategory, get_known_hosts

        hosts = tuple(dict.fromkeys([*TDX_HOSTS, *get_known_hosts()]))
        client = _FailoverTdxClient(TdxClient, hosts)
        last_error: Exception | None = None
        try:
            required_minute_rows = MINUTE_OBSERVATION_BARS + int(game_length)
            stock_needs_download = (
                not self.store.history_current(ts_code, stock_type, self.required_trade_date)
                if hybrid
                else len(stock_rows) < required_minute_rows
            )
            benchmark_needs_download = (
                not self.store.history_current(benchmark_code, benchmark_type, self.required_trade_date)
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
                    incremental=hybrid and cached_scenario is not None and self.store.has_full_history(ts_code, stock_type),
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
                    incremental=hybrid and cached_scenario is not None and self.store.has_full_history(benchmark_code, benchmark_type),
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
        finally:
            client.close()

        if last_error is not None:
            if cached_scenario is not None:
                return {**cached_scenario, 'cacheFreshness': {'state': 'stale', 'message': '分钟续更失败，本次使用已验证的本地历史窗口'}}
            raise ValueError(
                "分钟行情下载失败且本地缓存不足："
                f"通达信错误={last_error}；"
                f"缓存错误={cache_error or '缓存数据不足'}"
            ) from last_error
        if hybrid:
            stale = not self.store.history_current(ts_code, stock_type, self.required_trade_date) or not self.store.history_current(benchmark_code, benchmark_type, self.required_trade_date)
            if stale:
                for code, kind in [(ts_code, stock_type), (benchmark_code, benchmark_type)]:
                    if not self.store.history_current(code, kind, self.required_trade_date):
                        self.store.record_refresh(code, kind, error='五分钟缓存尚未覆盖基准的已收盘数据日')
                if cached_scenario is not None:
                    return {**cached_scenario, 'cacheFreshness': {'state': 'stale', 'message': '上游尚未返回新数据，本次使用本地历史窗口'}}
            scenario = self._build_hybrid(
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
            if stale:
                scenario['cacheFreshness'] = {'state': 'stale', 'message': '上游尚未返回新数据，本次使用已验证的本地历史窗口'}
            return scenario
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
