"""同步桥接公开发布的 pytdxdata 通达信客户端。"""

from __future__ import annotations

import asyncio
import math
from concurrent.futures import Future
from datetime import datetime
from threading import Event, Thread
from typing import Any, Callable

import pandas as pd
from pytdxdata import KlinePeriod as KlineCategory
from pytdxdata import Market, TdxData


def get_known_hosts() -> tuple[str, ...]:
    """项目自己的 TDX_HOSTS 是稳定且可审核的默认节点列表。"""
    return ()


class TdxClient:
    """为现有同步行情缓存代码提供 pytdxdata 的最小适配。"""

    def __init__(self, host: str, timeout: float = 8, **_options: Any):
        self.host = host
        self.timeout = timeout
        self._data: TdxData | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: Thread | None = None
        self._started = Event()
        self._start_error: BaseException | None = None
        self._security_lists: dict[Market, list[Any]] = {}

    def __enter__(self) -> "TdxClient":
        self._thread = Thread(target=self._run_loop, name=f"tdx-{self.host}", daemon=True)
        self._thread.start()
        self._started.wait()
        if self._start_error is not None:
            raise self._start_error
        self._call(self._start)
        return self

    def __exit__(self, *_args: Any) -> None:
        if self._loop is None:
            return
        try:
            if self._data is not None:
                self._call(self._close)
        finally:
            self._loop.call_soon_threadsafe(self._loop.stop)
            if self._thread is not None:
                self._thread.join(timeout=self.timeout + 2)
            self._loop = None
            self._thread = None
            self._data = None

    def _run_loop(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        self._started.set()
        loop.run_forever()
        loop.close()

    async def _start(self) -> None:
        self._data = TdxData(
            standard_servers=[self.host],
            mac_servers=[self.host],
            timeout=self.timeout,
            cache_dir=None,
            pool_min=1,
            pool_max=6,
        )
        await self._data.start()

    async def _close(self) -> None:
        if self._data is not None:
            await self._data.close()

    def _call(self, operation: Callable[[], Any]) -> Any:
        if self._loop is None:
            raise RuntimeError("通达信客户端未连接")
        future: Future[Any] = asyncio.run_coroutine_threadsafe(operation(), self._loop)
        return future.result(timeout=self.timeout * 12)

    @staticmethod
    def _frame(rows: list[Any]) -> pd.DataFrame:
        return pd.DataFrame(rows)

    def _bars(self, *, market: Market, code: str, category: KlineCategory, start: int, count: int, index: bool) -> pd.DataFrame:
        async def fetch() -> list[dict[str, Any]]:
            if self._data is None:
                raise RuntimeError("通达信客户端未连接")
            method = self._data.get_index_kline if index else self._data.get_kline
            bars = await method(market, code, category, start=start, count=count)
            return [{
                "datetime": datetime(bar.year, bar.month, bar.day, bar.hour, bar.minute),
                "open": bar.open, "high": bar.high, "low": bar.low, "close": bar.close,
                "vol": bar.vol, "amount": bar.amount,
            } for bar in bars]

        return self._frame(self._call(fetch))

    def get_security_bars(self, market: Market, code: str, category: KlineCategory, start: int, count: int, **_kwargs: Any) -> pd.DataFrame:
        return self._bars(market=market, code=code, category=category, start=start, count=count, index=False)

    def get_index_bars(self, market: Market, code: str, category: KlineCategory, start: int, count: int, **_kwargs: Any) -> pd.DataFrame:
        return self._bars(market=market, code=code, category=category, start=start, count=count, index=True)

    def get_security_list(self, market: Market, start: int) -> pd.DataFrame:
        async def fetch() -> list[dict[str, Any]]:
            if self._data is None:
                raise RuntimeError("通达信客户端未连接")
            # pytdxdata 0.3.2 的分页器未应用公开 API 的 start 参数。
            # 一次拉取该市场全量后本地分页，避免缓存初始化重复请求第一页。
            rows = self._security_lists.get(market)
            if rows is None:
                rows = await self._data.get_security_list(market, count=None)
                self._security_lists[market] = rows
            rows = rows[start : start + 1000]
            return [{"code": row.code, "name": row.name} for row in rows]

        return self._frame(self._call(fetch))

    def get_xdxr_info(self, market: Market, code: str) -> pd.DataFrame:
        async def fetch() -> list[dict[str, Any]]:
            if self._data is None:
                raise RuntimeError("通达信客户端未连接")
            rows = await self._data.get_xdxr(market, code)
            return [{
                "date": f"{row.year:04d}-{row.month:02d}-{row.day:02d}",
                "category": row.category, "fenhong": row.fenhong, "peigujia": row.peigujia,
                "songzhuangu": row.songzhuangu, "peigu": row.peigu,
            } for row in rows]

        return self._frame(self._call(fetch))


def apply_forward_adjust(frame: pd.DataFrame, xdxr: pd.DataFrame) -> pd.DataFrame:
    """以通达信除权记录在本地计算前复权，最新价格保持不变。"""
    result = frame.copy()
    if result.empty or xdxr is None or xdxr.empty:
        return result
    result = result.assign(datetime=pd.to_datetime(result["datetime"])).sort_values("datetime").reset_index(drop=True)
    multipliers = [1.0] * len(result)
    for _, event in xdxr[xdxr["category"] == 1].sort_values("date").iterrows():
        positions = result.index[result["datetime"] >= pd.Timestamp(event["date"])]
        if positions.empty or positions[0] == 0:
            continue
        previous = int(positions[0]) - 1
        close = float(result.at[previous, "close"])
        fenhong = float(event.get("fenhong") or 0)
        peigujia = float(event.get("peigujia") or 0)
        songzhuangu = float(event.get("songzhuangu") or 0)
        peigu = float(event.get("peigu") or 0)
        denominator = close * (1 + songzhuangu + peigu)
        factor = (close - fenhong + peigujia * peigu) / denominator if denominator else float("nan")
        if not math.isfinite(factor) or factor <= 0:
            continue
        for index in range(previous + 1):
            multipliers[index] *= factor
    for column in ("open", "high", "low", "close"):
        if column in result:
            result[column] = result[column].astype(float) * multipliers
    return result
