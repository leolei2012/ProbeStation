import type { DatabaseSync } from 'node:sqlite'
import { captureDeviceEditBaseline, deviceEditMatches, type DeviceEditBaseline } from '../../core/src/device-settings-edit.ts'
import type { DeviceRecord } from './index.ts'

export interface RecordingIntervalLease { readonly deviceId: number; readonly intervalMs: number; readonly originalPollInterval: number }
export interface RecordingSourceGuard { readonly deviceId: number }
interface Guard { expected: DeviceEditBaseline; revision: symbol; dataVersion: number }
const sourceKeys = ['mode', 'transport', 'slaveId', 'ip', 'port', 'serialPath', 'baudRate', 'parity', 'stopBits', 'dataBits', 'flowControl'] as const
function sourceSignature(row: DeviceRecord | undefined): string | null {
  if (!row || !['master', 'slave'].includes(row.mode) || !['tcp', 'rtu'].includes(row.transport) || !Number.isFinite(row.slaveId)) return null
  const values = row.transport === 'tcp' ? [row.ip, row.port] : [row.serialPath, row.baudRate, row.parity, row.stopBits, row.dataBits, row.flowControl]
  if (row.transport === 'tcp' ? typeof row.ip !== 'string' || !Number.isFinite(row.port) : row.serialPath !== null && typeof row.serialPath !== 'string' || ![row.baudRate, row.stopBits, row.dataBits].every(Number.isFinite) || typeof row.parity !== 'string' || typeof row.flowControl !== 'string') return null
  return JSON.stringify([row.id, row.mode, row.transport, row.slaveId, ...values])
}
const invalid = (): never => { throw Object.assign(new Error('录制间隔参数无效。'), { statusCode: 400 }) }
const rate = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647

/** In-process ownership, without a database schema change. Other SQLite connections invalidate conservatively. */
export class RecordingIntervals {
  private revisions = new Map<number, symbol>()
  private leases = new WeakMap<RecordingIntervalLease, Guard>()
  private identity = Symbol()
  private sourceRevisions = new Map<number, symbol>()
  private sourceGuards = new WeakMap<RecordingSourceGuard, { scope: symbol; revision: symbol; signature: string }>()
  scope() { return this.identity }
  constructor(private db: () => DatabaseSync, private read: (id: number) => DeviceRecord | undefined, private write: (id: number, rate: number) => void, private restoring: () => boolean, private notify: (id: number) => void, private rollbackFailed: (failure: AggregateError) => void = () => {}) {}
  /** Called for every supported poll-interval write, including same-value writes and rolled-back attempts. */
  changed(id: number) { if (this.revisions.has(id)) this.revisions.set(id, Symbol()) }
  deleted(id: number) { this.revisions.delete(id); this.sourceRevisions.delete(id) }
  reset() { this.revisions.clear(); this.leases = new WeakMap(); this.identity = Symbol(); this.sourceRevisions.clear(); this.sourceGuards = new WeakMap() }
  sourceChanged(id: number, fields: Record<string, unknown>) {
    if (!this.sourceRevisions.has(id) || !sourceKeys.some(key => fields[key] !== undefined)) return
    const before = this.read(id), next = { ...before, ...Object.fromEntries(sourceKeys.filter(key => fields[key] !== undefined).map(key => [key, fields[key]])) } as DeviceRecord
    const a = sourceSignature(before), b = sourceSignature(next)
    if (a === null || b === null || a !== b) this.sourceRevisions.set(id, Symbol())
  }
  captureSource(id: number): RecordingSourceGuard {
    if (!Number.isSafeInteger(id) || id < 1) return invalid()
    const row = this.read(id)
    if (!row) throw Object.assign(new Error('录制设备不存在。'), { statusCode: 404 })
    const signature = sourceSignature(row)
    if (signature === null) throw Object.assign(new Error('设备来源配置无法核对，本次未开始录制。'), { statusCode: 400 })
    if (!this.sourceRevisions.has(id)) this.sourceRevisions.set(id, Symbol())
    const guard = Object.freeze({ deviceId: id })
    this.sourceGuards.set(guard, { scope: this.identity, revision: this.sourceRevisions.get(id)!, signature }); return guard
  }
  sourceMatches(guard: RecordingSourceGuard, row?: DeviceRecord) {
    const expected = this.sourceGuards.get(guard)
    return !!expected && expected.scope === this.identity && expected.revision === this.sourceRevisions.get(guard.deviceId) && sourceSignature(this.read(guard.deviceId)) === expected.signature && (row === undefined || sourceSignature(row) === expected.signature)
  }
  revoke(lease: RecordingIntervalLease) { this.leases.delete(lease) }
  private version() {
    const value = this.db().prepare('PRAGMA data_version').get()?.data_version
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('无法核对配置数据库写入身份。')
    return value
  }
  private matches(lease: RecordingIntervalLease) {
    const guard = this.leases.get(lease), row = guard && this.read(lease.deviceId)
    if (!guard || !row || guard.revision !== this.revisions.get(lease.deviceId) || guard.dataVersion !== this.version()) return false
    return deviceEditMatches(captureDeviceEditBaseline(row), guard.expected)
  }
  private transaction<T>(run: () => T): T {
    if (this.restoring()) throw Object.assign(new Error('配置正在批量更新，录制间隔未修改。'), { statusCode: 409 })
    const db = this.db(); db.exec('BEGIN IMMEDIATE')
    try { const result = run(); db.exec('COMMIT'); return result }
    catch (error) {
      try { db.exec('ROLLBACK') }
      catch (rollback) { const failure = new AggregateError([error, rollback], '录制间隔回滚失败，结果待核实。'); this.rollbackFailed(failure); throw failure }
      throw error
    }
  }
  private warnings(id: number) {
    const warnings: string[] = []
    try { this.notify(id) } catch { warnings.push('采样间隔已保存，但变更通知失败；请核对运行状态，勿重复操作。') }
    return warnings
  }
  acquire(id: number, intervalMs: number, expectedSource?: RecordingSourceGuard) {
    if (!Number.isSafeInteger(id) || id < 1 || !rate(intervalMs)) return invalid()
    const lease = this.transaction(() => {
      const before = this.read(id)
      if (!before) throw Object.assign(new Error('录制设备不存在。'), { statusCode: 404 })
      if (expectedSource !== undefined && (!this.sourceMatches(expectedSource, before) || expectedSource.deviceId !== id)) throw Object.assign(new Error('录制准备期间设备来源已变化，本次未开始；请重新核对。'), { statusCode: 409 })
      if (!rate(before.pollIntervalMs)) return invalid()
      const expected = captureDeviceEditBaseline({ ...before, pollIntervalMs: intervalMs })
      if (!this.revisions.has(id)) this.revisions.set(id, Symbol())
      // Read the original and set the temporary rate under the same lock; no stale prepare value is restored.
      this.write(id, intervalMs)
      const saved = this.read(id)
      if (!saved || !deviceEditMatches(captureDeviceEditBaseline(saved), expected)) throw new Error('录制间隔读回不一致，事务已中止。')
      const lease = Object.freeze({ deviceId: id, intervalMs, originalPollInterval: before.pollIntervalMs })
      const revision = this.revisions.get(id)
      if (!revision) throw new Error('录制间隔缺少写入身份，事务已中止。')
      this.leases.set(lease, { expected, revision, dataVersion: this.version() })
      return lease
    })
    return { lease, warnings: this.warnings(id) }
  }
  valid(lease: RecordingIntervalLease) { return this.transaction(() => this.matches(lease)) }
  restore(lease: RecordingIntervalLease): { state: 'restored' | 'preserved'; warnings: string[] } {
    let restored: boolean
    try { restored = this.transaction(() => {
      if (!this.matches(lease)) return false
      this.write(lease.deviceId, lease.originalPollInterval)
      const row = this.read(lease.deviceId), guard = this.leases.get(lease)!
      if (!row || !deviceEditMatches(captureDeviceEditBaseline(row), { ...guard.expected, pollIntervalMs: lease.originalPollInterval })) throw new Error('恢复间隔读回不一致，事务已中止。')
      return true
    }) } finally { this.leases.delete(lease) } // One attempt, including an uncertain failure.
    return restored ? { state: 'restored', warnings: this.warnings(lease.deviceId) } : { state: 'preserved', warnings: ['录制已结束；配置/间隔写入身份已变化，保留当前间隔，未自动恢复。请人工核对采样周期。'] }
  }
}
