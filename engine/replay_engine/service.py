from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any

from .config import MARKET_DB_PATH, MINUTE_REPLAY_DB_PATH
from .data_store import DuckDbBarStore
from .errors import QuantWorkbenchError
from .minute_replay import TdxMinuteReplayProvider
from .tdx_market_cache import (
    TdxMarketCache,
    TdxMarketDataProvider,
    TdxMarketUnavailableError,
)


class ReplayMarketSupply:
    def __init__(
        self,
        store: Any | None = None,
        minute_replay_provider: Any | None = None,
        market_data_provider: Any | None = None,
    ) -> None:
        self.daily_store = store or DuckDbBarStore(source_db_path=MARKET_DB_PATH)
        self.minute_provider = minute_replay_provider or TdxMinuteReplayProvider(
            MINUTE_REPLAY_DB_PATH
        )
        self.market_provider = market_data_provider or TdxMarketDataProvider(
            TdxMarketCache(MARKET_DB_PATH)
        )

    def _ensure_cache(self) -> None:
        try:
            self.market_provider.ensure_ready()
        except TdxMarketUnavailableError as exc:
            raise QuantWorkbenchError(str(exc), 409) from exc

    def benchmarks(self, *, retry_failed: bool = False) -> dict[str, Any]:
        initialization = (
            self.market_provider.prepare_replay_cache(retry_failed=True)
            if retry_failed
            else self.market_provider.prepare_replay_cache()
        )
        if not initialization.get("ready"):
            return {"sourceDataVersion": None, "items": [], "initialization": initialization}
        try:
            return {
                "sourceDataVersion": self.daily_store.source_data_version(),
                "items": self.daily_store.list_replay_benchmarks(),
                "initialization": initialization,
            }
        except (FileNotFoundError, ValueError) as exc:
            raise QuantWorkbenchError(str(exc), 409) from exc

    @staticmethod
    def _file_size(path: Path) -> int:
        try:
            return int(path.stat().st_size)
        except FileNotFoundError:
            return 0

    def cache_status(self) -> dict[str, Any]:
        market_stats = self.market_provider.cache.statistics()
        minute_stats = self.minute_provider.store.statistics()
        initialization = self.market_provider.replay_cache_status()
        pool = self.market_provider.pool_status()
        market_bytes = self._file_size(self.market_provider.cache.path)
        minute_bytes = self._file_size(self.minute_provider.store.path)
        active = pool if pool.get("state") == "running" else initialization
        if initialization.get("state") == "running":
            active = initialization
        state = "running" if active.get("state") == "running" else "ready"
        if initialization.get("state") == "failed" or pool.get("state") == "failed":
            state = "failed"
        return {
            "state": state,
            "activeTask": active,
            "initialization": initialization,
            "stockPool": pool,
            "market": market_stats,
            "minute": minute_stats,
            "storage": {
                "marketBytes": market_bytes,
                "minuteBytes": minute_bytes,
                "totalBytes": market_bytes + minute_bytes,
            },
            "lastSuccessAt": market_stats.get("lastSuccessAt"),
        }

    def prefetch_replay_stocks(
        self,
        excluded_ts_codes: tuple[str, ...],
        *,
        target_reserve: int = 12,
    ) -> dict[str, Any]:
        available = self.market_provider.ensure_unseen_stock_available(
            excluded_ts_codes,
            target_count=target_reserve,
        )
        return {
            "available": available,
            "targetReserve": int(target_reserve),
        }

    def create_scenario(
        self,
        game_length: int,
        benchmark_code: str,
        seed: int | None = None,
        interval: str = "1d",
        *,
        excluded_ts_codes: tuple[str, ...] = (),
        recent_window_end_dates: tuple[date, ...] = (),
    ) -> dict[str, Any]:
        self._ensure_cache()
        if excluded_ts_codes and not self.market_provider.ensure_unseen_stock_available(
            excluded_ts_codes
        ):
            raise QuantWorkbenchError(
                "当前缓存中的新标的已用完，通达信暂时无法补充新的日线标的",
                409,
            )
        normalized_interval = str(interval or "1d").strip().lower()
        supported = {
            "1d": {20, 60, 120},
            "1m": {240, 720, 1200},
            "hybrid": {20, 60, 120},
        }
        if normalized_interval not in supported:
            raise QuantWorkbenchError("interval 只支持 1d、1m、hybrid", 400)
        if int(game_length) not in supported[normalized_interval]:
            values = "、".join(str(value) for value in sorted(supported[normalized_interval]))
            raise QuantWorkbenchError(f"{normalized_interval} 的 gameLength 只支持 {values}", 400)
        benchmark = str(benchmark_code or "").strip().upper()
        if not benchmark:
            raise QuantWorkbenchError("benchmarkCode 不能为空", 400)
        try:
            if normalized_interval == "1d":
                return self.daily_store.create_replay_scenario(
                    game_length=int(game_length),
                    benchmark_code=benchmark,
                    seed=seed,
                    excluded_ts_codes=excluded_ts_codes,
                    recent_window_end_dates=recent_window_end_dates,
                )
            last_error: Exception | None = None
            for attempt in range(6):
                candidate_seed = None if seed is None else int(seed) + attempt
                daily = self.daily_store.create_replay_scenario(
                    game_length=20,
                    benchmark_code=benchmark,
                    seed=candidate_seed,
                    excluded_ts_codes=excluded_ts_codes,
                    recent_window_end_dates=recent_window_end_dates,
                )
                try:
                    options: dict[str, Any] = {
                        "ts_code": daily["tsCode"],
                        "name": daily.get("name", ""),
                        "benchmark_code": benchmark,
                        "game_length": int(game_length),
                        "seed": seed,
                        "hybrid": normalized_interval == "hybrid",
                    }
                    if normalized_interval == "hybrid":
                        cache = self.market_provider.cache
                        options["stock_daily_rows"] = cache.load_history(
                            "stock_daily_bars", daily["tsCode"]
                        ).to_dict("records")
                        options["benchmark_daily_rows"] = cache.load_history(
                            "index_daily_bars", benchmark
                        ).to_dict("records")
                    return self.minute_provider.create_scenario(**options)
                except ValueError as exc:
                    last_error = exc
            raise ValueError(str(last_error or "没有可用的分钟行情"))
        except FileNotFoundError as exc:
            raise QuantWorkbenchError(str(exc), 409) from exc
        except ValueError as exc:
            raise QuantWorkbenchError(str(exc), 404) from exc

    def search_instruments(self, keyword: str, limit: int = 8) -> dict[str, Any]:
        self.market_provider.ensure_ready()
        text = str(keyword or "").strip().lower()
        cached_names = self.daily_store.source_instrument_name_map()
        items = [
            {"orderBookId": code, "name": name}
            for code, name in cached_names.items()
            if not text or text in str(code).lower() or text in str(name).lower()
        ]
        return {"items": items[: max(1, min(int(limit), 50))]}
