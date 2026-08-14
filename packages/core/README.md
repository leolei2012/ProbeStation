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

- `DATA_TYPES`：位宽(16/32/64) × 端序(大端/小端 `-LE`) × 格式(int/uint/float/hex/bin)，共 30 种（如 `int16`、`int16-LE`、`hex32`、`bin64-LE`）。
- `baseType` / `isLittleEndian` / `isHexType` / `isBinType` / `registerWidth`（16=1、32=2、64=4 字）。
- `applyEndianness(type, words)`：16 位=字节交换、32/64 位=字序反转。
- `decodeRegister` / `encodeRegister`：按类型解码/编码（64 位整数用 bigint）；hex/bin 为原始显示格式。
- `toHex` / `toBin`：16 位字 → 十六进制 / 16 位二进制。

大端=高字/高字节在前（默认），小端=`-LE` 后缀；float16 编码用截断。
