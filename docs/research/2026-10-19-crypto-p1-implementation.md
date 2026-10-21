# 加密训练 P1：纯计算实现与验证

日期：2026-10-19。状态：**P1 纯计算已实现，28 项测试通过；未接界面、业务账本、数据库或网络，未启用完整执行引擎。**

用户授权：新建加密开发分支，后续加密部分在该分支内实现，先做第一阶段纯计算，不接界面和业务账本。

## 分支与工作目录

- 分支：`codex/okx-crypto-training`。
- 独立目录：`/Users/dan/.codex/worktrees/okx-crypto-training/InvestFlow-Replay`。
- 基点：`5807ba821ddf649505942b23dbe0906b77ba7087`。
- 原目录 `/Users/dan/Programs/InvestFlow-Replay` 保持 `codex/replay-order-execution`；其 A 股/TDX/UI 未提交改动未带入此分支。
- 仅复制加密方向的研究文件、规则快照与 ADR-0002/0003。后续加密实现继续使用本目录和分支；P4 前重新核对 A 股批次状态，不假设其未提交实现已存在于本分支。
- 本次未提交、未推送。工作内容保存在该分支的独立工作目录中。

## 成功条件与改动对应

| 可检查结果 | 对应实现与证据 | 状态 |
| --- | --- | --- |
| 按冻结规格计算，BTC/ETH 不共用面值或 tick | `backend/src/replay-crypto-calculations.js`，构造时显式注入规则；A01、全部 198 个档位的两端边界检查 | 通过纯计算测试 |
| Maker/Taker 费、滑点与整段净收益符合已确认基准 | quoteFill/quoteMarketFill/openPosition/reducePosition；BTC 30/12、ETH 12.8625、BTC 最终 10042.46300500 | 通过 |
| 保证金只因资金事件变化，追加不增加权益 | openPosition/addMargin/reducePosition；mark 不重置 M、比例释放保留舍入余量、可用为 0 仍可减仓 | 通过 |
| 资金费四种收付方向正确，负保证金不截断 | settleFunding；只从 M 收付，返回新的风险检查结果 | 通过数学验证；时点调度/防重待 P3/P4 |
| 风险阈值与多空公式一致，等于阈值触发 | assessPosition；独立阈值金标、整仓档位公式、显示值舍入不会误触发 | 通过 |
| 教学接管合计只结算一次，费用拆分不重扣 | liquidateAfterCancellation；8 个已确认算例、较高档位全平、穿仓与负保证金豁免 | 通过计算验证；真实撤单与重试防重待 P3/P4 |
| 模块不改变调用者状态，不访问外部环境 | 唯一运行依赖为 decimal.js；冻结输入、重复计算、JSON 序列化、规则防御性复制检查 | 通过；未接入业务调用 |
| 实盘差异与后续验收不被“纯计算通过”覆盖 | ADR、结算规范、实施计划同步状态；展示契约保留 | 文档已更新；界面验收待 P5 |

## 实现与接口

新增 `backend/src/replay-crypto-calculations.js` 及同名 `.test.js`。后端依赖固定增加 `decimal.js@10.6.0`，锁文件仅增加该包，没有升级其他依赖。使用独立精度配置，不修改进程内其他调用者的 Decimal 配置；[库官方接口说明](https://mikemcl.github.io/decimal.js/)提供独立构造器和舍入能力。

构造：`createCryptoCalculator({ rules, instrumentId })`。规则由调用者提供，模块不自行读取文件；仅接受确认的 OKX 逐仓单向版本和 BTC/ETH。复制规则后计算，调用者后续修改原对象不改变本实例。

| 接口 | 作用 / 调用者必须知道的约束 |
| --- | --- |
| quoteFill | 给定实际模拟 fill 的角色、数量和价格计算名义价值与手续费；可选杠杆计算初始保证金，不猜测限价单身份 |
| quoteMarketFill | 0/2/10 bps 组别模拟方向性价格偏移并向不利 tick 取整，归因为参考金额，不另扣现金 |
| floorContracts | 辅助按 lot 向下取整；不足最小张数返回 0，不能直接当有效委托 |
| openPosition | 从给定现金中扣初始保证金与已成交手续费，返回持仓值；要求空仓及明确杠杆，反向不能绕过先平仓 |
| reducePosition | 给定成交计算部分/全部退出，按比例释放保证金，扣退出手续费，保留剩余入场均价，不跨零反向 |
| addMargin | 仅将现金移入 M，数量与均价不变；非正或超可用金额拒绝 |
| settleFunding | 输入原始结算事件所用 mark 和 settledRate，返回正支出/负收入、M 新值和风险；不决定事件何时发生 |
| assessPosition | 按独立 mark 算浮盈亏、整仓维持保证金、风险率与阈值，风险比较用未按显示精度舍入的值 |
| liquidateAfterCancellation | 必须明确模型版本及 `ordersCancelled=true`；对撤单释放后的状态重新检查，安全则不接管，不安全则按教学模型全平 |

金额输入用普通十进制字符串，或安全整数；拒绝小数 Number、非有限值、科学计数法和超过 32 位数字的输入。现金余额最多 8 位小数，结果统一 8 位 HALF_UP；价格和张数按各自 tick/lot 校验。风险率输出 24 位、估算阈值 40 位，仅作解释，不据其显示舍入值判断是否触发。

输入/输出均为可序列化值，不返回 Decimal 对象。账户值为 `{ availableBalance, position }`，没有持仓时 `position=null`；持仓包含 instrumentId、side、contracts、entryPrice、marginBalance。每次调用返回新对象，不写数据库，也不创建会话或业务资金流水。

普通主动平仓若数学结果为负现金，返回明确的 `cashDeficit`，不套用教学接管豁免。这是数学缺口的披露，后续订单/风险阶段须明确处理，不在 P1 冒充完整业务策略。

## 已完成验证

运行环境 Node `v24.20.0`，执行：

```sh
cd /Users/dan/.codex/worktrees/okx-crypto-training/InvestFlow-Replay
node --test backend/src/replay-crypto-calculations.test.js
```

结果：**28 tests / 28 pass / 0 fail / 0 skipped**。文件名符合后端既有 `npm test` 的收集规则；本轮只运行新纯计算测试，没有启动后端、运行迁移或测试用户正式账本。

直接读取冻结的[普通算例](./okx-rule-snapshots/2026-10-19-golden-cases.json)与[8 个接管金标](./okx-rule-snapshots/2026-10-19-liquidation-teaching-cases.json)进行断言，没有把期望值从被测函数回填。规则与金标文件保留当时采集/确认阶段的状态元数据；当前实现进度以本报告为准，不因此改写证据或声称整体执行模型已启用。

主要复核结果：

- BTC 100 张 / 60,000：taker 30、maker 12；ETH 三笔混合费用 12.8625。
- BTC 1500 张 / 60,000：整仓 MM=4500，未用错误累计扣减 3900。
- BTC 默认滑点往返：资金费 0.502，最终 10042.46300500；中途追加 500 不改变最终权益。
- 8 个接管金标全部匹配：BTC/ETH 多空、追加＋资金费、跳空、恰好阈值、资金费造成负保证金；仓外现金不再扣费，实际成交/官方 clearance 保留 null。
- 显示风险率被舍入为 1 而精确权益仍略高于要求时，不错误强平。

## 已知边界与后续

P1 不负责实际撤单、委托冻结、maker/taker 判定、同向加仓撮合、资金费时点调度、分钟内事件排序、行情准入、事务/幂等、持久化版本或界面。`ordersCancelled=true` 是计算前置条件，P3/P4 必须从服务端执行状态得出，不能把客户端自报当作真实撤单。

L01/L02 的计算部分、L03/L04 已覆盖；L05 的持久化防重、L06 的时间因果、L07–L10 的展示/会话冻结仍不能标整体验收通过。A01–A05 仅数学部分通过；A05 的原始资金费时间与恢复防重待后续。当前净收益表示已确认教学模型下的数学结果，不是实盘清算账单。

下一阶段是 P2：先 BTC，再 ETH 的连续 72h 场景、此前 90 日背景与结束执行点，校验普通/mark/funding、hash、时间和不泄露未来；之后才进入 P3 分钟执行。用户本轮授权止于 P1，没有自动开展 P2。

安装检查另外报告 4 项既有间接依赖告警：body-parser（low）、qs（moderate）、form-data（high）、proxy-addr（critical）。只读 audit 未列出 decimal.js，锁文件中既有包版本未改；本次未顺手升级或修复这些无关依赖。
