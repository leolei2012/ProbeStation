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
| `port` | number | 8080 | 监听端口 |
| `staticDir` | string | — | 前端 dist 路径（存在才托管） |

## REST 端点

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
