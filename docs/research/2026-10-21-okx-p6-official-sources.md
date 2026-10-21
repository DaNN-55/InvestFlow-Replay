# P6：OKX BTC/ETH 官方历史来源核验

日期：2026-10-21（北京时间）。分支：`codex/okx-crypto-training`。状态：**只读来源研究；未修改业务代码，未创建账户或订单，未做全量下载。**

本文只回答 P6 数据池扩充前的来源和准入问题：OKX `BTC-USDT-SWAP`、`ETH-USDT-SWAP` 在 2024–2025 年的 ordinary 1m、mark 1m、实际资金费分别有什么官方入口、覆盖声明、字段和限制。P2 已冻结的小样本与模型规则不在本文中重算或修改。

## 结论

1. **ordinary 1m 有可用的官方批量月档。** 官方批量端点的 `module=2` 明确表示 1-minute candlestick，返回真实静态 ZIP 下载链接。2024–2025 的 BTC/ETH 月档元数据已用官方接口分段查询：2024 年 1–10 月、11–12 月和 2025 年 1–10 月、11–12 月均返回两个 instrument family 的文件名和 URL。官方页面另外声明 OHLC candlestick 历史从 2023 年 7 月开始；这证明官方声称的起始范围，不代替逐文件完整性校验。
2. **实际资金费也有可用的官方批量月档。** `module=3` 返回按合约族命名的 funding rate ZIP；2024–2025 两币的同样分段查询均返回月文件。官方历史页声明 perpetual funding rate 从 2022 年 3 月开始。月 ZIP 的 CSV 字段为 `instrument_name,funding_rate,funding_time`；`funding_time` 是 Unix 毫秒字段，月档实测的 BTC 2024-01 文件含表头加 93 条记录。
3. **mark 1m 没有在官方批量历史模块中出现。** 批量 API 文档列出的模块为 trade、1-minute candlestick、funding rate 和 orderbook，没有 mark candlestick 模块。mark 仍可通过官方 `GET /api/v5/market/history-mark-price-candles` 分页取得；官方文档把 `limit` 最大值标为 100、限速 20 requests/2s，但本轮当前服务实测请求 `limit=300` 返回 300 行，`limit=1000` 也返回 300 行。因此 100 是文档标注值，不能写成当前服务的硬上限；下载器可请求 300，同时必须按实际返回逐页验证。对 2024 和 2025 的少量 BTC/ETH 页请求均返回完整的 `[ts,o,h,l,c,confirm]` 六字段行。本轮对两个推测的 mark 月 ZIP 路径做了 404 探针，不能据此断言所有未来/地区都没有静态 mark 归档，但当前不能把 ordinary 月 ZIP 改名后当作 mark 来源。
4. **REST funding history 不适合补 2024–2025。** 官方明确该接口最多返回 3 个月、每页最多 400 条；它返回预测 `fundingRate` 与实际结算 `realizedRate`，并带 `formulaType`、`method`、毫秒 `fundingTime`。本轮对 BTC/ETH 用旧的 2024 时间游标请求，响应 `code=0` 但 `data=[]`；不应把空数组解释为旧窗口无资金费，长期窗口应使用官方归档。
5. **月档和 P2 日档的时间语义要分开保存。** 已冻结 P2 使用的 all-swap 日 ZIP 保留源行中的秒级 `funding_time`；官方 BTC 2024-01 合约月 ZIP 的前 12 条费率与 P2 日档相同，时间也在该窗口中一致为整 8 小时槽位。其他合约/日期仍需逐文件核对，不能凭 8 小时名义间隔插值或把月档字段扩展成未提供的发布时刻。

## 官方入口与接口契约

### 官方历史数据页

OKX 的[Historical market data](https://www.okx.com/historical-data) 页面给出四类公开历史数据的官方声明：tick-level trade history 从 2021-09 起；OHLC candlestick 从 2023-07 起；perpetual funding rate 从 2022-03 起；高分辨率 L2 orderbook 从 2023-03 起。这里是厂商的覆盖宣传/目录声明，不能替代本地下载后的文件存在性、行数、连续性和 SHA256 验证。

### 批量历史查询：普通 1m 与资金费

官方 [V5 API guide：Get historical market data](https://www.okx.com/docs-v5/en/#public-data-rest-api-get-historical-market-data) 的公开端点是：

```text
GET https://www.okx.com/api/v5/public/market-data-history
```

文档给出的参数和限制如下：

| 参数 | 取值/语义 | 对 P6 的影响 |
| --- | --- | --- |
| `module` | `2` = 1-minute candlestick；`3` = funding rate；`1` = tick trade；`4/5/6` = orderbook | 没有列出 mark-price candlestick 模块 |
| `instType` | `SWAP` | 目标合约使用 `SWAP` |
| `instFamilyList` | 例如 `BTC-USDT,ETH-USDT`，非 SPOT；最多 10 个 | 一次查询可包含 BTC/ETH 两个合约族 |
| `dateAggrType` | `daily` 或 `monthly`；funding 的合约族查询不支持 `daily`，除非使用 `ANY` | 月档适合 P6 长期文件索引 |
| `begin` / `end` | 毫秒时间戳，含两端；文档称 daily 最多 10 天、monthly 最多 10 个月 | 24 个月应至少拆成 3 个窗口；实际查询按 10+2 个月拆分 |
| 时间解释 | module 1/2/3/11 的时间戳按 UTC+8 转日期；只使用日期部分，返回逆时间顺序 | 请求的月边界要用北京时间，并注意端点包含下一月首日的风险 |
| 发布延迟 | 文档提示 module 1/2/3/11 通常 T+2，orderbook 通常 T+3 | 当月/最近月份不能用“空目录”直接判历史缺失 |

官方返回的每个 `groupDetails` 包含 `filename`、`sizeMB`、`dataTs` 和 `url`。下载地址由 API 返回，不能只依赖手写的 URL 模板。实际查询地址的完整形态为：

```text
GET https://www.okx.com/api/v5/public/market-data-history?
  module=2&instType=SWAP&instFamilyList=BTC-USDT,ETH-USDT&
  dateAggrType=monthly&begin=<UTC+8日期毫秒>&end=<UTC+8日期毫秒>
GET https://www.okx.com/api/v5/public/market-data-history?
  module=3&instType=SWAP&instFamilyList=BTC-USDT,ETH-USDT&
  dateAggrType=monthly&begin=<UTC+8日期毫秒>&end=<UTC+8日期毫秒>
```

本轮 module 2 ordinary 月 ZIP 的实测 CSV 头有 **10 列**：

```text
instrument_name,open,high,low,close,vol,vol_ccy,vol_quote,open_time,confirm
```

这与 ordinary REST 的 9 元组不同：ZIP 把合约名和 `open_time` 写进 CSV；`vol`、`vol_ccy`、`vol_quote` 的量纲仍需按官方衍生品说明解析。module 3 funding 月 ZIP 的实测 CSV 头有 **3 列**：

```text
instrument_name,funding_rate,funding_time
```

普通月档在本轮返回的实测模式为：

```text
https://static.okx.com/cdn/okex/traderecords/candlesticks/monthly/YYYYMM/
  BTC-USDT-SWAP-candlesticks-YYYY-MM.zip?v=1001
```

资金费月档在本轮返回的实测模式为：

```text
https://static.okx.com/cdn/okex/traderecords/swaprates/monthly/YYYYMM/
  BTC-USDT-SWAP-fundingrates-YYYY-MM.zip?v=1001
```

这两个模板仅用于阅读实际返回结果；实现时应保存批量 API 的原始 JSON 和其返回 URL。

### 普通历史 K 线 REST

官方 [Get Candlesticks history](https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-candlesticks-history) 是：

```text
GET /api/v5/market/history-candles
```

文档称普通历史 K 线来自最近几年，1s K 线仅支持最近 3 个月；`1m` 到 `4H`、UTC+8/UTC+0 日线粒度可选，单页最大 100 条，限速 20 requests/2s（IP）。普通合约响应为 `[ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]`：衍生品的 `vol` 是合约数，`volCcy` 是标的币数量，`volCcyQuote` 是计价币数量；`confirm=1` 表示已完成。

P2 的下载脚本保存的是该 endpoint 的原始响应、URL、获取时间和 SHA256；`backend/src/replay-crypto-source-job.js` 还会检查 origin、endpoint、`instId`、`bar` 和逐分钟覆盖。P6 采用官方月 ZIP 时，应为 ZIP/CSV 建立等价的来源身份与覆盖检查，不能仅以文件名准入。

### mark 历史 K 线 REST

官方 [Get mark price candlesticks history](https://www.okx.com/docs-v5/en/#rest-api-market-data-get-mark-price-candlesticks-history) 是：

```text
GET /api/v5/market/history-mark-price-candles
```

文档称可取最近几年 mark price candlestick；支持 `1m`、`3m`、`5m`、`15m`、`30m`、`1H`、`2H`、`4H` 以及 UTC+8/UTC+0 的日/周/月粒度，文档标注单页最大 100 条，限速 20 requests/2s（IP）。响应只有 `[ts,o,h,l,c,confirm]`，没有成交量。`ts` 是毫秒开盘时间；`confirm=0/1` 分别表示未完成/完成。

本轮使用 `User-Agent: Mozilla/5.0` 和 `Accept: application/json` 对 BTC 在 `after=1767196800000` 的 1m 页面重复请求：`limit=100` 返回 100 行，`limit=300` 返回 300 行，`limit=1000` 仍返回 300 行，三次均 `code=0`，字段宽度为 6；两币 2024/2025 的少量 `limit=100` 请求也均为 `code=0`。这说明当前服务实际至少接受 300 行/页，1000 被截为 300；不能把官方文档中的 100 直接写成当前硬上限。没有这些常见请求头时，本环境曾收到 HTTP 403；加头后同一公开请求可用。这是访问条件观察，不是 OKX 官方数据缺口。

官方批量端点的 `module` 枚举没有 mark candlestick。对以下两个少量推测路径做了状态探针，均为 HTTP 404；它们不是官方文档给出的入口：

```text
https://static.okx.com/cdn/okex/traderecords/mark-price-candlesticks/monthly/202401/
  BTC-USDT-SWAP-mark-price-candlesticks-2024-01.zip?v=1001
https://static.okx.com/cdn/okex/traderecords/mark-price-candlesticks/monthly/202512/
  BTC-USDT-SWAP-mark-price-candlesticks-2025-12.zip?v=1001
```

因此当前长期 mark 方案只能写成“REST 分页 + 每页原始响应缓存 + 覆盖验证”。若以后发现官方返回了新的 mark 批量模块或目录，需重新做来源审计，不能静默替换。

### funding rate history REST

官方 [Get funding rate history](https://www.okx.com/docs-v5/en/#rest-api-public-data-get-funding-rate-history) 是：

```text
GET /api/v5/public/funding-rate-history
```

文档明确写明该接口最多返回 3 个月；按 `instId` 分页，限速为 10 requests/2s（IP + Instrument ID），单页最多 400 条。字段包括：

| 字段 | 官方语义 |
| --- | --- |
| `fundingRate` | 预测的下一结算资金费率 |
| `realizedRate` | 实际资金费率 |
| `fundingTime` | 结算时间，Unix 毫秒 |
| `formulaType` | `noRate` 旧公式或 `withRate` 新公式 |
| `method` | `current_period` 或 `next_period` 机制 |

官方还提示部分永续的收取频率可能从通常的 8 小时调整为 6/4/2/1 小时，应根据资金时间差确定实际间隔。该提示和 `fundingTime` 秒/毫秒字段都意味着不能用固定 8 小时插值补旧事件。

### 官方资金费归档

官方批量 API `module=3` 返回合约族月/日 ZIP。官方全合约日归档的一个已冻结地址示例是：[2024-01-01 allswap funding ZIP](https://static.okx.com/cdn/okex/traderecords/swaprates/daily/20240101/allswap-fundingrates-2024-01-01.zip?v=1001)。合约族月档的实测地址示例是：[BTC-USDT-SWAP 2024-01 monthly ZIP](https://static.okx.com/cdn/okex/traderecords/swaprates/monthly/202401/BTC-USDT-SWAP-fundingrates-2024-01.zip?v=1001)。

月 ZIP CSV 头为：

```text
instrument_name,funding_rate,funding_time
```

本轮在内存中读取 BTC 2024-01 月 ZIP：94 行（表头 + 93 条 BTC funding event），文件内首行费率为 `0.0002955843024083`、`funding_time=1704038400000`；对 P2 已保存的 2024-01-01 至 2024-01-04 日 ZIP 过滤出 BTC 后，前 12 条费率和时间与月档一致。日 allswap 文件则包含很多合约，且其他合约/其他日期可能出现秒级偏移；P2 的冻结原始行必须继续按源文件保留。

## 本轮少量实测结果

所有请求均为公开市场数据读取；没有 API key、私有接口、账户连接或订单操作。

| 检查 | 实测结果 | 解释 |
| --- | --- | --- |
| 批量 module 2，2024-01 至 2024-10 | `code=0`；BTC、ETH 各 10 个普通月 ZIP；两币合计 API 报告 `23.01 MB` | 证明该窗口的官方文件索引可取得，不等于已下载/校验文件 |
| 批量 module 2，2025-01 至 2025-10 | `code=0`；BTC、ETH 各 10 个普通月 ZIP；两币合计 API 报告 `24.92 MB` | 同上 |
| 批量 module 2，2024-11 至 2024-12、2025-11 至 2025-12 | 每币每窗口各 2 个文件，均 `code=0` | 24 个月的普通月档索引分段均有返回；查询 end 必须避免把下一月首日包含进来 |
| 批量 module 3，2024/2025 同四段窗口 | 每币每窗口各返回对应 fundingrates 月 ZIP，均 `code=0` | 资金费归档可作为长期 REST 替代入口 |
| ZIP 字段数 | module 2 ordinary CSV 实测 10 列：`instrument_name,open,high,low,close,vol,vol_ccy,vol_quote,open_time,confirm`；module 3 funding CSV 实测 3 列：`instrument_name,funding_rate,funding_time` | ZIP CSV 不能直接当作 REST 数组；需保留合约名、时间字段和量纲映射 |
| 官方静态 URL HEAD/轻量 GET | 2024-01 ordinary 月 ZIP：HTTP 200、约 1.15 MB；2025-12 ordinary 月 ZIP：HTTP 200、1,312,053 bytes；对应 BTC funding 月 ZIP：HTTP 200，约 1.3 KB | URL 由批量 API 返回；没有全量下载普通数据 |
| mark 静态猜测路径 | 2024-01 和 2025-12 两个 `mark-price-candlesticks` 路径 HTTP 404 | 仅说明这些猜测路径不可用，不构成所有静态 mark 目录不存在的证明 |
| mark REST，BTC，`after=1767196800000` | `limit=100` 返回 100 行；`limit=300` 返回 300 行；`limit=1000` 返回 300 行；均 `code=0`、六字段数组 | 官方文档标注 100，但当前服务实测返回上限至少为 300；下载器应按实际行数和完整分钟覆盖验证 |
| funding REST，BTC/ETH，旧 2024 游标 `after=1704124800000` | `code=0`、`data=[]` | 与官方“最多 3 个月”一致；不能作为旧窗口无事件的证据 |
| funding REST，BTC/ETH 当前请求 | `code=0`、278 行；字段含 `realizedRate`、`fundingTime`、`formulaType`、`method` | 当前窗口可查，但不替代 2024–2025 归档 |
| 请求头条件 | 无常见浏览器头时本环境收到 HTTP 403；`Mozilla/5.0` + `Accept: application/json` 后同一公开 REST `code=0` | 在下载器中固定 User-Agent，并把访问失败与数据空结果区分记录 |

## 对 P6 数据池的准入建议

### 可以进入长期准入候选

- ordinary 1m：使用官方 `module=2` 返回的每月 ZIP；每个文件保存批量查询响应、官方 URL、下载时间、字节数、SHA256、CSV 头、合约和月份。月文件命名与目录不是独立的真实性证明。
- 实际 funding：优先使用官方 `module=3` 月 ZIP（或全合约日 ZIP）；CSV 中只使用实际 `funding_rate` 与源 `funding_time`，保留原字符串，不能由 REST `fundingRate` 预测值替代。每个窗口要保留前后保护事件并验证是否存在缺日/重复。
- 2024–2025 普通/funding：当前官方索引准入覆盖已由 10+10+2+2 个月小查询确认；真正进入冻结池前仍需逐文件下载、ZIP/CSV 解析、分钟连续性、合约过滤、费率重复性和来源索引校验。

### 仍需按批次准入

- mark 1m：目前只有 REST。官方文档标注 `limit=100`，本轮当前服务 `limit=300` 返回 300 行、`limit=1000` 返回 300 行；按请求 300 估算，BTC/ETH 两币 2024–2025 全窗口约 `2 × 731 × 1440 / 300 ≈ 7,018` 个页面（闰日和保护边界会略有变化）。必须分批缓存，不能把“官方称最近几年”写成已覆盖。
- mark 每页要保存原始 JSON、URL、请求头策略、响应 SHA256、页面时间范围和 `confirm`；全窗口完成后再做无重复、无缺口和时间对齐审计。若请求受限，记录已覆盖日期和未准入日期。
- 普通月 ZIP 与 funding 月 ZIP 的字段/时区需要单独适配；不能直接复用 P2 `history-candles` source-job 对 gzip REST 页的解码器，也不能改变 P2 冻结样本。

## 与 P2 冻结证据的关系

P2 的[冻结报告](./2026-10-19-crypto-p2-sample.md)和[下载脚本](../../engine/scripts/download_okx_sample.py)仍是 BTC/ETH 2024-01-01（北京时间）各 90 天背景 + 72h 回放 + 1 分钟结束执行的既有事实来源。该样本已经保存普通/mark REST 原始响应和官方 funding 日 ZIP，并通过离线完整性验证；本报告只为 P6 扩展数据池补充官方批量目录与限制，不改 P2 数据、不改 `funding_time` 语义、不把新的官方月档宣传成已冻结本地样本。

## 官方来源清单

- [OKX Historical market data](https://www.okx.com/historical-data)
- [OKX V5 API：Get historical market data](https://www.okx.com/docs-v5/en/#public-data-rest-api-get-historical-market-data)
- [OKX V5 API：Get Candlesticks history](https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-candlesticks-history)
- [OKX V5 API：Get mark price candlesticks history](https://www.okx.com/docs-v5/en/#public-data-rest-api-get-mark-price-candlesticks-history)
- [OKX V5 API：Get funding rate history](https://www.okx.com/docs-v5/en/#rest-api-public-data-get-funding-rate-history)
- [OKX V5 API changelog：Historical market data query endpoint（2025-09-02）](https://www.okx.com/docs-v5/log_en/)
- [官方 2024-01-01 allswap funding ZIP](https://static.okx.com/cdn/okex/traderecords/swaprates/daily/20240101/allswap-fundingrates-2024-01-01.zip?v=1001)
- [官方 BTC-USDT-SWAP 2024-01 funding 月 ZIP](https://static.okx.com/cdn/okex/traderecords/swaprates/monthly/202401/BTC-USDT-SWAP-fundingrates-2024-01.zip?v=1001)
