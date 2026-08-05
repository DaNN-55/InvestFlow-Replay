from __future__ import annotations

from dataclasses import dataclass
from datetime import date
import hashlib
import math
from pathlib import Path
import random
from threading import Lock
from typing import Any

import duckdb

from .config import CATALOG_DB_PATH, DEFAULT_MARKET_DB_PATH, MARKET_DB_PATH, REPLAY_SOURCE_DB_PATH


SOURCE_PROVIDER = "tdx"
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


SOURCE_DATASETS: dict[str, dict[str, Any]] = {
    "stock_daily_bars": {
        "label": "股票日线",
        "description": "通达信股票日线行情缓存",
        "table": "stock_daily_bars",
        "dateField": "trade_date",
        "keywordFields": ["ts_code"],
        "defaultOrder": "trade_date DESC, ts_code ASC",
    },
    "etf_daily_bars": {
        "label": "ETF 日线",
        "description": "本地 ETF 日线行情缓存",
        "table": "etf_daily_bars",
        "dateField": "trade_date",
        "keywordFields": ["ts_code"],
        "defaultOrder": "trade_date DESC, ts_code ASC",
    },
    "index_daily_bars": {
        "label": "指数日线",
        "description": "通达信指数日线行情缓存",
        "table": "index_daily_bars",
        "dateField": "trade_date",
        "keywordFields": ["ts_code"],
        "defaultOrder": "trade_date DESC, ts_code ASC",
    },
    "index_weights": {
        "label": "指数成分股",
        "description": "指数最新或历史调样期的成分股及权重目录",
        "table": "index_weights",
        "dateField": "trade_date",
        "keywordFields": ["index_code", "index_name", "con_code", "con_name"],
        "defaultOrder": "trade_date DESC, weight DESC, con_code ASC",
    },
    "stock_adj_factors": {
        "label": "股票复权因子",
        "description": "股票前后复权换算因子",
        "table": "stock_adj_factors",
        "dateField": "trade_date",
        "keywordFields": ["ts_code"],
        "defaultOrder": "trade_date DESC, ts_code ASC",
    },
    "etf_adj_factors": {
        "label": "ETF 复权因子",
        "description": "ETF 前后复权换算因子",
        "table": "etf_adj_factors",
        "dateField": "trade_date",
        "keywordFields": ["ts_code"],
        "defaultOrder": "trade_date DESC, ts_code ASC",
    },
    "stock_daily_basic": {
        "label": "股票日度指标",
        "description": "股票估值、换手率、市值等日频基础指标",
        "table": "stock_daily_basic",
        "dateField": "trade_date",
        "keywordFields": ["ts_code"],
        "defaultOrder": "trade_date DESC, ts_code ASC",
    },
    "stock_fina_indicator": {
        "label": "财务指标",
        "description": "股票财务指标原始表",
        "table": "stock_fina_indicator",
        "dateField": "ann_date",
        "keywordFields": ["ts_code"],
        "defaultOrder": "ann_date DESC, ts_code ASC",
    },
    "trade_calendar": {
        "label": "交易日历",
        "description": "交易所开闭市日历",
        "table": "trade_calendar",
        "dateField": "cal_date",
        "keywordFields": ["exchange"],
        "defaultOrder": "cal_date DESC, exchange ASC",
    },
    "stock_instruments": {
        "label": "股票基础信息",
        "description": "股票代码、名称、行业、上市状态等基础资料",
        "table": "stock_instruments",
        "dateField": "list_date",
        "keywordFields": ["ts_code", "symbol", "name", "industry", "area", "market"],
        "defaultOrder": "list_date DESC, ts_code ASC",
    },
    "etf_instruments": {
        "label": "ETF 基础信息",
        "description": "ETF 名称、管理人、类型、基准等基础资料",
        "table": "etf_instruments",
        "dateField": "list_date",
        "keywordFields": ["ts_code", "name", "fund_type", "management", "benchmark"],
        "defaultOrder": "list_date DESC, ts_code ASC",
    },
}


class DuckDbBarStore:
    def __init__(
        self,
        db_path: Path | None = None,
        source_db_path: Path | None = None,
        catalog_db_path: Path | None = None,
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
        resolved_catalog_path = catalog_db_path or CATALOG_DB_PATH or self.db_path or DEFAULT_MARKET_DB_PATH
        self.catalog_db_path = Path(resolved_catalog_path).resolve()
        self._catalog_refresh_lock = Lock()
        self._catalog_summary_version: str | None = None

        if self.db_path is not None and not self.read_only:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            self._ensure_daily_bars_table()
            self._ensure_adjust_factors_table()
            self._ensure_fundamental_snapshots_table()

    def _connect(self, read_only: bool = False) -> duckdb.DuckDBPyConnection:
        if self.db_path is None:
            raise FileNotFoundError("当前实例未启用 Quantflow 本地主市场库")
        return duckdb.connect(str(self.db_path), read_only=read_only)

    def _source_enabled(self) -> bool:
        return self.source_db_path is not None and self.source_db_path.exists()

    def _source_connect(self, read_only: bool = True) -> duckdb.DuckDBPyConnection:
        if not self._source_enabled():
            raise FileNotFoundError("未配置可用的外部原始库")
        del read_only
        return duckdb.connect(str(self.source_db_path))

    def _catalog_connect(self, read_only: bool = False) -> duckdb.DuckDBPyConnection:
        if not read_only:
            self.catalog_db_path.parent.mkdir(parents=True, exist_ok=True)
        return duckdb.connect(str(self.catalog_db_path), read_only=read_only)

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
    def _symbol_exchange_to_ts_code(symbol: str, exchange: str) -> str:
        suffix = {
            "SSE": "SH",
            "SZSE": "SZ",
            "BSE": "BJ",
        }.get(str(exchange or "").strip().upper(), str(exchange or "").strip().upper())
        return f"{str(symbol or '').strip()}.{suffix}"

    @staticmethod
    def _ts_code_to_order_book_id(ts_code: str) -> str:
        symbol, exchange = DuckDbBarStore._ts_code_to_symbol_exchange(ts_code)
        suffix = {
            "SSE": "XSHG",
            "SZSE": "XSHE",
            "BSE": "XBSE",
        }.get(exchange, exchange)
        return f"{symbol}.{suffix}" if suffix else symbol

    @staticmethod
    def _serialize_source_value(value: Any) -> Any:
        if hasattr(value, "isoformat"):
            return value.isoformat()
        return value

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

    def _source_bar_rows(self, table_name: str) -> list[tuple]:
        connection = self._source_connect()
        try:
            return connection.execute(
                f"""
                SELECT
                    ts_code,
                    MIN(trade_date) AS start_date,
                    MAX(trade_date) AS end_date,
                    COUNT(*) AS bars,
                    MAX(updated_at) AS latest_sync_at
                FROM {table_name}
                GROUP BY ts_code
                """
            ).fetchall()
        finally:
            connection.close()

    def _source_factor_rows(self, table_name: str) -> list[tuple]:
        connection = self._source_connect()
        try:
            return connection.execute(
                f"""
                SELECT
                    ts_code,
                    MIN(trade_date) AS start_date,
                    MAX(trade_date) AS end_date,
                    COUNT(*) AS rows,
                    MAX(updated_at) AS latest_sync_at
                FROM {table_name}
                GROUP BY ts_code
                """
            ).fetchall()
        finally:
            connection.close()

    @staticmethod
    def _serialize_catalog_value(value: Any) -> str:
        if value is None:
            return ""
        if hasattr(value, "isoformat"):
            return value.isoformat()
        return str(value)

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

    def _ensure_instrument_catalog_tables(
        self,
        connection: duckdb.DuckDBPyConnection,
    ) -> None:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS instrument_catalog_summary (
                order_book_id VARCHAR PRIMARY KEY,
                ts_code VARCHAR NOT NULL,
                symbol VARCHAR NOT NULL,
                exchange VARCHAR NOT NULL,
                name VARCHAR NOT NULL,
                code VARCHAR NOT NULL,
                instrument_type VARCHAR NOT NULL,
                board_type VARCHAR NOT NULL,
                listed_date VARCHAR NOT NULL,
                delisted_date VARCHAR NOT NULL,
                list_status VARCHAR NOT NULL,
                interval VARCHAR NOT NULL,
                start_date VARCHAR NOT NULL,
                end_date VARCHAR NOT NULL,
                bars BIGINT NOT NULL,
                latest_sync_at VARCHAR NOT NULL,
                available_adjustments VARCHAR[] NOT NULL,
                data_version VARCHAR NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS market_data_version (
                dataset VARCHAR PRIMARY KEY,
                data_version VARCHAR NOT NULL,
                refreshed_at TIMESTAMP NOT NULL
            )
            """
        )

    def _rebuild_external_instrument_catalog_summary(
        self,
        connection: duckdb.DuckDBPyConnection,
        data_version: str,
    ) -> None:
        connection.execute(
            """
                INSERT INTO instrument_catalog_summary
                WITH bar_coverage AS (
                    SELECT
                        ts_code,
                        'CS' AS instrument_type,
                        MIN(trade_date) AS start_date,
                        MAX(trade_date) AS end_date,
                        COUNT(*) AS bars,
                        MAX(updated_at) AS latest_sync_at
                    FROM catalog_source.stock_daily_bars
                    GROUP BY ts_code
                    UNION ALL
                    SELECT
                        ts_code,
                        'ETF' AS instrument_type,
                        MIN(trade_date) AS start_date,
                        MAX(trade_date) AS end_date,
                        COUNT(*) AS bars,
                        MAX(updated_at) AS latest_sync_at
                    FROM catalog_source.etf_daily_bars
                    GROUP BY ts_code
                    UNION ALL
                    SELECT
                        ts_code,
                        'INDX' AS instrument_type,
                        MIN(trade_date) AS start_date,
                        MAX(trade_date) AS end_date,
                        COUNT(*) AS bars,
                        MAX(updated_at) AS latest_sync_at
                    FROM catalog_source.index_daily_bars
                    GROUP BY ts_code
                ),
                factor_coverage AS (
                    SELECT
                        ts_code,
                        MIN(start_date) AS start_date,
                        MAX(end_date) AS end_date,
                        SUM(factor_rows) AS factor_rows,
                        MAX(latest_sync_at) AS latest_sync_at
                    FROM (
                        SELECT
                            ts_code,
                            MIN(trade_date) AS start_date,
                            MAX(trade_date) AS end_date,
                            COUNT(*) AS factor_rows,
                            MAX(updated_at) AS latest_sync_at
                        FROM catalog_source.stock_adj_factors
                        GROUP BY ts_code
                        UNION ALL
                        SELECT
                            ts_code,
                            MIN(trade_date) AS start_date,
                            MAX(trade_date) AS end_date,
                            COUNT(*) AS factor_rows,
                            MAX(updated_at) AS latest_sync_at
                        FROM catalog_source.etf_adj_factors
                        GROUP BY ts_code
                    )
                    GROUP BY ts_code
                ),
                instrument_metadata AS (
                    SELECT
                        ts_code,
                        'CS' AS instrument_type,
                        symbol AS code,
                        name,
                        market AS board_type,
                        list_status,
                        list_date,
                        delist_date
                    FROM catalog_source.stock_instruments
                    UNION ALL
                    SELECT
                        ts_code,
                        'ETF' AS instrument_type,
                        SPLIT_PART(ts_code, '.', 1) AS code,
                        name,
                        market AS board_type,
                        status AS list_status,
                        list_date,
                        delist_date
                    FROM catalog_source.etf_instruments
                )
                SELECT
                    SPLIT_PART(bars.ts_code, '.', 1) || '.' ||
                        CASE UPPER(SPLIT_PART(bars.ts_code, '.', 2))
                            WHEN 'SH' THEN 'XSHG'
                            WHEN 'SZ' THEN 'XSHE'
                            WHEN 'BJ' THEN 'XBSE'
                            ELSE UPPER(SPLIT_PART(bars.ts_code, '.', 2))
                        END AS order_book_id,
                    UPPER(bars.ts_code) AS ts_code,
                    SPLIT_PART(bars.ts_code, '.', 1) AS symbol,
                    CASE UPPER(SPLIT_PART(bars.ts_code, '.', 2))
                        WHEN 'SH' THEN 'SSE'
                        WHEN 'SZ' THEN 'SZSE'
                        WHEN 'BJ' THEN 'BSE'
                        ELSE UPPER(SPLIT_PART(bars.ts_code, '.', 2))
                    END AS exchange,
                    COALESCE(meta.name, '') AS name,
                    COALESCE(meta.code, SPLIT_PART(bars.ts_code, '.', 1)) AS code,
                    bars.instrument_type,
                    COALESCE(meta.board_type, '') AS board_type,
                    COALESCE(CAST(meta.list_date AS VARCHAR), '') AS listed_date,
                    COALESCE(CAST(meta.delist_date AS VARCHAR), '') AS delisted_date,
                    COALESCE(meta.list_status, '') AS list_status,
                    '1d' AS interval,
                    CAST(bars.start_date AS VARCHAR) AS start_date,
                    CAST(bars.end_date AS VARCHAR) AS end_date,
                    bars.bars,
                    CAST(
                        CASE
                            WHEN factors.start_date <= bars.start_date
                                AND factors.end_date >= bars.end_date
                                AND factors.factor_rows >= bars.bars
                            THEN GREATEST(bars.latest_sync_at, factors.latest_sync_at)
                            ELSE bars.latest_sync_at
                        END
                        AS VARCHAR
                    ) AS latest_sync_at,
                    CASE
                        WHEN factors.start_date <= bars.start_date
                            AND factors.end_date >= bars.end_date
                            AND factors.factor_rows >= bars.bars
                        THEN ['none', 'qfq', 'hfq']
                        ELSE ['none']
                    END AS available_adjustments,
                    ? AS data_version
                FROM bar_coverage AS bars
                LEFT JOIN factor_coverage AS factors
                    ON factors.ts_code = bars.ts_code
                LEFT JOIN instrument_metadata AS meta
                    ON meta.ts_code = bars.ts_code
                    AND meta.instrument_type = bars.instrument_type
                """,
            [data_version],
        )

    def _rebuild_local_instrument_catalog_summary(
        self,
        connection: duckdb.DuckDBPyConnection,
        data_version: str,
    ) -> None:
        connection.execute(
            """
            INSERT INTO instrument_catalog_summary
            WITH adjustment_coverage AS (
                SELECT
                    symbol,
                    exchange,
                    interval,
                    adjust,
                    MIN(trade_date) AS start_date,
                    MAX(trade_date) AS end_date,
                    COUNT(*) AS bars,
                    MAX(updated_at) AS latest_sync_at
                FROM daily_bars
                GROUP BY symbol, exchange, interval, adjust
            ),
            instrument_coverage AS (
                SELECT
                    symbol,
                    exchange,
                    interval,
                    MIN(start_date) AS start_date,
                    MAX(end_date) AS end_date,
                    MAX(bars) AS bars,
                    MAX(latest_sync_at) AS latest_sync_at,
                    LIST(
                        adjust
                        ORDER BY CASE adjust
                            WHEN 'none' THEN 0
                            WHEN 'qfq' THEN 1
                            WHEN 'hfq' THEN 2
                            ELSE 3
                        END
                    ) AS available_adjustments
                FROM adjustment_coverage
                GROUP BY symbol, exchange, interval
            )
            SELECT
                bars.symbol || '.' ||
                    CASE UPPER(bars.exchange)
                        WHEN 'SSE' THEN 'XSHG'
                        WHEN 'SZSE' THEN 'XSHE'
                        WHEN 'BSE' THEN 'XBSE'
                        ELSE UPPER(bars.exchange)
                    END AS order_book_id,
                bars.symbol || '.' ||
                    CASE UPPER(bars.exchange)
                        WHEN 'SSE' THEN 'SH'
                        WHEN 'SZSE' THEN 'SZ'
                        WHEN 'BSE' THEN 'BJ'
                        ELSE UPPER(bars.exchange)
                    END AS ts_code,
                bars.symbol,
                UPPER(bars.exchange) AS exchange,
                '' AS name,
                bars.symbol AS code,
                CASE
                    WHEN (
                        UPPER(bars.exchange) = 'SSE'
                        AND bars.symbol IN (
                            '000001', '000016', '000300', '000688',
                            '000852', '000905', '000906'
                        )
                    ) OR (
                        UPPER(bars.exchange) = 'SZSE'
                        AND bars.symbol IN (
                            '399001', '399006', '399303', '399330', '399673'
                        )
                    )
                    THEN 'INDX'
                    WHEN UPPER(bars.exchange) IN ('BSE', 'SZSE') THEN 'CS'
                    WHEN list_contains(bars.available_adjustments, 'qfq')
                        OR list_contains(bars.available_adjustments, 'hfq')
                    THEN 'CS'
                    ELSE 'INDX'
                END AS instrument_type,
                '' AS board_type,
                '' AS listed_date,
                '' AS delisted_date,
                '' AS list_status,
                bars.interval,
                CAST(bars.start_date AS VARCHAR) AS start_date,
                CAST(bars.end_date AS VARCHAR) AS end_date,
                bars.bars,
                CAST(bars.latest_sync_at AS VARCHAR) AS latest_sync_at,
                bars.available_adjustments,
                ? AS data_version
            FROM instrument_coverage AS bars
            """,
            [data_version],
        )

    def _refresh_instrument_catalog_summary(self) -> str:
        data_version = self.source_data_version()
        if (
            self._catalog_summary_version == data_version
            and self.catalog_db_path.exists()
        ):
            return data_version
        with self._catalog_refresh_lock:
            if (
                self._catalog_summary_version == data_version
                and self.catalog_db_path.exists()
            ):
                return data_version
            connection = self._catalog_connect()
            try:
                self._ensure_instrument_catalog_tables(connection)
                current = connection.execute(
                    """
                    SELECT data_version
                    FROM market_data_version
                    WHERE dataset = 'instrument_catalog_summary'
                    """
                ).fetchone()
                if current and str(current[0]) == data_version:
                    self._catalog_summary_version = data_version
                    return data_version

                attached_source = False
                if self._source_enabled():
                    source_path = str(self.source_db_path).replace("'", "''")
                    connection.execute(
                        f"ATTACH '{source_path}' AS catalog_source (READ_ONLY)"
                    )
                    attached_source = True
                connection.execute("BEGIN TRANSACTION")
                try:
                    connection.execute("DELETE FROM instrument_catalog_summary")
                    if attached_source:
                        self._rebuild_external_instrument_catalog_summary(
                            connection,
                            data_version,
                        )
                    else:
                        self._rebuild_local_instrument_catalog_summary(
                            connection,
                            data_version,
                        )
                    connection.execute(
                        """
                        INSERT INTO market_data_version
                            (dataset, data_version, refreshed_at)
                        VALUES ('instrument_catalog_summary', ?, CURRENT_TIMESTAMP)
                        ON CONFLICT (dataset) DO UPDATE SET
                            data_version = EXCLUDED.data_version,
                            refreshed_at = EXCLUDED.refreshed_at
                        """,
                        [data_version],
                    )
                    connection.execute("COMMIT")
                except Exception:
                    connection.execute("ROLLBACK")
                    raise
                finally:
                    if attached_source:
                        connection.execute("DETACH catalog_source")
            finally:
                connection.close()
        self._catalog_summary_version = data_version
        return data_version

    @staticmethod
    def _serialize_catalog_row(row: tuple) -> dict[str, Any]:
        return {
            "orderBookId": str(row[0]),
            "symbol": str(row[1]),
            "exchange": str(row[2]),
            "name": str(row[3] or ""),
            "code": str(row[4] or ""),
            "type": str(row[5] or ""),
            "boardType": str(row[6] or ""),
            "listedDate": str(row[7] or ""),
            "delistedDate": str(row[8] or ""),
            "listStatus": str(row[9] or ""),
            "interval": str(row[10] or ""),
            "startDate": str(row[11] or ""),
            "endDate": str(row[12] or ""),
            "bars": int(row[13] or 0),
            "latestSyncAt": str(row[14] or ""),
            "availableAdjustments": list(row[15] or []),
        }

    def query_instrument_catalog(
        self,
        *,
        page: int = 1,
        page_size: int = 20,
        keyword: str = "",
        instrument_type: str = "",
        exchange: str = "",
        interval: str = "1d",
        adjust: str = "",
        matched_order_book_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        data_version = self._refresh_instrument_catalog_summary()
        where_clauses = ["interval = ?"]
        params: list[Any] = [str(interval or "1d").strip().lower()]
        if keyword.strip():
            normalized_keyword = f"%{keyword.strip()}%"
            keyword_clauses = [
                "symbol ILIKE ?",
                "order_book_id ILIKE ?",
                "name ILIKE ?",
                "code ILIKE ?",
            ]
            params.extend([normalized_keyword] * 4)
            normalized_ids = [
                str(item or "").strip().upper()
                for item in (matched_order_book_ids or [])
                if str(item or "").strip()
            ]
            if normalized_ids:
                keyword_clauses.append(
                    f"UPPER(order_book_id) IN ({', '.join(['?'] * len(normalized_ids))})"
                )
                params.extend(normalized_ids)
            where_clauses.append(f"({' OR '.join(keyword_clauses)})")
        if instrument_type.strip():
            where_clauses.append("instrument_type = ?")
            params.append(instrument_type.strip().upper())
        if exchange.strip():
            where_clauses.append("exchange = ?")
            params.append(exchange.strip().upper())
        if adjust.strip():
            where_clauses.append("list_contains(available_adjustments, ?)")
            params.append(adjust.strip().lower())

        where_sql = " AND ".join(where_clauses)
        normalized_page = max(int(page or 1), 1)
        normalized_page_size = max(1, min(int(page_size or 20), 100))
        offset = (normalized_page - 1) * normalized_page_size
        connection = self._catalog_connect(read_only=True)
        try:
            total = int(
                connection.execute(
                    f"""
                    SELECT COUNT(*)
                    FROM instrument_catalog_summary
                    WHERE {where_sql}
                    """,
                    params,
                ).fetchone()[0]
                or 0
            )
            rows = connection.execute(
                f"""
                SELECT
                    order_book_id,
                    symbol,
                    exchange,
                    name,
                    code,
                    instrument_type,
                    board_type,
                    listed_date,
                    delisted_date,
                    list_status,
                    interval,
                    start_date,
                    end_date,
                    bars,
                    latest_sync_at,
                    available_adjustments
                FROM instrument_catalog_summary
                WHERE {where_sql}
                ORDER BY latest_sync_at DESC, symbol ASC, order_book_id ASC
                LIMIT ? OFFSET ?
                """,
                [*params, normalized_page_size, offset],
            ).fetchall()
        finally:
            connection.close()
        return {
            "items": [self._serialize_catalog_row(row) for row in rows],
            "meta": {
                "page": normalized_page,
                "pageSize": normalized_page_size,
                "total": total,
                "totalPages": max((total + normalized_page_size - 1) // normalized_page_size, 1),
            },
            "dataVersion": data_version,
        }

    def get_instrument_catalog_item(self, order_book_id: str) -> dict[str, Any] | None:
        self._refresh_instrument_catalog_summary()
        connection = self._catalog_connect(read_only=True)
        try:
            row = connection.execute(
                """
                SELECT
                    order_book_id,
                    symbol,
                    exchange,
                    name,
                    code,
                    instrument_type,
                    board_type,
                    listed_date,
                    delisted_date,
                    list_status,
                    interval,
                    start_date,
                    end_date,
                    bars,
                    latest_sync_at,
                    available_adjustments
                FROM instrument_catalog_summary
                WHERE UPPER(order_book_id) = UPPER(?)
                """,
                [str(order_book_id or "").strip()],
            ).fetchone()
        finally:
            connection.close()
        return self._serialize_catalog_row(row) if row else None

    def instrument_catalog_overview(self) -> dict[str, Any]:
        data_version = self._refresh_instrument_catalog_summary()
        connection = self._catalog_connect(read_only=True)
        try:
            row = connection.execute(
                """
                SELECT
                    COUNT(*) AS symbol_count,
                    MAX(latest_sync_at) AS latest_sync_at
                FROM instrument_catalog_summary
                """
            ).fetchone()
        finally:
            connection.close()
        latest_sync_at = str(row[1] or "")
        if " " in latest_sync_at:
            latest_sync_at = latest_sync_at.replace(" ", "T", 1)
        return {
            "dataVersion": data_version,
            "symbolCount": int(row[0] or 0),
            "latestSyncAt": latest_sync_at,
        }

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

    def _source_fetch_raw_bar_rows(
        self,
        symbol: str,
        exchange: str,
        start_date: str,
        end_date: str,
    ) -> list[tuple]:
        ts_code = self._symbol_exchange_to_ts_code(symbol, exchange)
        queries = (
            (
                "stock_daily_bars",
                """
                SELECT
                    ? AS symbol,
                    ? AS exchange,
                    '1d' AS interval,
                    'none' AS adjust,
                    bars.trade_date,
                    bars.open,
                    bars.high,
                    bars.low,
                    bars.close,
                    bars.vol,
                    bars.amount,
                    CASE
                        WHEN bars.pre_close IS NOT NULL AND bars.pre_close <> 0
                        THEN ((bars.high - bars.low) / bars.pre_close) * 100
                        ELSE NULL
                    END AS amplitude,
                    bars.change,
                    bars.pct_chg,
                    basic.turnover_rate,
                    ? AS provider,
                    bars.updated_at
                FROM stock_daily_bars bars
                LEFT JOIN stock_daily_basic basic
                  ON basic.ts_code = bars.ts_code
                 AND basic.trade_date = bars.trade_date
                WHERE bars.ts_code = ?
                  AND bars.trade_date BETWEEN ? AND ?
                ORDER BY bars.trade_date ASC
                """,
            ),
            (
                "etf_daily_bars",
                """
                SELECT
                    ? AS symbol,
                    ? AS exchange,
                    '1d' AS interval,
                    'none' AS adjust,
                    trade_date,
                    open,
                    high,
                    low,
                    close,
                    vol,
                    amount,
                    CASE
                        WHEN pre_close IS NOT NULL AND pre_close <> 0
                        THEN ((high - low) / pre_close) * 100
                        ELSE NULL
                    END AS amplitude,
                    change,
                    pct_chg,
                    NULL AS turnover_rate,
                    ? AS provider,
                    updated_at
                FROM etf_daily_bars
                WHERE ts_code = ?
                  AND trade_date BETWEEN ? AND ?
                ORDER BY trade_date ASC
                """,
            ),
            (
                "index_daily_bars",
                """
                SELECT
                    ? AS symbol,
                    ? AS exchange,
                    '1d' AS interval,
                    'none' AS adjust,
                    trade_date,
                    open,
                    high,
                    low,
                    close,
                    vol,
                    amount,
                    CASE
                        WHEN pre_close IS NOT NULL AND pre_close <> 0
                        THEN ((high - low) / pre_close) * 100
                        ELSE NULL
                    END AS amplitude,
                    change,
                    pct_chg,
                    NULL AS turnover_rate,
                    ? AS provider,
                    updated_at
                FROM index_daily_bars
                WHERE ts_code = ?
                  AND trade_date BETWEEN ? AND ?
                ORDER BY trade_date ASC
                """,
            ),
        )
        connection = self._source_connect()
        try:
            for _table_name, query in queries:
                rows = connection.execute(
                    query,
                    [symbol, exchange, SOURCE_PROVIDER, ts_code, start_date, end_date],
                ).fetchall()
                if rows:
                    return rows
        finally:
            connection.close()
        return []

    def _source_fetch_factor_rows(
        self,
        symbol: str,
        exchange: str,
        start_date: str,
        end_date: str,
    ) -> list[tuple]:
        ts_code = self._symbol_exchange_to_ts_code(symbol, exchange)
        connection = self._source_connect()
        try:
            for table_name in ("stock_adj_factors", "etf_adj_factors"):
                rows = connection.execute(
                    f"""
                    SELECT
                        trade_date,
                        adj_factor,
                        ? AS provider,
                        updated_at
                    FROM {table_name}
                    WHERE ts_code = ?
                      AND trade_date BETWEEN ? AND ?
                    ORDER BY trade_date ASC
                    """,
                    [SOURCE_PROVIDER, ts_code, start_date, end_date],
                ).fetchall()
                if rows:
                    return rows
        finally:
            connection.close()
        return []

    def _source_fetch_factor_anchor_rows(
        self,
        symbol: str,
        exchange: str,
    ) -> tuple[tuple | None, tuple | None]:
        ts_code = self._symbol_exchange_to_ts_code(symbol, exchange)
        connection = self._source_connect()
        try:
            for table_name in ("stock_adj_factors", "etf_adj_factors"):
                latest = connection.execute(
                    f"""
                    SELECT trade_date, adj_factor
                    FROM {table_name}
                    WHERE ts_code = ?
                    ORDER BY trade_date DESC
                    LIMIT 1
                    """,
                    [ts_code],
                ).fetchone()
                earliest = connection.execute(
                    f"""
                    SELECT trade_date, adj_factor
                    FROM {table_name}
                    WHERE ts_code = ?
                    ORDER BY trade_date ASC
                    LIMIT 1
                    """,
                    [ts_code],
                ).fetchone()
                if latest or earliest:
                    return latest, earliest
        finally:
            connection.close()
        return None, None

    def _source_columns(self, table_name: str) -> list[str]:
        connection = self._source_connect()
        try:
            rows = connection.execute(f"PRAGMA table_info('{table_name}')").fetchall()
        finally:
            connection.close()
        return [str(row[1]) for row in rows]

    def list_source_datasets(self) -> list[dict[str, Any]]:
        if not self._source_enabled():
            return []

        connection = self._source_connect()
        try:
            available_tables = {
                str(row[0])
                for row in connection.execute(
                    """
                    SELECT table_name
                    FROM information_schema.tables
                    WHERE table_schema = 'main'
                    """
                ).fetchall()
            }
            datasets: list[dict[str, Any]] = []
            for dataset_key, definition in SOURCE_DATASETS.items():
                table_name = str(definition["table"])
                if table_name not in available_tables:
                    continue
                total_rows = int(
                    connection.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0]
                    or 0
                )
                rows = connection.execute(f"PRAGMA table_info('{table_name}')").fetchall()
                datasets.append(
                    {
                        "key": dataset_key,
                        "label": definition["label"],
                        "description": definition["description"],
                        "table": table_name,
                        "dateField": definition.get("dateField"),
                        "keywordFields": list(definition.get("keywordFields") or []),
                        "columns": [str(row[1]) for row in rows],
                        "totalRows": total_rows,
                    }
                )
        finally:
            connection.close()

        return datasets

    def query_source_dataset(
        self,
        dataset_key: str,
        *,
        page: int = 1,
        page_size: int = 50,
        keyword: str = "",
        start_date: str | None = None,
        end_date: str | None = None,
        field_filters: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        definition = SOURCE_DATASETS.get(str(dataset_key or "").strip())
        if definition is None:
            raise KeyError(dataset_key)

        table_name = str(definition["table"])
        date_field = str(definition.get("dateField") or "").strip()
        keyword_fields = [str(item) for item in definition.get("keywordFields") or []]
        where_clauses: list[str] = []
        params: list[Any] = []
        normalized_field_filters = {
            str(key or "").strip(): value
            for key, value in (field_filters or {}).items()
            if str(key or "").strip()
        }
        valid_columns = set(self._source_columns(table_name)) if normalized_field_filters else set()

        if keyword.strip() and keyword_fields:
            where_clauses.append(
                "(" + " OR ".join([f"CAST({field} AS VARCHAR) ILIKE ?" for field in keyword_fields]) + ")"
            )
            params.extend([f"%{keyword.strip()}%"] * len(keyword_fields))
        if date_field and start_date:
            where_clauses.append(f"{date_field} >= ?")
            params.append(start_date)
        if date_field and end_date:
            where_clauses.append(f"{date_field} <= ?")
            params.append(end_date)
        for field_name, raw_value in normalized_field_filters.items():
            if field_name not in valid_columns:
                raise ValueError(f"invalid field filter: {field_name}")
            values = raw_value if isinstance(raw_value, (list, tuple, set)) else [raw_value]
            normalized_values = [str(item).strip() for item in values if str(item).strip()]
            if not normalized_values:
                continue
            if len(normalized_values) == 1:
                where_clauses.append(f"CAST({field_name} AS VARCHAR) = ?")
                params.append(normalized_values[0])
                continue
            placeholders = ", ".join(["?"] * len(normalized_values))
            where_clauses.append(f"CAST({field_name} AS VARCHAR) IN ({placeholders})")
            params.extend(normalized_values)

        where_sql = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""
        order_sql = str(definition.get("defaultOrder") or "")
        if order_sql:
            order_sql = f"ORDER BY {order_sql}"

        offset = max(page - 1, 0) * page_size
        connection = self._source_connect()
        try:
            total = int(
                connection.execute(
                    f"SELECT COUNT(*) FROM {table_name} {where_sql}",
                    params,
                ).fetchone()[0]
                or 0
            )
            rows = connection.execute(
                f"""
                SELECT *
                FROM {table_name}
                {where_sql}
                {order_sql}
                LIMIT ?
                OFFSET ?
                """,
                [*params, page_size, offset],
            ).fetchall()
            columns = [item[0] for item in connection.description]
        finally:
            connection.close()

        return {
            "dataset": {
                "key": dataset_key,
                "label": definition["label"],
                "description": definition["description"],
                "table": table_name,
                "dateField": date_field or None,
                "keywordFields": keyword_fields,
                "columns": columns,
            },
            "rows": [
                {
                    str(columns[index]): self._serialize_source_value(value)
                    for index, value in enumerate(row)
                }
                for row in rows
            ],
            "meta": {
                "page": page,
                "pageSize": page_size,
                "total": total,
                "totalPages": max((total + page_size - 1) // page_size, 1),
            },
        }

    def _create_daily_bars_table(self, table_name: str = "daily_bars") -> None:
        connection = self._connect()
        try:
            connection.execute(
                f"""
                CREATE TABLE IF NOT EXISTS {table_name} (
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
        finally:
            connection.close()

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

    def upsert_bars(self, bars: list[dict]) -> int:
        if not bars:
            return 0

        connection = self._connect()
        try:
            connection.executemany(
                """
                INSERT OR IGNORE INTO daily_bars (
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
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        bar["symbol"],
                        bar["exchange"],
                        bar["interval"],
                        bar["adjust"],
                        bar["trade_date"],
                        bar["open"],
                        bar["high"],
                        bar["low"],
                        bar["close"],
                        bar["volume"],
                        bar["turnover"],
                        bar.get("amplitude"),
                        bar.get("change"),
                        bar.get("pct_chg"),
                        bar.get("turnover_rate"),
                        bar["provider"],
                        bar["updated_at"],
                    )
                    for bar in bars
                ],
            )
        finally:
            connection.close()
        return len(bars)

    def replace_bars(self, bars: list[dict]) -> int:
        if not bars:
            return 0

        connection = self._connect()
        try:
            self._replace_bars_with_connection(connection, bars)
        finally:
            connection.close()
        return len(bars)

    def delete_bars(
        self,
        symbol: str,
        exchange: str,
        interval: str,
        adjust: str,
        start_date: str,
        end_date: str,
    ) -> int:
        connection = self._connect()
        try:
            cursor = connection.execute(
                """
                DELETE FROM daily_bars
                WHERE symbol = ?
                  AND exchange = ?
                  AND interval = ?
                  AND adjust = ?
                  AND trade_date BETWEEN ? AND ?
                """,
                [symbol, exchange, interval, adjust, start_date, end_date],
            )
            deleted = cursor.rowcount
        finally:
            connection.close()
        return max(int(deleted or 0), 0)

    def replace_bars_in_range(
        self,
        symbol: str,
        exchange: str,
        interval: str,
        adjust: str,
        start_date: str,
        end_date: str,
        bars: list[dict[str, Any]],
    ) -> int:
        connection = self._connect()
        try:
            connection.begin()
            self._delete_bars_with_connection(
                connection,
                symbol=symbol,
                exchange=exchange,
                interval=interval,
                adjust=adjust,
                start_date=start_date,
                end_date=end_date,
            )
            if bars:
                self._replace_bars_with_connection(connection, bars)
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()
        return len(bars)

    def delete_adjust_factors(
        self,
        symbol: str,
        exchange: str,
        start_date: str,
        end_date: str,
    ) -> int:
        connection = self._connect()
        try:
            cursor = connection.execute(
                """
                DELETE FROM adjust_factors
                WHERE symbol = ?
                  AND exchange = ?
                  AND trade_date BETWEEN ? AND ?
                """,
                [symbol, exchange, start_date, end_date],
            )
            deleted = cursor.rowcount
        finally:
            connection.close()
        return max(int(deleted or 0), 0)

    def replace_live_market_data(
        self,
        *,
        symbol: str,
        exchange: str,
        interval: str,
        start_date: str,
        end_date: str,
        raw_bars: list[dict[str, Any]],
        adjust_factor_rows: list[dict[str, Any]] | None = None,
    ) -> tuple[int, int]:
        connection = self._connect()
        try:
            connection.begin()
            for adjust in ("none", "qfq", "hfq"):
                self._delete_bars_with_connection(
                    connection,
                    symbol=symbol,
                    exchange=exchange,
                    interval=interval,
                    adjust=adjust,
                    start_date=start_date,
                    end_date=end_date,
                )
            self._delete_adjust_factors_with_connection(
                connection,
                symbol=symbol,
                exchange=exchange,
                start_date=start_date,
                end_date=end_date,
            )
            if raw_bars:
                self._replace_bars_with_connection(connection, raw_bars)
            if adjust_factor_rows:
                self._upsert_adjust_factors_with_connection(
                    connection,
                    adjust_factor_rows,
                )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()
        return len(raw_bars), len(adjust_factor_rows or [])

    def backfill_adjust_factors_from_local_qfq(
        self,
        start_date: str | None = None,
        end_date: str | None = None,
        provider: str = "tdx",
    ) -> int:
        filters = [
            "raw.interval = '1d'",
            "raw.adjust = 'none'",
            "qfq.interval = '1d'",
            "qfq.adjust = 'qfq'",
            "raw.close > 0",
            "qfq.close > 0",
        ]
        params: list[Any] = []
        if start_date:
            filters.append("raw.trade_date >= ?")
            params.append(start_date)
        if end_date:
            filters.append("raw.trade_date <= ?")
            params.append(end_date)
        where_clause = " AND ".join(filters)

        connection = self._connect()
        try:
            count = int(
                connection.execute(
                    f"""
                    SELECT COUNT(*)
                    FROM daily_bars raw
                    JOIN daily_bars qfq
                      ON raw.symbol = qfq.symbol
                     AND raw.exchange = qfq.exchange
                     AND raw.interval = qfq.interval
                     AND raw.trade_date = qfq.trade_date
                    WHERE {where_clause}
                    """,
                    params,
                ).fetchone()[0]
                or 0
            )
            if count <= 0:
                return 0

            connection.execute(
                f"""
                INSERT OR REPLACE INTO adjust_factors (
                    symbol,
                    exchange,
                    trade_date,
                    factor,
                    provider,
                    updated_at
                )
                SELECT
                    raw.symbol,
                    raw.exchange,
                    raw.trade_date,
                    qfq.close / raw.close AS factor,
                    ?,
                    CURRENT_TIMESTAMP
                FROM daily_bars raw
                JOIN daily_bars qfq
                  ON raw.symbol = qfq.symbol
                 AND raw.exchange = qfq.exchange
                 AND raw.interval = qfq.interval
                 AND raw.trade_date = qfq.trade_date
                WHERE {where_clause}
                """,
                [provider, *params],
            )
        finally:
            connection.close()
        return count

    def purge_legacy_adjusted_bars_covered_by_factors(
        self,
        start_date: str | None = None,
        end_date: str | None = None,
    ) -> int:
        filters = [
            "bars.interval = '1d'",
            "bars.adjust IN ('qfq', 'hfq')",
        ]
        params: list[Any] = []
        if start_date:
            filters.append("bars.trade_date >= ?")
            params.append(start_date)
        if end_date:
            filters.append("bars.trade_date <= ?")
            params.append(end_date)
        where_clause = " AND ".join(filters)

        connection = self._connect()
        try:
            count = int(
                connection.execute(
                    f"""
                    SELECT COUNT(*)
                    FROM daily_bars bars
                    WHERE {where_clause}
                      AND EXISTS (
                        SELECT 1
                        FROM adjust_factors factors
                        WHERE factors.symbol = bars.symbol
                          AND factors.exchange = bars.exchange
                          AND factors.trade_date = bars.trade_date
                      )
                    """,
                    params,
                ).fetchone()[0]
                or 0
            )
            if count <= 0:
                return 0

            connection.execute(
                f"""
                DELETE FROM daily_bars AS bars
                WHERE {where_clause}
                  AND EXISTS (
                    SELECT 1
                    FROM adjust_factors factors
                    WHERE factors.symbol = bars.symbol
                      AND factors.exchange = bars.exchange
                      AND factors.trade_date = bars.trade_date
                  )
                """,
                params,
            )
        finally:
            connection.close()
        return count

    def fetch_bars(
        self,
        symbol: str,
        exchange: str,
        interval: str,
        adjust: str,
        start_date: str,
        end_date: str,
    ) -> list[dict]:
        if self._source_enabled():
            rows = self._source_fetch_raw_bar_rows(symbol, exchange, start_date, end_date)
            if adjust in {"qfq", "hfq"} and rows:
                factor_rows = self._source_fetch_factor_rows(
                    symbol,
                    exchange,
                    start_date,
                    end_date,
                )
                qfq_anchor_row, hfq_anchor_row = self._source_fetch_factor_anchor_rows(
                    symbol,
                    exchange,
                )
                rows = self._build_adjusted_rows(
                    rows,
                    factor_rows,
                    adjust,
                    qfq_anchor_row,
                    hfq_anchor_row,
                )
            elif adjust != "none":
                rows = []

            return [
                {
                    "symbol": row[0],
                    "exchange": row[1],
                    "interval": row[2],
                    "adjust": row[3],
                    "trade_date": row[4].isoformat() if isinstance(row[4], date) else str(row[4]),
                    "open": float(row[5]),
                    "high": float(row[6]),
                    "low": float(row[7]),
                    "close": float(row[8]),
                    "volume": float(row[9]),
                    "turnover": float(row[10]),
                    "amplitude": float(row[11]) if row[11] is not None else None,
                    "change": float(row[12]) if row[12] is not None else None,
                    "pct_chg": float(row[13]) if row[13] is not None else None,
                    "turnover_rate": float(row[14]) if row[14] is not None else None,
                    "provider": row[15],
                    "updated_at": row[16].isoformat() if hasattr(row[16], "isoformat") else str(row[16]),
                }
                for row in rows
            ]

        connection = self._connect(read_only=True)
        try:
            rows = connection.execute(
                """
                SELECT
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
                FROM daily_bars
                WHERE symbol = ?
                  AND exchange = ?
                  AND interval = ?
                  AND adjust = ?
                  AND trade_date BETWEEN ? AND ?
                ORDER BY trade_date ASC
                """,
                [symbol, exchange, interval, adjust, start_date, end_date],
            ).fetchall()

            if not rows and adjust in {"qfq", "hfq"}:
                raw_rows = connection.execute(
                    """
                    SELECT
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
                    FROM daily_bars
                    WHERE symbol = ?
                      AND exchange = ?
                      AND interval = ?
                      AND adjust = 'none'
                      AND trade_date BETWEEN ? AND ?
                    ORDER BY trade_date ASC
                    """,
                    [symbol, exchange, interval, start_date, end_date],
                ).fetchall()
                factor_rows = connection.execute(
                    """
                    SELECT
                        trade_date,
                        factor,
                        provider,
                        updated_at
                    FROM adjust_factors
                    WHERE symbol = ?
                      AND exchange = ?
                      AND trade_date BETWEEN ? AND ?
                    ORDER BY trade_date ASC
                    """,
                    [symbol, exchange, start_date, end_date],
                ).fetchall()
                anchor_row = connection.execute(
                    """
                    SELECT trade_date, factor
                    FROM adjust_factors
                    WHERE symbol = ?
                      AND exchange = ?
                    ORDER BY trade_date DESC
                    LIMIT 1
                    """,
                    [symbol, exchange],
                ).fetchone()
                hfq_anchor_row = connection.execute(
                    """
                    SELECT trade_date, factor
                    FROM adjust_factors
                    WHERE symbol = ?
                      AND exchange = ?
                    ORDER BY trade_date ASC
                    LIMIT 1
                    """,
                    [symbol, exchange],
                ).fetchone()
                rows = self._build_adjusted_rows(
                    raw_rows,
                    factor_rows,
                    adjust,
                    anchor_row,
                    hfq_anchor_row,
                )
        finally:
            connection.close()

        return [
            {
                "symbol": row[0],
                "exchange": row[1],
                "interval": row[2],
                "adjust": row[3],
                "trade_date": row[4].isoformat() if isinstance(row[4], date) else str(row[4]),
                "open": float(row[5]),
                "high": float(row[6]),
                "low": float(row[7]),
                "close": float(row[8]),
                "volume": float(row[9]),
                "turnover": float(row[10]),
                "amplitude": float(row[11]) if row[11] is not None else None,
                "change": float(row[12]) if row[12] is not None else None,
                "pct_chg": float(row[13]) if row[13] is not None else None,
                "turnover_rate": float(row[14]) if row[14] is not None else None,
                "provider": row[15],
                "updated_at": row[16].isoformat() if hasattr(row[16], "isoformat") else str(row[16]),
            }
            for row in rows
        ]

    def fetch_adjust_factors(
        self,
        symbol: str,
        exchange: str,
        start_date: str,
        end_date: str,
    ) -> list[dict[str, Any]]:
        if self._source_enabled():
            rows = self._source_fetch_factor_rows(symbol, exchange, start_date, end_date)
            return [
                {
                    "trade_date": row[0].isoformat() if hasattr(row[0], "isoformat") else str(row[0]),
                    "factor": float(row[1]),
                    "provider": row[2],
                    "updated_at": row[3].isoformat() if hasattr(row[3], "isoformat") else str(row[3]),
                }
                for row in rows
            ]

        connection = self._connect(read_only=True)
        try:
            rows = connection.execute(
                """
                SELECT
                    trade_date,
                    factor,
                    provider,
                    updated_at
                FROM adjust_factors
                WHERE symbol = ?
                  AND exchange = ?
                  AND trade_date BETWEEN ? AND ?
                ORDER BY trade_date ASC
                """,
                [symbol, exchange, start_date, end_date],
            ).fetchall()
        finally:
            connection.close()

        return [
            {
                "trade_date": row[0].isoformat() if hasattr(row[0], "isoformat") else str(row[0]),
                "factor": float(row[1]),
                "provider": row[2],
                "updated_at": row[3].isoformat() if hasattr(row[3], "isoformat") else str(row[3]),
            }
            for row in rows
        ]

    @staticmethod
    def _build_adjusted_rows(
        raw_rows: list[tuple],
        factor_rows: list[tuple],
        adjust: str,
        qfq_anchor_row: tuple | None,
        hfq_anchor_row: tuple | None,
    ) -> list[tuple]:
        if not raw_rows or not factor_rows:
            return []

        factor_map = {}
        latest_updated_at = None
        provider = "tdx"
        for trade_date, factor, row_provider, updated_at in factor_rows:
            key = trade_date.isoformat() if hasattr(trade_date, "isoformat") else str(trade_date)
            factor_map[key] = float(factor)
            provider = row_provider or provider
            if latest_updated_at is None or str(updated_at) > str(latest_updated_at):
                latest_updated_at = updated_at

        qfq_anchor = float(qfq_anchor_row[1]) if qfq_anchor_row and qfq_anchor_row[1] else None
        hfq_anchor = float(hfq_anchor_row[1]) if hfq_anchor_row and hfq_anchor_row[1] else None
        if adjust == "qfq" and not qfq_anchor:
            return []
        if adjust == "hfq" and not hfq_anchor:
            return []

        adjusted_rows: list[tuple] = []
        for row in raw_rows:
            trade_date = row[4].isoformat() if hasattr(row[4], "isoformat") else str(row[4])
            factor = factor_map.get(trade_date)
            if factor is None:
                continue

            if adjust == "qfq":
                ratio = factor / qfq_anchor if qfq_anchor else None
            else:
                ratio = factor / hfq_anchor if hfq_anchor else None
            if ratio is None:
                continue

            adjusted_rows.append(
                (
                    row[0],
                    row[1],
                    row[2],
                    adjust,
                    row[4],
                    float(row[5]) * ratio,
                    float(row[6]) * ratio,
                    float(row[7]) * ratio,
                    float(row[8]) * ratio,
                    float(row[9]),
                    float(row[10]),
                    None,
                    None,
                    None,
                    row[14],
                    provider,
                    latest_updated_at or row[16],
                )
            )
        return adjusted_rows

    def coverage(self) -> list[dict]:
        if self._source_enabled():
            payload: list[dict[str, Any]] = []
            for table_name in ("stock_daily_bars", "etf_daily_bars", "index_daily_bars"):
                for row in self._source_bar_rows(table_name):
                    symbol, exchange = self._ts_code_to_symbol_exchange(str(row[0]))
                    payload.append(
                        {
                            "symbol": symbol,
                            "exchange": exchange,
                            "interval": "1d",
                            "adjust": "none",
                            "startDate": row[1].isoformat() if hasattr(row[1], "isoformat") else str(row[1]),
                            "endDate": row[2].isoformat() if hasattr(row[2], "isoformat") else str(row[2]),
                            "bars": int(row[3] or 0),
                            "provider": SOURCE_PROVIDER,
                            "latestSyncAt": row[4].isoformat() if hasattr(row[4], "isoformat") else str(row[4]),
                        }
                    )
            return sorted(
                payload,
                key=lambda item: (
                    str(item.get("latestSyncAt") or ""),
                    str(item.get("symbol") or ""),
                    str(item.get("adjust") or ""),
                ),
                reverse=True,
            )

        connection = self._connect(read_only=True)
        try:
            rows = connection.execute(
                """
                SELECT
                    symbol,
                    exchange,
                    interval,
                    adjust,
                    MIN(trade_date) AS start_date,
                    MAX(trade_date) AS end_date,
                    COUNT(*) AS bars,
                    MIN(provider) AS provider,
                    MAX(updated_at) AS latest_sync_at
                FROM daily_bars
                GROUP BY symbol, exchange, interval, adjust
                ORDER BY latest_sync_at DESC, symbol ASC, adjust ASC
                """
            ).fetchall()
        finally:
            connection.close()

        return [
            {
                "symbol": row[0],
                "exchange": row[1],
                "interval": row[2],
                "adjust": row[3],
                "startDate": row[4].isoformat(),
                "endDate": row[5].isoformat(),
                "bars": int(row[6]),
                "provider": row[7],
                "latestSyncAt": row[8].isoformat() if hasattr(row[8], "isoformat") else str(row[8]),
            }
            for row in rows
        ]

    def coverage_by_symbol(
        self,
        interval: str = "1d",
        adjust: str = "qfq",
    ) -> dict[tuple[str, str], dict[str, Any]]:
        if self._source_enabled():
            if interval != "1d" or adjust != "none":
                return {}
            coverage: dict[tuple[str, str], dict[str, Any]] = {}
            for table_name in ("stock_daily_bars", "etf_daily_bars", "index_daily_bars"):
                for row in self._source_bar_rows(table_name):
                    symbol, exchange = self._ts_code_to_symbol_exchange(str(row[0]))
                    coverage[(symbol, exchange)] = {
                        "startDate": row[1].isoformat() if hasattr(row[1], "isoformat") else str(row[1]),
                        "endDate": row[2].isoformat() if hasattr(row[2], "isoformat") else str(row[2]),
                        "bars": int(row[3] or 0),
                        "latestSyncAt": row[4].isoformat() if hasattr(row[4], "isoformat") else str(row[4]),
                    }
            return coverage

        connection = self._connect(read_only=True)
        try:
            rows = connection.execute(
                """
                SELECT
                    symbol,
                    exchange,
                    MIN(trade_date) AS start_date,
                    MAX(trade_date) AS end_date,
                    COUNT(*) AS bars,
                    MAX(updated_at) AS latest_sync_at
                FROM daily_bars
                WHERE interval = ?
                  AND adjust = ?
                GROUP BY symbol, exchange
                """,
                [interval, adjust],
            ).fetchall()
        finally:
            connection.close()

        return {
            (str(row[0]), str(row[1])): {
                "startDate": row[2].isoformat() if hasattr(row[2], "isoformat") else str(row[2]),
                "endDate": row[3].isoformat() if hasattr(row[3], "isoformat") else str(row[3]),
                "bars": int(row[4] or 0),
                "latestSyncAt": row[5].isoformat() if hasattr(row[5], "isoformat") else str(row[5]),
            }
            for row in rows
        }

    def adjust_factor_coverage_by_symbol(self) -> dict[tuple[str, str], dict[str, Any]]:
        if self._source_enabled():
            coverage: dict[tuple[str, str], dict[str, Any]] = {}
            for table_name in ("stock_adj_factors", "etf_adj_factors"):
                for row in self._source_factor_rows(table_name):
                    symbol, exchange = self._ts_code_to_symbol_exchange(str(row[0]))
                    coverage[(symbol, exchange)] = {
                        "startDate": row[1].isoformat() if hasattr(row[1], "isoformat") else str(row[1]),
                        "endDate": row[2].isoformat() if hasattr(row[2], "isoformat") else str(row[2]),
                        "rows": int(row[3] or 0),
                        "latestSyncAt": row[4].isoformat() if hasattr(row[4], "isoformat") else str(row[4]),
                    }
            return coverage

        connection = self._connect(read_only=True)
        try:
            rows = connection.execute(
                """
                SELECT
                    symbol,
                    exchange,
                    MIN(trade_date) AS start_date,
                    MAX(trade_date) AS end_date,
                    COUNT(*) AS rows,
                    MAX(updated_at) AS latest_sync_at
                FROM adjust_factors
                GROUP BY symbol, exchange
                """
            ).fetchall()
        finally:
            connection.close()

        return {
            (str(row[0]), str(row[1])): {
                "startDate": row[2].isoformat() if hasattr(row[2], "isoformat") else str(row[2]),
                "endDate": row[3].isoformat() if hasattr(row[3], "isoformat") else str(row[3]),
                "rows": int(row[4] or 0),
                "latestSyncAt": row[5].isoformat() if hasattr(row[5], "isoformat") else str(row[5]),
            }
            for row in rows
        }

    def list_market_trade_dates(self, start_date: str, end_date: str) -> list[str]:
        if self._source_enabled():
            connection = self._source_connect()
            try:
                rows = connection.execute(
                    """
                    SELECT DISTINCT cal_date
                    FROM trade_calendar
                    WHERE is_open = 1
                      AND cal_date BETWEEN ? AND ?
                    ORDER BY cal_date ASC
                    """,
                    [start_date, end_date],
                ).fetchall()
            finally:
                connection.close()

            return [
                row[0].isoformat() if hasattr(row[0], "isoformat") else str(row[0])
                for row in rows
            ]

        connection = self._connect(read_only=True)
        try:
            rows = connection.execute(
                """
                SELECT DISTINCT trade_date
                FROM daily_bars
                WHERE interval = '1d'
                  AND adjust = 'none'
                  AND trade_date BETWEEN ? AND ?
                ORDER BY trade_date ASC
                """,
                [start_date, end_date],
            ).fetchall()
        finally:
            connection.close()

        return [
            row[0].isoformat() if hasattr(row[0], "isoformat") else str(row[0])
            for row in rows
        ]

    def latest_market_snapshot(self, adjust: str = "qfq") -> dict[str, Any] | None:
        if self._source_enabled():
            if adjust != "none":
                return None
            connection = self._source_connect()
            try:
                row = connection.execute(
                    """
                    WITH latest AS (
                        SELECT MAX(trade_date) AS trade_date
                        FROM (
                            SELECT trade_date FROM stock_daily_bars
                            UNION ALL
                            SELECT trade_date FROM etf_daily_bars
                            UNION ALL
                            SELECT trade_date FROM index_daily_bars
                        )
                    ),
                    merged AS (
                        SELECT ts_code, trade_date, updated_at FROM stock_daily_bars
                        UNION ALL
                        SELECT ts_code, trade_date, updated_at FROM etf_daily_bars
                        UNION ALL
                        SELECT ts_code, trade_date, updated_at FROM index_daily_bars
                    )
                    SELECT
                        latest.trade_date,
                        COUNT(*) AS row_count,
                        COUNT(DISTINCT merged.ts_code) AS symbol_count,
                        MAX(merged.updated_at) AS latest_sync_at
                    FROM merged, latest
                    WHERE merged.trade_date = latest.trade_date
                    GROUP BY latest.trade_date
                    """
                ).fetchone()
            finally:
                connection.close()
            if not row:
                return None
            return {
                "tradeDate": row[0].isoformat() if hasattr(row[0], "isoformat") else str(row[0]),
                "rowCount": int(row[1] or 0),
                "symbolCount": int(row[2] or 0),
                "latestSyncAt": row[3].isoformat() if hasattr(row[3], "isoformat") else str(row[3]),
                "adjust": "none",
            }

        connection = self._connect(read_only=True)
        try:
            row = connection.execute(
                """
                WITH latest AS (
                    SELECT MAX(trade_date) AS trade_date
                    FROM daily_bars
                    WHERE interval = '1d'
                      AND adjust = ?
                )
                SELECT
                    latest.trade_date,
                    COUNT(*) AS row_count,
                    COUNT(DISTINCT symbol || '.' || exchange) AS symbol_count,
                    MAX(updated_at) AS latest_sync_at
                FROM daily_bars, latest
                WHERE daily_bars.interval = '1d'
                  AND daily_bars.adjust = ?
                  AND daily_bars.trade_date = latest.trade_date
                GROUP BY latest.trade_date
                """,
                [adjust, adjust],
            ).fetchone()
            if (not row or row[0] is None) and adjust != "none":
                row = connection.execute(
                    """
                    WITH latest AS (
                        SELECT MAX(trade_date) AS trade_date
                        FROM daily_bars
                        WHERE interval = '1d'
                          AND adjust = 'none'
                    )
                    SELECT
                        latest.trade_date,
                        COUNT(*) AS row_count,
                        COUNT(DISTINCT symbol || '.' || exchange) AS symbol_count,
                        MAX(updated_at) AS latest_sync_at
                    FROM daily_bars, latest
                    WHERE daily_bars.interval = '1d'
                      AND daily_bars.adjust = 'none'
                      AND daily_bars.trade_date = latest.trade_date
                    GROUP BY latest.trade_date
                    """
                ).fetchone()
        finally:
            connection.close()

        if not row or row[0] is None:
            return None

        return {
            "tradeDate": row[0].isoformat() if hasattr(row[0], "isoformat") else str(row[0]),
            "rowCount": int(row[1] or 0),
            "symbolCount": int(row[2] or 0),
            "latestSyncAt": row[3].isoformat() if hasattr(row[3], "isoformat") else str(row[3]),
            "adjust": adjust,
        }

    def latest_adjust_factor_snapshot(self) -> dict[str, Any] | None:
        if self._source_enabled():
            connection = self._source_connect()
            try:
                row = connection.execute(
                    """
                    WITH latest AS (
                        SELECT MAX(trade_date) AS trade_date
                        FROM (
                            SELECT trade_date FROM stock_adj_factors
                            UNION ALL
                            SELECT trade_date FROM etf_adj_factors
                        )
                    ),
                    merged AS (
                        SELECT ts_code, trade_date, updated_at FROM stock_adj_factors
                        UNION ALL
                        SELECT ts_code, trade_date, updated_at FROM etf_adj_factors
                    )
                    SELECT
                        latest.trade_date,
                        COUNT(*) AS row_count,
                        COUNT(DISTINCT merged.ts_code) AS symbol_count,
                        MAX(merged.updated_at) AS latest_sync_at
                    FROM merged, latest
                    WHERE merged.trade_date = latest.trade_date
                    GROUP BY latest.trade_date
                    """
                ).fetchone()
            finally:
                connection.close()
            if not row:
                return None
            return {
                "tradeDate": row[0].isoformat() if hasattr(row[0], "isoformat") else str(row[0]),
                "rowCount": int(row[1] or 0),
                "symbolCount": int(row[2] or 0),
                "latestSyncAt": row[3].isoformat() if hasattr(row[3], "isoformat") else str(row[3]),
            }

        connection = self._connect(read_only=True)
        try:
            row = connection.execute(
                """
                WITH latest AS (
                    SELECT MAX(trade_date) AS trade_date
                    FROM adjust_factors
                )
                SELECT
                    latest.trade_date,
                    COUNT(*) AS row_count,
                    COUNT(DISTINCT symbol || '.' || exchange) AS symbol_count,
                    MAX(updated_at) AS latest_sync_at
                FROM adjust_factors, latest
                WHERE adjust_factors.trade_date = latest.trade_date
                GROUP BY latest.trade_date
                """
            ).fetchone()
        finally:
            connection.close()

        if not row:
            return None

        return {
            "tradeDate": row[0].isoformat() if hasattr(row[0], "isoformat") else str(row[0]),
            "rowCount": int(row[1] or 0),
            "symbolCount": int(row[2] or 0),
            "latestSyncAt": row[3].isoformat() if hasattr(row[3], "isoformat") else str(row[3]),
        }

    def list_fundamental_as_of_dates(self, start_date: str, end_date: str) -> list[str]:
        connection = self._connect(read_only=True)
        try:
            rows = connection.execute(
                """
                SELECT DISTINCT as_of_date
                FROM fundamental_snapshots
                WHERE as_of_date BETWEEN ? AND ?
                ORDER BY as_of_date ASC
                """,
                [start_date, end_date],
            ).fetchall()
        finally:
            connection.close()

        return [
            row[0].isoformat() if hasattr(row[0], "isoformat") else str(row[0])
            for row in rows
        ]

    def upsert_adjust_factors(self, rows: list[dict[str, Any]]) -> int:
        if not rows:
            return 0

        connection = self._connect()
        try:
            self._upsert_adjust_factors_with_connection(connection, rows)
        finally:
            connection.close()
        return len(rows)

    def _replace_bars_with_connection(
        self,
        connection: duckdb.DuckDBPyConnection,
        bars: list[dict[str, Any]],
    ) -> None:
        connection.executemany(
            """
            INSERT OR REPLACE INTO daily_bars (
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    bar["symbol"],
                    bar["exchange"],
                    bar["interval"],
                    bar["adjust"],
                    bar["trade_date"],
                    bar["open"],
                    bar["high"],
                    bar["low"],
                    bar["close"],
                    bar["volume"],
                    bar["turnover"],
                    bar.get("amplitude"),
                    bar.get("change"),
                    bar.get("pct_chg"),
                    bar.get("turnover_rate"),
                    bar["provider"],
                    bar["updated_at"],
                )
                for bar in bars
            ],
        )

    def _delete_bars_with_connection(
        self,
        connection: duckdb.DuckDBPyConnection,
        *,
        symbol: str,
        exchange: str,
        interval: str,
        adjust: str,
        start_date: str,
        end_date: str,
    ) -> int:
        cursor = connection.execute(
            """
            DELETE FROM daily_bars
            WHERE symbol = ?
              AND exchange = ?
              AND interval = ?
              AND adjust = ?
              AND trade_date BETWEEN ? AND ?
            """,
            [symbol, exchange, interval, adjust, start_date, end_date],
        )
        return max(int(cursor.rowcount or 0), 0)

    def _delete_adjust_factors_with_connection(
        self,
        connection: duckdb.DuckDBPyConnection,
        *,
        symbol: str,
        exchange: str,
        start_date: str,
        end_date: str,
    ) -> int:
        cursor = connection.execute(
            """
            DELETE FROM adjust_factors
            WHERE symbol = ?
              AND exchange = ?
              AND trade_date BETWEEN ? AND ?
            """,
            [symbol, exchange, start_date, end_date],
        )
        return max(int(cursor.rowcount or 0), 0)

    def _upsert_adjust_factors_with_connection(
        self,
        connection: duckdb.DuckDBPyConnection,
        rows: list[dict[str, Any]],
    ) -> None:
        connection.executemany(
            """
            INSERT OR REPLACE INTO adjust_factors (
                symbol,
                exchange,
                trade_date,
                factor,
                provider,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    row["symbol"],
                    row["exchange"],
                    row["trade_date"],
                    row["factor"],
                    row["provider"],
                    row["updated_at"],
                )
                for row in rows
            ],
        )

    def upsert_fundamental_snapshots(self, rows: list[dict[str, Any]]) -> int:
        if not rows:
            return 0

        connection = self._connect()
        try:
            connection.executemany(
                """
                INSERT OR REPLACE INTO fundamental_snapshots (
                    as_of_date,
                    source_trade_date,
                    report_period,
                    symbol,
                    exchange,
                    order_book_id,
                    pe_ttm,
                    pb,
                    roe,
                    revenue_growth,
                    gross_margin,
                    operating_cashflow_ratio,
                    debt_to_asset,
                    eps_basic,
                    book_value_per_share,
                    provider,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        row["as_of_date"],
                        row.get("source_trade_date"),
                        row.get("report_period"),
                        row["symbol"],
                        row["exchange"],
                        row["order_book_id"],
                        row.get("pe_ttm"),
                        row.get("pb"),
                        row.get("roe"),
                        row.get("revenue_growth"),
                        row.get("gross_margin"),
                        row.get("operating_cashflow_ratio"),
                        row.get("debt_to_asset"),
                        row.get("eps_basic"),
                        row.get("book_value_per_share"),
                        row["provider"],
                        row["updated_at"],
                    )
                    for row in rows
                ],
            )
        finally:
            connection.close()
        return len(rows)

    def fetch_fundamental_snapshots(
        self,
        as_of_date: str,
        order_book_ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        normalized_ids = [str(item).strip().upper() for item in (order_book_ids or []) if str(item).strip()]
        query = """
            SELECT
                as_of_date,
                source_trade_date,
                report_period,
                symbol,
                exchange,
                order_book_id,
                pe_ttm,
                pb,
                roe,
                revenue_growth,
                gross_margin,
                operating_cashflow_ratio,
                debt_to_asset,
                eps_basic,
                book_value_per_share,
                provider,
                updated_at
            FROM fundamental_snapshots
            WHERE as_of_date = ?
        """
        params: list[Any] = [as_of_date]
        if normalized_ids:
            placeholders = ", ".join(["?"] * len(normalized_ids))
            query += f" AND order_book_id IN ({placeholders})"
            params.extend(normalized_ids)
        query += " ORDER BY order_book_id ASC"

        connection = self._connect(read_only=True)
        try:
            rows = connection.execute(query, params).fetchall()
        finally:
            connection.close()

        return [
            {
                "asOfDate": row[0].isoformat() if hasattr(row[0], "isoformat") else str(row[0]),
                "sourceTradeDate": row[1].isoformat() if hasattr(row[1], "isoformat") else (str(row[1]) if row[1] is not None else None),
                "reportPeriod": row[2].isoformat() if hasattr(row[2], "isoformat") else (str(row[2]) if row[2] is not None else None),
                "symbol": row[3],
                "exchange": row[4],
                "orderBookId": row[5],
                "peTtm": float(row[6]) if row[6] is not None else None,
                "pb": float(row[7]) if row[7] is not None else None,
                "roe": float(row[8]) if row[8] is not None else None,
                "revenueGrowth": float(row[9]) if row[9] is not None else None,
                "grossMargin": float(row[10]) if row[10] is not None else None,
                "operatingCashflowRatio": float(row[11]) if row[11] is not None else None,
                "debtToAsset": float(row[12]) if row[12] is not None else None,
                "epsBasic": float(row[13]) if row[13] is not None else None,
                "bookValuePerShare": float(row[14]) if row[14] is not None else None,
                "provider": row[15],
                "updatedAt": row[16].isoformat() if hasattr(row[16], "isoformat") else str(row[16]),
            }
            for row in rows
        ]

    def latest_fundamental_snapshot(self) -> dict[str, Any] | None:
        connection = self._connect(read_only=True)
        try:
            row = connection.execute(
                """
                WITH latest AS (
                    SELECT MAX(as_of_date) AS as_of_date
                    FROM fundamental_snapshots
                )
                SELECT
                    latest.as_of_date,
                    MAX(source_trade_date) AS source_trade_date,
                    MAX(report_period) AS report_period,
                    COUNT(*) AS symbol_count,
                    MAX(updated_at) AS latest_sync_at
                FROM fundamental_snapshots, latest
                WHERE fundamental_snapshots.as_of_date = latest.as_of_date
                GROUP BY latest.as_of_date
                """
            ).fetchone()
        finally:
            connection.close()

        if not row or row[0] is None:
            return None

        return {
            "asOfDate": row[0].isoformat() if hasattr(row[0], "isoformat") else str(row[0]),
            "sourceTradeDate": row[1].isoformat() if hasattr(row[1], "isoformat") else (str(row[1]) if row[1] is not None else None),
            "reportPeriod": row[2].isoformat() if hasattr(row[2], "isoformat") else (str(row[2]) if row[2] is not None else None),
            "symbolCount": int(row[3] or 0),
            "latestSyncAt": row[4].isoformat() if hasattr(row[4], "isoformat") else str(row[4]),
        }
