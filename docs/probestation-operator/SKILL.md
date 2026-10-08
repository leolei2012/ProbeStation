---
name: probestation-operator
description: 使用 ProbeStation 操作 Modbus TCP/RTU 主站和从站，通过 MCP、REST 或 Web UI 配置设备角色、点位和告警，读取快照、查询历史、设置从站内存值和诊断通信。适用于操作本软件，不用于一般前端开发。
---

# ProbeStation 操作指南

本指南按 2026-10-08 仓库源码核对。先确认用户要操作的服务地址和设备；优先复用运行中的服务。工具自动化优先使用 MCP，缺少 MCP 时使用 REST；界面操作或曲线交互使用 Web UI。

此目录是可独立分发的 skill。其他 agent 可直接读取本文件；仅放在 `docs` 下不会自动注册到客户端的技能列表。需要自动发现时，将整个 `probestation-operator` 目录复制到目标客户端的 skills 目录。

## 1. 接入与启动

| 服务 | 默认地址 | 用途 |
|---|---|---|
| Web / REST | `http://localhost:8080` | 页面及 `/api` 接口 |
| 健康检查 | `http://localhost:8080/health` | 服务存活，不代表设备通信成功 |
| MCP | `http://localhost:8081/mcp` | Streamable HTTP、有状态会话 |
| WebSocket | `ws://localhost:8080/ws` | 配置变化和采集结果推送 |
| 内置 Modbus 模拟器 | `127.0.0.1:8502` | 示例设备 |

远程使用时将 localhost 换成运行 ProbeStation 的主机地址。MCP 端点不是普通 REST，使用客户端的 MCP 连接流程，发现工具及其当前 schema；工具名前缀由客户端决定。

需要本地启动时，在仓库根目录执行：

```powershell
node --version
node -e "require('node:sqlite'); console.log('sqlite available')"
npm install
$env:PROBESTATION_DATA_DIR = Join-Path (Get-Location) 'data'
npm run start
```

使用支持 `node:sqlite` 的 Node（工程要求 >=22.19.0）。`npm run start` 会先构建前端再启动后端。数据目录应指向已有实例使用的位置，不要为了修复空列表随意切换目录。默认目录是**进程 cwd 下的 data**，`npm run dev` 的 workspace 工作目录可能不同；显式设置绝对数据目录可避免看似丢失配置。

数据目录包含 `config.db`、`poll.duckdb` 和 `firmware/`。更新或迁移前停止实例并备份整个目录；不要用删除目录解决普通启动故障，也不要让两个实例同时使用它。

**启动有实际副作用**：入口会开始轮询已启用设备。空配置首次启动还会创建 `192.168.90.176:8899` 的“测试从站”和本地模拟器；前者是真实网络目标，不能假设启动就是纯模拟。只做文档或 UI 验证时不必启动设备后端。创建或更新设备也可能开始轮询或重连，应限定在用户指定的设备范围内。

## 2. 先识别设备和点位，再读数

常用工作流：`list_devices` → 根据名称及连接信息确定 ID → `list_registers` → `get_device_snapshot`。不要照抄示例 ID，也不要只根据“已连接”判断数据新鲜度。

三个概念必须区分：

- `device_id` / REST `object_id`：平台设备 ID。
- `register_id`：平台配置记录 ID，用于修改点位定义等操作。
- `address` / `start_address`：Modbus 协议地址，通常从 0 开始；不是数据库 ID，也不能直接把手册中的 40001 当协议地址。先核对手册约定。

同一地址在不同数据区是不同点位：

| area | 读取功能码 | 含义 |
|---|---|---|
| `coil` | 1 | 线圈 |
| `discrete-input` | 2 | 离散输入 |
| `holding-register` | 3 | 保持寄存器 |
| `input-register` | 4 | 输入寄存器 |

`read_register`、`query_history` 都要求 area，旧包 README 中省略 area 或使用 register_id 的示例不适用于当前实现。以下是 MCP 工具参数示意，ID 和地址必须替换为发现结果：

```json
{"device_id": 1, "area": "holding-register", "address": 0}
```

`read_register` 读取采集缓存，并不主动发一次新的 Modbus 读取。报告值时同时报告 timestamp、quality、连接/暂停状态；null 或旧时间不能当作当前有效读数。可结合 `get_device_health`、`get_raw_frames` 诊断。多从站若在同设备、同 area 使用重复地址，当前按地址定位可能有歧义，不能将返回的第一个匹配项视为已唯一定位。

## 3. 配置和控制

- 先检查设备 `mode`：`master` 主动读取外部设备，`slave` 在本机监听外部主站。`create_device` / `update_device` 支持 mode 和 transport；省略 mode 创建主站。切换角色会释放旧连接或监听，不能只把远端 IP 原样用于本地监听。
- TCP 从站填写本机监听地址（例如 `0.0.0.0`）和未占用端口；外部主站连接运行本软件的电脑实际 IP，不连接 `0.0.0.0`。RTU 从站占用独立串口，数据位必须为 8，从站号 1–247；不能与启用的主站设备共用该串口。
- 从站没有扫描间隔，等待外部主站读写。`get_device_health` 的 connected 对从站表示监听已启动，polling=false，poll_interval_ms=null；slave_service 提供 running、error、requests、connections 等状态。请求数/连接数为 0 是正常等待，不是“未连接”故障。端口占用或串口打不开才是服务异常。
- 每个从站设备拥有独立的四区内存，配置和点位持久保存；内存值在程序重启后清零。停用后再启用保留本次运行内存，切换角色或删除设备会释放其内存。
- TCP：核对 IP、端口、从站号。RTU：核对 `serial_path`、波特率、校验、停止位、数据位，避免其他进程占用串口。具体字段以 `create_device` / `update_device` 的 schema 为准。
- `create_group` 参数包括 device_id、name、function_code、start_address、quantity、slave_id。它会自动创建覆盖该范围的 int16 点位；创建后重新 list_registers，再 update_register，避免重复建点。
- 多字类型必须落在组读取范围内，例如 32 位值需要相邻两个 16 位字。按设备文档核对类型、字序及地址，不把“数据不足”改成 0。
- `set_device_active {device_id, active}` 控制主站连接与采集，或启动/停止从站监听；`set_group_active {group_id, active}` 暂停/恢复组的数据发布，不能视为禁止外部主站访问从站内存。优先用明确状态，避免重复调用 toggle 导致状态反转。
- `set_poll_interval` 只用于主站；多个分组轮流读取，组刷新周期约为间隔乘组数并受通信耗时影响。1ms 设置不保证 1kHz 采样。从站拒绝此工具，不用隐藏的采样字段模拟主动扫描。
- `import_points` 支持 JSON/CSV 语义配置；Excel 点位表使用 `export_points_xlsx` / `import_points_xlsx`，按工具 schema 提供文件参数。先查看现有定义及导出结果，确认目标映射。

写入、OTA、删除配置、缩短历史保留时间都不是观测所必需的步骤。只在用户已授权的范围执行；目标或写值单位不清楚时先补齐信息，不重复索要已明确给予的授权。

`write_register` 参数包括 device_id、address、value、可选 area 和 method。value 是工程值，反向应用 factor/offset 后编码；主站只写 holding-register / coil，并会控制外部设备。从站支持四区，修改本机内存供外部主站读取，不发起远端连接；多字类型仍按类型编码。写入后检查响应与快照，真实协议读回需另行验证。不要因超时盲目重复写入或升级。OTA 使用 list_firmwares / ota_upgrade / ota_status 等工具，仅用于适配的主站设备；无关任务不触发升级。

### 点位表和告警

使用 v2 XLSX：设备信息、每分组一个 sheet、独立“告警规则”sheet；旧版不兼容。无告警也保留告警表头。每条告警一行：分组、功能码、起始地址、告警条件、原始值阈值、告警提示；按分组名 + 功能码 + 地址定位，支持同一点多个规则，不填数据库 ID 或 JSON。分组表“告警数量”为派生统计。

`import_points_xlsx` 全量覆盖该设备的分组、点位和告警，导入后 ID 会重建，需重新发现。检查返回 errors，告警校验失败会保留原配置。详细格式和模板见仓库 `docs/product/10-点位表xlsx规范与模板.md`、`docs/pointsheet-template-example.xlsx`。

告警比较按点位类型解码后的原始值，支持 >、>=、==、<=、<、!=，不应用 factor/offset。界面在“配置”模式的具体点位“告警”入口设置；触发时顶部提示，原始值和物理值标红；旧值、暂停、错误或不完整数据不当作有效触发值。

MCP 用 `list_alarm_rules` 查询，`create_alarm_rule {register_id, operator, threshold, message?}` 新增，`update_alarm_rule {rule_id, operator?, threshold?, message?}` 编辑（省略保留，message=null 清空），`delete_alarm_rule {rule_id}` 删除。REST `/api/rules` 也支持管理（POST/PUT `/:id`：registerId、operator、threshold、message；DELETE `/:id`）。

`delete_device {device_id}` 删除设备及其分组、点位和告警，停止连接/监听，但保留历史；需要清理历史时单独指定范围，不将删除设备等同于删除数据。

## 4. 历史查询和录制

`query_history` 示例：

```json
{"device_id": 1, "area": "holding-register", "address": 0, "start": "2026-09-28T00:00:00Z", "end": "2026-09-28T01:00:00Z", "limit": 2000, "offset": 0}
```

查询前确认用户时区，将时间边界转换为带时区的 ISO 字符串。返回的无时区展示时间按服务器本地时区解释，不能直接假设为 UTC；跨时区浏览器尤其要核对。

- limit 默认 2000，上限 200000；需要完整数据时通过 offset 分页，直到返回数量小于请求数量。不要将首批数据声称为整个区间。
- 单字返回 raw_value 及语义 value；多字类型的该接口只查询起始地址，value 可能为 null，并附 register_width。需要完整多字数据时，用 REST 设备历史取得相邻地址的同一采样时刻数据后解码，不把起始字当完整数值。
- `get_device_stats` 检查历史覆盖区间；`get_data_retention` 检查保留规则。保留 0 表示永久，设备覆盖优先全局。
- `export_history {device_id,start,end,format?,register_ids?,tz_offset_min?}` 导出 CSV（默认）或 XLSX，返回 filename、b64、bytes；解码 base64 保存到用户指定位置。时间必须带时区，tz_offset_min 只影响展示，例如中国为 480。未指定点位时导出该设备全部已配置点位。
- `delete_history {device_id,start,end,dry_run?}` 只清理该设备、包含两端的时间范围。默认 dry_run=true 返回 affected_rows；用户授权的范围明确后才传 false 删除。保留点位配置和实时缓存，运行设备仍可能产生新数据；也可通过已删除设备的 ID 清理遗留历史。
- `start_recording` 和 `start_trigger_recording` 会临时改变设备采样周期，不是只读查询；用户需要录制时使用。addresses 是 `{area,address}` 数组；触发记录还需要 trigger_area。用返回的 recording_id 调用 get_recording / stop_recording，报告实际状态和采样时间，不承诺绝对采样频率。

无 MCP 时，REST 只读入口如下（查询参数需 URL 编码）：

| GET 路径 | 参数或结果 |
|---|---|
| `/api/monitor_objects` | 设备列表 |
| `/api/monitor_objects/:id/groups` | 分组列表 |
| `/api/groups/:gid/registers` | 点位定义 |
| `/api/monitor_objects/:id/latest` | 该设备所有数据区的原始快照 |
| `/api/monitor_objects/:id/diagnostics` | 通信诊断 |
| `/api/monitor_objects/:id/slave` | 从站监听状态、错误、请求数和连接数；只用于从站 |
| `/api/monitor_objects/:id/frames` | limit，最近 TX/RX 报文 |
| `/api/data/query` | object_id、area、address、start、end、可选 limit |
| `/api/data/object/page` | object_id、start、end、page（从 0 起）、page_size；按时间戳分页 |
| `/api/data/object/curve` | object_id、start、end、max_points；分桶后的点 |

PowerShell 首次只读检查：

```powershell
$probeBase = 'http://localhost:8080'
Invoke-RestMethod "$probeBase/health"
Invoke-RestMethod "$probeBase/api/monitor_objects"
```

## 5. Web UI 操作

在左侧选设备，再按任务选择标签：

- **实时数据**：观测模式查看点位，配置模式修改组及点位；可搜索名称/地址、只看异常或过期。更新时间与数据状态在组标题上方，时间按组内最早样本汇总，旧值不等于当前值。
- **实时曲线**：最多选择 8 个数值点位，时间窗 30 秒至 10 分钟；冻结只固定显示，后台仍收集；清空清除当前曲线缓存。该曲线是页面内存缓存，刷新或离开设备不能保证保留，不代替历史库或录制。
- **历史数据 → 曲线**：选择寄存器，使用快捷时间或精确起止时间查询。横向拖动缩放时间，纵向拖动缩放 Y 轴，斜向框选同时缩放两轴；也可用按钮缩放/移动。Y 轴自适应只恢复 Y 轴，双击图表或重置缩放恢复两轴。
- 时间放大后点击 **查询放大区间**，重新获取该区间更细的数据。单纯缩放画面不会增加数据点。
- 点击图例隐藏/显示曲线；悬停显示最近真实样本及其实际时间。相对量程将各曲线映射至 0–100% 方便比较趋势，恒定值显示在 50%；读数仍为原始数值。
- 曲线支持选择原始值或物理值，先核对当前显示模式和工程单位。历史曲线每桶每地址保留末值，Min/Max 仅针对显示点，可能漏掉瞬时峰值；验证峰值时缩短区间并查询原始历史或录制。
- **历史数据 → 表格 / 导出**：核对时间范围和已选寄存器，导出 CSV/XLSX。**通信诊断**页主站查看 TX/RX，可暂停画面；从站查看监听服务状态，当前不提供从站报文缓冲。设备角色在编辑设备中切换，从站服务状态显示在设备概况与标签页之间。
- 左侧“调整顺序”支持拖动/箭头排序，侧栏边缘可拖动宽度、双击恢复。排序和宽度属于浏览器本地偏好，不会同步到另一台电脑。

### 通过 MCP 咨询软件配置的 AI

`ask_ai {question,context?,device_id?,provider?,model?,effort?}` 向软件“设置 → AI 助手”中已保存的 API 提问。省略模型选项使用当前配置，effort 默认 default；自定义接口需在设置中启用推理参数协议后才能指定等级。提供商必须已配置，密钥留在服务端，工具不返回密钥。

可附带文本参考 context，或指定 device_id 自动附带设备配置和最多 200 个点位的缓存快照；这些内容会发送给选定提供商并消耗 API 额度。只附带本次任务需要的信息。单次咨询没有工具执行，不修改设备、不自动执行回答中的建议、不加入界面聊天历史；调用方负责后续上下文。返回 answer、provider、model、effort、elapsedMs，模型分析不能当成真实设备读回或已完成操作。优先用软件工具取事实，再在需要解释或第二意见时调用 ask_ai，避免递归调用。

需要运行 REST/AI 服务。只启用 MCP 时该工具返回服务未启动；API 未配置、提供商异常或超时也返回明确错误。

## 6. 排查与完成标准

| 现象 | 优先核对 |
|---|---|
| Web 无法打开 / 端口占用 | 现有实例、启动输出、8080；不要重复启动占用同一数据库的实例 |
| 页面能打开但数据不更新 | 设备启用、组暂停、更新时间、IP/串口/从站号和诊断报文；WS 失败时 UI 可能使用 REST 兜底 |
| 有值但明显不对 | area、地址基准、类型/字序、多字范围、factor/offset |
| 历史为空 | 时间及服务器时区、是否曾采集、保留策略、实际数据目录；入库有批量刷新延迟 |
| 曲线不可见 | 数值类型、点位选择、图例隐藏、缩放范围；先恢复自适应或重置 |
| MCP 工具参数被拒绝 | 重新读取服务的 schema；不要沿用旧 README 参数 |

完成任务时说明目标设备、执行操作、实际观察到的值/时间/质量，以及仍未验证的部分。区分“接口调用成功”“已配置”“实际采样已更新”“真实设备读回已确认”，不把这些状态混为一谈。

需要追查实现时，在仓库查看 `apps/cli/src/main.ts`（启动）、`packages/mcp/src/index.ts`（工具 schema）、`packages/api/src/index.ts`（REST）、`packages/core/src/paths.ts`（目录/时区）、`apps/web/src/App.tsx`（UI）。仓库路径相对项目根目录；随软件更新以运行中 schema 和对应源码为准。
