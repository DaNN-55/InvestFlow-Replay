# F5 行情冷启动交付修复

日期：2026-10-21。分支 `codex/okx-crypto-training`。状态：F5 已实现并通过本轮验收；不提交、合并或推送。

## 成功条件（实施前冻结）

| 编号 | 可检查的结果 | 对应改动 |
| --- | --- | --- |
| C1 | 干净目录无行情时汇总为 0，界面提示准备步骤并禁止新建，保留历史恢复入口 | 真实数据 readiness、创建表单 |
| C2 | 冻结小样可离线准备到独立目录，BTC/ETH 各 1 个；历史池为 210 个；校验失败不发布、不假装回退 | 版本固定的准备与校验命令 |
| C3 | 原始资料、规范化文件、规则、索引按已冻结 SHA256 校验，重复准备幂等，冲突不覆盖 | 导入及完整性校验 |
| C4 | 三种目录经真实源及服务验证；行情离线并重启后旧会话可恢复和显式复练，原结果/版本/账本不变 | 独立临时数据与数据库验证 |
| C5 | 文档命令可执行；说明资产从何而来、离线导入和官方重新采集的区别；必要回归通过 | 数据指南、配置示例、验证证据 |

历史 F5 红色证据保留在原审查目录。本轮使用新的证据目录，不覆盖旧截图、结果或冻结资产。

## 根因与实现

原回退分支只要没有历史池指针，就固定报告两个小样；小样源直到创建时才检查文件，且读仓库固定目录。沿用已归档的确定性复现，无需再猜测多个故障原因。新增空目录回归先红（实际 2、期望 0），再修复；[红色记录](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f5-fix-2026-10-21/regression-red.log`）与原审查证据都保留。

- `replay-crypto-data.js` 固定已验收 v1 的 manifest/catalog/规则/准入报告根指纹，沿索引校验 raw 和规范化文件。新增 `crypto-data.mjs status/check/prepare`；先完整校验来源，再复制自有暂存目录并复核，完整版本发布后才原子创建池指针。重复导入核验后成功；来源损坏、同名目标冲突、指针冲突均拒绝，不覆盖或补零。
- `createFrozenOkxSource({ dataRoot })` 提供实际 summary；缺失或损坏为不可用/0。历史池 summary 检查规则及全部 3290 个规范化文件，缺指针或文件仍拒绝，不悄悄回退。文件身份未变时复用 hash，但每次检查文件元数据；实际加载仍核验 bytes。
- `standalone-server.js` 接入独立 `INVESTFLOW_REPLAY_CRYPTO_DATA_ROOT`，默认目录保持原样，与原账本根目录分开。`sample` 模式也使用同一配置。没有改数据库结构、执行/费用/强平版本或已冻结资产。
- 无数据时使用现有界面控件禁用新建，并显示准备与校验指引；表单提交本身也有同一限制。历史恢复仍可用。README、环境变量示例、[准备指南](../crypto-data.md)与 ADR-0013 补充交付约束。

## 验收结果

[独立冷启动验证](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f5-fix-2026-10-21/cold-start-validation.json`）实际执行 CLI 离线导入及全量校验，使用三个干净目录、独立 SQLite、实际 standalone 配置及真实浏览器：

| 成功条件 | 证据与结果 |
| --- | --- |
| C1 | 空目录汇总为 unavailable/0；浏览器禁止新建且显示指引；绕过按钮直接 HTTP 创建返回 503 + not-committed，没有会话入账 |
| C2 | 小样导入/复核 487 文件、24,037,859 字节、两币各 1 场景；历史池 7,622 文件、254,163,597 字节、两币各 105 场景；重复准备幂等，不复制 app/交易记录 |
| C3 | 8 组真实资产故障检查：两种配置的规范化/索引损坏、raw 源损坏，及历史池指针冲突/缺失；拒绝发布或覆盖；unit 另覆盖摘要缓存失效、缺文件、路径和链接越界、假 manifest |
| C4 | 两种配置均实际开 BTC/ETH、成交、结束、盲评和揭晓；停服后移走仅属于测试目录的行情并重启，旧状态/账本逐项相同；两币均原版本复练且重复请求幂等，首次结果不改；SQL 冻结快照 hash 一致 |
| C5 | 文档所列 prepare/check/status 路径已在干净目录实跑；不泄露候选日期/路径；提前请求未来一分钟被服务端拒绝；7 张冷启动/恢复截图，浏览器运行异常 0 |

截图：[无数据](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f5-fix-2026-10-21/empty-setup.png`）、[小样](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f5-fix-2026-10-21/sample-setup.png`）、[历史池](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f5-fix-2026-10-21/pool-setup.png`）、[小样离线恢复](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f5-fix-2026-10-21/sample-offline-restored.png`）、[历史池离线恢复](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f5-fix-2026-10-21/pool-offline-restored.png`）。截图已目视检查无数据提示和布局；机器流程同时核对按钮和历史选择。

`status` 只检查运行依赖；原始资料不参与日常回放，因此仅 raw 损坏时可以仍显示运行可用，完整 `check` 和迁移 `prepare` 必定拒绝。该区别在指南明确说明。已发布池故障不会用小样掩盖。

## 回归与边界

- 后端最终 **296/296** 通过（本轮新增 4 项），前端 **199/199** 通过，lint 无警告，构建通过。日志均在本轮证据目录。
- P2/P3a/P3b 的 **12 个纯计算/执行基线指纹不变**；原始小样和历史池全量 hash 链复核通过，未重新下载或修改。见 [基线](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f5-fix-2026-10-21/pure-baseline-check.json`）、[小样核验](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f5-fix-2026-10-21/original-sample-check.json`）、[历史池核验](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f5-fix-2026-10-21/original-pool-check.json`）。
- F2/F3 的 6 组真实 HTTP/浏览器回归通过：[结果](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f5-fix-2026-10-21/f2-f3-rerun/recovery-browser-validation.json`）。F1/F4/F6 的 6 组冻结两币真实浏览器回归也通过，运行异常 0：[结果](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f5-fix-2026-10-21/f1-f4-f6-rerun/insights-browser-validation.json`）。
- F1/F4/F6 原验证入口只在临时副本调整证据输出目录，原入口和旧证据不覆盖；[适配指纹](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f5-fix-2026-10-21/runner-adaptation.json`）可核对。临时副本和临时数据/服务运行后清理。
- 本地测试入口仍为 `http://127.0.0.1:5182/decision/crypto-replay`，原 `crypto-user-testing` 账本和默认历史池。后端重启加载修复后以独立 agent-browser 会话只读检查；各表重启前后指纹一致，没有自动测试写入用户账本。见[只读界面记录](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f5-fix-2026-10-21/user-service-readonly-snapshot.txt`）。

当前 v1 资产只有已有本地目录及备份，**没有公开托管包**。本轮交付可验证的离线安装流程；仅有 Git 代码的新机器需先取得冻结资产。指南列出官方重新采集工具与边界，但本轮未执行联网采集，新抓取时间/响应字节不能冒充原 v1；加入新版本需要另行准入。未扩大币种、年份或数据池。

F5 的个人离线冷启动交付判据已满足。G1 与新 A 股组合的集成验收仍开放；没有合并、推送或提交，不能把本轮修复通过等同整体可合并。

完整汇总、最终代码指纹和服务状态见 [fix-summary.json](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f5-fix-2026-10-21/fix-summary.json`）。既有四个运行文件的本轮精确差异见 [补丁](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f5-fix-2026-10-21/existing-source-changes.patch`）。
