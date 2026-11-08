# @probebench/config

新增`setActivation(kind,id,{expected,isActive})`只SET设备/分组开关。BEGIN IMMEDIATE内核对ActivationSnapshot，写回完整条件核验后COMMIT，提交后保留原object/group通知并汇总同步抛错；失败尝试回滚，回滚未知不报成功。旧toggleObject/toggleGroup保持反转行为，无迁移或持久操作身份；边界见[条件开关](../../docs/develop/82-设备与分组条件开关.md)。

`getHistoryExportConfigurationScope()`仅返回本配置实例当前打开周期的内存标识，不运行SQL或暴露路径；恢复中或导出快照状态不明时拒绝，与`getHistoryExportConfiguration`使用同一门禁。它不是内容revision，普通编辑不会变更；用于后续生命周期配对，未接入实际导出。见[工作区门禁](../../docs/develop/71-工作区导出配对生命周期保护.md)。

内部新增 `getHistoryExportConfiguration(objectId)`：单次只读事务获取设备、全部分组/点位的冻结副本，返回结构版本1与本实例配置库打开周期scope。scope不随普通字段修改变化，不是内容版本或工作区/时序库租约；尚无REST入口，现有导出不调用。读取回滚不明时仅阻止此能力，成功重开后恢复，无schema迁移；见[快照契约与临时库验收](../../docs/develop/69-导出配置只读事务快照.md)。

日志新增previewLogCleanup/cleanupReviewedLogs：内存连接范围绑定预览，BEGIN IMMEDIATE事务内仅删除id<=throughId；AUTOINCREMENT契约未核实则拒绝，无schema迁移。新增记录保留、重复范围可无新增删除、已有移除单独计数；回滚结果不明阻止该清理能力直到显式成功重开。原clearLogs全删行为及日志生成/保留策略未变，见[边界](../../docs/develop/55-预览范围日志清理.md)。

日志记录类型与已有schema对齐：level/source/message可为NULL，ts仍为NOT NULL文本；只调整TypeScript声明，不修改schema、默认值、日志生成/保留或listLogs返回。消费者应保留NULL与空文本的区别，见[兼容修复](../../docs/develop/54-日志NULL字段兼容.md)。

设备 / 寄存器组 / 寄存器 的**元数据存储**（配置层），基于 Node 24 内置 `node:sqlite`（同步 API）。
提供 `ctx.config`。

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dbPath` | string | — | SQLite 文件路径（`:memory:` 为内存库，测试用） |

## 服务 `ctx.config`

```ts
class ConfigStore {
  // Objects（设备）
  listObjects(): DeviceRecord[]
  getObject(id): DeviceRecord | undefined
  createObject(name, ip, port, mode?): DeviceRecord
  updateObject(id, fields): DeviceRecord | undefined   // fields: {name?,ip?,port?,mode?,isActive?}
  deleteObject(id): void                                // 级联删 group + register
  toggleObject(id): DeviceRecord | undefined            // 切换 is_active
  // Groups（寄存器组）
  listGroups(objectId) / getGroup(id) / createGroup(objectId, name, functionCode, startAddress, quantity, mode?, slaveId?, options?: { isActive?: number }) / updateGroup(id, fields) / deleteGroup(id) / toggleGroup(id)
  // Registers（寄存器）
  listRegisters(groupId) / listRegistersByObject(objectId) / getRegister(id)
  getHistoryExportConfiguration(objectId): HistoryExportConfigurationSnapshot // 只读；尚未接入导出API
  createRegister(groupId, objectId, alias, functionCode, startAddress, dataType?, extra?)
  updateRegister(id, fields) / deleteRegister(id)
  // 告警规则 + 日志
  listRules() / createRule(registerId, operator, threshold, message) / deleteRule(id)
  log(level, source, message) / listLogs(limit) / clearLogs()
}
```

## 表

`monitor_objects` / `register_groups` / `registers` / `alarm_rules` / `logs` 五张表。
规则与日志由 `rule` / `api` 插件写入。

## 字段映射

update 接受 **camelCase**（`isActive`、`functionCode`、`startAddress`、`dataType`），内部映射到 snake_case 列。参数化 SQL，无注入。

新建分组可用具名`options.isActive`传数字0/1，省略默认1；非法值在INSERT/通知前拒绝。直接在INSERT中保存，首次group/后续register通知即可观察到暂停状态，不先启用再更新。旧7参数调用不变；旧文档的第8个pollIntervalMs并未在该方法中实现，不应依赖，多余数字也不会被当作启用开关。参见[新增分组启用状态修复](../../docs/develop/77-新增分组启用状态保真.md)。

REST使用`createGroupWithRegisters`（同参数）统一创建组和默认点位，BEGIN IMMEDIATE内暂缓通知，失败回滚，成功后按group→register原顺序各通知一次。返回原GroupRecord字段加`warnings: string[]`；同步通知回调异常不把已提交配置误报成创建失败。不能嵌套其他批量事务；回滚失败明确报结果未知。原createGroup仍只创建组，导入/备份等调用不会被自动补点。详见[创建事务](../../docs/develop/78-分组与默认点位创建事务.md)。

## 表结构

`monitor_objects` / `register_groups` / `registers` 三张表，每台设备独立配置，无语义层字段。

`monitor_objects` 关键列（PRD 08 新增）：

| 列 | 说明 |
|---|---|
| `poll_interval_ms` | 设备级统一采样周期（毫秒，默认 1000，≥1；该设备所有组共用） |
| `data_retain_seconds` | 设备级历史保留覆盖（秒，NULL=跟随全局，0=永久） |

## 变更事件 `config/changed`

- 所有元数据变更（object/group/register/rule 的增删改、toggle）都会触发 `ctx.emit('config/changed', { scope, id })`。
- 上层（如 `api`）据此经 WebSocket 广播给前端，让 Web UI 与 MCP/任意调用方的改动保持同步。
- 事件由构造器的 `onChange` 回调注入，独立构造 ConfigStore（测试）时不注入即为 no-op。

## 当前限制（TODO）

配置 JSON 备份将点位 `quantity` 作为独立元数据保存和恢复，合法值为正 JavaScript 安全整数（1–9007199254740991），不施加 Modbus 单次读取或地址空间的上限。该范围可通过 JSON 和 SQLite INTEGER 精确往返。旧 v1 备份完全缺少此字段时默认 1；显式非法值会返回 400，不能通过字符串转换、舍入或按 dtype 重算。备份解析不修改调用方的输入。

`createRegister` 的 `extra.quantity` 使用同样校验并显式入库。实际解码字宽仍由 `dataType` 决定，读取范围仍由分组决定；本字段不会扩大采样或写入范围。本次不包含生产数据迁移，也没有调整 XLSX/MBP 导入数量列的既有行为。

- `isActive` 直接返回 SQLite 的 0/1，未转布尔。
- 无外键约束（级联删除靠应用层）。

## 文件点表原子追加（2026-11-06）

appendImportedPoints(objectId, groups, registers) 用于importer文件窗口，不替代importPoints语义更新或JSON备份恢复。registers必须保留来源groupIndex（0-based）；先用共享规则检查完整图，再BEGIN IMMEDIATE追加组/点位，失败回滚，原有配置不动。不会调用updateGroup来补点或改变设备启用状态/编号，点位quantity仍遵循旧文件导入默认1。

创建过程抑制逐行通知；提交后一次notify(import, objectId)。同步通知回调异常不回滚已提交数据，而返回warnings提示勿重复导入；数据库回滚本身失败则明确报结果不确定，不自动重试。成功返回groups/registers计数及warnings。空导入不写入/不通知，缺失目标和错误窗口引用在写入前失败。只验证了内存库和合成数据；没有模式迁移或访问真实库。

## 语义导入（2026-11-06）

importPoints(objectId, points)更新已有点位，支持functionCode/address和可选slaveId/registerId；使用当前来源绑定，歧义或冲突跳过并返回候选，不选首项。省略语义字段保留原值，unit/enumMap显式null清除，alias=null保持旧值。quantity、归属、告警不变；显式dtype须可解码且完整字宽在组内。有效行原子提交，一次notify(point-import, objectId)，失败回滚。报告保留updated/skipped/errors，新增details/warnings；无效行跳过与重复目标按输入顺序执行的兼容语义保留。详见[输入/空值/事务契约](../../docs/develop/07-语义点表安全导入.md)。

## 全量XLSX事务边界

applyPointBookImport(objectId, replace, build)仅供Sink同步构建点表，事务包含旧配置删除和整次新图创建，不是通用异步事务接口。已有行校验失败整次回滚并返回0计数/errors；写入失败抛出异常，回滚失败明确不确定。成功后一次notify(point-book-import, objectId)，后续同步通知失败返回warnings。无分组页不能清空目标。详见[原子替换与未完成字段限制](../../docs/develop/08-XLSX点表原子替换.md)。

## 点位设置条件更新

`updateRegisterSettings(id, { expected, changes })`仅供点位设置新接口：expected为打开时点位、分组和设备来源快照，changes仅允许类型、单位、倍率、偏移、枚举及小数位。BEGIN IMMEDIATE覆盖读取、条件核对、范围检查、绑定参数写入及读回；冲突409、缺点404、输入错误400，失败回滚且不通知。成功提交后通知一次，通知异常返回`{point,warnings}`而非假失败。省略枚举保留当前值，显式编辑需匹配原枚举。

不新增列或迁移。旧updateRegister/设备分组更新/导入等兼容入口未统一加保护，不是全局版本号或跨工作区身份保证；详见[保护范围与验收](../../docs/develop/34-点位设置并发冲突保护.md)。

## 设备编辑条件更新

`updateObjectSettings(id, { expected, changes })`用于设备编辑新接口；快照仅含设备编辑表单字段，不含connected/isActive/dataRetainSeconds。BEGIN IMMEDIATE内比较整份表单旧值、校验合并结果、绑定写入并读回，失败回滚，不通知。提交后一次通知，异常转warnings；返回`{device,warnings}`。不调用poller或从站服务，连接处理由API提交后执行，冲突/非法输入不调用。旧updateObject兼容，不新增列或迁移。

设备/点位已具备当前值条件保护；旧接口、MCP、导入及分组编辑尚未统一保护。分组quantity变化涉及现有点位与告警删除/新增，须另做整图核对与事务，详见[评估与边界](../../docs/develop/35-设备编辑冲突与分组风险评估.md)。

## 分组图条件更新与原子缩扩容

`getGroupSettings(id)`在一致读事务中返回`{group,device,registers,rules,revision}`，revision是规范图JSON的v1 SHA256摘要（当前值条件，不是授权或持久修订号）。`updateGroupSettings(id,{expectedRevision,changes,confirmedDeletion?})`在BEGIN IMMEDIATE内重读并比较整图，验证当前删除预览的确切点位/告警ID，再执行原缩扩容逻辑、读回并提交；失败回滚，提交后一次group通知，通知异常返回warnings。变动影响、已保存图与warnings均在结果中。

公开`updateGroup`保留原调用/返回形状及原缩扩容政策，外部调用自动包事务；已有restoring批量事务内复用外层事务/通知，防嵌套BEGIN。旧调用没有expectedRevision，仍不能防止过期字段覆盖，且旧通知异常仍可能在提交后抛出；新接口提供明确已保存警告。新建/删除整个分组等流程未统一改造。没有新增表列或迁移；详见[策略、结果及限制](../../docs/develop/36-分组整图核对与原子缩扩容.md)。
