import unittest
from tempfile import TemporaryDirectory
from pathlib import Path
from datetime import datetime, timedelta
from unittest.mock import patch
from threading import Event, Thread
import pandas as pd

from replay_engine.minute_replay import TdxMinuteReplayProvider

from replay_engine.tdx_market_cache import _FailoverTdxClient


class ConnectionReuseTest(unittest.TestCase):
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
            provider.store.mark_full_history("600000.SH", "stock-5m")
            provider.store.mark_full_history("000001.SH", "index-5m")
            provider.prefetch("600000.SH", "000001.SH")

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
