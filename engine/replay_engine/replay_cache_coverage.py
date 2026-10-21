"""Public, anonymous aggregation of cache inventory. No network or persistence."""
from typing import Any
from .replay_cache_policy import BOARDS, BOARD_LABELS, board_for_code, reserve_targets
from .minute_replay import MinuteReplayStore


def cache_coverage(daily: list[dict[str, Any]], minute: list[dict[str, Any]], *, excluded: tuple[str, ...],
                   target_date, minimum_bars: int, daily_target: int = 12, benchmark_code: str = '000001.SH') -> dict[str, Any]:
    seen = set(excluded)
    targets = reserve_targets(daily_target)
    benchmark = next((item for item in minute if item['code'] == benchmark_code and item['kind'] == 'index-5m'), None)
    benchmark_current = bool(target_date) and MinuteReplayStore.item_current(benchmark, target_date)
    eligible = {item['code'] for item in daily if item['eligible']}
    target = target_date.isoformat() if target_date else None
    boards = []
    for board in BOARDS:
        stock = [item for item in daily if item['board'] == board]
        intraday = [item for item in minute if item['kind'] == 'stock-5m' and board_for_code(item['code']) == board]
        daily_dates = sorted(item['latestDate'] for item in stock if item['latestDate'])
        minute_dates = sorted(item['latestTime'].date().isoformat() for item in intraday if item['latestTime'])
        boards.append({'key': board, 'label': BOARD_LABELS[board], 'daily': {
            'cachedCount': sum(item['barCount'] > 0 for item in stock), 'eligibleCount': sum(item['eligible'] for item in stock),
            'unseenCount': sum(item['eligible'] and item['code'] not in seen for item in stock), 'targetReserve': targets[board],
            'staleCount': sum(item['barCount'] > 0 and (not target or (item['latestDate'] or '') < target) for item in stock),
            'failedCount': sum(bool(item['error']) for item in stock),
            'earliestDataDate': daily_dates[0] if daily_dates else None, 'latestDataDate': daily_dates[-1] if daily_dates else None,
        }, 'fiveMinute': {
            'cachedCount': sum(item['barCount'] > 0 for item in intraday), 'completeCount': sum(item['full'] and item['barCount'] > 0 for item in intraday),
            'unseenCount': sum(benchmark_current and item['code'] in eligible and item['code'] not in seen and MinuteReplayStore.item_current(item, target_date) for item in intraday),
            'targetReserve': 1, 'staleCount': sum(not target_date or not MinuteReplayStore.item_current(item, target_date) for item in intraday),
            'failedCount': sum(bool(item['error']) for item in intraday),
            'earliestDataDate': minute_dates[0] if minute_dates else None, 'latestDataDate': minute_dates[-1] if minute_dates else None,
        }})
    return {'boards': boards, 'targetTradeDate': target, 'minimumDailyBars': minimum_bars,
        'qualification': 'stock-continuous-history', 'benchmarkCurrent': benchmark_current}
