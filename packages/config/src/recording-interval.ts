import type { DatabaseSync } from 'node:sqlite'
import { captureDeviceEditBaseline, deviceEditMatches, type DeviceEditBaseline } from '../../core/src/device-settings-edit.ts'
import type { DeviceRecord } from './index.ts'

export interface RecordingIntervalLease { readonly deviceId: number; readonly intervalMs: number; readonly originalPollInterval: number }
interface Guard { expected: DeviceEditBaseline; revision: symbol; dataVersion: number }
const invalid = (): never => { throw Object.assign(new Error('录制间隔参数无效。'), { statusCode: 400 }) }
const rate = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647

/** In-process ownership, without a database schema change. Other SQLite connections invalidate conservatively. */
export class RecordingIntervals {
  private revisions = new Map<number, symbol>()
  private leases = new WeakMap<RecordingIntervalLease, Guard>()
  private identity = Symbol()
  scope() { return this.identity }
  constructor(private db: () => DatabaseSync, private read: (id: number) => DeviceRecord | undefined, private write: (id: number, rate: number) => void, private restoring: () => boolean, private notify: (id: number) => void) {}
  /** Called for every supported poll-interval write, including same-value writes and rolled-back attempts. */
  changed(id: number) { if (this.revisions.has(id)) this.revisions.set(id, Symbol()) }
  deleted(id: number) { this.revisions.delete(id) }
  reset() { this.revisions.clear(); this.leases = new WeakMap(); this.identity = Symbol() }
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
    catch (error) { try { db.exec('ROLLBACK') } catch (rollback) { throw new AggregateError([error, rollback], '录制间隔回滚失败，结果待核实。') }; throw error }
  }
  private warnings(id: number) {
    const warnings: string[] = []
    try { this.notify(id) } catch { warnings.push('采样间隔已保存，但变更通知失败；请核对运行状态，勿重复操作。') }
    return warnings
  }
  acquire(id: number, intervalMs: number) {
    if (!Number.isSafeInteger(id) || id < 1 || !rate(intervalMs)) return invalid()
    const lease = this.transaction(() => {
      const before = this.read(id)
      if (!before) throw Object.assign(new Error('录制设备不存在。'), { statusCode: 404 })
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
