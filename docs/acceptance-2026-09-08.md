# 2026-09-08 三层验收

验收工作树：`/Users/dan/.codex/worktrees/ea1e/InvestFlow-Replay`。基线为
`5cf15a7d61587245c568a03be78dcc4b72d9f629`；后端回归修复已整合为
`0810f67`（来源 `af6f1eb`）。离线 Demo 来源提交为
`1c5ec6f1f4adbf26e120e54d65815488b3ef8755`；其与继承的两处未提交
Web 修改重叠，按专用安全补丁整合，未覆盖原有 UI 修改。

后续准确提交为 `6225371`。本报告将“验收工作树的集成记录”与
“`git archive 6225371` 的干净源码复验”分开记录，后者不使用工作树的未提交
前端修改。

## A. 离线合成行情：通过

- `./run-demo.sh` 使用独立端口 8875 / 3210 / 5280、`.demo-storage/`
  与 `.runtime-demo/`；健康、基准、缓存 API 都返回 `provider=fixture`，
  数据版本为 `fixture-demo-market-v1`。
- 在真实 Web 页面完成：创建 60 日日线盲测、100 股买入、推进成交、100 股
  卖出、刷新恢复、冻结盲评、揭晓、事后复盘与评分；重启三层服务后，页面及
  `GET /api/quant/replay/sessions` 均恢复已揭晓、已评分的历史记录。
- Demo 只提供 20 / 60 / 120 日日线；日内入口在 fixture 模式隐藏。
- `storage/` 保持只含受版本控制的占位文件；验收记录只写入 `.demo-storage/`。

## B. 安装与真实 TDX：通过

原 `easy-tdx==1.20.4` 已无可复现的 PyPI 分发，导致全新安装中止。现改为
公开发布的 `pytdxdata==0.3.2`，并用一个同步适配器保留现有日线、分钟缓存和
前复权调用边界；适配器对该版本证券列表分页失效采用一次全量下载、内存分页，
避免重复请求第一页。

- 在隔离存储 `/private/tmp/ifr-tdx-acceptance-20260908`、端口
  8876 / 3211 / 5281 完成真实初始化。
- 日线缓存状态为 `ready`：5,220 只证券、8 个指数、12,000 根股票日线、
  6,400 根指数日线；缓存日期为当天。
- 5 分钟缓存按需落盘：5 个标的、118,080 根；真实页面完成日内会话创建、
  100 股买入、跨日 T+1 解锁、100 股卖出。成交后账户为零持仓，累计盈亏
  `-¥3.05`。
- 日线会话完成提前交卷、冻结盲评、揭晓标的 `白云机场 600004.SH`、事后复盘
  与锁定评分 `63.13/100`。
- 同页刷新与三层服务重启后，日内会话的两笔成交、日线已揭晓评分会话及
  `GET /api/quant/replay/sessions` 都保留；缓存仍为 `ready`。

断网/缓存不足不靠现场断网破坏服务复现：`engine/tests/test_minute_replay.py`
覆盖缓存存在时 `OSError("network down")` 不访问网络的恢复路径；缓存下载、
连接复用和分钟数据边界由下列 Python 回归覆盖。

## C. 工作树回归：通过

```bash
PYTHONPATH=engine .venv/bin/python -m pytest engine/tests -q
npm test --prefix backend
npm run test:unit --prefix web
npm run lint --prefix web
npm run build --prefix web
```

结果：Python 77/77、后端 93/93、前端 171/171 通过，lint 与 build 通过。
Python 测试唯一提示为继承的 `.pytest_cache` 没有写权限，未影响结果，也未纳入
提交；构建另有既有 Browserslist/注释提示。

## D. `6225371` 干净源码复验：通过

从 `git archive 6225371` 导出的全新临时目录执行 `./install.sh`，再在该目录
自己的 `.venv` 与 `node_modules` 运行下列完整回归：Python 77/77、后端 93/93、
前端 171/171、lint 与 build 全部通过。Python 无工作树 `.pytest_cache` 警告；
build 仍仅有现有 Browserslist/第三方注释提示。

同一目录的 `./run-demo.sh` 真实 Web 入口显示“离线合成数据”边界，缓存 API 为
`provider=fixture`、`ready`，并成功创建 60 日 Demo 日线盲测（250 根观察日线）。

同一干净源码目录以独立端口启动真实 TDX：日线缓存为 `ready`，含 5,220 证券、
12 只股票日线缓存、8 个指数和 6,400 根指数日线。真实 Web 创建 20 日 hybrid
会话，按以下顺序完成并持久化：提前交卷、保存并冻结盲评、揭晓 `平安银行
000001.SZ`、保存并锁定事后复盘与 `63.13/100` 评分、刷新页面、进入“历史演练”。
历史页显示该记录为“已评分 · 日内模拟 · 5分钟 20 日”，并同时显示冻结盲评与
事后复盘。该会话无买卖委托；先前工作树中的真实买入、跨日 T+1 解锁和卖出证据
仍单列于 B 节，不被误称为干净导出中的该会话证据。

## E. 发布边界

本报告证明本地隔离环境的可安装性、真实 TDX 数据流与会话持久化；不等同于生产
部署、外网稳定性或交易建议。临时验收服务将在提交后停止，临时数据不进入仓库。
