# InvestFlow Replay 作品证据包

这套证据用于在 3–5 分钟内说明一个可重复的工程闭环：研究假设进入行情演练，模拟委托在下一开盘执行，决策与事件写入账本，盲评和事后复盘形成候选规则，最后由人确认是否生成新战法版本。

## 快速入口

- [离线 Demo 视频](video/InvestFlow-Replay-offline-demo.mp4)
- [演示讲稿与操作路径](demo-script.md)
- [正常与三类失败状态](failure-states.md)
- [代表性测试报告](test-report.md)
- [AI Coding 如何被约束和验收](ai-coding-governance.md)
- [已知限制与未来计划](limitations-and-roadmap.md)

架构图和 Backend → Engine 核心请求/响应 JSON 位于项目根目录 [README](../README.md#architecture)。所有示例只使用合成代码和独立 `.demo-storage`，不包含个人交易数据。

## 证据边界

- 离线 Demo 只替换外部行情供给；Web、Backend、会话生命周期、订单、成交事件、SQLite 账本和复盘流程仍走真实实现。
- 浏览器 E2E 中部分场景使用 API mock，用于固定前端交互契约；它们不冒充完整三层集成测试。
- synthetic fixture 和模拟交易结果不能用于证明真实市场收益。
- 状态示例是脱敏后的稳定契约，由对应自动化测试验证，不依赖现场制造真实网络故障。

## 本地复现

```bash
./stop-demo.sh
./reset-demo.sh
./run-demo.sh
```

打开 <http://127.0.0.1:5280/decision/market-replay>。完整分层验证可运行：

```bash
./scripts/run-portfolio-verification.sh /tmp/investflow-portfolio-evidence
```

原始 JUnit、日志和环境快照默认写入调用者指定的目录，不提交进仓库，避免机器路径和运行环境信息进入公开证据。
