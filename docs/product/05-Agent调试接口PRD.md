# Agent 调试接口 PRD

> 状态：v1.2 · 日期：2026-08-14
> 读者：开发侧（平台实现）+ 产品侧。
> 前置：`03-语义清单契约-YAML规范`（agent 之间的说明书）、`04-调试能力说明与接入指南`（对外能力承诺）。
> 定位：本文定义**平台侧**的 MCP 原始数据接口。

> 设计原则：**平台是纯数据通道，只做「读原始值 / 写原始值」，不做翻译、不解析 YAML、不按名寻址。** 语义（scale/unit/enum/bitfield）由调试 agent 拿 YAML 自己理解。

---

## 1. 目标与非目标

### 1.1 目标

- 调试 agent 通过 MCP 读/写 Modbus 寄存器的**原始值**，带 `timestamp` 与 `quality`（判断数据新旧）。
- 提供调试便利：整机快照、健康状态、告警查看。
- 写操作**忠实执行**，无任何拦截。

### 1.2 非目标（不做）

- **不解析 YAML**：不加载语义、不按 `name` 寻址、不做 scale/unit/enum 换算。
- **不做安全拦截**：无白名单、无值域校验、无审批。
- 不做 OTA、降采样（沿用 Phase 5 范围）。

---

## 2. 数据约定

- 读返回：`{ register_id, address, value, timestamp, quality }`，其中 `value` 是按平台 config 里已有的 `data_type` 解码后的数值（int16/int32/…，这是「原始值按类型呈现」，不是语义翻译）。
- 平台**不涉及** scale/unit/enum：这些只存在于 YAML 里，由 agent 自己换算。

---

## 3. MCP 工具集

> 寻址：`register` 用 `register_id` 或 `address`（平台已有），**不用** YAML 里的 `name`。

### 3.1 读

| 工具 | 参数 | 说明 | 状态 |
|---|---|---|---|
| `list_devices` | — | 设备列表（id/name/ip/port/mode/is_active） | ✅ |
| `list_registers` | `device_id` | 某设备寄存器定义（id/alias/address/data_type） | ✅ |
| `read_register` | `device_id, register_id` | 读单寄存器原始值 + `timestamp` + `quality` | ✅ |
| `query_history` | `device_id, register_id, start, end` | 查历史原始值 | ✅ |
| `get_device_snapshot` | `device_id` | 一次返回整台设备所有寄存器原始值 | 🚧 新增 |
| `get_device_health` | `device_id` | 连接状态 / 轮询是否在跑 / 最近采样时间 | 🚧 新增 |
| `list_alarm_rules` | `device_id?` | 查看已配告警规则 | 🚧 新增 |

### 3.2 写

| 工具 | 参数 | 说明 | 状态 |
|---|---|---|---|
| `write_register` | `device_id, register_id, value` | 写原始值（FC16），忠实执行 | ✅ |

### 3.3 配置（改寄存器表）

- 保留 `create_group / update_group / create_register / update_register / delete_register / delete_group`。
- 属「改采集拓扑」，默认不向调试流程开放。

---

## 4. 现状差距与改造点

现有 12 个工具已能读/写原始值，本 PRD 的增量很小：

| 项 | 现状 | 目标 |
|---|---|---|
| 读原始值 | 已有，但返回未带 `timestamp`/`quality` 透出 | 补上时间戳与质量（store 已存，最便宜） |
| 整机快照 | `read_all` 返回 `{register_id: value}` | 带别名 + 时间戳（`get_device_snapshot`） |
| 健康状态 | 无 | 新增 `get_device_health` |
| 告警查看 | 无 MCP 工具 | 新增 `list_alarm_rules` |

**不需要做的**（此前设计已砍掉）：`load_semantics`、按 `name` 寻址、scale/unit/enum 换算、安全护栏。

---

## 5. 分期实施

| 优先级 | 内容 | 价值 |
|---|---|---|
| **P0** | 读原始值带 `timestamp`/`quality`（现状最便宜的一步） | 让 agent 判断数据新旧 |
| **P1** | 整机快照 / 健康状态 / 告警查看 | 调试便利 |

---

## 6. 验收标准

- [ ] `read_register` 返回 `{ register_id, address, value, timestamp, quality }`。
- [ ] `write_register` 写原始值，忠实执行，无拦截。
- [ ] `get_device_snapshot` 一次返回整机原始值快照。
- [ ] `get_device_health` 返回连接/轮询/最近采样时间。

---

## 7. 开放问题

1. **数据新旧**：`read_register` 返回的是缓存快照还是强制采样，由 `fresh` 参数还是固定行为决定——实现时定。
2. **多设备隔离**：`register_id` 全局唯一，跨设备寻址需带 `device_id`（本 PRD 已约定）。
