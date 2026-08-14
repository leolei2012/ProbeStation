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

- `DATA_TYPES`：`int16/uint16/float16`（16 位，不分端）+ `int32/uint32/float32/int64/uint64/float64`（大端）+ 同名前缀 `-LE` 的小端变体（共 15 种）。
- `baseType(type)` / `isLittleEndian(type)` / `registerWidth(type)`（16=1 字、32=2 字、64=4 字）。
- `decodeRegister(type, words)`：按端序合并多字解码（64 位整数返回 bigint）。
- `encodeRegister(type, value)`：按端序编码成 16 位字数组。
- `toHex(word)`：16 位字 → `0x` 十六进制。

词序：大端=低地址高字（默认），小端=低地址低字（`-LE` 后缀）；float16 编码用截断。
