from datetime import datetime
from threading import Event

import duckdb
import pandas as pd
import pytest

from replay_engine.data_store import DuckDbBarStore
from replay_engine.service import ReplayMarketSupply
from replay_engine.tdx_market_cache import TdxMarketCache, TdxMarketDataProvider, build_stock_history
from test_tdx_market_cache import FakeTdxClient, make_daily_frame


class CountingClient(FakeTdxClient):
    def __init__(self, count=4):
        super().__init__({
            '600000': make_daily_frame('2024-01-02', count, 10),
            '000001': make_daily_frame('2024-01-02', count, 3000),
        })
        self.calls = []

    def get_security_list(self, *args, **kwargs):
        self.calls.append('metadata')
        return super().get_security_list(*args, **kwargs)

    def get_index_bars(self, *args, **kwargs):
        self.calls.append('index')
        return super().get_index_bars(*args, **kwargs)

    def get_security_bars(self, *args, **kwargs):
        self.calls.append('stock')
        return super().get_security_bars(*args, **kwargs)


def provider_at(path, now):
    return TdxMarketDataProvider(TdxMarketCache(path), initial_stock_count=1,
        minimum_replay_bars=3, benchmark_codes=('000001.SH',), now=lambda: now)


def test_warm_cache_remains_ready_during_every_background_progress_report(tmp_path):
    provider = provider_at(tmp_path / 'market.duckdb', datetime(2024, 1, 5, 16))
    cold_reports = []
    provider.sync_with_client(CountingClient(), progress_callback=cold_reports.append)
    assert cold_reports[0]['ready'] is False
    reports = []
    provider.sync_with_client(CountingClient(), progress_callback=reports.append)
    assert reports and all(report['ready'] for report in reports)


def test_benchmark_options_are_available_while_actual_background_refresh_is_blocked(tmp_path):
    path = tmp_path / 'market.duckdb'
    provider_at(path, datetime(2025, 3, 3, 16)).sync_with_client(CountingClient(count=300))
    provider = provider_at(path, datetime(2025, 3, 4, 9))
    entered, release = Event(), Event()

    class BlockingClient(CountingClient):
        def __init__(self, **_kwargs):
            super().__init__()

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def get_security_list(self, *args, **kwargs):
            entered.set()
            assert release.wait(5)
            return super().get_security_list(*args, **kwargs)

    provider.client_factory = BlockingClient
    supply = ReplayMarketSupply(store=DuckDbBarStore(source_db_path=path), market_data_provider=provider)
    assert supply.daily_store.source_db_path == path.resolve()
    try:
        supply.benchmarks()
        assert entered.wait(2)
        result = supply.benchmarks()
        assert result['initialization']['state'] == 'running'
        assert result['initialization']['ready'] is True
        assert [item['code'] for item in result['items']] == ['000001.SH']
    finally:
        release.set()
        provider._sync_thread.join(5)
        assert not provider._sync_thread.is_alive()


def test_routine_refresh_reuses_current_resources_even_after_provider_restart(tmp_path):
    path = tmp_path / 'market.duckdb'
    provider_at(path, datetime(2024, 1, 5, 16)).sync_with_client(CountingClient())
    client = CountingClient()
    provider = provider_at(path, datetime(2024, 1, 5, 17))
    result = provider.sync_with_client(client, skip_current=True)
    assert client.calls == []
    assert result['state'] == 'ready'
    assert result['skippedStockCount'] == 1


def test_same_day_open_startup_retries_failed_resource_despite_global_success_marker(tmp_path):
    path = tmp_path / 'market.duckdb'
    now = datetime(2024, 1, 5, 9)
    provider = provider_at(path, now)
    provider.sync_with_client(CountingClient())
    provider.cache.record_resource_sync('600000.SH', 'stock-day', error='timeout', now=now)
    client = CountingClient()
    restarted = provider_at(path, now)

    class ClientContext:
        def __init__(self, **_kwargs):
            pass

        def __enter__(self):
            return client

        def __exit__(self, *_args):
            pass

    restarted.client_factory = ClientContext
    restarted.prepare_replay_cache()
    if restarted._sync_thread:
        restarted._sync_thread.join(5)
        assert not restarted._sync_thread.is_alive()
    assert 'stock' in client.calls
    assert restarted.cache.failed_resource_count() == 0


def test_new_day_before_close_rechecks_calendar_but_reuses_completed_stock(tmp_path):
    path = tmp_path / 'market.duckdb'
    provider_at(path, datetime(2024, 1, 5, 16)).sync_with_client(CountingClient())
    client = CountingClient()
    provider_at(path, datetime(2024, 1, 8, 9)).sync_with_client(client, skip_current=True)
    assert 'metadata' in client.calls and 'index' in client.calls
    assert 'stock' not in client.calls


def test_close_phase_discovers_new_day_and_refreshes_stock(tmp_path):
    path = tmp_path / 'market.duckdb'
    provider_at(path, datetime(2024, 1, 5, 16)).sync_with_client(CountingClient())
    provider_at(path, datetime(2024, 1, 8, 9)).sync_with_client(CountingClient(), skip_current=True)
    client = CountingClient(count=5)
    provider = provider_at(path, datetime(2024, 1, 8, 16))
    provider.sync_with_client(client, skip_current=True)
    assert 'index' in client.calls and 'stock' in client.calls
    assert provider.cache.latest_trade_date('stock_daily_bars', '600000.SH').isoformat() == '2024-01-08'


@pytest.mark.parametrize('damage', ['failure', 'factor', 'bar', 'calendar', 'listing', 'index', 'calendar-tail'])
def test_failed_or_incomplete_resource_is_not_skipped(tmp_path, damage):
    path = tmp_path / 'market.duckdb'
    provider = provider_at(path, datetime(2024, 1, 5, 16))
    provider.sync_with_client(CountingClient())
    if damage == 'failure':
        provider.cache.record_resource_sync('600000.SH', 'stock-day', error='timeout', now=provider.now())
    else:
        with duckdb.connect(str(path)) as connection:
            if damage == 'factor':
                connection.execute("DELETE FROM stock_adj_factors WHERE trade_date = '2024-01-03'")
            elif damage == 'bar':
                connection.execute("DELETE FROM stock_daily_bars WHERE trade_date = '2024-01-03'")
            elif damage == 'calendar':
                connection.execute('DELETE FROM trade_calendar')
            elif damage == 'calendar-tail':
                connection.execute("DELETE FROM trade_calendar WHERE cal_date = '2024-01-05'")
            elif damage == 'index':
                connection.execute("DELETE FROM index_daily_bars WHERE trade_date = '2024-01-05'")
            else:
                connection.execute('UPDATE stock_instruments SET list_date = NULL')
    client = CountingClient()
    provider.sync_with_client(client, skip_current=True)
    assert ('index' if damage in {'calendar', 'calendar-tail', 'index'} else 'stock') in client.calls
    assert provider.cache.is_replay_ready(provider.benchmark_codes, 3)


def test_bulk_write_revises_duplicates_preserves_other_rows_and_rolls_back_factors(tmp_path):
    cache = TdxMarketCache(tmp_path / 'market.duckdb')
    rows, factors = build_stock_history('600000.SH', make_daily_frame('2024-01-02', 4, 10),
        pd.DataFrame(), updated_at=datetime(2024, 1, 5, 16))
    cache.upsert_stock_history(rows, factors)
    cache.upsert_stock_history([rows[0], {**rows[0], 'close': 99}], [factors[0], {**factors[0], 'adj_factor': .5}])
    with duckdb.connect(str(cache.path)) as connection:
        before = connection.execute('SELECT * FROM stock_daily_bars ORDER BY trade_date').fetchall()
        assert len(before) == 4 and before[0][5] == 99
        assert connection.execute('SELECT adj_factor FROM stock_adj_factors ORDER BY trade_date LIMIT 1').fetchone()[0] == .5
    with pytest.raises(duckdb.ConstraintException):
        cache.upsert_stock_history([{**rows[0], 'close': 77}], [{**factors[0], 'adj_factor': None}])
    with duckdb.connect(str(cache.path)) as connection:
        assert connection.execute('SELECT * FROM stock_daily_bars ORDER BY trade_date').fetchall() == before


def test_bulk_metadata_keeps_listing_dates_and_last_non_null_delisting_date(tmp_path):
    cache = TdxMarketCache(tmp_path / 'market.duckdb')
    first_date = datetime(2024, 1, 2).date()
    last_date = datetime(2024, 1, 5).date()
    row = {'ts_code': '600000.SH', 'symbol': '600000', 'name': 'original', 'market': '主板',
        'list_status': 'L', 'list_date': first_date, 'delist_date': last_date, 'updated_at': datetime(2024, 1, 5, 16)}
    cache.upsert_instruments([row, {**row, 'name': 'revised', 'list_date': None, 'delist_date': None}])
    cache.upsert_instruments([{**row, 'name': 'latest', 'list_date': last_date, 'delist_date': None}])
    with duckdb.connect(str(cache.path)) as connection:
        assert connection.execute('SELECT name, list_date, delist_date FROM stock_instruments').fetchone() == ('latest', first_date, last_date)
