import unittest
from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

from pytdxdata import TdxData
from pytdxdata.models import SecurityBar
from pytdxdata.scheduler.paginator import Paginator

from replay_engine.tdx_api import KlineCategory, Market, TdxClient


class TdxApiTest(unittest.TestCase):
    def test_bar_pages_honor_offset_and_count_through_real_upstream_paginator(self):
        requests = (
            (0, 0), (0, 2), (2, 2), (0, 800), (0, 1600), (799, 2),
            (800, 100), (800, 800), (1600, 800), (1800, 100), (3000, 100),
        )
        periods = (
            (KlineCategory.DAY, timedelta(days=1)),
            (KlineCategory.MIN_5, timedelta(minutes=5)),
            (KlineCategory.MIN_1, timedelta(minutes=1)),
        )
        for history_size in (50, 800, 1800, 2625):
            for period, step in periods:
                history = []
                for index in range(history_size):
                    timestamp = datetime(2024, 1, 1, 9, 30) + index * step
                    history.append(SecurityBar(
                        market=1, code="600000", year=timestamp.year,
                        month=timestamp.month, day=timestamp.day,
                        hour=timestamp.hour, minute=timestamp.minute,
                        open=index + 1, high=index + 2, low=index + 0.5,
                        close=index + 1.5, vol=100, amount=1000,
                    ))

                commands = []

                class Connection:
                    def __init__(self, channel):
                        self.channel = channel

                    async def execute(self, command):
                        commands.append(self.channel)
                        end = max(0, len(history) - command.start)
                        return history[max(0, end - command.count):end]

                class Pool:
                    def __init__(self, channel):
                        self.channel = channel

                    async def acquire_many(self, count):
                        return [Connection(self.channel) for _ in range(count)]

                    async def acquire(self):
                        return Connection(self.channel)

                    async def release(self, *_args, **_kwargs):
                        pass

                class InMemoryTransportData(TdxData):
                    async def start(self):
                        self._paginator_std = Paginator(
                            Pool("standard"), concurrency=3, retries=0,
                        )
                        # MIN_1 stock bars use the SDK's real MAC serial path.
                        self._mac_pool = Pool("mac")

                    async def close(self):
                        pass

                with patch("replay_engine.tdx_api.TdxData", InMemoryTransportData), TdxClient("fake") as client:
                    for method in (client.get_security_bars, client.get_index_bars):
                        channel = "mac" if period == KlineCategory.MIN_1 and method == client.get_security_bars else "standard"
                        code = "600000" if method == client.get_security_bars else "000001"
                        for start, count in requests:
                            with self.subTest(history=history_size, period=period.name,
                                              method=method.__name__, start=start, count=count):
                                before = len(commands)
                                actual = method(Market.SH, code, period, start, count)
                                end = max(0, len(history) - start)
                                expected = history[max(0, end - count):end]
                                self.assertEqual(len(actual), len(expected))
                                if expected:
                                    self.assertEqual(actual.close.tolist(), [row.close for row in expected])
                                    self.assertEqual(actual.datetime.tolist(), [
                                        datetime(row.year, row.month, row.day, row.hour, row.minute)
                                        for row in expected
                                    ])
                                if start + count:
                                    self.assertTrue(commands[before:])
                                    self.assertEqual(set(commands[before:]), {channel})

    def test_adapter_maps_pytdxdata_records_to_existing_dataframes(self):
        calls = []

        class FakeData:
            def __init__(self, **_options):
                pass

            async def start(self):
                pass

            async def close(self):
                pass

            async def get_kline(self, *_args, **_kwargs):
                calls.append("stock")
                return [SimpleNamespace(year=2026, month=9, day=8, hour=0, minute=0, open=1, high=2, low=0.5, close=1.5, vol=10, amount=15)]

            async def get_index_kline(self, *_args, **_kwargs):
                calls.append("index")
                return [SimpleNamespace(year=2026, month=9, day=8, hour=0, minute=0, open=3, high=4, low=2.5, close=3.5, vol=20, amount=70)]

            async def get_security_list(self, *_args, **kwargs):
                calls.append(("list", kwargs.get("start"), kwargs["count"]))
                return [SimpleNamespace(code=f"{index:06d}", name="股票") for index in range(2000)]

            async def get_xdxr(self, *_args, **_kwargs):
                return [SimpleNamespace(year=2026, month=1, day=2, category=1, fenhong=0.1, peigujia=0, songzhuangu=0, peigu=0)]

        with patch("replay_engine.tdx_api.TdxData", FakeData), TdxClient("fake", timeout=1) as client:
            stock = client.get_security_bars(Market.SH, "600000", KlineCategory.DAY, 0, 1)
            index = client.get_index_bars(Market.SH, "000001", KlineCategory.DAY, 0, 1)
            securities = client.get_security_list(Market.SH, 1000)
            xdxr = client.get_xdxr_info(Market.SH, "600000")

        self.assertEqual(calls[:2], ["stock", "index"])
        self.assertEqual(calls[2], ("list", None, None))
        self.assertEqual(stock.loc[0, "close"], 1.5)
        self.assertEqual(index.loc[0, "amount"], 70)
        self.assertEqual(len(securities), 1000)
        self.assertEqual(securities.iloc[0]["code"], "001000")
        self.assertEqual(xdxr.loc[0, "date"], "2026-01-02")
