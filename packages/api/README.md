# @probebench/api

开关新增`PUT /api/monitor_objects/:id/activation`和`PUT /api/groups/:id/activation`，body为`{expected:ActivationSnapshot,isActive:0|1}`，仅允许与expected不同的显式目标。事务核对设备字段/来源及开关状态，拒绝400/404/409在写前；成功`{snapshot,warnings}`，提交后同步/通知异常为warning，未知500需核对。原POST toggle/toggle-pause及返回形状不变，新UI不回退。不是请求幂等或防ABA，字段及限制见[条件开关](../../docs/develop/82-设备与分组条件开关.md)。

诊断清空新增`GET /api/monitor_objects/:id/diagnostics/cleanup-preview`（no-store）与`POST /api/monitor_objects/:id/diagnostics/cleanup`，POST仅`{token}`、16KiB，并要求x-probestation-config:1及Origin若提供需Host匹配。预览503拒绝不支持目标；POST格式400/头403/条件409，其他500表示未知。预览绑定当前连接、配置库及driver；重复已完成token仅回原结果，不再次清空。不是前缀删除，预览后新增也在确认时清空；旧frames/clear仍无条件兼容，新UI不回退。字段与剩余限制见[说明](../../docs/develop/60-通信诊断清空确认与结果隔离.md)。

日志条件清理新增只读`GET /api/logs/cleanup-preview`（no-store）和`POST /api/logs/cleanup`，body为`{expected:{version:1,throughId,count,revision}}`。POST要求x-probestation-config:1，Origin若提供需Host匹配；这不是鉴权。仅删除预览截止ID范围，返回deleted/alreadyRemoved/remaining；来源/条件不符409，非法400、来源头403，错误500不冒充未执行。原/api/logs/clear保持兼容，新UI不回退，见[精确契约](../../docs/develop/55-预览范围日志清理.md)。

`POST /api/registers/:id/write`明确要求value为非空数值文本或有限数字，拒绝null、缺失、布尔、数组、对象及非有限值（HTTP400，写回调/成功日志均不执行）。int64/uint64数字输入必须为安全整数，大整数使用整数字符串；hex/bin仍遵循其原始进制与无符号范围。0和coil的数值0/1可用，不能以布尔值替代。端点路径/方法选择/来源参数/成功形状不变；没有改变codec舍入/截断/饱和或新增权限机制，见[契约及限制](../../docs/develop/50-寄存器写值输入校验.md)。

`GET /api/monitor_objects/:id/stats`的retention新增`policy:{version:1,objectId,source:'global'|'device'|'unverified',seconds:number|null}`；原retention_seconds仍是全局默认，不能直接作为设备实际时长。0永久，NULL设备覆盖继承全局；未知/不合法策略不猜测。全局`GET /api/stats`及保留设置读写接口契约不变，本轮仅扩展原只读统计返回，未改清理/写入行为，见[说明](../../docs/develop/48-设备保留策略准确显示.md)。

新增只读`GET /api/storage/persistence-status?object_id=正整数`（省略为全服务），Cache-Control:no-store。返回version/available/objectId；可用时包含stateScope=service、checkedAt、phase/failure、flushing、pendingRows/globalPendingRows、lastCommitAt/lastFailureAt，不含SQL/路径/错误原文。设备筛选不把共享写入故障改成设备专属故障；不存在当前配置的ID也仅表示该ID的缓冲计数，未验证配置身份。无服务能力时available=false；参数400、无法核实503。只读刷新不查询DuckDB或触发写/清理/重开，见[字段及限制](../../docs/develop/47-采样落盘状态与设备缓冲计数.md)。

告警上下文扩展：`GET /api/rules/:id/settings`读`{expected,expectedContext}`，`GET /api/registers/:id/alarm-context`读新增用条件，均不缓存。`PUT/DELETE /api/rules/:id/settings`可附原`expectedContext`，提供时必须完整有效，不会降级；`POST /api/rules/settings`用`{fields,expectedContext}`在源条件下新增。上下文成功响应含`protection="rule-and-context"`；旧无context的规则级settings响应字段保持不变，不具有来源保护。原`/api/rules`CRUD未改语义。接口不访问设备、不做真实库结构迁移，详见[字段和兼容边界](../../docs/develop/46-告警点位与来源上下文保护.md)。

告警界面新增`PUT/DELETE /api/rules/:id/settings`：更新传`{expected,changes}`，删除传`{expected}`；expected为打开操作时的完整原规则`id/registerId/operator/threshold/message`，changes仅允许operator/threshold/message且不可为空。事务内全字段核对，不一致409、已删除404、无条件/非法输入400，不回退旧接口。响应`{rule,deletedRuleId,warnings}`，提交后的通知失败仍成功返回警告。现有`/api/rules/:id`与MCP仍无条件兼容；不代表点位/来源或持久修订保护。见[契约及验证](../../docs/develop/45-告警编辑删除旧值核对.md)。

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
| POST | `/api/monitor_objects/:id/groups` | 同事务新建组及默认点位；原组字段加warnings。可选数字isActive=0/1，省略默认1，非法值400且不创建 |

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

## 离线点表结构诊断（2026-11-06）

`GET /api/monitor_objects/:id/point-diagnostics` 只读取该设备当前元数据，报告共享结构诊断（scope、ok、complete、summary、issues），不更新配置/访问硬件，不查询原始历史。成功完成扫描即 200，即使有诊断错误（ok=false）；无效 ID 为400，缺失设备404，读取失败500且不给出内部异常详情。诊断不是完整备份恢复校验、实时质量或测试通过。

内置助手新增只读 diagnose_points 工具，沿用会话设备权限；只返回报告，不自动创建修改提案或写配置。fakeFetch 与只读配置替身已覆盖正常/歧义/权限/无变更路径。离线命令、错误与警告规则见 [诊断说明](../../docs/develop/05-离线点表诊断.md)。

## 语义点表更新

原POST /api/monitor_objects/:id/points/import支持JSON点数组、{csv}或{xlsx}（base64首sheet）；实现抽到points-import.ts，未新增全量替换入口。JSON可选slave_id/register_id，歧义行跳过并返回候选。省略字段/表格缺列保留原值，有列空单元格沿用旧清空/默认行为。报告兼容updated/skipped/errors并附details/warnings/parse；有效行事务提交，不自动改归属/扩组。400/404及非泄露500已用Fastify.inject验证，无服务启动。完整规则和例子见[语义导入](../../docs/develop/07-语义点表安全导入.md)。
