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
| `create_device` | name、mode?、transport?、连接参数 | mode=master/slave；创建可能开始运行 |
| `get_device_edit_snapshot` | `device_id` | 只读原expected，供设备编辑条件保存 |
| `update_device` | `device_id, expected`、原可选变更字段 | 有条件修改，缺expected拒绝；返回原设备字段及已保存/warnings |
| `delete_device` | `device_id` | 删除设备、分组、点位和告警，释放监听；保留历史 |
| `get_device_health` | `device_id` | 主站连接/轮询状态；从站 slave_service 监听、请求、连接数及错误 |
| `set_device_active` | `device_id, active` | 主站连接/断开，从站启动/停止监听 |
| `set_poll_interval` | `device_id, poll_interval_ms` | 仅主站，设扫描间隔（毫秒，≥1 整数） |
| `set_data_retention` | `retention_seconds, device_id?` | 设历史保留（秒，0=永久；缺省 device_id 设全局，否则设该设备覆盖） |
| `get_data_retention` | `device_id?` | 查当前生效保留时长（设备覆盖优先于全局） |
| `read_register` | `device_id, area, address, slave_id?, register_id?` | 按数据区和协议地址读取缓存快照，不主动请求新值 |
| `write_register` | `device_id, address, value, area?, method?` | 工程值逆变换编码；主站写真实设备 holding/coil，从站四区本地内存均可设置 |
| `get_device_snapshot` | `device_id` | 读某设备全部寄存器快照（含别名/地址/类型/时间戳/质量） |
| `query_history` | `device_id, area, address, start, end, slave_id?, register_id?, limit?, offset?` | 查单地址历史时序 |
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
| `get_recording_interval_status` | `device_id` | 只读当前间隔/活动录制/当前配置保留的核对记录与移出计数，不恢复或连接 |
| `list_recordings` | — | 列录制会话（不含 samples） |
| `stop_recording` | `recording_id` | 提前结束/取消录制 |
| `import_points` | `device_id, points[]\|csv` | 更新已有语义；可选逐点 slave_id/register_id，歧义跳过并返回候选，省略字段/缺列保留原值 |
| `create_group` | `device_id, name, function_code?, start_address, quantity, slave_id?` | 新建分组并自动建立 int16 点位；从站使用设备从站号 |
| `get_group_edit_snapshot` | `group_id` | 一致的组/点位/告警/来源快照及revision |
| `preview_group_update` | `group_id, expected_revision`、原可选变更字段 | 只读核对原版本并给出完整增删计划 |
| `update_group` | `group_id, expected_revision`、原变更字段、确认删除ID数组 | 条件更新；删除须传confirmed_delete_register_ids/confirmed_delete_rule_ids |
| `create_register` | `group_id, alias?, function_code?, start_address, data_type?` | 新增寄存器 |
| `get_register_edit_snapshot` | `register_id` | 只读一致点位/分组/设备来源快照，返回expected |
| `update_register` | `register_id, expected, alias?, data_type?, unit?, factor?, offset?, enum?` | 带原expected条件更新；缺条件428、冲突409，保留根记录并附configuration_saved/warnings |
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

`read_register` / `query_history` 按设备+area+address 定位，新增可选 slave_id/register_id；只接受唯一且一致的匹配，未指明而存在歧义时返回候选，不选择第一项。`get_device_snapshot` 按每个点位当前目标从站取缓存，返回 slave_id、verification、automatic_eligible。缓存多字还需同一有效采样时间、同批和质量有效才能给语义值。query_history 按目标来源读取并保留 NULL 原始来源；旧兼容值不能自动评估，歧义为未知，多字原始历史仍不进行合并解码。只读 handler 通过 mock 注册器测试，未启动真实 MCP 传输或模型。

录制/触发录制的来源选择随后已补齐，见下文。写入等其他地址型工具仍未统一提供显式从站选择，不能据此宣称全部 MCP 工具支持多从站重叠地址。没有调用或测试实机写入。

## 录制来源选择（2026-11-06）

- `start_recording` 新增可选 `slave_id` 作为默认录制源；`addresses` 支持 `{area,address,slave_id?}`，每项来源可覆盖默认值。不筛地址/来源（包括旧的空 addresses）仍录制所有来源，逐样本保留 slaveId、batchId、sourceVerified；来源缺失保持 NULL，sourceVerified=false，不补为当前配置或 1。非法非空源编号的事件不录入。
- 指定地址却省略来源时，只有当前配置能唯一确定来源才接受；无配置/多源重叠时拒绝，要求显式选择，在改采样周期或创建会话前失败。同来源重叠分组不构成来源歧义。本地 slave 模式使用设备自身编号。解析结果固定在会话内，不随分组之后修改而漂移。
- `start_trigger_recording` 新增 `trigger_slave_id`：显式值优先，其次继承 `slave_id`，否则从当前配置唯一解析。它与录制范围独立，可从站 2 触发、只录从站 1。返回的 addresses/trigger 是解析后的 camelCase 描述，get_recording/list_recordings 同时给出范围；触发证据为 triggeredBy。
- 触发条件保持**原始 16 位单字**比较，不按 dtype 合并或作物理值换算。只用目标来源的唯一候选、good 质量、有效整数原始字及不早于布防/前次采样的有效时间。未知/其他源不触发、不改变 changed 基线；目标坏值或重复候选清空 changed 基线，完整有效值恢复。局部 slave 的单字允许无 batchId，不生成批次；原始多字录制的自动消费仍须自行验证同来源/area/采样时间/完整批次及质量。
- sourceVerified 仅代表来源元数据存在，不代表质量、完整多字、物理身份认证或 PASS/FAIL。录制仅在进程内存中保存，没有持久化/导入旧录制路径；重启不会恢复会话，外部保存的缺身份旧记录不能据当前配置回填。
- 同设备同间隔录制可并行，最后一个停止才恢复最初间隔；不同间隔或期间已修改当前间隔时拒绝叠加。停止时原子核对原设备快照及间隔写入身份；同值写入/ABA或外部SQLite连接提交也保留当前值。返回恢复状态及警告，不能将done或ok=true当作已恢复。最近 50 段上限只淘汰已结束记录，50 段全部活动时拒绝新会话。毫秒参数为整数且不超过 Node 定时器上限 2147483647；触发等待仍有原有 10 分钟上限。

回归 `test-recorder`、`test-recorder-source`、`test-mcp-source` 使用 mock 事件/配置/时钟/工具注册器，不监听端口、不连接设备或修改真实配置。详细兼容契约和示例见 [录制隔离说明](../../docs/develop/03-录制从站隔离.md)。

## 只读精确选点（2026-11-06）

read_register/query_history 可选 `slave_id`（0–255 整数）或 `register_id`（从 list_registers/candidates 发现的正安全整数）。两者同时给出必须与当前点位所属设备、area、address 和配置目标从站一致。只有一个匹配时沿用旧调用方式；同从站同地址存在多个语义定义时需要 register_id。不匹配不降级到其他来源，非法输入/无匹配/歧义在读缓存或历史前返回 isError=true，text 为 JSON：error、code（REGISTER_SELECTOR_INVALID/REGISTER_NOT_FOUND/REGISTER_AMBIGUOUS）、candidates（仅当前设备该地址的 register_id/group_id/slave_id/alias/data_type）。

选择只决定当前点位与期望来源，不赋值给旧 NULL 历史，也不解除质量/完整批次要求；指定来源仍不能把旧未归属数据变成已验证值。query_history 返回所选 register_id/slave_id/group_id，逐行 slave_id 仍是原始来源。MCP 多字原始历史继续不自动合并。本轮不增加 write_register 的来源参数，不执行写入或任何设备操作。示例与兼容边界见 [只读选点说明](../../docs/develop/04-只读点位选择.md)。

## 只读点表诊断（2026-11-06）

`diagnose_points {device_id}` 仅读 getObject/listGroups/listRegistersByObject，用共享纯函数报告点宽/范围/引用错误，以及重复、覆盖、重叠与语义导入歧义警告。返回 scope=point-table-structure、ok、complete、summary 和 issues；错误代码/位置/相关点位 ID 可用于人工定位，不返回连接凭据或完整配置。不会更新配置、查历史/缓存、连接设备或改变采样周期；不能把 ok 当作在线、采样有效或测试通过。默认覆盖 int16 占位行只计数，跨从站同址不作物理冲突，但旧语义导入缺源选择仍可能警告。完整规则和离线 CLI 见 [诊断说明](../../docs/develop/05-离线点表诊断.md)。

## 语义点表更新（2026-11-06）

import_points的JSON行支持可选slave_id/register_id；CSV识别来源/点位ID列。必须与设备、area/address一致，多候选返回details/candidates并跳过，不任选首项。JSON省略字段/CSV缺列保留原值；unit/enum显式null清除，存在但空白的CSV单元格沿用旧默认/清空行为。有效行原子提交，仍需检查updated/skipped/errors及新增details/warnings/parse，不能把工具返回当作全部行成功。数量/归属/告警不改；不是全量import_points_xlsx。见[完整兼容规则](../../docs/develop/07-语义点表安全导入.md)。注册器mock已验证参数映射，无实际MCP监听或配置写入。

全量import_points_xlsx先校验整本v2计划，再事务替换；错误保留原配置，无分组页拒绝清空。现保留分组从站/显式范围、独立quantity和零倍率，检查多字完整覆盖，不补占位。缺来源/FC默认1/FC03及推导范围均会返回warnings要求核对，缺quantity默认1。提交后通知/日志失败也可能只返回警告，不自动重试。v2其他未定义字段不猜测，范围与限制见[说明](../../docs/develop/09-XLSX点表字段保真.md)。

export_points_xlsx会分配合法唯一页签，B1保留原组名，告警G可引用页签；现点位L/告警H可选文件内“点位标识”支持同页同址多个定义各自告警。它不是数据库register_id，不入库、不用于其他MCP工具。所有显式条件须一致，重复/失效/冲突ID拒绝；旧无标识仍只接受唯一匹配，不猜归属。详见[页签](../../docs/develop/10-XLSX工作表名称与告警定位.md)与[文件内身份](../../docs/develop/11-XLSX文件内点位标识.md)。

## 配置编辑条件迁移

`update_device`、`update_group`保留工具名、原snake_case变更字段和结果根部的设备/组字段。执行更新时新增条件必需：schema中条件字段可选是为了让旧参数形状得到明确的`isError:true` / `CONFIG_PRECONDITION_REQUIRED`（status 428）和next_tool；缺条件不执行，也不临时读取新条件套在旧意图上。旧客户端需升级，不能把此行为称为完全向后兼容。

- 设备：`get_device_edit_snapshot {device_id}`取得expected，核对原值后，`update_device {device_id, expected, ...原变更字段}`。
- 分组：`get_group_edit_snapshot {group_id}`取得revision及完整图；`preview_group_update {group_id, expected_revision:revision, ...原变更字段}`核对计划。确定删除对象后，在`update_group`显式带同一expected_revision、原变更及`confirmed_delete_register_ids:plan.delete_register_ids`、`confirmed_delete_rule_ids:plan.delete_rule_ids`。没有删除可省略确认数组。
- 预览拒绝过期版本，不自动返回新条件；保存时服务端在同一事务内再核对。冲突409需重新审阅，不自动重试；不退回旧REST。
- 成功结果保留原记录字段，增加configuration_saved=true及warnings；组另附revision和实际增删ID。连接应用/通知/日志失败是已保存警告，不能当作配置未保存重试。设备MCP原master重连、随后从站同步的顺序保留，本轮没有变更硬件策略。

新读工具只读配置，不枚举、连接或探测仪器。条件是并发保护，不是鉴权/授权或持久幂等键。点位`update_register`现须先`get_register_edit_snapshot`并原样携带expected；助手确认/撤销也已使用原条件。旧REST、窄状态命令、录制等剩余调用不因此获得保护，详见[最新调用方及边界](../../docs/develop/38-点位调用与助手提案条件保护.md)。先查运行实例tools/list，不能假设本地代码已部署。

## 录制间隔归还（2026-11-06）

开始返回warnings；get/list_recordings新增intervalRestore/warnings，stop/delete_recording新增interval_restore/warnings，旧ID/ok字段保持。pending为活动，shared为其他会话继续持有，restored为本次事务恢复，preserved为保留当前值，uncertain需核实。开始后通知/日志失败不报假开始失败；停止不自动重试。其他连接的任何提交都保守失效，可能保留录制短周期，须人工核对。进程退出不自动恢复，无持久锁/跨进程排程，不改旧REST的无条件更新契约，见[实现及剩余边界](../../docs/develop/39-录制间隔归还与并发修改保护.md)。

## 录制间隔核对提示

`get_recording_interval_status {device_id}`只读返回本次checkedAt、current、active、notices、retention。核对记录独立于样本，当前配置最近100条，超限有全局dropped计数；reopen或进程重启不保留，不按当前值相等推断已处理。available=false表示服务未提供，current=null表示设备缺失。Web概要使用相同只读结果；失败保留旧记录并标记未核实。需调整时人工核对并使用既有设备编辑及原条件，不能盲目用旧原值或无条件REST恢复。详见[状态与覆盖边界](../../docs/develop/40-录制间隔核对提示与只读检查.md)。
