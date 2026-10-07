# ProbeStation（砺台）

面向嵌入式设备的**观测与测试平台**：监控是数据底座，AI 测试是大脑与核心卖点。
用 DeepSeek Harness（DSH）「一切皆插件」的理念，以 TypeScript + Cordis 全量重写了旧 Monitor（Python FastAPI + Quasar）。

## 📚 文档导航

| 文档 | 内容 |
|---|---|
| [`docs/probestation-operator/SKILL.md`](docs/probestation-operator/SKILL.md) | **Agent 操作技能**：接入 MCP/REST、设备与点位、历史/实时曲线、诊断与操作边界 |
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
| 5 | 降采样、AI 调试语义层 | ⬜ |

**已实现**：Modbus TCP/RTU 轮询、DuckDB 时序、REST+WS（心跳、断线重连、REST 兜底）、React 仪表盘（DSH 风格）、写寄存器、CRUD、从站模拟、告警、MBS/MBP 导入、CSV/XLSX 导出、**点位表 xlsx 导出/导入（分组=sheet）**、日志、工作区、按设备轮询速率、数据保留、连续/触发录制、34 个 MCP 工具、OTA 固件升级（0x41 IAP，TCP/RTU）。
**未实现**：时序降采样、AI 调试语义层（语义清单/DSH skill）、FC05/FC15 线圈写入及后续完整从站能力。

---

## 快速开始

```bash
# Node.js >= 22.19.0
npm install
npm run start   # 构建前端 + 一键启动
```

- **8080**：Web UI + REST API + WebSocket → 浏览器开 http://localhost:8080
- **8081**：MCP 服务器（给 AI agent 的工具）

首次启动自动播种「测试从站」（192.168.90.176:8899，两段数据：0x0000 上升 + 0x1000 下降）+「本地模拟器」。数据在 `data/`（删掉即重置）。

---

## 内置 AI 助手

启动后点击左下角 **设置 → AI 助手**，选择第三方提供商并填写 API Key；各提供商的配置分别保存。聊天框右下角可切换提供商的模型和该模型支持的推理等级。底层复用 DSH 使用的 `@earendil-works/pi-ai`（0.87.x）；当前接入 API Key 提供商，尚未接入 OAuth、AWS/Vertex 等云凭据流程。自定义模型 API 保留以下 Chat Completions 接入。
接口使用支持工具调用的 Chat Completions 协议，程序自动在基础地址后追加 `/chat/completions`；例如基础地址可以包含服务商要求的 `/v1`。远程地址要求 HTTPS，本机 `localhost` / `127.0.0.1` 可使用 HTTP 和免密模型服务。不需要额外启动 DSH 或 MCP 客户端。

- **查询**：设备、点位定义、当前缓存值、历史数据、通信统计和最近报文。
- **修改**：设备名称/扫描间隔/超时，分组名称/启停，点位名称/单位/比例/偏移。AI 只生成提案，界面展示目标、新旧值，用户确认后执行并读回验证。提案 10 分钟有效，配置已被其他操作改变时拒绝执行。
- **不开放给内置 AI**：硬件写入、删除、固件升级、任意 shell/SQL/HTTP 调用。现有外部 MCP 的能力不变。
- 选择设备后，对话限定在该设备；切换设备重新开始。会话保存在服务器内存，闲置 30 分钟过期，不支持重启后恢复。支持新对话、停止、工具调用记录及确认/拒绝。
- 模型服务会接收对话和按需查询的数据；密钥保存在实际数据目录的 `ai-settings.json`，不会通过设置读取接口返回，也不会放在浏览器 localStorage。该文件不是加密保险库，迁移/备份时须按密钥文件处理。更换 API 地址而未输入新密钥时，旧密钥会清除。
- AI 设置在实例内共享。程序当前仍是无账户鉴权的本地/可信内网工具；同源检查和会话随机 ID 不等同于用户身份认证，不应直接暴露到公网。
- 历史查询每页最多 500 点、单次区间最多 24 小时，支持分页；返回原始解码值及语义配置，统计仅代表返回页。相邻字按毫秒时间对齐，缺字返回 null。当前值是采集缓存，必须结合样本时间和质量判断。

可试问：“查看当前设备的数据和采样时间”“检查设备通信有没有异常”“把当前设备采样间隔改成 500ms”。首次保存设置后发送一个问题即可验证服务；HTTP 错误会显示在对话面板。

实现入口：`packages/api/src/assistant.ts`（有界工具循环、配置、会话、确认），`apps/web/src/AssistantPanel.tsx`（侧栏）。网关复用现有 config/store/poller 服务，维护内置助手的工具白名单。工具调用协议参考 [DeepSeek 官方说明](https://api-docs.deepseek.com/guides/tool_calls/)。

本地模拟测试不需要 API Key，也不会调用模型或真实设备：

```bash
npx tsx scripts/test-assistant.ts
npx tsx scripts/test-assistant-history.ts
```

## 技术栈与插件

TypeScript · Cordis 4（插件运行时）· schemastery（配置校验）· jsmodbus（Modbus）· Fastify（REST/WS）· DuckDB（时序）· node:sqlite（元数据）· React 18 + Vite（前端）· npm workspaces。

## 插件（13 个，全部「一切皆插件」）

`core / config / modbus / poller / store / sink / rule / api / slave / importer / mcp / ota / workspace` + 前端 `apps/web` + 入口 `apps/cli`。

完整职责、服务契约、数据流、插件开发范式、踩坑记录见 [`docs/03`](docs/03-开发与接手指南.md)。

---

## 冒烟测试

```bash
npx tsx scripts/test-loop.ts      # 轮询→落库→查询
npx tsx scripts/test-protocol.ts  # 统一 Modbus 模型、校验、结构化错误和兼容执行入口
npx tsx scripts/test-modbus-diagnostics.ts # 有界报文缓冲、错误率和响应耗时统计
npx tsx scripts/test-store-area-migration.ts # 时序表 area 结构升级与四数据区隔离
npx tsx scripts/test-crud.ts      # 写寄存器 + CRUD
npx tsx scripts/test-ws.ts        # WebSocket
npx tsx scripts/test-rule.ts      # 告警
npx tsx scripts/test-mcp.ts       # MCP 34 个工具
npx tsx scripts/test-pointsheet.ts # 点位表 xlsx 导出/导入（分组=sheet）往返
npx tsx scripts/test-rtu-recover.ts # RTU TX/RX 断线重接自动恢复
# ... 全部见 docs/03 §2
```
