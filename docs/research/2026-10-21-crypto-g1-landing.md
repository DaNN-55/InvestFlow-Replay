# G1 已验证方案落地到加密工作区

日期：2026-10-21。结论：**G1 通过的组合方案已落地到 `codex/okx-crypto-training` 工作文件，必要回归通过。** HEAD 仍为 `5807ba8`；没有暂存、提交、正式 Git 合并或推送。原 A 股工作区的未提交内容不变。

## 成功条件与结果

| 编号 | 应用前记录的条件 | 结果 |
| --- | --- | --- |
| L1 | 精确落地 G1 候选业务文件，保留后续状态说明 | 应用原归档补丁；464/466 文件当时精确一致，2 份当前状态文档保留后续说明；最终 273 份运行/测试/关键输入仍与受测候选逐字节相同 |
| L2 | 两边行为、冻结资金及市场隔离不退化 | 355 后端、210 前端、93 引擎通过；A 股 52、加密 12 组浏览器流程，真实旧库迁移与同库混合市场通过 |
| L3 | ADR 唯一编号和当前引用完整，历史证据不覆盖 | 13 份唯一 ADR，36 个当前引用通过；补正 6 份文档显示标签，原审查编号附映射，归档证据保留原字节 |
| L4 | 具体整理实现/文档/固定基准/归档范围，排除运行数据 | 已生成各组完整路径和 SHA256；无未分类路径，无 storage 混入，无暂存 |
| L5 | HEAD、原索引、正式合并状态不变，测试不动用户账本 | 原索引与 HEAD 不变，无 MERGE_HEAD；自动测试仅临时账本。更新本地后端前后原账本各表原有行数/列值一致 |

[补丁应用记录](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-landing-2026-10-21/applied-candidate.json`）、[运行文件对照](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-landing-2026-10-21/runtime-candidate-check.json`）、[ADR 校验](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-landing-2026-10-21/adr-check.json`）、[机器汇总](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-landing-2026-10-21/landing-summary.json`）。

## 落地内容

应用的是[上一轮 G1 受测候选](./2026-10-21-crypto-g1-integration.md)，A 股部分只来自 `7ea07cc22aa0f132b206f9b4362a98f5f9a382e3`。没有从原工作区复制其未提交 TDX/CONTEXT 内容，没有用 Git merge 改变分支关系。

- 股票展示和持久化入口支持 legacy-next-open、bar-orders-v1/v2，仍拒绝未知版本和合约误用股票执行器，不降级解释旧会话。
- A 股对照/训练统计与合约 preview/analysis/actions/market/ledger/traces 共存；股票统计和股票样本维护上下文只读取 ashare，合约仍使用自己的暴露、精确账本和首次对照。
- A 股限价/止损/撤单/部分成交、主板/创业板/科创板、首次与复练分析，以及加密训练、风险、保护单、追加保证金、教学接管均保留。
- 共用 SQLite/schema/facade、HTTP/API 和界面按候选落地；加密规则/执行/教学强平版本未更改。P2/P3a/P3b 的 12 个纯计算/执行文件指纹保持不变。
- A 股已提交的 ADR 0001/0004–0007 不变，加密原 0004–0009 改为 0008–0013，规则决策内容保持原意。除候选原有链接修正，还把当前链接的文字编号与目标文件对齐；原审查的历史编号用括注映射，不改归档 JSON/日志/截图/补丁。

## 实际工作区回归

| 检查 | 本轮实跑结果 |
| --- | --- |
| 后端全量 | 355 passed，0 failed |
| 前端单元 | 210 passed，0 failed |
| 引擎离线 | 93 passed（90 项 A 股＋3 项加密下载器） |
| ESLint / 生产构建 | 通过 |
| A 股浏览器全量 | 52 passed |
| 冻结 BTC/ETH 预览、图表、复盘 | 6 组通过，pageerror 0 |
| F2/F3 恢复、幂等和首次对照 | 6 组通过，pageerror 0 |
| 同一应用、同一临时库的混合市场 HTTP/界面 | 通过：历史/统计隔离，跨市场请求不改钱和股票状态；页面切换无串线 |
| 三条真实旧版本升级路径 | legacy 2、新 A 股 4、原加密 3，共 9 会话通过；旧库原有列逐列指纹一致，继续操作/重试/原模型复练通过，首次不变 |
| 原始冻结资产完整性 | 小样 487 文件、历史池 7622 文件完整 SHA256 链复核通过；不改行情、不联网重取 |

旧加密源由本轮应用前指纹和备份重建，另外两套源由 5807ba8/7ea07cc 的 Git 原提交导出；不是用新版本生成的库冒充旧库。加密恢复验证禁用当前行情 source 后仍可恢复/复练。

[旧库迁移](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-landing-2026-10-21/migration.log`）、[分路径证据](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-landing-2026-10-21/migration`）、[混合市场](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-landing-2026-10-21/mixed/mixed-http-browser.json`）、[BTC/ETH 专项](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-landing-2026-10-21/crypto-insights/insights-browser-validation.json`）、[恢复专项](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-landing-2026-10-21/crypto-recovery/recovery-browser-validation.json`）。本轮证据与此前 G1/F1–F6 目录分开，未覆盖旧截图或结果。

此前 G1 的 F5 三种冷启动/8 组异常证据仍保留；本轮运行相关模块与受测候选精确一致，另实跑原资产全量指纹检查及恢复/混合市场流程，没有重复将旧 F5 记录说成本轮重跑。

## 提交范围（只整理，未暂存）

完整建议见[分组清单](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-landing-2026-10-21/proposed-commit-scope.md`）和[逐文件 JSON](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-landing-2026-10-21/proposed-commit-scope.json`）：

| 分组 | 建议内容 |
| --- | --- |
| 实现与测试 | 120 文件：backend/web/engine 代码与测试、验证入口、依赖声明、配置示例 |
| 当前文档与 ADR | 45 文件：README、数据准备、13 份 ADR/索引、方案及验收说明 |
| 固定规则与验证输入 | 9 文件：规则/数值算例/原始规则参考和三个被验证脚本引用的基准 JSON，必须随实现保留 |
| 历史及本轮证据 | 单独审查和归档，完整日志/截图/补丁/指纹路径见清单；不能等同运行依赖 |

明确排除 `storage/**` 内的行情池、小样、账本与缓存，以及 node_modules、.venv、dist、.runtime、临时数据库和编译缓存。不把运行数据加入 Git 来替代 F5 的离线交付。TDX 文件在实现清单内的变更仅为 7ea07cc 已提交的样本维护内容，不含主工作区另行修改。

归档日志/嵌套 patch 的既有空白提示保留；运行代码与新增集成差异检查通过。若后续决定证据包不随代码仓库分发，应连同报告链接一起处理；当前全部本地证据仍保留，没有擅自删除或改写。

## 本地服务与剩余边界

测试入口仍为 `http://127.0.0.1:5182/decision/crypto-replay`，3112 后端已加载落地代码，沿用 `storage/crypto-user-testing` 账本和默认冻结行情。启动前后只读核对所有原有行/列不变，未自动创建、下单、推进或改写用户练习。[记录核对](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-landing-2026-10-21/user-service-check.json`）。原工作区的 8775 引擎服务未重启或改配置；本轮 A 股供数验证为固定行情/离线引擎测试，没有新增实盘或 TDX 联网供数验收。

落地、兼容修正和本轮验收已完成。尚未执行的是用户保留的提交、正式合并、推送以及最终证据分发决策；S1/N1 两项原非阻塞建议仍保留，未顺手扩成重构。若以后更换目标提交或纳入额外未提交 TDX 改动，应按对应增量重新检查。
