# G1 A 股与加密实现隔离集成验证

日期：2026-10-21。结论：**在处理兼容问题后的精确隔离候选上验证通过。原分支尚未应用该候选，不等同已经正式合并。** 原两个工作区的业务文件、索引和分支保持原样；没有推送，没有使用用户测试账本。

## 成功条件与结果

| 编号 | 组合前记录的成功条件 | 结果 |
| --- | --- | --- |
| G1-1 | 冻结当前加密源与 A 股已提交版本，保留原工作区业务文件/索引 | 通过：加密 418、A 股 269 份原文件指纹相同，两个索引相同；后续仅新增报告与更新验收说明 |
| G1-2 | 执行实际三方合并，列明冲突并保留双方意图 | 通过：4 处文本冲突；另修复 3 处自动合并后的行为冲突，全部仅在隔离候选 |
| G1-3 | 原版本真实旧库可恢复，资金、快照、执行模型和首次不重写 | 通过：三条迁移路径共 9 个旧会话；继续操作、幂等、复练和混合市场均通过 |
| G1-4 | 两边必要回归及同库市场隔离 | 后端 355、前端 210、引擎 93、A 股浏览器 52；加密专项、冷启动和混合市场验证通过 |
| G1-5 | ADR 编号/索引完整，候选可精确复核，剩余事项明确 | 13 个唯一编号，候选补丁可在干净 A 股提交上重建，466 份文件 SHA256 一致；剩余事项见末节 |

[机器汇总](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/integration-summary.json`）、[来源与索引核对](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/source-unchanged-check.json`）、[最终候选逐文件指纹](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/candidate-files.json`）。

## 实际组合范围

- 共同基线：`5807ba821ddf649505942b23dbe0906b77ba7087`。
- A 股：当前已提交的 `7ea07cc22aa0f132b206f9b4362a98f5f9a382e3`，包含新订单/部分成交、板块规则、样本维护、首次对照与训练分析。
- 加密：`codex/okx-crypto-training` 在 F5 完成后的实际工作文件（P1–P6、F1–F6），而非只有其仍为 5807ba8 的 HEAD。全部受测来源按文件 SHA256 冻结。
- 临时仓库中建立专用于验证的加密快照 `b2eacd6fc8de8b731fea903dbcded624b4fb341d`，以 `merge --no-commit --no-ff` 三方合并 A 股提交。此临时快照不写回原仓库，不保留正式合并提交；临时环境归档后清理。
- 不纳入 A 股工作区未提交的 TDX 节点/分页改动、其共用测试的额外改动及未提交 CONTEXT 内容。只复用已安装依赖，不借用这些工作文件。未联网下载行情。
- 原 `5182/3112` 用户测试服务保持现有加密版本，未切换到隔离候选。所有组合测试使用自有动态端口/5197、临时账本和独立复制的冻结资产。

## 冲突与兼容问题

[实际三方合并输出](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/merge-output.log`）、[原始冲突文件](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/conflicts`）、[处理明细](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/resolution-notes.json`）均归档。与之前 `apply --check` 的文本适用性检查不同，本轮确实执行三方合并。

| 文本冲突 | 隔离候选的处理 |
| --- | --- |
| `backend/src/app.js` | 同时保留 A 股 comparison/analytics 和加密 preview/analysis/actions/market/ledger/traces 路由及错误码 |
| `backend/src/db.js` | 保留新 A 股订单/板块/条件事件模块和同连接的加密持久化；移除自动合并形成的重复 executionModelVersion 属性 |
| `backend/src/replay-lifecycle-store.js` | 同时保留股票对照/统计和合约快照/动作/账本 adapter |
| `docs/adr/README.md` | 两组决策都保留；A 股已提交编号不变，加密未提交的 0004–0009 映射至 0008–0013，更新对应文件及链接 |

**G1-I1：新 A 股模型被原加密保护条件拒绝。** 原保护只允许 `legacy-next-open`，自动合并后会让新 A 股创建、展示、操作及复练返回 409。隔离候选改为明确支持 legacy、bar-orders-v1/v2；股票入口仍拒绝合约和未知执行版本，不把未知版本按 legacy 执行。首次解决文本冲突后的组合回归为 **266/352 通过、86 失败**，有入口拒绝导致的级联失败；[红色记录](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/baseline-backend.log`）保留。

**G1-I2：股票统计/对照入口缺少市场边界。** 股票统计原查询全部 replay_sessions。隔离候选给 session/event 查询限定 `market='ashare'`；股票 comparison 路由拒绝合约会话。合约自己的分析与首次对照不变。

**G1-I3：股票样本维护的上下文可能被最近合约会话覆盖。** 原 `getReplayScenarioUsage` 遍历所有 snapshot；合约描述没有股票 benchmark，会把缓存上下文设为日线/空指数。隔离候选仅从 A 股快照构造股票已见记录和缓存上下文，不改变合约的暴露隔离算法。

新增 3 项混合市场回归；原加密兼容测试没有删除失败断言：旧股票夹具显式冻结 legacy，原先未支持的 bar-orders-v1 现在已支持，未知版本用 `future-bar-orders-v999` 继续断言拒绝。另正向覆盖三种已支持股票执行模型的下单/推进/幂等；既有 v1 取整、恢复/复练和板块边界回归仍通过。加密验证脚本的输出也改为可配置、默认独立临时证据目录，避免重跑覆盖旧证据。

## 真实旧库恢复与版本冻结

由**各自原版本的代码**生成三个独立临时账本，再由组合候选打开；没有把组合版本生成的库冒充旧库，也没有拼接用户账本。旧库原有 replay 表的每一行、每一列均先保存指纹，迁移后逐项核对；新增兼容列可按既有迁移补充，但不重算原账户/快照/成交/评分。重新以全新目录运行过最终脚本。

| 来源 | 旧会话 | 验证结果 |
| --- | ---: | --- |
| 5807ba8 legacy | 2 | 原 12 张 replay 表原列一致；恢复 legacy，继续与重试、原模型复练、首次不变 |
| 7ea07cc 新 A 股 | 4 | 原 12 张 replay 表原列一致；恢复 bar-orders-v2 的主板/创业板/科创板及活动委托，继续、复练及原成绩保留 |
| 组合前加密快照 | 3（BTC/ETH＋已有复练） | 原 16 张 replay 表原列一致；禁用行情 source 后恢复/推进/显式复练仍成功，精确资金及首次不变 |

随后在每个已迁移的同一数据库中创建另一市场会话，历史分组和 A 股统计仍隔离；不是只验证两份互不接触的数据库。[最终运行记录](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/migration-final.log`）、[分路径状态与原列指纹](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/migration`）、[可复用验证脚本](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/runners/restore-worker.mjs`）。

## 回归与界面证据

| 检查 | 结果 |
| --- | --- |
| 组合后端全量 | 355 passed，0 failed；含 3 项新增混合市场回归 |
| 前端单元全量 | 210 passed，0 failed |
| Python 引擎 | 93 passed；A 股提交的 90 项＋加密下载器的 3 项离线测试 |
| ESLint / 生产构建 | 通过 |
| A 股浏览器全量 | 52 passed；限价/止损/撤单/部分成交、板块、对照/统计与原有页面 |
| 冻结 BTC/ETH 预览、图表、复盘 | 6 组通过，pageerror 0 |
| F2/F3 故障恢复及首次对照 | 6 组通过，pageerror 0 |
| F5 无数据、小样、历史池 | 3 种干净目录通过；8 组实际资产异常检查通过，pageerror 0 |
| 同一真实 app/账本混合市场 HTTP＋浏览器 | 通过；两种历史各 1 条，A 股统计只含 A 股；比较及跨会话撤单拒绝且账本不变；两页面切换无串线，pageerror 0 |
| 纯计算/执行与原始资产 | P2/P3a/P3b 的 12 文件 SHA256 不变；原小样 487 文件、历史池 7622 文件完整 hash 链再次通过 |

对应日志在证据目录；[加密专项](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/verification/crypto-insights/insights-browser-validation.json`）、[恢复](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/verification/crypto-recovery/recovery-browser-validation.json`）、[冷启动](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/verification/crypto-cold-start/cold-start-validation.json`）、[混合市场](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/verification/mixed/mixed-http-browser.json`）。

同库切换截图：[合约历史](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/verification/mixed/mixed-crypto-history.png`）、[股票历史](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/verification/mixed/mixed-stock-history.png`）。

## 可复核的候选与剩余事项

候选补丁（均未应用回原工作区）：

- [相对已提交 A 股 7ea07cc 的完整候选](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/candidate-over-ashare.patch`）：可在该提交的干净隔离副本应用。重新实跑 apply 后，466 文件指纹与受测候选完全相同；[重建证明](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/patch-reconstruction.json`）。这也是清理临时仓库后复现候选的主要入口。
- [相对本轮加密工作文件快照的候选差异](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/candidate-over-crypto-snapshot.patch`）：用于审查 A 股增量与集成修正，不能直接套到一个后来又改变的加密工作区。
- [ADR 映射](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/adr-mapping.json`）、[逐文件指纹](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/candidate-files.json`）固定本轮受测版本。补丁不包含行情资产、用户账本或依赖目录。

**剩余处理顺序：**

1. **正式整合尚未进行。** G1-I1/I2/I3 和文本/ADR 处理只在候选补丁中。下一步若获正式整合授权，应锁定这里的两个来源和提交范围，应用同一组合方案；当前原加密分支不能因为候选通过就被称为已包含新 A 股。若换目标提交或加入未提交 TDX 改动，需重新审视对应增量。
2. **提交范围和文档整理仍需落实。** 完整候选保留既有研究与历史证据用于复核；正式提交前应明确哪些归档入库，不把 storage 或其他工作一并加入。相对 A 股完整补丁有 34 处既有文档/日志/嵌套 patch 的空白提示（其中 3 份研究文档末尾空行）；运行代码/测试和本轮集成增量的空白检查通过。本轮未为了格式检查改写历史红色日志或补丁。详见[记录](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-g1-integration-2026-10-21/full-patch-whitespace.log`）。
3. **原非阻塞 S1/N1 保留。** 金额/配置数据的组织优化与人工构造坏目录的 schema 错误分类加固不在本轮顺手重构；已接受 v1 资产没有新增功能阻塞。冻结行情仍使用 F5 的本地/备份离线交付，没有发布公开数据包。

本轮完成的是已确认版本的隔离组合验证和可审查补丁。未正式合并、未推送、未修改两边业务文件或原索引；现有用户测试服务仍保持原版本。
