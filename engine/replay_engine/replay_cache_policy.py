"""Shared cache policy; the trading calendar itself stays in cached source data."""
from datetime import date, datetime, time
from zoneinfo import ZoneInfo

BOARDS = ("main", "chinext", "star")
BOARD_LABELS = {"main": "主板", "chinext": "创业板", "star": "科创板"}
DAILY_RESERVE = 12
MINUTE_RESERVE = 3
DAILY_BATCH_SIZE = 12
MAINTENANCE_INTERVAL = 60
RETRY_SECONDS = 300
CLOSE_GRACE = time(15, 10)


def market_now() -> datetime:
    return datetime.now(ZoneInfo("Asia/Shanghai")).replace(tzinfo=None)


def board_for_code(code: str) -> str | None:
    value = str(code).strip().upper()
    symbol, _, suffix = value.partition(".")
    if len(symbol) != 6 or not symbol.isdigit():
        return None
    if suffix == "SH" and symbol.startswith("688"):
        return "star"
    if suffix == "SZ" and symbol.startswith(("300", "301")):
        return "chinext"
    if (suffix == "SH" and symbol.startswith(("600", "601", "603", "605"))) or (suffix == "SZ" and symbol.startswith(("000", "001", "002", "003"))):
        return "main"
    return None


def reserve_targets(total: int) -> dict[str, int]:
    total = max(0, int(total))
    return {board: total // len(BOARDS) + (index < total % len(BOARDS)) for index, board in enumerate(BOARDS)}


def maintenance_key(now: datetime) -> str:
    return f"{now.date().isoformat()}:{'closed' if now.time() >= CLOSE_GRACE else 'open'}"


def latest_completed_date(dates: list[date], now: datetime) -> date | None:
    eligible = [day for day in dates if day < now.date() or (day == now.date() and now.time() >= CLOSE_GRACE)]
    return max(eligible, default=None)
