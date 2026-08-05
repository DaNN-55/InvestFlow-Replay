from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .errors import QuantWorkbenchError
from .service import ReplayService


class ReplayScenarioRequest(BaseModel):
    gameLength: int = 60
    benchmarkCode: str = Field(..., min_length=1)
    seed: int | None = None
    interval: str = "1d"


service = ReplayService()
app = FastAPI(title="InvestFlow Replay Engine")


@app.exception_handler(QuantWorkbenchError)
async def handle_error(_request: Request, exc: QuantWorkbenchError):
    return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})


@app.get("/internal/health")
def health():
    return {"ok": True, "marketProvider": "tdx"}


@app.get("/internal/replay/benchmarks")
def benchmarks(retry: bool = False):
    return service.benchmarks(retry_failed=retry)


@app.post("/internal/replay/scenarios")
def create_scenario(request: ReplayScenarioRequest):
    return service.create_scenario(
        request.gameLength, request.benchmarkCode, request.seed, request.interval
    )
