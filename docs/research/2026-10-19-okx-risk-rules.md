# OKX BTC/ETH USDT 永续：逐仓风险、费用与执行参数核对

日期：2026-10-19。状态：只读官方规则调研，供实施顺序和验收标准使用；没有修改业务代码、训练账本或交易账户。

补充核对与确认：强平接管成本、余额冲突及已确认教学模型，见[接管结算规范](./2026-10-19-okx-liquidation-settlement-proposal.md)。首版采用 `isolated-full-loss-teaching-v1`，P0-B 决策已关闭；P1 纯计算已实现验证，完整事件/事务/UI 未接入，不代表实盘精确结算已闭合。

## 范围与排除

本记录只针对 OKX `BTC-USDT-SWAP`、`ETH-USDT-SWAP`，USDT 本位、逐仓、单向净持仓。这里的“保证金”是合约逐仓保证金，不是现货借贷 `MARGIN`。

以下页面不作为本方案的规则来源：

- `help/iv-isolated-margin-mode` 一类页面主要描述现货/借贷隔离模式，不能拿来计算 USDT 永续的合约强平。
- EEA `X-Perps` 页面是地区产品；即使其中的标记价概念相同，也不能替代全球 `SWAP` 的合约档位和清算规则。
- 交易所 Demo 或界面显示值只能用于操作核对，不能证明历史 1 分钟数据能还原真实盘口成交。

## 结论

1. OKX USDT 永续的下单大小是合约张数。当前公开快照中，BTC 每张 `0.01 BTC`，ETH 每张 `0.1 ETH`，`ctMult=1`；`lotSz`/`minSz` 均为 `0.01` 张，价格步长分别为 `0.1` 和 `0.01` USDT。名义价值应使用 `contracts × ctVal × ctMult × price`，不能把 BTC/ETH 数量直接当成 `sz`。
2. 逐仓档位按该合约、该方向的总持仓张数选择一行 `minSz..maxSz`；当前快照显示 BTC 1 档 `0..1000` 张、`mmr=.004`，2 档 `1000.01..5000` 张、`mmr=.005`；ETH 1 档 `0..5000` 张、`mmr=.004`，2 档 `5000.01..10000` 张、`mmr=.005`。官方公式以“所选档位的 `mmr` × 整个持仓名义价值”计算维持保证金；公开接口没有提供 lower-tier deduction/累计扣减字段。因此首版按总张数选档后对整仓套该档 `mmr`，不把它拆成“前一档部分 + 当前档剩余部分”。若未来官方规则或接口出现明确扣减字段，必须升级规则版本和黄金算例。
3. 未实现盈亏和强平检查使用 mark price；last price 是最新成交价，主要用于图表与可选的止盈止损触发。OKX 公开接口把 `last`、`index`、`mark` 作为独立触发参考价，训练记录必须保存触发类型。
4. 交易费按实际成交的 maker/taker 率计收，和杠杆无关。官方示例的 Lv1 USDT 永续费率为 maker `0.02%`、taker `0.05%`；实际账户费率可能因 VIP、活动或地区不同而变化。首版应把这组数作为可见、可替换的固定训练费率版本，而不是宣称它是所有账户的当前费率。
5. 资金费按历史记录中的原始 `fundingTime` 结算。USDT 永续资金费 = 结算时仓位价值 × 已实现资金费率；仓位价值 = 张数 × 合约面值 × 合约乘数 × 结算 mark price。正费率由多头支付，负费率由空头支付；逐仓时从该持仓的逐仓保证金扣除或记入。不能按固定 8 小时插值，也不能用当前预测费率替换历史 `realizedRate`。
6. OKX 官方没有一个适用于所有历史窗口的“滑点参数”。滑点取决于盘口、数量、价格冲击和延迟。没有历史 L2/逐笔盘口时，固定滑点只能是训练模型，必须单独版本化、可见，并和手续费分开；不能把它称作 OKX 实盘执行。

## 官方公式与训练字段

### 合约规格和数量

`GET /api/v5/public/instruments?instType=SWAP&instId=...` 返回 `ctVal`、`ctMult`、`ctType`、`lotSz`、`minSz`、`tickSz` 等字段。当前快照见 `docs/research/okx-rule-snapshots/2026-10-19-public-rules.json`。

对线性 USDT 合约，令：

```text
N = contracts × ctVal × ctMult       # 标的数量，例如 BTC
V(P) = N × P                          # USDT 名义价值
```

每一笔订单和持仓都保存 `contracts`、`ctVal`、`ctMult`、`notional`、`priceTick`、`qtyStep`；先按交易所步长取整，再计算保证金和费用。

来源：[OKX Get instruments](https://www.okx.com/docs-v5/en/#rest-api-public-data-get-instruments)。

### Mark、Last 与浮动盈亏

OKX 说明合约 mark price 是指数价加移动平均 basis，用来计算未实现盈亏并减少异常成交导致的非必要强平；last price 是订单簿最新成交价。USDT 永续浮动盈亏为：

```text
long  PnL(mark) = N × (mark - avgOpen)
short PnL(mark) = N × (avgOpen - mark)
```

来源：[Mark price and Last price](https://www.okx.com/en-us/help/ii-mark-price-and-last-price)、[Futures PnL calculation rules](https://www.okx.com/en-us/help/futures-pnl-calculation-rules)。

### 初始保证金、维持保证金和风险率

对选定杠杆 `L` 和持仓 mark price `P`：

```text
requiredInitialMarginAtMark = N × P / L
maintenanceMargin = N × P × mmr(tier)
initialAllocationAtOpen = filledQuantity × fillPrice / L
marginBalance = persisted isolated ledger balance
marginRatio = (marginBalance + unrealizedPnL)
               / [N × mark × (mmr(tier) + liquidationFeeRate)]
```

`requiredInitialMarginAtMark` 是当前价格下的保证金需求指标，不是账本里已划入资金的余额；不能每次 mark 变化都重置 `marginBalance`，否则会凭空增减资金。初次划入按实际成交和选定杠杆计算，余额随后只随明确的加减仓分配/释放、手动追加、费用和资金费流水改变。单纯 mark 变化只改变浮盈亏和风险需求。手动追加不增加张数、不重置入场价、不凭空增加账户权益。逐仓资金费直接从该仓余额扣除或记入，见 [官方机制的 Funding Fee Collection/Distribution 段](https://www.okx.com/help/perps-funding-fee-mechanism)。普通手续费资金桶采用的教学约定需在版本中另标，不从资金费规则推断。

官方强平规则说明，当维持保证金率达到 100% 或更低时，系统会先取消/拒绝需要额外保证金的订单并进入强平流程；可能部分减仓，也可能全部接管，且涉及强平 taker 费和清算成本。首版采用已确认的教学全额接管，固定 taker 率用于风险分母与参考费用拆分；不把拆分另行扣款，也不以 1 分钟 OHLC 声称还原真实成交、clearance 和保险基金处置。

来源：[Futures PnL calculation rules](https://www.okx.com/en-us/help/futures-pnl-calculation-rules)、[Tiered maintenance margin ratio rules](https://www.okx.com/help/v-tiered-maintenance-margin-ratio-rules)。

### 估算强平价

按 OKX 的 USDT 永续逐仓估算式，令 `M=marginBalance`、`P0=avgOpen`、`N=contracts×ctVal×ctMult`、`f=feeRate`、`r=mmr(tier)`：

```text
long  estLiq = (M - N × P0) / [N × (r + f - 1)]
short estLiq = (M + N × P0) / [N × (r + f + 1)]
```

这只是基于当前档位和费用的估算。真实系统会随 mark、资金费、部分成交、档位变化、接管和清算成交而变化；界面应同时显示“估算值”和“触发依据”，不能把估算价当成保证成交价。

## 档位：按张数选档，不做未经证实的累计扣减

OKX 公开 `position-tiers` 响应给出 `minSz`、`maxSz`、`mmr`、`imr`、`maxLever`。官方帮助页明确，逐仓永续/交割合约按每个方向的合约数量单独确定档位；官方 PnL 公式把维持保证金写成整仓数量乘该档位 MMR。当前公开快照没有“maintenance margin deduction”字段，也没有官方公式要求把相邻档位分段累加。

因此规则适配层应：

1. 对单向净持仓取 `abs(contracts)`；
2. 找到唯一满足 `minSz <= abs(contracts) <= maxSz` 的档位；
3. 用该行的 `mmr`、`imr`、`maxLever` 作为整笔持仓的参数；
4. 持仓跨档时重新选择整仓档位，记录 `tierBefore`、`tierAfter`；
5. 在规则版本中保存原始档位 JSON 和抓取时间。

不能把 1,500 BTC 张拆成“前 1,000 张按 0.4%，后 500 张按 0.5%”，除非未来官方资料明确提供该累计公式。

## 手续费、强平费与资金费

### 交易手续费

OKX 说明手续费由实际执行身份决定：立即吃单通常是 taker；限价单若立即成交也可能是 taker，只有进入订单簿并被动成交才是 maker。USDT 永续的成交费公式为：

```text
tradingFee = feeRate × (contracts × ctMult × ctVal × fillPrice)
```

官方 FAQ 的 Lv1 示例为 maker `0.02%`、taker `0.05%`，100 张 BTC 合约、20,000 USDT 成交价时分别是 4 USDT 和 10 USDT。首版建议：

- 规则草案 `okx-usdt-swap-training-2026-10-19-v1` 固定 `makerRate=0.0002`、`takerRate=0.0005`，尚未作为业务运行配置启用；
- 每个 fill 保存 `liquidityRole`（maker/taker）、`feeRate`、`fee`、`feeCcy`；
- 市价单默认 taker；限价单只有在模拟撮合判定“挂单后成交”时才使用 maker；
- 普通平仓逐 fill 计费；教学强平合计结算一次，taker 费仅作参考拆分，不能清零保证金后再向仓外扣一笔；
- 若以后要贴合用户账户，另建费率版本，不改写旧会话。

实际费率以账户的 `GET /api/v5/account/trade-fee` 或交易页登录后显示为准；公开/未登录页面的费率不能证明用户账户费率。

来源：[Trading Fee Rules FAQ](https://www.okx.com/en-us/help/trading-fee-rules-faq)、[Get fee rates](https://www.okx.com/docs-v5/en/#rest-api-account-get-fee-rates)。

### 资金费

历史 funding 核心字段是合约、原始结算时间和已结算费率。REST 若有 `realizedRate` 则优先使用；公开归档只有 `funding_rate/funding_time` 时保留原值并标明来自已结算历史归档，不能与实时预测混用。`formulaType/method` 等元数据只保存来源实际提供的值，缺失时标记未知，不拿当前值补到旧记录里：

```text
fundingNotional = contracts × ctVal × ctMult × markAtFunding
fundingFee = fundingNotional × settledRateFromSource
```

正费率：多头支付、空头收取；负费率相反。按原始 `fundingTime` 的持仓状态结算，逐仓支付从该持仓保证金扣除，收款计入该持仓保证金。历史文件不一定提供结算瞬间 mark：缺少精确值时，首期使用事件前最近一根已完成分钟的 mark close 作教学代理并留标记，不能用事件之后才形成的分钟收盘价；事件前后 1ms 的模拟处理顺序也要冻结，不能声称恢复了真实毫秒成交路径。

OKX 公开说明结算频率可为 8、4、2 或 1 小时，并可因市场条件自动调整；2025 年还分批切换过 funding 公式，BTC/ETH 属于 2025-04-24 批次。因此不能固定按 8 小时、整点或当前公式重算旧费率。`method=current_period|next_period`、`formulaType=noRate|withRate` 必须作为数据字段，而不是丢弃。

来源：[Perpetual funding fee mechanism](https://www.okx.com/en-sg/help/perps-funding-fee-mechanism)、[Funding fee FAQ](https://www.okx.com/en-gb/help/funding-fees-for-perpetual-contracts-faq)、[Funding formula change announcement](https://www.okx.com/en-us/help/okx-to-change-the-funding-rate-formula-for-perpetual-futures)、[Get funding rate history](https://www.okx.com/docs-v5/en/#rest-api-public-data-get-funding-rate-history)。

## 滑点：只能作为独立教学参数

OKX 官方规则定义费用和价格触发类型，但没有为所有订单、数量和历史时点提供一个固定滑点率。当前训练只有 1 分钟 OHLC/mark 时：

- 市价开/平、止损/止盈触发后的市价退出：按默认下一可执行分钟开盘价，再施加方向性滑点；
- 限价单：价格触及只表示“可进入模拟成交判定”，不保证真实盘口排队成交；成交价按冻结的分钟模型；
- 强平：用 mark 判断触发，撤单复核后按已确认模型全额接管；不生成真实清算成交价，不在合计结算上再加滑点费；
- 滑点不是现金费用，不能在扣滑点后又把同一差额计入手续费。

整合后的参数为 `slippageBps=0`（公式控制组）、`2`（默认教学组，0.02%）、`10`（压力验收组，0.10%）。这是本地模型假设，非 OKX 官方固定滑点或历史百分位校准；盘口样本和选择依据见 [参数与实施验收计划](./2026-10-19-okx-implementation-and-acceptance.md)。

## 可用于数值验收的黄金算例

下列算例使用当前公开快照的 BTC 规格和档位、固定训练费率 `f=0.0005`，价格仅为计算输入，不表示市场预测。

### BTC 一档，多头/空头与手动追加

参数：`ctVal=0.01 BTC`、`ctMult=1`、100 张、均价 60,000、5 倍杠杆、档位 1 `mmr=.004`。下列是给定保证金余额的公式单测，不是默认 10,000 USDT 账户的完整开仓流程；该名义仓位需要 12,000 USDT 保证金，另需费用。`M=12,000` 是给定余额，实际成交费用等已另行处理。

```text
N = 100 × .01 × 1 = 1 BTC
notional = 1 × 60,000 = 60,000 USDT
initialMargin = 60,000 / 5 = 12,000 USDT
maintenanceMargin = 60,000 × .004 = 240 USDT

long  estLiq ≈ 48,216.98 USDT
short estLiq ≈ 71,677.45 USDT
```

手动追加 2,000 USDT 后，仓位和均价不变：

```text
marginBalance = 14,000 USDT
long  estLiq ≈ 46,207.94 USDT
short estLiq ≈ 73,668.49 USDT
```

验收应确认追加只改变逐仓余额和强平距离，不改变张数、名义价值、已实现盈亏或账户总权益。

### BTC 二档，跨档选择

参数：1,500 张、均价 60,000、5 倍杠杆。当前快照应选择 BTC 档位 2（`1000.01..5000`、`mmr=.005`、`maxLever=66.66`）：

```text
N = 1,500 × .01 = 15 BTC
notional = 900,000 USDT
initialMargin = 180,000 USDT
maintenanceMargin = 900,000 × .005 = 4,500 USDT
```

这里的黄金断言是“整仓使用档位 2 的 0.5%，维持保证金为 4,500 USDT”。若实现得到 3,900 USDT（1,000 张按 0.4% 加 500 张按 0.5%），那是未经官方文档证实的分段累计算法，应先阻止合入并升级规则核对。

### 资金费算例

100 张 BTC、mark 60,000、`realizedRate=0.0001`：

```text
fundingNotional = 100 × .01 × 60,000 = 60,000 USDT
fundingFee = 60,000 × .0001 = 6 USDT
```

多头持仓时扣 6 USDT，空头持仓时收 6 USDT；若仓位在原始 `fundingTime` 前已平仓，则为 0。资金费不得按当前页面的下一期预测值代替。

### 费用与滑点算例

100 张 BTC、成交价 20,000：名义成交额 20,000 USDT；taker 手续费为 10 USDT，maker 手续费为 4 USDT。若模拟市价开多使用下一分钟开盘 20,000、`slippageBps=2`，成交价是 20,004 USDT，手续费应随实际成交价重算为 10.002 USDT；滑点造成的价格差另记执行成本，不再作为第二笔手续费扣除。

## 实施顺序与验收重点

### 实施顺序

统一以[实施计划 P1–P6](./2026-10-19-okx-implementation-and-acceptance.md)为准：独立纯计算（含一次接管结算）→ BTC/ETH 冻结小场景 → 分钟执行 → 现有会话/账本事务 → 界面与差异说明 → 扩大数据池。成交费、资金费和接管合计分别记录，参考费用拆分不单独入账；恢复与复练冻结版本。本轮仅更新文档。

### 最重要的验收边界

- 1,000 张与 1,000.01 张 BTC 分别落在档位 1/2；5,000 与 5,000.01 同理；ETH 使用自己的档位边界，不能共用 BTC 档位。
- 多头 mark 上升、空头 mark 下降时 PnL 符号正确；last 变化但 mark 不变时，强平风险不应随 last 直接改变。
- 手动追加 2,000 USDT 只改变 margin balance 和估算强平价；不改变 contracts、avgOpen、notional、账户权益。
- fundingTime 前后 1ms 的持仓状态决定是否结算；原始时间、`realizedRate`、`formulaType`、`method` 可追溯。
- 交易费按 fill 的 maker/taker 角色计算；同一限价单部分 maker/部分 taker 时逐 fill 计费，不能按订单类型一刀切。
- 资金费、普通手续费、滑点和教学接管分项展示且只记一次；接管 taker 参考拆分与实际普通平仓费分清，完成 L01–L10 与 A08/A14。
- 规则版本改变后旧会话结果不重算；公开快照缺字段或跨档公式不确定时，场景应标记“教学近似/不可精确复现”，不能伪装成交易所逐笔执行。

## 可靠性与未决边界

P0-B 已通过用户接受独立教学模型的路径关闭；官方精确逐仓结算仍未闭合，依据与冲突详见补充规范。未核实的 clearance 不设为 0；不采用“mark 普通平仓并返还余款”冒充已核实接管，也不把教学手续费拆分当实盘账单。后续功能仍需实现与验收才能标为教学强平闭环通过。

已可靠核实：OKX 官方的线性 USDT 永续 PnL、初始/维持保证金、逐仓 margin balance、估算强平价、mark/last 定义、maker/taker 费用、资金费基数/方向/逐仓扣款、资金费周期动态调整，以及当前 BTC/ETH 公开规格和档位快照。

需要保留为教学近似：历史每一分钟的完整盘口与排队、订单冲击、清算接管价、清算 clearance fee 的逐笔金额、保险基金何时介入、历史任意日期的档位版本。首版可以做可解释的规则化模拟，但不能说“1m 完全还原实盘”。

## 主要官方来源

- [OKX Futures PnL calculation rules](https://www.okx.com/en-us/help/futures-pnl-calculation-rules)
- [OKX Mark price and Last price](https://www.okx.com/en-us/help/ii-mark-price-and-last-price)
- [OKX Tiered maintenance margin ratio rules](https://www.okx.com/help/v-tiered-maintenance-margin-ratio-rules)
- [OKX Trading Fee Rules FAQ](https://www.okx.com/en-us/help/trading-fee-rules-faq)
- [OKX Perpetual funding fee mechanism](https://www.okx.com/en-sg/help/perps-funding-fee-mechanism)
- [OKX Perpetual Futures Funding Fee FAQ](https://www.okx.com/en-gb/help/funding-fees-for-perpetual-contracts-faq)
- [OKX funding formula change announcement](https://www.okx.com/en-us/help/okx-to-change-the-funding-rate-formula-for-perpetual-futures)
- [OKX V5 API guide: public position tiers](https://www.okx.com/docs-v5/en/#rest-api-public-data-get-position-tiers)
- [OKX V5 API guide: funding history](https://www.okx.com/docs-v5/en/#rest-api-public-data-get-funding-rate-history)
- [OKX V5 API guide: trade fee](https://www.okx.com/docs-v5/en/#rest-api-account-get-fee-rates)
