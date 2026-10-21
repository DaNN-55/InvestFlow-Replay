# 加密分支 F2 故障恢复与 F3 首次对照修复

日期：2026-10-21。分支 `codex/okx-crypto-training`。结论：**F2、F3 已按原审查触发条件修复并验证；其余问题保持开放，不代表 P1–P6 已整体通过。** 未合并、推送或提交。

## 成功条件与改动对应

| 可检查结果 | 实现与验证 |
| --- | --- |
| 新建因行情源缺失而明确未落账后，可以恢复已存会话 | 服务端只在读取新场景且尚未进入持久化之前，返回 `details.actionOutcome: not-committed`；控制器仅对创建的这一明确拒绝解除 pending。真实 503→刷新→恢复 BTC 已通过 |
| 提交结果未知时仍能查历史，但不能重复提交或静默丢弃动作 | 保留原 actionId、原会话 ID、expectedRevision 和完整请求；历史切换/图表周期只读可用，所有业务写动作及新开继续锁定。泛化 5xx、网络错误、无法解析的 2xx 响应均保留待核对 |
| 失效引用不会卡死开局与历史入口 | 会话 GET 404 后清除失效引用及旧行情/轨迹显示，继续加载历史和行情池汇总；若有待核对动作则仍保留。刷新后不再反复请求失效 ID |
| 重试始终回到原动作所属会话且只入账一次 | 真正创建后把响应替成普通 503；真正追加 500 USDT 后丢失响应。两者刷新并切换其他会话后重试，创建/入金及追加都只发生一次，且继续读取最新状态 |
| 删除首次后，已揭晓复练仍有首次判断、参数和结果 | 专用首次对照读取包含软删除首次，并沿用现有 row 校验和 review 读取；普通会话 GET/历史仍排除删除项。BTC/ETH 删除后重启、禁用新行情源，显示与删除前相同的冻结摘要 |
| 不扩大公开边界或改写旧结果 | 未揭晓子会话不带 `firstAttempt`；已删除首次普通读取为 404，历史列表不复活，已见限制仍保留。子会话结果、快照和账本不变；无新 schema、规则或执行版本 |

## 改动范围

- `web/src/utils/cryptoReplayController.js`：明确拒绝与未知结果分开；失效引用回退；pending 时允许只读恢复。
- `web/src/views/CryptoReplayView.vue`：历史选择与周期切换仅在读取忙碌时禁用；待核对提示说明可以查看历史。新开/推进/委托/复盘等写操作仍锁定，沿用既有 Dan UI 控件。
- `backend/src/replay-crypto-session.js`：只对新场景源获取失败附加“未提交”结果。事务阶段、响应呈现阶段错误不附加该保证；已提交创建重试优先从数据库返回，不访问当前源。
- `backend/src/replay-crypto-persistence.js` 与 `backend/src/db.js`：专用首次对照读取包含软删除行，注入现有 review reader；不开放普通删除记录读取。
- 后端新增 3 项、前端新增 4 项回归；新增独立验证入口 [verify-crypto-recovery.mjs](../../backend/scripts/verify-crypto-recovery.mjs)。

相对本轮开始的 5 份业务源文件的精确改动见 [business-changes.patch](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f2-f3-fix-2026-10-21/business-changes.patch`）。本分支原有 P1–P6 尚未提交，不能把与旧 HEAD 的整个差异误当成本次修复。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 修复前定向回归 | 前端原有 6 项通过、新增 4 项失败；后端新增 3 项失败。分别对应 pending/404/未知成功响应及两币删除对照、源失败契约 |
| 修复后定向回归 | 前端 10/10；后端新增 3/3 |
| 后端完整回归 | **285/285**；包含原资金计算/执行/事务与本分支 legacy A 股兼容 |
| 前端完整单元回归 | **195/195** |
| 前端完整 lint、生产构建 | 均通过 |
| 实际 HTTP＋浏览器 | **6/6**；页面运行异常 0；使用原冻结 BTC/ETH 和临时 SQLite/临时服务 |
| 原基线核对 | P2/P3a/P3b 的 **12 份纯计算/执行代码与测试指纹未变**；seed manifest、pool catalog SHA256 未变 |
| 修改范围核对 | 与整体验收记录相比，只有列明的 7 份既有业务/测试文件发生本轮改动；新增验证脚本及本次报告/证据另列 |

真实浏览器六组：

1. 原 F2 的新场景源 503→刷新→恢复已有冻结 BTC。
2. 原 F2 的不存在/其他存储引用 404→历史可选→恢复。
3. 创建已提交但收到普通 503→刷新→只读切到 BTC→原请求重试，ETH 仅一个会话、一份初始账本。
4. BTC 追加保证金已提交后丢响应→刷新→只读切到 ETH→原请求重试，BTC 只转入 500 USDT。
5. 原 F3 的 BTC 首次/复练均揭晓→软删除首次→重启且禁用当前源→首次对照仍可见。
6. 同一 F3 条件在 ETH 通过；未揭晓子会话不出现首次摘要，删除项保持隐藏。

源故障在临时来源边界注入，与原审查“汇总可读但加载新场景失败”的条件相同，没有删除实际行情文件。未知 503 在真实创建已提交之后注入，追加则在真实动作提交后丢弃响应。自动验证未读取/修改用户手动测试账本。

原审查的 [F2 复现](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-premerge-audit-2026-10-21/repro-ui-recovery.mjs`）、[F3 复现](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-premerge-audit-2026-10-21/repro-deleted-first.mjs`）及结果保留原样，作为修复前缺陷快照；它们断言的是旧错误，不将旧断言改成“通过”。本轮在新回归与真实浏览器中复用相同触发条件并断言正确结果。

新证据：[机器汇总](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f2-f3-fix-2026-10-21/fix-summary.json`）、[HTTP/浏览器逐项记录与当前代码 hash](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f2-f3-fix-2026-10-21/recovery-browser-validation.json`）、[BTC 首次对照截图](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f2-f3-fix-2026-10-21/btc-deleted-first-comparison.png`）、[ETH 首次对照截图](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f2-f3-fix-2026-10-21/eth-deleted-first-comparison.png`）。同目录保存修复前失败及修复后通过日志。运行验证入口：

```bash
node --no-warnings backend/scripts/verify-crypto-recovery.mjs
```

该入口自行建立并清理临时服务与数据库。现默认将新结果写入 `.runtime/crypto-recovery-evidence/`，可通过 `INVESTFLOW_CRYPTO_EVIDENCE_DIR` 指定新证据目录，避免覆盖历史快照。没有重跑下载器或重建整池；相关实现未改，本轮不扩大验证或数据池。

## 当前手动测试服务

页面：**http://127.0.0.1:5182/decision/crypto-replay**。后端 `127.0.0.1:3112`，已重启加载修复版本，前端由开发服务更新。已通过浏览器确认入口正常，并能显示实际 `okx-2024-2025-v1` 历史池。页面检查只读，没有替用户新建练习。

手动测试持久账本位于本工作树 `storage/crypto-user-testing/app/replay.sqlite`。与原目录和正式账本分开，刷新/后端重启保留记录；不删除这些测试记录。行情仍读取当前工作树的冻结 pool。该服务用于加密页面检查；没有为此启动/整合新版 A 股或通达信服务。

## 剩余与边界

F2、F3 在本加密工作区关闭。F1 开仓预览/风险字段、F4 图表联动、F5 冷启动交付、F6 复盘指标及 G1 与新 A 股组合后的集成验证仍未处理。原整体验收状态仍为未通过；没有扩币种/年份、改变教学结算、修其他问题、提交、合并或推送。


## 展示证据来源补记

同日 F1/F4/F6 回归曾误用本报告的输出目录，覆盖三张截图及浏览器机器记录。已将当次结果另存到 [本轮恢复回归](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f1-f4-f6-fix-2026-10-21/f2-f3-rerun/recovery-browser-validation.json`），再用实施 F1/F4/F6 之前的源码临时副本重建这里的旧版本展示证据。原修复汇总中的全部 8 份代码指纹均匹配，原版本六组流程再次通过；原 `fix-summary.json`、修复前失败日志和审查复现保留。这里三张截图是原版本重建截图，不能称为取回了原始像素文件；[重建来源与 hash](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f2-f3-fix-2026-10-21/evidence-regeneration-provenance.json`） 已记录。训练数据和用户账本未受影响。

原版本的 16 份源码覆盖层及其 SHA256 已保存为 [隔离重建源码包](HISTORY.md#local-archive)（本地归档：`docs/research/crypto-f2-f3-fix-2026-10-21/original-version-source-overlay.zip`），用于在隔离副本复现上述重建，不覆盖当前工作树。
