import type { Context } from 'cordis'
import z from 'schemastery'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { localTs, type ModbusArea } from '@probebench/core'

/** Cordis plugin name. */
export const name = 'store'
export const inject = ['config']

/** Persistence plugin config, validated by schemastery. */
export interface Config {
  dbPath: string
  flushIntervalMs: number
  flushBatchSize: number
  retentionSeconds: number
  retentionCheckMs: number
}

export const Config: z<Config> = z.object({
  dbPath: z.string(),
  flushIntervalMs: z.number().default(5000),
  flushBatchSize: z.number().default(1000),
  retentionSeconds: z.number().default(2592000), // 全局默认保留 30 天；0 = 永久
  retentionCheckMs: z.number().default(300000), // 清理间隔 5 分钟；0 = 仅启动时清理
})

/** 一个原始 16 位字采样，按 Modbus 地址键控（类型只是显示方式，解码在消费端做）。 */
export interface PollPoint {
  objectId: number
  area: ModbusArea
  address: number
  timestamp: string
  rawValue: number
  quality: string
}

/**
 * Columnar time-series store (DuckDB) with an in-memory hot buffer.
 * The hot tier serves latest snapshots without touching disk; the cold tier
 * flushes batches into a single `poll_data` table.
 */
export class DuckDBStore {
  private ready: Promise<DuckDBConnection>
  private instance: DuckDBInstance | null = null
  private buffer: PollPoint[] = []
  private readonly latest = new Map<string, { rawValue: number; quality: string; timestamp: string }>()
  private flushTimer: NodeJS.Timeout | null = null
  private retentionTimer: NodeJS.Timeout | null = null
  private dbPath: string
  private retentionSeconds: number

  constructor(private readonly config: Config, private readonly cfg?: any) {
    this.dbPath = config.dbPath
    this.retentionSeconds = config.retentionSeconds
    this.ready = this.init()
    this.ready.catch(() => {})
    if (this.config.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => { void this.flush() }, this.config.flushIntervalMs)
    }
    if (this.config.retentionCheckMs > 0) {
      this.retentionTimer = setInterval(() => { void this.cleanup() }, this.config.retentionCheckMs)
    }
    void this.ready.then(() => this.cleanup()).catch(() => {})
  }

  private async init(): Promise<DuckDBConnection> {
    const instance = await DuckDBInstance.create(this.dbPath)
    this.instance = instance
    const conn = await instance.connect()
    await conn.run(`CREATE TABLE IF NOT EXISTS poll_data (
      object_id INTEGER,
      area VARCHAR DEFAULT 'holding-register',
      address INTEGER,
      ts TIMESTAMP,
      raw_value DOUBLE,
      quality VARCHAR
    )`)
    // 迁移：旧表用 register_id 列
    try { await conn.run(`ALTER TABLE poll_data RENAME COLUMN register_id TO address`) } catch { /* 已是 address 或表刚建 */ }
    try { await conn.run(`ALTER TABLE poll_data ADD COLUMN area VARCHAR DEFAULT 'holding-register'`) } catch { /* 已迁移或新表 */ }
    // 历史查询按 (object_id, ts) 过滤排序，建索引避免大表全表扫描拖慢实时/查询
    try { await conn.run(`CREATE INDEX IF NOT EXISTS idx_poll_object_ts ON poll_data(object_id, ts)`) } catch { /* 索引创建失败不阻断启动 */ }
    return conn
  }

  /** 切换工作区：冲刷旧缓冲、关闭旧连接，重开新库并清空热层。 */
  async reopen(dbPath: string): Promise<void> {
    await this.flush()
    const old = await this.ready.catch(() => null)
    if (old) old.closeSync()
    if (this.instance) { try { this.instance.closeSync() } catch { /* already closed */ } }
    this.instance = null
    this.buffer = []
    this.latest.clear()
    this.dbPath = dbPath
    this.ready = this.init()
    this.ready.catch(() => {})
    void this.ready.then(() => this.cleanup()).catch(() => {})
  }

  /** Enqueue points into the hot buffer; auto-flush when the batch is full. */
  write(points: PollPoint[]): void {
    for (const p of points) {
      const area = p.area
      if (!area) throw new Error('PollPoint.area is required')
      this.buffer.push(p)
      this.latest.set(`${p.objectId}:${area}:${p.address}`, { rawValue: p.rawValue, quality: p.quality, timestamp: p.timestamp })
    }
    if (this.buffer.length >= this.config.flushBatchSize) void this.flush()
  }

  /** Flush buffered points to DuckDB. */
  async flush(): Promise<void> {
    const conn = await this.ready
    if (this.buffer.length === 0) return
    const batch = this.buffer.splice(0)
    // TODO(phase2): replace string interpolation with parameterized insert.
    const rows = batch.map(p =>
      `(${p.objectId}, '${p.area}', ${p.address}, '${p.timestamp}', ${p.rawValue}, '${p.quality}')`,
    ).join(', ')
    await conn.run(`INSERT INTO poll_data (object_id, area, address, ts, raw_value, quality) VALUES ${rows}`)
  }

  /**
   * 按保留策略清理过期数据：全局默认 + 设备级覆盖（data_retain_seconds）。
   * 0 = 永久；设备字段 NULL = 跟随全局。设备覆盖优先于全局。
   */
  /** 全局保留时长（秒）。 */
  getRetentionSeconds(): number { return this.retentionSeconds }

  /** 运行时改全局保留时长（秒，0=永久），改完立即清理一次。 */
  setRetentionSeconds(seconds: number): void {
    this.retentionSeconds = Math.max(0, Math.floor(seconds))
    void this.cleanup().catch(() => {})
  }

  async cleanup(): Promise<void> {
    const conn = await this.ready
    const global = this.retentionSeconds
    const now = Date.now()
    const overrideIds: number[] = []

    if (this.cfg) {
      for (const o of this.cfg.listObjects() as Array<{ id: number; dataRetainSeconds: number | null }>) {
        if (o.dataRetainSeconds == null) continue
        overrideIds.push(o.id)
        if (o.dataRetainSeconds > 0) {
          const cutoff = new Date(now - o.dataRetainSeconds * 1000).toISOString()
          await conn.run(`DELETE FROM poll_data WHERE object_id = ${o.id} AND ts < '${cutoff}'`)
        }
      }
    }

    if (global > 0) {
      const cutoff = new Date(now - global * 1000).toISOString()
      if (overrideIds.length > 0) {
        await conn.run(`DELETE FROM poll_data WHERE ts < '${cutoff}' AND object_id NOT IN (${overrideIds.join(',')})`)
      } else {
        await conn.run(`DELETE FROM poll_data WHERE ts < '${cutoff}'`)
      }
    }
  }

  /** Query the cold tier for all addresses of one object over a time range. */
  /** 把外部传入的 start/end（可能带 Z 的 UTC，或无时区的本地时间）归一成 UTC ISO，供 SQL 比较。 */
  private normalizeToUtc(s: string): string {
    if (!s) return ''
    const d = new Date(s)
    if (Number.isNaN(d.getTime())) return s
    // 无时区后缀视为服务器本地时间 → 转 UTC；带 Z/±offset 由 Date 直接解析为绝对时刻
    return d.toISOString()
  }

  async queryObject(
    objectId: number, start: string, end: string, limit?: number,
  ): Promise<Array<{ ts: string; area: ModbusArea; address: number; rawValue: number; quality: string }>> {
    const conn = await this.ready
    const startUtc = this.normalizeToUtc(start)
    const endUtc = this.normalizeToUtc(end)
    const limitClamped = limit != null ? Math.max(1, Math.min(200000, Math.trunc(limit))) : 200000
    const reader = await conn.runAndReadAll(
      `SELECT ts, area, address, raw_value, quality FROM poll_data
       WHERE object_id = $objectId AND ts >= $start AND ts <= $end
       ORDER BY ts
       LIMIT $limit`,
      { objectId, start: startUtc, end: endUtc, limit: limitClamped },
    )
    const rows = reader.getRowObjects() as Array<{ ts: unknown; area: unknown; address: unknown; raw_value: unknown; quality: unknown }>
    return rows.map(r => ({ ts: localTs(String(r.ts)), area: String(r.area ?? 'holding-register') as ModbusArea, address: Number(r.address), rawValue: Number(r.raw_value), quality: String(r.quality ?? '') }))
  }

  /** 全局快照键统一为 objectId:area:address。timestamp 输出为服务器本地时间。 */
  getLatest(): Record<string, { rawValue: number; quality: string; timestamp: string }> {
    const out: Record<string, { rawValue: number; quality: string; timestamp: string }> = {}
    for (const [k, v] of this.latest) out[k] = { ...v, timestamp: localTs(v.timestamp) }
    return out
  }

  /** 单设备、单数据区的最新快照（按地址键控）。timestamp 输出为服务器本地时间。 */
  getLatestByObject(objectId: number, area: ModbusArea): Record<number, { rawValue: number; quality: string; timestamp: string }> {
    const out: Record<number, { rawValue: number; quality: string; timestamp: string }> = {}
    const prefix = `${objectId}:${area}:`
    for (const [k, v] of this.latest) {
      if (k.startsWith(prefix)) out[Number(k.slice(prefix.length))] = { ...v, timestamp: localTs(v.timestamp) }
    }
    return out
  }

  /** 单设备四数据区快照，键统一为 area:address。timestamp 输出为服务器本地时间。 */
  getLatestByObjectAll(objectId: number): Record<string, { rawValue: number; quality: string; timestamp: string }> {
    const out: Record<string, { rawValue: number; quality: string; timestamp: string }> = {}
    const prefix = objectId + ':'
    for (const [k, v] of this.latest) {
      if (!k.startsWith(prefix)) continue
      const key = k.slice(prefix.length)
      out[key] = { ...v, timestamp: localTs(v.timestamp) }
    }
    return out
  }

  /**
   * 按「时间戳」分页查询单设备历史原始点（冷层）。原始点每地址一行，同一时间戳下会有多条；
   * 这里先按时间戳去重分页，再取该页时间戳对应的全部原始点，避免固定 limit 卡在窗口最开头的几行。
   * 返回 { points, total, page, pageSize, hasMore }。points 的 ts 已转服务器本地时间。
   */
  async queryObjectPage(
    objectId: number, start: string, end: string, page = 0, pageSize = 200,
  ): Promise<{ points: Array<{ ts: string; area: ModbusArea; address: number; rawValue: number; quality: string }>; total: number; page: number; pageSize: number; hasMore: boolean }> {
    const conn = await this.ready
    const startUtc = this.normalizeToUtc(start)
    const endUtc = this.normalizeToUtc(end)
    const size = Math.max(1, Math.min(10000, Math.trunc(pageSize) || 200))
    const p = Math.max(0, Math.trunc(page) || 0)

    // 1) 时间戳去重偏移分页（升序，最早的在前）
    const tsReader = await conn.runAndReadAll(
      `SELECT DISTINCT ts FROM poll_data
       WHERE object_id = $objectId AND ts >= $start AND ts <= $end
       ORDER BY ts ASC
       LIMIT $size OFFSET $offset`,
      { objectId, start: startUtc, end: endUtc, size, offset: p * size },
    )
    const tsRows = tsReader.getRowObjects() as Array<{ ts: unknown }>
    const pageTs = tsRows.map(r => String(r.ts))

    // 2) 总数（去重时间戳数）
    const cntReader = await conn.runAndReadAll(
      `SELECT COUNT(DISTINCT ts) AS c FROM poll_data
       WHERE object_id = $objectId AND ts >= $start AND ts <= $end`,
      { objectId, start: startUtc, end: endUtc },
    )
    const total = Number(cntReader.getRowObjects()[0]?.c ?? 0)

    if (pageTs.length === 0) return { points: [], total, page: p, pageSize: size, hasMore: false }

    // 3) 取该页时间戳对应的全部原始点
    const ptsReader = await conn.runAndReadAll(
      `SELECT ts, area, address, raw_value, quality FROM poll_data
       WHERE object_id = $objectId AND ts >= $lo AND ts <= $hi
       ORDER BY ts ASC, address ASC`,
      { objectId, lo: pageTs[0], hi: pageTs[pageTs.length - 1] },
    )
    const rows = ptsReader.getRowObjects() as Array<{ ts: unknown; area: unknown; address: unknown; raw_value: unknown; quality: unknown }>
    const points = rows.map(r => ({
      ts: localTs(String(r.ts)),
      area: String(r.area ?? 'holding-register') as ModbusArea,
      address: Number(r.address),
      rawValue: Number(r.raw_value),
      quality: String(r.quality ?? ''),
    }))
    return { points, total, page: p, pageSize: size, hasMore: p * size + pageTs.length < total }
  }

  /** Query the cold tier for a single address over a time range. */
  async query(
    objectId: number, address: number, start: string, end: string, area: ModbusArea, limit?: number,
  ): Promise<Array<{ ts: string; rawValue: number; quality: string }>> {
    const conn = await this.ready
    const startUtc = this.normalizeToUtc(start)
    const endUtc = this.normalizeToUtc(end)
    const limitClamped = limit != null ? Math.max(1, Math.min(200000, Math.trunc(limit))) : 200000
    const reader = await conn.runAndReadAll(
      `SELECT ts, raw_value, quality FROM poll_data
       WHERE object_id = $objectId AND area = $area AND address = $address AND ts >= $start AND ts <= $end
       ORDER BY ts
       LIMIT $limit`,
      { objectId, area, address, start: startUtc, end: endUtc, limit: limitClamped },
    )
    const rows = reader.getRowObjects() as Array<{ ts: unknown; raw_value: unknown; quality: unknown }>
    return rows.map(r => ({ ts: localTs(String(r.ts)), rawValue: Number(r.raw_value), quality: String(r.quality ?? '') }))
  }

  /** 单地址查询 + offset 分页（升序，最早的在前），供 MCP 等需要翻完整大时间范围的场景。 */
  async queryWithOffset(
    objectId: number, address: number, start: string, end: string, area: ModbusArea, limit: number, offset = 0,
  ): Promise<Array<{ ts: string; rawValue: number; quality: string }>> {
    const conn = await this.ready
    const startUtc = this.normalizeToUtc(start)
    const endUtc = this.normalizeToUtc(end)
    const limitClamped = Math.max(1, Math.min(200000, Math.trunc(limit)))
    const off = Math.max(0, Math.trunc(offset) || 0)
    const reader = await conn.runAndReadAll(
      `SELECT ts, raw_value, quality FROM poll_data
       WHERE object_id = $objectId AND area = $area AND address = $address AND ts >= $start AND ts <= $end
       ORDER BY ts
       LIMIT $limit OFFSET $off`,
      { objectId, area, address, start: startUtc, end: endUtc, limit: limitClamped, off },
    )
    const rows = reader.getRowObjects() as Array<{ ts: unknown; raw_value: unknown; quality: unknown }>
    return rows.map(r => ({ ts: localTs(String(r.ts)), rawValue: Number(r.raw_value), quality: String(r.quality ?? '') }))
  }

  /**
   * 曲线降采样：把整个时间范围按 maxPoints 个时间桶聚合，每桶每地址取「桶内最新」的原始字。
   * 用于曲线展示，避免把几十万原始点全拉到前端；返回点数 ≈ maxPoints 桶 × 地址数。
   */
  async queryObjectCurve(
    objectId: number, start: string, end: string, maxPoints = 1000,
  ): Promise<Array<{ ts: string; area: ModbusArea; address: number; rawValue: number }>> {
    const conn = await this.ready
    const startUtc = this.normalizeToUtc(start)
    const endUtc = this.normalizeToUtc(end)
    const sMs = Date.parse(startUtc)
    const eMs = Date.parse(endUtc)
    const spanMs = Number.isFinite(sMs) && Number.isFinite(eMs) ? Math.max(1, eMs - sMs) : 3600_000
    const bucketMs = Math.max(1, Math.ceil(spanMs / Math.max(1, Math.trunc(maxPoints) || 1000)))
    // 用 date_diff('millisecond', DATE '1970-01-01', ts) 得到 ts 的正确 UTC 相对毫秒（epoch_ms 会把无时区 TIMESTAMP 当作本地时区，产生 8 小时偏移）。
    // 桶号作为桶的 UTC epoch 毫秒返回（bucketMs 列），在 JS 侧转 ISO/local，绕开 to_timestamp 的时区歧义。
    const reader = await conn.runAndReadAll(
      `SELECT
         (floor(date_diff('millisecond', DATE '1970-01-01', ts) / $bucketMs) * $bucketMs) AS bucket_ms,
         area, address,
         arg_max(raw_value, ts) AS raw_value
       FROM poll_data
       WHERE object_id = $objectId AND ts >= $start AND ts <= $end
       GROUP BY floor(date_diff('millisecond', DATE '1970-01-01', ts) / $bucketMs), area, address
       ORDER BY bucket_ms, address`,
      { objectId, start: startUtc, end: endUtc, bucketMs: Number(bucketMs) },
    )
    const rows = reader.getRowObjects() as Array<{ bucket_ms: unknown; area: unknown; address: unknown; raw_value: unknown }>
    return rows.map(r => {
      const bm = Number(r.bucket_ms)
      const iso = Number.isFinite(bm) ? new Date(bm).toISOString() : ''
      return {
        ts: localTs(iso),
        area: String(r.area ?? 'holding-register') as ModbusArea,
        address: Number(r.address),
        rawValue: Number(r.raw_value),
      }
    })
  }

  /** 单设备数据统计：总行数 / 时间跨度 / 按数据区分布 / 待落盘缓冲（供数据 tab 只显示当前设备）。 */
  async statsByObject(objectId: number): Promise<{
    totalRows: number
    oldestTs: string | null
    newestTs: string | null
    byArea: Array<{ area: string; rows: number }>
    bufferPending: number
    retention: { retention_seconds: number }
  }> {
    const conn = await this.ready
    const num = (v: unknown): number => Number(v ?? 0)
    const str = (v: unknown): string | null => (v == null ? null : String(v))
    const countRows = (await conn.runAndReadAll('SELECT COUNT(*) AS c FROM poll_data WHERE object_id = $objectId', { objectId })).getRowObjects()
    const totalRows = num(countRows[0]?.c)
    const spanRows = (await conn.runAndReadAll('SELECT MIN(ts) AS mn, MAX(ts) AS mx FROM poll_data WHERE object_id = $objectId', { objectId })).getRowObjects()
    const span = spanRows[0]
    const byAreaRows = (await conn.runAndReadAll('SELECT area, COUNT(*) AS c FROM poll_data WHERE object_id = $objectId GROUP BY area ORDER BY c DESC', { objectId })).getRowObjects()
    return {
      totalRows,
      oldestTs: span?.mn == null ? null : localTs(String(span.mn)),
      newestTs: span?.mx == null ? null : localTs(String(span.mx)),
      byArea: byAreaRows.map((r: any) => ({ area: String(r.area ?? 'holding-register'), rows: num(r.c) })),
      bufferPending: this.buffer.length,
      retention: { retention_seconds: this.getRetentionSeconds() },
    }
  }

  /** 数据量统计：总行数 / 时间跨度 / 按设备与数据区分布 / 待落盘缓冲。 */
  async stats(): Promise<{
    totalRows: number
    oldestTs: string | null
    newestTs: string | null
    byDevice: Array<{ objectId: number; rows: number; oldestTs: string | null; newestTs: string | null }>
    byArea: Array<{ area: string; rows: number }>
    bufferPending: number
  }> {
    const conn = await this.ready
    const num = (v: unknown): number => Number(v ?? 0)
    const str = (v: unknown): string | null => (v == null ? null : String(v))
    const countRows = (await conn.runAndReadAll('SELECT COUNT(*) AS c FROM poll_data')).getRowObjects()
    const totalRows = num(countRows[0]?.c)
    const spanRows = (await conn.runAndReadAll('SELECT MIN(ts) AS mn, MAX(ts) AS mx FROM poll_data')).getRowObjects()
    const span = spanRows[0]
    const byDeviceRows = (await conn.runAndReadAll('SELECT object_id, COUNT(*) AS c, MIN(ts) AS mn, MAX(ts) AS mx FROM poll_data GROUP BY object_id ORDER BY c DESC')).getRowObjects()
    const byAreaRows = (await conn.runAndReadAll('SELECT area, COUNT(*) AS c FROM poll_data GROUP BY area ORDER BY c DESC')).getRowObjects()
    return {
      totalRows,
      oldestTs: span?.mn == null ? null : localTs(String(span.mn)),
      newestTs: span?.mx == null ? null : localTs(String(span.mx)),
      byDevice: byDeviceRows.map((r: any) => ({ objectId: num(r.object_id), rows: num(r.c), oldestTs: r.mn == null ? null : localTs(String(r.mn)), newestTs: r.mx == null ? null : localTs(String(r.mx)) })),
      byArea: byAreaRows.map((r: any) => ({ area: String(r.area ?? 'holding-register'), rows: num(r.c) })),
      bufferPending: this.buffer.length,
    }
  }
}

/** Provide `ctx.store` to consumers (poller, api). */
export function apply(ctx: Context, config: Config): void {
  ctx.provide('store', new DuckDBStore(config, (ctx as any).config))
}
