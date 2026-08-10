# InvestFlow Replay

从 InvestFlow 独立提取的行情演练与交易追踪工具。外部行情只来自通达信（easy-tdx），行情缓存、演练快照、战法版本、交易记录和复盘账本均保存在本机。

## 包含内容

- 日线演练、1 分钟演练和日线背景 + 5 分钟执行的日内模拟
- 通达信证券列表、股票/指数日线、XDXR 除权除息解析与本地前复权
- DuckDB 行情缓存和分钟缓存，支持按需下载与增量更新
- 演练会话、交易执行、盲评/复盘、战法版本和历史记录
- 独立交易追踪、买入许可证、成交事件与本地复盘账本

项目不包含市场扫描、股票诊断、量化实验室，也不包含任何全量行情或个人交易数据。历史退市股票名单受通达信当前证券列表能力限制。

## 安装与启动

需要 Python 3.11+、Node.js 22+ 和可访问通达信行情服务器的网络。

```bash
./install.sh
./run.sh
```

浏览器打开 `http://127.0.0.1:5180/decision/market-replay`。停止服务运行 `./stop.sh`。

首次进入时会后台初始化最小可用的日线缓存，页面会显示进度；最小缓存就绪后即可开始，完整历史继续在后台补齐。分钟线在首次选中具体标的后按需下载，视通达信节点情况可能需要数秒到数十秒，后续相同标的优先复用本地缓存。断网时，缓存足够则继续使用；缓存不足会明确返回通达信连接失败及缓存不足原因。

## 本地数据

- `storage/market/market.duckdb`：日线、复权因子、证券名称、指数和交易日历
- `storage/market/minute_replay.duckdb`：1 分钟与 5 分钟缓存
- `storage/app/replay.sqlite`：演练快照、订单、复盘和战法账本
- `storage/trade-records/*.json`：个人交易追踪记录

这些运行时文件均被 `.gitignore` 排除。仓库只分享下载/解析代码和空库初始化结构。

## 测试

```bash
PYTHONPATH=engine .venv/bin/python -m pytest engine/tests
npm test --prefix backend
npm run test:unit --prefix web
npm run lint --prefix web
npm run build --prefix web
```
