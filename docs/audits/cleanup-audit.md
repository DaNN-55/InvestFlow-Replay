# Cleanup Audit

> 下文审计结论与行号保留为修改前快照；用户随后批准的处理结果见文末“执行记录”。

审计日期：2026-10-01。基线：`main`，HEAD `f5a666bb7a85474bf55857d640cff33ce11f1a9b`，以当前工作区内容为准。

开始时已有 5 个未提交改动文件：`engine/replay_engine/{tdx_api.py,tdx_market_cache.py}`、`engine/tests/{test_minute_replay.py,test_tdx_api.py,test_tdx_connection_reuse.py}`。本审计不修改这些文件，不删除仓库文件，不执行清理、重构、依赖升级或 Git 提交操作。

## Executive Summary

发现 5 组高置信度候选：未接入的 UI 组件及表格依赖、空载 Pinia、旧行情存储接口、无调用的前端声明、未引用图片；另有 5 组需确认用途或契约。最大清理空间在旧存储接口，最需先判断的是失联的执行设置入口。历史数据兼容、通达信适配和离线演示均应保留。401 项现有测试全部通过，lint 与构建通过。本次仅新增报告，测试通过不等于已经验证删除安全。

## High Confidence

### H1. 四个未接入的 UI 组件及其唯一表格依赖

- **位置**：`web/src/components/ui/UiDataTable.vue:1`、`UiEmptyState.vue:1`、`UiSkeleton.vue:1`、`UiTabs.vue:1`；`web/package.json:15` 的 `@tanstack/vue-table`。
- **证据**：解析全部受 Git 跟踪的 JS 和 Vue `<script>`，从 `web/src/main.js` 递归遍历静态 import、动态 import、re-export，这四个组件均不可达；全仓搜索文件名、组件名也无消费者。`@tanstack/vue-table` 的唯一源码引用是 `UiDataTable.vue:7`。未发现非字面量动态 import、批量组件自动注册或按这些名字解析组件的路径。
- **为什么值得处理**：这四个文件没有运行入口、测试消费者或组件展示入口；表格库因此只增加安装和维护范围。不是仅凭组件名称推断。
- **建议范围与影响**：可成组移除组件、直接依赖及对应 lockfile 项；不影响当前页面。专属样式候选位于 `web/src/styles/tailwind.css:1427`、`:1467`、`:1544`、`:2008`、`:2032`，应按选择器再次核对，不能整段删除混排的公共样式。`reka-ui` 仍被弹窗、抽屉和 Tooltip 使用，不能跟随 `UiTabs` 一起删除。不宣称这些组件当前占据生产 JS 包体积，构建可将未引用模块排除。
- **置信度：高。**

### H2. Pinia 只有初始化，没有状态消费

- **位置**：`web/src/main.js:2`、`:9`；`web/package.json:18`。
- **证据**：`pinia` 的唯一源码 import 是 `createPinia`；全仓无 `defineStore`、`useStore` 或 Pinia store 模块。实际共享状态位于 `useReplayCacheStatus`、`useTradeRecordArchive` 等 Vue composable；路由和其组件均已纳入引用图。
- **为什么值得处理**：应用启动安装了一个没有 store 的插件。这是空载依赖，不是与 composable 共同承担状态职责的第二套实现。
- **建议范围与影响**：移除 import、`app.use(createPinia())` 和依赖/锁文件对应项；当前业务状态不依赖它，变化主要是插件初始化及其开发工具接入消失。清理后复跑前端单测、E2E、构建即可，无需替换状态方案。
- **置信度：高。**

### H3. DuckDbBarStore 中未接入现有产品的旧数据浏览、读写接口

- **位置与候选边界**：

  | 文件位置 | 候选内容 |
  | --- | --- |
  | `engine/replay_engine/data_store.py:86` | `SOURCE_DATASETS`：只供下面两个数据集浏览接口使用的元数据表 |
  | 同文件 `:1805–2147` | `_source_fetch_raw_bar_rows`、`_source_fetch_factor_rows`、`_source_fetch_factor_anchor_rows`、`_source_columns`、`list_source_datasets`、`query_source_dataset`，共 6 个方法 |
  | 同文件 `:2149–2177` | 无调用的 `_create_daily_bars_table`；实际初始化使用 `:2179` 的 `_ensure_daily_bars_table` |
  | 同文件 `:2388–3703` | 26 个旧接口及其内部 helper：通用 bars 增删改查、复权因子读写/回填、coverage/日期/最新快照查询、基本面快照读写；代表入口为 `upsert_bars`、`replace_live_market_data`、`fetch_bars`、`latest_market_snapshot`、`upsert_fundamental_snapshots` |

- **证据**：`service.py:42` 是生产代码中构造 `DuckDbBarStore` 的入口；调用的业务方法只有 `source_data_version`、`list_replay_benchmarks`、`create_replay_scenario`、`source_instrument_name_map`。以这四个方法及构造函数为根，Python AST 追踪 `self`/`cls` 方法调用，以上 33 个方法均不在可达集合内，也没有本类之外的生产或测试调用。检查 Engine 的 `getattr` 后，只发现 TDX 客户端方法转发和行情行取值，没有对该存储类的动态分发。FastAPI 路由也不暴露数据集浏览、基本面或通用数据管理功能。
- **为什么值得处理**：保留了独立 Replay 当前不提供的数据管理功能。仅这 33 个方法的函数体范围就有 1,657 行，维护面明显大于当前产品需要；不是因为 `data_store.py` 文件大就建议拆分。
- **建议范围与影响**：优先收缩无调用的方法和只属于它们的常量/helper，不改变现有行情场景计算。删除会使仓库外自行 import 这些方法的脚本失效；仓库内未发现此类脚本或公开使用说明。**不能删除整个 `data_store.py`，不能据此删除数据库、数据表或构造函数仍引用的 `_ensure_*` 初始化/兼容逻辑。**目录汇总接口另见 R3，不混在本项直接删除。
- **置信度：高，限定于当前仓库内无消费的代码；不代表历史数据可删。**

### H4. 无消费者的状态标签常量和两个前端 API 包装

- **位置**：`web/src/composables/useReplayReviewDrafts.js:10–15` 的 `REPLAY_REVIEW_DRAFT_STATUS_LABELS`；`web/src/services/api.js:85` 的 `recordTradePriceObservation`、`:89` 的 `recordTradeExit`。
- **证据**：状态标签常量除声明外无引用，运行中的 `ReplayReviewPanel.vue:108–113` 另外定义了完全相同的四个标签，并在 `:553`、`:815` 展示。两个 API 对象成员在全部前端源码和测试中没有调用；当前成交动作走 `recordTradeExecutionEvent` 等事件接口。
- **为什么值得处理**：一个常量构成无效的第二份文案来源，两个包装成员保留了前端没有入口的调用方式。
- **建议范围与影响**：删除无人消费的常量，或让面板使用它并移除局部副本，二选一即可；删除两个前端包装不改变当前 UI。**保留后端对应路由**：`backend/src/app.js:1758`、`:1808` 仍有 `trade-license-api.test.js:364`、`:418`、`:899` 等 API 回归测试，不能从“前端不调用”直接推导为整个接口可以废弃。
- **置信度：高，范围仅限前端声明。**

### H5. 未引用但仍进入构建产物的旧交易台图片

- **位置**：`web/public/replay-trading-desk.png`，339,254 bytes。
- **证据**：全部 Git 跟踪文本中不存在该文件名或路径引用。展示页实际使用 `landing-replay-*.png`，见 `web/landing/index.html:340–342`；Pages 工作流 `:34–49` 和 `web/tests/e2e/landing.spec.js:211–246` 都明确枚举这组新素材，没有旧图。隔离执行 Vite 生产构建后，旧图仍被原样复制至输出目录，大小相同。
- **为什么值得处理**：这是可验证的未引用静态资产，并非正常的源码树摇优化问题。
- **建议范围与影响**：可删除旧图；会减少本地生产构建的静态文件体积，当前页面不受影响。若仓库外曾直接引用 `/replay-trading-desk.png`，该 URL 会失效；仓库内没有此契约。GitHub Pages 本就不复制此图，不能声称删除它会缩小当前 Pages 发布物。
- **置信度：高，限定于仓库页面与发布流程。**

## Needs Review

### R1. 执行设置抽屉完全失联，但背后的业务仍在使用

- **位置**：`web/src/components/TradeExecutionSettingsDrawer.vue:1–146`、`web/src/components/ui/UiAlert.vue:1`、`web/src/services/api.js:82`。
- **证据**：抽屉没有任何导入或注册；`UiAlert` 只被该抽屉引用；保存执行设置的前端包装也只被抽屉调用。然而 `TradeRecordsView.vue:254–255` 仍加载设置，`:153` 用账户本金和风险参数预览许可证；后端 `app.js:945–978` 仍按设置签发许可证，`:1688–1700` 保留读取/保存路由。`db.js:2217–2218` 的账户本金默认值为 `null`。
- **判断**：无入口是确定事实，但它可能是漏接的必要功能。新存储缺少账户本金时，计算器会拒绝签发许可；因此不能把相关设置功能当作已废弃功能整条删除。
- **待判断与影响**：先决定交易追踪是否仍需要用户配置执行参数。若需要，应恢复可达入口；若功能已明确取消，才移除抽屉及其孤立依赖，并单独处理仍活跃的许可证契约。单删抽屉不会改变当前界面，却可能掩盖已有功能缺口。
- **置信度：中；不可达的证据为高，正确处置方式尚需产品判断。**

### R2. 旧展示/视口工具只在单元测试中存活

- **位置与验证**：

  | 声明 | 唯一实际消费者 |
  | --- | --- |
  | `web/src/utils/tradeRecordPresentation.js:173`：`buildDiagnosisSnapshotSections` | `web/tests/unit/tradeRecordPresentation.test.js:5` 及其测试用例 |
  | 同文件 `:369`：`buildTradeReviewOverview` | 同测试文件 `:6` 及其测试用例 |
  | `web/src/utils/replayMarket.js:36–64`：`resolveReplayViewportAfterBarsChange` | `web/tests/unit/replayMarket.test.js:63`、`:74` |
  | `web/src/utils/replayIndicatorEngine.js:348–364`：`validateReplayIndicatorExpression` | `web/tests/unit/replayIndicatorEngine.test.js:9`、`:61` |
  | `web/src/utils/replayScorePresentation.js:114–118`：`isReplayPlaybookComplianceApplicable` | `web/tests/unit/replayScorePresentation.test.js:10`、`:331–346` |

- **证据与判断**：这些导出函数不存在生产消费者，也没有模块内调用。当前图表更新使用 `useReplayKlineChart.js:378–408` 的图表 API；当前指标编辑验证使用 `validateReplayAdvancedIndicatorConfig`。单测通过说明这些工具仍能运算，不能说明页面还在使用它们。前两项还牵连只服务于旧诊断/复盘展示的内部 helper，清理价值较高。
- **待判断与影响**：确认它们是否承载仍要保留、但尚未接入的产品规则。若已被替代，应同时裁剪旧函数和专属测试；若仍应存在，应补上实际消费路径。不要删除整个工具文件，文件内其他导出仍被页面使用，也不要把移除旧断言当作新 UI 已获得等价测试覆盖。
- **置信度：中。**

### R3. 行情目录汇总缓存仅被旧目录查询测试使用

- **位置**：`engine/replay_engine/data_store.py:386–911` 的目录表初始化、汇总刷新及 `query_instrument_catalog`、`get_instrument_catalog_item`、`instrument_catalog_overview`；`engine/replay_engine/config.py:16`、`:22` 的 catalog 路径。
- **证据**：生产标的搜索 `service.py:242–251` 读取 `source_instrument_name_map()` 后过滤，不经过目录汇总查询。`query_instrument_catalog` 唯一外部调用在 `engine/tests/test_tdx_market_cache.py:657–669`；另外两个目录公开方法无调用。目录路径和相关 helper 的消费均留在这条目录链路内。
- **判断**：它是一个有测试、没有产品消费者的独立分支，而非当前标的搜索的必要加速层。
- **待判断与影响**：确认是否仍保留离线目录管理需求；若取消，可移除查询及汇总代码并调整专属断言。不要删除同一个测试中的 TDX 同步、代码名称和日历验证；也不能据此删除磁盘上的 `catalog.duckdb`。是否还支持旧存储构造方式，需与 H3 的代码裁剪分开判断。
- **置信度：中。**

### R4. 前后端交易许可算法重复，并已有可复现的校验漂移

- **位置**：`web/src/utils/tradeLicense.js:51–136`、`backend/src/trade-license.js:21–106`。
- **证据**：两份实现重复计算不追价、风险预算、手数和计划仓位；前端 `:73` 拒绝 `maxAccountRiskPct > 100`，后端 `:43` 只检查大于零。直接 import 两个现有函数，对相同输入实际验证：

  ```js
  {
    triggerPrice: 10, failurePrice: 9, targetPrice: 15,
    accountEquity: 100000, minRewardRiskRatio: 2,
    maxAccountRiskPct: 101, maxPositionPct: 20, lotSize: 100
  }
  // Web: valid=false, INVALID_ACCOUNT_RISK
  // Backend: valid=true, plannedQuantity=1800
  ```

- **边界**：`backend/src/app.js:364`、`:465–479` 的正常写入路径已经限制风险百分比不超过 100，因此此证据是函数契约不一致，不能直接描述为 HTTP 接口绕过了校验。前端 `tradeLicense.test.js:51` 有该边界断言，后端计算器测试目前只覆盖正常计算与仓位上限。
- **待判断与影响**：前端即时预览与后端权威签发都有合理职责，不能直接删掉任意一端。应先确定两端的校验契约，补充同输入一致性验证；是否减少算法副本由后续任务决定，不要求在 Cleanup 中做跨包架构重构。
- **置信度：中；重复与差异为高置信度，收敛方式需判断。**

### R5. `.env.example` 缺少与实际启动方式对应的说明

- **位置**：`.env.example:1–8`；`run.sh:5–9`、`:93–114`；`engine/replay_engine/config.py:8–19`；`backend/src/standalone-server.js:8–13`；`web/vite.config.js:5–6`；`README.md:33–55`。
- **证据**：根启动脚本没有加载 `.env`，Python/Node 入口读取进程环境；Vite 配置也直接读取 `process.env`，没有调用 `loadEnv`。README 未给出导出变量或加载示例文件的方法。因此仅复制为根目录 `.env` 并执行 `./run.sh`，不会按示例覆盖这些配置。变量本身在运行代码中有消费者，不能称为“全都无效”。
- **待判断与影响**：若文件只是环境变量清单，应明确 `export`/加载方式；若预期复制后自动生效，则启动脚本与文档契约尚未接通。需要说明配置优先级，尤其 Demo 脚本主动覆盖端口和存储根的行为。修正文档风险低；改变自动加载行为可能改变既有启动配置，应另行验证。
- **置信度：中；未自动加载为高置信度，文件原本意图未在文档中确定。**

## False Positives / Keep

| 看似可清理的内容 | 当前证据与保留原因 | 误删影响 / 置信度 |
| --- | --- | --- |
| SQLite 历史会话迁移、旧评分/盲评兼容 | `backend/src/db.js:1394`、`:1655`；`replay-session-api.test.js:1347`、`:1659` 及 training/retrain/review-draft/correction API 测试覆盖旧库升级和旧记录读取 | 会破坏历史账本解释或升级；**高，应保留** |
| 旧交易计划、许可证和快照字段保护 | `backend/src/app.js:631–689` 的保留旧快照逻辑实际用于更新；`web/src/views/TradeRecordsView.vue:112–142` 消费 legacy 状态；`trade-license-api.test.js:656` 等验证更新不会覆盖历史字段 | 会丢失旧记录上下文，或错误放行旧计划；**高，应保留** |
| `tdx_api.py` 同步桥接和分页修正、TDX failover | `tdx_api.py:23`、`:97`、`:125` 被 `tdx_market_cache.py` 与分钟数据供应链实际使用；`test_tdx_api.py`、`test_tdx_connection_reuse.py` 覆盖适配行为 | 不是过期兼容壳，删除可能破坏当前 `pytdxdata==0.3.2` 调用语义；**高，应保留** |
| `fixture_market.py`、`fixtures/demo_market.json` 和 Demo 脚本 | `service.py:20–30` 按 provider 选择；`run-demo.sh` 明确设置 fixture 和独立存储；`test_fixture_market.py` 验证合成场景 | 会破坏 README 的离线演示入口；**高，应保留** |
| `install.sh`、`engine/init_storage.py`、停止和重置脚本 | README 明确说明脚本入口，`install.sh:31` 调用初始化；`run-demo.sh`/`stop-demo.sh` 复用正式脚本 | 是运行入口，不因没有 JS/Python import 就算死文件；**高，应保留**。审计未执行停止或重置脚本 |
| `reka-ui`、`klinecharts` 和构建工具依赖 | `ConfirmDialog`/`UiDrawer`/`UiModal`/`UiTooltip` 使用 reka；`useReplayKlineChart.js` 使用 klinecharts；Vite、ESLint、PostCSS、Tailwind 配置与 npm 脚本消费相应开发依赖 | 不因少量组件死代码就删除整个库；**高，应保留** |
| Backend/Python 其余直接依赖、两个 npm lockfile | Express/Supertest 分别服务应用与 API 测试；FastAPI/Uvicorn/DuckDB/Pandas/pytdxdata/pytest 有源码或命令入口。两个 npm 项目各有安装入口，不是重复 lockfile | 未发现值得列入问题的其他未使用直接依赖；不同包的锁文件各自有效；**高，应保留** |
| 无普通引用的 FastAPI 处理函数、`__init__.py`、测试辅助导出 | `app.py:34–97` 通过装饰器注册；包入口与只供单测访问的内部能力应结合调用语义判断 | 简单名称计数会误报，不能仅凭零直接调用删除；**高，应保留** |
| `web/landing/index.html`、六张 `landing-replay-*` 图片、README banner | Vite 多入口、Pages 工作流、README 和展示页 E2E 都有实际消费；35 项 E2E 含素材枚举验证 | 是现行展示与发布资产；**高，应保留** |
| README 中现有安装、存储、Demo 和验证说明 | 对照脚本、配置、路由和测试，主要契约一致；已扫描四个跟踪 Markdown 文件的本地链接，未发现失效目标。仅发现 R5 的配置说明缺口 | 未把历史设计记忆当成当前承诺，也未因措辞差异制造过期文档问题；**高（仅已核对的本地契约）** |

额外检查：对受 Git 跟踪源码执行不区分大小写的 `TODO / FIXME / HACK / XXX / workaround / deprecated` 搜索，没有发现对应标记。中文“暂时”和大量 `legacy` 命中主要是交互文案、旧数据保护及测试，未据此判定为债务。`storage/`、`.runtime*`、虚拟环境、既有构建和测试产物不作为可删除历史文件推断；本次没有盘点个人账本内容。

## Recommended Cleanup Order

1. **先确定 R1 的功能归属**：执行设置关系到仍活跃的交易许可流程，先判定应恢复入口还是退出产品。此项是判断顺序，不是本次修复授权。
2. **先做边界小的候选**：H4 无消费声明、H5 旧图片，再处理 H1 UI 组件及表格依赖、H2 Pinia。检查 lockfile 只反映删除，不顺带升级依赖；前端单测、E2E、lint、构建验证。
3. **分块处理 H3 旧存储接口**：先数据集浏览和确定无调用的 helper，再通用读写/基本面代码。保留会话场景构建、初始化和迁移；运行全部 Engine 测试与 Backend API 测试，不改磁盘数据。
4. **判断 R2/R3 的测试孤岛**：确认功能归属后，成对处理旧实现与专属测试。不能单纯以测试数减少证明清理成功。
5. **独立处理 R4 契约漂移和 R5 配置说明**：两端许可计算先对齐规则，配置示例先补齐使用约定。不要将其扩大成架构重构。

### 审计方法与复现范围

- 范围为 206 个原有 Git 跟踪文件，以及实际安装依赖和隔离构建输出。引用搜索排除 `.git`、`node_modules`、虚拟环境、存储和生成文件；负引用结论也不把本报告的候选名称计为消费者。
- JS 使用已安装的 Espree 与 Vue SFC parser 解析静态/动态导入及重导出：Web 82 个源码模块中 6 个不从 `main.js` 可达，其中 4 个列 H1，另外 2 个列 R1；Backend 10 个非测试模块全部可从 `standalone-server.js` 到达。动态 `<component :is>` 检查确认用于已导入图标和 RouterView，没有孤立组件注册入口。
- Python 使用标准库 AST 构建 `DuckDbBarStore` 方法图，再逐项搜索全仓名称与动态分发；以构造函数和 4 个实际业务消费方法为根，76 个方法中 27 个可达。这个静态结果只用来筛选，已将测试消费者、框架注册和数据兼容要求单独处理。
- 同名算法做源代码比较和现有函数的直接调用验证；依赖核对 `npm ls --depth=0` 与 `pip check`。未安装扫描器、修改依赖或增加持久化审计脚本。
- 可重复定位的只读搜索示例：

  ```bash
  git grep -n -E 'UiDataTable|UiEmptyState|UiSkeleton|UiTabs|TradeExecutionSettingsDrawer' -- web
  git grep -n -E 'pinia|defineStore|useStore|@tanstack/vue-table' -- web ':!web/package-lock.json'
  git grep -n -E 'REPLAY_REVIEW_DRAFT_STATUS_LABELS|recordTradePriceObservation|recordTradeExit' -- web
  git grep -n -E 'list_source_datasets|query_source_dataset|replace_live_market_data|fetch_fundamental_snapshots' -- engine
  git grep -n -E 'buildDiagnosisSnapshotSections|buildTradeReviewOverview|resolveReplayViewportAfterBarsChange' -- web
  git grep -n 'replay-trading-desk' -- README.md web .github
  git grep -n -i -E '\b(TODO|FIXME|HACK|XXX|workaround|deprecated)\b' -- engine backend web
  ```

### 现有测试与验证结果

环境：macOS，Node.js `v24.20.0`，Python `3.11.15`。以下均在未清理的当前工作区运行，所有测试最终运行退出码为 0。

| 项目 | 实际命令/隔离方式 | 结果 |
| --- | --- | --- |
| Engine | `PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=engine INVESTFLOW_REPLAY_STORAGE_ROOT="$AUDIT_TMP/engine-storage" .venv/bin/python -B -m pytest engine/tests -p no:cacheprovider` | **81 passed**，22.44 s |
| Backend | `npm test --prefix backend` | **98 passed**，14 suites，2.38 s |
| Web unit | `npm run test:unit --prefix web` | **187 passed**，36 suites，0.55 s |
| Web E2E | 使用现有 `tests/e2e`，Vite 单独监听 `127.0.0.1:5587`；在 `web/` 执行 `PLAYWRIGHT_BASE_URL=http://127.0.0.1:5587 npm exec -- playwright test tests/e2e --output "$AUDIT_TMP/e2e-results"` | **35 passed**，8.5 s |
| Web lint | `npm run lint --prefix web`，无 `--fix` | **通过，无警告或错误输出** |
| Web build | `npm run build --prefix web -- --outDir "$AUDIT_TMP/web-dist"` | **通过**，2.25 s；有两条 `@vueuse/core` PURE 注释位置警告、Browserslist 数据陈旧提示，以及隔离输出目录不会被自动清空的提示；未据此升级依赖 |
| 依赖完整性 | `npm ls --depth=0 --prefix web`、`npm ls --depth=0 --prefix backend`、`.venv/bin/python -B -m pip check` | **通过**，无缺失/失效的顶层 npm 依赖，`No broken requirements found` |

执行说明：

- `$AUDIT_TMP` 表示本次独立临时目录。Python 的默认存储路径被重定向，避免测试初始化接触正式行情库。
- 首次 E2E 因沙箱禁止本地监听而报 `listen EPERM 127.0.0.1:5587`；首次 Backend 受限运行未继续输出，已中止，不能计为通过。通过权限流程后重新运行，上表是最终完成结果，未为通过测试改动代码。
- 为保留已有 `web/test-results`、`web/dist` 和固定 `/tmp/investflow-replay-e2e-vite.log`，E2E 复用了 `web/scripts/run-e2e.sh` 的“启动 Vite → 等待可访问 → 运行全部 E2E”步骤，单独指定端口和结果目录，没有直接覆盖这些既有产物。Vite 后端代理设为未启动的隔离端口 `5588`，不连接正式 Backend；用例自身的 API mock 保持原样。测试用 Vite 已停止。
- 浏览器用例主要验证前端契约；这些通过结果不证明真实通达信网络可用、历史数据库可删除，或候选代码删除后必然无回归。README 本身也说明了 E2E mock 边界。
- 未运行安装/重置脚本、未升级依赖、未进行在线行情同步。本次不执行任何推荐清理动作。
- 收尾核对：`git diff --check` 通过；原有 tracked diff 的 SHA-256 在审计前后均为 `dc791996bffcf61537f0a05449e027cea29eaa253e3c05810349c02c793f195d`，原有 5 个改动文件未被改变；新增仓库文件仅为本报告。隔离测试日志和产物保留在 `/tmp/investflow-cleanup-audit.58Mfep/`，未删除仓库原有文件或测试产物。

### 执行记录（2026-10-01）

用户在审计后批准新开分支逐项处理，并要求决策项在修改前询问。本轮使用 `codex/cleanup-audit` 分支；实施验收时尚未提交、push 或创建 PR，以下保留当时的验证记录。

#### 已确认的决策

| 项目 | 用户选择 | 实际处理 |
| --- | --- | --- |
| H1/H2 | 批准高置信度清理 | 删除四个未使用的 UI 组件、18 块专属 CSS/动画规则；移除 Pinia 初始化和两个直接依赖。锁文件及本地安装共减少 15 个包，保留包版本不变 |
| H3 | 批准高置信度清理 | 删除 33 个旧数据浏览/读写方法和 `SOURCE_DATASETS`，保留行情场景和初始化逻辑 |
| H4/H5 | 批准高置信度清理 | 删除未使用的状态标签常量、两个前端 API 包装及旧交易台图片；对应后端 API 保留 |
| R1 | 恢复设置入口，复用现有抽屉/API | 在交易追踪的“实盘与模拟”页头恢复“执行参数”按钮。保存成功立即更新当前许可预览，失败显示原接口错误且不替换页面参数；保留历史许可快照 |
| R2/R3 | 不再恢复，删除旧实现及专属测试 | 删除五个测试独占的前端函数及其独占 helper、旧行情目录分支和 catalog 配置/构造参数。保留同一 Engine 测试中的行情同步、证券名称和日历断言 |
| R4 | 补齐上限和一致性测试，保留两端职责 | 后端计算函数与前端/API 一致，要求 `0 < maxAccountRiskPct <= 100`；新增边界测试及 12 组输入的两端结果比较 |
| R5 | 保持启动行为，补齐 export 说明 | 更新 README 和 `.env.example`，说明进程环境、自定义存储、显式行情库路径和 Demo 覆盖优先级；没有改动启动脚本 |

#### 修改后验证

| 验证 | 结果 |
| --- | --- |
| Engine 全部现有测试 | **81 passed**，22.35 s；默认存储重定向至临时目录 |
| Backend 全部测试（含新增两项） | **100 passed**，2.74 s |
| Web unit | **177 passed**，0.52 s |
| Web E2E（含新增两项） | **37 passed**，9.1 s；独立 Vite 端口 5587、隔离结果目录、未连接正式后端 |
| ESLint | **通过**，无警告或错误 |
| Vite build | **通过**；从本地安装中移除 15 个包后再次构建也通过。既有 Browserslist/PURE 注释提示未作为升级理由 |
| 依赖锁定与安装核对 | 锁文件 **删除 15 个包、增加 0 个包、保留包版本变化 0 个**；`npm ls --depth=0 --prefix web` 通过 |
| 前端引用闭合 | 剩余 **78 个源码模块均从应用入口可达**，无无法解析的相对 import |
| Engine 裁剪边界 | 共删除 **47 个方法**（H3 的 33 个 + R3 的 14 个）；其余 **28 个方法 AST 与原文件完全相同**，仅构造函数移除 catalog 参数和初始化 |
| 工作区保护 | 原有 5 个改动文件 diff 的 SHA-256 仍为 `dc791996bffcf61537f0a05449e027cea29eaa253e3c05810349c02c793f195d`；`git diff --check` 通过 |

最终共 **395 项测试通过**。相较审计时的 401 项，移除旧展示函数的 7 项、旧视口函数的 2 项和旧战法判断函数的 1 项专属单测，新增 2 项 Backend 测试和 2 项浏览器测试；指标解析的安全断言、行情同步测试及旧数据兼容测试继续保留。新增浏览器测试覆盖保存 payload、即时预览更新、刷新重读、关闭，以及保存失败时维持当前参数。

实施阶段没有删除运行时数据库、账本、历史数据或既有构建产物；没有实施架构重构、依赖升级、Git 提交或远程操作。本轮临时测试服务已停止，临时产物在结果记录后清除。审计阶段保留的旧日志目录不在本轮清理范围。

#### 提交前隔离验证

用户随后批准提交并合并到本地 `main`。暂存范围为本次清理的 32 个文件，排除原有 5 个 Python 文件改动。将 Git 暂存区中的全部 Engine 文件提取到独立临时目录，以原版本 TDX 代码和测试运行：**79 passed，21.96 s**。这证明本次清理的 Engine 提交不依赖那组未提交改动；相较上述工作区的 81 项，减少的 2 项属于原有未提交测试。本地原有改动仍保持原样，不纳入清理提交。
