# 2026-09-08 三层验收

验收工作树：`/Users/dan/.codex/worktrees/ea1e/InvestFlow-Replay`。基线为
`5cf15a7d61587245c568a03be78dcc4b72d9f629`；后端回归修复已整合为
`0810f67`（来源 `af6f1eb`）。离线 Demo 来源提交为
`1c5ec6f1f4adbf26e120e54d65815488b3ef8755`；其与继承的两处未提交
Web 修改重叠，按专用安全补丁整合，未覆盖原有 UI 修改。

## A. 离线合成行情：通过

- `./run-demo.sh` 使用独立端口 8875 / 3210 / 5280、`.demo-storage/`
  与 `.runtime-demo/`；健康、基准、缓存 API 都返回 `provider=fixture`，
  数据版本为 `fixture-demo-market-v1`。
- 在真实 Web 页面完成：创建 60 日日线盲测、100 股买入、推进成交、100 股
  卖出、刷新恢复、冻结盲评、揭晓、事后复盘与评分；重启三层服务后，页面及
  `GET /api/quant/replay/sessions` 均恢复已揭晓、已评分的历史记录。
- Demo 只提供 20 / 60 / 120 日日线；日内入口在 fixture 模式隐藏。
- `storage/` 保持只含受版本控制的占位文件；验收记录只写入 `.demo-storage/`。

## B. 通达信真实行情：未通过

使用全新 `/private/tmp/ifr-tdx-acceptance` 与端口 8876 / 3211 / 5281
启动后，真实模式健康检查为 `tdx`，但行情初始化失败：
`No module named 'easy_tdx'`。因此未能准备日线缓存，也未能进入日内、
下单、揭晓或复盘的真实行情路径。

`./install.sh` 同样在 `easy-tdx==1.20.4` 无可用分发时中止。当前 pip
没有自定义 index 配置，官方 PyPI 的 `easy-tdx` JSON 端点返回 404；不能
把 `pytdx` 当作静默替代，因为现有代码导入的是另一套 `easy_tdx` API。

## 可复现检查

```bash
PYTHONPATH=engine .venv/bin/python -m pytest engine/tests/test_fixture_market.py -q
npm test --prefix backend
npm run test:unit --prefix web
npm run lint --prefix web
npm run build --prefix web
./run-demo.sh
```

实际结果：fixture 测试 8/8、后端 93/93、前端 171/171、lint 与 build 均通过。

## 发布结论

离线本地 Alpha 演示可供受控试用；不允许宣称通达信真实行情已验收，也不建议
基于当前状态发布为真实行情 Alpha，直到可复现安装 `easy_tdx` 并完成真实
日线及日内全链路验证。
