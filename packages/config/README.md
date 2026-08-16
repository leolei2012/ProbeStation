# @probebench/config

设备 / 寄存器组 / 寄存器 的**元数据存储**（配置层），基于 Node 24 内置 `node:sqlite`（同步 API）。
提供 `ctx.config`。

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dbPath` | string | — | SQLite 文件路径（`:memory:` 为内存库，测试用） |

## 服务 `ctx.config`

```ts
class ConfigStore {
  // Objects（设备）
  listObjects(): DeviceRecord[]
  getObject(id): DeviceRecord | undefined
  createObject(name, ip, port, mode?): DeviceRecord
  updateObject(id, fields): DeviceRecord | undefined   // fields: {name?,ip?,port?,mode?,isActive?}
  deleteObject(id): void                                // 级联删 group + register
  toggleObject(id): DeviceRecord | undefined            // 切换 is_active
  // Groups（寄存器组）
  listGroups(objectId) / getGroup(id) / createGroup(objectId, name, functionCode, startAddress, quantity, mode?, slaveId?, pollIntervalMs?) / updateGroup(id, fields) / deleteGroup(id) / toggleGroup(id)
  // Registers（寄存器）
  listRegisters(groupId) / listRegistersByObject(objectId) / getRegister(id)
  createRegister(groupId, objectId, alias, functionCode, startAddress, dataType?)
  updateRegister(id, fields) / deleteRegister(id)
  // 告警规则 + 日志
  listRules() / createRule(registerId, operator, threshold, message) / deleteRule(id)
  log(level, source, message) / listLogs(limit) / clearLogs()
}
```

## 表

`monitor_objects` / `register_groups` / `registers` / `alarm_rules` / `logs` 五张表。
规则与日志由 `rule` / `api` 插件写入。

## 字段映射

update 接受 **camelCase**（`isActive`、`functionCode`、`startAddress`、`dataType`），内部映射到 snake_case 列。参数化 SQL，无注入。

## 表结构

`monitor_objects` / `register_groups` / `registers` 三张表，每台设备独立配置，无语义层字段。

`monitor_objects` 关键列（PRD 08 新增）：

| 列 | 说明 |
|---|---|
| `poll_interval_ms` | 设备级统一采样周期（毫秒，默认 1000，≥1；该设备所有组共用） |
| `data_retain_seconds` | 设备级历史保留覆盖（秒，NULL=跟随全局，0=永久） |

## 变更事件 `config/changed`

- 所有元数据变更（object/group/register/rule 的增删改、toggle）都会触发 `ctx.emit('config/changed', { scope, id })`。
- 上层（如 `api`）据此经 WebSocket 广播给前端，让 Web UI 与 MCP/任意调用方的改动保持同步。
- 事件由构造器的 `onChange` 回调注入，独立构造 ConfigStore（测试）时不注入即为 no-op。

## 当前限制（TODO）

- `isActive` 直接返回 SQLite 的 0/1，未转布尔。
- 无外键约束（级联删除靠应用层）。
