import unittest
from tempfile import TemporaryDirectory
from pathlib import Path
from datetime import datetime, timedelta
from unittest.mock import patch
from threading import Event, Thread
import pandas as pd
from pytdxdata.protocol.commands.base import TdxDecodeError

from replay_engine.minute_replay import TdxMinuteReplayProvider
from replay_engine.tdx_api import KlineCategory, Market

from replay_engine.tdx_market_cache import TDX_HOSTS, TdxMarketUnavailableError, _FailoverTdxClient


def recording_bar_client(reply):
    opened, requests, closed = [], [], []

    class Client:
        def __init__(self, host, **_options):
            self.host = host

        def __enter__(self):
            opened.append(self.host)
            return self

        def __exit__(self, *_args):
            closed.append(self.host)

        def _bars(self, method, *args, **kwargs):
            start = args[3] if len(args) > 3 else kwargs.get("start", 0)
            requests.append((self.host, method, start))
            return reply(self.host, method, start)

        def get_security_bars(self, *args, **kwargs):
            return self._bars("get_security_bars", *args, **kwargs)

        def get_index_bars(self, *args, **kwargs):
            return self._bars("get_index_bars", *args, **kwargs)

    return Client, opened, requests, closed


class ConnectionReuseTest(unittest.TestCase):
    def test_bar_failover_reuses_recovered_connection(self):
        for failure in ("decode", "empty"):
            for method in ("get_security_bars", "get_index_bars"):
                with self.subTest(failure=failure, method=method):
                    clock = [0]

                    def reply(host, _method, _start):
                        if host != TDX_HOSTS[-1]:
                            if failure == "decode":
                                raise TdxDecodeError("invalid bars")
                            return pd.DataFrame()
                        return pd.DataFrame([{"close": 10}])

                    factory, opened, requests, closed = recording_bar_client(reply)
                    with patch("replay_engine.tdx_market_cache.monotonic", side_effect=lambda: clock[0]):
                        with _FailoverTdxClient(factory, TDX_HOSTS) as client:
                            fetch = getattr(client, method)
                            self.assertEqual(fetch(Market.SH, "600000", KlineCategory.MIN_5, 0, 800).close.tolist(), [10])
                            self.assertEqual(opened, list(TDX_HOSTS))
                            self.assertEqual(closed, list(TDX_HOSTS[:-1]))
                            # Even after bad-node cooldown expires, reuse the recovered node.
                            clock[0] = 31
                            self.assertEqual(fetch(Market.SH, "600000", KlineCategory.MIN_5, 800, 800).close.tolist(), [10])
                            self.assertEqual(opened, list(TDX_HOSTS))
                            self.assertEqual(requests, [(host, method, 0) for host in TDX_HOSTS] + [(TDX_HOSTS[-1], method, 800)])
                        self.assertEqual(closed, list(TDX_HOSTS))

    def test_invalid_bar_nodes_raise_without_leaking_connections(self):
        for failure in ("decode", "empty"):
            for method in ("get_security_bars", "get_index_bars"):
                with self.subTest(failure=failure, method=method):
                    def reply(_host, _method, _start):
                        if failure == "decode":
                            raise TdxDecodeError("invalid bars")
                        return pd.DataFrame()

                    factory, opened, requests, closed = recording_bar_client(reply)
                    with _FailoverTdxClient(factory, TDX_HOSTS) as client:
                        with self.assertRaises(TdxMarketUnavailableError):
                            getattr(client, method)(Market.SH, "600000", KlineCategory.MIN_5, 0, 800)
                    self.assertEqual(opened, list(TDX_HOSTS))
                    self.assertEqual(requests, [(host, method, 0) for host in TDX_HOSTS])
                    self.assertEqual(closed, list(TDX_HOSTS))

    def test_failed_bar_node_is_retried_after_cooldown(self):
        first, last = TDX_HOSTS[0], TDX_HOSTS[-1]
        clock = [0]

        def reply(host, _method, _start):
            if (host == first and clock[0] < 30) or (host == last and clock[0] > 0):
                raise TdxDecodeError("temporarily invalid bars")
            return pd.DataFrame([{"close": 10}])

        factory, opened, requests, closed = recording_bar_client(reply)
        with patch("replay_engine.tdx_market_cache.monotonic", side_effect=lambda: clock[0]):
            with _FailoverTdxClient(factory, (first, last)) as client:
                self.assertFalse(client.get_security_bars(start=0).empty)
                clock[0] = 10
                with self.assertRaises(TdxMarketUnavailableError):
                    client.get_security_bars(start=0)
                clock[0] = 29
                with self.assertRaises(TdxMarketUnavailableError):
                    client.get_security_bars(start=0)
                self.assertEqual(opened, [first, last])
                clock[0] = 31
                self.assertFalse(client.get_security_bars(start=0).empty)
                self.assertEqual(opened, [first, last, first])
                self.assertEqual(requests, [(host, "get_security_bars", 0) for host in (first, last, last, first)])
            self.assertEqual(closed, [first, last, first])

    def test_empty_older_page_does_not_switch_hosts(self):
        for method in ("get_security_bars", "get_index_bars"):
            with self.subTest(method=method):
                def reply(_host, _method, start):
                    return pd.DataFrame() if start else pd.DataFrame([{"close": 10}])

                factory, opened, requests, closed = recording_bar_client(reply)
                with _FailoverTdxClient(factory, TDX_HOSTS) as client:
                    fetch = getattr(client, method)
                    self.assertFalse(fetch(start=0).empty)
                    self.assertTrue(fetch(start=800).empty)
                    self.assertEqual(opened, [TDX_HOSTS[0]])
                    self.assertEqual(requests, [(TDX_HOSTS[0], method, start) for start in (0, 800)])
                self.assertEqual(closed, [TDX_HOSTS[0]])

    def test_default_hosts_can_recover_when_legacy_nodes_return_invalid_bars(self):
        legacy_hosts = {"180.153.18.170", "115.238.56.198", "111.229.247.189"}

        class Client:
            def __init__(self, host, **_options):
                self.host = host

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                pass

            def get_index_bars(self):
                if self.host in legacy_hosts:
                    raise TdxDecodeError("指数K线响应只有记录数，没有行情内容")
                return pd.DataFrame([{"close": 3842.19}])

        with _FailoverTdxClient(Client, TDX_HOSTS) as client:
            self.assertFalse(client.get_index_bars().empty)

    def test_reuses_successful_connection_and_skips_failed_host(self):
        opened, closed = [], []

        class Client:
            def __init__(self, host, **_options):
                self.host = host

            def __enter__(self):
                opened.append(self.host)
                if self.host == "failed":
                    raise OSError("offline")
                return self

            def __exit__(self, *_args):
                closed.append(self.host)

            def get_xdxr_info(self):
                return "data"

        with _FailoverTdxClient(Client, ("failed", "working")) as client:
            for _ in range(30):
                self.assertEqual(client.get_xdxr_info(), "data")
        self.assertEqual(opened, ["failed", "working"])
        self.assertEqual(closed, ["working"])

    def test_prefetch_uses_complete_cache_without_network(self):
        with TemporaryDirectory() as directory:
            provider = TdxMinuteReplayProvider(Path(directory) / "minute.duckdb")
            row = {
                "datetime": datetime(2026, 10, 19, 14, 55),
                "open": 10, "high": 11, "low": 9, "close": 10,
                "vol": 100, "amount": 1000,
            }
            provider.store.save("600000.SH", "stock-5m", [row])
            provider.store.save("000001.SH", "index-5m", [row])
            provider.store.mark_full_history("600000.SH", "stock-5m")
            provider.store.mark_full_history("000001.SH", "index-5m")
            with patch.object(provider, "_fetch") as fetch:
                provider.prefetch("600000.SH", "000001.SH")
            fetch.assert_not_called()

    def test_interrupted_prefetch_keeps_partial_cache_but_not_complete_marker(self):
        class Client:
            def __init__(self, **_options):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                pass

            def get_security_bars(self, _market, _symbol, _category, start, _count, **_kwargs):
                if start:
                    raise OSError("interrupted")
                return pd.DataFrame([{
                    "datetime": datetime(2026, 1, 1) + timedelta(minutes=5 * index),
                    "open": 10, "high": 11, "low": 9, "close": 10,
                    "vol": 100, "amount": 1000,
                } for index in range(800)])

        with TemporaryDirectory() as directory, patch("replay_engine.tdx_api.TdxClient", Client):
            provider = TdxMinuteReplayProvider(Path(directory) / "minute.duckdb")
            with self.assertRaisesRegex(ValueError, "中断"):
                provider.prefetch("600000.SH", "000001.SH")
            self.assertFalse(provider.store.has_full_history("600000.SH", "stock-5m"))
            self.assertEqual(len(provider.store.load("600000.SH", "stock-5m")), 800)

    def test_prefetch_waits_for_foreground_work(self):
        entered, release, downloaded = Event(), Event(), Event()

        class Provider(TdxMinuteReplayProvider):
            def _create_scenario(self, **_options):
                entered.set()
                if not release.wait(3):
                    raise TimeoutError("test foreground not released")
                return {}

        class Client:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                pass

            def get_security_bars(self, *_args, **_kwargs):
                downloaded.set()
                return pd.DataFrame([{
                    "datetime": datetime(2026, 1, 1),
                    "open": 10, "high": 11, "low": 9, "close": 10,
                    "vol": 100, "amount": 1000,
                }])

            def get_index_bars(self, *_args, **_kwargs):
                downloaded.set()
                return pd.DataFrame([{
                    "datetime": datetime(2026, 1, 1),
                    "open": 10, "high": 11, "low": 9, "close": 10,
                    "vol": 100, "amount": 1000,
                }])

        with TemporaryDirectory() as directory:
            provider = Provider(Path(directory) / "minute.duckdb")
            provider.store.mark_full_history("000001.SH", "index-5m")
            foreground = Thread(target=provider.create_scenario)
            background = Thread(target=lambda: provider.prefetch("600000.SH", "000001.SH", client=Client()))
            foreground.start()
            self.assertTrue(entered.wait(3))
            background.start()
            try:
                self.assertFalse(downloaded.wait(0.1))
            finally:
                release.set()
                foreground.join(3)
                background.join(3)
            self.assertFalse(background.is_alive())
            self.assertTrue(downloaded.is_set())
