# ProbeStation（砺台）

面向嵌入式设备的**观测与测试平台**：监控是数据底座，AI 测试是大脑与核心卖点。
本项目是对现有 Monitor 平台（Python FastAPI + Quasar）的**全量重写**，采用
DSH（DeepSeek Harness）「一切皆插件」的理念组织代码。

> 产品命名、背景与动机见 `docs/01-项目初步讨论纪要.md`；
> 重构选型与插件边界见 `docs/02-重构架构方案.md`；
> 历次讨论流水见 `conversation_log.md`。

---

## 1. 当前状态

| Phase | 内容 | 状态 |
|---|---|---|
| 0 | 架构方案（选型、插件边界、数据模型、路线） | ✅ |
| 1 | monorepo 脚手架 + Cordis 运行时 + core 插件 | ✅ |
| 2 | modbus 驱动 + poller + store（轮询→落库→查询闭环） | ✅ |
| 3 | api + ws + client（React 前端） | ✅ |
| 4 | slave 模拟器、ota、importer、sink 导出、rule 告警 | ⬜ |
| 5 | 降采样/保留、AI 测试层对接 | ⬜ |

已实现：Modbus TCP 主站轮询（jsmodbus）、时序落库（DuckDB 列存）、热内存快照、时间范围查询。
未实现：REST API、WebSocket、前端、告警、OTA、导入导出、从站模拟。

---

## 2. 技术栈

| 层 | 选型 | 版本 |
|---|---|---|
| 运行时 | Node.js | ≥ 20 |
| 插件运行时 | Cordis | 4.0.0-rc.8 |
| 配置校验 | schemastery | 3.18.0 |
| 语言 | TypeScript（strict，ESM） | 5.x |
| Modbus | jsmodbus（master + slave） | 4.0.10 |
| 时序存储 | @duckdb/node-api（嵌入式列存） | 1.5.5 |
| 包管理 | npm workspaces | — |
| 前端（规划中） | React + Vite | 18 / 6 |

---

## 3. 插件化架构

项目完全照搬 DSH 的 Cordis 范式（详见 `docs/02-重构架构方案.md` §4.1）：

1. **插件 = 实现 Service 的对象**：函数 + `inject` / `apply(ctx)`，或 Service 类。
2. **context 是服务仓库**：服务挂在 `ctx.<key>`（如 `ctx.modbus`、`ctx.store`），按 key 找服务。
3. **`inject` 声明依赖**：加载顺序由服务依赖决定。
4. **类型化事件通信**：`emit / waterfall / parallel / serial`。
5. **注册都是可逆 effect**：`ctx.effect()` / `ctx.on()`，卸载自动回滚。

**关键工程约定**（已踩坑验证）：

- `ctx.plugin()` 是**异步激活**的，必须 `await`，否则服务尚未对外可见。
- 消费者用 `inject: [name]` + `ctx.<name>` 属性访问服务；`ctx.get(name)` 默认 strict，只返回活跃 fiber 提供的服务。
- Service 的异步初始化用 `ready: Promise` 模式（构造器启动、方法内 await），不依赖异步 apply。

---

## 4. 目录结构

```
probestation/
  apps/
    cli/              # 启动入口：装配 cordis 插件
    web/              # （规划中）React 前端
  packages/
    core/             # 全局配置 schema + 日志
    modbus/           # Modbus TCP 驱动抽象 + jsmodbus 实现
    poller/           # 轮询引擎
    store/            # 持久化（热缓冲 + DuckDB）
  scripts/
    test-loop.ts      # 集成 smoke：从站→轮询→落库→查询
    test-store.ts     # store 单元 smoke
  config/             # （规划中）cordis.yml 装配
  docs/               # 架构文档
  reference/          # DSH 源码参考（git 忽略）
```

---

## 5. 插件与服务一览

| 包 | 服务 | 职责 |
|---|---|---|
| core | （配置） | 全局配置 schema（host/port/dbPath/retain/poll），启动日志 |
| modbus | `ctx.modbus` | 驱动工厂 `createDriver()`，返回 `ModbusDriver` |
| poller | `ctx.poller` | `pollOnce(device)`：按组读寄存器 → 生成采样点 → 写 store |
| store | `ctx.store` | `write / flush / getLatest / query` |

详细接口（Config 字段、方法签名、用法示例）见各包 `README.md`。

---

## 6. 数据模型

### 6.1 配置元数据（规划，SQLite）

沿用原 Monitor 结构，每台设备独立配置寄存器（不做类型模板，无语义层字段）：

- `monitor_objects`：id, name, ip, port, remark, is_active, data_retain_days, timeout_ms, mode(master/slave), slave_port
- `register_groups`：id, object_id, name, slave_id, function_code, start_address, quantity, poll_interval_ms, mode(read/write/read_write/disable), is_active
- `registers`：id, group_id, object_id, alias, function_code, start_address, quantity, data_type, remark

（Phase 3 接入 API 后落地。）

### 6.2 时序数据（已实现，DuckDB）

- **热层（内存）**：每寄存器一份 latest 快照（`getLatest()` 不打盘）。
- **冷层（DuckDB 列存）**：单表 `poll_data(object_id, register_id, ts TIMESTAMP, raw_value DOUBLE, quality VARCHAR)`。
- 批量写：攒到 `flushBatchSize` 或显式 `flush()` 才落库。
- 规划：降采样（0–24h 1s → 1–7d 1min → 7–30d 5min）+ 保留删除（Phase 5）。

---

## 7. 快速开始

```bash
# 安装（npm 缓存可重定向到工作区）
npm install

# 启动空应用（验证 Cordis 运行时 + 插件装配 + 日志）
npm run dev

# 集成 smoke：本地 jsmodbus 从站 → 轮询 → 落库 → 查询
npx tsx scripts/test-loop.ts

# store 单元 smoke
npx tsx scripts/test-store.ts
```

---

## 8. 路线图

Phase 0~5 见 `docs/02-重构架构方案.md` §8。当前处于 **Phase 2 完成、Phase 3 待启动**。
