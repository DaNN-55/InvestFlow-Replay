# ADR-0007：跨会话训练分析与客观事件

## Status

Accepted，2026-10-20。按已确认方案实施，含用户指认的同场景对照入口内边距修正。

## Decision

- 沿既有SQLite、database→store→interaction→HTTP边界汇总，不新建训练账本，不改冻结行情、原始复盘或评分。新增GET `/api/quant/replay/analytics`，默认读取全部非删除A股练习；离线合成Demo排除，不混入A股训练结论。
- 筛选支持from/to（北京时间创建日期，YYYY-MM-DD）、interval（all/1d/hybrid/1m）、gameLength（all或合法练习长度）、board（all/main/chinext/star）。日期、周期和长度都明确显示；不受历史列表分页、关键词或当前选中记录限制。
- 返回 `{filters, groups:{first,retrain}}`，两个分组始终独立，不产生混合总收益曲线。每组：counts（sessions/active/completed/unrevealed/analysed/scored/skipped/tagged/uncomputable/metricsUncomputable）、distributions（returns/drawdowns：n/median/min/max/buckets[{label,count}]）、feesTotal、issues[{tag,count,samples[{sessionId,createdAt,interval,gameLength,attemptNumber}]}]、events（evaluableSessions/triggeredSessions/stopTriggeredSessions/invalidationTriggeredSessions/protectedSessions/autoExitSessions/stopCancelledSessions/exitOrderSessions/restrictedSessions/partialFillSessions）、cohorts（earlier/recent：最多各20个已揭晓完成样本，n/from/to/returnMedian/drawdownMedian/taggedSessions/triggeredSessions）、breakdowns（intervals/boards/executionModels：[{label,count}]）。空分布和空组使用null值与n=0，不能伪造零收益。
- 只有已完成且揭晓的练习纳入结果、事件和问题分析；进行中和未揭晓的只计状态数。只返回匿名聚合及已揭晓问题样本链接，不返回行情、真实股票代码、指纹、隐藏订单或草稿。费用和仓位等客观指标复用对照模块，冻结评分原样读取。
- 增加可选issueTags（0到6个去重标签）：`提前入场`、`追涨`、`仓位过大`、`退出犹豫`、`偏离计划`、`无明确依据`。原始事后复盘、草稿和追加修正均支持；最新有效事后修正决定当前问题标签，删除修正回退。旧自由文本不自动分词或打标签，也不要求用户重填结果。
- uncomputable表示冻结持仓条件无法自动评估；metricsUncomputable单独表示有效推进或结果数据不足，未进入分布。新推进在既有事务的replay_events追加客观条件触发与逐步执行观察记录，动作重试不能重复；同一冻结规则版本持续触及只记一次。历史旧练习只从已冻结的下单条件、执行状态和已推进行情回算；未保存的受限过程无法还原，0仅表示未找到记录，不读取事后草稿或修正作为事前条件，不回写历史。前端说明历史回算边界。
- 触价止损优先采用执行器持久triggeredSequence；旧模型的手动条件仅从买入成交后已生效的计划评估。收盘失效条件（basis=close）按完整日线收盘检查，hybrid盘中5分钟不能当日收盘；有效规则从对应买入成交起生效，新计划作为新版本，不追溯覆盖旧判断。没有持仓或从未成交的买单不算持仓退出条件机会。
- 不把触发、已提交退出、实际成交混为一谈。T+1、跌停、容量不足等属于客观限制；统计自动保护、用户主动取消保护、部分成交和受限练习数；会话结束或持仓归零自动停止保护不计主动取消。没有约定人工响应期限，不输出“拖延率/违规率”或自动纪律评价；不因空仓、亏损或低分自动判断错误。
- 最近20个与紧邻此前最多20个（两组不重叠）只作描述性对照，明确样本量和创建日期，列出周期/板块/执行模型构成；样本不足显示不足，不推断提升，不将重叠历史会话拼成真实资金净值。
- 历史演练使用同一行“演练记录 / 首次分析 / 复练分析”切换，分析独立筛选；首次与复练之间切换保留筛选和已读取报告。问题样本可回到具体历史记录，原始记录和后续修正都可审查。

## Success conditions

| 可检查结果 | 验证 |
| --- | --- |
| 首次、复练、Demo、删除、未揭晓、分页互不混淆 | 纯聚合与真实HTTP测试 |
| 窗口样本量、空值、周期/日期筛选和分布正确 | 固定数据与边界测试 |
| 标签只由用户确认，修正/删除后统计正确且原评分不变 | API与页面完整流程 |
| 触发去重、生效起点、持仓、日收盘和交易限制口径正确 | 事件检测测试、真实推进重试与回滚 |
| 分析只读，未揭晓数据不泄露 | 账本前后快照与匿名测试 |
| 分析入口、筛选、样本跳转及窄屏可操作 | 浏览器与实际页面验收 |
