# Architecture Decision Records

隔离组合候选：保留 A 股已提交编号；加密原 0004–0009 映射到 0008–0013，决定正文与历史证据不变。

| ADR | 决策 | 状态 | 日期 |
| --- | --- | --- | --- |
| [0001](0001-replay-bar-orders.md) | 在现有账户事务内处理可持续委托 | Accepted | 2026-10-19 |
| [0002](0002-okx-versioned-training-rules.md) | OKX 历史合约训练使用冻结规则与独立执行版本 | Accepted | 2026-10-19 |
| [0003](0003-okx-conservative-liquidation.md) | OKX 首版采用保守教学接管结算 | Accepted | 2026-10-19 |
| [0004](0004-ashare-board-rules.md) | 按板块和历史日期冻结 A 股训练规则 | Accepted | 2026-10-19 |
| [0005](0005-replay-sample-maintenance.md) | 行情缓存维护与板块覆盖 | Accepted | 2026-10-19 |
| [0006](0006-replay-attempt-comparison.md) | 首次与复练按冻结场景对照 | Accepted | 2026-10-20 |
| [0007](0007-replay-training-analytics.md) | 跨会话训练分析与客观事件 | Accepted | 2026-10-20 |
| [0008](0008-okx-sample-time-visibility.md) | 行情样本保存完整证据，可见数据只按时间前缀生成 | Accepted | 2026-10-19 |
| [0009](0009-okx-pure-minute-execution.md) | 合约分钟执行保持独立纯状态转换 | Accepted | 2026-10-20 |
| [0010](0010-okx-orders-and-protection.md) | 完整合约订单使用独立执行版本和共享分钟容量 | Accepted | 2026-10-20 |
| [0011](0011-okx-session-transactions.md) | 合约会话沿用同一 SQLite 事务并冻结全部执行输入 | Accepted | 2026-10-20 |
| [0012](0012-okx-training-interface.md) | 合约界面复用现有图表与事务，训练记录独立于执行版本 | Accepted | 2026-10-21 |
| [0013](0013-okx-history-pool.md) | 历史池分批准入，共用已冻结会话并独立记录行情暴露 | Accepted | 2026-10-21 |
