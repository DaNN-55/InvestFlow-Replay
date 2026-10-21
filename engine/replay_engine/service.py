from __future__ import annotations

from datetime import date
from contextlib import ExitStack
import logging
from threading import Event, Lock, Thread
from typing import Any

from .config import MARKET_DB_PATH, MINUTE_REPLAY_DB_PATH
from .data_store import DuckDbBarStore
from .errors import QuantWorkbenchError
from .minute_replay import TdxMinuteReplayProvider
from .replay_cache_policy import BOARDS, MAINTENANCE_INTERVAL, RETRY_SECONDS, board_for_code, maintenance_key
from .replay_cache_coverage import cache_coverage
from .tdx_market_cache import (
    TdxMarketCache,
    TdxMarketDataProvider,
    TdxMarketUnavailableError,
)


def create_market_supply(provider: str | None = None) -> Any:
    from .config import MARKET_PROVIDER

    selected = str(provider or MARKET_PROVIDER).strip().lower()
    if selected == "fixture":
        from .fixture_market import FixtureReplayMarketSupply

        return FixtureReplayMarketSupply()
    if selected == "tdx":
        return ReplayMarketSupply()
    raise ValueError("INVESTFLOW_REPLAY_MARKET_PROVIDER 只支持 tdx 或 fixture")


class ReplayMarketSupply:
    provider_name = "tdx"

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
        self._prefetch_lock = Lock()
        self._maintenance_lock = Lock()
        self._maintenance_stop = Event()
        self._maintenance_thread: Thread | None = None
        self._reserve_request: dict[str, Any] | None = None
        self._minute_key: str | None = None
        self._minute_attempt_at = None
        self._maintenance_status = {'state': 'idle', 'message': '等待样本维护', 'error': ''}
        self._minute_reserve_status = {'state': 'idle', 'message': '尚未请求五分钟预取', 'error': ''}
        self._reserve_attempt_at = None
        self._reserve_completed_signature = None
        self._reserve_completed_key = None
        self._reserve_result: dict[str, Any] = {}

    def start_maintenance(self) -> None:
        if self._maintenance_thread is not None and self._maintenance_thread.is_alive():
            return
        self._maintenance_stop.clear()
        def run():
            while not self._maintenance_stop.wait(MAINTENANCE_INTERVAL):
                try:
                    self.maintain_once()
                except Exception:
                    logging.getLogger(__name__).exception('样本维护失败')
        self._maintenance_thread = Thread(target=run, name='replay-sample-maintenance', daemon=True)
        self._maintenance_thread.start()

    def stop_maintenance(self) -> None:
        self._maintenance_stop.set()
        if self._maintenance_thread is not None:
            self._maintenance_thread.join(timeout=1)

    def maintain_once(self) -> dict[str, Any]:
        if not self._maintenance_lock.acquire(blocking=False):
            return dict(self._maintenance_status)
        try:
            now = self.market_provider.now()
            state = self.market_provider.prepare_replay_cache(retry_failed=self.market_provider.background_retry_due())
            if state['state'] == 'running' or not state.get('ready'):
                return state
            self.minute_provider.required_trade_date = self.market_provider.completed_trade_date()
            key = maintenance_key(now)
            retry_minute = self._maintenance_status['state'] in {'partial', 'failed'} and (self._minute_attempt_at is None or (now - self._minute_attempt_at).total_seconds() >= RETRY_SECONDS)
            retry_reserve = (self.market_provider.pool_status()['state'] in {'partial', 'failed'} or self._minute_reserve_status['state'] in {'partial', 'failed'}) and (self._reserve_attempt_at is None or (now - self._reserve_attempt_at).total_seconds() >= RETRY_SECONDS)
            pending_reserve = self._reserve_request is not None and self._request_signature(self._reserve_request) != self._reserve_completed_signature
            if key != self._minute_key or retry_minute or retry_reserve or pending_reserve:
                self._minute_key, self._minute_attempt_at = key, now
                self._maintenance_status = {'state': 'running', 'message': '正在分批续更已有五分钟缓存', 'error': ''}
                result = self.minute_provider.refresh_cached()
                if self._reserve_request is not None:
                    request = dict(self._reserve_request)
                    self.prefetch_replay_stocks(**request, _remember_request=False)
                self._maintenance_status = result
            return dict(self._maintenance_status)
        except Exception as exc:
            self._maintenance_status = {'state': 'failed', 'message': '样本维护失败，已有历史缓存保留', 'error': '样本更新失败，将自动重试'}
            return dict(self._maintenance_status)
        finally:
            self._maintenance_lock.release()

    def _ensure_cache(self) -> None:
        try:
            self.market_provider.ensure_ready()
        except TdxMarketUnavailableError as exc:
            raise QuantWorkbenchError(
                str(exc), 409, "MARKET_CACHE_INSUFFICIENT"
            ) from exc

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
            raise QuantWorkbenchError(
                str(exc), 409, "MARKET_CACHE_INSUFFICIENT"
            ) from exc

    def cache_status(self, excluded_ts_codes: tuple[str, ...] = (), *, benchmark_code: str = '') -> dict[str, Any]:
        market_snapshot = self.market_provider.cache_snapshot()
        minute_snapshot = self.minute_provider.cache_snapshot()
        market_stats = market_snapshot["statistics"]
        minute_stats = minute_snapshot["statistics"]
        initialization = self.market_provider.replay_cache_status()
        pool = self.market_provider.pool_status()
        market_bytes = market_snapshot["storageBytes"]
        minute_bytes = minute_snapshot["storageBytes"]
        coverage = cache_coverage(market_snapshot.get('inventory', []), minute_snapshot.get('inventory', []),
            excluded=excluded_ts_codes, target_date=self.market_provider.completed_trade_date(),
            minimum_bars=self.market_provider.minimum_replay_bars,
            daily_target=(self._reserve_request or {}).get('target_reserve', 12),
            benchmark_code=benchmark_code or (self._reserve_request or {}).get('benchmark_code') or '000001.SH')
        coverage['dailyFailedResourceCount'] = market_snapshot.get('failedResourceCount', 0)
        maintenance = dict(self._maintenance_status)
        tasks = [initialization, pool, maintenance, dict(self._minute_reserve_status)]
        active = next((task for task in tasks if task.get('state') == 'running'), None) or next((task for task in tasks if task.get('state') in {'partial', 'failed'}), initialization)
        if initialization.get("state") == "running":
            active = initialization
        state = "running" if active.get("state") == "running" else "ready"
        if state != 'running':
            if initialization.get('state') == 'failed' and not initialization.get('ready'):
                state = 'failed'
            else:
                incomplete_task = any(item.get('state') in {'failed', 'partial'} for item in tasks)
                incomplete_board = any(
                    group['staleCount'] or group['failedCount']
                    for board in coverage['boards']
                    for group in (board['daily'], board['fiveMinute'])
                )
                incomplete_benchmark = minute_stats.get('fiveMinuteInstrumentCount', 0) > 0 and not coverage['benchmarkCurrent']
                if (incomplete_task or incomplete_board or incomplete_benchmark
                        or coverage['targetTradeDate'] is None or coverage['dailyFailedResourceCount']):
                    state = 'partial'
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
            "coverage": coverage,
            "maintenance": maintenance,
            "minuteReserve": dict(self._minute_reserve_status),
        }

    @staticmethod
    def _request_signature(request):
        return (tuple(sorted(request['excluded_ts_codes'])), request['target_reserve'], request['interval'], request['benchmark_code'])

    def prefetch_replay_stocks(
        self,
        excluded_ts_codes: tuple[str, ...],
        *,
        target_reserve: int = 12,
        interval: str = "1d",
        benchmark_code: str = "",
        _remember_request: bool = True,
    ) -> dict[str, Any]:
        if _remember_request:
            excluded_ts_codes = tuple(set(excluded_ts_codes) | set((self._reserve_request or {}).get("excluded_ts_codes", ())))
            self._reserve_request = {'excluded_ts_codes': tuple(excluded_ts_codes), 'target_reserve': target_reserve,
            'interval': interval, 'benchmark_code': benchmark_code}
        if not self._prefetch_lock.acquire(blocking=False):
            return {"state": "running"}
        try:
            request = dict(self._reserve_request)
            signature = self._request_signature(request)
            now = self.market_provider.now()
            if signature == self._reserve_completed_signature and self._reserve_completed_key == maintenance_key(now) and self._reserve_attempt_at is not None and (now - self._reserve_attempt_at).total_seconds() < RETRY_SECONDS:
                return dict(self._reserve_result)
            excluded_ts_codes = request['excluded_ts_codes']
            target_reserve, interval, benchmark_code = request['target_reserve'], request['interval'], request['benchmark_code']
            self._reserve_attempt_at = now
            self.minute_provider.required_trade_date = self.market_provider.completed_trade_date()
            available = self.market_provider.ensure_unseen_stock_available(
                excluded_ts_codes, target_count=target_reserve,
            )
            prepared = 0
            if available and interval == "hybrid" and benchmark_code:
                excluded = set(excluded_ts_codes)
                cached = self.minute_provider.prefetched_codes(benchmark_code) - excluded
                counts = {board: sum(board_for_code(code) == board for code in cached) for board in BOARDS}
                prepared = sum(min(1, count) for count in counts.values())
                errors = []
                candidates = self.market_provider.unseen_eligible_codes(tuple(excluded | cached))
                inventory = self.minute_provider.cache_snapshot().get('inventory', [])
                attempted = {item['code']: str(item.get('lastAttemptAt') or '') for item in inventory if item['kind'] == 'stock-5m'}
                candidates.sort(key=lambda code: attempted.get(code, ''))
                groups = {board: [code for code in candidates if board_for_code(code) == board] for board in BOARDS}
                candidates = [groups[board][index] for index in range(max((len(group) for group in groups.values()), default=0)) for board in BOARDS if index < len(groups[board])]
                with ExitStack() as connections:
                    client = None
                    attempts = 0
                    for code in candidates:
                        board = board_for_code(code)
                        if board is None or counts[board] >= 1:
                            continue
                        if attempts >= 12:
                            break
                        attempts += 1
                        try:
                            if client is None:
                                client = connections.enter_context(self.minute_provider.download_client())
                            self.minute_provider.prefetch(code, benchmark_code, client=client)
                            counts[board] += 1
                        except Exception as exc:
                            errors.append(str(exc))
                            logging.getLogger(__name__).exception("五分钟预取失败")
                prepared = sum(min(1, count) for count in counts.values())
                self._reserve_attempt_at = self.market_provider.now()
                self._minute_reserve_status = {'state': 'ready' if prepared == 3 else 'partial',
                    'message': f'五分钟未见板块储备 {prepared}/3', 'error': '部分分钟下载失败，将自动重试' if errors else ''}
            if not available and interval == 'hybrid':
                self._minute_reserve_status = {'state': 'partial', 'message': '日线未见样本不足，五分钟储备等待补充', 'error': ''}
            result = {"available": available, "targetReserve": int(target_reserve)}
            if interval == "hybrid":
                result["minutePrepared"] = prepared
            self._reserve_completed_signature = signature
            self._reserve_completed_key = maintenance_key(now)
            self._reserve_result = dict(result)
            return result
        finally:
            self._prefetch_lock.release()

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
        self.minute_provider.required_trade_date = self.market_provider.completed_trade_date()
        if excluded_ts_codes and not self.market_provider.ensure_unseen_stock_available(
            excluded_ts_codes
        ):
            raise QuantWorkbenchError(
                "当前缓存中的新标的已用完，通达信暂时无法补充新的日线标的",
                409,
                "MARKET_CACHE_INSUFFICIENT",
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
                        "recent_window_end_dates": recent_window_end_dates,
                    }
                    if normalized_interval == "hybrid":
                        history = self.market_provider.load_hybrid_daily_history(
                            daily["tsCode"], benchmark
                        )
                        options["stock_daily_rows"] = history["stock"]
                        options["benchmark_daily_rows"] = history["benchmark"]
                    return self.minute_provider.create_scenario(**options)
                except ValueError as exc:
                    last_error = exc
            raise QuantWorkbenchError(
                str(last_error or "没有可用的分钟行情"),
                409,
                "MARKET_CACHE_INSUFFICIENT",
            )
        except FileNotFoundError as exc:
            raise QuantWorkbenchError(
                str(exc), 409, "MARKET_CACHE_INSUFFICIENT"
            ) from exc
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
