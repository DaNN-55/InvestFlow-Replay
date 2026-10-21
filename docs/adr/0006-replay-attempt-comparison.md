# ADR-0006：首次与复练按冻结场景对照

## Status

Accepted，2026-10-20。用户授权按已确认方案实现首次与复练对照。

## Decision

- 继续复用SQLite里的场景指纹、attempt信息、原始复盘和冻结评分，不新建结果存储。按完整冻结场景身份查组，不能只按直接sourceSessionId找首次；多代复练、分页和删除不改变首次身份。
- 添加只读GET `/api/quant/replay/sessions/:sessionId/comparison`，通过既有database→store→interaction→HTTP边界提供对照。选中记录未揭晓则拒绝；组内尚未揭晓的尝试只返回次数与状态，不返回成绩、判断、交易或行情。删除记录不返回详情；首次缺失明确提示，不能提升复练为首次。
- 返回契约：selectedSessionId、firstSessionId、firstUnavailable（deleted/missing/null）、counts（first/retrain）、attempts。每项包含id、attemptNumber、kind、countsTowardFirstScore、createdAt、status、completionReason、available；已揭晓项再包含scoreCard（原冻结值）、metrics、conditions、originalReview（blindReview/postReview）、corrections、executions、comparison。
- metrics包含totalReturnPct、maxDrawdownPct、totalTradingCosts、averageCapitalUtilizationPct、maxCapitalUtilizationPct、buyFillCount、sellFillCount。复用冻结score metrics；未评分项只计算客观结果，不产生或保存评分。计算到实际结束步，不延伸到提前结束之后。
- conditions包含initialCapital、costConfig、executionModelVersion、scoringAlgorithmVersion、completedSteps、totalSteps。comparison包含comparable、reasons、delta；条件/结束进度不同时明确提示，不给出误导性综合差值。评分版本或配置不同不得比较分数。没有首次评分或尚未完成复盘时，分数为缺失而不是零。
- 历史详情与揭晓后的复盘复用同一对照组件。固定展示首次，选择第2、3等已知复练；原始判断、用户确认问题及修正单独展示，原始评分不随修正重算。复练明确不计首次成绩，收益增加不自动解释为纪律提升。
- 本批不实现跨会话训练分析、自动问题归因，不改变撮合、样本供给或已有首次计数规则。缓存状态附带精简为“日线 已更新 / 5分钟 待更新N”，成功绿色、待更新保留原黄色，失败单独显示。

## Success conditions

| 可检查结果 | 实现与验证 |
| --- | --- |
| 多代复练、分页与删除不混淆首次 | 数据分组、接口回归 |
| 匿名/未揭晓结果不泄露 | 接口拒绝及组内脱敏测试 |
| 首次原记录、评分与复盘修正互不覆盖 | 重复读取与修正回归 |
| 费用、收益、回撤、仓位、成交时点可并排检查 | 固定行情和临时账本的数值验收 |
| 不同规则/配置/结束步明确不可直接比 | 差值与提示测试 |
| 页面入口可达，切换复练和窄屏可用 | 单元、浏览器与实际页面验收 |
