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
}

interface Store {
  write(points: PollPoint[]): void                          // 入热缓冲，满批自动 flush
  flush(): Promise<void>                                    // 强制落库
  getLatest(): Record<string, { rawValue: number; quality: string; timestamp: string }>
  query(objectId: number, address: number, start: string, end: string, area: ModbusArea):
    Promise<Array<{ ts: string; rawValue: number }>>
}
```

## 存储布局

- **热层**：键为 `objectId:area:address` 的 Map，`getLatest()` 零磁盘 IO，另有单设备快照接口。
- **冷层**：DuckDB 单表

  ```sql
  CREATE TABLE poll_data (
    object_id INTEGER,
    area VARCHAR,
    address INTEGER,
    ts TIMESTAMP,
    raw_value DOUBLE,
    quality VARCHAR
  )
  ```

- 批量写入：`INSERT INTO poll_data VALUES (...), (...)`，达到 `flushBatchSize` 自动触发。
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

`queryRegisterCurve(objectId, start, end, registers, maxPoints, signal?)` 使用独立 DuckDB 连接流式读取所选点位的全部区间，按实际采样时间合并完整原始字、解码，再保留桶内首/末值、数值最小/最大值及无效读数。返回 series、sourceSamples、displayedSamples、downsampled、complete。内存中保留显示桶，查询不受旧 `queryObject` 的 20 万行默认值影响；AbortSignal 可中断对应查询。

`queryObjectCurve` 保留旧版每桶各地址最新字的接口，供已有调用兼容；新前端使用解码后的 `queryRegisterCurve`，避免多字异步拼接及峰值丢失。当前降采样为查询时计算，尚无预计算多级聚合表。
