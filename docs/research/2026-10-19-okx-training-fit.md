# OKX 合约训练适配与 Binance 规则差异

日期：2026-10-19。状态：只读规则调研，仍处于方案期；没有合约引擎、训练会话、下单或账本操作。

本文只回答一个决策：用户未来实际交易使用 OKX 时，是否需要现在就把训练规则源切到 OKX。历史数据可用性另有数据源调研；本文不重复主 Agent 正在进行的 OKX REST 和归档探针。

## 结论

多空方向、净持仓/双向持仓、逐仓/全仓、标记价格风控、资金费结算、止损触发价和 reduce-only 都有可迁移的通用概念，但两家交易所的字段和边界不能直接互换。最需要隔离的是：

- OKX 的下单数量是合约张数，必须结合 `ctVal`、`ctValCcy`、`ctType`、`lotSz`、`minSz` 换算；Binance USDⓈ-M 的下单数量受 `LOT_SIZE` 的 `minQty`/`stepSize` 约束。
- 两家的维持保证金按各自定义的仓位规模分档；Binance USD-M 的名义金额档位与 OKX 的合约张数档位不能直接互换，杠杆限制和历史可追溯性也需分别核对。
- 两家都以标记价格参与清算风险判断，但清算引擎、部分/全部清算、费用和实际成交可能不同。
- 两家都收取多空之间的资金费，但 OKX 明确存在 8/4/2/1 小时等不同周期及 current-period/cross-period 机制；训练必须使用数据中的实际结算时间和公式版本。
- Binance 条件单的 `workingType` 在 `CONTRACT_PRICE` 与 `MARK_PRICE` 间选择；OKX 的 TP/SL 触发类型可选 `last`、`index`、`mark`。如果训练把止损触发价写死为“收盘价”，迁移时会产生行为差异。
- Binance 的 `reduceOnly` 不能在 Hedge Mode 直接发送；OKX API 只把显式 `reduceOnly` 适用于净持仓模式，而双向模式的关闭单默认具备减仓语义。

因此，**不必丢弃已经取得的 Binance 研究证据，但应现在就把 OKX 定为首期目标规则源**。当前仍无合约引擎，切换规则源的成本最低；主 Agent 已确认 OKX 普通/标记价格 `1m`、资金费、合约规格、档位和批量历史文件均可取得并解析。首期只支持同源 OKX；Binance 保留为独立候选和已取得证据，不与 OKX 数据混拼。

## 规则差异对照

| 主题 | Binance USDⓈ-M Futures | OKX SWAP/FUTURES | 对训练的影响 |
| --- | --- | --- | --- |
| 合约单位 | USDⓈ-M 是线性、以 USDT/USDC 结算的产品；下单 `quantity` 受交易规则中的 `LOT_SIZE`、`minQty`、`maxQty`、`stepSize` 约束 | `GET /api/v5/public/instruments` 返回 `ctVal`、`ctValCcy`、`ctType`、`lotSz`、`minSz`、`tickSz`；衍生品的 `lotSz`/`minSz` 单位是合约张数 | 内部不能把“1 张”或“1 quantity”当作统一单位。保存 `contracts`、`contract_value`、`notional` 和价格精度，入口按交易所换算 |
| 数量精度 | `LOT_SIZE` 决定数量最小值、最大值和步长；价格另受 `PRICE_FILTER`/`tickSize` 约束 | `lotSz`/`minSz` 决定张数步长与最小张数，`tickSz` 决定价格步长；不同合约的 `ctVal` 也可能不同 | 下单前要先量化到交易所步长，再计算名义价值；不能先用 BTC 数量四舍五入后直接当 OKX 张数 |
| 持仓模式 | `positionSide=BOTH` 表示 One-way，`LONG`/`SHORT` 表示 Hedge；`dualSidePosition` 是账户配置；`marginType` 区分 `ISOLATED`/`CROSSED` | `posMode` 为 `net_mode` 或 `long_short_mode`；`mgnMode` 为 `cross`/`isolated`；OKX 文档说明 Futures/SWAP 在组合保证金下只支持 net mode | 多空方向和逐仓概念可迁移，字段和切换前置条件不可直接迁移。训练场景必须记录 `exchange`、`pos_mode`、`margin_mode` |
| 维持保证金档位 | `Notional and Leverage Brackets` 返回名义区间、维护保证金率、累计项和最大初始杠杆；Binance 说明维护保证金按 bracket 计算 | `GET /api/v5/public/position-tiers` 返回衍生品档位信息，例如 `tier`、`maxSz`、`mmr`、`imr`、最大杠杆等 | 不能把 Binance 的 bracket 字段套到 OKX。需要按来源保存档位快照、适用合约和生效时间；两家官方接口都主要反映当前规则，不能假定能还原任意历史时点 |
| 强平参考价 | Binance 官方说明清算价和未实现盈亏基于 Mark Price；清算可能经过 Smart Liquidation/IOC，实际成交价可偏离显示的清算价 | OKX 官方说明 Mark Price 用于清算检查和未实现盈亏；官方清算 FAQ 说明维持保证金比率触发后，清算/减仓价由 Mark Price 决定，并按仓位档位处理 | 两家都可用 mark 序列做风险训练，但强平结果、部分清算、清算费用和成交滑点不能跨源复用。应将“触发风险”与“最终成交”分开 |
| 资金费 | USDⓈ-M `fundingRate` 返回费率、资金时间和关联 mark price；具体合约的结算间隔要以接口/合约信息为准 | OKX 官方说明通常 8 小时，部分合约为 1/2/4 小时；API 日志还区分 `current_period` 与 `next_period` 机制，历史响应有 `fundingTime`、`nextFundingTime`、`formulaType` 等字段 | 资金费不能只按固定 8 小时插值。按实际 `fundingTime` 结算，保存费率公式/周期字段；正负号的多空支付方向是通用概念 |
| 止损/止盈触发价 | Binance 条件单 `workingType` 可选 `MARK_PRICE` 或 `CONTRACT_PRICE`；`positionSide` 在 Hedge Mode 需要明确方向 | OKX TP/SL 的 `slTriggerPxType`/`tpTriggerPxType` 可选 `last`、`index`、`mark`；不同订单接口的参数约束要分别核对 | 触发价类型是订单语义的一部分。训练记录必须保存触发参考价与触发后订单类型，不能仅保存一个 stop price |
| reduce-only | Binance 新订单参数有 `reduceOnly`，文档说明 Hedge Mode 不能发送；`positionSide` 需按单向/双向填写 | OKX `reduceOnly` 对 Futures/SWAP 适用于 net mode；官方文档说明双向模式的关闭单具有减仓语义 | “平仓不会反向开仓”是目标语义，具体参数和超量处理不同。应先按模式验证，再把统一的 `close_only` 映射到交易所字段 |

## 逐项说明与官方来源

### 1. 合约张数和数量精度是最早会出错的边界

OKX 的公共 instruments 文档把衍生品 `lotSz` 和 `minSz` 定义为合约数量，`ctVal` 表示每张合约的价值，`ctType` 区分线性和反向合约。也就是说，用户说“买 0.01 BTC”时，OKX 下单层可能需要先换算成若干张；这个换算不能由 Binance 的 `quantity` 精度规则替代。

Binance USDⓈ-M 的公开交易规则则通过 `exchangeInfo` 返回 `LOT_SIZE`，其中 `minQty`、`maxQty` 和 `stepSize` 直接约束订单 `quantity`。两家都还有价格 `tickSize`，所以金额、数量和价格应在内部保存为高精度数值，最后一步才按目标交易所量化。

- [OKX Get instruments](https://www.okx.com/docs-v5/en/#rest-api-public-data-get-instruments)
- [OKX Contract specifications in API guide](https://www.okx.com/docs-v5/en/)
- [Binance Exchange Information](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information)
- [Binance Common Definition: LOT_SIZE](https://developers.binance.com/docs/derivatives/usds-margined-futures/common-definition)
- [Binance USDⓈ-M contract specifications](https://www.binance.com/en/support/faq/detail/360033161972)

### 2. 逐仓、全仓、单向和双向可以抽象，但切换边界不能假设相同

Binance 的订单使用 `BOTH`、`LONG`、`SHORT` 表达单向或 Hedge Mode 的持仓方向，并有 `ISOLATED`/`CROSSED` 保证金类型。OKX 将持仓模式写成 `net_mode`/`long_short_mode`，订单和持仓再使用 `mgnMode=cross|isolated`。OKX 官方说明组合保证金模式的 FUTURES/SWAP 只支持 net mode；因此“支持双向持仓”不是所有账户模式下都成立。

- [OKX Set position mode](https://www.okx.com/docs-v5/en/#rest-api-account-set-position-mode)
- [OKX Place order](https://www.okx.com/docs-v5/en/#rest-api-trade-place-order)
- [OKX API guide: account/position mode](https://www.okx.com/docs-v5/en/)
- [Binance Change Position Mode](https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/Change-Position-Mode)
- [Binance Change Margin Type](https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/Change-Margin-Type)
- [Binance New Order](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Order)

### 3. 档位决定强平边界，不能只保存用户输入杠杆

Binance 官方说明维护保证金采用 bracket setup；API 的 leverage-bracket 返回名义规模和维护保证金相关字段。OKX 有独立的 position-tiers 接口。两者都说明了“当前规则如何查”，但这不等于为每个历史时点提供了完整档位快照。训练数据版本至少要记录合约规格、档位快照、获取时间和规则来源。

- [Binance Notional and Leverage Brackets](https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/Notional-and-Leverage-Brackets)
- [Binance Leverage and Margin of USDⓈ-M Futures](https://www.binance.com/en/support/faq/detail/360033162192)
- [OKX Get position tiers](https://www.okx.com/docs-v5/en/#rest-api-public-data-get-position-tiers)

### 4. 标记价格相同地重要，清算过程并不相同

Binance 官方清算说明明确以 Mark Price 作为清算触发参考，并说明 Smart Liquidation、IOC 和波动时实际清算成交可能偏离预先显示的清算价。OKX 官方帮助页也明确 Mark Price 用于清算检查和未实现盈亏，清算 FAQ 说明触发后按维护保证金档位进行强制减仓。两家都不能用 1m OHLC 单独还原真实盘口中的清算成交。

- [Binance Futures Liquidation Protocols](https://www.binance.com/en/support/faq/detail/360033525271)
- [Binance What Are Mark Price and Price Index in USDⓈ-M Futures](https://www.binance.com/en/support/faq/detail/360033525071)
- [OKX Mark price and TP/SL trigger prices](https://www.okx.com/en-eu/help/okx-x-perps-eea-mark-last-index-price)
- [OKX Forced Liquidation FAQ](https://www.okx.com/en-eu/help/liquidation-faq)

其中 EEA 帮助页仅作为标记价格和清算概念的参照；具体 USDT 永续的规则仍应以所选市场的合约说明、API 和档位快照核对，不能把地区产品的全部处理方式视为通用规则。

### 5. 资金费和触发价必须按源保存

Binance 的 funding history 能提供 `fundingRate`、`fundingTime` 和 `markPrice`。OKX 的 funding 文档说明不同合约可能使用不同结算周期，官方日志还记录了 funding 公式版本和 current-period/cross-period 机制变化。OKX 的止盈止损接口则明确把 last/index/mark 作为独立触发类型。训练事件应保存“哪一种价格触发了什么订单”，而不是只保存最终成交结果。

- [Binance Get Funding Rate History](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Get-Funding-Rate-History)
- [Binance New Order](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Order)
- [OKX Get Funding Rate History](https://www.okx.com/docs-v5/en/#rest-api-public-data-get-funding-rate-history)
- [OKX API changelog: funding formula and period](https://www.okx.com/docs-v5/log_en/)
- [OKX Place Algo Order](https://www.okx.com/docs-v5/en/#rest-api-trade-place-algo-order)

### 6. reduce-only 是迁移时容易漏掉的执行约束

Binance 的公开下单文档把 `reduceOnly` 定义为只能减少仓位，并规定 Hedge Mode 不能发送该参数；双向模式需要用 `positionSide` 明确平哪一边。OKX 的下单文档把 `reduceOnly` 限定在 Futures/SWAP 的 net mode，官方说明 long/short mode 的关闭单默认具备 reduce-only 语义。训练系统可以把它们统一为 `close_only`，但必须保留原始交易所模式与订单参数，避免平仓变成反向开仓或被拒单。

- [Binance New Order](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Order)
- [Binance New Algo Order](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Algo-Order)
- [OKX Place order](https://www.okx.com/docs-v5/en/#rest-api-trade-place-order)
- [OKX Basic Order Types: reduce-only](https://www.okx.com/en-eu/help/x-basic-order-types)

## 现在切换与晚期迁移的代价

### 现在切换规则源

现在切换的优点是：还没有合约引擎，也没有账本和用户历史需要迁移；可以直接把 OKX 的 `ctVal`、张数、position tiers、mark/index/last 触发价和 funding 字段作为第一版规则输入。剩余工作是核对整日/长期字段覆盖，Binance 只作为独立候选证据保留。

### 先用 Binance、后迁移 OKX

如果只做价格和方向练习，先用 Binance 不会阻碍产品推进。真正的迁移成本出现在已经把 Binance 的 `quantity` 当成统一数量、把 bracket 公式写进引擎、把 stop price 默认理解为 last/contract price、或把 funding 固定为 8 小时以后。那时迁移不是换数据源，而是重做数量换算、档位、触发事件、清算和回放结果。既然 OKX 的目标数据入口已通过小窗口验证，现在切到 OKX 规则源比实现完成后再迁移更合适。

所以建议把迁移边界放在“实现规则引擎之前”：数据缓存和事件模型可以参考 Binance 样本，但规则配置必须包含交易所、合约规格、数量单位、保证金模式、持仓模式、触发价类型和资金费周期。现在以 OKX 同源数据和规则训练；Binance 证据保留为独立的 Binance 场景，不与 OKX 场景混合，首期不同时支持两家。

## 主 Agent 实测

主 Agent 已完成第一轮 OKX 公开 REST 与归档实测；本节只记录证据边界，不在本轮重复探针：

- 无账户、无 API key：2024-01-01 的 `BTC-USDT-SWAP`、`ETH-USDT-SWAP` 普通 `1m` 与 mark `1m` REST 均返回 `code=0`。普通 `1m` REST 样本各 100 条连续且无重复；mark `1m` 通过 15 页分页取得整日 1440 条，时间完整对齐且 `confirm` 全为 `1`。
- BTC instrument 样本：`ctVal=.01 BTC`、`lotSz=.01` 张、`tickSz=.1 USDT`；这些字段足以证明 OKX 的下单数量不能直接沿用 Binance 数量，但仍需按目标合约逐一读取。
- BTC isolated position tiers 返回 99 档，首档样本为 `maxSz=1000` 张、`mmr=.004`；这是当前规则快照，不是历史档位。
- BTC/ETH 各取得 3 条资金费记录；ETH 样本的实际 `funding_time` 相对名义整点偏移 1 秒，因此训练必须保留原始时间，不能按名义整点修正。
- 批量 `market-data-history` 的 candles（module 2）和 funding（module 3）均返回 `code=0`，且 2024-01-01 ZIP 已实际下载、解析成功，无登录要求。candles ZIP 为 4,731,674 B、SHA256 `d8259111f5c48bfa893ad54496bd0d6c338ce10e3df3e3777fa484f78c06d593`；funding ZIP 为 7,159 B、SHA256 `f679ff98745b8eebf9ed8e74d9254994bc739101f79ff8be4190ddfbb7e91cec`。样本 URL：[candles ZIP](https://static.okx.com/cdn/okex/traderecords/candlesticks/daily/20240101/allswap-candlesticks-2024-01-01.zip?v=1001)、[funding ZIP](https://static.okx.com/cdn/okex/traderecords/swaprates/daily/20240101/allswap-fundingrates-2024-01-01.zip?v=1001)。
- 两个合约各有 1440 条普通 `1m` 归档记录，连续、无重复，时间范围为 `1704038400000..1704124740000`，对应 2024-01-01 的 UTC+8 整日。普通归档的 `confirm` 样本全为 `0`，而同历史 REST 样本为 `1`。进一步核对两个合约首根分钟：同时间戳的 OHLC、张成交量、币成交量与计价币成交量均一致，只有 `confirm` 不同；这是已观测到的来源字段口径差异，不能直接用 REST 的 `confirm=1` 规则过滤整份历史归档，也不能默默改写原字段。
- `dateRangeStart=1704038400000` 对应本次批量接口返回的 UTC+8 归档日期边界；不能因此泛化所有模块和日期的时区。两个合约整日普通 1m 汇总的 OHLC、张成交量、币成交量、计价币成交量均与 REST 官方 `1D` 同日数据完全一致，官方日线 `confirm=1`。本轮没有本地原始文件残留。

当前结论是“OKX 已具备首期同源训练的入口，且 2024-01-01 BTC/ETH 普通与 mark 数据已完成整日样本验证；字段口径和长期完整性仍按窗口验收”，不是“已证明所有年份、所有合约和实际清算成交都完整可还原”。

## 产品建议与第一层待确认问题

建议现在冻结一个交易所无关的训练概念层，并把 OKX 作为目标规则源：订单方向、持仓方向、保证金模式、标记价格、资金费事件、触发价类型、close-only 语义都保留；每个交易所的数量、档位和订单字段通过适配层进入。这样可以保留 Binance 的已取得研究证据，又不会把 OKX 迁移推迟到引擎完成以后；首期产品只支持 OKX 同源训练。

用户随后在 Q4–Q9 均选 A，确认首期 **OKX BTC/ETH USDT 永续（`SWAP`）、逐仓（`isolated`）、单向净持仓（`net_mode`）、允许无自动止损但清楚展示风险、手动追加但不自动补保证金、核对并保存固定规则版本**。具体规则参数尚需核对；新增默认配置与首期功能范围见 [第一版默认方案](./2026-10-19-crypto-default-plan.md)，选择过程见 [加密方向讨论](./2026-10-19-crypto-followup.md)。

本轮没有修改代码、没有创建合约引擎、没有操作交易或账本。
