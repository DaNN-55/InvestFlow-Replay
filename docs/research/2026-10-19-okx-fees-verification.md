# OKX BTC/ETH USDT 永续：规则、手续费与滑点核对

日期：2026-10-19（Asia/Shanghai）。状态：规则核对稿，供合约训练实施设计使用；未改业务代码、账本或交易接口。

补充核对与确认：减仓成本类别已有直接官方说明，精确逐仓结算及余额条件仍有缺口；用户已接受[保守教学接管规范](./2026-10-19-okx-liquidation-settlement-proposal.md)，正式版本 `isolated-full-loss-teaching-v1`。P0-B 决策关闭，P1 纯计算已验证、完整执行未启用；不将参考费用拆分冒充实盘账单。

本文件只覆盖首期已确认范围：`BTC-USDT-SWAP`、`ETH-USDT-SWAP`、USDT 本位、逐仓、单向持仓。公开资料从 OKX 页面和公开 API 读取，未登录账户、未调用私人费率接口，也没有把公开页面的费率当作用户账户的实时费率。

## 结论

1. `0.02% maker / 0.05% taker` 目前仍有 OKX 官方公开依据，可作为普通用户（LV1/Regular）USDT 永续的训练 baseline；它不是用户实际费率的确认。OKX 明确说登录后显示的账户费率可能不同，费率还受地区、VIP/费组和产品可用性影响。
2. USDT 永续的成交手续费公式已明确：`手续费 = 张数 × 合约面值(ctVal) × 成交价 × 费率`。开仓和关仓没有另一套公式，均按实际成交数量和成交价计费，成交时收取并以 USDT 结算。
3. maker/taker 由实际撮合结果决定。市价单通常是 taker；普通限价单如果立即吃掉订单也是 taker，只有进入订单簿并在之后被撮合才是 maker。限价单不能一律按 maker 费率。
4. 强平时要把普通用户主动平仓的成交手续费和强平手续费分开记录。OKX 公开资料明确强平手续费按当前等级的 taker 费率计算，也说明可能另收覆盖清算期间市场波动、滑点和部分清算损失的 `liquidation clearance fee`；后者不是一个对所有用户固定公开的 BTC/ETH 数值。
5. 资金费不是手续费。它在永续结算点由多空之间互付，公式是 `持仓价值 × 资金费率`；正费率通常多头付空头，负费率相反。训练账本必须分开记录。
6. OKX 官方没有为历史盲测提供一个固定的“滑点百分比”。官方只说明市价单按订单簿可用价格成交、最终成交价不保证，止盈止损触发后也可能因快速或低流动性市场而劣于触发价。历史训练的滑点应来自冻结的数据/撮合模型版本；具体盘口测量由主 Agent 的公开数据探针负责，本文件不重复该探针。

## 官方来源与资料边界

| 事实 | 官方来源（读取日 2026-10-19） | 厂商声明与实测边界 |
| --- | --- | --- |
| 普通用户期货费率 0.0200% / 0.0500%，BTC-USDT、ETH-USDT 在 Group 1 | [Updates to Global Fee Framework](https://www.okx.com/en-us/help/updates-to-global-fee-framework)（页面列出 Futures Markets、Regular user、Group 1） | 页面是公开参考表，且注明并非所有地区可用；未登录，不代表本账户费率。 |
| LV1 费率、USDT 永续公式、开关仓均按成交计费 | [How are futures trading fees calculated](https://www.okx.com/en-eu/help/how-to-calculate-the-contract-transaction-fee)（2026-08-26 更新）和 [Trading Fee Rules FAQ](https://www.okx.com/en-us/help/trading-fee-rules-faq)（2026-09-09 更新） | 这是规则说明，不是本地撮合实测；账户费率应以登录后的 My trading fees 为准。 |
| maker/taker 按实际是否立即撮合决定 | [Trading Fee Rules FAQ](https://www.okx.com/en-us/help/trading-fee-rules-faq) | 公开说明确认分类逻辑；历史 K 线没有真实排队/盘口，训练只能采用显式模拟口径。 |
| 合约面值、最小张数、tick size | [BTC-USDT-SWAP public instruments](https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=BTC-USDT-SWAP)、[ETH-USDT-SWAP public instruments](https://www.okx.com/api/v5/public/instruments?instType=SWAP&instId=ETH-USDT-SWAP) | 公开 API 实测读取到当前配置；本项目另保存了 [2026-10-19 规则快照](./okx-rule-snapshots/2026-10-19-public-rules.json)；这是当前快照，不是每个历史日期的规则恢复。 |
| USDT 永续 PnL、初始/维持保证金、估算强平价 | [Futures PnL calculation rules](https://www.okx.com/en-us/help/futures-pnl-calculation-rules) | 公式可作为训练规则版本的依据；具体档位仍需绑定 position-tiers 快照。 |
| 逐仓档位和 MMR | [public position-tiers API](https://www.okx.com/api/v5/public/position-tiers?instType=SWAP&uly=BTC-USDT&tdMode=isolated)（另取 `ETH-USDT`）及 [Tiered maintenance margin ratio rules](https://www.okx.com/en-us/help/v-tiered-maintenance-margin-ratio-rules) | API 当前公开快照能给 `imr/mmr/maxSz`；页面说明 OKX 可调整档位，不能把旧快照冒充历史制度。 |
| 强平 taker fee、可能的 clearance fee | [Tiered maintenance margin ratio rules](https://www.okx.com/en-us/help/v-tiered-maintenance-margin-ratio-rules)、[Trading Fee Rules FAQ](https://www.okx.com/en-us/help/trading-fee-rules-faq) | taker 费率公式有依据；clearance fee 可能存在，但公开资料没有给出本训练场景可直接套用的固定用户数值。 |
| 资金费与交易手续费的区别 | [Trading Fee Rules FAQ](https://www.okx.com/en-us/help/trading-fee-rules-faq) | 公式和结算方向有依据；历史资金费数据的时间点和费率由数据源单独核验。 |
| 市价单、限价单和最终成交价 | [How do I trade with different order types](https://www.okx.com/en-us/help/how-do-i-trade-with-different-order-types-eea) | 官方行为说明，不构成历史订单簿的逐笔复现。 |

地区页面不同并不等于用户账户费率不同已被查明。OKX 的 FAQ 明确要求登录后查看当前账户等级和对应合约费率；本轮不猜测用户注册地区，也不登录账户核对。

## 当前合约规格快照

2026-10-19 读取 OKX `GET /api/v5/public/instruments?instType=SWAP&instId=...`：

| 合约 | `ctType` | `ctVal` | `ctValCcy` | `lotSz/minSz` | `tickSz` | 结算币 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `BTC-USDT-SWAP` | `linear` | `0.01` | BTC | `0.01` 张 | `0.1` USDT | USDT |
| `ETH-USDT-SWAP` | `linear` | `0.1` | ETH | `0.01` 张 | `0.01` USDT | USDT |

当前逐仓 position-tiers 公开快照的前几档为：

| 合约族 | 档位 | `minSz`–`maxSz`（张） | `imr` | `mmr` | `maxLever` |
| --- | ---: | ---: | ---: | ---: | ---: |
| BTC-USDT | 1 | 0–1,000 | 1.00% | 0.40% | 100 |
| BTC-USDT | 2 | 1,000.01–5,000 | 1.50% | 0.50% | 66.66 |
| BTC-USDT | 3 | 5,000.01–20,000 | 2.00% | 0.75% | 50 |
| ETH-USDT | 1 | 0–5,000 | 1.00% | 0.40% | 100 |
| ETH-USDT | 2 | 5,000.01–10,000 | 1.50% | 0.50% | 66.66 |
| ETH-USDT | 3 | 10,000.01–25,000 | 2.00% | 0.75% | 50 |

这份快照足以说明“张数、面值、档位”不能写死成 BTC 和 ETH 相同；首期训练应把合约规格和规则版本一起保存。

## 手续费规则

### 费率 baseline

首期规则草案统一名为 `okx-usdt-swap-training-2026-10-19-v1`，尚未作为业务运行配置启用：

- maker：`0.0002`（0.02%）。
- taker：`0.0005`（0.05%）。
- 普通开仓和关仓都按实际 fill 的 maker/taker 分类计费。
- 教学接管只入账一次合计损失，taker 率用于参考费用拆分；不清零保证金后再扣 `liquidation_taker_fee`，不添加未经证实的固定强平费。

这只是训练 baseline。OKX 公共页面的 Regular/LV1 费率支持它，但 OKX 同时声明登录后的账户费率可能不同，VIP、返佣/做市计划、地区实体和产品可用性均可能改变结果。训练 UI 应显示“固定训练费率版本”，不要写成“你的 OKX 费率”。

### 公式和计费时点

对 USDT 本位线性永续：

```text
fill_notional_usdt = contracts × ctVal × fill_price
trading_fee_usdt = fill_notional_usdt × maker_or_taker_rate
```

OKX 明确说手续费在订单成交时收取；开仓、关仓没有不同的费率公式。部分成交按每次 fill 计算，未成交部分不收费。[Trading Fee Rules FAQ](https://www.okx.com/en-us/help/trading-fee-rules-faq)

### maker/taker 分类

- 市价单通常立即对手盘成交，因此通常是 taker。
- 普通限价单若立即匹配已有订单，是 taker；若先进入订单簿、之后才被撮合，是 maker。
- `post_only` 的产品语义是只允许 maker；若不能保持 maker，应取消/拒绝，而不是隐式改成 taker。是否在首期支持该订单类型另行决定。

因此，“限价单 = maker”不是可接受的训练规则。若历史模型没有盘口排队数据，至少要把“立即可成交限价”和“挂单等待成交”拆成不同的模拟状态，并在成交记录中写明假设。

## 两组独立算例

以下只验证手续费算术，资金费、滑点和盈亏另算；数字均为虚拟示例。

### 算例 A：BTC 开仓 taker、关仓 maker

- `ctVal = 0.01 BTC`，开仓 `100` 张，成交价 `60,000 USDT`：名义价值 `100 × 0.01 × 60,000 = 60,000 USDT`。
- 开仓若立即成交为 taker：`60,000 × 0.0005 = 30.00 USDT`。
- 关仓 `100` 张，成交价 `61,000 USDT`，若限价挂单后才成交为 maker：`100 × 0.01 × 61,000 × 0.0002 = 12.20 USDT`。
- 两次普通交易手续费合计 `42.20 USDT`，不包含资金费、滑点或强平费用。

### 算例 B：ETH 限价立即成交 taker、再分批 maker 关仓

- `ctVal = 0.1 ETH`，开仓 `50` 张，限价直接吃掉卖盘，成交价 `3,000 USDT`：名义价值 `50 × 0.1 × 3,000 = 15,000 USDT`。
- 即使订单类型是限价，只要立即成交仍是 taker：`15,000 × 0.0005 = 7.50 USDT`。
- 之后关仓 `25` 张，挂在订单簿后以 `3,100 USDT` maker 成交：`25 × 0.1 × 3,100 × 0.0002 = 1.55 USDT`。
- 余下 `25` 张在 `3,050 USDT` 以市价退出为 taker：`25 × 0.1 × 3,050 × 0.0005 = 3.8125 USDT`。
- 这笔合计 `12.8625 USDT`（按下述训练账本精度保留；界面可以显示 `12.86 USDT`）。

## 强平、清算费与其他费用

需要在账本里至少拆成以下事件：

1. **普通成交手续费**：用户自己提交的开仓/减仓/平仓 fill，按该 fill 的 maker/taker 费率。
2. **强平 taker fee**：强平引擎处理清算订单时，按当前等级 taker 费率。公开公式可以支持“被清算名义价值 × taker 费率”的训练计算。
3. **liquidation clearance fee**：OKX 的规则页说该费用“可能”用于覆盖清算过程中的市场波动、滑点和某些清算损失。该页面对不同账户模式分别给公式：孤立/交叉的现货与借贷段落、以及组合保证金（portfolio margin）下的 U-margined futures 段落；它没有给出首期 BTC/ETH USDT **逐仓永续**可以直接套用的固定金额/费率。不能把交叉模式的 `position value × taker rate`、借贷段落或 portfolio margin 的公式拼成“逐仓一定双收”的结论。
4. **维持保证金/风险扣减**：这是触发和清算风险计算中的保证金要求，不应在账本里伪装成交易手续费。
5. **资金费**：永续持仓在结算时点发生的多空转移，不是平台交易手续费。

第 2 项可单独核对参考算术，不能单凭它通过完整接管验收。第 3 项官方精确数值仍未闭合，不能默认为 0，也不能拼入组合保证金/借贷公式。用户已接受独立保守教学模型，P0-B 通过该路径关闭；合计接管损失入账一次，参考费率拆分仅供说明。后续按 L01–L10/A08/A14 验收教学闭环，不标为实盘精确净损益。状态与顺序见[实施计划](./2026-10-19-okx-implementation-and-acceptance.md)。

## 资金费与手续费的边界

OKX FAQ 给出的 USDT 本位资金费公式为：

```text
funding_fee_usdt = contracts × ctVal × mark_price × funding_rate
```

正资金费通常由多头支付给空头，负资金费方向相反；只有在结算点仍持仓才参与。OKX 说明资金费由多空之间结算，平台不抽取其中一部分；因此训练复盘中应把 `funding_fee` 与 `trading_fee` 分成两条成本来源。资金费率和结算频率按具体合约和时点读取，不能用手续费率替代。

## 滑点：官方能确认什么、训练需要自行冻结什么

OKX 的订单类型说明确认：市价单按订单簿当前可用的最佳价格执行，但最终成交价不保证；止损/止盈触发后再提交订单，在快速或低流动性市场可能比触发价更差。官方没有发布一条适用于所有历史窗口和所有订单大小的固定滑点率。

因此：

- 历史 1 分钟 K 线无法测出真实盘口冲击，也不能把“下一分钟开盘价”称为 OKX 实盘成交价。
- 滑点应独立于手续费，记录为 `execution_slippage`；不能先把成交价劣化再额外收一笔同义“滑点费”。
- 主 Agent 已完成 3 次、双合约、3 个名义规模的公开显示盘口观察，原始证据见 [盘口样本](./okx-rule-snapshots/2026-10-19-public-book-samples.json)。它只能检查当前静态深度量级，不能作为历史真实成交校准。
- 整合参数为 0/2/10 bps（控制/默认/压力），均属教学模型假设；`slippage_model_id` 必须冻结，验收用固定快照，不依赖实时盘口。

## 产品必须先冻结的精度与扣费假设

以下是实现前的**训练产品假设**，不是 OKX 已确认的账户内部实现；之所以明确写出，是为了避免不同开发者各自选择隐含口径：

1. 所有手续费先用 Decimal 计算；单个 fill 的内部账本保留 8 位 USDT，不在每个中间乘法步骤四舍五入；界面金额显示到 0.01 USDT。会话汇总由内部账本重新求和后再显示。
2. 普通开仓 fill 的手续费从可用 USDT 单独扣，事前预留保证金和 taker 费用，实际按该 fill 角色结算；资金不足时不凭空形成仓位。普通减仓/平仓的费用与本次释放保证金、已实现盈亏一并结算，不能仅因可用余额为 0 就禁止风险降低型退出。资金桶和精度是本产品明确的建模约定，不冒充 OKX 所有内部展示细节；账本事件必须与净权益守恒。
3. 强平 taker fee 作为单独 `liquidation_taker_fee` 事件计一次；同一被强平退出不再重复扣普通 close fee。`liquidation_clearance_fee` 保持未决，不能用 0 代替未知。该门槛解决前，不能把忽略 clearance 的结果显示为已验收的强平净损益。
4. 本范围是 OKX 合约逐仓：[官方资金费机制](https://www.okx.com/help/perps-funding-fee-mechanism) 明确资金费直接从对应逐仓保证金扣除/计入；不能套用“先可用余额、不足才扣逐仓”的其他平台或模式规则。资金费改变保证金后必须重算风险。

第 1–3 项必须在规则版本中持久化。它们使训练结果可重放，但不能被描述为“已完全复刻 OKX 内部扣费/舍入实现”。

## 实施前的技术核实项

- 以当前公开 `public/instruments` 和 `public/position-tiers` 快照生成规则版本；开局固定 `ctVal`、`lotSz`、`minSz`、`tickSz`、档位边界、IMR/MMR 和最大杠杆，不在会话中跟随未来 API 变化。
- 主 Agent 的公开数据探针需输出滑点模型的来源、样本窗口、方向、数量规模、缺失和不确定性；若仅有 OHLC，必须标记“非盘口实测”。
- 用确定性算例验证 BTC/ETH 的张数取整、面值换算、费率切换、部分成交、部分平仓和多次 fill 汇总；覆盖限价立即成交（taker）与挂单成交（maker）。
- 明确实现的费用精度和现金扣款策略，并把“训练假设”标签保留在复盘里；不要把 8 位内部精度或不足余额拒单写成 OKX 官方规则。
- 强平测试至少验证：mark 价格而非 last 价格触发；普通退出、强平 taker fee、clearance fee 未建模提示、资金费各自独立；追加逐仓保证金只改变该仓保证金，不重复产生费用。
- 记录资料日期和来源链接，规则更新时新建版本；不得重写旧会话的费率、MMR 或合约面值。

## 给实施顺序与验收的费用侧输入

建议把费用/规则工作拆在业务实现之前：

1. **规则快照层**：保存合约规格、费率 baseline、position tiers、资金费数据版本和来源日期。
2. **纯计算层**：先实现并单测名义价值、初始/维持保证金、普通手续费、资金费、强平 taker fee 和展示舍入；不得依赖 UI 或实时网络。
3. **撮合/事件层**：每个 fill 记录 maker/taker、价格、数量、手续费事件和滑点模型 ID；强平另记事件类型。
4. **会话恢复与复盘层**：恢复后重新计算结果必须与保存快照一致；复盘按交易费、资金费、滑点和强平费用分别展示。
5. **数据和 UI 验收**：再接入 1 分钟推进、标记价格和暂停/揭晓流程，检查同一数据快照下结果确定且无未来泄漏。

费用侧验收最少包括：

- BTC 100 张、60,000 USDT、taker 手续费为 30.00 USDT；同量 maker 为 12.00 USDT。
- ETH 50 张、3,000 USDT、立即成交限价按 taker 为 7.50 USDT；挂单 maker 的结果不同。
- 开仓和关仓按各自 fill 价格计费；部分成交只对已成交部分收费，未成交/撤单不收费。
- 强平不会被记录成普通用户 close；只出现一笔 `liquidation_taker_fee`，clearance fee 明确标注未建模。
- 资金费不进入交易手续费合计；fee、funding、slippage 复盘分栏可加总回到账户权益。
- 同一输入快照、规则版本和操作序列重复运行，内部金额和事件顺序一致；显示舍入不改变内部总额。

以上验收是费用/规则子集，不能单独证明完整合约引擎已经实现，也不能证明历史训练精确复现 OKX 实盘。
