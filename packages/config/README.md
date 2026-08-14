# @probebench/config

设备 / 寄存器组 / 寄存器 的**元数据存储**（配置层），基于 Node 24 内置 `node:sqlite`（同步 API）。
提供 `ctx.config`。

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dbPath` | string | — | SQLite 文件路径（`:memory:` 为内存库，测试用） |

## 服务 `ctx.config`

返回 `ConfigStore` 实例，方法如下（均为同步，因 `node:sqlite` 是同步 API）：

```ts
class ConfigStore {
  listObjects(): DeviceRecord[]                    // 设备列表
  listGroups(objectId: number): GroupRecord[]      // 某设备的寄存器组
  listRegisters(groupId: number): RegisterRecord[] // 某组的寄存器
  listRegistersByObject(objectId): RegisterRecord[]// 某设备全部寄存器
  createObject(name, ip, port, mode?): DeviceRecord
  createGroup(objectId, name, functionCode, startAddress, quantity, mode?): GroupRecord
  createRegister(groupId, objectId, alias, functionCode, startAddress, dataType?): RegisterRecord
}
```

## 记录结构

- `DeviceRecord`：`id, name, ip, port, mode('master'|'slave'), isActive`
- `GroupRecord`：`id, objectId, name, functionCode, startAddress, quantity, mode('read'|'write'|...), isActive`
- `RegisterRecord`：`id, groupId, objectId, alias, functionCode, startAddress, quantity, dataType`

## 表结构（自动建表）

`monitor_objects` / `register_groups` / `registers` 三张表，字段对齐原 Monitor 平台，
但**每台设备独立配置**（不做类型模板），**无语义层字段**（scale/unit/enum）。

## 当前限制（TODO）

- 仅 `list` / `create`，缺 `update` / `delete` / `toggle`（Phase 4 补）。
- `isActive` 直接返回 SQLite 的 0/1，未转布尔。
