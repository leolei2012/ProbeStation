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
- `PUT /api/rules/:id` — 编辑完整规则 `{registerId, operator, threshold, message}`
- `DELETE /api/rules/:id` — 删除

## 前端联动

设备页面的「告警规则」可添加、编辑、删除规则。界面使用有效的最新采样持续显示当前触发项，条件恢复后自动消除；数据过期、设备或分组暂停、通信异常时显示等待有效数据，不将其当作正常值。

比较对象是按点位类型解码后的原始值，不应用工程系数、偏移或显示小数位舍入。后端按数据区域隔离并检查完整字宽；64 位整数比较不转为浮点数。同一次持续告警只记录一条 WARN 日志并发一个 `rule/trigger` 事件，恢复后再次命中才重新记录。日志可在现有运行日志中查看。

## 当前限制（TODO）

- 仅单阈值比较，无多条件、无告警去抖/恢复通知。
- 不包含独立的告警历史表、声音通知或后台操作系统通知；日志按现有日志保留策略清理。
