# @probebench/api

REST + WebSocket API（Fastify + @fastify/websocket），镜像原 Monitor 端点。
注入 `config` + `store` + `poller`，提供 `ctx.api`。

## 依赖

```ts
export const inject = ['config', 'store', 'poller']
```

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `host` | string | 0.0.0.0 | 监听地址 |
| `port` | number | 9090 | 监听端口 |
| `staticDir` | string | — | 前端 dist 路径（存在才托管） |

## REST 端点

### 配置备份与曲线

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/config/backup` | 下载版本化、可阅读的 JSON 配置；不含历史、固件文件和密钥 |
| POST | `/api/config/backup/preview` | 校验备份并返回新增数量、设备及同名提示；不写现有配置 |
| POST | `/api/config/backup/restore` | 事务新增；重映射 ID，保持现有配置与历史，新增设备暂停 |
| GET | `/api/data/object/series` | object_id/start/end/register_ids/max_points；解码后峰谷采样，覆盖完整视窗并返回样本数量 |

备份 POST 请求体为导出的 JSON，需 `x-probestation-config: 1`；浏览器 Origin 需同源。上传上限 64 MiB。曲线请求取消会中断独立连接上的查询，`register_ids` 仅允许当前设备的点位。实现分别在 `config-backup.ts` 和 `curve.ts`。

### 设备（monitor_objects）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/monitor_objects` | 列表 |
| POST | `/api/monitor_objects` | 新建 `{name,ip,port,mode}` |
| PUT | `/api/monitor_objects/:id` | 更新 |
| DELETE | `/api/monitor_objects/:id` | 删除（级联） |
| POST | `/api/monitor_objects/:id/toggle` | 切换启用 |
| GET | `/api/monitor_objects/:id/groups` | 组列表 |
| POST | `/api/monitor_objects/:id/groups` | 新建组 |

### 组（groups）
| 方法 | 路径 | 说明 |
|---|---|---|
| PUT | `/api/groups/:id` | 更新 |
| DELETE | `/api/groups/:id` | 删除 |
| POST | `/api/groups/:id/toggle-pause` | 切换暂停 |
| GET | `/api/groups/:gid/registers` | 寄存器列表 |
| POST | `/api/groups/:gid/registers` | 新建寄存器 |

### 寄存器（registers）+ 写
| 方法 | 路径 | 说明 |
|---|---|---|
| PUT | `/api/registers/:id` | 更新 |
| DELETE | `/api/registers/:id` | 删除 |
| POST | `/api/registers/:id/write` | 写值 `{value, method:'single'\|'multiple'}`（FC06/FC16） |

### 数据
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/monitor_objects/:id/latest` | 最新快照 |
| GET | `/api/data/query?...` | 历史时序 |
| GET | `/health` | 健康检查 |

## WebSocket

- `/ws`：连接推 `latest`，轮询结果广播 `poller/result`。

## 当前限制（TODO）

- `/latest` 未按 objectId 过滤。
- 写寄存器默认 `multiple`（FC16，适配固件只开 FC03+FC16）。
- 无鉴权（决策 #14）。

## 内置助手历史选点（2026-11-06）

内置 query_history 工具支持可选 slave_id/register_id，与 MCP 共用纯函数选择契约：设备/area/address 必须匹配，两个可选条件同时提供必须一致。list_points 返回的 id/slaveId 可用于选择；歧义返回结构化 candidates，帮助用户明确来源，不猜测第一项。同从站重复语义定义可用 register_id 精确选择。选择错误不查历史、不生成分析来源链接；成功查询沿用所选点位的 dtype 和分组来源，原有会话设备权限保持有效。旧 NULL 身份仍按共享历史规则人工兼容/未知，不能自动计入统计。

工具 schema 和候选/范围/NULL/错误路径由 fakeFetch 模型网关测试，没有真实模型调用或生产配置/数据库操作。见 [只读选点说明](../../docs/develop/04-只读点位选择.md)。
