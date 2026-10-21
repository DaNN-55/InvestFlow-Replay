# 加密训练 P2：行情小样与无未来泄露验证

开始日期：2026-10-19；完成验证：2026-10-20（北京时间）。状态：**BTC/ETH 小样已冻结，P2 的 30 项测试与真实数据离线复核通过；不接界面、会话或业务账本。**

工作分支 `codex/okx-crypto-training`，目录 `/Users/dan/.codex/worktrees/okx-crypto-training/InvestFlow-Replay`。原 A 股工作目录未切换或合并。本轮未提交、未推送。

## 成功条件与对应产出

| 可检查结果 | 实现与证据 | 结果 |
| --- | --- | --- |
| BTC/ETH 各完整 90 天分钟背景、72h 回放和结束执行分钟 | `engine/scripts/download_okx_sample.py`、冻结 manifest 与 6 份规范化文件 | 两币各两条价格流，每条 133,921 根 |
| 普通/mark 连续、无重复、时间完全对齐 | 原始分页、来源身份、OHLC/成交量/REST confirm、精确时间序列校验 | 通过；不补造或前向填充价格 |
| 分钟聚合与官方粗周期一致 | 普通与 mark 分别核对 1H/北京时间 1D | 每币每条流 2,232 根小时线、93 根日线，价格和适用成交量全部精确一致 |
| 资金费原始时间与率可追溯 | 95 份官方日 ZIP、前后保护事件、科学计数法适配 | 每币 282 条含保护事件；回放＋结束分钟各有 10 个源事件，均有因果 mark 代理 |
| 只输出当时已知信息 | `backend/src/replay-crypto-scenario.js` 的时间前缀投影 | 1m–1d 共 11 种周期未来扰动测试通过；真实 BTC/ETH 的 5m/1d 扰动亦通过 |
| 全量样本与盲测视图分开 | 相对时间、字段白名单、先截分钟再聚合、不提前出最终费率 | 输出不含真实日期、UTC 源时间戳、源 URL、完整 manifest 或未来费率 |
| 文件内容和版本可复核 | `replay-crypto-source-job.js`、SHA256 与离线 verify 命令 | 文件/响应篡改、串错合约/价格流、缺口拒绝测试通过；479 份源载荷离线复核通过 |

## 冻结窗口和文件

两币固定使用同一时段，作为工程样本，不按后续盈亏挑选。BTC/ETH 属于相关行情暴露，不是两个独立的未见测验。

| 部分 | 北京时间 | 分钟数 |
| --- | --- | ---: |
| 背景 | 2023-10-03 00:00 至 2024-01-01 00:00，不含右端 | 129,600 |
| 回放 | 2024-01-01 00:00 至 2024-01-04 00:00，不含右端 | 4,320 |
| 结束执行 | 2024-01-04 00:00 至 00:01，不含右端 | 1 |

回放属于 2024 年，90 天背景自然延伸至 2023 年；这不表示额外开放了 2023 年训练池。

- 数据目录：[okx-20240101-v1](HISTORY.md#local-archive)（本地归档：`storage/crypto-samples/okx-20240101-v1`）。保留完整原始证据与压缩规范化文件，可离线使用。
- [冻结 manifest](HISTORY.md#local-archive)（本地归档：`storage/crypto-samples/okx-20240101-v1/manifest.json`），数据版本 `okx-20240101-v1`、规范版本 `okx-frozen-sample-v1`。
- [验证摘要](./okx-sample-evidence/2026-10-20-p2-validation.json)，关联 manifest、代码和源索引的 SHA256。
- manifest SHA256：`048fd665a006077050585ba34c8b498caab3672d21bd4311a270c412fe3e6f56`。

源载荷共 479 份：普通价格 192 份、mark 192 份、资金费日归档 95 份。原始载荷合计 12,056,624 bytes，规范化压缩文件合计 11,763,334 bytes，另有索引与缓存元数据。SHA256 是本地取得后固化的校验值，用于识别后续变化，不冒充交易所签名或官方 CHECKSUM。

## 来源与时间语义

普通和 mark 全部取自 OKX 历史 REST；没有混入 Binance，也没有使用现货数据。

- 普通：[history-candles](https://my.okx.com/docs-v5/en/#order-book-trading-market-data-get-candlesticks-history)。本批使用官方支持的每页 300 条。
- mark：[history-mark-price-candles](https://my.okx.com/docs-v5/en/#public-data-rest-api-get-mark-price-candlesticks-history)。每页 100 条。
- 资金费：官方[历史归档](https://www.okx.com/historical-data)，例如 [2024-01-01 ZIP](https://static.okx.com/cdn/okex/traderecords/swaprates/daily/20240101/allswap-fundingrates-2024-01-01.zip?v=1001)。只解码 CSV，不把 ZIP 路径解压到文件系统。

每个 REST 原始响应保存 URL、获取时间和原始文本 SHA256，所在压缩文件另有 SHA256。保留源 UTC 毫秒；样本和日线按北京时间划界，时区不依赖主机设置。普通成交量分别保留张数、标的币、计价币，mark 没有成交量，不用来模拟流动性。

本批 REST `confirm` 全部为 1；历史普通 CSV 的 confirm 口径差异仍留在早期研究中，本批没有偷偷改写该字段或沿用不适用的 CSV 过滤逻辑。

### 资金费特殊字段

- 原始 `funding_time` 逐条保留，不强行对齐整点。BTC 本窗无偏移；ETH 相对名义时点最多晚 2 秒。
- 对这一个历史窗口核对每个归档日每币 3 条、8h 名义槽位连续且有前后保护事件；8h 只用于该样本准入审计，不是全合约/全历史的固定调度规则，也没有据此插值补费率。
- 2023-10-08 BTC 有一条原始费率 `-3.035143876E-7`，精确规范化为 `-0.0000003035143876`，同时保留 `sourceRate` 原字符串，未经过二进制浮点。
- 归档缺少 method、formulaType、精确结算 mark 和实际发布时间，保留 null，不用当前规则补造。
- `fundingMarkReference()` 只取源事件前最近已完成分钟的 mark close，并标 approximate。事件在 08:00:01 仍取 07:59 分钟的 close，不偷用 08:00 分钟到 08:01 才知道的收盘价；所有回放内源事件都有该代理。窗口外保护事件允许没有价格代理，不拿陈旧 mark 假装即时值。
- 10 个回放内资金费源事件不是 10 笔用户扣费；后续 P3 按持仓资格处理。本批归档不足以证明名义结算冻结时刻、记录时间与发布时延完全相同，不能把秒差解释成已精确复刻的实盘交易优势。

## 可见数据接口与边界

`createCryptoScenarioView(internalScenario).visibleAt({ elapsedMinutes, timeframeMinutes })` 是独立计算接口，不是 HTTP 接口。

1. 只取 `分钟起点＋60 秒 <= 游标` 的完整分钟。开局只有 90 天背景，不提前暴露回放首分钟的高低收或成交量。
2. 先截已知分钟，再聚合 1m/3m/5m/15m/30m/1h/2h/4h/6h/12h/1d。当前小时/日线仅包含已知部分，并标 `complete=false`。
3. 最终费率只在源事件时间不晚于游标时出现；08:00:01 的源事件在 08:00 分钟游标仍隐藏，到 08:01 才可见。不把未来最终费率当预测展示。
4. 盲测投影只含相对分钟/毫秒，不序列化内部窗口、日期、源文件名或源 URL。输入和返回值的后续修改不会改变被冻结的供给对象。
5. 结束分钟只有在明确推进到它完成后才进入可见输出。逐分钟与批量直达同一游标，投影结果一致；这不是已经完成 P3 的订单/资金推进等价验收。

游标在本接口中是**可信的调用方状态**。P4 仍须从服务端会话读取已揭示游标，不能直接信任客户端要求查看任意未来时点；当前未建立服务端权限或 HTTP 防跳跃机制。文件/投影测试通过不代表这些尚未接入的功能已完成。

## 验证命令与结果

从独立加密工作目录运行：

```sh
python3 engine/scripts/download_okx_sample.py
node backend/scripts/build-crypto-sample.mjs build
node --test backend/src/replay-crypto-scenario.test.js
node backend/scripts/build-crypto-sample.mjs verify
```

下载器可从已保存的日块继续，限速和失败重试均有边界。已冻结后 `build` 会拒绝静默覆盖，复核使用 `verify`；不需要再下载。两次成功的离线复核均无网络请求，最后一次还验证真实未来扰动不影响当前前缀。

结果：P2 **30 tests / 30 pass / 0 fail / 0 skipped**；BTC/ETH 的 479 份源载荷和全部规范化文件通过离线完整性校验。真实投影检查游标 0/1/5/61/1441/4320/4321，周期 5m/1h/1d；5 分钟处把未来 OHLCV、最终费率和内部元数据改成其他值，当前 5m/1d 输出保持相同。

P1 的 28 项验证记录保留，不把它们算作本轮新跑的 30 项；本轮未运行后端业务接口、数据库迁移或浏览器测试。

## 后续实施

P2 的两币小场景完成，下一步是 P3a：使用冻结小样驱动市价开平、资金费事件、风险检查、手动追加与教学全额接管；之后补 P3b 限价/保护/部分成交/撤单。当前不启动 P3，不接界面与业务账本。全量 2024–2025 数据池仍未完成，1m 数据也不能还原真实秒级行情路径和清算成交。
