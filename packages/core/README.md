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

## Modbus 类型编解码器（`codec.ts`）

纯函数、无依赖，供 web 前端（显示/写值）+ api/mcp 后端（写值编码）共用：

- `DATA_TYPES`：`int16 / uint16 / float16`（仅 16 位）。
- `decodeRegister(type, word)`：把 16 位字解码成 JS number（int16 符号扩展、uint16 无符号、float16 半精度）。
- `encodeRegister(type, value)`：把 JS number 编码成单个 16 位字。
- `toHex(word)`：16 位字 → `0x` 十六进制。

float16 编码用截断（非最近舍入）。32 位类型（int32/uint32/float32）已移除。
