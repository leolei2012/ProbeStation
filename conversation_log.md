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
