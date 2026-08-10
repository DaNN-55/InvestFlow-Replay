# 正常与失败状态证据

四种状态通过公开 HTTP interface 和浏览器可见结果表达。连接失败与缓存不足刻意分开：前者在缓存可用时是可继续工作的降级状态，后者是不能创建演练的业务拒绝。

| 状态 | HTTP / 业务结果 | 用户可见结果 | 稳定证据 |
| --- | --- | --- | --- |
| 正常 | `201`，Fixture 创建会话 | 进入“历史行情盲测”，显示 250 根观察日线 | Engine fixture、Backend session、真实离线 smoke |
| 缓存不足 | `409 MARKET_CACHE_INSUFFICIENT` | 显示“本地缓存不足”，不创建会话 | Engine/Backend 错误契约测试、浏览器状态测试 |
| 连接失败 | `200`，继续使用完整本地缓存 | 缓存入口呈降级色，面板解释“连接失败，继续使用本地缓存” | TDX fallback 单测、浏览器状态测试 |
| 输入非法 | `400 INVALID_REQUEST` | 显示具体字段约束，不进入工作区 | Backend 参数测试、浏览器状态测试 |

## 代表性响应

### 正常

```json
{
  "session": {
    "sourceDataVersion": "fixture-demo-market-v1",
    "interval": "1d",
    "gameLength": 20,
    "observationBars": 250,
    "status": "active",
    "revealed": false
  }
}
```

### 缓存不足

```json
{
  "error": {
    "code": "MARKET_CACHE_INSUFFICIENT",
    "message": "通达信连接失败且本地缓存不足，无法初始化行情演练：演示连接不可用",
    "details": {
      "error": {
        "code": "MARKET_CACHE_INSUFFICIENT",
        "message": "通达信连接失败且本地缓存不足，无法初始化行情演练：演示连接不可用"
      }
    }
  }
}
```

### 连接失败但缓存可用

```json
{
  "state": "ready",
  "activeTask": {
    "state": "ready",
    "ready": true,
    "message": "通达信连接失败，继续使用本地缓存：演示连接不可用"
  }
}
```

### 输入非法

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "gameLength 只支持 20、60、120",
    "details": null
  }
}
```

## 为什么不现场制造断网

真实网络故障的时机和底层错误字符串不可控，缓存日期也会影响是否触发刷新。作品演示使用脱敏的固定响应和自动化测试证明界面与契约；在线 TDX adapter 的真实 fallback 由 Engine 测试验证。这样既能说明失败处理，又不会把偶然的网络状态包装成可重复证据。
