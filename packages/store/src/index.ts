import type { Context } from 'cordis'
import z from 'schemastery'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import type { ModbusArea } from '@probebench/core'

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
  async queryObject(
    objectId: number, start: string, end: string,
  ): Promise<Array<{ ts: string; area: ModbusArea; address: number; rawValue: number; quality: string }>> {
    const conn = await this.ready
    const reader = await conn.runAndReadAll(
      `SELECT ts, area, address, raw_value, quality FROM poll_data
       WHERE object_id = $objectId AND ts >= $start AND ts <= $end
       ORDER BY ts`,
      { objectId, start, end },
    )
    const rows = reader.getRowObjects() as Array<{ ts: unknown; area: unknown; address: unknown; raw_value: unknown; quality: unknown }>
    return rows.map(r => ({ ts: String(r.ts), area: String(r.area ?? 'holding-register') as ModbusArea, address: Number(r.address), rawValue: Number(r.raw_value), quality: String(r.quality ?? '') }))
  }

  /** 全局快照键统一为 objectId:area:address。 */
  getLatest(): Record<string, { rawValue: number; quality: string; timestamp: string }> {
    const out: Record<string, { rawValue: number; quality: string; timestamp: string }> = {}
    for (const [k, v] of this.latest) out[k] = v
    return out
  }

  /** 单设备、单数据区的最新快照（按地址键控）。 */
  getLatestByObject(objectId: number, area: ModbusArea): Record<number, { rawValue: number; quality: string; timestamp: string }> {
    const out: Record<number, { rawValue: number; quality: string; timestamp: string }> = {}
    const prefix = `${objectId}:${area}:`
    for (const [k, v] of this.latest) {
      if (k.startsWith(prefix)) out[Number(k.slice(prefix.length))] = v
    }
    return out
  }

  /** 单设备四数据区快照，键统一为 area:address。 */
  getLatestByObjectAll(objectId: number): Record<string, { rawValue: number; quality: string; timestamp: string }> {
    const out: Record<string, { rawValue: number; quality: string; timestamp: string }> = {}
    const prefix = objectId + ':'
    for (const [k, v] of this.latest) {
      if (!k.startsWith(prefix)) continue
      const key = k.slice(prefix.length)
      out[key] = v
    }
    return out
  }

  /** Query the cold tier for a single address over a time range. */
  async query(
    objectId: number, address: number, start: string, end: string, area: ModbusArea,
  ): Promise<Array<{ ts: string; rawValue: number; quality: string }>> {
    const conn = await this.ready
    const reader = await conn.runAndReadAll(
      `SELECT ts, raw_value, quality FROM poll_data
       WHERE object_id = $objectId AND area = $area AND address = $address AND ts >= $start AND ts <= $end
       ORDER BY ts`,
      { objectId, area, address, start, end },
    )
    const rows = reader.getRowObjects() as Array<{ ts: unknown; raw_value: unknown; quality: unknown }>
    return rows.map(r => ({ ts: String(r.ts), rawValue: Number(r.raw_value), quality: String(r.quality ?? '') }))
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
      oldestTs: str(span?.mn),
      newestTs: str(span?.mx),
      byDevice: byDeviceRows.map((r: any) => ({ objectId: num(r.object_id), rows: num(r.c), oldestTs: str(r.mn), newestTs: str(r.mx) })),
      byArea: byAreaRows.map((r: any) => ({ area: String(r.area ?? 'holding-register'), rows: num(r.c) })),
      bufferPending: this.buffer.length,
    }
  }
}

/** Provide `ctx.store` to consumers (poller, api). */
export function apply(ctx: Context, config: Config): void {
  ctx.provide('store', new DuckDBStore(config, (ctx as any).config))
}
