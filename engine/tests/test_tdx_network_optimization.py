import asyncio
from contextlib import contextmanager
from datetime import datetime
from threading import Event, Lock, current_thread, enumerate as threads
from time import monotonic, sleep
from unittest.mock import patch

import pandas as pd
import pytest
from pytdxdata import TdxData
from pytdxdata.pool.pool import DynamicPool
from pytdxdata.pool.ex_pool import ExPool
from pytdxdata.models import SecurityBar

from replay_engine.tdx_api import TdxClient, Market, KlineCategory
from replay_engine.tdx_market_cache import _FailoverTdxClient, TdxMarketCache, TdxMarketDataProvider, TdxMarketUnavailableError
from test_tdx_market_cache import FakeTdxClient, make_daily_frame


def test_connections_are_created_only_for_the_requested_channel_and_all_close():
    started, opened, closed = [], [], []

    async def start(pool):
        started.append(type(pool).__name__)

    async def connect(pool, **_kwargs):
        channel = 'mac' if pool._probe_factory else 'standard'
        opened.append(channel)

        class Connection:
            host = 'fake'
            alive = True

            async def execute(self, _command):
                return [SecurityBar(year=2024, month=1, day=2, hour=10, minute=0,
                    open=10, high=11, low=9, close=10, vol=100, amount=1000,
                    market=1, code='600000')]

            async def close(self):
                closed.append(channel)

        return Connection()

    with patch.object(DynamicPool, 'start', start), patch.object(ExPool, 'start', start), patch.object(DynamicPool, '_new_connection', connect):
        with TdxClient('fake', timeout=1) as client:
            assert started == []
            assert opened == []
            assert len(client.get_security_bars(Market.SH, '600000', KlineCategory.DAY, 0, 1)) == 1
            assert opened == ['standard']
            assert len(client.get_security_bars(Market.SH, '600000', KlineCategory.MIN_1, 0, 1)) == 1
            assert opened == ['standard', 'mac']
        assert closed == opened


def test_timeout_cancels_underlying_download_and_does_not_leave_client_thread():
    cancelled = Event()

    async def no_start(_pool):
        pass

    async def blocked(*_args, **_kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    with patch.object(DynamicPool, 'start', no_start), patch.object(ExPool, 'start', no_start), patch.object(TdxData, 'get_kline', blocked):
        with TdxClient('cancel-test', timeout=.02) as client:
            start = monotonic()
            with pytest.raises(TimeoutError):
                client.get_security_bars(Market.SH, '600000', KlineCategory.DAY, 0, 1)
            assert cancelled.wait(.1)
            assert monotonic() - start < .2
        assert not any(thread.name == 'tdx-cancel-test' for thread in threads())


def test_failed_client_start_cleans_up_its_thread():
    async def broken(_client):
        raise OSError('startup failed')

    with patch.object(TdxClient, '_start', broken):
        with pytest.raises(OSError):
            TdxClient('startup-test', timeout=.02).__enter__()
    assert not any(thread.name == 'tdx-startup-test' for thread in threads())


def test_failover_shares_one_budget_across_nodes():
    clock = [0.0]
    attempted, budgets = [], []

    class Client:
        def __init__(self, host, **_kwargs):
            self.host = host

        @contextmanager
        def request_budget(self, seconds):
            budgets.append(seconds)
            yield

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def get_xdxr_info(self):
            attempted.append(self.host)
            clock[0] += 16
            raise TimeoutError('offline')

    with patch('replay_engine.tdx_market_cache.monotonic', side_effect=lambda: clock[0]):
        with _FailoverTdxClient(Client, ('a', 'b', 'c', 'd')) as client:
            with pytest.raises(TdxMarketUnavailableError):
                client.get_xdxr_info()
    assert attempted == ['a', 'b']
    assert budgets == [7.5, 14 / 3]


def test_slow_first_nodes_leave_time_for_a_working_later_node():
    clock, budgets = [0.0], []

    class Client:
        def __init__(self, host, **_kwargs):
            self.host = host

        @contextmanager
        def request_budget(self, seconds):
            budgets.append(seconds)
            yield

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def get_xdxr_info(self):
            if self.host == 'working':
                return pd.DataFrame([{'category': 1}])
            clock[0] += budgets[-1]
            raise TimeoutError('slow node')

    with patch('replay_engine.tdx_market_cache.monotonic', side_effect=lambda: clock[0]):
        with _FailoverTdxClient(Client, ('slow-a', 'slow-b', 'working')) as client:
            assert not client.get_xdxr_info().empty
    assert clock[0] < 30


def test_worker_client_starts_with_the_parent_verified_node():
    opened = []

    class Client:
        def __init__(self, host, **_kwargs):
            self.host = host

        def __enter__(self):
            opened.append(self.host)
            return self

        def __exit__(self, *_args):
            pass

        def get_xdxr_info(self):
            if self.host != 'working':
                raise OSError('offline')
            return pd.DataFrame()

    with _FailoverTdxClient(Client, ('offline', 'working')) as parent:
        parent.get_xdxr_info()
        with parent.fork() as worker:
            worker.get_xdxr_info()
    assert opened == ['offline', 'working', 'working']


@pytest.mark.parametrize('fail_one', [False, True])
@pytest.mark.parametrize('stock_count', [6, 15])
def test_daily_downloads_overlap_with_private_clients_and_one_writer(tmp_path, fail_one, stock_count):
    codes = [f'{600001 + i:06d}' for i in range(stock_count)]
    opened, closed, write_threads = [], [], []
    active = peak = 0
    lock = Lock()

    class Client(FakeTdxClient):
        def __init__(self, **_kwargs):
            super().__init__({code: make_daily_frame('2024-01-02', 4, 10) for code in [*codes, '000001']})

        def __enter__(self):
            self.owner = current_thread().ident
            opened.append(self)
            return self

        def __exit__(self, *_args):
            closed.append(self)

        def get_security_list(self, market, start):
            if start:
                return pd.DataFrame()
            return pd.DataFrame([{'code': code, 'name': code} for code in (codes if int(market) == 1 else ['000001'])])

        def get_security_bars(self, *args, **kwargs):
            nonlocal active, peak
            assert current_thread().ident == self.owner
            with lock:
                active += 1
                peak = max(peak, active)
            try:
                sleep(.03)
                if fail_one and args[1] == '600003':
                    raise OSError('one stock failed')
                return super().get_security_bars(*args, **kwargs)
            finally:
                with lock:
                    active -= 1

    cache = TdxMarketCache(tmp_path / 'market.duckdb')
    provider = TdxMarketDataProvider(cache, hosts=('fake',), client_factory=Client,
        initial_stock_count=stock_count, minimum_replay_bars=3, benchmark_codes=('000001.SH',),
        now=lambda: datetime(2024, 1, 5, 16))
    writer = current_thread().ident
    original = cache.upsert_stock_history
    original_connect = cache._connect

    def write(*args):
        write_threads.append(current_thread().ident)
        return original(*args)

    def connect():
        assert current_thread().ident == writer, 'worker must not open DuckDB'
        return original_connect()

    with patch.object(cache, 'upsert_stock_history', side_effect=write), patch.object(cache, '_connect', side_effect=connect):
        result = provider.ensure_ready(force_refresh=True, skip_current=True)
    assert 2 <= peak <= 3
    expected = stock_count - int(fail_one)
    assert write_threads == [writer] * expected
    assert result['stockCount'] == expected
    assert result['state'] == ('partial' if fail_one else 'ready')
    assert len(opened) <= (5 if fail_one else 4)
    assert set(opened) == set(closed)
    assert not any(thread.name.startswith('tdx-download') for thread in threads())
    assert cache.statistics()['stockDailyBarCount'] == expected * 4
