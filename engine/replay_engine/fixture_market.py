from __future__ import annotations

from datetime import date, timedelta
import hashlib
import json
import math
from pathlib import Path
from typing import Any

from .errors import QuantWorkbenchError


OBSERVATION_BARS = 250
SUPPORTED_GAME_LENGTHS = (20, 60, 120)
MANIFEST_PATH = Path(__file__).parent / "fixtures" / "demo_market.json"


def _trading_dates(start: date, count: int) -> list[date]:
    dates: list[date] = []
    current = start
    while len(dates) < count:
        if current.weekday() < 5:
            dates.append(current)
        current += timedelta(days=1)
    return dates


def _stable_offset(seed: int | None, size: int) -> int:
    digest = hashlib.sha256(str(seed if seed is not None else 0).encode()).digest()
    return int.from_bytes(digest[:8], "big") % size


def _generate_bars(
    *,
    start_date: date,
    count: int,
    base_price: float,
    phase: float,
    benchmark: bool = False,
) -> list[dict[str, Any]]:
    bars: list[dict[str, Any]] = []
    previous_close = float(base_price)
    previous_week: tuple[int, int] | None = None
    previous_month: tuple[int, int] | None = None
    week_index = 0
    month_index = 0
    for index, trade_date in enumerate(_trading_dates(start_date, count)):
        cycle = phase + index * (0.113 if benchmark else 0.137)
        drift = 0.00035 if benchmark else 0.00055
        gap = math.sin(cycle * 0.71) * (0.0018 if benchmark else 0.003)
        move = drift + math.sin(cycle) * 0.006 + math.cos(cycle * 0.37) * 0.0025
        open_price = previous_close * (1 + gap)
        close = open_price * (1 + move)
        spread = 0.004 + abs(math.sin(cycle * 1.31)) * 0.006
        high = max(open_price, close) * (1 + spread)
        low = min(open_price, close) * (1 - spread * 0.9)
        volume = int((2_400_000 if benchmark else 680_000) * (1 + abs(math.sin(cycle * 0.83))))
        week_key = trade_date.isocalendar()[:2]
        month_key = (trade_date.year, trade_date.month)
        if week_key != previous_week:
            week_index += 1
            previous_week = week_key
        if month_key != previous_month:
            month_index += 1
            previous_month = month_key
        bar = {
            "sequence": index + 1,
            "tradeDate": trade_date.isoformat(),
            "open": round(open_price, 4),
            "high": round(high, 4),
            "low": round(low, 4),
            "close": round(close, 4),
            "preClose": round(previous_close, 4),
            "pctChange": round(((close / previous_close) - 1) * 100, 4),
            "volume": volume,
            "amount": round(volume * ((open_price + close) / 2), 2),
        }
        if not benchmark:
            bar.update(
                {
                    "rawOpen": bar["open"],
                    "rawHigh": bar["high"],
                    "rawLow": bar["low"],
                    "rawClose": bar["close"],
                    "rawPreClose": bar["preClose"],
                    "adjustFactor": 1.0,
                    "adjustmentMultiplier": 1.0,
                    "limitType": None,
                    "openTimes": None,
                    "weekIndex": week_index,
                    "monthIndex": month_index,
                }
            )
        bars.append(bar)
        previous_close = close
    return bars


class FixtureReplayMarketSupply:
    provider_name = "fixture"

    def __init__(self, manifest_path: Path = MANIFEST_PATH) -> None:
        self.manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.source_data_version = str(self.manifest["version"])
        self.start_date = date.fromisoformat(self.manifest["startDate"])

    def benchmarks(self, *, retry_failed: bool = False) -> dict[str, Any]:
        del retry_failed
        benchmark = self.manifest["benchmark"]
        end_date = _trading_dates(
            self.start_date, OBSERVATION_BARS + max(SUPPORTED_GAME_LENGTHS)
        )[-1]
        initialization = {
            "provider": "fixture",
            "mode": "fixture",
            "state": "ready",
            "ready": True,
            "completed": 1,
            "total": 1,
            "message": "离线合成行情已就绪",
            "error": "",
        }
        return {
            "provider": "fixture",
            "mode": "fixture",
            "sourceDataVersion": self.source_data_version,
            "items": [
                {
                    "code": benchmark["code"],
                    "name": benchmark["name"],
                    "startDate": self.start_date.isoformat(),
                    "endDate": end_date.isoformat(),
                    "barCount": OBSERVATION_BARS + max(SUPPORTED_GAME_LENGTHS),
                    "supportedGameLengths": list(SUPPORTED_GAME_LENGTHS),
                }
            ],
            "initialization": initialization,
        }

    def cache_status(self) -> dict[str, Any]:
        instrument_count = len(self.manifest["instruments"])
        daily_bar_count = instrument_count * (
            OBSERVATION_BARS + max(SUPPORTED_GAME_LENGTHS)
        )
        task = {
            "provider": "fixture",
            "mode": "fixture",
            "state": "ready",
            "ready": True,
            "completed": 1,
            "total": 1,
            "message": "离线合成行情已就绪",
            "error": "",
        }
        return {
            "provider": "fixture",
            "mode": "fixture",
            "state": "ready",
            "activeTask": task,
            "initialization": task,
            "stockPool": task,
            "market": {
                "instrumentCount": instrument_count,
                "stockCount": instrument_count,
                "stockDailyBarCount": daily_bar_count,
                "adjustFactorCount": daily_bar_count,
                "indexCount": 1,
                "indexDailyBarCount": OBSERVATION_BARS + max(SUPPORTED_GAME_LENGTHS),
                "tradeDateCount": OBSERVATION_BARS + max(SUPPORTED_GAME_LENGTHS),
                "lastSuccessAt": None,
            },
            "minute": {
                "oneMinuteInstrumentCount": 0,
                "oneMinuteBarCount": 0,
                "fiveMinuteInstrumentCount": 0,
                "fiveMinuteBarCount": 0,
            },
            "storage": {"marketBytes": 0, "minuteBytes": 0, "totalBytes": 0},
            "lastSuccessAt": None,
        }

    def prefetch_replay_stocks(
        self,
        excluded_ts_codes: tuple[str, ...],
        *,
        target_reserve: int = 12,
    ) -> dict[str, Any]:
        excluded = {str(code).strip().upper() for code in excluded_ts_codes}
        available_count = sum(
            instrument["code"].upper() not in excluded
            for instrument in self.manifest["instruments"]
        )
        return {
            "provider": "fixture",
            "mode": "fixture",
            "available": available_count > 0,
            "availableCount": available_count,
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
        del recent_window_end_dates
        normalized_interval = str(interval or "1d").strip().lower()
        if normalized_interval != "1d":
            raise QuantWorkbenchError(
                "离线合成数据 Demo 暂不支持 1m 或 hybrid 日内模式，请选择日线演练",
                400,
            )
        if int(game_length) not in SUPPORTED_GAME_LENGTHS:
            values = "、".join(str(value) for value in SUPPORTED_GAME_LENGTHS)
            raise QuantWorkbenchError(f"1d 的 gameLength 只支持 {values}", 400)
        benchmark = self.manifest["benchmark"]
        normalized_benchmark = str(benchmark_code or "").strip().upper()
        if normalized_benchmark != str(benchmark["code"]).upper():
            raise QuantWorkbenchError("请选择 Demo 合成基准指数", 400)
        excluded = {str(code).strip().upper() for code in excluded_ts_codes}
        instruments = [
            item
            for item in self.manifest["instruments"]
            if str(item["code"]).upper() not in excluded
        ]
        if not instruments:
            raise QuantWorkbenchError("离线 Demo 合成标的已全部使用，请重置 Demo 数据", 409)
        instrument = instruments[_stable_offset(seed, len(instruments))]
        bar_count = OBSERVATION_BARS + int(game_length)
        bars = _generate_bars(
            start_date=self.start_date,
            count=bar_count,
            base_price=float(instrument["basePrice"]),
            phase=float(instrument["phase"]),
        )
        benchmark_bars = _generate_bars(
            start_date=self.start_date,
            count=bar_count,
            base_price=float(benchmark["basePrice"]),
            phase=float(benchmark["phase"]),
            benchmark=True,
        )[OBSERVATION_BARS - 1 :]
        return {
            "sourceDataVersion": self.source_data_version,
            "tsCode": instrument["code"],
            "symbol": instrument["symbol"],
            "exchange": "DEMO",
            "name": instrument["name"],
            "interval": "1d",
            "observationBars": OBSERVATION_BARS,
            "gameLength": int(game_length),
            "benchmark": {"code": benchmark["code"], "bars": benchmark_bars},
            "priceAdjustment": {
                "method": "synthetic-unadjusted",
                "factorSource": "fixture-generator",
                "calendarExchange": "DEMO",
                "anchorTradeDate": bars[0]["tradeDate"],
                "anchorFactor": 1.0,
            },
            "bars": bars,
        }

    def search_instruments(self, keyword: str, limit: int = 8) -> dict[str, Any]:
        text = str(keyword or "").strip().lower()
        items = [
            {"orderBookId": item["code"], "name": item["name"]}
            for item in self.manifest["instruments"]
            if not text
            or text in str(item["code"]).lower()
            or text in str(item["name"]).lower()
        ]
        return {"items": items[: max(1, min(int(limit), 50))]}
