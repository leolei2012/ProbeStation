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
| `set_device_active` | `device_id, active` | 连接/断开设备（active=true 连接并打开串口/开始轮询；false 断开并关闭串口/停止轮询），状态经 `config/changed` 同步到 Web UI |
| `set_poll_interval` | `device_id, poll_interval_ms` | 设设备采样周期（毫秒，≥1 整数；1ms 只是下限，实际受 Modbus 往返限制） |
| `set_data_retention` | `retention_seconds, device_id?` | 设历史保留（秒，0=永久；缺省 device_id 设全局，否则设该设备覆盖） |
| `get_data_retention` | `device_id?` | 查当前生效保留时长（设备覆盖优先于全局） |
| `read_register` | `device_id, register_id` | 读单寄存器实时值（热缓存） |
| `read_all` | `device_id` | 读某设备全部寄存器快照 |
| `query_history` | `device_id, register_id, start, end` | 查历史时序 |
| `write_register` | `device_id, register_id, value` | 写寄存器（FC16，控制真机） |
| `create_group` | `device_id, name, function_code?, start_address, quantity, slave_id?, poll_interval_ms?` | 新建分组 |
| `update_group` | `group_id, name?, slave_id?, function_code?, start_address?, quantity?, poll_interval_ms?, is_active?` | 更改分组 |
| `create_register` | `group_id, alias?, function_code?, start_address, data_type?` | 新增寄存器 |
| `update_register` | `register_id, alias?, data_type?` | 更改别名/类型 |
| `delete_register` | `register_id` | 删除寄存器 |
| `delete_group` | `group_id` | 删除分组 |

## DSH 接入（cordis.yml）

```yaml
- name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: probestation
    transport: streamable-http
    url: http://192.168.90.34:8081/mcp
```

模型会得到 `mcp__probestation__list_devices`、`mcp__probestation__read_register` 等原生工具。

## 与 Web UI 的状态同步

- 所有改配置/连接状态的工具（含 `set_device_active`）最终都走 `ConfigStore` 的变更回调，
  触发 `config/changed` 事件 → api 经 WS 广播 → 前端刷新设备/寄存器列表。
- 因此 MCP 连接/断开设备时，Web UI 的「已连接/未连接」徽标会实时同步，无需手动刷新。

## 安全（TODO）

- `write_register` 是控制真机的危险操作，目前直接执行 + 记日志；**尚未接入审批/鉴权**。
  接 AI 自动控制前，需补「读全自动 / 写需人工确认」的分级授权（决策 #14）。
- 无认证：内网任何能访问 8081 的客户端都可调用工具。
