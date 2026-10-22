from __future__ import annotations

from datetime import date, datetime
from contextlib import ExitStack
from time import monotonic
import math
import logging
from pathlib import Path
from threading import Lock, Thread
from typing import Any

import duckdb
import pandas as pd
from .replay_cache_policy import (
    BOARDS, DAILY_BATCH_SIZE, board_for_code, latest_completed_date,
    maintenance_key, market_now, reserve_targets,
)


TDX_PAGE_SIZE = 800
TDX_MAX_DAILY_BARS = 8000
TDX_HOSTS = (
    # Verified with index/stock daily bars and stock 5-minute bars, 2026-10-01.
    # The legacy nodes below can accept connections while returning no bar data.
    "139.9.52.158",
    "103.221.142.82",
    "103.251.85.94",
    "180.153.18.170",
    "115.238.56.198",
    "111.229.247.189",
)

LOGGER = logging.getLogger(__name__)
DEFAULT_REPLAY_BENCHMARK_CODES = (
    "000001.SH",
    "000016.SH",
    "000300.SH",
    "000688.SH",
    "000852.SH",
    "000905.SH",
    "000906.SH",
    "399001.SZ",
)


class TdxMarketUnavailableError(RuntimeError):
    pass


class _FailoverTdxClient:
    def __init__(self, factory: Any, hosts: tuple[str, ...]) -> None:
        self.factory = factory
        self.hosts = tuple(hosts)
        self._connections = {}
        self._failed_until = {}
        self._preferred_host = None

    def __enter__(self):
        return self

    def close(self):
        for context, _client in self._connections.values():
            context.__exit__(None, None, None)
        self._connections.clear()

    def __exit__(self, *_args):
        self.close()

    def _call(self, method_name: str, *args, require_non_empty: bool = False, **kwargs):
        errors: list[str] = []
        hosts = sorted(self.hosts, key=lambda host: host != self._preferred_host)
        for host in hosts:
            if self._failed_until.get(host, 0) > monotonic():
                continue
            try:
                if host not in self._connections:
                    context = self.factory(host=host, timeout=8, auto_reconnect=True, heartbeat_interval=0)
                    self._connections[host] = (context, context.__enter__())
                result = getattr(self._connections[host][1], method_name)(*args, **kwargs)
                if require_non_empty and (result is None or result.empty):
                    raise ValueError("返回空数据")
                self._preferred_host = host
                return result
            except Exception as exc:
                connection = self._connections.pop(host, None)
                if connection is not None:
                    connection[0].__exit__(None, None, None)
                self._failed_until[host] = monotonic() + 30
                errors.append(f"{host}: {exc}")
        raise TdxMarketUnavailableError(
            f"通达信请求 {method_name} 在所有节点均失败：" + "；".join(errors)
        )

    def get_security_list(self, *args, **kwargs):
        start = int(args[1]) if len(args) > 1 else int(kwargs.get("start", 0))
        return self._call(
            "get_security_list",
            *args,
            require_non_empty=start == 0,
            **kwargs,
        )

    def get_security_bars(self, *args, **kwargs):
        start = int(args[3]) if len(args) > 3 else int(kwargs.get("start", 0))
        return self._call(
            "get_security_bars",
            *args,
            require_non_empty=start == 0,
            **kwargs,
        )

    def get_index_bars(self, *args, **kwargs):
        start = int(args[3]) if len(args) > 3 else int(kwargs.get("start", 0))
        return self._call(
            "get_index_bars",
            *args,
            require_non_empty=start == 0,
            **kwargs,
        )

    def get_xdxr_info(self, *args, **kwargs):
        return self._call("get_xdxr_info", *args, **kwargs)


def _normalize_bars(rows: pd.DataFrame) -> pd.DataFrame:
    if rows is None or rows.empty:
        return pd.DataFrame()
    frame = rows.copy()
    if "datetime" not in frame.columns and "date" in frame.columns:
        frame["datetime"] = frame["date"]
    required = {"datetime", "open", "high", "low", "close"}
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError("通达信行情缺少字段：" + "、".join(missing))
    frame["datetime"] = pd.to_datetime(frame["datetime"], errors="coerce")
    # TDX daily pages can contain the same trade date with different clock times.
    # The cache schema is keyed by trading date, so normalize and deduplicate at
    # that same granularity before any rows are turned into cache records.
    frame["trade_date"] = frame["datetime"].dt.normalize()
    duplicate_trade_dates = int(frame.duplicated("trade_date", keep=False).sum())
    if duplicate_trade_dates:
        LOGGER.warning(
            "TDX daily page contains %s rows sharing a trade date; keeping the latest timestamp per date",
            duplicate_trade_dates,
        )
    frame = (
        frame.sort_values(["trade_date", "datetime"], kind="stable")
        .drop_duplicates("trade_date", keep="last")
        .drop(columns=["trade_date"])
    )
    for column in ("open", "high", "low", "close"):
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    volume_column = "vol" if "vol" in frame.columns else "volume"
    frame["vol"] = (
        pd.to_numeric(frame[volume_column], errors="coerce").fillna(0.0)
        if volume_column in frame.columns
        else 0.0
    )
    frame["amount"] = (
        pd.to_numeric(frame["amount"], errors="coerce").fillna(0.0)
        if "amount" in frame.columns
        else 0.0
    )
    valid = (
        frame["datetime"].notna()
        & frame[["open", "high", "low", "close"]].apply(
            lambda values: values.map(lambda value: math.isfinite(float(value)) and float(value) > 0)
        ).all(axis=1)
        & (frame["high"] >= frame[["open", "close"]].max(axis=1))
        & (frame["low"] <= frame[["open", "close"]].min(axis=1))
        & (frame["vol"] >= 0)
        & (frame["amount"] >= 0)
    )
    return frame.loc[valid].reset_index(drop=True)


def build_stock_history(
    ts_code: str,
    bars: pd.DataFrame,
    xdxr: pd.DataFrame,
    *,
    updated_at: datetime,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    from .tdx_api import apply_forward_adjust

    raw = _normalize_bars(bars)
    if raw.empty:
        raise ValueError(f"通达信未返回 {ts_code} 的有效股票日线")
    adjusted = apply_forward_adjust(raw, xdxr)
    factors = adjusted["close"].astype(float) / raw["close"].astype(float)
    if not factors.map(lambda value: math.isfinite(float(value)) and float(value) > 0).all():
        raise ValueError(f"{ts_code} 的本地前复权因子无效")

    stock_rows: list[dict[str, Any]] = []
    factor_rows: list[dict[str, Any]] = []
    previous_adjusted_close: float | None = None
    for index, row in raw.iterrows():
        factor = float(factors.iloc[index])
        close = float(row["close"])
        adjusted_close = close * factor
        if previous_adjusted_close is None:
            pre_close = float(row["open"])
            pct_chg = ((close / pre_close) - 1) * 100
        else:
            pre_close = previous_adjusted_close / factor
            pct_chg = ((adjusted_close / previous_adjusted_close) - 1) * 100
        trade_date = pd.Timestamp(row["datetime"]).date()
        stock_rows.append(
            {
                "ts_code": str(ts_code).upper(),
                "trade_date": trade_date,
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": close,
                "pre_close": pre_close,
                "change": close - pre_close,
                "pct_chg": pct_chg,
                "vol": float(row["vol"]),
                "amount": float(row["amount"]),
                "updated_at": updated_at,
            }
        )
        factor_rows.append(
            {
                "ts_code": str(ts_code).upper(),
                "trade_date": trade_date,
                "adj_factor": factor,
                "updated_at": updated_at,
            }
        )
        previous_adjusted_close = adjusted_close
    return stock_rows, factor_rows


def build_index_history(
    ts_code: str,
    exchange: str,
    bars: pd.DataFrame,
    *,
    updated_at: datetime,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    raw = _normalize_bars(bars)
    if raw.empty:
        raise ValueError(f"通达信未返回 {ts_code} 的有效指数日线")
    index_rows: list[dict[str, Any]] = []
    calendar_rows: list[dict[str, Any]] = []
    previous_close: float | None = None
    previous_date: date | None = None
    for _, row in raw.iterrows():
        trade_date = pd.Timestamp(row["datetime"]).date()
        close = float(row["close"])
        pre_close = previous_close if previous_close is not None else float(row["open"])
        index_rows.append(
            {
                "ts_code": str(ts_code).upper(),
                "trade_date": trade_date,
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": close,
                "pre_close": pre_close,
                "change": close - pre_close,
                "pct_chg": ((close / pre_close) - 1) * 100,
                "vol": float(row["vol"]),
                "amount": float(row["amount"]),
                "updated_at": updated_at,
            }
        )
        calendar_rows.append(
            {
                "exchange": str(exchange).upper(),
                "cal_date": trade_date,
                "is_open": 1,
                "pretrade_date": previous_date,
                "updated_at": updated_at,
            }
        )
        previous_close = close
        previous_date = trade_date
    return index_rows, calendar_rows


class TdxMarketCache:
    def __init__(self, path: Path) -> None:
        self.path = Path(path).resolve()
        self._quality_cache: dict[str, tuple[Any, int]] = {}
        self._quality_lock = Lock()

    def _connect(self) -> duckdb.DuckDBPyConnection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        return duckdb.connect(str(self.path))

    def ensure_schema(self) -> None:
        connection = self._connect()
        try:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS stock_daily_bars (
                    ts_code VARCHAR NOT NULL,
                    trade_date DATE NOT NULL,
                    open DOUBLE NOT NULL,
                    high DOUBLE NOT NULL,
                    low DOUBLE NOT NULL,
                    close DOUBLE NOT NULL,
                    pre_close DOUBLE NOT NULL,
                    change DOUBLE NOT NULL,
                    pct_chg DOUBLE NOT NULL,
                    vol DOUBLE NOT NULL,
                    amount DOUBLE NOT NULL,
                    updated_at TIMESTAMP NOT NULL,
                    PRIMARY KEY (ts_code, trade_date)
                );
                CREATE TABLE IF NOT EXISTS stock_adj_factors (
                    ts_code VARCHAR NOT NULL,
                    trade_date DATE NOT NULL,
                    adj_factor DOUBLE NOT NULL,
                    updated_at TIMESTAMP NOT NULL,
                    PRIMARY KEY (ts_code, trade_date)
                );
                CREATE TABLE IF NOT EXISTS stock_instruments (
                    ts_code VARCHAR PRIMARY KEY,
                    symbol VARCHAR NOT NULL,
                    name VARCHAR NOT NULL,
                    industry VARCHAR,
                    area VARCHAR,
                    market VARCHAR NOT NULL,
                    list_status VARCHAR NOT NULL,
                    list_date DATE,
                    delist_date DATE,
                    updated_at TIMESTAMP NOT NULL
                );
                CREATE TABLE IF NOT EXISTS etf_daily_bars (
                    ts_code VARCHAR NOT NULL,
                    trade_date DATE NOT NULL,
                    updated_at TIMESTAMP NOT NULL,
                    PRIMARY KEY (ts_code, trade_date)
                );
                CREATE TABLE IF NOT EXISTS etf_adj_factors (
                    ts_code VARCHAR NOT NULL,
                    trade_date DATE NOT NULL,
                    adj_factor DOUBLE NOT NULL,
                    updated_at TIMESTAMP NOT NULL,
                    PRIMARY KEY (ts_code, trade_date)
                );
                CREATE TABLE IF NOT EXISTS etf_instruments (
                    ts_code VARCHAR PRIMARY KEY,
                    name VARCHAR NOT NULL,
                    market VARCHAR NOT NULL,
                    status VARCHAR NOT NULL,
                    list_date DATE,
                    delist_date DATE
                );
                CREATE TABLE IF NOT EXISTS index_daily_bars (
                    ts_code VARCHAR NOT NULL,
                    trade_date DATE NOT NULL,
                    open DOUBLE NOT NULL,
                    high DOUBLE NOT NULL,
                    low DOUBLE NOT NULL,
                    close DOUBLE NOT NULL,
                    pre_close DOUBLE NOT NULL,
                    change DOUBLE NOT NULL,
                    pct_chg DOUBLE NOT NULL,
                    vol DOUBLE NOT NULL,
                    amount DOUBLE NOT NULL,
                    updated_at TIMESTAMP NOT NULL,
                    PRIMARY KEY (ts_code, trade_date)
                );
                CREATE TABLE IF NOT EXISTS trade_calendar (
                    exchange VARCHAR NOT NULL,
                    cal_date DATE NOT NULL,
                    is_open INTEGER NOT NULL,
                    pretrade_date DATE,
                    updated_at TIMESTAMP NOT NULL,
                    PRIMARY KEY (exchange, cal_date)
                );
                CREATE TABLE IF NOT EXISTS tdx_cache_sync_state (
                    dataset VARCHAR PRIMARY KEY,
                    last_success_at TIMESTAMP NOT NULL,
                    detail VARCHAR NOT NULL
                );
                CREATE TABLE IF NOT EXISTS tdx_resource_sync (
                    instrument_code VARCHAR NOT NULL,
                    resource_type VARCHAR NOT NULL,
                    last_attempt_at TIMESTAMP NOT NULL,
                    last_success_at TIMESTAMP,
                    last_error VARCHAR NOT NULL DEFAULT '',
                    PRIMARY KEY (instrument_code, resource_type)
                )
                """
            )
        finally:
            connection.close()

    def latest_trade_date(self, table_name: str, ts_code: str) -> date | None:
        self.ensure_schema()
        if table_name not in {"stock_daily_bars", "index_daily_bars"}:
            raise ValueError(f"不支持的行情表：{table_name}")
        connection = self._connect()
        try:
            row = connection.execute(
                f"SELECT MAX(trade_date) FROM {table_name} WHERE ts_code = ?",
                [str(ts_code).upper()],
            ).fetchone()
        finally:
            connection.close()
        return row[0] if row else None

    def load_history(self, table_name: str, ts_code: str) -> pd.DataFrame:
        self.ensure_schema()
        if table_name not in {"stock_daily_bars", "index_daily_bars"}:
            raise ValueError(f"不支持的行情表：{table_name}")
        connection = self._connect()
        try:
            rows = connection.execute(
                f"""
                SELECT trade_date, open, high, low, close, vol, amount
                FROM {table_name}
                WHERE ts_code = ?
                ORDER BY trade_date
                """,
                [str(ts_code).upper()],
            ).fetchall()
        finally:
            connection.close()
        return pd.DataFrame(
            rows,
            columns=["datetime", "open", "high", "low", "close", "vol", "amount"],
        )

    def load_replay_stock_history(self, ts_code: str) -> pd.DataFrame:
        self.ensure_schema()
        connection = self._connect()
        try:
            rows = connection.execute(
                """
                SELECT
                    bars.trade_date,
                    bars.open,
                    bars.high,
                    bars.low,
                    bars.close,
                    bars.vol,
                    bars.amount,
                    factors.adj_factor,
                    bars.pre_close
                FROM stock_daily_bars AS bars
                INNER JOIN stock_adj_factors AS factors
                    ON factors.ts_code = bars.ts_code
                   AND factors.trade_date = bars.trade_date
                WHERE bars.ts_code = ?
                ORDER BY bars.trade_date
                """,
                [str(ts_code).upper()],
            ).fetchall()
        finally:
            connection.close()
        return pd.DataFrame(
            rows,
            columns=[
                "datetime", "open", "high", "low", "close", "vol", "amount",
                "adjust_factor", "pre_close",
            ],
        )

    def upsert_instruments(self, rows: list[dict[str, Any]]) -> None:
        self.ensure_schema()
        if not rows:
            return
        connection = self._connect()
        try:
            connection.executemany(
                """
                INSERT INTO stock_instruments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (ts_code) DO UPDATE SET
                    symbol = EXCLUDED.symbol,
                    name = EXCLUDED.name,
                    industry = EXCLUDED.industry,
                    area = EXCLUDED.area,
                    market = EXCLUDED.market,
                    list_status = EXCLUDED.list_status,
                    list_date = COALESCE(stock_instruments.list_date, EXCLUDED.list_date),
                    delist_date = COALESCE(EXCLUDED.delist_date, stock_instruments.delist_date),
                    updated_at = EXCLUDED.updated_at
                """,
                [
                    tuple(row.get(key) for key in (
                        "ts_code", "symbol", "name", "industry", "area", "market",
                        "list_status", "list_date", "delist_date", "updated_at",
                    ))
                    for row in rows
                ],
            )
        finally:
            connection.close()

    def instrument_count(self) -> int:
        self.ensure_schema()
        connection = self._connect()
        try:
            return int(connection.execute("SELECT COUNT(*) FROM stock_instruments").fetchone()[0])
        finally:
            connection.close()

    def upsert_stock_history(
        self,
        stock_rows: list[dict[str, Any]],
        factor_rows: list[dict[str, Any]],
    ) -> None:
        self.ensure_schema()
        connection = self._connect()
        try:
            connection.execute("BEGIN TRANSACTION")
            if stock_rows:
                connection.executemany(
                    """
                    INSERT INTO stock_daily_bars VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (ts_code, trade_date) DO UPDATE SET
                        open = EXCLUDED.open,
                        high = EXCLUDED.high,
                        low = EXCLUDED.low,
                        close = EXCLUDED.close,
                        pre_close = EXCLUDED.pre_close,
                        change = EXCLUDED.change,
                        pct_chg = EXCLUDED.pct_chg,
                        vol = EXCLUDED.vol,
                        amount = EXCLUDED.amount,
                        updated_at = EXCLUDED.updated_at
                    """,
                    [
                        tuple(row[key] for key in (
                            "ts_code", "trade_date", "open", "high", "low", "close",
                            "pre_close", "change", "pct_chg", "vol", "amount", "updated_at",
                        ))
                        for row in stock_rows
                    ],
                )
            if factor_rows:
                connection.executemany(
                    """
                    INSERT INTO stock_adj_factors VALUES (?, ?, ?, ?)
                    ON CONFLICT (ts_code, trade_date) DO UPDATE SET
                        adj_factor = EXCLUDED.adj_factor,
                        updated_at = EXCLUDED.updated_at
                    """,
                    [
                        tuple(row[key] for key in ("ts_code", "trade_date", "adj_factor", "updated_at"))
                        for row in factor_rows
                    ],
                )
            connection.execute("COMMIT")
            with self._quality_lock:
                for code in {row["ts_code"] for row in [*stock_rows, *factor_rows]}:
                    self._quality_cache.pop(code, None)
        except Exception:
            connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

    def replace_index_history(
        self,
        ts_code: str,
        exchange: str,
        index_rows: list[dict[str, Any]],
        calendar_rows: list[dict[str, Any]] | None,
    ) -> None:
        self.ensure_schema()
        calendar_by_key = {
            (str(row["exchange"]).upper(), row["cal_date"]): row
            for row in (calendar_rows or [])
        }
        if calendar_rows is not None and len(calendar_by_key) != len(calendar_rows):
            LOGGER.warning(
                "Deduplicated %s duplicate trade-calendar rows before cache write",
                len(calendar_rows) - len(calendar_by_key),
            )
        connection = self._connect()
        try:
            connection.execute("BEGIN TRANSACTION")
            if index_rows:
                connection.executemany(
                    """
                    INSERT INTO index_daily_bars VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (ts_code, trade_date) DO UPDATE SET
                        open = EXCLUDED.open,
                        high = EXCLUDED.high,
                        low = EXCLUDED.low,
                        close = EXCLUDED.close,
                        pre_close = EXCLUDED.pre_close,
                        change = EXCLUDED.change,
                        pct_chg = EXCLUDED.pct_chg,
                        vol = EXCLUDED.vol,
                        amount = EXCLUDED.amount,
                        updated_at = EXCLUDED.updated_at
                    """,
                    [
                        tuple(row[key] for key in (
                            "ts_code", "trade_date", "open", "high", "low", "close",
                            "pre_close", "change", "pct_chg", "vol", "amount", "updated_at",
                        ))
                        for row in index_rows
                    ],
                )
            if calendar_rows is not None:
                connection.execute("DELETE FROM trade_calendar WHERE exchange = ?", [exchange])
                if calendar_by_key:
                    connection.executemany(
                        "INSERT INTO trade_calendar VALUES (?, ?, ?, ?, ?)",
                        [
                            tuple(row[key] for key in (
                                "exchange", "cal_date", "is_open", "pretrade_date", "updated_at",
                            ))
                            for row in calendar_by_key.values()
                        ],
                    )
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

    def record_resource_sync(self, code: str, kind: str, *, error: str = "", now: datetime | None = None) -> None:
        self.ensure_schema()
        timestamp = now or market_now()
        with self._connect() as connection:
            connection.execute("""
                INSERT INTO tdx_resource_sync VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (instrument_code, resource_type) DO UPDATE SET
                    last_attempt_at = EXCLUDED.last_attempt_at,
                    last_success_at = COALESCE(EXCLUDED.last_success_at, tdx_resource_sync.last_success_at),
                    last_error = EXCLUDED.last_error
            """, [code, kind, timestamp, timestamp if not error else None, error])

    def failed_resource_count(self) -> int:
        self.ensure_schema()
        with self._connect() as connection:
            return int(connection.execute("SELECT COUNT(*) FROM tdx_resource_sync WHERE last_error <> ''").fetchone()[0])

    def completed_trade_date(self, now: datetime | None = None) -> date | None:
        self.ensure_schema()
        with self._connect() as connection:
            dates = [row[0] for row in connection.execute("SELECT DISTINCT cal_date FROM trade_calendar WHERE is_open = 1").fetchall()]
        return latest_completed_date(dates, now or market_now())

    def sample_inventory(self, minimum_bars: int) -> list[dict[str, Any]]:
        """Stock-only quality; benchmark/selected-length alignment is checked at creation."""
        from .data_store import DuckDbBarStore
        self.ensure_schema()
        with self._quality_lock, self._connect() as connection:
            calendar_key = tuple(connection.execute("SELECT COUNT(*), MAX(updated_at) FROM trade_calendar").fetchone())
            rows = connection.execute("""
                SELECT bars.ts_code, COUNT(*), MAX(bars.trade_date), MAX(bars.updated_at),
                    COUNT(factors.trade_date), MAX(factors.updated_at), MAX(instruments.list_date), MAX(instruments.delist_date),
                    MAX(sync.last_success_at), MAX(sync.last_error), MAX(sync.last_attempt_at)
                FROM stock_daily_bars AS bars
                LEFT JOIN stock_adj_factors AS factors ON factors.ts_code = bars.ts_code AND factors.trade_date = bars.trade_date
                LEFT JOIN stock_instruments AS instruments ON instruments.ts_code = bars.ts_code
                LEFT JOIN tdx_resource_sync AS sync ON sync.instrument_code = bars.ts_code AND sync.resource_type = 'stock-day'
                GROUP BY bars.ts_code ORDER BY bars.ts_code
            """).fetchall()
            result = []
            for row in rows:
                code = str(row[0])
                board = board_for_code(code)
                if board is None:
                    continue
                key = (*row[:8], *calendar_key)
                cached = self._quality_cache.get(code)
                if cached is None or cached[0] != key:
                    source = DuckDbBarStore._replay_valid_source_rows(connection, code, 'SSE' if code.endswith('.SH') else 'SZSE')
                    longest = max((length for _, length in DuckDbBarStore._replay_stock_continuous_runs(source)), default=0)
                    self._quality_cache[code] = (key, longest)
                longest = self._quality_cache[code][1]
                result.append({"code": code, "board": board, "barCount": int(row[1]), "eligible": longest >= minimum_bars,
                    "continuousBars": longest, "latestDate": row[2].isoformat() if row[2] else None,
                    "lastSuccessAt": row[8].isoformat() if row[8] else None, "error": str(row[9] or ""),
                    "lastAttemptAt": row[10].isoformat() if row[10] else None})
            cached_codes = {item['code'] for item in result}
            for code, attempted, succeeded, error in connection.execute("SELECT instrument_code, last_attempt_at, last_success_at, last_error FROM tdx_resource_sync WHERE resource_type = 'stock-day' AND last_error <> ''").fetchall():
                if code not in cached_codes and board_for_code(code):
                    result.append({'code': code, 'board': board_for_code(code), 'barCount': 0, 'eligible': False,
                        'continuousBars': 0, 'latestDate': None, 'lastSuccessAt': succeeded.isoformat() if succeeded else None,
                        'error': error, 'lastAttemptAt': attempted.isoformat()})
        return result

    def mark_sync_success(self, detail: str, *, now: datetime | None = None) -> None:
        self.ensure_schema()
        connection = self._connect()
        try:
            connection.execute(
                """
                INSERT INTO tdx_cache_sync_state VALUES ('replay-market', ?, ?)
                ON CONFLICT (dataset) DO UPDATE SET
                    last_success_at = EXCLUDED.last_success_at,
                    detail = EXCLUDED.detail
                """,
                [now or market_now(), detail],
            )
        finally:
            connection.close()

    def synced_today(self, now: datetime | None = None) -> bool:
        self.ensure_schema()
        connection = self._connect()
        try:
            row = connection.execute(
                """
                SELECT CAST(last_success_at AS DATE) = ?
                FROM tdx_cache_sync_state
                WHERE dataset = 'replay-market'
                """, [(now or market_now()).date()],
            ).fetchone()
        finally:
            connection.close()
        return bool(row and row[0])

    def has_successful_sync(self) -> bool:
        self.ensure_schema()
        connection = self._connect()
        try:
            row = connection.execute(
                """
                SELECT 1
                FROM tdx_cache_sync_state
                WHERE dataset = 'replay-market'
                """
            ).fetchone()
        finally:
            connection.close()
        return row is not None

    def statistics(self) -> dict[str, Any]:
        self.ensure_schema()
        connection = self._connect()
        try:
            row = connection.execute(
                """
                SELECT
                    (SELECT COUNT(*) FROM stock_instruments),
                    (SELECT COUNT(DISTINCT ts_code) FROM stock_daily_bars),
                    (SELECT COUNT(*) FROM stock_daily_bars),
                    (SELECT COUNT(*) FROM stock_adj_factors),
                    (SELECT COUNT(DISTINCT ts_code) FROM index_daily_bars),
                    (SELECT COUNT(*) FROM index_daily_bars),
                    (SELECT COUNT(DISTINCT cal_date) FROM trade_calendar WHERE is_open = 1),
                    (SELECT MAX(last_success_at) FROM tdx_cache_sync_state)
                """
            ).fetchone()
        finally:
            connection.close()
        return {
            "instrumentCount": int(row[0]),
            "stockCount": int(row[1]),
            "stockDailyBarCount": int(row[2]),
            "adjustFactorCount": int(row[3]),
            "indexCount": int(row[4]),
            "indexDailyBarCount": int(row[5]),
            "tradeDateCount": int(row[6]),
            "lastSuccessAt": row[7].isoformat() if row[7] is not None else None,
        }

    def is_replay_ready(
        self,
        benchmark_codes: tuple[str, ...],
        minimum_bars: int,
    ) -> bool:
        self.ensure_schema()
        connection = self._connect()
        try:
            stock_ready = connection.execute(
                """
                SELECT COUNT(*)
                FROM (
                    SELECT bars.ts_code
                    FROM stock_daily_bars AS bars
                    INNER JOIN stock_adj_factors AS factors
                        ON factors.ts_code = bars.ts_code
                       AND factors.trade_date = bars.trade_date
                    INNER JOIN stock_instruments AS instruments
                        ON instruments.ts_code = bars.ts_code
                       AND instruments.list_date IS NOT NULL
                    GROUP BY bars.ts_code
                    HAVING COUNT(*) >= ?
                )
                """,
                [minimum_bars],
            ).fetchone()[0]
            for code in benchmark_codes:
                suffix = str(code).upper().rsplit(".", 1)[-1]
                exchange = "SSE" if suffix == "SH" else "SZSE"
                counts = connection.execute(
                    """
                    SELECT
                        (SELECT COUNT(*) FROM index_daily_bars WHERE ts_code = ?),
                        (SELECT COUNT(*) FROM trade_calendar WHERE exchange = ? AND is_open = 1)
                    """,
                    [str(code).upper(), exchange],
                ).fetchone()
                if min(int(counts[0]), int(counts[1])) < minimum_bars:
                    return False
            return int(stock_ready) > 0
        finally:
            connection.close()


class TdxMarketDataProvider:
    def __init__(
        self,
        cache: TdxMarketCache,
        *,
        hosts: tuple[str, ...] | None = None,
        client_factory: Any | None = None,
        initial_stock_count: int = 12,
        minimum_replay_bars: int = 370,
        benchmark_codes: tuple[str, ...] = DEFAULT_REPLAY_BENCHMARK_CODES,
        now: Any = market_now,
    ) -> None:
        self.cache = cache
        self.hosts = hosts
        self.client_factory = client_factory
        self.initial_stock_count = max(int(initial_stock_count), 1)
        self.minimum_replay_bars = int(minimum_replay_bars)
        self.benchmark_codes = tuple(str(code).upper() for code in benchmark_codes)
        self.now = now
        self._attempt_key: str | None = None
        self._last_attempt_at: datetime | None = None
        self._status_lock = Lock()
        self._pool_lock = Lock()
        self._pool_status: dict[str, Any] = {
            "state": "idle",
            "completed": 0,
            "total": 0,
            "message": "未运行股票池预热",
            "error": "",
        }
        self._sync_thread: Thread | None = None
        self._sync_status: dict[str, Any] = {
            "state": "idle",
            "ready": False,
            "completed": 0,
            "total": 1 + len(self.benchmark_codes) + self.initial_stock_count,
            "message": "等待初始化通达信行情缓存",
            "error": "",
        }

    def cache_snapshot(self) -> dict[str, Any]:
        try:
            storage_bytes = int(self.cache.path.stat().st_size)
        except FileNotFoundError:
            storage_bytes = 0
        return {
            "statistics": self.cache.statistics(),
            "storageBytes": storage_bytes,
            "inventory": self.cache.sample_inventory(self.minimum_replay_bars),
            "failedResourceCount": self.cache.failed_resource_count(),
        }

    def completed_trade_date(self) -> date | None:
        return self.cache.completed_trade_date(self.now())

    def unseen_eligible_codes(self, excluded: tuple[str, ...]) -> list[str]:
        seen = set(excluded)
        return [item['code'] for item in self.cache.sample_inventory(self.minimum_replay_bars) if item['eligible'] and item['code'] not in seen]

    def background_retry_due(self) -> bool:
        from .replay_cache_policy import RETRY_SECONDS
        return self.replay_cache_status()['state'] in {'partial', 'failed'} and (self._last_attempt_at is None or (self.now() - self._last_attempt_at).total_seconds() >= RETRY_SECONDS)

    def _sync_stock(self, client: Any, code: str, metadata: dict[str, Any] | None, timestamp: datetime) -> None:
        try:
            latest = self.cache.latest_trade_date("stock_daily_bars", code)
            bars = self._fetch_daily_pages(client, code, is_index=False, latest_cached_date=latest,
                maximum_bars=TDX_PAGE_SIZE if latest is None else TDX_MAX_DAILY_BARS)
            xdxr = client.get_xdxr_info(self._market_for_code(code), self._symbol(code))
            stock_rows, factor_rows = build_stock_history(code, bars, xdxr, updated_at=timestamp)
            self.cache.upsert_stock_history(stock_rows, factor_rows)
            if metadata is not None:
                item = {**metadata, "list_date": metadata.get("list_date") or stock_rows[0]["trade_date"], "updated_at": timestamp}
                self.cache.upsert_instruments([item])
            target = self.cache.completed_trade_date(timestamp)
            latest = self.cache.latest_trade_date("stock_daily_bars", code)
            if target is not None and (latest is None or latest < target):
                raise ValueError("日线尚未覆盖基准已收盘数据日，待续更或核实停牌")
            self.cache.record_resource_sync(code, "stock-day", now=timestamp)
        except Exception as exc:
            self.cache.record_resource_sync(code, "stock-day", error=str(exc), now=timestamp)
            raise

    def load_hybrid_daily_history(
        self,
        ts_code: str,
        benchmark_code: str,
    ) -> dict[str, list[dict[str, Any]]]:
        return {
            "stock": self.cache.load_replay_stock_history(ts_code).to_dict("records"),
            "benchmark": self.cache.load_history(
                "index_daily_bars", benchmark_code
            ).to_dict("records"),
        }

    def _connection_hosts(self) -> tuple[str, ...]:
        if self.hosts is not None:
            return tuple(self.hosts)
        from .tdx_api import get_known_hosts

        return tuple(dict.fromkeys([*get_known_hosts(), *TDX_HOSTS]))

    @staticmethod
    def _market_for_code(ts_code: str):
        from .tdx_api import Market

        return Market.SH if str(ts_code).upper().endswith(".SH") else Market.SZ

    @staticmethod
    def _symbol(ts_code: str) -> str:
        return str(ts_code).split(".", 1)[0]

    @staticmethod
    def _is_stock_code(symbol: str, suffix: str) -> bool:
        value = str(symbol).strip()
        if len(value) != 6 or not value.isdigit():
            return False
        if suffix == "SH":
            return value.startswith(("600", "601", "603", "605", "688"))
        return value.startswith(("000", "001", "002", "003", "300", "301"))

    @staticmethod
    def _board_name(symbol: str) -> str:
        if str(symbol).startswith("688"):
            return "科创板"
        if str(symbol).startswith(("300", "301")):
            return "创业板"
        return "主板"

    @staticmethod
    def _balanced_instruments(
        instruments: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        groups: dict[str, list[dict[str, Any]]] = {
            "sh_main": [],
            "sz_main": [],
            "chinext": [],
            "star": [],
        }
        for item in instruments:
            code = str(item.get("ts_code") or "")
            market = str(item.get("market") or "主板")
            if market == "科创板":
                key = "star"
            elif market == "创业板":
                key = "chinext"
            elif code.endswith(".SZ"):
                key = "sz_main"
            else:
                key = "sh_main"
            groups[key].append(item)
        for values in groups.values():
            values.sort(key=lambda item: str(item.get("ts_code") or ""))
        ordered: list[dict[str, Any]] = []
        while any(groups.values()):
            for key in ("sh_main", "sz_main", "chinext", "star"):
                if groups[key]:
                    ordered.append(groups[key].pop(0))
        return ordered

    def _fetch_instruments(self, client: Any, updated_at: datetime) -> list[dict[str, Any]]:
        instruments: list[dict[str, Any]] = []
        for suffix in ("SH", "SZ"):
            market = self._market_for_code(f"000000.{suffix}")
            start = 0
            while True:
                frame = client.get_security_list(market, start)
                if frame is None or frame.empty:
                    break
                for row in frame.to_dict("records"):
                    symbol = str(row.get("code") or "").strip()
                    if not self._is_stock_code(symbol, suffix):
                        continue
                    instruments.append(
                        {
                            "ts_code": f"{symbol}.{suffix}",
                            "symbol": symbol,
                            "name": str(row.get("name") or "").strip(),
                            "industry": None,
                            "area": None,
                            "market": self._board_name(symbol),
                            "list_status": "L",
                            "list_date": None,
                            "delist_date": None,
                            "updated_at": updated_at,
                        }
                    )
                if len(frame) < 1000:
                    break
                start += len(frame)
        return instruments

    def _fetch_daily_pages(
        self,
        client: Any,
        ts_code: str,
        *,
        is_index: bool,
        latest_cached_date: date | None,
        maximum_bars: int = TDX_MAX_DAILY_BARS,
    ) -> pd.DataFrame:
        from .tdx_api import KlineCategory

        frames: list[pd.DataFrame] = []
        market = self._market_for_code(ts_code)
        symbol = self._symbol(ts_code)
        for start in range(0, maximum_bars, TDX_PAGE_SIZE):
            if is_index:
                frame = client.get_index_bars(
                    market, symbol, KlineCategory.DAY, start, TDX_PAGE_SIZE, bar_time="start"
                )
            else:
                frame = client.get_security_bars(
                    market, symbol, KlineCategory.DAY, start, TDX_PAGE_SIZE, bar_time="start"
                )
            if frame is None or frame.empty:
                break
            frames.append(frame)
            normalized_dates = pd.to_datetime(frame["datetime"] if "datetime" in frame else frame["date"])
            if latest_cached_date is not None and normalized_dates.min().date() <= latest_cached_date:
                break
            if len(frame) < TDX_PAGE_SIZE:
                break
        if not frames:
            raise ValueError(f"通达信未返回 {ts_code} 的日线")
        downloaded = pd.concat(frames, ignore_index=True)
        table_name = "index_daily_bars" if is_index else "stock_daily_bars"
        cached = self.cache.load_history(table_name, ts_code)
        if not cached.empty:
            downloaded = pd.concat([cached, downloaded], ignore_index=True)
        return downloaded

    def sync_with_client(
        self,
        client: Any,
        *,
        progress_callback: Any | None = None,
    ) -> dict[str, Any]:
        updated_at = self.now().replace(microsecond=0)
        self.cache.ensure_schema()
        total = 1 + len(self.benchmark_codes) + self.initial_stock_count
        completed = 0

        def report(message: str, *, ready: bool = False) -> None:
            if progress_callback is not None:
                progress_callback(
                    {
                        "state": "running",
                        "ready": ready,
                        "completed": completed,
                        "total": total,
                        "message": message,
                        "error": "",
                    }
                )

        report("正在下载通达信证券名单")
        failures: list[str] = []
        try:
            instruments = self._fetch_instruments(client, updated_at)
            if not instruments:
                raise ValueError("通达信证券列表为空")
            self.cache.upsert_instruments(instruments)
            self.cache.record_resource_sync("instruments", "metadata", now=updated_at)
        except Exception as exc:
            failures.append(str(exc))
            self.cache.record_resource_sync("instruments", "metadata", error=str(exc), now=updated_at)
            with self.cache._connect() as connection:
                rows = connection.execute("SELECT ts_code, symbol, name, market, list_date, list_status, updated_at, industry, area, delist_date FROM stock_instruments").fetchall()
            instruments = [dict(zip(("ts_code", "symbol", "name", "market", "list_date", "list_status", "updated_at", "industry", "area", "delist_date"), row)) for row in rows]
        completed += 1
        report(f"证券名单已缓存，共 {len(instruments)} 只")

        for benchmark_code in self.benchmark_codes:
            try:
                latest = self.cache.latest_trade_date("index_daily_bars", benchmark_code)
                bars = self._fetch_daily_pages(client, benchmark_code, is_index=True, latest_cached_date=latest,
                    maximum_bars=TDX_PAGE_SIZE if latest is None else TDX_MAX_DAILY_BARS)
                exchange = "SSE" if benchmark_code.endswith(".SH") else "SZSE"
                index_rows, calendar_rows = build_index_history(benchmark_code, exchange, bars, updated_at=updated_at)
                self.cache.replace_index_history(benchmark_code, exchange, index_rows,
                    calendar_rows if benchmark_code in {"000001.SH", "399001.SZ"} else None)
                self.cache.record_resource_sync(benchmark_code, "index-day", now=updated_at)
            except Exception as exc:
                failures.append(str(exc))
                self.cache.record_resource_sync(benchmark_code, "index-day", error=str(exc), now=updated_at)
            completed += 1
            report("正在续更指数与交易日历")

        # Pool expansion and daily stock refresh share one writer/download queue.
        with self._pool_lock:
            cached_codes: list[str] = []
            connection = self.cache._connect()
            try:
                cached_codes = [
                    str(row[0])
                    for row in connection.execute(
                        "SELECT DISTINCT ts_code FROM stock_daily_bars ORDER BY ts_code"
                    ).fetchall()
                ]
            finally:
                connection.close()
            available_codes = {str(row["ts_code"]): row for row in instruments}
            # All cached stocks participate, including those missing from today's instrument list.
            selected_codes = [code for code in cached_codes if board_for_code(code)]
            for item in self._balanced_instruments(list(available_codes.values())):
                if len(selected_codes) >= self.initial_stock_count:
                    break
                code = str(item["ts_code"])
                if code not in selected_codes:
                    selected_codes.append(code)
                if len(selected_codes) >= self.initial_stock_count:
                    break
            total = 1 + len(self.benchmark_codes) + len(selected_codes)

            synced_codes: list[str] = []
            for batch_start in range(0, len(selected_codes), DAILY_BATCH_SIZE):
                for ts_code in selected_codes[batch_start:batch_start + DAILY_BATCH_SIZE]:
                    try:
                        self._sync_stock(client, ts_code, available_codes.get(ts_code), updated_at)
                        synced_codes.append(ts_code)
                    except Exception as exc:
                        failures.append(str(exc))
                    completed += 1
                    report(f"日线分批续更 {completed - 1 - len(self.benchmark_codes)}/{len(selected_codes)} 只，失败 {len(failures)} 项")

        ready = self.cache.is_replay_ready(
            self.benchmark_codes,
            self.minimum_replay_bars,
        )
        if not ready:
            raise ValueError("通达信快速行情缓存不足，无法形成连续演练窗口")
        report("演练所需行情已就绪", ready=True)

        detail = f"stocks={len(synced_codes)},benchmarks={len(self.benchmark_codes)}"
        if not failures:
            self.cache.mark_sync_success(detail, now=updated_at)
        return {
            "mode": "cache" if not synced_codes and failures else "tdx",
            "state": "partial" if failures else "ready",
            "error": f"{len(failures)}项更新失败，将自动重试" if failures else "",
            "stockCount": len(synced_codes),
            "benchmarkCount": len(self.benchmark_codes),
            "message": f"日线续更完成 {len(synced_codes)}/{len(selected_codes)}只" + (f"，{len(failures)}项失败，保留原缓存" if failures else ""),
        }

    def _resolved_client_factory(self):
        if self.client_factory is not None:
            return self.client_factory
        from .tdx_api import TdxClient

        return TdxClient

    def ensure_ready(
        self,
        *,
        force_refresh: bool = False,
        progress_callback: Any | None = None,
    ) -> dict[str, Any]:
        ready = self.cache.is_replay_ready(
            self.benchmark_codes,
            self.minimum_replay_bars,
        )
        if ready and not force_refresh:
            return {
                "mode": "cache",
                "message": (
                    "通达信行情缓存今日已更新"
                    if self.cache.synced_today(self.now())
                    else "演练行情已就绪，行情更新由后台继续处理"
                ),
            }

        factory = self._resolved_client_factory()
        last_error: Exception | None = None
        try:
            with _FailoverTdxClient(factory, self._connection_hosts()) as client:
                return self.sync_with_client(client, progress_callback=progress_callback)
        except Exception as exc:
            last_error = exc
        if ready:
            return {
                "mode": "cache",
                "state": "partial",
                "error": str(last_error),
                "message": f"通达信连接失败，继续使用本地缓存：{last_error}",
            }
        raise TdxMarketUnavailableError(
            f"通达信连接失败且本地缓存不足，无法初始化行情演练：{last_error or '没有可用服务器'}"
        )

    def _cache_ready(self) -> bool:
        return self.cache.is_replay_ready(
            self.benchmark_codes,
            self.minimum_replay_bars,
        )

    def ensure_unseen_stock_available(
        self,
        excluded_ts_codes: tuple[str, ...],
        *,
        client: Any | None = None,
        target_count: int = 1,
    ) -> bool:
        excluded = {str(code).strip().upper() for code in excluded_ts_codes}
        desired = max(int(target_count), 1)
        inventory = self.cache.sample_inventory(self.minimum_replay_bars)
        # Foreground creation needs one valid unseen stock, not the completion of background reserves.
        if desired == 1 and any(item["eligible"] and item["code"] not in excluded for item in inventory):
            return True
        with self._pool_lock, ExitStack() as connections:
            inventory = self.cache.sample_inventory(self.minimum_replay_bars)
            eligible = {item["code"] for item in inventory if item["eligible"]}
            counts = {board: sum(item["eligible"] and item["code"] not in excluded and item["board"] == board for item in inventory) for board in BOARDS}
            targets = reserve_targets(desired)
            if desired == 1 and sum(counts.values()):
                return True
            if all(counts[board] >= targets[board] for board in BOARDS):
                self._pool_status = {"state": "ready", "completed": desired, "total": desired,
                    "message": "各板块未见日线储备已充足", "error": "", "targets": targets}
                return True
            with self.cache._connect() as connection:
                rows = connection.execute("SELECT ts_code, symbol, name, market, list_status, list_date, delist_date, industry, area, updated_at FROM stock_instruments WHERE list_status = 'L' ORDER BY ts_code").fetchall()
            candidates = self._balanced_instruments([
                dict(zip(("ts_code", "symbol", "name", "market", "list_status", "list_date", "delist_date", "industry", "area", "updated_at"), row))
                for row in rows if str(row[0]) not in excluded and str(row[0]) not in eligible and board_for_code(str(row[0]))
            ])
            # Prefer untried candidates so short/failed histories cannot pin the reserve forever.
            attempts_by_code = {item['code']: item.get('lastAttemptAt') or '' for item in inventory}
            candidates.sort(key=lambda item: attempts_by_code.get(item['ts_code'], ''))
            initial = sum(counts.values())
            self._pool_status = {"state": "running", "completed": 0, "total": max(0, desired - initial),
                "message": "正在按板块准备未见日线样本", "error": "", "targets": targets}
            errors = []
            attempts = 0
            resolved_client = client
            for metadata in candidates:
                code = metadata["ts_code"]
                board = board_for_code(code)
                if desired > 1 and counts[board] >= targets[board]:
                    continue
                if attempts >= max(12, desired * 4):
                    break
                attempts += 1
                try:
                    if resolved_client is None:
                        resolved_client = connections.enter_context(_FailoverTdxClient(self._resolved_client_factory(), self._connection_hosts()))
                    self._sync_stock(resolved_client, code, metadata, self.now())
                    item = next((item for item in self.cache.sample_inventory(self.minimum_replay_bars) if item["code"] == code), None)
                    if not item or not item["eligible"]:
                        errors.append("候选历史长度、交易日历或复权质量不足")
                        continue
                    counts[board] += 1
                    self._pool_status = {**self._pool_status, "completed": sum(counts.values()) - initial}
                    if (desired == 1 and sum(counts.values())) or all(counts[key] >= targets[key] for key in BOARDS):
                        break
                except Exception as exc:
                    errors.append(str(exc))
            fulfilled = all(counts[board] >= targets[board] for board in BOARDS) if desired > 1 else bool(sum(counts.values()))
            self._pool_status = {**self._pool_status, "state": "ready" if fulfilled else "partial" if sum(counts.values()) else "failed",
                "message": "各板块未见日线储备已补足" if fulfilled else "部分板块未见日线储备仍不足",
                "error": "" if fulfilled else ("候选下载或历史质量检查未通过，将自动重试" if errors else "缺额板块没有更多符合条件的候选样本"),
                "counts": counts, "targets": targets, "attempts": attempts}
            return sum(counts.values()) > 0

    def pool_status(self) -> dict[str, Any]:
        return dict(self._pool_status)

    def _update_sync_status(self, payload: dict[str, Any]) -> None:
        with self._status_lock:
            self._sync_status = {**self._sync_status, **payload}

    def replay_cache_status(self) -> dict[str, Any]:
        with self._status_lock:
            status = dict(self._sync_status)
        if status["state"] == "idle" and self._cache_ready() and self.cache.synced_today(self.now()):
            return {
                **status,
                "state": "ready",
                "ready": True,
                "completed": status["total"],
                "message": "本地日线缓存可用，覆盖与更新状态见下方",
            }
        return status

    def prepare_replay_cache(self, *, retry_failed: bool = False) -> dict[str, Any]:
        key = maintenance_key(self.now())
        if self._attempt_key == key and self._sync_status['state'] in {'ready', 'partial', 'failed'} and not retry_failed:
            return self.replay_cache_status()
        if self._attempt_key is None and self._cache_ready() and self.cache.synced_today(self.now()) and key.endswith(':open'):
            self._update_sync_status(
                {
                    "state": "ready",
                    "ready": True,
                    "completed": self._sync_status["total"],
                    "message": "本地日线缓存可用，覆盖与更新状态见下方",
                    "error": "",
                }
            )
            return self.replay_cache_status()

        with self._status_lock:
            if self._sync_thread is not None and self._sync_thread.is_alive():
                return dict(self._sync_status)
            self._attempt_key = key
            self._last_attempt_at = self.now()
            self._sync_status = {
                **self._sync_status,
                "state": "running",
                "ready": self._cache_ready(),
                "completed": 0,
                "message": "正在初始化通达信行情缓存",
                "error": "",
            }
            self._sync_thread = Thread(
                target=self._run_background_sync,
                name="tdx-replay-cache-sync",
                daemon=True,
            )
            self._sync_thread.start()
            return dict(self._sync_status)

    def _run_background_sync(self) -> None:
        try:
            result = self.ensure_ready(
                force_refresh=True,
                progress_callback=self._update_sync_status,
            )
        except Exception as exc:
            self._update_sync_status(
                {
                    "state": "failed",
                    "ready": self._cache_ready(),
                    "message": "通达信行情缓存初始化失败",
                    "error": "行情下载失败，可重试或继续使用可用历史缓存",
                }
            )
            return
        self._update_sync_status(
            {
                "state": result.get("state", "ready"),
                "ready": self._cache_ready(),
                "completed": self._sync_status["total"],
                "message": "通达信更新未完成，继续使用本地缓存" if result.get("mode") == "cache" else result.get("message") or "通达信行情缓存已就绪",
                "error": "部分资源更新失败，将自动重试" if result.get("error") else "",
            }
        )

    def ensure_instruments(self) -> dict[str, Any]:
        cached_count = self.cache.instrument_count()
        if cached_count > 0:
            return {
                "mode": "cache",
                "instrumentCount": cached_count,
                "message": "使用通达信证券名称缓存",
            }
        last_error: Exception | None = None
        factory = self._resolved_client_factory()
        for host in self._connection_hosts():
            try:
                with _FailoverTdxClient(factory, (host,)) as client:
                    rows = self._fetch_instruments(client, datetime.now().replace(microsecond=0))
                if not rows:
                    raise ValueError("通达信证券列表为空")
                self.cache.upsert_instruments(rows)
                return {
                    "mode": "tdx",
                    "instrumentCount": len(rows),
                    "message": "通达信证券名称初始化完成",
                }
            except Exception as exc:
                last_error = exc
        raise TdxMarketUnavailableError(
            f"通达信证券名称下载失败且本地名称缓存为空：{last_error or '没有可用服务器'}"
        )
