from __future__ import annotations

from datetime import date, datetime
import math
from pathlib import Path
from threading import Lock, Thread
from typing import Any

import duckdb
import pandas as pd


TDX_PAGE_SIZE = 800
TDX_MAX_DAILY_BARS = 8000
TDX_HOSTS = (
    "180.153.18.170",
    "115.238.56.198",
    "111.229.247.189",
)
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


class _RequestScopedTdxClient:
    def __init__(self, factory: Any, host: str) -> None:
        self.factory = factory
        self.host = host

    def _call(self, method_name: str, *args, **kwargs):
        with self.factory(
            host=self.host,
            timeout=8,
            auto_reconnect=True,
            heartbeat_interval=0,
        ) as client:
            return getattr(client, method_name)(*args, **kwargs)

    def get_security_list(self, *args, **kwargs):
        return self._call("get_security_list", *args, **kwargs)

    def get_security_bars(self, *args, **kwargs):
        return self._call("get_security_bars", *args, **kwargs)

    def get_index_bars(self, *args, **kwargs):
        return self._call("get_index_bars", *args, **kwargs)

    def get_xdxr_info(self, *args, **kwargs):
        return self._call("get_xdxr_info", *args, **kwargs)


class _FailoverTdxClient:
    def __init__(self, factory: Any, hosts: tuple[str, ...]) -> None:
        self.factory = factory
        self.hosts = tuple(hosts)

    def _call(self, method_name: str, *args, require_non_empty: bool = False, **kwargs):
        errors: list[str] = []
        for host in self.hosts:
            try:
                result = getattr(
                    _RequestScopedTdxClient(self.factory, host),
                    method_name,
                )(*args, **kwargs)
                if require_non_empty and (result is None or result.empty):
                    raise ValueError("返回空数据")
                return result
            except Exception as exc:
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
    frame["datetime"] = pd.to_datetime(frame["datetime"])
    frame = frame.sort_values("datetime").drop_duplicates("datetime", keep="last")
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
        frame[["open", "high", "low", "close"]].apply(
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
    from easy_tdx.mac.adjust import apply_forward_adjust

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
                if calendar_rows:
                    connection.executemany(
                        "INSERT INTO trade_calendar VALUES (?, ?, ?, ?, ?)",
                        [
                            tuple(row[key] for key in (
                                "exchange", "cal_date", "is_open", "pretrade_date", "updated_at",
                            ))
                            for row in calendar_rows
                        ],
                    )
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise
        finally:
            connection.close()

    def mark_sync_success(self, detail: str) -> None:
        self.ensure_schema()
        connection = self._connect()
        try:
            connection.execute(
                """
                INSERT INTO tdx_cache_sync_state VALUES ('replay-market', CURRENT_TIMESTAMP, ?)
                ON CONFLICT (dataset) DO UPDATE SET
                    last_success_at = EXCLUDED.last_success_at,
                    detail = EXCLUDED.detail
                """,
                [detail],
            )
        finally:
            connection.close()

    def synced_today(self) -> bool:
        self.ensure_schema()
        connection = self._connect()
        try:
            row = connection.execute(
                """
                SELECT CAST(last_success_at AS DATE) = CURRENT_DATE
                FROM tdx_cache_sync_state
                WHERE dataset = 'replay-market'
                """
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
    ) -> None:
        self.cache = cache
        self.hosts = hosts
        self.client_factory = client_factory
        self.initial_stock_count = max(int(initial_stock_count), 1)
        self.minimum_replay_bars = int(minimum_replay_bars)
        self.benchmark_codes = tuple(str(code).upper() for code in benchmark_codes)
        self._status_lock = Lock()
        self._sync_thread: Thread | None = None
        self._sync_status: dict[str, Any] = {
            "state": "idle",
            "ready": False,
            "completed": 0,
            "total": 1 + len(self.benchmark_codes) + self.initial_stock_count,
            "message": "等待初始化通达信行情缓存",
            "error": "",
        }

    def _connection_hosts(self) -> tuple[str, ...]:
        if self.hosts is not None:
            return tuple(self.hosts)
        from easy_tdx.config import get_known_hosts

        return tuple(dict.fromkeys([*get_known_hosts(), *TDX_HOSTS]))

    @staticmethod
    def _market_for_code(ts_code: str):
        from easy_tdx.models.enums import Market

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
        from easy_tdx.models.enums import KlineCategory

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
        updated_at = datetime.now().replace(microsecond=0)
        self.cache.ensure_schema()
        total = 1 + len(self.benchmark_codes) + self.initial_stock_count
        completed = 0
        needs_full_backfill = not self.cache.has_successful_sync()

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
        instruments = self._fetch_instruments(client, updated_at)
        if not instruments:
            raise ValueError("通达信证券列表为空")
        self.cache.upsert_instruments(instruments)
        completed += 1
        report(f"证券名单已缓存，共 {len(instruments)} 只")

        backfill_benchmarks: list[str] = []
        for benchmark_code in self.benchmark_codes:
            latest = self.cache.latest_trade_date("index_daily_bars", benchmark_code)
            bootstrap = latest is None
            bars = self._fetch_daily_pages(
                client,
                benchmark_code,
                is_index=True,
                latest_cached_date=latest,
                maximum_bars=TDX_PAGE_SIZE if bootstrap else TDX_MAX_DAILY_BARS,
            )
            exchange = "SSE" if benchmark_code.endswith(".SH") else "SZSE"
            index_rows, calendar_rows = build_index_history(
                benchmark_code,
                exchange,
                bars,
                updated_at=updated_at,
            )
            self.cache.replace_index_history(
                benchmark_code,
                exchange,
                index_rows,
                (
                    calendar_rows
                    if benchmark_code in {"000001.SH", "399001.SZ"}
                    else None
                ),
            )
            if bootstrap or needs_full_backfill:
                backfill_benchmarks.append(benchmark_code)
            completed += 1
            report(f"指数 {benchmark_code} 已缓存")

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
        selected_codes = [code for code in cached_codes if code in available_codes]
        for suffix in ("SH", "SZ"):
            for code in sorted(code for code in available_codes if code.endswith(f".{suffix}")):
                if code not in selected_codes:
                    selected_codes.append(code)
                if len(selected_codes) >= self.initial_stock_count:
                    break
            if len(selected_codes) >= self.initial_stock_count:
                break
        selected_codes = selected_codes[: max(self.initial_stock_count, len(cached_codes))]
        total = 1 + len(self.benchmark_codes) + len(selected_codes)

        synced_codes: list[str] = []
        backfill_stocks: list[str] = []
        for ts_code in selected_codes:
            latest = self.cache.latest_trade_date("stock_daily_bars", ts_code)
            bootstrap = latest is None
            bars = self._fetch_daily_pages(
                client,
                ts_code,
                is_index=False,
                latest_cached_date=latest,
                maximum_bars=TDX_PAGE_SIZE if bootstrap else TDX_MAX_DAILY_BARS,
            )
            xdxr = client.get_xdxr_info(
                self._market_for_code(ts_code),
                self._symbol(ts_code),
            )
            stock_rows, factor_rows = build_stock_history(
                ts_code,
                bars,
                xdxr,
                updated_at=updated_at,
            )
            self.cache.upsert_stock_history(stock_rows, factor_rows)
            metadata = dict(available_codes[ts_code])
            metadata["list_date"] = stock_rows[0]["trade_date"]
            self.cache.upsert_instruments([metadata])
            synced_codes.append(ts_code)
            if bootstrap or needs_full_backfill:
                backfill_stocks.append(ts_code)
            completed += 1
            report(f"股票 {ts_code} 已缓存")

        ready = self.cache.is_replay_ready(
            self.benchmark_codes,
            self.minimum_replay_bars,
        )
        report("演练所需行情已就绪，正在后台补齐完整历史", ready=ready)

        total += len(backfill_benchmarks) + len(backfill_stocks)
        for benchmark_code in backfill_benchmarks:
            bars = self._fetch_daily_pages(
                client,
                benchmark_code,
                is_index=True,
                latest_cached_date=None,
            )
            exchange = "SSE" if benchmark_code.endswith(".SH") else "SZSE"
            index_rows, calendar_rows = build_index_history(
                benchmark_code,
                exchange,
                bars,
                updated_at=updated_at,
            )
            self.cache.replace_index_history(
                benchmark_code,
                exchange,
                index_rows,
                calendar_rows if benchmark_code in {"000001.SH", "399001.SZ"} else None,
            )
            completed += 1
            report(f"指数 {benchmark_code} 完整历史已补齐", ready=ready)

        for ts_code in backfill_stocks:
            bars = self._fetch_daily_pages(
                client,
                ts_code,
                is_index=False,
                latest_cached_date=None,
            )
            xdxr = client.get_xdxr_info(
                self._market_for_code(ts_code),
                self._symbol(ts_code),
            )
            stock_rows, factor_rows = build_stock_history(
                ts_code,
                bars,
                xdxr,
                updated_at=updated_at,
            )
            self.cache.upsert_stock_history(stock_rows, factor_rows)
            completed += 1
            report(f"股票 {ts_code} 完整历史已补齐", ready=ready)

        detail = f"stocks={len(synced_codes)},benchmarks={len(self.benchmark_codes)}"
        self.cache.mark_sync_success(detail)
        return {
            "mode": "tdx",
            "stockCount": len(synced_codes),
            "benchmarkCount": len(self.benchmark_codes),
            "message": detail,
        }

    def _resolved_client_factory(self):
        if self.client_factory is not None:
            return self.client_factory
        from easy_tdx.client import TdxClient

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
                    if self.cache.synced_today()
                    else "演练行情已就绪，行情更新由后台继续处理"
                ),
            }

        factory = self._resolved_client_factory()
        last_error: Exception | None = None
        try:
            return self.sync_with_client(
                _FailoverTdxClient(factory, self._connection_hosts()),
                progress_callback=progress_callback,
            )
        except Exception as exc:
            last_error = exc
        if ready:
            return {
                "mode": "cache",
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

    def _update_sync_status(self, payload: dict[str, Any]) -> None:
        with self._status_lock:
            self._sync_status = {**self._sync_status, **payload}

    def replay_cache_status(self) -> dict[str, Any]:
        with self._status_lock:
            status = dict(self._sync_status)
        if status["state"] == "idle" and self._cache_ready() and self.cache.synced_today():
            return {
                **status,
                "state": "ready",
                "ready": True,
                "completed": status["total"],
                "message": "通达信行情缓存今日已更新",
            }
        return status

    def prepare_replay_cache(self, *, retry_failed: bool = False) -> dict[str, Any]:
        if self._cache_ready() and self.cache.synced_today():
            self._update_sync_status(
                {
                    "state": "ready",
                    "ready": True,
                    "completed": self._sync_status["total"],
                    "message": "通达信行情缓存今日已更新",
                    "error": "",
                }
            )
            return self.replay_cache_status()

        with self._status_lock:
            if self._sync_thread is not None and self._sync_thread.is_alive():
                return dict(self._sync_status)
            if self._sync_status["state"] == "failed" and not retry_failed:
                return dict(self._sync_status)
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
                    "error": str(exc),
                }
            )
            return
        self._update_sync_status(
            {
                "state": "ready",
                "ready": True,
                "completed": self._sync_status["total"],
                "message": result.get("message") or "通达信行情缓存已就绪",
                "error": "",
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
                rows = self._fetch_instruments(
                    _RequestScopedTdxClient(factory, host),
                    datetime.now().replace(microsecond=0),
                )
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
