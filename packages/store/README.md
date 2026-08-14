# @probebench/store

时序数据持久化：热内存快照 + DuckDB 列存。提供 `ctx.store`。

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dbPath` | string | — | DuckDB 文件路径（`:memory:` 为内存库，测试用） |
| `flushIntervalMs` | number | 5000 | 预留：定期 flush 间隔 |
| `flushBatchSize` | number | 1000 | 攒批到该数量自动 flush |

## 服务 `ctx.store`

```ts
interface PollPoint {
  objectId: number
  registerId: number
  timestamp: string   // ISO 8601
  rawValue: number
  quality: string     // "good" | ...
}

interface Store {
  write(points: PollPoint[]): void                          // 入热缓冲，满批自动 flush
  flush(): Promise<void>                                    // 强制落库
  getLatest(): Record<number, { rawValue: number; quality: string; timestamp: string }>
  query(objectId: number, registerId: number, start: string, end: string):
    Promise<Array<{ ts: string; rawValue: number }>>
}
```

## 存储布局

- **热层**：`Map<registerId, latest>`，`getLatest()` 零磁盘 IO。
- **冷层**：DuckDB 单表

  ```sql
  CREATE TABLE poll_data (
    object_id INTEGER,
    register_id INTEGER,
    ts TIMESTAMP,
    raw_value DOUBLE,
    quality VARCHAR
  )
  ```

- 批量写入：`INSERT INTO poll_data VALUES (...), (...)`，达到 `flushBatchSize` 自动触发。

## 用法

```ts
ctx.store.write([
  { objectId: 9, registerId: 470, timestamp: new Date().toISOString(), rawValue: 1234, quality: 'good' },
])
await ctx.store.flush()
const rows = await ctx.store.query(9, 470, '2026-01-01T00:00:00Z', '2026-12-31T23:59:59Z')
```

## 当前限制（TODO）

- `flush()` 用字符串插值拼 SQL，需改为参数化（防注入，当前为内部数值可接受）。
- `flushIntervalMs` 定时 flush 尚未实现（现仅满批 + 显式调用）。
- 降采样 / 保留删除未实现（Phase 5）。
- `getLatest()` 未按 objectId 过滤（当前 registerId 全局唯一，可接受）。
