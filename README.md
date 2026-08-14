# ProbeStation（砺台）

面向嵌入式设备的**观测与测试平台**：监控是数据底座，AI 测试是大脑与核心卖点。
用 DeepSeek Harness（DSH）「一切皆插件」的理念，以 TypeScript + Cordis 全量重写了旧 Monitor（Python FastAPI + Quasar）。

## 📚 文档导航

| 文档 | 内容 |
|---|---|
| [`docs/03-开发与接手指南.md`](docs/03-开发与接手指南.md) | **现状 + 开发指南（接手必读）**：怎么跑、架构、插件范式、踩坑、API 速查 |
| [`docs/02-重构架构方案.md`](docs/02-重构架构方案.md) | Phase 0 架构方案与选型决策 |
| [`docs/01-项目初步讨论纪要.md`](docs/01-项目初步讨论纪要.md) | 立项背景与调研 |
| [`conversation_log.md`](conversation_log.md) | 历次讨论流水 |
| 每个包的 `README.md` | 各插件的 Config / Service / 用法 / 限制 |

---

## 当前状态

| Phase | 内容 | 状态 |
|---|---|---|
| 0–4 | 脚手架 → 采集/持久化 → API/前端 → 全部功能（slave/importer/sink/rule/logs/写/CRUD/MCP） | ✅ |
| 5 | 降采样/保留、AI 测试层 | ⬜ |

**已实现**：Modbus 轮询、DuckDB 时序、REST+WS、React 仪表盘（DSH 风格）、写寄存器、CRUD、从站模拟、告警、MBS/MBP 导入、CSV/XLSX 导出、日志、MCP 服务器（AI 接口）。
**未实现**：OTA 固件升级、降采样/保留、AI 测试层（语义 Excel → DSH skill）。

---

## 快速开始

```bash
npm install
npm run start   # 构建前端 + 一键启动
```

- **8080**：Web UI + REST API + WebSocket → 浏览器开 http://localhost:8080
- **8081**：MCP 服务器（给 AI agent 的工具）

首次启动自动播种「测试从站」（192.168.90.176:8899，两段数据：0x0000 上升 + 0x1000 下降）+「本地模拟器」。数据在 `data/`（删掉即重置）。

---

## 技术栈

TypeScript · Cordis 4（插件运行时）· schemastery（配置校验）· jsmodbus（Modbus）· Fastify（REST/WS）· DuckDB（时序）· node:sqlite（元数据）· React 18 + Vite（前端）· npm workspaces。

## 插件（11 个，全部「一切皆插件」）

`core / config / modbus / poller / store / sink / rule / api / slave / importer / mcp` + 前端 `apps/web` + 入口 `apps/cli`。

完整职责、服务契约、数据流、插件开发范式、踩坑记录见 [`docs/03`](docs/03-开发与接手指南.md)。

---

## 冒烟测试

```bash
npx tsx scripts/test-loop.ts      # 轮询→落库→查询
npx tsx scripts/test-crud.ts      # 写寄存器 + CRUD
npx tsx scripts/test-ws.ts        # WebSocket
npx tsx scripts/test-rule.ts      # 告警
npx tsx scripts/test-mcp.ts       # MCP 工具
# ... 全部见 docs/03 §2
```
