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
