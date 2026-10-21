# 加密训练 P4：事务账本、幂等、恢复与复练冻结

日期：2026-10-20。分支 `codex/okx-crypto-training`。状态：**合约会话已接现有后端和同一 SQLite 事务，P4 的 17 项测试通过；冻结 BTC/ETH 事务闭环与旧会话回归通过。暂不接界面。**

目录 `/Users/dan/.codex/worktrees/okx-crypto-training/InvestFlow-Replay`。本轮没有启动正式服务、操作正式账本、修改 web、提交或推送。数据库迁移和业务动作只在临时数据库验证，验证完成已删除。

## 成功条件与交付

| 可检查结果 | 对应改动 | 验证 |
| --- | --- | --- |
| 同一业务事务保存状态、游标、轨迹、账本和动作结果 | [持久化 adapter](../../backend/src/replay-crypto-persistence.js)装入现有 createDatabase，同一个连接/BEGIN IMMEDIATE | SQL 中途失败全部回滚；创建/复练失败不消耗尝试编号 |
| 同动作重试不重复创建、下单、扣费或追加 | actionId＋规范化请求比较，先幂等后 revision；结果保存提交时状态 | 同请求返回原游标；同 ID 改请求、旧 revision 拒绝；两个 writer 共享防重 |
| 合约小数张数/USDT 不经股票整数/REAL 字段 | 新增 TEXT 十进制业务账本，原账户 JSON 保存完整执行态 | 逐动作桶变动与费用/资金费/盈亏一致；分数张数、部分成交、接管不双记 |
| 恢复不依赖最新源文件、全局规则或重新撮合 | 全量行情/规则共享冻结文档＋内容 hash；会话配置/状态 hash 和不可变触发器 | 活动 GTC、保护、费用、游标重启一致；源被禁用后仍可继续 |
| 复练复制原版本和资金预设，原成绩不改写 | 同一不可变 descriptor/config，独立初态/会话/尝试编号 | 原始数据、规则、执行、滑点、起始现金/杠杆一致；重复复练只产生一个子会话 |
| 服务端限定可见范围，不能让客户端写游标或状态 | [合约会话服务](../../backend/src/replay-crypto-session.js)白名单命令；先截完整分钟再聚合 | 请求未来游标/轨迹、上传 state/snapshot、关闭事件暂停或跳 1000 分钟均拒绝 |
| 旧 A 股默认行为保留 | 现有 interaction/store/app 按市场分流；默认历史仍为 ashare | 本分支旧 A 股创建、交易、T+1、恢复、历史、复练、盲评/揭晓回归通过 |
| 新旧模型不会被偷偷重解释 | 独立市场和 execution_model_version | 未合入的 bar-orders 等股票版本保留数据，公开解释/执行显式拒绝；没有回落为 legacy |

约束见 [ADR-0011](../adr/0011-okx-session-transactions.md)。P1–P3b 的纯计算和样本没有修改。

## 数据与写入边界

沿用原 `replay.sqlite` 和 `createDatabase` facade，没有第二份账户库或独立业务写入服务。

- `replay_sessions` 添加 `market`、`execution_model_version`、`snapshot_hash`、`account_state_hash`。旧行默认 ashare / legacy-next-open。合约 account_json 保存完整 P3b 状态，包含活动委托、保护、保证金、费用、事件序号和已完成分钟；按市场解释。
- `replay_crypto_snapshots` 在同一 SQLite 保存完整普通/mark/funding、规则及执行版本。按内容 hash 去重、禁止更新/删除；descriptor 引用文档并冻结起始金额、杠杆和滑点。复练不复制成另一份行情 blob，也不重新读取源文件。
- `replay_execution_traces` 保存按执行序号排列的真实模拟成交、拒单、资金费、追加、歧义、接管和结束轨迹，序号必须连续。
- `replay_account_entries` 每写动作一行，TEXT 保存 available/reserved/M 的实际变化，以及 initial/fee/funding/realized/liquidation/topup 的变化。逐动作校验 `桶变化合计 = 起始注入 − 手续费 − 资金费 + 价格已实现收益 + 接管合计`。
- 轨迹解释经济事件，桶账本记录状态变化；不把二者再叠加扣款。滑点仍在模拟成交价中；参考接管费用、核销和豁免不再作为普通手续费或收入重复记账。
- 现有 `replay_events` 保存 actionId、规范化请求和本次提交的结果。重复动作返回原提交的 cursor/revision/盲评可见状态，不因会话后来推进或揭晓而泄露后续信息。

每个动作在 BEGIN IMMEDIATE 内完成幂等检查、版本检查、基于持久状态计算、状态更新、轨迹/账本和动作记录；任何步骤失败整体回滚。没有先写内存状态后补账本的窗口。创建、子会话初始注入和尝试计数也在同一事务。

## 恢复、复练与未知版本

恢复从数据库的不可变冻结文档构建已保存执行版本，再使用持久化状态继续；不从开始重复跑一次，也不拿今日规则覆盖旧仓。文档、descriptor、状态 hash 失败会报错；缺失或不支持版本不会静默退到其他模型。

正常/提前结束与揭晓分开。finish 有仓位时先按 P3b 规则在下一未展示分钟退出，容量不足可继续推进；最后仍未平仓则保留 end-blocked，不能假装空仓、强制新增非风险接管、保存完成盲评或揭晓。completed 且空仓、保存首次盲评后才允许揭晓和复练。

合约首份盲评只保存判断/交易或不交易计划，不套股票评分。完整复盘编辑、草稿和评分扩展留给 P5，相关旧股票入口对合约显式拒绝。

复练要求已揭晓源会话；复制原数据/规则/执行/费率/资金/杠杆/滑点，恢复到空仓、无活动单/保护、0 已展示未来分钟的独立初态。原结果保持不变，子会话记录 sourceSessionId 和尝试编号，不计首次成绩；同 actionId 重试不会重复创建或增加编号。

## 后端接口

现有 `/api/quant/replay/sessions` 继续承载两种市场。创建合约必须显式给 `market: "crypto-perpetual"`、BTC/ETH `instrumentId` 和创建 actionId；可选 startingCash/leverage/slippageBps。默认 10000/5/2；只允许已冻结的 0/2/10 bps。

| 接口 | 合约语义 |
| --- | --- |
| POST /sessions | 创建；同 actionId/同参数重试返回原初态，改参数冲突 |
| GET /sessions/:id | 恢复当前公开状态，不返回完整场景、内部 state 或未揭晓数据版本 |
| POST /sessions/:id/orders | `{actionId, expectedRevision, command}` 的 market/limit 开平；同向加仓沿用 market-open/limit-open |
| POST /sessions/:id/actions | 相同封装承载取消、保护、追加等 P3b 命令；不接受客户端 state/规则/游标 |
| POST /sessions/:id/advance | `{actionId, expectedRevision, minutes: 1/5/15}`；遇事件在该完成分钟暂停 |
| POST /sessions/:id/finish | 开始结束并尝试一个执行分钟；未退出完仍保留 ending/end-blocked |
| POST /sessions/:id/reviews/blind | `{actionId, expectedRevision, review:{thesis,tradePlan}}`；完成后、揭晓前一次冻结 |
| POST /sessions/:id/reveal | 已完成平仓及首次盲评才揭晓 |
| POST /sessions/:id/retrain | `{actionId, expectedRevision}`；以源会话冻结配置创建独立初态 |
| GET /sessions/:id/market | timeframeMinutes 与可选 elapsedMinutes；未揭晓只允许不大于服务端已展示分钟 |
| GET /sessions/:id/ledger 或 /traces | 当前已提交范围的分页账本/轨迹，limit 最大 200，越界游标拒绝 |

创建/复练新会话返回 201，重复为 200；其他动作返回 idempotent、outcome 和公开 session。网络重试保留同 actionId 和请求，改变意图须新 actionId；旧 expectedRevision 不能用于新动作。

默认历史列表只查 ashare，合约使用 `?market=crypto-perpetual`。公开合约数据包含当前账户、风险、订单、保护与金额事实；隐藏真实行情日期、源 URL、完整冻结文档及带行情日期的数据版本。揭晓后才提供场景数据版本和真实起始时点，并允许读取整个冻结窗口；执行状态与交易结果不因此重算。

## 真实冻结 BTC/ETH 验证

[事务证据](HISTORY.md#local-archive)（本地归档：`docs/research/okx-sample-evidence/2026-10-20-p4-session-validation.json`）与[验证脚本](../../backend/scripts/verify-crypto-sessions.mjs)关联 P3b 独立基准和当前代码 hash。

在临时同一业务数据库中，共创建 10 个会话（4 个正常流程、4 个复练、2 个风险流程），全量冻结文档去重为 2 份，数据库约 80 MB；结束后已删除临时库，没有操作正式账户库。

正常流程与 P3b 工程动作一致：索引 1 开 10 张、追加 500、索引 100 加 5、索引 600 限价减 4、索引 1000 平余 11。索引 101 关闭重开数据库，并禁用当前 source；后续资金费、退出、盲评/揭晓和复练均只用数据库冻结输入。每次推进都以原 actionId 重试，金额和游标没有二次变化。

| 合约/方向 | 最终可用 USDT | 普通费 | 资金费净支出 | 价格已实现盈亏 |
| --- | ---: | ---: | ---: | ---: |
| BTC 多 | 9990.24128581 | 6.37752100 | 2.90319319 | -0.47800000 |
| BTC 空 | 9991.88567319 | 6.37752000 | -2.90319319 | -4.64000000 |
| ETH 多 | 9974.35055673 | 3.44032150 | 1.89212177 | -20.31700000 |
| ETH 空 | 10015.98080627 | 3.44031550 | -1.89212177 | 17.52900000 |

四组逐项等于已验证的 P3b 独立 Decimal 金标；所有账本桶和费用分项汇总等于持久状态，轨迹连续。

另有 BTC/ETH 多头 100 倍风险夹具，带未成交单与保护，各只教学接管一次，释放预留后仓外现金保持原值；重试及重启没有重复接管或参考费用收费。这只是风险测试，产品默认仍为 5 倍。

## 回归、限制和后续

运行：

```sh
npm --prefix backend test
node backend/scripts/verify-crypto-sessions.mjs
```

P4 新增 **17 项**测试，后端完整回归 **267 项通过，0 失败、0 跳过**，包括既有 A 股会话/交易/T+1/恢复/历史/复练、盲评/揭晓和此前加密纯计算。HTTP 测试需要临时本机端口权限；本轮已在具备该权限的环境完整运行。

原目录仍为 `codex/replay-order-execution`，其中 bar-orders/board-orders 及 A 股/TDX/UI 未提交工作未合入加密分支。**已验证兼容的是本分支现有 legacy-next-open 会话**；保存了其他股票执行版本的行会保留数据，但本分支未具备对应执行器时拒绝公开解释和推进，不冒充这些新模型已兼容。合并并行 A 股批次时仍需独立整合与回归。

P4 的 A10 事务/幂等、A11 后端版本与复练、A09 服务端游标及 A12 后端结束受阻约束已有验证；端到端操作与四处实盘差异呈现仍待 P5。实际交易所逐笔清算、分钟容量/价格路径/资金费代理的教学差异沿用 P3b，不因接账本变成实盘复刻。

下一步 P5 再接合约界面、风险三态、保护/追加操作与复盘。P6 扩大 2024–2025 数据池。本轮不启动界面工作，也未提交或推送。
