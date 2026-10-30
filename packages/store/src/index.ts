import type { Context } from 'cordis'
import z from 'schemastery'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { localTs, areaForFunction, registerWidth, type ModbusArea, type ModbusFunctionCode } from '@probebench/core'
import { CurveSampler } from './curve-sampling.ts'
import { ensurePollDataSchema } from './schema.ts'
import { decodeHistoricalSample } from '../../core/src/history-integrity.ts'

function rawTimestampMs(value: unknown): number {
  const text = String(value)
  return Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(text) ? text : text + 'Z')
}

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
  batchId?: string | null
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
  private readonly latest = new Map<string, { rawValue: number; quality: string; timestamp: string; batchId?: string | null }>()
  private flushTimer: NodeJS.Timeout | null = null
  private retentionTimer: NodeJS.Timeout | null = null
  private dbPath: string
  private retentionSeconds: number
  private mutations: Promise<unknown> = Promise.resolve()
  private persistenceError: unknown = null
  private initError: unknown = null
  private switching = false
  private background(task: Promise<unknown>): void {
    void task.catch(error => this.onError(error instanceof Error ? error : new Error(String(error))))
  }
  getPersistenceStatus() {
    return { pendingRows: this.buffer.length, error: this.persistenceError == null ? null : String(this.persistenceError) }
  }
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(action)
    this.mutations = result.catch(() => {})
    return result
  }

  constructor(private readonly config: Config, private readonly cfg?: any, private readonly onError: (error: Error) => void = error => console.error('[store]', error)) {
    this.dbPath = config.dbPath
    this.retentionSeconds = config.retentionSeconds
    this.ready = this.init()
    this.background(this.ready)
    if (this.config.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => { if (!this.switching) this.background(this.flush()) }, this.config.flushIntervalMs)
    }
    if (this.config.retentionCheckMs > 0) {
      this.retentionTimer = setInterval(() => { if (!this.switching) this.background(this.cleanup()) }, this.config.retentionCheckMs)
    }
    this.background(this.ready.then(() => this.cleanup()))
  }

  private async init(): Promise<DuckDBConnection> {
    let instance: DuckDBInstance | undefined
    let conn: DuckDBConnection | undefined
    try {
      instance = await DuckDBInstance.create(this.dbPath)
      this.instance = instance
      conn = await instance.connect()
      await ensurePollDataSchema(conn)
      return conn
    } catch (error) {
      this.initError = this.persistenceError = error
      conn?.closeSync()
      instance?.closeSync()
      this.instance = null
      throw error
    }
  }

  /** 切换工作区：冲刷旧缓冲、关闭旧连接，重开新库并清空热层。 */
  async reopen(dbPath: string): Promise<void> {
    if (this.switching) throw new Error('Store is already reopening')
    this.switching = true
    try {
      await this.flush()
      await this.mutations
      const old = await this.ready
      old.closeSync()
      this.instance?.closeSync()
      this.instance = null
      this.latest.clear()
      this.dbPath = dbPath
      this.initError = this.persistenceError = null
      this.ready = this.init()
      await this.ready
    } finally { this.switching = false }
    this.background(this.cleanup())
  }

  /** Enqueue points into the hot buffer; auto-flush when the batch is full. */
  write(points: PollPoint[]): void {
    if (this.switching) throw new Error('Store is reopening')
    if (this.initError) throw this.initError
    for (const p of points) {
      if (!p.area) throw new Error('PollPoint.area is required')
      if (p.batchId != null && typeof p.batchId !== 'string') throw new Error('PollPoint.batchId must be a string or null')
    }
    for (const p of points) {
      const area = p.area
      this.buffer.push({ ...p })
      this.latest.set(`${p.objectId}:${area}:${p.address}`, { rawValue: p.rawValue, quality: p.quality, timestamp: p.timestamp, ...(p.batchId !== undefined ? { batchId: p.batchId } : {}) })
    }
    if (this.buffer.length >= this.config.flushBatchSize) this.background(this.flush())
  }

  /** Flush buffered points to DuckDB. */
  async flush(): Promise<void> {
    await this.mutate(async () => {
      let conn: DuckDBConnection | undefined
      try {
        if (this.initError) throw this.initError
        await this.ready
        const batch = this.buffer.slice()
        if (!batch.length) return
        // Readers on the main connection see only committed batches between chunks.
        conn = await this.instance!.connect()
        await conn.run('BEGIN TRANSACTION')
        try {
          for (let offset = 0; offset < batch.length; offset += 500) {
            const values: Array<string | number | null> = []
            const rows = batch.slice(offset, offset + 500).map(p => {
              values.push(p.objectId, p.area, p.address, p.timestamp, p.rawValue, p.quality, p.batchId ?? null)
              return '(?, ?, ?, CAST(? AS TIMESTAMP), ?, ?, ?)'
            })
            await conn.run(`INSERT INTO poll_data (object_id, area, address, ts, raw_value, quality, batch_id) VALUES ${rows.join(',')}`, values)
          }
          await conn.run('COMMIT')
        } catch (error) {
          try { await conn.run('ROLLBACK') } catch (rollback) {
            this.initError = new AggregateError([error, rollback], 'poll_data write outcome uncertain; reopen with a new store after investigation')
            throw this.initError
          }
          throw error
        }
        this.buffer.splice(0, batch.length)
        this.persistenceError = null
      } catch (error) { this.persistenceError = error; throw error }
      finally { conn?.closeSync() }
    })
  }

  /** Explicit device/time range only; leaves the live cache and configuration intact. */
  async deleteHistory(objectId: number, start: string, end: string, dryRun = true) {
    if (!Number.isSafeInteger(objectId) || objectId < 1) throw new Error('设备 ID 无效')
    const from = new Date(start), to = new Date(end)
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) throw new Error('历史时间范围无效')
    // Queue buffered inserts before the deletion so old buffered samples cannot reappear afterward.
    const flushing = this.flush()
    const result = this.mutate(async () => {
      await flushing
      const conn = await this.ready
      const params = { objectId, start: from.toISOString(), end: to.toISOString() }
      const where = 'object_id = $objectId AND ts >= CAST($start AS TIMESTAMP) AND ts <= CAST($end AS TIMESTAMP)'
      const rows = (await conn.runAndReadAll(`SELECT COUNT(*) AS c FROM poll_data WHERE ${where}`, params)).getRowObjects()
      const affectedRows = Number(rows[0]?.c ?? 0)
      if (!dryRun) await conn.run(`DELETE FROM poll_data WHERE ${where}`, params)
      return { objectId, start: params.start, end: params.end, dryRun, affectedRows }
    })
    return result
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
    this.background(this.cleanup())
  }

  async cleanup(): Promise<void> {
    return this.mutate(async () => {
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
    })
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
  ): Promise<Array<{ ts: string; area: ModbusArea; address: number; rawValue: number; quality: string; batchId: string | null; timestampMs: number }>> {
    await this.mutations
    const conn = await this.ready
    const startUtc = this.normalizeToUtc(start)
    const endUtc = this.normalizeToUtc(end)
    const limitClamped = limit != null ? Math.max(1, Math.min(200000, Math.trunc(limit))) : 200000
    const reader = await conn.runAndReadAll(
      `SELECT ts, area, address, raw_value, quality, batch_id FROM poll_data
       WHERE object_id = $objectId AND ts >= $start AND ts <= $end
       ORDER BY ts
       LIMIT $limit`,
      { objectId, start: startUtc, end: endUtc, limit: limitClamped },
    )
    const rows = reader.getRowObjects() as Array<{ ts: unknown; area: unknown; address: unknown; raw_value: unknown; quality: unknown; batch_id: unknown }>
    return rows.map(r => ({ ts: localTs(String(r.ts)), timestampMs: rawTimestampMs(r.ts), area: String(r.area ?? 'holding-register') as ModbusArea, address: Number(r.address), rawValue: Number(r.raw_value), quality: String(r.quality ?? ''), batchId: r.batch_id == null ? null : String(r.batch_id) }))
  }

  /** 全局快照键统一为 objectId:area:address。timestamp 输出为服务器本地时间。 */
  getLatest(): Record<string, { rawValue: number; quality: string; timestamp: string; timestampMs?: number; batchId?: string | null }> {
    const out: Record<string, { rawValue: number; quality: string; timestamp: string; timestampMs?: number; batchId?: string | null }> = {}
    for (const [k, v] of this.latest) out[k] = { ...v, timestamp: localTs(v.timestamp), timestampMs: Date.parse(v.timestamp) }
    return out
  }

  /** 单设备、单数据区的最新快照（按地址键控）。timestamp 输出为服务器本地时间。 */
  getLatestByObject(objectId: number, area: ModbusArea): Record<number, { rawValue: number; quality: string; timestamp: string; timestampMs?: number; batchId?: string | null }> {
    const out: Record<number, { rawValue: number; quality: string; timestamp: string; timestampMs?: number; batchId?: string | null }> = {}
    const prefix = `${objectId}:${area}:`
    for (const [k, v] of this.latest) {
      if (k.startsWith(prefix)) out[Number(k.slice(prefix.length))] = { ...v, timestamp: localTs(v.timestamp), timestampMs: Date.parse(v.timestamp) }
    }
    return out
  }

  /** 单设备四数据区快照，键统一为 area:address。timestamp 输出为服务器本地时间。 */
  getLatestByObjectAll(objectId: number): Record<string, { rawValue: number; quality: string; timestamp: string; timestampMs?: number; batchId?: string | null }> {
    const out: Record<string, { rawValue: number; quality: string; timestamp: string; timestampMs?: number; batchId?: string | null }> = {}
    const prefix = objectId + ':'
    for (const [k, v] of this.latest) {
      if (!k.startsWith(prefix)) continue
      const key = k.slice(prefix.length)
      out[key] = { ...v, timestamp: localTs(v.timestamp), timestampMs: Date.parse(v.timestamp) }
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
  ): Promise<{ points: Array<{ ts: string; area: ModbusArea; address: number; rawValue: number; quality: string; batchId: string | null; timestampMs: number }>; total: number; page: number; pageSize: number; hasMore: boolean }> {
    await this.mutations
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
      `SELECT ts, area, address, raw_value, quality, batch_id FROM poll_data
       WHERE object_id = $objectId AND ts >= $lo AND ts <= $hi
       ORDER BY ts ASC, address ASC`,
      { objectId, lo: pageTs[0], hi: pageTs[pageTs.length - 1] },
    )
    const rows = ptsReader.getRowObjects() as Array<{ ts: unknown; area: unknown; address: unknown; raw_value: unknown; quality: unknown; batch_id: unknown }>
    const points = rows.map(r => ({
      ts: localTs(String(r.ts)), timestampMs: rawTimestampMs(r.ts),
      area: String(r.area ?? 'holding-register') as ModbusArea,
      address: Number(r.address),
      rawValue: Number(r.raw_value),
      quality: String(r.quality ?? ''), batchId: r.batch_id == null ? null : String(r.batch_id),
    }))
    return { points, total, page: p, pageSize: size, hasMore: p * size + pageTs.length < total }
  }

  /** Query the cold tier for a single address over a time range. */
  async query(
    objectId: number, address: number, start: string, end: string, area: ModbusArea, limit?: number,
  ): Promise<Array<{ ts: string; rawValue: number; quality: string; batchId: string | null; timestampMs: number }>> {
    await this.mutations
    const conn = await this.ready
    const startUtc = this.normalizeToUtc(start)
    const endUtc = this.normalizeToUtc(end)
    const limitClamped = limit != null ? Math.max(1, Math.min(200000, Math.trunc(limit))) : 200000
    const reader = await conn.runAndReadAll(
      `SELECT ts, raw_value, quality, batch_id FROM poll_data
       WHERE object_id = $objectId AND area = $area AND address = $address AND ts >= $start AND ts <= $end
       ORDER BY ts
       LIMIT $limit`,
      { objectId, area, address, start: startUtc, end: endUtc, limit: limitClamped },
    )
    const rows = reader.getRowObjects() as Array<{ ts: unknown; raw_value: unknown; quality: unknown; batch_id: unknown }>
    return rows.map(r => ({ ts: localTs(String(r.ts)), timestampMs: rawTimestampMs(r.ts), rawValue: Number(r.raw_value), quality: String(r.quality ?? ''), batchId: r.batch_id == null ? null : String(r.batch_id) }))
  }

  /** 单地址查询 + offset 分页（升序，最早的在前），供 MCP 等需要翻完整大时间范围的场景。 */
  async queryWithOffset(
    objectId: number, address: number, start: string, end: string, area: ModbusArea, limit: number, offset = 0,
  ): Promise<Array<{ ts: string; rawValue: number; quality: string; timestampMs: number; batchId: string | null }>> {
    await this.mutations
    const conn = await this.ready
    const startUtc = this.normalizeToUtc(start)
    const endUtc = this.normalizeToUtc(end)
    const limitClamped = Math.max(1, Math.min(200000, Math.trunc(limit)))
    const off = Math.max(0, Math.trunc(offset) || 0)
    const reader = await conn.runAndReadAll(
      `SELECT ts, raw_value, quality, batch_id FROM poll_data
       WHERE object_id = $objectId AND area = $area AND address = $address AND ts >= $start AND ts <= $end
       ORDER BY ts
       LIMIT $limit OFFSET $off`,
      { objectId, area, address, start: startUtc, end: endUtc, limit: limitClamped, off },
    )
    const rows = reader.getRowObjects() as Array<{ ts: unknown; raw_value: unknown; quality: unknown; batch_id: unknown }>
    return rows.map(r => {
      const timestamp = String(r.ts)
      const utc = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(timestamp) ? timestamp : timestamp + 'Z'
      return { ts: localTs(timestamp), timestampMs: Date.parse(utc), rawValue: Number(r.raw_value), quality: String(r.quality ?? ''), batchId: r.batch_id == null ? null : String(r.batch_id) }
    })
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

  /** Timestamp-grouped samples with explicit response verification; bounded display memory. */
  async queryRegisterCurve(objectId: number, start: string, end: string, registers: Array<{ id: number; functionCode: number; startAddress: number; dataType: string }>, maxPoints = 1200, signal?: AbortSignal) {
    const startMs = Date.parse(start), endMs = Date.parse(end)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) throw Object.assign(new Error('时间范围无效'), { statusCode: 400 })
    const buckets = Math.max(1, Math.min(5000, Math.floor(maxPoints / 6) || 1))
    const bucketMs = Math.max(1, Math.ceil((endMs - startMs) / buckets))
    if (!registers.length) return { series: [], sourceSamples: 0, displayedSamples: 0, downsampled: false, complete: true, start, end }
    await this.ready
    const conn = await this.instance!.connect()
    const interrupted = () => conn.interrupt()
    signal?.addEventListener('abort', interrupted, { once: true })
    try {
      signal?.throwIfAborted()
      const params: Record<string, any> = { objectId, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() }
      const defs = registers.map((r, i) => {
        Object.assign(params, { ['id' + i]: r.id, ['area' + i]: areaForFunction(r.functionCode as ModbusFunctionCode), ['addr' + i]: r.startAddress, ['width' + i]: registerWidth(r.dataType) })
        return `($id${i}, $area${i}, $addr${i}, $width${i})`
      }).join(',')
      const samplers = new Map(registers.map(r => [r.id, new CurveSampler(startMs, bucketMs)]))
      const byId = new Map(registers.map(r => [r.id, r]))
      const continuity = new Map<number, { previous: number; segment: number; sourceGapMs: number | null }>()
      const result = await conn.stream(`WITH grouped AS (SELECT r.id, date_diff('millisecond', DATE '1970-01-01', p.ts) AS time,
        list(p.raw_value ORDER BY p.address) AS words, list(p.quality ORDER BY p.address) AS qualities,
        list(p.address ORDER BY p.address) AS addresses, list(p.batch_id ORDER BY p.address) AS batch_ids,
        count(DISTINCT p.address) AS word_count
        FROM poll_data p JOIN (VALUES ${defs}) AS r(id, area, addr, width)
        ON p.area = r.area AND p.address >= r.addr AND p.address < r.addr + r.width
        WHERE p.object_id = $objectId AND p.ts >= $start AND p.ts <= $end
        GROUP BY r.id, p.ts), timed AS (
          SELECT *, time - lag(time) OVER (PARTITION BY id ORDER BY time) AS interval_ms FROM grouped
        ) SELECT *, median(CASE WHEN interval_ms > 0 THEN interval_ms END) OVER (PARTITION BY id) AS cadence_ms
        FROM timed ORDER BY time, id`, params)
      for await (const rows of result.yieldRowObjects()) {
        signal?.throwIfAborted()
        for (const row of rows) {
          const id = Number(row.id), reg = byId.get(id)!
          const words = (row.words as any).items.map(Number) as number[]
          const qualities = (row.qualities as any).items.map(String) as string[]
          const addresses = (row.addresses as any).items.map(Number) as number[]
          const ids = (row.batch_ids as any).items as Array<string | null>
          const decoded = decodeHistoricalSample(reg, words.map((rawValue, i) => ({ address: addresses[i], rawValue, quality: qualities[i], batchId: ids[i] })))
          const raw = decoded.value ?? NaN
          const number = typeof raw === 'bigint' && (raw > BigInt(Number.MAX_SAFE_INTEGER) || raw < BigInt(Number.MIN_SAFE_INTEGER)) ? NaN : Number(raw)
          const time = Number(row.time), cadence = Number(row.cadence_ms)
          const state = continuity.get(id) ?? { previous: time, segment: 0, sourceGapMs: cadence > 0 ? cadence * 3 : null }
          if (state.sourceGapMs !== null && time - state.previous > state.sourceGapMs) state.segment++
          if (!Number.isFinite(number)) state.segment++
          samplers.get(id)!.add({ time, value: Number.isFinite(number) ? number : null, words, qualities, verification: Number.isFinite(number) ? decoded.verification : 'unknown', segment: state.segment })
          state.previous = time
          continuity.set(id, state)
        }
      }
      let sourceSamples = 0, displayedSamples = 0
      const series = registers.map(r => {
        const sampler = samplers.get(r.id)!, displayed = sampler.samples(), samples = displayed.map(s => [s.time, s.value] as [number, number | null])
        sourceSamples += sampler.count; displayedSamples += samples.length
        const intervals = samples.slice(1).map((p, i) => p[0] - samples[i][0]).filter(v => v > 0).sort((a, b) => a - b)
        return { id: r.id, samples, segments: displayed.map(s => [s.time, s.segment!] as const), sourceGapMs: continuity.get(r.id)?.sourceGapMs ?? null, verification: displayed.map(s => [s.time, s.verification] as const), integrity: sampler.integrity(), summary: sampler.summary(), gapMs: intervals.length ? intervals[Math.floor(intervals.length / 2)] * 3 : null }
      })
      return { series, sourceSamples, displayedSamples, downsampled: displayedSamples < sourceSamples, complete: true, start, end }
    } finally { signal?.removeEventListener('abort', interrupted); conn.disconnectSync() }
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
