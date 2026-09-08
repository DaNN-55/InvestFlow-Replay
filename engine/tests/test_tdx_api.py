import unittest
from types import SimpleNamespace
from unittest.mock import patch

from replay_engine.tdx_api import KlineCategory, Market, TdxClient


class TdxApiTest(unittest.TestCase):
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
