from __future__ import annotations

from unittest.mock import patch

import pytest

from replay_engine.errors import QuantWorkbenchError
from replay_engine.fixture_market import FixtureReplayMarketSupply
from replay_engine.service import create_market_supply


BENCHMARK_CODE = "DEMO-INDEX.SYN"


def test_fixture_factory_does_not_construct_tdx_supply() -> None:
    with patch(
        "replay_engine.service.ReplayMarketSupply",
        side_effect=AssertionError("TDX supply must not be constructed"),
    ):
        supply = create_market_supply("fixture")
        supply.benchmarks()
        supply.cache_status()
        supply.prefetch_replay_stocks(())
        supply.create_scenario(20, BENCHMARK_CODE, seed=7)

    assert supply.provider_name == "fixture"


def test_fixture_benchmark_and_cache_status_report_offline_mode() -> None:
    supply = FixtureReplayMarketSupply()

    benchmarks = supply.benchmarks()
    status = supply.cache_status()

    assert benchmarks["provider"] == "fixture"
    assert benchmarks["mode"] == "fixture"
    assert benchmarks["initialization"]["state"] == "ready"
    assert benchmarks["initialization"]["provider"] == "fixture"
    assert benchmarks["items"][0]["name"].startswith("Demo 合成")
    assert benchmarks["items"][0]["supportedGameLengths"] == [20, 60, 120]
    assert status["provider"] == "fixture"
    assert status["mode"] == "fixture"
    assert status["state"] == "ready"
    assert status["minute"]["oneMinuteBarCount"] == 0
    assert status["storage"]["totalBytes"] == 0


@pytest.mark.parametrize("game_length", [20, 60, 120])
def test_fixture_daily_scenario_has_complete_contract(game_length: int) -> None:
    scenario = FixtureReplayMarketSupply().create_scenario(
        game_length,
        BENCHMARK_CODE,
        seed=19,
    )

    assert scenario["sourceDataVersion"] == "fixture-demo-market-v1"
    assert scenario["tsCode"].startswith("DEMO")
    assert scenario["name"].startswith("Demo 合成")
    assert scenario["interval"] == "1d"
    assert scenario["observationBars"] == 250
    assert scenario["gameLength"] == game_length
    assert len(scenario["bars"]) == 250 + game_length
    assert len(scenario["benchmark"]["bars"]) == game_length + 1
    assert scenario["benchmark"]["bars"][0]["sequence"] == 250
    assert scenario["benchmark"]["bars"][-1]["sequence"] == 250 + game_length
    assert [bar["tradeDate"] for bar in scenario["bars"]] == sorted(
        bar["tradeDate"] for bar in scenario["bars"]
    )
    for bar in scenario["bars"]:
        assert bar["low"] <= min(bar["open"], bar["close"])
        assert bar["high"] >= max(bar["open"], bar["close"])
        assert bar["volume"] >= 0
        assert bar["amount"] >= 0


def test_fixture_scenario_is_deterministic_for_same_input() -> None:
    supply = FixtureReplayMarketSupply()

    first = supply.create_scenario(60, BENCHMARK_CODE, seed=42)
    second = supply.create_scenario(60, BENCHMARK_CODE, seed=42)

    assert first == second


@pytest.mark.parametrize("interval", ["1m", "hybrid"])
def test_fixture_rejects_intraday_modes_with_business_error(interval: str) -> None:
    with pytest.raises(QuantWorkbenchError) as error:
        FixtureReplayMarketSupply().create_scenario(
            20,
            BENCHMARK_CODE,
            seed=1,
            interval=interval,
        )

    assert error.value.status_code == 400
    assert "离线合成数据" in str(error.value)
