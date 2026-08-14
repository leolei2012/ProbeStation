# @probebench/api

REST + WebSocket API（Fastify + @fastify/websocket），镜像原 Monitor 端点。
注入 `config` + `store`，提供 `ctx.api`。

## 依赖

```ts
export const inject = ['config', 'store']
```

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `host` | string | 0.0.0.0 | 监听地址 |
| `port` | number | 8080 | 监听端口 |

## REST 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/api/monitor_objects` | 设备列表 |
| GET | `/api/monitor_objects/:id/groups` | 设备寄存器组 |
| GET | `/api/groups/:gid/registers` | 组内寄存器 |
| GET | `/api/monitor_objects/:id/latest` | 最新快照（热层） |
| GET | `/api/data/query?object_id=&register_id=&start=&end=` | 历史时序（冷层） |

## WebSocket

- 路径：`/ws`
- 连接时立即推送 `{ type: 'latest', data: {...} }`（最新快照）。
- 每次轮询结果广播 `{ type: 'poller/result', objectId, points }`（实时推送）。
- 事件来源：订阅 Cordis 全局事件 `poller/result`（由 `poller` 插件发射）。

## 服务 `ctx.api`

返回 `FastifyInstance`（**未自动 listen**，便于 `app.inject()` 测 REST、`app.listen()` 测 WS）。

```ts
const app = ctx.get('api', false)
// REST 测试（不绑端口）
const res = await app.inject({ method: 'GET', url: '/api/monitor_objects' })
// 真实启动（含 WS）
await app.listen({ host, port })
```

## 当前限制（TODO）

- `/latest` 未按 objectId 过滤（返回全量快照，依赖 registerId 全局唯一）。
- `registerId` 目前由 poller 用 `startAddress` 占位，尚未与 `config` 的真实 register id 对齐。
- 无鉴权（决策 #14：暂不做）。
