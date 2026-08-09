from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from datetime import date

from pydantic import BaseModel, Field

from .errors import QuantWorkbenchError
from .service import ReplayMarketSupply


class ReplayScenarioRequest(BaseModel):
    gameLength: int = 60
    benchmarkCode: str = Field(..., min_length=1)
    seed: int | None = None
    interval: str = "1d"
    excludedTsCodes: list[str] = Field(default_factory=list)
    recentWindowEndDates: list[date] = Field(default_factory=list)


class ReplayStockPrefetchRequest(BaseModel):
    excludedTsCodes: list[str] = Field(default_factory=list)
    targetReserve: int = Field(default=12, ge=1, le=24)


market_supply = ReplayMarketSupply()
app = FastAPI(title="InvestFlow Replay Engine")


@app.exception_handler(QuantWorkbenchError)
async def handle_error(_request: Request, exc: QuantWorkbenchError):
    return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})


@app.get("/internal/health")
def health():
    return {"ok": True, "marketProvider": "tdx"}


@app.get("/internal/replay/benchmarks")
def benchmarks(retry: bool = False):
    return market_supply.benchmarks(retry_failed=retry)


@app.get("/internal/replay/cache/status")
def cache_status():
    return market_supply.cache_status()


@app.post("/internal/replay/scenarios")
def create_scenario(request: ReplayScenarioRequest):
    return market_supply.create_scenario(
        request.gameLength,
        request.benchmarkCode,
        request.seed,
        request.interval,
        excluded_ts_codes=tuple(request.excludedTsCodes),
        recent_window_end_dates=tuple(request.recentWindowEndDates),
    )


@app.post("/internal/replay/cache/stocks/prefetch")
def prefetch_stocks(request: ReplayStockPrefetchRequest):
    return market_supply.prefetch_replay_stocks(
        tuple(request.excludedTsCodes),
        target_reserve=request.targetReserve,
    )
