# 加密行情数据准备

当前加密分支使用 OKX BTC、ETH USDT 永续的两个冻结小样，或 2024–2025 历史池。每个场景含此前 90 天背景、72 小时回放和一个结束分钟。`install.sh` 安装依赖，不会下载这批行情；启动服务也不会自动联网补数据。

## 先确认数据从哪里来

行情资产不随 Git 代码分发。当前 v1 只有本地已验收的资产目录及其备份，**尚无公开下载包或下载地址**。在已有数据的加密检出目录中，源目录为 `storage`；也可使用它的离线备份。首次在全新机器使用，需要先把这两个版本目录从已有机器或备份转移过来。不能只有代码、没有资产，却显示可练两个小样。

源目录结构如下。仅练小样不需要历史池：

```text
frozen-data-root/
  crypto-samples/okx-20240101-v1/   # manifest、6 个规范化文件、raw 索引及 479 个源文件
  crypto-pool/okx-2024-2025-v1/     # catalog、规则、准入报告、3290 个规范化文件、4328 个源文件及索引
```

准备工具按固定清单复制，不复制源目录中的 `app`、SQLite 账本或手动交易记录。小样的冻结规则使用当前代码随附的规则文件；历史池包含同一规则副本。

| 已接受版本 | 完整校验文件数 | 文件合计字节 | 场景数 |
| --- | ---: | ---: | ---: |
| `okx-20240101-v1` | 487 | 24,037,859 | BTC 1、ETH 1 |
| `okx-2024-2025-v1` | 7,622 | 254,163,597 | BTC 105、ETH 105 |

这里的字节数是受校验资产的合计，不包含目录元数据。历史池首次选择还会排除已见背景、前缀和相关币种时段，可用数会随训练减少。

## 离线导入及核验

以下命令在加密项目根目录执行，先安装项目依赖。把 `CRYPTO_FROZEN_SOURCE` 指向**包含上述 crypto-samples/crypto-pool 子目录**的已冻结资产根目录，把 `CRYPTO_DATA_DIR` 指向目标目录。

```bash
export CRYPTO_FROZEN_SOURCE=/absolute/path/to/frozen-data-root
export CRYPTO_DATA_DIR=/absolute/path/to/local-crypto-data

# 干净目录应返回 mode=unavailable、admittedWindows=0
node --no-warnings backend/scripts/crypto-data.mjs status --data-root "$CRYPTO_DATA_DIR"

# 起步只需小样；prepare 会先核验全部来源，复制后再校验，最后发布版本
node --no-warnings backend/scripts/crypto-data.mjs prepare --kind sample --from "$CRYPTO_FROZEN_SOURCE" --data-root "$CRYPTO_DATA_DIR"
node --no-warnings backend/scripts/crypto-data.mjs check --kind sample --data-root "$CRYPTO_DATA_DIR"
node --no-warnings backend/scripts/crypto-data.mjs status --data-root "$CRYPTO_DATA_DIR"

# 需要已验收的历史池时再准备；不会扩大当前版本、币种或年份
node --no-warnings backend/scripts/crypto-data.mjs prepare --kind pool --from "$CRYPTO_FROZEN_SOURCE" --data-root "$CRYPTO_DATA_DIR"
node --no-warnings backend/scripts/crypto-data.mjs check --kind pool --data-root "$CRYPTO_DATA_DIR"
node --no-warnings backend/scripts/crypto-data.mjs status --data-root "$CRYPTO_DATA_DIR"
```

重复导入相同版本会重新校验并成功返回，不覆盖已有文件。来源缺失/损坏先于目标写入被拒绝；目标同名版本损坏或指针冲突也会拒绝，不重算 hash、不覆盖。复制期间用自有临时目录暂存，完整验证后发布，历史池指针最后原子创建。需要额外约一个版本的暂存空间。完整 `check` 失败返回非零退出码。

`status` 是**运行所需资产**的可用性检查：小样检查 manifest、规则、6 个规范化文件；历史池检查目录、规则及全部 3290 个规范化文件。`check` 另外核验原始资料、下载索引、准入报告的完整指纹链。运行不依赖 raw 文件，所以仅缺 raw 时 `status` 可能仍可用，完整 `check` 必定失败。首次准备和迁移必须执行完整核验。

## 启动与账本位置

```bash
export INVESTFLOW_REPLAY_CRYPTO_DATA_ROOT="$CRYPTO_DATA_DIR"
./run.sh
```

进入 `http://127.0.0.1:5180/decision/crypto-replay`。使用自定义端口时按实际前端端口进入。环境变量由终端导出，脚本不自动加载 `.env`。

- `INVESTFLOW_REPLAY_CRYPTO_DATA_ROOT`：只控制加密行情资产，默认项目的 `storage`；相对路径按启动目录解释，建议使用绝对路径。
- `INVESTFLOW_REPLAY_STORAGE_ROOT`：控制原有应用账本、交易记录及 Engine 存储，保持原含义。迁移行情时不要顺带改它，避免误用空账本。
- `INVESTFLOW_REPLAY_CRYPTO_SOURCE=sample`：可选，只使用已核验的两个小样；仍从上述行情目录读取。

无数据时界面禁止新建，并提示导入步骤。已发布历史池缺指针、缺文件或校验失败时，拒绝新建，不会悄悄退回小样。已有会话的完整行情和规则已经冻结在原 SQLite 中，数据源离线时仍能恢复、操作及显式原版本复练；**原 SQLite 本身也必须保留**，仅转移行情不能恢复账本中的练习。

## 完整性和版本身份

受信任的根指纹固定在 `backend/src/replay-crypto-data.js`，不是接受来源自报的任意 hash：

```text
小样 manifest: 048fd665a006077050585ba34c8b498caab3672d21bd4311a270c412fe3e6f56
历史池 catalog: df58e4fd6d8a69f8e7de824e3cbb03bc85bad83c8dd97de9cd9ffa7d47539ede
冻结规则:       1a1f5a04615ab6e2229cb8abc5685ea20d13a47ef131027d571255824c0f78e6
准入报告:       64dcd0919a09374441123f37dcaeae6aa8d2fcd44a40b2fc636e3fd28c1a754d
```

小样 manifest 再固定 raw 下载索引和全部规范化文件；历史池 catalog 固定 raw 索引、规则和规范化日块；raw 索引逐项固定原文。准备与完整校验核对整条链，运行加载再次校验所用文件。汇总不向盲测界面暴露目录、具体场景日期或未来价格。

## 如果没有冻结资产，能否从 OKX 重新获取？

仓库保留 `engine/scripts/download_okx_sample.py`、`download_okx_pool.py`，使用 OKX 官方历史普通价格/标记价格接口及资金费日归档，保留响应与请求元数据。以下只演示采集**新的原始研究资料**，需网络访问，当前 F5 验收未重新联网下载：

```bash
python3 engine/scripts/download_okx_sample.py --output .runtime/okx-reacquire/sample/raw
python3 engine/scripts/download_okx_pool.py --output .runtime/okx-reacquire/pool/raw --workers 12
```

采集器有加密分支检查。新下载中的抓取时间、分页响应与归档修订可能不同，**不能承诺重建原 v1 的相同字节**，也不能直接导入冒充 v1。没有冻结资产时，新建保持不可用。

要把重新采集的数据用于训练，须另立数据版本，在独立检出中运行 `backend/scripts/build-crypto-sample.mjs` / `build-crypto-pool.mjs` 的构建和完整验证，核对普通/标记价格、1h/1day 官方交叉结果、资金费原时点、分钟连续性、90d+72h 窗口、无未来泄露及准入/排除，再明确加入新版本。当前构建器读取各自固定 `storage` 子目录，不接受任意采集目录；不要把新资料覆盖进已冻结目录，也不要为了通过导入修改这里的 v1 指纹。

已有默认目录中的 v1 还可做原始数据到语义约束的复核（历史池需要 Python 3，较耗时）：

```bash
node --no-warnings --max-old-space-size=4096 backend/scripts/build-crypto-sample.mjs verify
node --no-warnings --max-old-space-size=4096 backend/scripts/build-crypto-pool.mjs verify
```

离线导入以已验收、固定指纹的 v1 为边界。公开资产包的托管发布不在本轮范围，也尚未完成。
