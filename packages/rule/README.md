# @probebench/rule

告警规则引擎。注入 `config`，订阅 `poller/result` 实时评估采样点。

## 规则模型

| 字段 | 说明 |
|---|---|
| `registerId` | 目标寄存器 id |
| `operator` | 比较符：`>` `<` `>=` `<=` `==` `!=` |
| `threshold` | 阈值 |
| `message` | 命中提示 |

## 评估流程

`poller/result` → 逐点匹配规则（同 registerId）→ 比较 → 命中发 `rule/trigger` 事件：

```ts
{ ruleId, objectId, registerId, value, threshold, message, timestamp }
```

## API 端点（由 api 插件暴露）

- `GET /api/rules` — 规则列表
- `POST /api/rules` — 新建 `{registerId, operator, threshold, message}`
- `DELETE /api/rules/:id` — 删除

## 前端联动

`rule/trigger` 事件由 api 转发到 WebSocket（`{type:'rule/trigger', ...}`），前端可实时弹告警。

## 当前限制（TODO）

- 仅单阈值比较，无多条件、无告警去抖/恢复通知。
- 告警历史未落库（仅实时事件）。
