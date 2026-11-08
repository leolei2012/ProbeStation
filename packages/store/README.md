# @probebench/store

新增终止性`close():Promise<void>`：立即停止定时器/新写入和新查询，使落盘元数据available=false并撤销导出句柄；等待按实例绑定的消费者、已接受的读/写/重开，尝试最终flush，随后尽力关闭主连接和实例。重复调用返回同一个Promise，失败也不自动重试；单个原错误直接保留，多处错误用AggregateError.errors。写失败不会清空待写缓冲，可在保留的实例上用`getPendingPoints()`取得独立副本，事务结果不明时不得盲目重放；此副本仅在内存，关闭异常不可吞掉后直接退出。close后不能reopen同一实例，应用需创建新实例。未更改正常查询/存储格式，见[有序关闭与边界](../../docs/develop/87-存储与配置资源有序关闭.md)。

可选的 `captureExportReadHandle()` / `queryObjectForExportWithHandle(handle, objectId, start, end, ranges?)` 仅用于后续条件导出的内部基础：句柄必须是本实例创建的原对象，复制或反序列化无效；库重开即撤销，旧等待/SQL迟到结果拒绝返回。范围参数在调用时复制，旧查询仍保留原语义。未接入Sink/API，不证明配置库配对、数据已提交/完整或物理身份，见[读取句柄](../../docs/develop/70-导出时序库读取句柄隔离.md)。

`validateExportReadHandle(handle)`仅同步核对上述所有权/就绪/打开周期，不等待、不查SQL、不flush，也不阻止旧连接关闭；用于可选工作区配对的后置核对。配对尚未接入实际导出，见[工作区门禁](../../docs/develop/71-工作区导出配对生命周期保护.md)。

`statsByObject(id).retention`保留原`retention_seconds`全局默认字段，并新增`policy:{version:1,objectId,source,seconds}`描述该ID的配置时长。source为global/device/unverified，seconds为非负安全整数（0永久）或未核实null；NULL设备设置继承全局，显式0是设备永久，不按真值回退。无当前设备覆盖/无config服务时沿用现有清理的全局默认语义，不能据此验证设备存在。只读读取listObjects，不触发清理；配置查询失败不伪造策略。详见[保留策略显示](../../docs/develop/48-设备保留策略准确显示.md)。

采样落盘状态新增`getSamplePersistenceStatus(objectId?)`，同步读取本实例内存元数据：初始化/切换/ready/失败/阻止、原始待写行数/全服务行数、提交中及最近批次提交/失败时间。状态始终是全服务共享，设备参数只过滤队列数；不包含错误原文，不做SQL/flush/cleanup/reopen，旧getPersistenceStatus诊断返回保持。statsByObject.bufferPending现按设备计数；全局stats保持全服务数。ready不等于所有数据已保存或历史完整；范围和内存回归见[落盘说明](../../docs/develop/47-采样落盘状态与设备缓冲计数.md)。

时序数据持久化：热内存快照 + DuckDB 列存。提供 `ctx.store`。

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dbPath` | string | — | DuckDB 文件路径（`:memory:` 为内存库，测试用） |
| `flushIntervalMs` | number | 5000 | 定期 flush 间隔 |
| `flushBatchSize` | number | 1000 | 攒批到该数量自动 flush |
| `retentionSeconds` | number | 2592000 | 全局历史保留时长（秒，30 天）；0 = 永久 |
| `retentionCheckMs` | number | 300000 | 周期清理间隔（毫秒，5 分钟）；0 只停周期定时器，其他触发仍生效 |

## 服务 `ctx.store`

```ts
interface PollPoint {
  objectId: number
  area: 'coil' | 'discrete-input' | 'holding-register' | 'input-register'
  address: number
  timestamp: string   // ISO 8601
  rawValue: number
  quality: string     // "good" | ...
  batchId?: string | null // 原始响应身份，不生成、不按时间戳推断
}

interface Store {
  write(points: PollPoint[]): void                          // 入热缓冲，满批自动 flush
  flush(): Promise<void>                                    // 强制落库
  getLatest(): Record<string, { rawValue: number; quality: string; timestamp: string }>
  query(objectId: number, address: number, start: string, end: string, area: ModbusArea):
    Promise<Array<{ ts: string; rawValue: number; quality: string; batchId: string | null }>>
}
```

## 存储布局

- **热层**：键为 `objectId:area:address` 的 Map，`getLatest()` 零磁盘 IO，另有单设备快照接口。
- 热缓存与所有 latest 快照保留可选 `batchId`，供消费者拒绝不同协议响应的多字组合。冷库可空 `batch_id VARCHAR` 原样保存已有身份；缺失/NULL 仍为 NULL，也可能来自现有从站生产者，不能一概认定为旧行。空字符串原样保留，不代表已验证身份。
- **冷层**：DuckDB 单表

  ```sql
  CREATE TABLE poll_data (
    object_id INTEGER,
    area VARCHAR,
    address INTEGER,
    ts TIMESTAMP,
    raw_value DOUBLE,
    quality VARCHAR,
    batch_id VARCHAR
  )
  ```

- 批量写入：绑定参数 INSERT，单事务按 500 行分块，独立写连接避免其他查询看见半批数据。COMMIT 成功后才移除缓冲；失败回滚、保留待写行及期间新到行，可再次 flush。后台失败输出错误；`getPersistenceStatus()` 返回 `pendingRows/error`。若回滚失败，结果不确定，会阻止后续写入/重试以待排查。缓冲仍为内存，进程退出不保证未落库数据持久化。
- 初始化在单事务内检查旧 `register_id`、缺失 `area` 并补可空 `batch_id`；检查所有必需列类型，已有 `batch_id` 必须为无默认值的可空 VARCHAR。反复打开幂等，迁移失败明确拒绝初始化/flush，已知初始化失败后拒绝 write；旧行不生成或回填身份。
- **新代码下次启动主应用可能自动加列；本轮仅对临时库验收，真实库迁移未做。**
- `query/queryWithOffset/queryObject/queryObjectPage` 的原始行均保留 `batchId: string | null`，分页仍按原有时间戳语义，不按批次重排。
- **数据保留**：`cleanup()` 按「全局 `retentionSeconds` + 设备级 `data_retain_seconds` 覆盖」删除过期数据
  （启动、成功重开、周期定时器及显式`cleanup()`）；`setRetentionSeconds()`可运行时改全局并立即安排清理，`getRetentionSeconds()`只读。
  `retentionCheckMs=0`不阻止启动、重开、修改全局或显式清理。全局`retentionSeconds=0`只关闭全局过期规则，设备正数覆盖仍执行，设备暂停也不跳过历史清理。
  若隔离测试需不删除任何过期行，应同时设置全局0且所有设备覆盖为NULL或0；读取或渲染界面本身不会执行清理。界面不提供清理周期控件，规则说明不代表当前后台周期已核实，见[清理触发规则](../../docs/develop/91-清理触发规则与界面说明.md)。

## 用法

```ts
ctx.store.write([
  { objectId: 9, area: 'holding-register', address: 470, timestamp: new Date().toISOString(), rawValue: 1234, quality: 'good' },
])
await ctx.store.flush()
const rows = await ctx.store.query(9, 470, '2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z', 'holding-register')
```

## 历史曲线

`queryRegisterCurve(objectId, start, end, registers, maxPoints, signal?)` 使用独立 DuckDB 连接流式读取所选点位的全部区间，按实际采样时间检查完整原始字、批次身份与质量后解码，再保留桶内首/末值、数值最小/最大值及无效读数。返回 series、sourceSamples、displayedSamples、downsampled、complete。内存中保留显示桶，查询不受旧 `queryObject` 的 20 万行默认值影响；AbortSignal 可中断对应查询。

旧 `queryObjectCurve` 逐地址聚合丢失来源和响应身份，内部方法已明确抛错；对应旧 HTTP 入口返回 410。前端使用检查批次后保留峰值的 `queryRegisterCurve`，返回逐点 verification 与降采样前 integrity 计数。当前降采样为查询时计算，尚无预计算多级聚合表。

`queryRegisterCurve` 每条 series 的 `summary` 包含完整查询区间内降采样前的 `sourceSamples`、`validSamples`、`invalidSamples`。这是按点位解码后的采样数，多字点位缺字或质量异常计为无效，非有限数或无法精确表示的 64 位整数也计为无效；没有采样的时段不在分母中，有效率不是设备在线率。空区间返回三个零。

## 历史身份显示与自动消费边界

历史样本分 verified/unverified/unknown：目标从站来源明确、完整、地址唯一、质量有效并带相同非空 batchId 才 verified；缺 batchId 或 slaveId 的完整样本在无来源歧义时保留兼容值、标记 unverified，不作为自动 PASS/FAIL 依据；混批、部分身份、缺字、重复地址、坏质量或非有限值为 unknown。曲线无法精确表示的 64 位整数也显示未知。单字也需要已有身份才能称已验证。不会生成或回填旧身份。

曲线 summary 的 validSamples 是可显示数，包含 unverified 兼容值；integrity 分开给出 verified/unverified/unknown 的降采样前数量，逐显示点 verification 与 samples 对齐。显示点可用于人工观察，Min/Max 不生成 PASS/FAIL。四个原始查询返回 batchId 和可空 slaveId，另带 timestampMs 供消费端避免本地显示字符串精度丢失，时间戳分页语义不变。同一精确时间重复地址保守判未知。

曲线 `segments: [time, segmentId][]` 在降采样前根据原始采样连续性生成，随后随保留的真实点一起返回。`sourceGapMs` 为原始正采样间隔中位数的三倍（不足时为 null）；真实采样空档和无效读数推进段身份。前端按段身份连线，不能把降采样后相隔较远的显示点再当作断采；这不会增加虚构样本或更改质量计数。旧 `gapMs` 只保留最近读数/旧客户端兼容用途，缺 segments 的旧响应采用原有保守回退。修复需同时更新后端和前端，不能仅刷新运行旧代码的后端页面。

表格、CSV/XLSX 使用同一共享判定；导出增加状态与 automatic_eligible 列，未知值为空。助手历史工具仅 verified value 进入统计，无身份值只在 compatibilityValue 中供人工查看，未知 value 为 null。历史数据不等同测试通过，未实现自动 PASS/FAIL 引擎。旧聚合 HTTP 入口已停用，返回 410。

离线回归：`node node_modules/tsx/dist/cli.mjs scripts/test-store-batch.ts`；`npm run check` 先构建前端再运行 25 组显式安全回归，含隔离入口 API/资源验收。`npm run test:edition` 启动只读临时测试版，详见 docs/test/隔离测试版使用说明.md。真实迁移和页面视觉验收未完成。


## 历史导出上限判断（2026-11-06）

普通 `queryObject()` 仍最多返回 200000 条。新增 `queryObjectForExport()` 仅供导出，使用同一参数绑定查询和原始字段映射，最多返回 200001 条；sink 若观察到第 200001 条即拒绝生成文件，恰好 200000 条可完整导出。可选 ranges 按数据区/地址限定所需原始字，在 LIMIT 前筛选；不提供 ranges 保持旧的全设备查询，空 ranges 返回空结果。范围值全部绑定，EXISTS 不会重复返回重叠范围的原始行。未改变批次身份、采样、迁移或历史显示策略。边界回归：`node node_modules/tsx/dist/cli.mjs scripts/test-export-limit.ts`，仅内存库。

按点位导出时，sink 使用 dtype 的完整字宽生成 ranges；未选地址不会占用 20 万行上限。回归：`node node_modules/tsx/dist/cli.mjs scripts/test-export-selection.ts`。来源筛选和旧 NULL 行的处理见下文。

## 多从站来源（2026-11-06）

- `PollPoint.slaveId` 保存请求目标字节（整数 0–255），并非额外物理身份认证。`slave_id INTEGER` 可空、无默认；迁移事务幂等且验证列定义。旧行不从当前配置、时间戳或 batchId 回填，保持 NULL；迁移失败拒绝读写，flush 失败保留所有待写行供重试。真实库未打开，下次正常启动会尝试加列。
- 热层主键 `objectId:slave:slaveId:area:address`，未知来源使用 `slave:unknown`。单一已观测来源保留旧 `objectId:area:address` 别名，出现不同来源（包括未知）则移除；重开清空热层及冲突记录。设备相对快照去除 objectId 前缀。消费者应用 `sourceSample` 严格选已知来源；旧别名也必须携带匹配的来源才能填值。
- `query(..., limit?, slaveId?)`、`queryWithOffset(..., limit, offset?, slaveId?)` 可选择目标，保留该来源及 NULL 原始行，并原样返回身份；省略选择器则返回全部来源。REST `/api/data/query` 可选 `slave_id`。原始页返回所有来源，解码表格按点位来源隔离。
- 曲线 register 描述必须包含当前期望 `slaveId`（由 owning group 绑定，本地 slave 模式用设备编号），先筛选来源再组时间戳解码。未绑定目标的内部调用只能兼容查看，不能自动已验证。旧 NULL 行在当前配置存在跨来源重叠时未知，否则可显示但永不 automaticEligible；不能混合已知/未知字补齐。
- 导出 ranges 增加可选 slaveId，只有同来源/area 的相邻地址才合并，在 LIMIT+1 前绑定筛选。其他已知从站不占目标配额；NULL 行无法安全排除，仍保守计入，且不能当作已知来源。
- `test-store-source`、`test-source-pipeline` 分别验证迁移/重开/往返和缓存→实时/历史/API/CSV/XLSX/助手资格、配额、失败重试。均为内存或新临时库，无真实设备。
