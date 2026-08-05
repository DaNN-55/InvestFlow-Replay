from replay_engine.config import MARKET_DB_PATH
from replay_engine.tdx_market_cache import TdxMarketCache


cache = TdxMarketCache(MARKET_DB_PATH)
cache.ensure_schema()
print(f"已初始化空行情库：{MARKET_DB_PATH}")
