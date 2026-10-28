# @probebench/store

时序数据持久化：热内存快照 + DuckDB 列存。提供 `ctx.store`。

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dbPath` | string | — | DuckDB 文件路径（`:memory:` 为内存库，测试用） |
| `flushIntervalMs` | number | 5000 | 定期 flush 间隔 |
| `flushBatchSize` | number | 1000 | 攒批到该数量自动 flush |
| `retentionSeconds` | number | 2592000 | 全局历史保留时长（秒，30 天）；0 = 永久 |
| `retentionCheckMs` | number | 300000 | 保留清理间隔（毫秒，5 分钟）；0 = 仅启动时清理 |

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
  （启动时 + 每 `retentionCheckMs` 一次）；`setRetentionSeconds()/getRetentionSeconds()` 可运行时改全局并立即清理。

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

旧 `queryObjectCurve` 为内部逐地址聚合，不作为自动判断依据；对应旧 HTTP 入口已返回 410。前端使用检查批次后保留峰值的 `queryRegisterCurve`，返回逐点 verification 与降采样前 integrity 计数。当前降采样为查询时计算，尚无预计算多级聚合表。

`queryRegisterCurve` 每条 series 的 `summary` 包含完整查询区间内降采样前的 `sourceSamples`、`validSamples`、`invalidSamples`。这是按点位解码后的采样数，多字点位缺字或质量异常计为无效，非有限数或无法精确表示的 64 位整数也计为无效；没有采样的时段不在分母中，有效率不是设备在线率。空区间返回三个零。

## 历史身份显示与自动消费边界

历史样本分 verified/unverified/unknown：完整、地址唯一、质量有效并带相同非空 batchId 才 verified；全部缺身份的完整样本保留兼容值、标记 unverified，不作为自动 PASS/FAIL 依据；混批、部分身份、缺字、重复地址、坏质量或非有限值为 unknown。曲线无法精确表示的 64 位整数也显示未知。单字也需要已有身份才能称已验证。不会生成或回填旧身份。

曲线 summary 的 validSamples 是可显示数，包含 unverified 兼容值；integrity 分开给出 verified/unverified/unknown 的降采样前数量，逐显示点 verification 与 samples 对齐。显示点可用于人工观察，Min/Max 不生成 PASS/FAIL。四个原始查询返回 batchId，另带 timestampMs 供消费端避免本地显示字符串精度丢失，时间戳分页语义不变。同一精确时间重复地址保守判未知。

表格、CSV/XLSX 使用同一共享判定；导出增加状态与 automatic_eligible 列，未知值为空。助手历史工具仅 verified value 进入统计，无身份值只在 compatibilityValue 中供人工查看，未知 value 为 null。历史数据不等同测试通过，未实现自动 PASS/FAIL 引擎。旧聚合 HTTP 入口已停用，返回 410。

离线回归：`node node_modules/tsx/dist/cli.mjs scripts/test-store-batch.ts`；`npm run check` 先构建前端再运行 16 组显式安全回归，含隔离入口 API/资源验收。`npm run test:edition` 启动只读临时测试版，详见 docs/test/隔离测试版使用说明.md。真实迁移和页面视觉验收未完成。
