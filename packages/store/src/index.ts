import type { Context } from 'cordis'
import z from 'schemastery'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'

/** Cordis plugin name. */
export const name = 'store'

/** Persistence plugin config, validated by schemastery. */
export interface Config {
  dbPath: string
  flushIntervalMs: number
  flushBatchSize: number
}

export const Config: z<Config> = z.object({
  dbPath: z.string(),
  flushIntervalMs: z.number().default(5000),
  flushBatchSize: z.number().default(1000),
})

/** One decoded poll sample, ready to persist. */
export interface PollPoint {
  objectId: number
  registerId: number
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
  private readonly latest = new Map<number, { rawValue: number; quality: string; timestamp: string }>()
  private flushTimer: NodeJS.Timeout | null = null
  private dbPath: string

  constructor(private readonly config: Config) {
    this.dbPath = config.dbPath
    this.ready = this.init()
    this.ready.catch(() => {})
    if (this.config.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => { void this.flush() }, this.config.flushIntervalMs)
    }
  }

  private async init(): Promise<DuckDBConnection> {
    const instance = await DuckDBInstance.create(this.dbPath)
    this.instance = instance
    const conn = await instance.connect()
    await conn.run(`CREATE TABLE IF NOT EXISTS poll_data (
      object_id INTEGER,
      register_id INTEGER,
      ts TIMESTAMP,
      raw_value DOUBLE,
      quality VARCHAR
    )`)
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
  }

  /** Enqueue points into the hot buffer; auto-flush when the batch is full. */
  write(points: PollPoint[]): void {
    for (const p of points) {
      this.buffer.push(p)
      this.latest.set(p.registerId, { rawValue: p.rawValue, quality: p.quality, timestamp: p.timestamp })
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
      `(${p.objectId}, ${p.registerId}, '${p.timestamp}', ${p.rawValue}, '${p.quality}')`,
    ).join(', ')
    await conn.run(`INSERT INTO poll_data VALUES ${rows}`)
  }

  /** Query the cold tier for all registers of one object over a time range. */
  async queryObject(
    objectId: number, start: string, end: string,
  ): Promise<Array<{ ts: string; registerId: number; rawValue: number }>> {
    const conn = await this.ready
    const reader = await conn.runAndReadAll(
      `SELECT ts, register_id, raw_value FROM poll_data
       WHERE object_id = $objectId AND ts >= $start AND ts <= $end
       ORDER BY ts`,
      { objectId, start, end },
    )
    const rows = reader.getRowObjects() as Array<{ ts: unknown; register_id: unknown; raw_value: unknown }>
    return rows.map(r => ({ ts: String(r.ts), registerId: Number(r.register_id), rawValue: Number(r.raw_value) }))
  }

  /** Latest snapshot from the hot tier (keyed by register id). */
  getLatest(): Record<number, { rawValue: number; quality: string; timestamp: string }> {
    const out: Record<number, { rawValue: number; quality: string; timestamp: string }> = {}
    for (const [rid, v] of this.latest) out[rid] = v
    return out
  }

  /** Query the cold tier for one register over a time range. */
  async query(
    objectId: number, registerId: number, start: string, end: string,
  ): Promise<Array<{ ts: string; rawValue: number }>> {
    const conn = await this.ready
    const reader = await conn.runAndReadAll(
      `SELECT ts, raw_value FROM poll_data
       WHERE object_id = $objectId AND register_id = $registerId AND ts >= $start AND ts <= $end
       ORDER BY ts`,
      { objectId, registerId, start, end },
    )
    const rows = reader.getRowObjects() as Array<{ ts: unknown; raw_value: unknown }>
    return rows.map(r => ({ ts: String(r.ts), rawValue: Number(r.raw_value) }))
  }
}

/** Provide `ctx.store` to consumers (poller, api). */
export function apply(ctx: Context, config: Config): void {
  ctx.provide('store', new DuckDBStore(config))
}
