# 死代码清理记录

日期：2026-10-25。基线：`main` / `f5de962`，开始时工作区干净。清理范围为当前仓库内可确认没有消费者的实现；实施与验证阶段未提交或推送，后续提交授权见文末。

## 已清理

| 内容 | 调用与历史证据 | 处理边界 |
| --- | --- | --- |
| `web/src/components/TradeExecutionSettingsDrawer.vue` 及 `api.saveDecisionExecutionSettings` | 组件从 `web/src/main.js` 不可达，保存包装仅被该组件调用。`055739a` 主动删除页面导入、按钮和组件挂载；`trade-record-detail.spec.js` 明确验证只读设置与无修改入口 | 删除组件、其 scoped 样式和前端保存包装；保留设置读取、共享 UI 组件、后端读写路由及数据层方法 |
| `MinuteReplayStore.full_history_codes` | 全仓 Git 跟踪源码中只有声明；Python 方法调用及动态分发检查未发现消费者 | 只删除查询方法；保留 `has_full_history`、同步标记及数据库表 |
| `TdxMarketCache.has_successful_sync` | 全仓 Git 跟踪源码中只有声明；当前准备流程使用 `synced_today` 与缓存状态 | 只删除查询方法；保留同步写入、状态查询与 schema |
| `quantityDraftCommand` | 唯一消费者是 `cryptoProtectionDraft.test.js`；当前修改流程使用 `createOrderDraft` / `orderDraftCommand` 生成 `amend-order` | 删除旧前端命令构造器；原数量边界、规范化、成交快照断言保留，命令与过期校验改为测试当前组合改单接口；保留后端 `amend-quantity` 处理 |
| 后端未使用声明及重复项 | ESLint 发现 `build-crypto-pool.mjs` 的 `readdirSync` 和 `isCompleteDailyClose` 的内部 `throughSequence` 参数未使用；`publicErrorCode` 的数组中两项重复 | 删除导入、内部参数及其传值和重复数组成员；外层事件检测的游标参数继续保留 |

源码与测试共 9 个文件发生变化，净减少 180 行；测试用例数量没有减少。未增加依赖或修改锁文件。

## 排除误报

- `createQuantityDraft`、保护草稿 helper、指标解析器等虽然没有模块外生产调用，但有模块内调用，保留。
- Backend CLI 的数据构建、验证及导入入口仍有效，不能因不从 HTTP 服务导入就删除。
- FastAPI 装饰器注册的处理函数、TDX 动态转发、历史账本兼容和离线 fixture 均保留。
- 旧审计 `cleanup-audit.md` 的高置信度候选已处理，不重新按旧快照执行清理。架构图保留其原源码快照，本轮没有重新生成架构资产。

## 验证

| 检查 | 修改前 | 修改后 |
| --- | --- | --- |
| Web 单元测试 | 329/329 | 329/329 |
| Backend 全量测试 | 375/375 | 375/375 |
| Engine 全量测试及 OKX 下载脚本测试 | 99 项及 274 个 subtest 通过 | 99 项及 274 个 subtest 通过 |
| 代表性浏览器场景 | 4/4 | 同一组 4/4 |
| 完整浏览器回归（追加验证） | 未执行 | 117/117 |
| Web ESLint | 通过 | 通过 |

首轮 4 项浏览器场景覆盖设置只读与刷新、设置读取失败仍可查看记录、数量修改过期拒绝，以及组合改单的只读预览与单次提交。合约路径使用真实临时 HTTP 后端及 SQLite；交易追踪场景沿用原 API mock。随后按用户追加要求执行全部 117 项浏览器回归，结果见下文。

修改后 Vite 构建、Backend 全源码及脚本的未使用变量/不可达代码检查、`git diff --check` 均通过。两个 Engine 文件通过删除前后 AST 对比，确认除目标方法外其余语法树完全相同。

导入图通过 Espree 与 Vue SFC parser 解析，覆盖静态 import、字面量动态 import 和 re-export。清理前 Web 110 个模块中仅已删除抽屉不可达；清理后 Web 109 个模块与 Backend 25 个模块均从应用、服务或 CLI 入口可达，无未解析导入或非字面量动态导入。可达性不等于每个模块内部都没有死分支，未据此作全仓零死代码保证。

Engine 默认存储重定向到新建临时目录；临时 Vite 仅使用独立 5297 端口，验证后已退出。没有操作正式数据、服务或真实行情池构建。验证日志保留于 `/tmp/investflow-dead-code-*-before.log` 和 `/tmp/investflow-dead-code-*-after.log`。

## 独立审查与完整回归（追加验证）

用户要求子 Agent 独立检查并执行完整浏览器回归，先不提交或推送。审查基线仍为 `f5de962` 与本次未提交 diff。

- Standards 轴：只读审查 Agent 未发现可操作缺陷；确认最小改动、共享能力保留，数量边界、规范化、成交快照和过期拒绝断言没有削弱。独立 Backend 未使用变量检查为零。
- Spec 轴：另一只读 Agent 未发现可操作缺陷；重新核对历史入口移除、每个删除项的调用和动态分发、Python AST 及错误码输出等价性，确认没有遗漏目标或越界清理。

主 Agent 复核了关键差异、当前组合改单消费者及后端兼容处理，并运行 `playwright test tests/e2e --workers=1`，不使用场景筛选。收集 14 个文件、117 个场景，最终 **117/117 通过**；结构化报告确认 117 次执行、零重试、零失败、零跳过、零 flaky、零全局错误，耗时 111.48 秒。

本轮使用独立 5297 端口，默认 API 代理指向未启用的隔离 5399 端口；真实后端场景沿用原临时 SQLite fixture，其他场景沿用原 mock。没有启动正式服务或访问正式账本。临时 Vite 已退出。

验证前后 380 个受 Git 跟踪文件的指纹完全一致（包含已删除文件的缺失状态；仅排除本计划与审计文档），所有浏览器测试及业务源码未变，HEAD 仍为 `f5de962`。仅更新本轮计划与审计结果，未提交或推送。

完整日志、JSON 结果、源码指纹及核对摘要位于 `/tmp/investflow-dead-code-review.K1NhYZ/`：`e2e.log`、`results.json`、`source-before.json`、`source-after.json`、`verification.json`。

## 外部证据限制

当前没有可用的 Slack、Statsig 连接器，仓库代码和配置未发现 Statsig 或实验开关接入。本轮依据仓库调用图、配置、现有测试和 Git 历史判断；未把静态检查表述为外部零使用量证明。

## 本地提交授权

用户随后确认将本次死代码清理和验证记录独立提交，先不推送，无关内容不纳入。提交范围为 9 个源码/测试文件、`PLAN.md` 和本记录，共 11 个文件。提交前再次核对 380 个跟踪文件的指纹与独立验证版本一致；没有新的实现改动，沿用上述检查结果，不重复运行测试。
