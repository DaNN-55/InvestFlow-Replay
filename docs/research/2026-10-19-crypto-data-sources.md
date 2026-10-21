# 加密合约历史数据源核查

日期：2026-10-19。状态：只读调研，服务于产品讨论；未实现业务功能，未创建训练会话、下单或修改账本。

本文只维护加密合约方向的数据源核查，不修改共同 `CONTEXT.md`、A 股讨论记录或代码。

## 本轮成功判据

| 可检查结果 | 本文对应产出 |
| --- | --- |
| 能判断 1 分钟至 1 天 K 线是否有官方来源 | 三家交易所 K 线接口和归档对照 |
| 能判断强平训练所需的标记价格与资金费是否可得 | 标记价格、资金费历史和保留窗口对照 |
| 能解释成交先后精度能做到哪里 | 聚合/逐笔成交、分页和归档限制 |
| 能选择一个首期主源，并保留备选 | 推荐理由、限制和待验证项 |
| 不把文档声明冒充实测 | 明确厂商声明、项目样本实测和未验证事项 |

## 已确认的训练条件

- 主要给用户自己使用，优先练习效果。
- 历史盲测为主；实时交易所 Demo 只补充界面和操作节奏。
- 持仓范围为几分钟到几小时，偶尔跨天。
- 数据粒度至少 1 分钟，最大到 1 天；训练需要在 1m 与 1d 之间切换或聚合。
- 重点是多空、保证金、止损和强平；首期不把现货开发设为前置。
- 当前阶段只讨论数据与方案，不实现合约引擎，不运行会修改账本的流程。
- 后续用户明确未来实际交易使用 OKX；如果 Binance 明显更便利，可接受先用 Binance，仍需比较训练价值。

## 结论与推荐

在用户说明未来实际使用 OKX、且补充样本实测通过后，**当前以 OKX 同源数据与规则为首期方向**。用户随后确认首期 BTC/ETH USDT 永续、先练逐仓。BTC/ETH 2024-01-01（UTC+8）普通 1m 归档、mark 1m REST、资金费均已无账户/API key 取得；分钟数据汇总与官方日线一致。完整证据和训练价值比较见 [OKX 训练适配](./2026-10-19-okx-training-fit.md)。业务功能仍未实现。

上一轮优先验证的 Binance USD-M 公共归档保留为已验证备选：无账户/API key 下载 2024-01-01 BTC/ETH 普通 1m、BTC 标记价格 1m 和 **2024 年 1 月**资金费均成功，并完成部分校验和、连续性与日线对账。它适合独立的 Binance 场景，不与 OKX 行情、标记价格、资金费或规则混拼。

Binance 的在线 `fapi.binance.com` 在当前环境对标记价格和资金费接口返回 HTTP 451（地区限制），因此不能把在线 REST 当作已验证依赖；归档 ZIP 是当前更可靠的离线入口。固定版本规则齐全时可做规则可核对的强平模拟，仍须单列分钟内先后和真实执行误差；缺少规则时只能按明确的简化口径作教学估算，不能称为交易所精确复现。

OKX 的 REST 资金费接口确实只承诺最多三个月，但这不是其长期历史能力的完整结论。官方历史页另列出资金费自 2022-03、普通 K 线自 2023-07 等归档。本轮批量下载实测已确认 2024-01-01 文件包含 BTC/ETH 完整 1m 与资金费，无需登录或 key；mark 1m 可从历史 REST 逐页取回。长期无缺口、其他日期和地区的可用性仍需按窗口核对。

Bybit 适合后续做近期窗口或操作 Demo 的同源参考：公开接口有普通 K 线、标记价格 K 线、资金费历史和近期成交，K 线最细可到 1m；但资金费每页最多 200 条，标记价格接口未在文档中给出多年保留承诺。官方另提供历史 OHLCV 与 trade CSV 下载站，是否包含同等完整的标记价格、资金费和规则快照，仍需小窗口实测。

## 三家官方能力对照

| 数据项 | Binance USD-M Futures | OKX SWAP/FUTURES | Bybit linear/inverse |
| --- | --- | --- | --- |
| 普通合约 K 线 | `/fapi/v1/klines`；1m 等周期，单次最多 1500；官方 USD-M 归档可按 daily/monthly ZIP 获取 | `/api/v5/market/history-candles`；1m、3m、5m、15m、30m、1H、2H、4H、6H、12H、1D 等，单次最多 100；官方称最近几年，1s 仅最近 3 个月 | `/v5/market/kline`；覆盖 linear/inverse，1m、3m、5m、15m、30m、60m、120m、240m、360m、720m、D/W/M，单次最多 1000 |
| 标记价格历史 | `/fapi/v1/markPriceKlines`；1m 等周期，单次最多 1500；官方 `binance-public-data` 提供 markPriceKlines 归档脚本 | `/api/v5/market/history-mark-price-candles`；官方称最近几年，1m 到 1D，单次最多 100 | `/v5/market/mark-price-kline`；覆盖线性/反向/期权，1m 到 D/W/M，单次最多 1000；未声明多年保留窗口 |
| 资金费历史 | `/fapi/v1/fundingRate`；返回 fundingRate、fundingTime、关联 markPrice，单次最多 1000；官方归档提供 `fundingRate` ZIP | REST `/api/v5/public/funding-rate-history` 最多 3 个月、单次最多 400；官方批量历史页另声明资金费自 2022-03 起可下载，结算周期可能按合约变化 | `/v5/market/funding/history`；USDT/USDC/Inverse 永续，单次最多 200；每合约资金费间隔不同，需另查 instruments-info |
| 成交数据 | 官方 daily/monthly `trades` 和 `aggTrades`；归档可追溯，REST `aggTrades` 在线只保留过去 48 小时 | `history-trades` 公共历史成交接口；官方历史下载页另声明自 2021-09 起的 tick 成交归档，实际文件未下载验证 | `recent-trade` 公开近期成交最多 1000；官方说明可从网站下载归档历史 trades，但长期范围需实测 |
| 标记/指数/溢价辅助 | 官方归档还提供 indexPriceKlines、premiumIndexKlines | REST 另有 index candles 与 mark-price candles；官方批量历史页没有分别列出 mark/index 起始年份，须实测模块与字段 | 另有 index price kline、premium/index 相关接口 |
| API key | 市场数据接口文档只列公开查询参数，未列签名或 key；按“公开接口”使用，但仍受 IP 权重限制 | 公共市场数据接口按 IP 限速，未列 API key；账户、交易和私有流水才需要 key | `/v5/market/*` 市场接口未列 API key，Demo 账户交易另需 key；公共接口仍受平台限频 |
| 历史规则档位 | 当前 `exchangeInfo`、leverage brackets、fundingInfo 可查当前规则/调整；官方归档没有承诺逐日历史保证金档位 | 当前 instruments、position tiers、fee/risk 参数可查；未见完整逐日历史规则归档承诺 | 当前 instruments-info、risk-limit 等可查；未见完整逐日历史规则快照承诺 |

以上“API key”结论是根据官方端点的参数/鉴权说明作出的工程判断，不等于平台对所有地区和访问方式的可用性承诺。

## Binance：已验证的独立备选

### 官方声明

Binance 官方公共数据仓库说明：网站 `data.binance.vision` 提供按日或按月的公开市场数据，USD-M Futures 的 `klines` 来自 `/fapi/v1/klines`，`aggTrades` 来自 `/fapi/v1/aggTrades`，`trades` 来自 `/fapi/v1/trades`；文件可带 `.CHECKSUM` 校验文件。仓库中的 Futures 专用脚本包含 `download-futures-markPriceKlines.py`、`download-futures-indexPriceKlines.py` 和 `download-futures-premiumPriceKlines.py`，默认从 2020-01-01 处理。

- [Binance Public Data README](https://github.com/binance/binance-public-data)
- [Binance Public Data Python README](https://raw.githubusercontent.com/binance/binance-public-data/master/python/README.md)
- [USD-M Futures REST 市场数据总览](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data)
- [Kline/Candlestick Data](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Kline-Candlestick-Data)
- [Mark Price Kline/Candlestick Data](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Mark-Price-Kline-Candlestick-Data)
- [Get Funding Rate History](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Get-Funding-Rate-History)

### 项目内样本实测

主 Agent 在当前环境通过公开 ZIP 下载成功取得：

- `BTCUSDT-1m-2024-01-01.zip`：1440 根，约 60,977 B；
- `BTCUSDT-1m-2024-01-01.zip` 的 `markPriceKlines` 对应文件：1440 根，约 33,182 B；
- `ETHUSDT-1m-2024-01-01.zip`：1440 根，约 61,611 B；
- `BTCUSDT-fundingRate-2024-01.zip`：**2024 年 1 月** 93 条，约 696 B，字段含 `calc_time`、`funding_interval_hours`、`last_funding_rate`。

示例官方路径：

- [BTCUSDT 1m K 线 ZIP](https://data.binance.vision/data/futures/um/daily/klines/BTCUSDT/1m/BTCUSDT-1m-2024-01-01.zip)
- [BTCUSDT 1m 标记价格 K 线 ZIP](https://data.binance.vision/data/futures/um/daily/markPriceKlines/BTCUSDT/1m/BTCUSDT-1m-2024-01-01.zip)
- [BTCUSDT 2024 年 1 月资金费 ZIP](https://data.binance.vision/data/futures/um/monthly/fundingRate/BTCUSDT/BTCUSDT-fundingRate-2024-01.zip)

该实测进一步确认：BTC/ETH 2024-01-01 普通 1m 各 1440 条、无重复；BTC 当日 mark 1m 1440 条并与普通 K 线逐条时间对齐；三个 ZIP 的 SHA256 与官方 `.CHECKSUM` 相符。BTC 2024 年 1 月 `1d` 归档 31 条，1 月 1 日由 1m 汇总的 OHLCV 与官方 1d 完全一致。离散旧窗口也通过：BTC 2020-01-01 普通/mark 1m 各 1440 条连续记录、BTC 2020-01 资金费 93 条、ETH 2024-01-01 mark 1m 1440 条及 2024-01 资金费 93 条、BTC 2025-01-01 普通 1m 1440 条。所有下载只在内存解析，无原始文件残留。

样本 ZIP 的 SHA256（本次取得的版本）：

| 2024-01-01 样本 | SHA256 |
| --- | --- |
| BTCUSDT 普通 1m | `19bb9f0d6b88db48e787ae2aaec04f19295c366fadb2e02abaa000529ac93d89` |
| BTCUSDT 标记价格 1m | `660efeefdc875f052051b94c2976babd013f64c6633bf58ba030764771747b90` |
| ETHUSDT 普通 1m | `db143263ed9be478acb69a3290318d20cee518dd930c8372857818642d50fe98` |

这些是离散样本，不等于 2020–2025 全覆盖验证，也不证明所有标的、所有年份、所有规则字段都完整。按 1m 粒度估算，一个合约一条价格流一年约 525,600 条；两个合约、普通与标记两条流在平年约 2,102,400 条，实际存储量取决于压缩和字段。历史保证金档位、手续费和其他规则仍未验证。

### Binance 的限制

- REST `aggTrades` 官方只承诺查询过去 48 小时，且 `startTime/endTime` 窗口需小于 1 小时；历史训练应使用归档，而不是在线分页重建多年成交。
- `fundingRate` 文档给出了 `markPrice`、`fundingTime` 和 `rateType` 字段，但没有在该端点页承诺无限历史保留；应以归档文件实际存在范围为准。
- `exchangeInfo`、杠杆/风险档位和费率接口主要反映当前状态或近期调整。官方公开归档并未承诺逐日保存历史维护保证金档位，因此“用当前规则重算旧场景”必须标成固定教学规则，而不能说是当时交易所精确复现。
- 当前环境访问 `fapi.binance.com` 的标记价格和资金费接口返回 HTTP 451（地区限制）。这是本次环境实测，不代表所有地区；因此首期应离线下载并记录来源日期、URL、CHECKSUM。

## OKX：REST 窗口短，但官方批量历史数据补充了长期能力

OKX REST `history-candles` 可取得最近几年的历史 K 线，1s K 线只支持最近 3 个月；接口使用 `after`/`before` 按时间分页，单次最多 100 条。普通 K 线支持 1m 到 1D 及 UTC+0/UTC+8 日线口径。`history-mark-price-candles` 也声明来自最近几年，支持 1m 到 1D，单次最多 100 条。`funding-rate-history` 只承诺最多三个月、单次最多 400 条，提供预测 `fundingRate` 与已结算 `realizedRate`；部分合约资金费周期会从通常的 8 小时调整为 6/4/2/1 小时，应使用 `fundingTime` 与 `nextFundingTime` 判断实际间隔。

这三个 REST 保留限制不能代表 OKX 全部历史数据能力。OKX 官方历史数据页明确列出：成交历史自 **2021 年 9 月**、普通 Candlestick 自 **2023 年 7 月**、Funding rate 自 **2022 年 3 月**、高分辨率订单簿自 **2023 年 3 月**。官方文档日志还在 2025-09-02 记载新增公开批量端点，支持 trade history、candlestick、funding rate、orderbook 等模块及 daily/monthly 聚合；后续日志将批量查询范围调整为 daily 最多 10 天、monthly 最多 10 个月。官方 SDK 将真实端点写为 `/api/v5/public/market-data-history`，参数包含 `module`、`instType`、`dateAggrType`、`begin`、`end`，并可传合约列表。

官方页没有分别给出独立 mark/index 归档的起始日期，不能把普通 Candlestick 自动解释成这两条价格流。本轮进一步实测：`market-data-history` 的 module 2 返回普通 1m 归档，module 3 返回资金费归档，均取得真实文件 URL 并在无账户/key 情况下下载解析成功；BTC/ETH 完整 mark 1m 则从历史 REST 各取 15 页获得。此结论仅覆盖本次目标窗口，不代表所有模块、地区、下载配额和历史日期都已验收。

- [OKX Historical Data（官方历史下载页）](https://www.okx.com/historical-data)
- [OKX API changelog（官方日志，含批量历史端点）](https://www.okx.com/docs-v5/log_en/)
- [OKX API guide：history candles](https://www.okx.com/docs-v5/en/#rest-api-market-data-get-history-candlesticks)
- [OKX API guide：history mark price candles](https://www.okx.com/docs-v5/en/#rest-api-market-data-get-history-mark-price-candlesticks)
- [OKX API guide：funding rate history](https://www.okx.com/docs-v5/en/#rest-api-public-data-get-funding-rate-history)
- [OKX 官方 Python SDK：批量历史端点常量](https://github.com/okxapi/python-okx/blob/master/okx/consts.py)
- [OKX 官方 Python SDK：批量历史调用方法](https://github.com/okxapi/python-okx/blob/master/okx/PublicData.py)
- [OKX API guide 总览](https://www.okx.com/docs-v5/en/)

结合用户的实际平台目标和上述样本，OKX 应作为首期主源建议；未来若某些目标历史窗口确实不能补齐，再缩小窗口或考虑独立 Binance 场景，不自动拼接两家数据。本轮也发现普通归档 `confirm=0` 与同分钟 REST `confirm=1` 不同，虽首分钟及整日聚合 OHLCV 对账一致，仍需按来源保存并解释该字段。它是接入时的适配事项，不能静默当作未收盘而丢掉历史记录。

## Bybit：公开接口齐全，长期辅助数据需实测

Bybit 官方 V5 文档中的 `/v5/market/kline` 覆盖 spot、USDT/USDC contract 和 inverse contract，支持 1m 到 D/W/M，单次最多 1000 条；数据按 `startTime`/`endTime` 查询，结果倒序返回。

`/v5/market/mark-price-kline` 覆盖 USDT、USDC、Inverse 合约和期权，同样支持 1m 到 D/W/M、单次最多 1000 条；文档没有给出“最近几年”或固定历史保留期限。

`/v5/market/funding/history` 覆盖 USDT/USDC/Inverse 永续，每页最多 200 条，资金费间隔依合约而异；文档建议从 instruments-info 查询资金费间隔。接口没有提供资金费的多年归档承诺。

`/v5/market/recent-trade` 只返回近期公开成交，合约最多 1000 条；该页明确提示可以从 Bybit 网站下载历史成交归档。Bybit 首页也把“Historical Market Data”描述为可下载公开 OHLCV 和 trade CSV，但官方页面没有在同一处保证标记价格 K 线、资金费和历史风险档位都包含在下载文件中。

- [Bybit Get Kline](https://bybit-exchange.github.io/docs/v5/market/kline)
- [Bybit Get Mark Price Kline](https://bybit-exchange.github.io/docs/v5/market/mark-kline)
- [Bybit Get Funding Rate History](https://bybit-exchange.github.io/docs/v5/market/history-fund-rate)
- [Bybit Get Recent Public Trades](https://bybit-exchange.github.io/docs/v5/market/recent-trade)
- [Bybit Historical Market Data入口](https://bybit-exchange.github.io/docs/)
- [Bybit Demo Trading](https://bybit-exchange.github.io/docs/v5/demo)

Bybit 的公开 REST 不需要账户即可查询市场数据的判断来自端点参数和鉴权表未列 API key；交易 Demo 另需专用 key，且官方说明 Demo 不是完整实盘服务。长期历史归档需要下载一个小窗口实测后才能进入候选主源。

## 规则档位与强平训练的现实边界

K 线、标记价格和资金费并不自动提供“当时的强平结果”。至少还要冻结以下规则：合约乘数/计价方式、tick size、数量步长、初始与维持保证金档位、杠杆上限、手续费、资金费结算时点、强平费用和 ADL/保险基金处理。三家公开接口都能查询当前 instruments、风险档位或费率，但本次没有找到官方承诺的逐日历史快照。

因此首期应采用以下分层：

1. **价格练习**：只要求普通合约 K 线和最小可解释的成交模型；可使用较长历史。
2. **资金费练习**：只使用资金费归档完整且覆盖窗口的场景；跨天场景需核对每次结算。
3. **规则可核对的强平模拟**：使用标记价格、固定版本规则和费用资料都齐全的窗口；分钟内触发先后、盘口排队和真实强平执行单独标记为无法由这些数据完全还原。规则缺失时降级为“教学估算”，不显示为交易所精确复现。

这能避免把当前杠杆档位套在多年以前的行情上，再把误差归因到用户操作。

## 建议的最小下载与验证批次

不先全盘下载。以 BTCUSDT、ETHUSDT 的 `1m` 作为最小长期基准，在内存或缓存中聚合出 `1h`、`1d`；`1h`/`1d` 只抽样下载或对账，不为同一长期窗口重复存储：

- 普通合约 `1m` 基准，抽样核对官方 `1h`、`1d`；
- 标记价格 `1m` 基准，抽样核对可获得的更粗周期；
- 资金费覆盖窗口前后至少一个结算点；
- 普通成交或聚合成交仅取触发止损/止盈的短窗口。

每个文件保存来源 URL、抓取日期、交易所/产品类型、符号、时间区间、粒度、校验和和解析版本。检查点包括：时间戳是否连续、日线时区口径、K 线是否闭合、标记价格与普通价格的时间对齐、资金费结算时间是否落在窗口内、归档文件是否能重复下载得到同一 CHECKSUM。

若 1m K 线一根同时触及止损和止盈，仍不能从 OHLC 确认先后；只有更细成交/标记价格序列或预先固定的保守规则才能解释。即便有聚合成交，也不能还原真实盘口排队和未成交限价单。

## 文档声明、样本实测与未验证清单

### 厂商文档声明

- Binance 官方仓库声明 USD-M Futures K 线、trades、aggTrades 和 Futures 专用 mark/index/premium K 线归档；官方 REST 文档列出 K 线、标记价格、资金费历史。
- OKX REST 官方声明普通/标记价格历史 K 线最近几年、1s K 线最多 3 个月、资金费历史最多 3 个月；官方历史下载页另声明 candlestick 自 2023-07、funding rate 自 2022-03 起可批量获取，批量模块的 mark/index 独立覆盖、1m 粒度和下载权限尚未实测。
- Bybit 官方 REST 文档列出 K 线、标记价格 K 线、资金费历史和近期成交；网站声明可下载历史 OHLCV/trade 数据。

### 本轮项目内实测

- OKX 无账户/API key 取得 BTC/ETH 2024-01-01（UTC+8）各 1440 根普通 1m 归档、各 1440 根标记价格 1m 与各 3 条资金费，连续性和时间对齐通过；普通分钟汇总的 OHLC 及三种成交量均与官方日线一致。当前合约规格和逐仓保证金档位也可读取，但不是历史规则快照。详细 URL、SHA256 和字段差异见 [OKX 训练适配](./2026-10-19-okx-training-fit.md)。
- Binance 公共 ZIP 在无账户/API key 环境可下载，BTC/ETH 1m、BTC 2024 年 1 月资金费样本已取得；Binance REST 标记价格/资金费接口在当前地区 HTTP 451。
- 主 Agent 已完成上述离散样本的 CHECKSUM、时间连续性、1d 对账和旧窗口核对；这些结果不是 2020–2025 全覆盖验证，历史保证金档位、手续费和其他规则仍待核实。

### 尚未验证

- Binance 2020 起每个目标标的的 markPriceKlines 和 fundingRate 文件是否无缺口；
- Binance 旧窗口的历史保证金/风险档位、手续费和强平参数能否从官方资料恢复；
- OKX 更长窗口的普通/mark/资金费缺口、独立 mark/index 归档覆盖，以及其他日期和地区的访问/配额条件；本次样本的 1m 字段和无账户下载已验证；
- Bybit 下载站是否提供长期标记价格和资金费归档，以及文件字段和时间覆盖；
- 三家在用户所在地区的公开 API/归档可达性、限速和长期稳定性；
- 用 1m K 线与标记价格序列能否在选定窗口稳定判定止盈/止损先后。

## 对产品讨论的下一轮影响

用户已选择历史盲测和 1m–1d 粒度，并确认首期为 **OKX BTC/ETH USDT 永续、逐仓**。Binance 保留为独立备选。后续讨论持仓方式、下单风险交互与规则版本，不再重复询问历史/实时、周期、平台或已确认的合约范围。

这不是实现承诺。确认后才需要设计缓存目录、数据版本、规则快照和合约结算模型；本轮没有改代码、没有提交、没有推送。
