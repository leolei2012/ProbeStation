# @probebench/core

全局配置与核心插件。

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `host` | string | — | Web/API 监听地址 |
| `port` | number | — | 监听端口（原 Monitor 为 8080） |
| `dbPath` | string | — | SQLite 元数据路径（规划） |
| `dataRetainDays` | number | — | 历史数据保留天数 |
| `pollIntervalMs` | number | — | 默认轮询间隔 |

所有字段当前为必填（`z.string()` / `z.number()`，无 default），在 `apps/cli` 装配时显式传入。

## 行为

`apply(ctx, config)` 仅打印一条启动日志（`core loaded: host:port ...`），暂无服务提供。
