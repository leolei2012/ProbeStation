# @probebench/mcp

MCP（Model Context Protocol）服务器：把 ProbeStation 的「读/写/查设备」能力暴露成 MCP 工具，
供 DeepSeek Harness（或任意 MCP 客户端）通过 streamable-http 连接调用。

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `host` | string | 0.0.0.0 | 监听地址 |
| `port` | number | 9091 | 监听端口（独立于 REST 的 9090） |

## 传输

- streamable-http（有状态，sessionIdGenerator 用 randomUUID）。
- 端点：`http://<host>:<port>/mcp`。
- 用**独立原生 HTTP 服务器**（`node:http`），不挂 Fastify（避免 hijack 冲突）。

## 工具

完整操作指南见 [操作 skill](../../docs/probestation-operator/SKILL.md)。以连接后 `tools/list` 返回的 schema 为准。

| 工具 | 参数 | 说明 |
|---|---|---|
| `list_devices` | — | 设备列表（id/名称/IP/端口/状态） |
| `list_registers` | `device_id` | 某设备寄存器定义（id/别名/地址/类型） |
| `create_device` / `update_device` | name 或 device_id、mode?、transport?、连接参数 | mode=master/slave；主站主动连接，从站在本机监听 TCP 或 RTU |
| `delete_device` | `device_id` | 删除设备、分组、点位和告警，释放监听；保留历史 |
| `get_device_health` | `device_id` | 主站连接/轮询状态；从站 slave_service 监听、请求、连接数及错误 |
| `set_device_active` | `device_id, active` | 主站连接/断开，从站启动/停止监听 |
| `set_poll_interval` | `device_id, poll_interval_ms` | 仅主站，设扫描间隔（毫秒，≥1 整数） |
| `set_data_retention` | `retention_seconds, device_id?` | 设历史保留（秒，0=永久；缺省 device_id 设全局，否则设该设备覆盖） |
| `get_data_retention` | `device_id?` | 查当前生效保留时长（设备覆盖优先于全局） |
| `read_register` | `device_id, area, address` | 按数据区和协议地址读取缓存快照，不主动请求新值 |
| `write_register` | `device_id, address, value, area?, method?` | 工程值逆变换编码；主站写真实设备 holding/coil，从站四区本地内存均可设置 |
| `get_device_snapshot` | `device_id` | 读某设备全部寄存器快照（含别名/地址/类型/时间戳/质量） |
| `query_history` | `device_id, area, address, start, end, limit?, offset?` | 查单地址历史时序 |
| `export_history` | `device_id, start, end, format?, register_ids?, tz_offset_min?` | CSV/XLSX，返回文件 base64；中国展示时区 +480 分钟 |
| `delete_history` | `device_id, start, end, dry_run?` | 默认预览行数，false 删除指定设备和时间范围；实时缓存和配置保留 |
| `list_alarm_rules` | `device_id?` | 查询点位告警 |
| `create_alarm_rule` | `register_id, operator, threshold, message?` | 比较解码原始值，支持六种比较符 |
| `update_alarm_rule` | `rule_id, operator?, threshold?, message?` | 编辑规则，省略字段保留 |
| `delete_alarm_rule` | `rule_id` | 删除指定规则 |
| `ask_ai` | `question, context?, device_id?, provider?, model?, effort?` | 复用 AI 设置进行单次咨询，可附设备全部点位缓存；没有工具执行，不修改配置，消耗 API 额度 |
| `start_recording` | `device_id, interval_ms, duration_ms, slave_id?, addresses?` | 连续采样：录 duration_ms，事后 get_recording 回放 |
| `start_trigger_recording` | `device_id, interval_ms, trigger_area, trigger_address, operator, threshold?, before_ms, after_ms, slave_id?, trigger_slave_id?, addresses?` | 触发记录：条件命中缓存前后窗口（operator 支持 > < >= <= == != changed） |
| `get_recording` | `recording_id` | 取录制完整采样序列（原始 16 位字） |
| `list_recordings` | — | 列录制会话（不含 samples） |
| `stop_recording` | `recording_id` | 提前结束/取消录制 |
| `import_points` | `device_id, points[]\|csv` | 批量导入/更新寄存器语义：支持 JSON 点数组或智能 CSV（自动识别列、0x/40001 地址、类型/存储区启发式） |
| `create_group` | `device_id, name, function_code?, start_address, quantity, slave_id?` | 新建分组并自动建立 int16 点位；从站使用设备从站号 |
| `update_group` | `group_id, name?, slave_id?, function_code?, start_address?, quantity?, is_active?` | 更改分组 |
| `create_register` | `group_id, alias?, function_code?, start_address, data_type?` | 新增寄存器 |
| `update_register` | `register_id, alias?, data_type?, unit?, factor?, offset?, enum?` | 更改点位语义配置 |
| `delete_register` | `register_id` | 删除寄存器 |
| `delete_group` | `group_id` | 删除分组 |

## DSH 接入（cordis.yml）

```yaml
- name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: probestation
    transport: streamable-http
    url: http://192.168.90.34:9091/mcp
```

模型会得到 `mcp__probestation__list_devices`、`mcp__probestation__read_register` 等原生工具。

## 与 Web UI 的状态同步

- 所有改配置/连接状态的工具（含 `set_device_active`）最终都走 `ConfigStore` 的变更回调，
  触发 `config/changed` 事件 → api 经 WS 广播 → 前端刷新设备/寄存器列表。
- 因此 MCP 连接/断开设备时，Web UI 的「已连接/未连接」徽标会实时同步，无需手动刷新。

`ask_ai` 依赖 REST/AI 服务和已保存的提供商设置。回答返回 answer、provider、model、effort、elapsedMs；单次调用不加入 UI 聊天历史，调用方提供后续上下文。设备配置和快照若指定会发送至选定提供商；模型建议不等于实际设备事实。软件不设置调用超时，错误不返回 API 密钥或提供商原始错误正文。

## 安全（TODO）

- `write_register` 是控制真机的危险操作，目前直接执行 + 记日志；**尚未接入审批/鉴权**。
  接 AI 自动控制前，需补「读全自动 / 写需人工确认」的分级授权（决策 #14）。
- 无认证：内网任何能访问 9091 的客户端都可调用工具。

## 多从站只读边界（2026-11-06）

`read_register` / `query_history` 仍按设备+area+address 定位；若当前有多个匹配点位会返回缺失/来源歧义错误，不再选择第一项。`get_device_snapshot` 按每个点位当前目标从站取缓存，返回 slave_id、verification、automatic_eligible。缓存多字还需同一有效采样时间、同批和质量有效才能给语义值。query_history 按目标来源读取并保留 NULL 原始来源；旧兼容值不能自动评估，歧义为未知，多字原始历史仍不进行合并解码。只读 handler 通过 mock 注册器测试，未启动真实 MCP 传输或模型。

录制/触发录制的来源选择随后已补齐，见下文。写入等其他地址型工具仍未统一提供显式从站选择，不能据此宣称全部 MCP 工具支持多从站重叠地址。没有调用或测试实机写入。

## 录制来源选择（2026-11-06）

- `start_recording` 新增可选 `slave_id` 作为默认录制源；`addresses` 支持 `{area,address,slave_id?}`，每项来源可覆盖默认值。不筛地址/来源（包括旧的空 addresses）仍录制所有来源，逐样本保留 slaveId、batchId、sourceVerified；来源缺失保持 NULL，sourceVerified=false，不补为当前配置或 1。非法非空源编号的事件不录入。
- 指定地址却省略来源时，只有当前配置能唯一确定来源才接受；无配置/多源重叠时拒绝，要求显式选择，在改采样周期或创建会话前失败。同来源重叠分组不构成来源歧义。本地 slave 模式使用设备自身编号。解析结果固定在会话内，不随分组之后修改而漂移。
- `start_trigger_recording` 新增 `trigger_slave_id`：显式值优先，其次继承 `slave_id`，否则从当前配置唯一解析。它与录制范围独立，可从站 2 触发、只录从站 1。返回的 addresses/trigger 是解析后的 camelCase 描述，get_recording/list_recordings 同时给出范围；触发证据为 triggeredBy。
- 触发条件保持**原始 16 位单字**比较，不按 dtype 合并或作物理值换算。只用目标来源的唯一候选、good 质量、有效整数原始字及不早于布防/前次采样的有效时间。未知/其他源不触发、不改变 changed 基线；目标坏值或重复候选清空 changed 基线，完整有效值恢复。局部 slave 的单字允许无 batchId，不生成批次；原始多字录制的自动消费仍须自行验证同来源/area/采样时间/完整批次及质量。
- sourceVerified 仅代表来源元数据存在，不代表质量、完整多字、物理身份认证或 PASS/FAIL。录制仅在进程内存中保存，没有持久化/导入旧录制路径；重启不会恢复会话，外部保存的缺身份旧记录不能据当前配置回填。
- 同设备同间隔录制可并行，最后一个停止才恢复最初间隔；不同间隔或期间已修改当前间隔时拒绝叠加。停止时若当前周期已经改成别的值则保留该值。最近 50 段上限只淘汰已结束记录，50 段全部活动时拒绝新会话。毫秒参数为整数且不超过 Node 定时器上限 2147483647；触发等待仍有原有 10 分钟上限。

回归 `test-recorder`、`test-recorder-source`、`test-mcp-source` 使用 mock 事件/配置/时钟/工具注册器，不监听端口、不连接设备或修改真实配置。详细兼容契约和示例见 [录制隔离说明](../../docs/develop/03-录制从站隔离.md)。
