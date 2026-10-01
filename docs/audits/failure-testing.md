# Failure-Oriented Testing

审计日期：2026-10-01。对象：`InvestFlow-Replay` 当前工作区，HEAD `29e745ed414746a36660ef62d3e2bd71eb161419`。

> 后续修复阶段（2026-10-01）：用户已授权在新分支 `codex/failure-testing-fixes` 依次修复 B1–B5，现已全部修复，完整验证 **422 passed**。下面保留首次审计的原始结果及修复前源码行号；修复和验收记录见文末，不将历史红灯结果改写成未曾发生。

## 结论与范围

原有 **395 项测试全部通过**，仍实测复现 **5 个业务/恢复缺陷**：失败请求污染文件账本、损坏文件阻断正常记录、重复成交重复记账、null 行情价格被作为零价格接受、取消复练部分成功后恢复目标丢失。

本次验证 15 个架构相关场景，新增 17 项测试。6 项正确行为断言因上述 5 个未修复问题报红（失败写入分别覆盖 POST 和 PATCH）；其他新增断言保护此前没有直接验证的故障边界。没有用 skip、todo、预期失败或反向断言掩盖缺陷。

仅新增本报告和两个测试文件，不修改业务代码、不删除或修改已有测试、不操作正式数据、不提交、不 push、不创建 PR。审计开始时已有的 5 个 Python 文件改动作为 baseline 的组成部分保留；这些改动不是本次成果。

## 产品路径、数据流与状态边界

| 路径/层 | 当前实现与持久化 | 失败测试关注点 |
| --- | --- | --- |
| 创建演练 | Vue `MarketReplayView` → `useReplayAttempt` / `useReplaySession` → Web API → Express `replay-interaction` → `replay-lifecycle` → Python Engine 场景 API | Engine 失败是否留下半成品；异常载荷是否进入账本 |
| 行情供应 | Python `ReplayMarketSupply`、`DuckDbBarStore`、TDX 日线/分钟 provider；通达信经 `pytdxdata` 进入 DuckDB；fixture provider 使用确定性合成行情 | 缺失、空缓存、错价、重复日期、网络失败、预取中断与前后台协调 |
| 交易与推进 | 场景创建后冻结到 SQLite；`replay_sessions`、orders、executions、events、reviews、drafts、playbooks 等保存在应用账本 | `actionId` 幂等、`expectedRevision` 乐观并发、SQL 事务回滚、重开后重试 |
| 揭晓与复盘 | 先完成会话，再保存盲评、揭晓、保存事后复盘；修正另行记录；`presentReplaySession` 投影可见状态 | 阶段顺序、匿名信息隔离、旧记录迁移、原始判断与评分不被覆盖 |
| 浏览器状态 | Vue composable 的响应式状态；`useReplayAttempt.runWrite` 与 session busy 标志串行化写命令；localStorage 仅保存 `investflow.replay.active-session-id` | 服务端成功但客户端未收到响应；多步操作只成功第一步；刷新恢复 |
| 草稿 | `useReplayReviewDrafts` 防抖、单阶段串行保存、generation/session 检查；草稿有独立 revision；内存保留未保存文本 | 在途响应、切换会话、CAS 冲突、编辑内容是否被服务器旧快照覆盖 |
| 交易追踪档案 | `TradeRecordsView` → `useTradeRecordArchive` → `/api/quant/decision/trade-records`；每条追踪单一个 JSON 文件，读取时计算 ledger；执行参数在 SQLite | 文件损坏隔离、失败写入的原子性、重复执行事件；该路径不复用演练 actionId 机制 |

主要使用闭环为：配置日线/日内模拟 → 匿名观察 → 提交委托 → 推进与成交 → 完成或提前交卷 → 盲评 → 揭晓 → 事后复盘/修正 → 历史查看、复练与战法版本。另有独立的交易追踪单创建、许可、执行动作、持仓与退出路径。上述两条路径的存储和并发保护不同，不能用演练幂等测试推断文件账本也具备幂等性。

本次理解来自当前 `CONTEXT.md`、README、应用入口、路由、composable、交互/生命周期/store、数据库迁移、行情供应实现和现有测试；没有把历史设计中的累计账户方案当成已实现功能。

## 当前测试 baseline

环境：macOS，Node.js `v24.20.0`，Python `3.11.15`；使用已安装依赖，未升级。

| 测试集 | 命令/隔离方式 | 开始时结果 |
| --- | --- | --- |
| Engine | `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=engine INVESTFLOW_REPLAY_STORAGE_ROOT="$AUDIT_TMP/engine-storage" INVESTFLOW_REPLAY_MARKET_DB_PATH="$AUDIT_TMP/engine-storage/market/market.duckdb" .venv/bin/python -B -m pytest engine/tests -p no:cacheprovider` | 81 passed，22.08 s |
| Backend | `npm test --prefix backend` | 100 passed，2.36 s |
| Web unit | `npm run test:unit --prefix web` | 177 passed，0.51 s |
| Web E2E | 独立 Vite `127.0.0.1:5587`；在 `web/` 运行 `PLAYWRIGHT_BASE_URL=http://127.0.0.1:5587 npm exec -- playwright test tests/e2e --output "$AUDIT_TMP/baseline-e2e-results"` | 37 passed，9.2 s |
| 合计 | 完整的 4 套现有测试 | **395 passed，0 failed** |

`AUDIT_TMP` 为 `mktemp -d` 创建的专属目录。Python 同时重定向默认存储根和显式行情库路径；Backend 用例使用临时 SQLite/JSON 和本机随机端口。E2E 复用现有 Playwright 测试，Vite 后端代理配置为未运行的隔离端口 `5588`，避免接触正式 Backend。没有运行正式 `run.sh`、安装或重置脚本。

最初受限运行遇到 Vite `listen EPERM`，Backend 也在监听阶段停滞；它们不计入 baseline 成功。经权限流程允许本机监听后重新运行，以上为完成结果。已停止本次受限运行残留的测试进程。

### 现有测试覆盖了什么

- **Engine**：可重复场景、拆分/分红复权、重复日期、null/非法 OHLC、交易日历缺口、基准对齐、缓存不足、离线降级、显式重试、主机切换、分钟预取部分完成和前后台互斥。大多使用临时 DuckDB 与 fake provider，不测试当日真实 TDX 服务。
- **Backend**：真实 Express/SQLite 配合模拟 Engine HTTP；匿名投影、创建与恢复、T+1、停牌/涨跌停/费用、相同 actionId 重试、并发不同 actionId 的 revision 冲突、整日推进触发器失败回滚、盲评/复盘阶段门禁、修正不可覆盖原记录、迁移和草稿 CAS。交易追踪已有正常 CRUD、许可校验和超量卖出动作拒绝，但未检查通用 POST/PATCH 被拒绝后的磁盘内容。
- **Web unit**：纯函数、composable 行为及若干源码字符串/界面结构断言。已有档案详情请求乱序保护、草稿防抖/串行化、写命令防重与复练取消成功路径。源码匹配不等于运行时故障验证。
- **E2E**：配置、缓存展示、图表、战法、追踪单和设置交互。多处 `page.route` 固定 API 响应；全部通过不代表已验证 JSON 文件写入、真实三层链路或真实网络异常恢复。

## 15 个场景与实际验证结果

“已有”表示本次重新执行了相应现有测试；“补充”表示用新增隔离测试实际验证，并非静态猜测。

| ID | 失败假设/输入 | 验证与结果 | 原有覆盖与真实盲区 |
| --- | --- | --- | --- |
| F01 | 存储目录不存在、列表为空、访问/更新不存在的记录 | 补充：新目录列表 `[]`；详情/PATCH 404；首条写入后关闭并重开应用可恢复 | 原有路径配置/必填验证不等于空目录→首次写入→重开链路；补齐，通过 |
| F02 | 一个追踪 JSON 文件截断，旁边还有正常记录 | 补充：正常记录详情和整个列表均 500；损坏文件未被覆盖 | **盲区，B2**；原有记录 fixture 都可解析 |
| F03 | 通用创建或修改携带“零持仓卖出 100 股”的账本，被校验拒绝 | 补充 POST/PATCH：请求 400，但新无效文件已落盘/旧文件已改变；后续 GET 也 400 | **盲区，B1**；只检查错误响应不足以验证失败原子性 |
| F04 | 响应不确定时重复 POST 同一个 execution event ID | 补充：两次均 200，事件数 2，持仓 100→200 | **盲区，B3**；演练 orders 的幂等覆盖不到文件账本 |
| F05 | 中文、emoji、组合字符、文件名特殊字符、边界长度和坏 JSON | 补充：名称与 1000 UTF-16 code unit 备注重开后原样恢复；1001 拒绝且原文件不变；截断请求 400、超过 2 MiB 请求 413，无文件产生 | 原有必填和大 payload 成功路径部分覆盖；补齐内容/文件副作用断言，通过 |
| F06 | Engine 断开 socket、200 截断 JSON、200 HTML | 补充：分别 500/500/502，均结构化错误，SQLite 会话数保持 0 | 原有只模拟合法结构的 400/409；补齐传输与解析失败边界，通过不落库要求；错误分类差异保留为边界说明 |
| F07 | 场景数组空、长度足够但价格字段缺失/null | 补充：空数组 502，不落库；缺失 OHLC 探针 500，不落库；**全 null OHLC 却 201，落库 1 条，前端输出零价格** | Engine 内有 null 校验；Backend 场景接收边界仍有 **盲区，B4** |
| F08 | SQLite 某条会话 `account_json` 损坏 | 补充：读取/推进 500；revision/进度仍 0，损坏字节未被覆盖 | 原有旧数据测试不是损坏数据测试；补齐 fail-closed 断言，通过 |
| F09 | 并发/重复推进、执行到一半 SQL 失败、关闭后重试已成功命令 | 已有并发订单/推进与整日触发器回滚全部通过；补充应用 dispose 后重建，订单/推进重复均幂等、成交和资金不变，改数量重试 409 | 事务和运行中幂等已有；持久化动作日志重开后幂等为新增验证，通过 |
| F10 | 旧版本数据缺训练/草稿/修正/复练元数据；先揭晓后盲评等错误顺序 | 本次运行现有迁移 fixture 与状态门禁用例：全部通过 | **已有覆盖**，没有复制新增同义测试；不代表任意历史库均已验证 |
| F11 | 快速连续点击；推进已提交但响应丢失，再点击推进 | 补充真实 session composable：在途只发一次；提交后断线重试遭 409 并刷新，最终只前进一根 | 原有 busy/409 分开测试；补齐具体响应丢失时序，通过 |
| F12 | 多步操作第一步成功、第二步网络失败 | 补充：“结束并换一局”失败仍保留已完成会话，通过；“取消复练”删除成功、加载来源失败后仍存已删除 ID，重建 composable 恢复为 null | 成功路径已有；**部分成功盲区，B5** |
| F13 | 草稿确认丢失，另一页随后保存，当前页继续编辑并收到新服务器快照 | 补充真实草稿 composable + CAS mock + 虚拟定时器：旧 revision 重试失败、状态 failed；本地新文本和服务器另一版本均保留，不静默覆盖 | 原有串行保存/切换已有；补齐传输丢失叠加冲突的内容保护，通过；没有验证用户级冲突解决流程 |
| F14 | 日线数据重复、缺价、OHLC 不合法、日历/基准缺口 | 运行 `test_replay_scenario.py` 的相关临时库用例及 cache 去重用例，全部通过 | **已有覆盖**；没有为这些分支复制测试。与 F07 不同，此处在 Engine 数据入口验证 |
| F15 | TDX 不可用、空缓存、后台同步失败、分钟预取中断、前后台同时取行情 | 运行 `test_error_contract.py`、`test_tdx_market_cache.py`、`test_minute_replay.py`、`test_tdx_connection_reuse.py` 相关 mock 用例，全部通过；中断的 800 条片段不被标成完整 | **已有覆盖**（含审计前未提交的预取测试），未声称真实网络健康 |

F10 的具体证据包括 `replay-training-api.test.js` 的旧训练快照迁移、`replay-review-draft-api.test.js` 的旧草稿表迁移、`replay-review-correction-api.test.js` 的旧修正表迁移、`replay-retrain-api.test.js` 的旧场景首次/复练分配，以及 `replay-session-api.test.js` 的 reveal/finish/review 状态门禁。F09 的已有故障注入通过 SQLite trigger 在整日第二步抛错，检查所有内部推进和事件均回滚。

## 确认的 bug 与最小复现

下面命令在项目根执行，只使用测试自建的临时目录和本机模拟服务。当前均应退出 1；这正是未修复缺陷的信号。优先级描述本项目内的数据与使用影响，不是线上事故评级。

### B1 / P1：失败请求仍改变账本文件（F03）

复现：创建一个空持仓追踪单；向通用 POST 或 PATCH 提供 `executionEvents: [{id:"execution-1", eventAt:"2026-09-01", action:"sell", price:10, quantity:100, fee:0}]`。请求返回 400，但无效账本已保存。POST 留下新文件；PATCH 覆盖旧文件。读取时再次计算 ledger，于是单条和列表也失败。

```bash
node --no-warnings --test --test-name-pattern='^F03' backend/src/standalone-failure-testing.test.js
```

期望：拒绝操作后文件集合和已有文件内容不变。实际：新增 `invalid.json` 对应的追踪文件，或旧 `executionEvents: []` 被改为超卖事件；随后列表/详情 400。原因已定位至 `backend/src/app.js:892` 的 `saveTradeRecordFile`：先 `writeFileSync`，再通过 `parseTradeRecordJson` → `calculateTradeLedger` 验证账本。专用 execution-events 路由会提前计算 ledger，因此它已有的拒绝用例不能发现通用写入路径的问题。

### B2 / P2：一个损坏文件阻断正常记录（F02）

复现：正常创建 `healthy`；在同一临时目录写入 `interrupted.json`，内容仅为 `{"id":"interrupted",`；GET 正常记录 `healthy`。

```bash
node --no-warnings --test --test-name-pattern='^F02' backend/src/standalone-failure-testing.test.js
```

期望：正常记录仍可读取，损坏内容不被静默覆盖。实际：正常详情与列表均 500 `INTERNAL_ERROR`。`app.js:870` 的 `readTradeRecords` 解析每个文件，`findTradeRecordById` 也先读取整库；单文件解析错误直接中断整次读取。此处验证的是损坏后的隔离能力，未模拟真实断电造成损坏。

### B3 / P1：相同成交事件重复入账（F04）

复现：创建追踪单；两次向 `/:id/execution-events` 提交完全相同的 `id: "execution-1"`、买入 100 股、价格 10 的请求。

```bash
node --no-warnings --test --test-name-pattern='^F04' backend/src/standalone-failure-testing.test.js
```

期望：同一事件 ID 只对应一笔账本事件；可以幂等返回或拒绝冲突，但不可重复记账。实际：两次都 200，`executionEvents.length = 2`，`positionQuantity = 200`。`app.js:1050` 的 `recordTradeExecutionEvent` 直接追加；`normalizeTradeExecutionEvents` 没有事件 ID 去重/冲突判定。现有演练订单幂等测试使用另一套 SQLite actionId 机制。

### B4 / P2：null 行情价格成为成功的零价会话（F07）

复现：模拟 Engine 返回完整 270 根行情、250 根观察线和 20 根演练线；保留有效代码、日期与其他字段，将每根 `open/high/low/close` 设为 null；请求创建日线会话。

```bash
node --no-warnings --test --test-name-pattern='F07 bars with null' backend/src/standalone-failure-testing.test.js
```

期望：异常上游行情被拒绝，不落库。实际：201，会话表增加 1 条，可见第一根 K 线的 OHLC 全为 0。`replay-lifecycle.js:40` 主要检查数量；`db.js:119` 的场景身份校验使用 `Number.isFinite(Number(value))`，而 `Number(null) === 0`；投影继续把 null 转成 0。

边界：正常 Engine 的日线数据筛选已有 null/正价校验且通过。本次证明 Backend 无法保护自身免受异常/不兼容 Engine 载荷影响，没有证明真实 TDX 已返回此类数据。字段完全缺失的探针会在身份校验时报 500 且不落库，未把它误报为同样的污染。

### B5 / P2：复练删除后来源加载失败，刷新无法恢复目标（F12）

复现：localStorage 保存 `retrain-1`；该会话来源为 `source-1`。删除复练成功，紧接着读取来源时模拟断线；网络恢复后用同一存储重建 session composable 并同步。

```bash
node --no-warnings --test --test-name-pattern='F12 cancelled retrain' web/tests/unit/replayFailureTesting.test.js
```

期望：取消成功后的恢复目标是仍存在的来源会话。实际：删除后 UI 和 localStorage 仍为 `retrain-1`；重新同步请求已删除记录，404 后会话变 null，丢失本次返回来源的恢复目标。诊断读取顺序为 `["retrain-1", "source-1", "retrain-1"]`。`useReplaySession.js:519` 的取消流程先删除再刷新；非 404 加载失败只记录错误，不变更恢复目标。来源本身没有被删除，可通过历史重新查找；不是整个历史数据丢失。

## 新增测试与执行方式

- [Backend 故障测试](../../backend/src/standalone-failure-testing.test.js)：12 项，覆盖 F01–F09；真实 Express、SQLite、JSON 文件和模拟 Engine HTTP，每例独立目录与随机端口，`t.after` 清理。5 项报红（B1 两项、B2/B3/B4 各一项），7 项通过。
- [Web 故障测试](../../web/tests/unit/replayFailureTesting.test.js)：5 项，覆盖 F11–F13；使用真实 composable、内存 storage、可控 Promise/网络错误、CAS mock 和虚拟定时器。B5 一项报红，其余 4 项通过。

新文件匹配现有 `npm test --prefix backend` 和 `npm run test:unit --prefix web` 的 glob，无需修改测试配置。新增断言检查文件字节、持仓数量、持久化会话数、revision、恢复目标和文本保留，不以覆盖率数字为目标。没有为了保留绿灯修改业务逻辑。

## 完成后的完整验证

报告及测试完成后重新运行全部 4 套测试，并执行 Web lint/build、差异及原有改动核对：

| 检查 | 最终结果 | 退出码 |
| --- | --- | --- |
| Engine 全量，同 baseline 隔离变量 | **81 passed**，25.85 s | 0 |
| `npm test --prefix backend` | **107 passed，5 failed**，共 112 项；失败仅 F02、F03a、F03b、F04、F07-null | 1 |
| `npm run test:unit --prefix web` | **181 passed，1 failed**，共 182 项；失败仅 F12 取消复练后的恢复 | 1 |
| Web E2E 全量，同 baseline 独立 Vite，输出至临时目录 | **37 passed**，8.7 s | 0 |
| `npm run lint --prefix web` | 最终无错误、无警告；清除了新增测试的一处无用初始赋值后复跑 | 0 |
| `npm run build --prefix web -- --outDir "$AUDIT_TMP/web-dist"` | 通过，2.21 s；未覆盖已有 `web/dist` | 0 |
| `git diff --check` 与既有 diff 核对 | 通过；原有 5 个文件逐字节保持原 diff | 0 |

全量结果合计 **412 项：406 passed，6 failed**，无跳过、无 todo。原有 395 项全部仍通过；新增 17 项中 11 项通过、6 项暴露未修复 bug。**完整测试已运行，结果不是全绿。** 没有为让测试通过改变预期结果。

构建仍有既有 Browserslist 数据陈旧和 `@vueuse/core` PURE 注释位置提示，没有因此升级依赖。原有 tracked diff 的 SHA-256 前后均为 `dc791996bffcf61537f0a05449e027cea29eaa253e3c05810349c02c793f195d`。本次新增文件只有两个测试文件和本报告；临时日志中的关键观测已记录在上文，各最小复现命令可重建证据。测试服务、临时数据库、浏览器产物、日志和隔离构建在收尾时清理，已有构建、日志和运行服务不在清理范围。

## 未验证与剩余边界

- 未访问正式 `storage/`、`.demo-storage/` 或线上 TDX；未执行真实网络同步。真实服务协议兼容、主机可用性与实时数据质量仍需独立环境验证。
- SQLite 重启验证为真实数据库关闭/重开和应用实例重建；没有 SIGKILL/断电、磁盘满、系统 I/O 错误或跨进程同时写库的验收。分钟预取中断是 mock 抛错，不能替代操作系统崩溃测试。
- F02 的损坏文件由 fixture 写入；未通过终止写文件进程制造真实截断。未验证整份 SQLite/DuckDB 文件损坏后的启动恢复。
- F05 验证的是实际字段边界（1000/1001 UTF-16 code units）、中文/emoji/组合字符、路径特殊字符和 2 MiB 请求上限；没有枚举所有 Unicode、操作系统文件名长度和 NUL 边界。
- F11–F13 为 composable 层受控时序；没有真实浏览器跨标签页、浏览器禁用/耗尽 localStorage 或 Web→Backend→Python 三层断网注入。E2E 的 mock 边界保持不变。
- F13 在冲突时保住本地文本并显示 failed，但当前测试不证明用户有完整的冲突合并/恢复流程；刷新页面可能丢失只在内存的未保存内容。没有将安全拒写误称为自动恢复成功。
- F06 的断线与截断 JSON 目前归类为 500 `INTERNAL_ERROR`，HTML 成功响应归类 502 `UPSTREAM_UNAVAILABLE`；本次保证失败不产生会话，未为统一错误分类扩大任务。

任务止于测试与报告；上述 bug 全部保持未修复。

## 后续修复验收（已完成）

本节属于用户随后授权的修复阶段；前面的“未修复/不修改业务代码”描述首次审计的工作范围。

| 顺序 | 可检查的成功条件 | 对应改动范围 |
| --- | --- | --- |
| B1 | 拒绝 POST/PATCH 不增添或改变账本文件；写入失败保留原内容 | 追踪文件写入前完整校验及同目录替换 |
| B2 | 损坏文件保留，正常记录可读；列表提示未读文件，不能静默覆盖它们 | 档案逐文件读取与部分失败反馈 |
| B3 | 同一事件 ID、同一内容重复执行仅记一次；同 ID 不同内容拒绝 | 成交追加与事件 ID 校验 |
| B4 | 非法/null 价格在创建会话前被拒绝，不产生会话；有效日线/分钟仍可用 | 场景接收边界校验 |
| B5 | 删除成功但来源加载失败后，浏览器仍以来源 ID 恢复；删除失败保留原复练 | 取消复练的前端恢复目标 |

修复前重跑新增测试：Backend 7 passed / 5 failed，Web 4 passed / 1 failed，与审计结果一致。原有 Engine diff 校验值仍为 `dc791996bffcf61537f0a05449e027cea29eaa253e3c05810349c02c793f195d`。

### 逐项结果

1. **B1 已修复**：先在内存中完成序列化、解析和 ledger 校验，再写同目录临时文件、rename 替换目标。POST/PATCH 拒绝时不改文件。额外注入“已写入部分字节后抛 EIO”，确认旧文件逐字节不变、临时文件清理、详情仍能读取。涉及 `backend/src/app.js` 的 `saveTradeRecordFile`。
2. **B2 已修复**：按文件独立读取；列表返回健康 `items` 和错误 `errors`。坏文件原样保留，对应 ID 的写入/删除返回 409，新文件也不能覆盖未成功读取的同名文件。前端复用 `UiAlert` 显示文件名，明确列表和统计只包含可读取数据。两项浏览器测试分别验证“坏文件旁仍有正常记录”和“全部文件都坏”的提示。涉及 `app.js`、`useTradeRecordArchive.js`、`TradeRecordsView.vue`。
3. **B3 已修复**：相同事件 ID 和相同规范化内容直接返回原记录，不改变持仓或文件；同 ID 不同内容返回 409。通用 POST/PATCH 的事件数组同样拒绝重复 ID。并发、应用重开后重试、冲突重试和不同 ID 的独立成交均已验证。涉及 `app.js` 的成交规范化与追加路径。
4. **B4 已修复**：在场景接收边界检查所有股票及已提供基准 K 线的价格，要求有限正数及正确的 OHLC 高低关系。null、缺失字段、空字符串、数字字符串、布尔值、零、负数和错误高低价均在持久化前返回 502；正常日线、分钟、混合模式原有用例继续通过。没有修改旧库迁移或自动修复历史快照。涉及 `replay-lifecycle.js`。
5. **B5 已修复**：删除确认成功后清除已删除会话状态、先保存来源 ID，再发起来源读取。来源读取断线后仍可按原 ID 恢复；删除请求本身失败则保留原复练。还验证了来源响应仍在途中时，恢复目标已经持久化。涉及 `useReplaySession.js`。

所有初始 6 项红灯断言现在通过，未降低断言。另增加 10 项相关回归：Backend 5 项、Web unit 3 项、浏览器 2 项（其中行情用例内部验证 8 种异常）。两个已有测试仅调整 fixture：生命周期创建 fixture 补齐有效价格；自动播放坏行情测试改为在合法创建后向临时 SQLite 注入旧/损坏快照，保留原 `invalid_market_data` 断言和其他所有用例。

### 修复后完整验证

所有命令均沿用审计时的隔离方式，临时根为本次单独创建的 `mktemp -d` 目录。

| 检查 | 结果 |
| --- | --- |
| Engine 全量，默认存储根和显式行情路径均重定向 | **81 passed**，26.10 s |
| `npm test --prefix backend` | **117 passed**，5.54 s |
| `npm run test:unit --prefix web` | **185 passed**，0.56 s |
| 全部 Playwright E2E，独立 Vite 5587、隔离代理 5588 | **39 passed**，9.6 s |
| Web ESLint | **通过，无错误/警告** |
| Web build，输出至临时目录 | **通过**，2.14 s；仅既有 Browserslist/PURE 提示 |
| Backend 修改文件 `node --check`、`git diff --check` | **通过** |

最终 **422 项全部通过，0 failed、0 skipped、0 todo**。原有 5 个 Python 文件的 diff 校验值保持不变；没有读取、迁移或清理正式存储，没有触发真实 TDX 同步。没有增加依赖、修改测试配置、提交、push 或创建 PR。修复留在 `codex/failure-testing-fixes` 的工作区中，测试服务和本次临时产物在收尾时清理。

### 修复的实际边界

- 成交幂等以客户端提供的相同事件 ID 为依据；不同 ID 仍是独立成交，不按价格/数量猜测重复。历史文件若已含重复 ID，会作为读取异常显示并保留，不自动改写个人账本。
- 原子替换及 EIO 测试验证失败写入不破坏旧文件；不等价于断电持久性或多进程同时写同一文件的验收。
- 损坏文件隔离不会自动恢复原数据；页面会持续提示被排除的文件及统计范围。旧文件名/内容均无法识别 ID 时不推断其业务身份，但仍禁止覆盖已有目标文件。
- 此轮仍未执行真实网络、真实账本、操作系统崩溃或浏览器存储不可用测试；首次审计中与这些环境有关的边界继续成立。
