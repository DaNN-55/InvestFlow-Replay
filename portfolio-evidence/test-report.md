# 代表性测试报告

验证日期：2026-08-10。运行环境：macOS arm64、Python 3.11.15、Node 25.5.0、npm 11.8.0。本文件只记录可公开复核的摘要；原始 JUnit、构建日志和机器环境快照由 `scripts/run-portfolio-verification.sh` 写入调用者指定目录。

## 验证范围

| 层次 | 代表性行为 |
| --- | --- |
| Engine | Fixture 完整契约与确定性、缓存完整时断网 fallback、空缓存明确失败、分钟/混合行情约束 |
| Backend | 会话持久化、下一开盘成交、T+1、幂等与 revision、盲评冻结、战法候选和不可变版本、错误映射 |
| Web unit | 图表因果性、会话命令串行化、复盘草稿、匿名/揭晓展示、Fixture 能力提示 |
| Browser E2E | 创建与推进、交易追踪、战法版本、确认交互、正常/缓存不足/连接降级/输入非法 |
| Static | ESLint 与 Vite production build |

## 最新结果

| 门禁 | 结果 | 耗时 / 说明 |
| --- | ---: | --- |
| Python Engine | 71 passed | 22.48s |
| Node Backend | 94 passed | 3.00s |
| Web unit | 157 passed | 0.64s |
| Playwright E2E | 20 passed | 5.3s |
| ESLint | passed | 无错误 |
| Vite build | passed | 2457 modules，1.91s |
| Offline fixture smoke | passed | 实际完成创建、委托、成交、交卷、盲评、揭晓、复盘、候选与 v2 |
| Demo video | passed | H.264，1280×800，25fps，182.68s |

验证命令：

```bash
./scripts/run-portfolio-verification.sh /tmp/investflow-stage3-evidence
node scripts/record-portfolio-demo.mjs
```

四状态新增证据：

- Engine 固定 `400 INVALID_REQUEST` 与 `409 MARKET_CACHE_INSUFFICIENT`，并验证缓存可用时连接失败仍可继续。
- Backend 保留 Engine 业务错误 code，不再把缓存不足包装成 `INTERNAL_ERROR`。
- Browser E2E 分别覆盖正常、缓存不足、连接失败但缓存可用、输入非法四种可见结果。
- Standalone runtime 与启动脚本拒绝符号链接形式的 `.demo-storage`，避免录屏误写个人存储。

## 重要限制

- E2E 的 API mock 用于稳定验证浏览器展示和交互契约；真实 Fixture smoke 另行走完整本地链路。
- 本报告不是 Python/Node 版本矩阵，也没有声称覆盖率阈值。
- Vite 可能输出第三方 `@vueuse/core` PURE 注释位置警告；若构建退出码为 0，会在报告中作为已知非阻断警告记录。
