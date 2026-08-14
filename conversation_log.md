# Conversation Log（讨论记录）

> 每次讨论按时间顺序追加到本文件下方。正式决策以 `docs/` 下的文档为准，本文件是讨论过程的流水记录。

---

## 2026-08-14 —— 立项讨论 & 重构方向定稿

### 讨论内容

- 项目概览：ProbeStation（砺台）= 设备试验台 + AI 测试大脑；监控是数据底座，AI 测试是卖点。
- 定位并连上 Monitor 源码：`192.168.90.34`（树莓派，用户 leo），源码在 `/home/leo/modbus_tcp_monitor`（非 git 仓库）。
- 源码调研结论：
  - 后端实为 **Python FastAPI**（非纪要所写 Node），端口 **8080**；前端 Quasar 2.16 + Vue3 + Vite。
  - 额外能力：WebSocket 推送、master/slave 双模式（slave 模拟器）、OTA/IAP、MBS/MBP 导入导出、CSV/XLSX 导出。
  - 8 台设备（id=1~9，id=5 已删），id=8 为 slave 模拟器，id=9 雪融机（192.168.90.32:8899）。
  - 核实纪要三差距：①缺 0x2007/0x2008 寄存器；②无缩放（后作废，因语义层不做）；③写寄存器默认 FC06，固件只开 FC03+FC16。
- 方向：**全量重写**，借 DSH「一切皆插件」理念 + DSH 前端 UI。

### 决策

1. 后端全量重写 **TypeScript**（弃 Python FastAPI）。
2. 前端换 **React 18 + Vite**（弃 Quasar/Vue）。
3. 插件运行时 **Cordis 直接依赖**（不 vendor）。
4. 配置校验 **sche mastery**。
5. Modbus 用 **jsmodbus**（master + slave）。
6. HTTP 用 **Fastify**（备选 Hono/Express）。
7. 时序存储 **DuckDB 列存 + 热内存缓冲**（重设计：批量写 + 降采样/保留）。
8. 元数据 **SQLite**（设备/寄存器/组配置）。
9. 工程 **pnpm workspace** monorepo。
10. **语义层不做**（AI 语义后续由外部 Excel 整理）。
11. 设备模型：**每台独立配置**，不做类型模板。
12. 告警/规则：**rule/ 从零做**（现状无）。
13. AI 测试层：**复用 DSH 本身**。
14. 鉴权/审批：**暂不做**，预留审计事件。

### 产出

- `docs/02-重构架构方案.md`（Phase 0：选型、插件边界、数据模型、路线 Phase 0~5）。

### 开放问题

- npm scope 查重（`@probebench` vs `@probe`）。
- DuckDB Node binding 选型。
- 前端「借理念不借代码」具体范围。
- 部署形态（树莓派边缘采集 + AI 分层）。
- 鉴权/审批预留点补全时机。

### 下一步

- **Phase 1**：搭 monorepo 脚手架（pnpm + Cordis + sche mastery + 空应用可跑 + SQLite 元数据）。

---

## 2026-08-14（下午）—— Phase 1：monorepo 脚手架

### 完成内容

- 环境确认：Node v24.18.0、npm 11.16.0；pnpm 未装 → 改用 **npm workspaces**（布局不变，后续可用 corepack 装 pnpm）。
- 依赖版本锁定：cordis 4.0.0-rc.8、schemastery 3.18.0、jsmodbus 4.0.10、fastify 5.12.0、@duckdb/node-api 1.5.5。
- 建 monorepo：根 `package.json`（workspaces: `packages/*` + `apps/*`）+ `tsconfig.json` + `.gitignore`。
- `packages/core`：core 插件（schemastery `Config` schema + `apply`），导出 `name/inject/Config/apply`。
- `apps/cli`：入口，`new Context()` + `ctx.plugin(ConsoleExporter)` + `ctx.plugin(core, config)`。
- 空应用成功启动并输出日志（Cordis 运行时 + schemastery 校验 + 插件装配 + console 日志全链路验证）。

### 决策 / 偏差

- pnpm → **npm workspaces**（pnpm 未装；monorepo 布局不变）。
- npm 缓存重定向到工作区 `.npm-cache`（沙箱限制，已 gitignore）。
- Cordis 4 无内置 console exporter，日志需 `@cordisjs/plugin-logger-console`。

### 下一步

- **Phase 2**：`modbus` 驱动 + `poller` + `store`（热缓冲 + DuckDB 批量写）——先跑通「轮询真机 → 落库 → 可查询」最小闭环。

---

## 2026-08-14（晚）—— Phase 2：modbus 驱动 + poller + store 最小闭环

### 完成内容

- `packages/modbus`：`ModbusDriver` 抽象 + jsmodbus provider（读/写 holding/input registers），提供 `ctx.modbus`。
- `packages/store`：`DuckDBStore`（热内存缓冲 + DuckDB 列存 `poll_data` 表 + 批量写 + query），提供 `ctx.store`。
- `packages/poller`：`PollingEngine`（inject modbus+store，按组轮询 → 生成 PollPoint → 写 store），提供 `ctx.poller`。
- 集成测试 `scripts/test-loop.ts`：本地 jsmodbus 从站 → 轮询 → 落库 → 查询，全链路验证通过。

### 关键技术点（踩坑记录）

- Cordis 4 服务范式：Service 类 + `ready` Promise 异步初始化 + `ctx.provide(name, val)`；消费者 `inject` + `ctx.<name>` 访问。
- `ctx.plugin()` 异步激活，须 `await`；顶层 `ctx.get(name)` 默认 strict，只读活跃 fiber 提供的服务。
- jsmodbus 响应用 `body.valuesAsArray`；从站需**预填 holding 缓冲**（`readHoldingRegisters` 事件仅在 holding 为 falsy 时触发）。

### 待办（后续 Phase）

- store 定期 flush 定时器 + 参数化 SQL + 降采样/保留（Phase 5）。
- poller 的 registerId 现用 startAddress 占位，需接真实配置（Phase 3-4）。
- 正式 vitest 测试框架（当前是 scripts/ 下 smoke 脚本）。

### 下一步

- **Phase 3**：`api` + `ws` + `client` React shell（可视化 + 实时推送 + 历史查询）。

---

## 2026-08-14（续）—— Phase 3a：config 元数据 + api REST

### 完成内容

- `packages/config`：`ConfigStore`（node:sqlite 同步元数据存储），表 `monitor_objects/register_groups/registers`，提供 `ctx.config`（list/create）。
- `packages/api`：Fastify REST，镜像原 Monitor 端点（objects/groups/registers/latest/data/query/health），提供 `ctx.api`（不自动 listen，用 inject() 测试）。
- poller 增加 `poller/result` 事件发射（为 ws 实时推送预留）。
- 冒烟测试 `scripts/test-api.ts`：6 个端点全 200。

### 关键决策

- 元数据存储用 **node:sqlite**（Node 24 内置同步 API，零额外依赖）。
- api 提供 `FastifyInstance` 但不自动 listen，便于 `inject()` 无端口测试。

### 下一步

- Phase 3b：`ws` 实时推送（@fastify/websocket）+ `client` React 前端（Vite）。

---

## 2026-08-14（续）—— Phase 3b：WebSocket 实时推送

### 完成内容

- `packages/api` 增加 WebSocket：`@fastify/websocket` + `/ws` 端点。
- 连接即推 `latest` 快照；订阅 `poller/result` 事件，实时广播轮询结果。
- 冒烟测试 `scripts/test-ws.ts`：连接 → 收 latest → emit 收广播，全通过。

### 关键技术点（踩坑）

- `@fastify/websocket` 必须 `await register()` 后才注册 `/ws`，否则升级失败；用 Fastify async 插件封装解决（apply 是同步的）。
- **Cordis 4 事件是全局分发**（兄弟插件 emit/on 互达），无需 `ctx.root`。

### 下一步

- Phase 3c：`apps/web` React + Vite 前端 shell（设备列表 + 实时值表 + WS 联动）。

---

## 2026-08-14（续）—— Phase 3c：React 前端 + 全栈打通

### 完成内容

- `apps/web`：React 18 + Vite 6 前端（设备列表 + 实时值表 + WS 联动），`vite build` 通过。
- 端到端 demo `scripts/demo-full.ts`：config + modbus + poller + store + api 串起来，真实轮询 3 次 → latest/query 全正确。
- 至此 Phase 3 完成：config 元数据 + api(REST+WS) + React 前端。

### 关键点

- 前端 dev 用 vite proxy 把 `/api`、`/ws` 转发到后端 8080；生产由后端 serve dist（待接线）。
- poller 的 `registerId` 仍用 `startAddress` 占位（与 config 真实 register id 未对齐，Phase 4 接）。

### 下一步（Phase 4）

- slave 模拟器、ota、importer（MBS/MBP 导入）、sink 导出、rule 告警。
- poller ↔ config 对齐（真实 register id、循环轮询、暂停/重连）。
- 生产接线：CLI 启动全插件 + serve 前端 dist。

---

## 2026-08-14（续）—— Phase 4.1：生产接线（一键启动）

### 完成内容

- `poller` 重构：注入 `config`，新增 `startAll()/stopAll()` 循环轮询、连接持久复用、真实 register id 映射。
- `store` 增加定期 flush 定时器（`flushIntervalMs`）。
- `api` 增加前端静态托管（`@fastify/static`，`staticDir` 配置）。
- `apps/cli` 重写：装配 5 插件 + 播种演示设备 + 循环轮询 + listen 8080 + 托管前端。
- `npm run start` 一键启动完整应用，验证 `/health`、前端首页、设备列表、组全 200。

### 关键技术点（踩坑）

- schemastery 字段**默认可选**（`required` 默认 false），无 `.optional()`；必填用 `.required()`。
- `@fastify/static` 的 `root` 必须**绝对路径**（用 `resolve()`）。

### 下一步（Phase 4 剩余）

- slave 模拟器插件、importer（MBS/MBP）、sink 导出、rule 告警。
- poller 轮询失败加日志；补 `update/delete` 等 config CRUD。

---

## 2026-08-14（续）—— Phase 4.2：slave 模拟器插件

### 完成内容

- `packages/slave`：Modbus TCP 从站模拟器（jsmodbus），FC03 读 / FC06 单写 / FC16 多写，提供 `ctx.slave`。
- 冒烟测试 `scripts/test-slave.ts`：读/写往返全通过。
- CLI 接线：启动 slave(8502) + 播种「本地模拟器」设备 + 每秒递增计数器，`npm run start` 本地即见实时数据。

### 下一步（Phase 4 剩余）

- 写寄存器 API（FC06/FC16 写路径暴露到 REST）。
- config CRUD（update/delete/toggle）+ 前端设备管理。
- importer（MBS/MBP 导入）、sink（CSV/XLSX 导出）、rule（告警）。

---

## 2026-08-14（续）—— Phase 4.3：写寄存器 + config CRUD（后端）

### 完成内容

- `config` 补齐 CRUD：get/update/delete/toggle（object/group/register），camelCase→snake_case 字段映射，参数化 SQL。
- `poller` 新增 `write(objectId, address, value, method)`（FC06/FC16，复用持久连接）。
- `api` 新增：设备/组/寄存器增删改查 + toggle + `POST /api/registers/:id/write`。
- 冒烟测试 `scripts/test-crud.ts`：写 FC16=42 / FC06=7 往返 + CRUD 全通过。

### 关键点

- 写寄存器默认 `multiple`（FC16），适配固件只开 FC03+FC16（原 Monitor 默认 FC06 是差距 3 的 bug）。

### 下一步

- 前端设备管理 UI（设备/寄存器 CRUD + 写值界面）。
- importer（MBS/MBP）、sink（CSV/XLSX）、rule（告警）。

---

## 2026-08-14（续）—— Phase 4.3b：前端设备管理 UI

### 完成内容

- `apps/web` 扩展：设备增删改查/toggle + 选中设备看寄存器实时值 + 写寄存器按钮（FC16）。
- `vite build` 通过。至此「写寄存器 + config CRUD + 前端管理」闭环完成。

### 下一步（Phase 4 剩余）

- importer（MBS/MBP 导入）、sink（CSV/XLSX 导出）、rule（告警）。
- Phase 5：降采样/保留、AI 测试层。

---

## 2026-08-14（续）—— Phase 4.4：sink 数据导出（CSV/XLSX）

### 完成内容

- `packages/sink`：`ctx.sink` 提供 `exportCsv/exportXlsx`（宽表：时间戳 × 每寄存器一列）。
- `store` 新增 `queryObject()`（一次查某设备全部寄存器时序）。
- `api` 新增 `GET /api/export/csv` 和 `/api/export/xlsx`（下载）。
- CLI 接入 sink。冒烟测试 `scripts/test-sink.ts`：CSV 宽表 + XLSX(6.5KB) 全通过。

### 关键点

- XLSX 用 exceljs；CSV 纯字符串 + 转义。

### 下一步（Phase 4 剩余）

- importer（MBS/MBP 导入）、rule（告警）、logs。

---

## 2026-08-14（续）—— Phase 4.5：rule 告警引擎

### 完成内容

- `config` 新增 `alarm_rules` 表 + `listRules/createRule/deleteRule`。
- `packages/rule`：订阅 `poller/result`，逐点比较（6 种操作符），命中发 `rule/trigger` 事件。
- `api` 新增 `GET/POST /api/rules`、`DELETE /api/rules/:id`，并把 `rule/trigger` 转发到 WS。
- CLI 接入 rule。冒烟测试：超阈值触发 / 低于不触发 / API CRUD 全通过。

### 下一步（Phase 4 剩余）

- logs（日志查询）、importer（MBS/MBP 导入）。
- Phase 5：降采样/保留、AI 测试层。

---

## 2026-08-14（续）—— Phase 4.6：logs 日志

### 完成内容

- `config` 新增 `logs` 表 + `log/listLogs/clearLogs`。
- `rule` 触发时写 WARN 日志；`api` 写寄存器时写 INFO 日志；`poller` 连接失败改为 console warn（不再静默吞）。
- `api` 新增 `GET /api/logs`、`POST /api/logs/clear`。
- 冒烟测试：规则触发日志入库 + 查询通过。

### Phase 4 进度

✅ slave / importer⬜ / sink / rule / logs；仅剩 **importer（MBS/MBP 导入）**。

### 下一步

- importer（MBS/MBP 导入）——需先读原 Python 的 mbs_parser.py/mbp_parser.py 理解格式。
- Phase 5：降采样/保留、AI 测试层。

---

## 2026-08-14（续）—— Phase 4.7：importer 导入（MBS/MBP）—— Phase 4 完成 ✅

### 完成内容

- `packages/importer`：移植原 Python 的 mbs_parser/mbp_parser 到 TS。
  - MBP XML（v12+，fast-xml-parser）+ MBP INI（< v12，手写解析）+ MBS 二进制（UTF-16LE 名称提取）。
- `api` 新增 `POST /api/monitor_objects/:id/import`（base64 内容）。
- CLI 接入 importer。冒烟测试：三种格式导入全通过。

### Phase 4 全部完成

✅ slave 模拟器 / importer / sink 导出 / rule 告警 / logs 日志 / 写寄存器 / config CRUD / 前端管理。

### 下一步（Phase 5）

- 降采样/保留（时序数据滚动聚合）。
- AI 测试层（复用 DSH）。

---

## 2026-08-14（续）—— 前端 UI 改版（DSH 风格 app 壳）

### 完成内容

- 前端重写为 DSH 风格：左栏（品牌 + 新建设备 + 设备列表 + 设置）+ 右侧工作页。
- 设备工作页：状态徽章、工具栏（暂停/导出 CSV/XLSX/删除）、寄存器实时值表 + 行内写值。
- 设置页（应用信息 + 清空日志）、新建设备弹窗、空状态。
- 纯 CSS 设计令牌（`styles.css`），`vite build` 通过。

---

## 2026-08-14（续）—— 接入真实测试从站

### 完成内容

- 种子设备换成真实测试从站 **192.168.90.176:8899**（unit id=1，0x0000 起 10 寄存器，别名 寄存器0~9）。
- 实测读到 10 寄存器，值为递增 ramp 模式（寄存器0=5555 恒定，其余随时间递增）。
- 本地模拟器保留为第二设备。

### 下一步

- 继续 Phase 5（降采样/保留、AI 测试层），或前端继续加曲线图/分 tab。

---

## 2026-08-14（续）—— 前端设置：外观主题 + 语言 i18n

### 完成内容

- `styles.css` 重构为 CSS 变量 + 深色主题（`[data-theme="dark"]`），全部组件改用变量。
- `App.tsx` 加入：
  - **外观**：浅色/深色主题切换（localStorage 持久化，`data-theme` 应用到根元素）。
  - **语言**：中文/English 双语（I18N 字典 + `t()` 助手），localStorage 持久化。
- 设置页新增「外观」「语言」两个卡片（分段控件选择）。

### 关键点

- 主题用 CSS 变量（`--sidebar-bg/--surface/--text/...`）+ `[data-theme="dark"]` 覆盖，无额外库。
- i18n 用轻量字典 + `t(key)`，不引入 react-i18next（够用）。

### 下一步

- 前端继续：历史曲线图、设备详情分 tab。
- Phase 5：降采样/保留、AI 测试层。

---

## 2026-08-14（续）—— 前端复刻 DSH 设计语言

### 完成内容

- 从 `reference/deepseek-harness-master/packages/client/ui-theme/src/styles/` 提取 DSH 设计令牌：
  - 色板：蓝灰中性色（`neutral-bluish`）+ DeepSeek 蓝 `rgb(65,118,230)` 强调色。
  - 近黑主按钮（`brand-primary`）、极浅灰侧栏（`#f9fafb` 浅色 / `#1b1b1c` 深色）。
  - 字体栈（SF Pro / PingFang / Microsoft YaHei）。
- `styles.css` 全部换成 DSH 精确色值；`App.tsx` 主题加 **system（跟随系统）**，三段切换，默认 system。

### 关键点

- 主题令牌对齐 DSH：`--dsw-static-neutral-bluish-*`、`--dsw-static-deepseek-*`。
- 主题偏好 light/dark/system，system 用 matchMedia 跟随 OS 深色。

### 下一步

- 继续前端（历史曲线图、分 tab），或 Phase 5。

---

## 2026-08-14（续）—— packages/mcp：MCP 服务器（AI 层接口）

### 完成内容

- `packages/mcp`：MCP 服务器（`@modelcontextprotocol/sdk@1.30`），streamable-http（有状态，randomUUID 会话），独立端口 8081。
- 6 个工具：list_devices / list_registers / read_register / read_all / query_history / write_register。
- 直接复用 ctx.config/store/poller（读热缓存、查历史、写 FC16），不走 REST。
- CLI 接入 mcp。冒烟测试：SDK 客户端连接 + listTools + list_devices + read_register 全通过。

### 关键点（踩坑）

- stateless 模式每个请求要新建 transport（SDK 会抛「Stateless transport cannot be reused」）→ 改有状态模式。
- 挂 Fastify 用 reply.hijack + 原始 res 会 double-close（libuv 断言崩溃）→ 改独立 node:http 服务器。

### 决策（AI 层架构）

- **动作层用 MCP 服务器**（标准、DSH 原生吃、可复用）；**知识层将来用 DSH skill**（Excel 语义 + 测试流程）。

### 下一步

- 写寄存器接审批/审计（AI 自动控制前的安全闸）。
- 语义 Excel → DSH skill（可选）。
- Phase 5 降采样/保留。

---

## 2026-08-14（续）—— 文档补全（接手指南）

### 完成内容

- 新增 `docs/03-开发与接手指南.md`（现状 + 开发指南）：快速开始、目录结构、架构/数据流、11 插件一览、插件开发范式、数据模型、**8 条踩坑记录**、REST API 速查、决策摘要、待办。
- 重写 `README.md`（文档导航 + 当前状态 + 快速开始 + 插件清单），指向 docs/03。
- `docs/02` 顶部加「方案 vs 现状」指引。

### 文档结构（当前）

- `README.md` — 门面 + 导航
- `docs/01` 立项纪要 → `docs/02` 架构方案 → `docs/03` 开发接手指南
- `conversation_log.md` — 讨论流水
- 每个包 `README.md` — 插件契约（11 插件 + 2 app 全覆盖）

---

## 2026-08-14（续）—— 分组管理 + 按组 scan rate / slave id

### 完成内容

- `register_groups` 表新增 `slave_id`（默认 1）+ `poll_interval_ms`（默认 1000，scan rate）。
- `modbus` 驱动改为**多从站**：每个 slave id 一个 TCP 连接（`Map<slaveId, connection>`），read/write 方法带 slaveId 参数。
- `poller` 按组 scan rate 轮询（`lastPoll` 跟踪，只轮询到期的组）+ 按组 slave id 读。
- `api` 分组 create/update 接受 slaveId/pollIntervalMs；写寄存器按寄存器的组 slave id 路由。
- 前端 Live 页：分组管理（新建/编辑/删除/暂停分组，字段：组名/从站ID/功能码/起始地址/数量/扫描间隔）。
- 测试 `scripts/test-groups.ts`：分组 CRUD + 新字段全通过。

### 注意

- schema 加了列，**旧 data/ 需删除重置**（测试已清理）。
---

## 2026-08-14（续）—— Modbus 故障显示（分组超时/非法地址）

### 需求

- 分组轮询出现读取超时、地址非法等 Modbus 故障时，要在 UI 上显示出来（不再静默吞掉）。

### 完成内容

- `modbus` 驱动：异常响应 `body.code` → 可读消息（`Illegal Data Address` 等，EXC_MSG 映射 + `body.message` 兜底）；
  `err:'Timeout'`（jsmodbus 的 `UserRequestError`）归一成 `Timeout`；连接错误保留原样（`connect ECONNREFUSED ...`）。
- `poller`：新增 `groupErrors` Map 按组跟踪错误——连接失败对该设备所有到期组标错、单组读取异常只标该组；
  发 `poller/group-error`（值变化才发）与 `poller/group-ok`（读成功且之前有错才发）。
- `api`：把 `poller/group-error`/`poller/group-ok` 转 WS 消息 `group-error`/`group-ok`。
- 前端：`groupErrors` state + WS 更新；Live 页分组头部显示红色徽标 `⚠ <错误>`，恢复后自动清除；新增 `.group-error` 样式。
- 测试 `scripts/test-group-fault.ts`：连接失败（ECONNREFUSED）→ `poller/group-error` 正确发出；好设备照常 `poller/result`。
- 顺手修复 `scripts/test-loop.ts`（poller 依赖 config，补 `configPlugin`）+ 各测试加 `process.exit(0)` 干净退出。
- 文档：`docs/03`（冒烟清单 + 关键事件 + WS 说明 + 踩坑 #10 + 待办）、`packages/poller/README.md` 同步更新。
---

## 2026-08-14（续）—— Live 表格交互改进 + 0x1000 第二段

### 需求

- 质量列去掉；地址放第一列、别名第二列。
- 设备级「启用」改为「连接」，分组级才是「启用」。
- 别名可编辑、类型下拉可改、分组编辑里功能码改下拉。
- 测试从站 0x1000 起有第二段 10 个数据（斜坡下降）。

### 完成内容

- 表格列：`地址 | 别名 | 类型 | 实时值 | 写值`（去掉质量列）。
- 设备头部：状态徽标 `已连接/未连接`、按钮 `连接/断开`；分组头部保持 `暂停/启用`。
- 别名单元格内联编辑（blur/Enter 提交 `PUT /api/registers/:id {alias}`）；类型下拉 `int16/uint16/int32/uint32/float32`（`PUT .../dataType`）。
- 分组编辑弹窗功能码改下拉：`FC03 读保持寄存器` / `FC04 读输入寄存器`；poller 按 `g.functionCode===4` 走 `readInputRegisters`（原只 FC03）。
- 种子：`测试从站` 加第二分组「第二段 0x1000」（0x1000 起 10 个）；`test-device.ts` 直连读两段（0x0000 上升 + 0x1000 下降）验证通过。
- 测试 `test-crud.ts` 补寄存器别名/类型更新断言；文档（REST 表补 `PUT/DELETE /api/registers/:id`、poller README 补 FC04）同步。
---

## 2026-08-14（续）—— 工作区（对齐 DSH：一个文件夹 = 一个工作区）

### 需求

- 软件本地运行，能不能像 DeepSeek Harness 一样选一个文件夹当工作区，再在工作区里新建设备？逻辑向 DSH 看齐。

### 设计

- 一个工作区 = 一个文件夹，内含 `config.db`（元数据）+ `poll.duckdb`（时序），自包含。
- 运行时切换：停轮询 → `store.reopen` → `config.reopen` → 广播 `workspace/changed` → 重启轮询。
- 注册表 `~/.probestation/workspaces.json` 记住最近 20 个工作区。

### 完成内容

- `config`：`ConfigStore` 加 `reopen(dbPath)`（抽 `schema()`，node:sqlite `close()` 后重开）。
- `store`：`DuckDBStore` 加 `reopen(dbPath)`（保留 instance，`flush` 后 `closeSync()` 关连接+实例，清空热层）。
- 新增 `packages/workspace` 插件：`getCurrent/list/browse/switchTo` + 最近工作区注册表。
- `api`：注入 workspace，加 `GET /api/workspace`、`GET /api/workspace/browse`、`POST /api/workspace/switch`，WS 广播 `workspace/changed`。
- 前端：侧边栏顶部工作区栏（📁 + 路径，点击弹「切换工作区」），弹窗支持路径输入 + 子目录浏览 + 最近使用；切换后重载设备列表。
- 测试：新增 `scripts/_bootstrap.ts`（临时目录装配全栈）+ `scripts/test-workspace.ts`（A/B 工作区数据隔离验证）；9 个装配 api 的测试脚本统一改用 `boot()`，顺带修复了 test-ws/test-sink/test-rule/test-logs/demo-full 原本缺 sink/importer 依赖的问题。
- 补充「重启记住上次工作区」：`resolveInitialWorkspace()` 启动时优先读注册表最近项，cli 用它推导 config/store 的 dbPath（DB 文件就落在所选文件夹，重启不再回退到 data/）。
---

## 2026-08-14（续）—— 借鉴 DSH 的工作区持久化实现

### 调研结论（DSH `@deepseek-ai/dsh-workspace`）

- DSH 用「工作区注册表」（`WorkspaceRegistry`，Cordis Service）而非单个当前目录指针：持久化一张 `workspaces` KV 表 + 全局状态（顺序/归档/初始化标记），落在 `~/.dsh`（storage-domain → storage-json，原子写）。
- 记录 `workspaceRecord = { path(realpath 规范化), title(basename), sessionIds(有序), createdAt, updatedAt }`；工作区文件夹只放会话数据，注册表全局一份。
- 新建按规范化路径去重复用；session 通过 header.cwd 归账到工作区；首次启动一次性 bootstrap 从既有 session 反推工作区；写操作带 pendingMutation 标记可恢复。

### 借鉴落地（ProbeStation）

- 注册表从 `string[]` 升级为记录 `{ path, title, lastUsedAt }`（title=basename），按规范化路径去重，兼容旧 string[] 迁移。
- 注册表原子写（tmp + rename，失败回退直写）。
- 前端工作区栏/最近列表显示 basename 标题（含完整路径副文本）。
- Live 表格：列名「实时值」→「值」，去掉「写值」列；改为**双击值**弹「写寄存器」窗口（输入值 + 选功能码 FC06 单写 / FC16 多写）。
- 分组可折叠：分组头部加 ▾/▸ 折叠箭头（点箭头或组名收起/展开表格）。
- **类型系统（修复 dataType 从不生效的 bug）**：新增 `packages/core/src/codec.ts`（int16/uint16/float16/int32/uint32/float32 编解码 + 大端字序 + hex）；前端按类型解码显示（32 位合并相邻两地址）、HEX 开关、类型下拉加 float16；写值按类型编码（32 位写 2 个寄存器，弹窗里 32 位锁定 FC16）。`poller.write` 改收 `values[]`。测试 test-codec / test-codec-write 通过。
- **拍板只做 16 位**：移除 int32/uint32/float32（编解码、32 位合并显示、写 2 寄存器逻辑全删），只保留 int16/uint16/float16；词序问题随之消失（单 16 位寄存器协议层即大端）。`decode/encodeRegister` 改单字、`poller.write` 回收单值、导入器 32 位码收敛为 int16；删除 test-codec-write。
- MCP 补 6 个 CRUD 工具（create_group/update_group/create_register/update_register/delete_register/delete_group），供 agent 开发时动态增删改分组与寄存器；顺带修了 mcp 漏 import `encodeRegister` 的潜在 bug。
- **修复设备级「断开」无效 bug**：poller 的轮询循环是启动时按设备建的 setInterval，pollObject 之前不重新检查设备 isActive，所以断开后仍继续读。现每轮开头重新 `getObject().isActive`，断开即停止轮询。测试 test-device-toggle。
- 工作区文件夹行加 DSH 风格：悬停卡片（标题 + 完整路径 + 创建时间）+ 文件夹 SVG 图标（开/合），workspace 记录补 `createdAt`。
- 侧边栏进一步对齐 DSH 侧边栏结构：logo 行 → 大按钮「＋ 新工作区」（对应 DSH 的「新会话」）→ 「工作区」区块（文件夹行右侧「＋」= 新建设备）→ 底部设置（ws-list flex:1 使设置固定在底部）。
- 侧边栏工作区 UI 对齐 DSH：区块标题「工作区」，工作区以文件夹树展示（📁/📂 + ▸/▾ 折叠箭头 + 标题 + 当前数量），当前工作区展开显示设备、其他工作区折叠点击即切换，底部「＋ 添加工作区」。
- hex/bin 并入类型矩阵：类型下拉改为 6 组（16/32/64 位 × 大端/小端），每组含 int/uint/float + hex/bin（`hex16`/`hex16-LE`/`hex32`/`bin64-LE`… 共 30 种）；16 位也有大小端（`-LE`=字节交换 `swap16`，32/64 位=字序反转）；hex/bin 为原始显示格式（不可写）。撤掉全局「值/HEX/BIN」开关。
- **最终态：16/32/64 位 + 端序下拉**：`codec` 支持 9 基础类型 + `-LE` 小端变体（共 15 种）；`registerWidth`=1/2/4；合并显示「首字显示合并值、被覆盖字显示 —、数据不足显示 —」；类型下拉用 optgroup 分「16 位 / 大端 / 小端」三组；数据不足改类型被拒（前端 + 后端 `PUT /api/registers/:id` 校验 `startAddress+width <= 组范围`）；64 位整数用 BigInt（前端写值传字符串、后端 BigInt）。`poller.write` 回收 `values[]`。测试 test-codec（15 类型往返）/ test-codec-io（32/64 位写 + 拒绝）通过。
- `resolveInitialWorkspace` 读最近一条记录 path，重启记住上次工作区（不变）。








