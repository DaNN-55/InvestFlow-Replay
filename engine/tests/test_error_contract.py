from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.exceptions import RequestValidationError

import replay_engine.app as app_module
from replay_engine.errors import QuantWorkbenchError
from replay_engine.service import ReplayMarketSupply
from replay_engine.tdx_market_cache import TdxMarketUnavailableError


class UnavailableMarketProvider:
    def ensure_ready(self):
        raise TdxMarketUnavailableError("连接失败且本地缓存不足")


class ReadyMarketProvider:
    def ensure_ready(self):
        return {"mode": "cache", "message": "连接失败，继续使用本地缓存"}


class ReplayStoreStub:
    def create_replay_scenario(self, **_kwargs):
        return {"tsCode": "600000.SH", "name": "浦发银行"}


class InsufficientMinuteProvider:
    def create_scenario(self, **_kwargs):
        raise ValueError("分钟行情不足：缓存数据不足")


def response_payload(response) -> dict:
    return json.loads(response.body)


def test_daily_cache_insufficiency_has_stable_business_error_contract() -> None:
    supply = ReplayMarketSupply(
        store=ReplayStoreStub(),
        market_data_provider=UnavailableMarketProvider(),
    )
    with pytest.raises(QuantWorkbenchError) as raised:
        supply.create_scenario(20, "000001.SH")
    response = asyncio.run(app_module.handle_error(None, raised.value))

    assert response.status_code == 409
    assert response_payload(response) == {
        "error": {
            "code": "MARKET_CACHE_INSUFFICIENT",
            "message": "连接失败且本地缓存不足",
        }
    }


def test_minute_cache_insufficiency_is_a_conflict_not_not_found() -> None:
    supply = ReplayMarketSupply(
        store=ReplayStoreStub(),
        market_data_provider=ReadyMarketProvider(),
        minute_replay_provider=InsufficientMinuteProvider(),
    )
    with pytest.raises(QuantWorkbenchError) as raised:
        supply.create_scenario(240, "000001.SH", interval="1m")
    response = asyncio.run(app_module.handle_error(None, raised.value))

    assert response.status_code == 409
    assert response_payload(response)["error"] == {
        "code": "MARKET_CACHE_INSUFFICIENT",
        "message": "分钟行情不足：缓存数据不足",
    }


def test_connection_failure_with_usable_cache_still_creates_scenario() -> None:
    supply = ReplayMarketSupply(
        store=ReplayStoreStub(),
        market_data_provider=ReadyMarketProvider(),
    )
    response = supply.create_scenario(20, "000001.SH")

    assert response["tsCode"] == "600000.SH"


def test_invalid_request_has_structured_400_error() -> None:
    validation_error = RequestValidationError(
        [{"type": "missing", "loc": ("body", "benchmarkCode"), "msg": "Field required", "input": {}}]
    )
    response = asyncio.run(
        app_module.handle_validation_error(None, validation_error)
    )

    assert response.status_code == 400
    assert response_payload(response)["error"] == {
        "code": "INVALID_REQUEST",
        "message": "Field required",
    }
