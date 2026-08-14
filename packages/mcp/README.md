# @probebench/mcp

MCP（Model Context Protocol）服务器：把 ProbeStation 的「读/写/查设备」能力暴露成 MCP 工具，
供 DeepSeek Harness（或任意 MCP 客户端）通过 streamable-http 连接调用。

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `host` | string | 0.0.0.0 | 监听地址 |
| `port` | number | 8081 | 监听端口（独立于 REST 的 8080） |

## 传输

- streamable-http（有状态，sessionIdGenerator 用 randomUUID）。
- 端点：`http://<host>:<port>/mcp`。
- 用**独立原生 HTTP 服务器**（`node:http`），不挂 Fastify（避免 hijack 冲突）。

## 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `list_devices` | — | 设备列表（id/名称/IP/端口/状态） |
| `list_registers` | `device_id` | 某设备寄存器定义（id/别名/地址/类型） |
| `read_register` | `device_id, register_id` | 读单寄存器实时值（热缓存） |
| `read_all` | `device_id` | 读某设备全部寄存器快照 |
| `query_history` | `device_id, register_id, start, end` | 查历史时序 |
| `write_register` | `device_id, register_id, value` | 写寄存器（FC16，控制真机） |

## DSH 接入（cordis.yml）

```yaml
- name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: probestation
    transport: streamable-http
    url: http://192.168.90.34:8081/mcp
```

模型会得到 `mcp__probestation__list_devices`、`mcp__probestation__read_register` 等原生工具。

## 安全（TODO）

- `write_register` 是控制真机的危险操作，目前直接执行 + 记日志；**尚未接入审批/鉴权**。
  接 AI 自动控制前，需补「读全自动 / 写需人工确认」的分级授权（决策 #14）。
- 无认证：内网任何能访问 8081 的客户端都可调用工具。
