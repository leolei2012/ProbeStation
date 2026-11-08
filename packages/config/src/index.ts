import { createHash, randomUUID } from 'node:crypto'
import net from 'node:net'
import type { Context } from 'cordis'
import z from 'schemastery'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { ALARM_OPERATORS } from '../../core/src/alarm.ts'
import { parseConfigBackup, type ConfigBackup } from './backup.ts'
import { parseRegisterQuantity } from './register-quantity.ts'
import { CommittedConfigurationNotificationError } from './notification-error.ts'
import { assertImportedPointTable, type ImportedPointGroup, type ImportedPointDefinition } from '../../core/src/point-import.ts'
import { withRegisterSources } from '../../core/src/sample-source.ts'
import { selectSourceRegister } from '../../core/src/register-selection.ts'
import { areaForFunction, type ModbusFunctionCode } from '../../core/src/protocol.ts'
import { registerWidth } from '../../core/src/codec.ts'
import { semanticPointFields, type SemanticPointUpdate } from '../../core/src/semantic-import.ts'
import { capturePointEditBaseline, parsePointEditRequest, pointEditMatches } from '../../core/src/point-settings-edit.ts'
import { captureDeviceEditBaseline, deviceEditMatches, parseDeviceEditRequest } from '../../core/src/device-settings-edit.ts'
import { captureGroupEditGraph, groupDeletionAcknowledged, groupEditInvalid, parseGroupEditChanges, planGroupResize, type GroupEditSnapshot } from '../../core/src/group-settings-edit.ts'
import { RecordingIntervals, type RecordingIntervalLease, type RecordingSourceGuard } from './recording-interval.ts'
import { alarmRuleMatches, parseAlarmEdit, invalidAlarmEdit } from '../../core/src/alarm-settings-edit.ts'
import { captureAlarmContext, alarmContextMatches, parseAlarmContext, type AlarmContext } from '../../core/src/alarm-settings-context.ts'
import { parseLogCleanupPreview, parseLogCleanupRequest, type LogCleanupPreview, type LogCleanupResult } from '../../core/src/log-cleanup.ts'
import { activationMatches, activationTarget, captureActivation, parseActivationRequest, type ActivationKind, type ActivationSnapshot } from '../../core/src/activation-settings.ts'
import { closeResourceDependents, registerResourceCleanup, throwCleanupErrors } from '../../core/src/resource-close.ts'

export const name = 'config'

declare module 'cordis' {
  interface Events { 'config/changed'(payload: { scope: string; id?: number }): void }
}

export interface Config { dbPath: string }
export const Config: z<Config> = z.object({ dbPath: z.string() })

export interface DeviceRecord { id: number; name: string; ip: string; port: number; mode: string; isActive: number; transport: string; serialPath: string | null; baudRate: number; parity: string; stopBits: number; dataBits: number; flowControl: string; slaveId: number; pollIntervalMs: number; timeoutMs: number; dataRetainSeconds: number | null }
export interface GroupRecord { id: number; objectId: number; name: string; slaveId: number; functionCode: number; startAddress: number; quantity: number; mode: string; isActive: number }
export interface RegisterRecord { id: number; groupId: number; objectId: number; alias: string | null; functionCode: number; startAddress: number; quantity: number; dataType: string; unit: string | null; factor: number; offset: number; enumJson: string | null; decimalPlaces: number | null }
/** Configuration only: not a content revision, workspace/store lease or history snapshot. */
export interface HistoryExportConfigurationSnapshot {
  readonly version: 1; readonly configurationScope: string
  readonly device: Readonly<DeviceRecord>
  readonly groups: readonly Readonly<GroupRecord>[]
  readonly registers: readonly Readonly<RegisterRecord>[]
}
export interface RuleRecord { id: number; registerId: number; operator: string; threshold: number; message: string | null }
export interface LogRecord { id: number; ts: string; level: string | null; source: string | null; message: string | null }
export interface FirmwareRecord { id: number; name: string; version: string | null; size: number; crc32: number; filePath: string | null; createdAt: string | null }
export interface PointBookImportReport { groups: number; registers: number; errors: string[]; warnings: string[] }

const OBJECT_SELECT = 'SELECT id, name, ip, port, mode, is_active AS isActive, transport, serial_path AS serialPath, baud_rate AS baudRate, parity, stop_bits AS stopBits, data_bits AS dataBits, flow_control AS flowControl, slave_id AS slaveId, poll_interval_ms AS pollIntervalMs, timeout_ms AS timeoutMs, data_retain_seconds AS dataRetainSeconds FROM monitor_objects'
const GROUP_SELECT = 'SELECT id, object_id AS objectId, name, slave_id AS slaveId, function_code AS functionCode, start_address AS startAddress, quantity, mode, is_active AS isActive FROM register_groups'
const REGISTER_SELECT = 'SELECT id, group_id AS groupId, object_id AS objectId, alias, function_code AS functionCode, start_address AS startAddress, quantity, data_type AS dataType, unit, factor, offset, enum_json AS enumJson, decimal_places AS decimalPlaces FROM registers'

const OBJECT_MAP: Record<string, string> = { name: 'name', ip: 'ip', port: 'port', mode: 'mode', isActive: 'is_active', transport: 'transport', serialPath: 'serial_path', baudRate: 'baud_rate', parity: 'parity', stopBits: 'stop_bits', dataBits: 'data_bits', flowControl: 'flow_control', slaveId: 'slave_id', pollIntervalMs: 'poll_interval_ms', timeoutMs: 'timeout_ms', dataRetainSeconds: 'data_retain_seconds' }
const GROUP_MAP: Record<string, string> = { name: 'name', slaveId: 'slave_id', functionCode: 'function_code', startAddress: 'start_address', quantity: 'quantity', mode: 'mode', isActive: 'is_active' }
const REGISTER_MAP: Record<string, string> = { alias: 'alias', functionCode: 'function_code', startAddress: 'start_address', dataType: 'data_type', unit: 'unit', factor: 'factor', offset: 'offset', enumJson: 'enum_json', decimalPlaces: 'decimal_places' }

export class ConfigStore {
  private restoring = false
  private logCleanupScope = randomUUID()
  private logCleanupBlocked = false
  private exportSnapshotScope = randomUUID()
  private exportSnapshotBlocked = false
  private db: DatabaseSync
  private dbPath: string
  private closing = false
  private closeTask: Promise<void> | undefined
  /** Wait for owned consumers before releasing SQLite; repeated callers share success or failure. */
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask
    this.closing = true
    return this.closeTask = this.finishClose()
  }
  private async finishClose(): Promise<void> {
    const errors = await closeResourceDependents(this)
    this.exportSnapshotScope = randomUUID(); this.exportSnapshotBlocked = true
    this.logCleanupScope = randomUUID(); this.logCleanupBlocked = true
    this.recordingIntervals.reset()
    try { if (this.db.isOpen) this.db.close() } catch (error) { errors.push(error) }
    throwCleanupErrors(errors, 'Configuration shutdown failed')
  }
  private recordingIntervals = new RecordingIntervals(() => this.db, id => this.getObject(id), (id, intervalMs) => this.update('monitor_objects', id, { pollIntervalMs: intervalMs }, OBJECT_MAP), () => this.restoring, id => this.notify('object', id))
  acquireRecordingInterval(id: number, intervalMs: number, expectedSource?: RecordingSourceGuard) { return this.recordingIntervals.acquire(id, intervalMs, expectedSource) }
  captureRecordingSource(id: number) { return this.recordingIntervals.captureSource(id) }
  // Producers may also bind the guard to the exact configuration snapshot used before I/O.
  recordingSourceMatches(guard: RecordingSourceGuard, snapshot?: DeviceRecord) { return this.recordingIntervals.sourceMatches(guard, snapshot) }
  revokeRecordingInterval(lease: RecordingIntervalLease) { this.recordingIntervals.revoke(lease) }
  recordingIntervalLeaseValid(lease: RecordingIntervalLease) { return this.recordingIntervals.valid(lease) }
  restoreRecordingInterval(lease: RecordingIntervalLease) { return this.recordingIntervals.restore(lease) }
  getRecordingIntervalScope() { return this.recordingIntervals.scope() }

  constructor(config: Config, private readonly onChange?: (scope: string, id?: number) => void) {
    this.dbPath = config.dbPath
    this.db = this.open(config.dbPath)
  }

  /** 元数据变更后回调（供上层广播 config/changed，让前端/MCP 状态同步）。 */
  private notify(scope: string, id?: number): void {
    if (this.restoring) return
    // Observe before invoking a possibly reentrant callback. Unknown runtimes fail closed.
    const committed = this.db.isTransaction === false
    try { this.onChange?.(scope, id) }
    catch (error) { if (committed) throw new CommittedConfigurationNotificationError(error); throw error }
  }

  /** 打开（或重开）一个库文件并确保 schema 存在。 */
  private open(dbPath: string): DatabaseSync {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    const db = new DatabaseSync(dbPath)
    try {
      // Keep CREATEs and legacy ALTERs atomic; a failed BEGIN owns no transaction.
      db.exec('BEGIN IMMEDIATE')
      try {
        db.exec(this.schema()); this.migrate(db); db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') }
        catch (rollback) { throw new AggregateError([error, rollback], 'Configuration migration and rollback failed') }
        throw error
      }
      return db
    }
    catch (error) {
      const errors: unknown[] = [error]
      try { db.close() } catch (cleanup) { errors.push(cleanup) }
      throwCleanupErrors(errors, 'Configuration initialization and cleanup failed'); throw error
    }
  }

  /** 旧库按实际列元数据补列；失败交由 open 回滚并报告，不猜测异常原因。 */
  private migrate(db: DatabaseSync): void {
    const columns = (table: string) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)))
    const addMissing = (table: string, additions: Array<[string, string]>) => {
      const existing = columns(table)
      for (const [col, ddl] of additions) if (!existing.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`)
    }
    const cols: Array<[string, string]> = [
      ['transport', "TEXT DEFAULT 'tcp'"],
      ['serial_path', 'TEXT'],
      ['baud_rate', 'INTEGER DEFAULT 9600'],
      ['parity', "TEXT DEFAULT 'even'"],
      ['stop_bits', 'INTEGER DEFAULT 1'],
      ['data_bits', 'INTEGER DEFAULT 8'],
      ['flow_control', "TEXT DEFAULT 'none'"],
      ['slave_id', 'INTEGER DEFAULT 1'],
      ['poll_interval_ms', 'INTEGER DEFAULT 1000'],
      ['timeout_ms', 'INTEGER DEFAULT 3000'],
      ['data_retain_seconds', 'INTEGER'],
    ]
    addMissing('monitor_objects', cols)
    // Earliest point tables predate per-group slave selection (the historical default is 1).
    // This is configuration compatibility, never a backfill of historical sample identity.
    addMissing('register_groups', [['slave_id', 'INTEGER DEFAULT 1']])
    // registers 语义列（幂等）
    const regCols: Array<[string, string]> = [
      ['unit', 'TEXT'],
      ['factor', 'REAL DEFAULT 1'],
      ['offset', 'REAL DEFAULT 0'],
      ['enum_json', 'TEXT'],
      ['decimal_places', 'INTEGER'],
    ]
    addMissing('registers', regCols)
    // 已废弃：分组级扫描间隔列，改用设备级采样周期统一轮询（幂等删除）
    if (columns('register_groups').has('poll_interval_ms')) db.exec('ALTER TABLE register_groups DROP COLUMN poll_interval_ms')
  }

  /** 切换工作区：关闭旧库、打开新库（幂等，CREATE TABLE IF NOT EXISTS）。 */
  reopen(dbPath: string): void {
    if (this.closing) throw new Error('Configuration is closing or closed')
    this.exportSnapshotScope = randomUUID(); this.exportSnapshotBlocked = true
    this.logCleanupScope = randomUUID()
    this.recordingIntervals.reset()
    this.db.close()
    this.dbPath = dbPath
    this.db = this.open(dbPath)
    this.logCleanupBlocked = false
    this.exportSnapshotBlocked = false
  }

  private schema(): string {
    return `
      CREATE TABLE IF NOT EXISTS monitor_objects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, ip TEXT NOT NULL, port INTEGER DEFAULT 502,
        mode TEXT DEFAULT 'master', is_active INTEGER DEFAULT 1,
        transport TEXT DEFAULT 'tcp', serial_path TEXT,
        baud_rate INTEGER DEFAULT 9600, parity TEXT DEFAULT 'even',
        stop_bits INTEGER DEFAULT 1, data_bits INTEGER DEFAULT 8,
        flow_control TEXT DEFAULT 'none', slave_id INTEGER DEFAULT 1,
        poll_interval_ms INTEGER DEFAULT 1000, timeout_ms INTEGER DEFAULT 3000, data_retain_seconds INTEGER
      );
      CREATE TABLE IF NOT EXISTS register_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_id INTEGER NOT NULL, name TEXT NOT NULL, slave_id INTEGER DEFAULT 1,
        function_code INTEGER DEFAULT 3, start_address INTEGER DEFAULT 0, quantity INTEGER DEFAULT 1,
        mode TEXT DEFAULT 'read', is_active INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS registers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL, object_id INTEGER NOT NULL, alias TEXT,
        function_code INTEGER NOT NULL, start_address INTEGER NOT NULL,
        quantity INTEGER DEFAULT 1, data_type TEXT DEFAULT 'int16',
        unit TEXT, factor REAL DEFAULT 1, offset REAL DEFAULT 0, enum_json TEXT
      );
      CREATE TABLE IF NOT EXISTS alarm_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        register_id INTEGER NOT NULL, operator TEXT NOT NULL DEFAULT '>',
        threshold REAL NOT NULL DEFAULT 0, message TEXT
      );
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, level TEXT DEFAULT 'INFO',
        source TEXT, message TEXT
      );
      CREATE TABLE IF NOT EXISTS firmwares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, version TEXT,
        size INTEGER DEFAULT 0, crc32 INTEGER DEFAULT 0,
        file_path TEXT, created_at TEXT
      );
    `
  }

  listObjects(): DeviceRecord[] { return this.db.prepare(OBJECT_SELECT + ' ORDER BY id').all() as unknown as DeviceRecord[] }
  getObject(id: number): DeviceRecord | undefined { return this.db.prepare(OBJECT_SELECT + ' WHERE id = ?').get(id) as unknown as DeviceRecord | undefined }
  createObject(name: string, ip: string, port: number, mode = 'master', extra?: Partial<Pick<DeviceRecord, 'transport' | 'serialPath' | 'baudRate' | 'parity' | 'stopBits' | 'dataBits' | 'flowControl' | 'slaveId' | 'pollIntervalMs' | 'timeoutMs' | 'dataRetainSeconds'>>): DeviceRecord {
    this.validateDevice({ mode, ip, port, ...extra })
    const transport = extra?.transport ?? 'tcp'
    const serialPath = extra?.serialPath ?? null
    const baudRate = extra?.baudRate ?? 9600
    const parity = extra?.parity ?? 'even'
    const stopBits = extra?.stopBits ?? 1
    const dataBits = extra?.dataBits ?? 8
    const flowControl = extra?.flowControl ?? 'none'
    const slaveId = extra?.slaveId ?? 1
    const pollIntervalMs = extra?.pollIntervalMs ?? 1000
    const timeoutMs = extra?.timeoutMs ?? 3000
    const dataRetainSeconds = extra?.dataRetainSeconds ?? null
    const res = this.db.prepare('INSERT INTO monitor_objects (name, ip, port, mode, transport, serial_path, baud_rate, parity, stop_bits, data_bits, flow_control, slave_id, poll_interval_ms, timeout_ms, data_retain_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(name, ip, port, mode, transport, serialPath, baudRate, parity, stopBits, dataBits, flowControl, slaveId, pollIntervalMs, timeoutMs, dataRetainSeconds)
    const id = Number(res.lastInsertRowid)
    this.notify('object', id)
    return this.getObject(id)!
  }
  updateObject(id: number, fields: Record<string, unknown>): DeviceRecord | undefined {
    const before = this.getObject(id)
    if (before) this.validateDevice({ ...before, ...fields })
    this.update('monitor_objects', id, fields, OBJECT_MAP)
    this.notify('object', id)
    return this.getObject(id)
  }
  private validateDevice(device: any): void {
    const fail = (message: string) => { throw Object.assign(new Error(message), { statusCode: 400 }) }
    if (!['master', 'slave'].includes(device.mode)) fail('设备角色必须为 master 或 slave')
    if (device.mode !== 'slave') return
    const transport = device.transport ?? 'tcp', unitId = device.slaveId ?? 1
    if (!['tcp', 'rtu'].includes(transport)) fail('从站连接方式必须为 TCP 或 RTU')
    if (!Number.isInteger(unitId) || unitId < 1 || unitId > 247) fail('从站地址必须为 1–247')
    if (transport === 'tcp' && (typeof device.ip !== 'string' || !net.isIP(device.ip) || !Number.isInteger(device.port) || device.port < 1 || device.port > 65535)) fail('从站请填写有效的本机监听 IP 和端口')
    if (transport === 'rtu' && (typeof device.serialPath !== 'string' || !device.serialPath.trim() || (device.dataBits ?? 8) !== 8 || !['none', 'even', 'odd'].includes(device.parity ?? 'even') || ![1, 2].includes(device.stopBits ?? 1) || !Number.isInteger(device.baudRate ?? 9600) || (device.baudRate ?? 9600) < 300 || (device.baudRate ?? 9600) > 4000000)) fail('RTU 从站请填写有效串口参数，数据位必须为 8')
  }
  /** Editor-only conditional metadata update. Runtime connection changes belong to the API after commit. */
  updateObjectSettings(id: number, request: unknown): { device: DeviceRecord; warnings: string[] } {
    const { expected, changes } = parseDeviceEditRequest(request)
    if (!Number.isSafeInteger(id) || id < 1 || expected.id !== id) throw Object.assign(new Error('设备编号与编辑快照不一致。'), { statusCode: 400 })
    if (this.restoring) throw Object.assign(new Error('配置正在批量更新，请核对后重新编辑。'), { statusCode: 409 })
    let device: DeviceRecord
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.getObject(id)
      if (!current) throw Object.assign(new Error('设备已不存在，本次未保存。请关闭窗口并刷新。'), { statusCode: 404 })
      let baseline
      try { baseline = captureDeviceEditBaseline(current) } catch { baseline = null }
      if (!baseline || !deviceEditMatches(baseline, expected)) throw Object.assign(new Error('设备配置已变更，本次未保存。草稿已保留；请记录修改，关闭并刷新配置后重新编辑。'), { statusCode: 409 })
      this.validateDevice({ ...current, ...changes })
      this.update('monitor_objects', id, changes, OBJECT_MAP)
      device = this.getObject(id)!
      if (!device) throw new Error('保存后无法读取设备，事务已中止。')
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (rollback) { throw new AggregateError([error, rollback], '设备设置回滚失败，结果待核实，勿自动重试。') }
      throw error
    }
    const warnings: string[] = []
    try { this.notify('object', id) } catch { warnings.push('配置已保存，但变更通知失败；请刷新核对，勿重复保存。') }
    return { device, warnings }
  }
  private deleteAtomically(action: () => void): void {
    if (this.restoring) { action(); return } // The existing bulk transaction owns rollback and notification.
    const ownsTransaction = this.db.isTransaction === false
    const savepoint = 'config_delete_' + randomUUID().replaceAll('-', '')
    this.db.exec(`SAVEPOINT ${savepoint}`)
    try { action(); this.db.exec(`RELEASE SAVEPOINT ${savepoint}`) }
    catch (error) {
      const errors: unknown[] = [error]
      let rolledBack = false
      try { this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); rolledBack = true } catch (rollback) { errors.push(rollback) }
      // Never release potentially partial changes after a failed rollback.
      if (rolledBack) { try { this.db.exec(`RELEASE SAVEPOINT ${savepoint}`) } catch (release) { errors.push(release) } }
      if (errors.length > 1) {
        // A whole rollback is safe only when this delete opened the outermost transaction.
        if (ownsTransaction) { try { this.db.exec('ROLLBACK') } catch (rollback) { errors.push(rollback) } }
        throw new AggregateError(errors, '配置删除回滚未确认，结果待核实；请核对数据库状态，勿重复删除。')
      }
      throw error
    }
  }
  deleteObject(id: number): void {
    this.recordingIntervals.deleted(id)
    this.deleteAtomically(() => {
      this.db.prepare('DELETE FROM alarm_rules WHERE register_id IN (SELECT id FROM registers WHERE object_id = ?)').run(id)
      this.db.prepare('DELETE FROM registers WHERE object_id = ?').run(id)
      this.db.prepare('DELETE FROM register_groups WHERE object_id = ?').run(id)
      this.db.prepare('DELETE FROM monitor_objects WHERE id = ?').run(id)
    })
    this.notify('object', id)
  }
  /** Additive conditional SET; legacy inversion methods remain unchanged for existing callers. */
  setActivation(kind: ActivationKind, id: number, request: unknown): { snapshot: ActivationSnapshot; warnings: string[] } {
    const { expected, isActive } = parseActivationRequest(request, kind, id)
    if (this.restoring) throw Object.assign(new Error('配置正在批量更新，请刷新后核对开关。'), { statusCode: 409 })
    const read = () => {
      const group = kind === 'group' ? this.getGroup(id) : undefined
      const device = this.getObject(kind === 'device' ? id : group?.objectId ?? 0)
      if (!device || kind === 'group' && !group) throw Object.assign(new Error('设备或分组已不存在，本次未切换。'), { statusCode: 404 })
      return captureActivation(device, group)
    }
    let snapshot!: ActivationSnapshot
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (!activationMatches(read(), expected)) throw Object.assign(new Error('开关状态或配置来源已变化，本次未切换。请刷新核对，勿直接重复操作。'), { statusCode: 409 })
      this.db.prepare(kind === 'device' ? 'UPDATE monitor_objects SET is_active = ? WHERE id = ?' : 'UPDATE register_groups SET is_active = ? WHERE id = ?').run(isActive, id)
      snapshot = read()
      if (!activationMatches(snapshot, activationTarget(expected, isActive))) throw new Error('开关写回不一致，事务中止。')
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (rollback) { throw new AggregateError([error, rollback], '开关结果待核实，勿直接重复操作。') }
      throw error
    }
    const warnings: string[] = []
    try { this.notify(kind === 'device' ? 'object' : 'group', id) } catch { warnings.push('开关配置已保存，但变更通知失败；请核对运行状态，勿重复切换。') }
    return { snapshot, warnings }
  }
  toggleObject(id: number): DeviceRecord | undefined {
    this.db.prepare('UPDATE monitor_objects SET is_active = 1 - is_active WHERE id = ?').run(id)
    this.notify('object', id)
    return this.getObject(id)
  }

  listGroups(objectId: number): GroupRecord[] { return this.db.prepare(GROUP_SELECT + ' WHERE object_id = ? ORDER BY id').all(objectId) as unknown as GroupRecord[] }
  getGroup(id: number): GroupRecord | undefined { return this.db.prepare(GROUP_SELECT + ' WHERE id = ?').get(id) as unknown as GroupRecord | undefined }
  createGroup(objectId: number, name: string, functionCode: number, startAddress: number, quantity: number, mode = 'read', slaveId = 1, options?: { isActive?: number }): GroupRecord {
    const isActive = options?.isActive === undefined ? 1 : options.isActive
    if (isActive !== 0 && isActive !== 1) throw Object.assign(new Error('分组启用状态必须为0或1。'), { statusCode: 400 })
    const res = this.db.prepare('INSERT INTO register_groups (object_id, name, slave_id, function_code, start_address, quantity, mode, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(objectId, name, slaveId, functionCode, startAddress, quantity, mode, isActive)
    const id = Number(res.lastInsertRowid)
    this.notify('group', id)
    return this.getGroup(id)!
  }
  /** REST creation owns group and default words together; primitive createGroup remains independent. */
  createGroupWithRegisters(objectId: number, name: string, functionCode: number, startAddress: number, quantity: number, mode = 'read', slaveId = 1, options?: { isActive?: number }): GroupRecord & { warnings: string[] } {
    if (this.restoring) throw Object.assign(new Error('配置正在批量更新，不能嵌套新建分组。'), { statusCode: 409 })
    const isActive = options?.isActive
    if (isActive !== undefined && isActive !== 0 && isActive !== 1) throw Object.assign(new Error('分组启用状态必须为0或1。'), { statusCode: 400 })
    let group!: GroupRecord
    const registerIds: number[] = []
    this.db.exec('BEGIN IMMEDIATE'); this.restoring = true
    try {
      group = this.createGroup(objectId, name, functionCode, startAddress, quantity, mode, slaveId, { isActive })
      for (let i = 0; i < group.quantity; i++) registerIds.push(this.createRegister(group.id, group.objectId, null, group.functionCode, group.startAddress + i, 'int16').id)
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (rollback) { throw new AggregateError([error, rollback], '分组创建回滚失败，结果待核实，勿重复创建。') }
      throw error
    } finally { this.restoring = false }
    let notificationFailed = false
    const emit = (scope: string, id: number) => { try { this.notify(scope, id) } catch { notificationFailed = true } }
    emit('group', group.id)
    for (const id of registerIds) emit('register', id)
    return { ...group, warnings: notificationFailed ? ['分组及点位已创建，但变更通知失败；请刷新核对，勿重复创建。'] : [] }
  }
  updateGroup(id: number, fields: Record<string, unknown>): GroupRecord | undefined {
    if (this.restoring) return this.updateGroupRows(id, fields) // Existing bulk transaction owns rollback and notification.
    let result: GroupRecord | undefined
    this.db.exec('BEGIN IMMEDIATE'); this.restoring = true
    try { result = this.updateGroupRows(id, fields); this.db.exec('COMMIT') }
    catch (error) { try { this.db.exec('ROLLBACK') } catch (rollback) { throw new AggregateError([error, rollback], '分组更新回滚失败，结果待核实，勿自动重试。') }; throw error }
    finally { this.restoring = false }
    this.notify('group', id)
    return result
  }
  private updateGroupRows(id: number, fields: Record<string, unknown>): GroupRecord | undefined {
    const before = this.getGroup(id)
    this.update('register_groups', id, fields, GROUP_MAP)
    const after = this.getGroup(id)
    // quantity 变化时同步寄存器数量：缩小删除多余的（按 start_address 排序保留前 N 个），扩大补建缺失（int16 无别名）
    if (before && after && typeof fields.quantity === 'number' && before.quantity !== after.quantity) {
      const newQty = Math.max(0, Math.trunc(after.quantity))
      const regs = this.db.prepare('SELECT id, start_address FROM registers WHERE group_id = ? ORDER BY start_address').all(id) as Array<{ id: number; start_address: number }>
      if (regs.length > newQty) {
        // 缩小：删除排序后超出前 newQty 个的寄存器（走 deleteRegister 以触发 register 事件）
        for (const r of regs.slice(newQty)) this.deleteRegister(r.id)
      } else if (regs.length < newQty) {
        // 扩大：从分组起始地址起补建缺失地址，直到凑够 newQty 个
        const existing = new Set(regs.map(r => r.start_address))
        let addr = after.startAddress
        while (existing.size < newQty) {
          if (!existing.has(addr)) {
            this.createRegister(id, after.objectId, null, after.functionCode, addr, 'int16')
            existing.add(addr)
          }
          addr++
        }
      }
    }
    this.notify('group', id)
    return this.getGroup(id)
  }
  private groupEditSnapshot(id: number): GroupEditSnapshot {
    const group = this.getGroup(id)
    if (!group) throw Object.assign(new Error('分组已不存在，请关闭窗口并刷新。'), { statusCode: 404 })
    const registers = this.listRegisters(id), ids = new Set(registers.map(row => row.id))
    const graph = captureGroupEditGraph({ group, device: this.getObject(group.objectId), registers, rules: this.listRules().filter(rule => ids.has(rule.registerId)) })
    return Object.freeze({ ...graph, revision: 'v1:' + createHash('sha256').update(JSON.stringify(graph)).digest('hex') })
  }
  /** Read one coherent graph; do not create a token from separately racing register/rule reads. */
  getGroupSettings(id: number): GroupEditSnapshot {
    if (!Number.isSafeInteger(id) || id < 1) return groupEditInvalid()
    if (this.restoring) throw Object.assign(new Error('配置正在批量更新，请稍后重读。'), { statusCode: 409 })
    this.db.exec('BEGIN')
    try { const result = this.groupEditSnapshot(id); this.db.exec('COMMIT'); return result }
    catch (error) { try { this.db.exec('ROLLBACK') } catch (rollback) { throw new AggregateError([error, rollback], '分组快照读取结束失败，请核对数据库状态。') }; throw error }
  }
  updateGroupSettings(id: number, request: unknown) {
    const raw = request as any
    if (!Number.isSafeInteger(id) || id < 1 || !raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.expectedRevision !== 'string' || !/^v1:[a-f0-9]{64}$/.test(raw.expectedRevision) || Object.keys(raw).some(key => !['expectedRevision', 'changes', 'confirmedDeletion'].includes(key))) return groupEditInvalid()
    if (this.restoring) throw Object.assign(new Error('配置正在批量更新，请核对后重新编辑。'), { statusCode: 409 })
    let result: { snapshot: GroupEditSnapshot; deletedRegisterIds: readonly number[]; deletedRuleIds: readonly number[]; addedRegisterIds: number[] }
    this.db.exec('BEGIN IMMEDIATE'); this.restoring = true
    try {
      const before = this.groupEditSnapshot(id)
      if (before.revision !== raw.expectedRevision) throw Object.assign(new Error('分组、点位、告警或设备来源已变化，本次未保存。草稿已保留；请记录修改，关闭并刷新后重新编辑。'), { statusCode: 409 })
      const changes = parseGroupEditChanges(raw.changes, before.group), plan = planGroupResize(before, changes)
      if (!groupDeletionAcknowledged(raw.confirmedDeletion, plan)) throw Object.assign(new Error('请先核对并确认本次将删除的点位和告警。'), { statusCode: 400 })
      this.updateGroupRows(id, changes)
      const snapshot = this.groupEditSnapshot(id), oldIds = new Set(before.registers.map(row => row.id))
      const remaining = new Set(snapshot.registers.map(row => row.id)), remainingRules = new Set(snapshot.rules.map(row => row.id))
      const deletedRegisterIds = before.registers.filter(row => !remaining.has(row.id)).map(row => row.id), deletedRuleIds = before.rules.filter(row => !remainingRules.has(row.id)).map(row => row.id)
      const added = snapshot.registers.filter(row => !oldIds.has(row.id)), deleted = new Set(plan.removeRegisterIds), deletedRules = new Set(plan.removeRuleIds)
      const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
      const byId = (a: { id: number }, b: { id: number }) => a.id - b.id
      if (!equal(deletedRegisterIds, plan.removeRegisterIds) || !equal(deletedRuleIds, plan.removeRuleIds) || !equal(added.map(row => row.startAddress), plan.addAddresses) || !equal(snapshot.group, { ...before.group, ...changes }) || !equal(snapshot.device, before.device) || !equal(snapshot.registers.filter(row => oldIds.has(row.id)).sort(byId), before.registers.filter(row => !deleted.has(row.id)).sort(byId)) || !equal(snapshot.rules, before.rules.filter(row => !deletedRules.has(row.id)))) throw new Error('缩扩容实际结果与已核对计划不一致，事务已中止。')
      result = { snapshot, deletedRegisterIds, deletedRuleIds, addedRegisterIds: added.map(row => row.id) }
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (rollback) { throw new AggregateError([error, rollback], '分组保存回滚失败，结果待核实，勿自动重试。') }
      throw error
    } finally { this.restoring = false }
    const warnings: string[] = []
    try { this.notify('group', id) } catch { warnings.push('分组及点位/告警已保存，但变更通知失败；请刷新核对，勿重复保存。') }
    return { ...result, warnings }
  }
  deleteGroup(id: number): void {
    this.deleteAtomically(() => {
      this.db.prepare('DELETE FROM alarm_rules WHERE register_id IN (SELECT id FROM registers WHERE group_id = ?)').run(id)
      this.db.prepare('DELETE FROM registers WHERE group_id = ?').run(id)
      this.db.prepare('DELETE FROM register_groups WHERE id = ?').run(id)
    })
    this.notify('group', id)
  }
  toggleGroup(id: number): GroupRecord | undefined {
    this.db.prepare('UPDATE register_groups SET is_active = 1 - is_active WHERE id = ?').run(id)
    this.notify('group', id)
    return this.getGroup(id)
  }

  /** One group's points; a device ID is not interchangeable with groupId. */
  listRegisters(groupId: number): RegisterRecord[] { return this.db.prepare(REGISTER_SELECT + ' WHERE group_id = ? ORDER BY start_address').all(groupId) as unknown as RegisterRecord[] }
  /** All points of a device, across all of its groups. */
  listRegistersByObject(objectId: number): RegisterRecord[] { return this.db.prepare(REGISTER_SELECT + ' WHERE object_id = ? ORDER BY start_address').all(objectId) as unknown as RegisterRecord[] }
  /** In-memory open-lifetime identity only; no SQL, content revision or path disclosure. */
  getHistoryExportConfigurationScope(): string {
    if (this.restoring || this.exportSnapshotBlocked) throw Object.assign(new Error('导出配置快照暂不可用，请核对配置状态。'), { statusCode: 409 })
    return this.exportSnapshotScope
  }
  /** One bounded read transaction; no raw history reads, notifications or runtime hooks. */
  getHistoryExportConfiguration(objectId: number): HistoryExportConfigurationSnapshot {
    if (!Number.isSafeInteger(objectId) || objectId < 1) throw Object.assign(new Error('导出配置设备编号无效。'), { statusCode: 400 })
    if (this.restoring || this.exportSnapshotBlocked) throw Object.assign(new Error('导出配置快照暂不可用，请核对配置状态。'), { statusCode: 409 })
    this.db.exec('BEGIN')
    try {
      // Fixed SELECT projections exclude unrelated tables/extra fields. No inferred source or validation repair.
      const device = this.db.prepare(OBJECT_SELECT + ' WHERE id = ?').get(objectId) as unknown as DeviceRecord | undefined
      if (!device) throw Object.assign(new Error('导出配置设备不存在。'), { statusCode: 404 })
      const groups = this.db.prepare(GROUP_SELECT + ' WHERE object_id = ? ORDER BY id').all(objectId) as unknown as GroupRecord[]
      const registers = this.db.prepare(REGISTER_SELECT + ' WHERE object_id = ? ORDER BY start_address').all(objectId) as unknown as RegisterRecord[]
      const snapshot = Object.freeze({ version: 1 as const, configurationScope: this.exportSnapshotScope, device: Object.freeze({ ...device }), groups: Object.freeze(groups.map(row => Object.freeze({ ...row }))), registers: Object.freeze(registers.map(row => Object.freeze({ ...row }))) })
      this.db.exec('COMMIT'); return snapshot
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (rollback) {
        this.exportSnapshotScope = randomUUID(); this.exportSnapshotBlocked = true
        throw new AggregateError([error, rollback], '导出配置读取回滚失败，已停止提供快照。')
      }
      throw error
    }
  }
  getRegister(id: number): RegisterRecord | undefined { return this.db.prepare(REGISTER_SELECT + ' WHERE id = ?').get(id) as unknown as RegisterRecord | undefined }

  /** Add file windows atomically; no existing devices/groups/registers/rules are changed. */
  appendImportedPoints(objectId: number, groups: readonly ImportedPointGroup[], registers: readonly ImportedPointDefinition[]) {
    if (!Number.isSafeInteger(objectId) || objectId < 1 || !this.getObject(objectId)) throw Object.assign(new Error('导入目标设备不存在'), { statusCode: 404 })
    assertImportedPointTable(groups, registers)
    if (!groups.length && !registers.length) return { groups: 0, registers: 0, warnings: [] as string[] }
    if (this.restoring) throw new Error('配置正在批量更新，不能嵌套导入')
    this.db.exec('BEGIN IMMEDIATE')
    this.restoring = true // Suppress partial graphs; also used by backup restore.
    try {
      const created = groups.map(g => this.createGroup(objectId, g.name, g.functionCode, g.startAddress, g.quantity, g.mode, g.slaveId))
      for (const r of registers) this.createRegister(created[r.groupIndex].id, objectId, r.alias, r.functionCode, r.startAddress, r.dataType)
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (rollback) { throw new AggregateError([error, rollback], '点表导入回滚失败，结果不确定，请检查配置，勿自动重试') }
      throw error
    } finally { this.restoring = false }
    const warnings: string[] = []
    try { this.notify('import', objectId) }
    catch { warnings.push('配置已提交，但变更通知失败，当前实例可能尚未刷新；请核对，勿重复导入。') }
    return { groups: groups.length, registers: registers.length, warnings }
  }

  /** Synchronous XLSX builder only: one replacement/append transaction, no partial config events. */
  applyPointBookImport(objectId: number, replace: boolean, build: () => Pick<PointBookImportReport, 'groups' | 'registers' | 'errors'>): PointBookImportReport {
    if (!Number.isSafeInteger(objectId) || objectId < 1 || !this.getObject(objectId)) throw Object.assign(new Error('导入目标设备不存在'), { statusCode: 404 })
    if (this.restoring) throw new Error('配置正在批量更新，不能嵌套点位表导入')
    const rejected = Symbol('invalid point book')
    let result: Pick<PointBookImportReport, 'groups' | 'registers' | 'errors'> | undefined
    this.db.exec('BEGIN IMMEDIATE'); this.restoring = true
    try {
      if (replace) for (const group of this.listGroups(objectId)) this.deleteGroup(group.id)
      result = build()
      if (!result.groups && !result.errors.length) result.errors.push('点位表没有分组页，未替换原配置。')
      if (result.errors.length) throw rejected
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') }
      catch (rollback) { throw new AggregateError([error, rollback], '点位表导入回滚失败，结果不确定，请核对配置，勿自动重试') }
      if (error === rejected) return { groups: 0, registers: 0, errors: result!.errors, warnings: [] }
      throw error
    } finally { this.restoring = false }
    const warnings: string[] = []
    try { this.notify('point-book-import', objectId) }
    catch { warnings.push('点位表已提交，但同步通知失败；请核对配置，勿重复导入。') }
    return { ...result!, warnings }
  }

  /** 更新已有点位语义；来源/点位可精确选择，歧义跳过，有效行原子提交。 */
  importPoints(objectId: number, points: SemanticPointUpdate[]) {
    const device = this.getObject(objectId)
    if (!Number.isSafeInteger(objectId) || objectId < 1 || !device) throw Object.assign(new Error('导入目标设备不存在'), { statusCode: 404 })
    if (!Array.isArray(points)) throw Object.assign(new Error('点表必须为数组'), { statusCode: 400 })
    const groups = this.listGroups(objectId), regs = withRegisterSources(this.listRegistersByObject(objectId), groups, device)
    let skipped = 0
    const errors: string[] = []
    const details: Array<{ row: number; code: string; error: string; candidates?: unknown[] }> = []
    const plans: Array<{ id: number; fields: Record<string, unknown> }> = []
    const reject = (row: number, code: string, error: string, candidates?: unknown[]) => {
      skipped++; details.push({ row, code, error, ...(candidates ? { candidates } : {}) })
      const choices = (candidates as Array<{ register_id: number; slave_id: number | null }> | undefined)?.map(c => `#${c.register_id}(从站${c.slave_id ?? '未知'})`).join(', ')
      errors.push(`row ${row}: ${error}${choices ? ' 候选：' + choices : ''}`)
    }
    points.forEach((p, row) => {
      if (!p || typeof p !== 'object') { reject(row, 'INVALID_SEMANTIC_ROW', '点表行必须为对象'); return }
      if (![1, 2, 3, 4].includes(p.functionCode)) { reject(row, 'REGISTER_SELECTOR_INVALID', '语义导入只接受读取功能码FC01/02/03/04'); return }
      const selected = selectSourceRegister(regs, { area: areaForFunction(p.functionCode as ModbusFunctionCode), address: p.address, slaveId: p.slaveId, registerId: p.registerId })
      if ('error' in selected) { reject(row, selected.code, selected.error, selected.candidates); return }
      const parsed = semanticPointFields(p)
      if ('error' in parsed) { reject(row, 'INVALID_SEMANTIC_FIELD', parsed.error); return }
      if (p.dataType !== undefined) {
        const g = groups.find(g => g.id === selected.register.groupId), address = selected.register.startAddress, width = registerWidth(p.dataType)
        if (!g || !Number.isInteger(g.startAddress) || !Number.isInteger(g.quantity) || g.quantity < 1 ||
          g.startAddress + g.quantity > 65536 || address + width > 65536 || address < g.startAddress || address + width > g.startAddress + g.quantity) {
          reject(row, 'SEMANTIC_WIDTH_OUTSIDE_GROUP', '新dtype的完整字宽超出所属分组，未扩组或修改该行'); return
        }
      }
      if (!Object.keys(parsed.fields).length) { skipped++; return }
      plans.push({ id: selected.register.id, fields: parsed.fields })
    })
    const warnings: string[] = []
    if (plans.length) {
      if (this.restoring) throw new Error('配置正在批量更新，不能嵌套语义导入')
      this.db.exec('BEGIN IMMEDIATE'); this.restoring = true
      try { for (const plan of plans) this.updateRegister(plan.id, plan.fields); this.db.exec('COMMIT') }
      catch (error) { try { this.db.exec('ROLLBACK') } catch (rollback) { throw new AggregateError([error, rollback], '语义导入回滚失败，结果不确定，勿自动重试') }; throw error }
      finally { this.restoring = false }
      try { this.notify('point-import', objectId) } catch { warnings.push('语义配置已提交，但同步通知失败，请核对，勿重复导入。') }
    }
    return { updated: plans.length, skipped, errors, details, warnings }
  }
  createRegister(groupId: number, objectId: number, alias: string | null, functionCode: number, startAddress: number, dataType = 'int16', extra?: Partial<Pick<RegisterRecord, 'unit' | 'factor' | 'offset' | 'enumJson' | 'decimalPlaces' | 'quantity'>>): RegisterRecord {
    const unit = extra?.unit ?? null
    const factor = extra?.factor ?? 1
    const offset = extra?.offset ?? 0
    const enumJson = extra?.enumJson ?? null
    const decimalPlaces = extra?.decimalPlaces ?? null
    const quantity = parseRegisterQuantity(extra && Object.hasOwn(extra, 'quantity') ? extra.quantity : 1)
    this.validateDecimalPlaces(decimalPlaces)
    const res = this.db.prepare('INSERT INTO registers (group_id, object_id, alias, function_code, start_address, data_type, quantity, unit, factor, offset, enum_json, decimal_places) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(groupId, objectId, alias, functionCode, startAddress, dataType, quantity, unit, factor, offset, enumJson, decimalPlaces)
    const id = Number(res.lastInsertRowid)
    this.notify('register', id)
    return this.getRegister(id)!
  }
  private validateDecimalPlaces(value: unknown): void {
    if (value !== null && (!Number.isInteger(value) || typeof value !== 'number' || value < 0 || value > 8)) throw Object.assign(new Error('小数位数必须为 0–8 的整数，或留空使用自动格式'), { statusCode: 400 })
  }
  updateRegister(id: number, fields: Record<string, unknown>): RegisterRecord | undefined {
    if (Object.hasOwn(fields, 'decimalPlaces')) this.validateDecimalPlaces(fields.decimalPlaces)
    this.update('registers', id, fields, REGISTER_MAP)
    this.notify('register', id)
    return this.getRegister(id)
  }
  /** Read the point and its source in one SQLite snapshot, without runtime/hardware access. */
  getRegisterSettings(id: number) {
    if (!Number.isSafeInteger(id) || id < 1) throw Object.assign(new Error('点位编号无效。'), { statusCode: 400 })
    if (this.restoring) throw Object.assign(new Error('配置正在批量更新，请稍后重读。'), { statusCode: 409 })
    this.db.exec('BEGIN')
    try {
      const point = this.getRegister(id)
      if (!point) throw Object.assign(new Error('点位不存在。'), { statusCode: 404 })
      const group = this.getGroup(point.groupId), device = this.getObject(point.objectId)
      if (!group || !device || group.objectId !== point.objectId) throw Object.assign(new Error('点位来源不一致，请核对配置。'), { statusCode: 409 })
      const expected = capturePointEditBaseline(point, group, device)
      this.db.exec('COMMIT'); return expected
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (rollback) { throw new AggregateError([error, rollback], '点位快照读取结束失败，请核对数据库状态。') }
      throw error
    }
  }
  /** The lock covers compare, range validation, update and readback for every guarded caller. */
  updateRegisterSettings(id: number, request: unknown): { point: RegisterRecord; warnings: string[] } {
    const { expected, changes } = parsePointEditRequest(request)
    if (!Number.isSafeInteger(id) || id < 1 || expected.point.id !== id) throw Object.assign(new Error('点位编号与保存快照不一致。'), { statusCode: 400 })
    if (this.restoring) throw Object.assign(new Error('配置正在批量更新，请稍后核对再保存。'), { statusCode: 409 })
    const conflict = () => Object.assign(new Error('配置已变更，本次未保存。草稿已保留；请先记录所需修改，关闭窗口并刷新配置后重新编辑。'), { statusCode: 409 })
    let point: RegisterRecord
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.getRegister(id)
      if (!current) throw Object.assign(new Error('点位已不存在，本次未保存。请关闭窗口并刷新配置。'), { statusCode: 404 })
      const group = this.getGroup(current.groupId), device = this.getObject(current.objectId)
      if (!group || !device || group.objectId !== current.objectId) throw conflict()
      let baseline
      try { baseline = capturePointEditBaseline(current, group, device) } catch { throw conflict() }
      if (!pointEditMatches(baseline, expected, changes)) throw conflict()
      if (changes.dataType !== undefined && current.startAddress + registerWidth(changes.dataType) > group.startAddress + group.quantity) throw Object.assign(new Error('dataType spans beyond the group poll range'), { statusCode: 400 })
      this.update('registers', id, changes, REGISTER_MAP)
      point = this.getRegister(id)!
      if (!point || Object.entries({ ...current, ...changes }).some(([key, value]) => (point as any)[key] !== value)) throw new Error('点位保存后读回不一致，事务已中止。')
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (rollback) { throw new AggregateError([error, rollback], '点位设置回滚失败，结果不确定，请核对配置，勿自动重试。') }
      throw error
    }
    const warnings: string[] = []
    try { this.notify('register', id) } catch { warnings.push('配置已保存，但变更通知失败。请刷新核对，勿重复保存。') }
    return { point, warnings }
  }
  deleteRegister(id: number): void {
    this.deleteAtomically(() => {
      this.db.prepare('DELETE FROM alarm_rules WHERE register_id = ?').run(id)
      this.db.prepare('DELETE FROM registers WHERE id = ?').run(id)
    })
    this.notify('register', id)
  }

  listRules(): RuleRecord[] { return this.db.prepare('SELECT id, register_id AS registerId, operator, threshold, message FROM alarm_rules ORDER BY id').all() as unknown as RuleRecord[] }
  createRule(registerId: number, operator: string, threshold: number, message: string | null): RuleRecord {
    this.validateRule(registerId, operator, threshold, message)
    const res = this.db.prepare('INSERT INTO alarm_rules (register_id, operator, threshold, message) VALUES (?, ?, ?, ?)').run(registerId, operator, threshold, message)
    const id = Number(res.lastInsertRowid)
    this.notify('rule', id)
    return this.db.prepare('SELECT id, register_id AS registerId, operator, threshold, message FROM alarm_rules WHERE id = ?').get(id) as unknown as RuleRecord
  }
  private validateRule(registerId: number, operator: string, threshold: number, message: string | null): void {
    if (!Number.isInteger(registerId) || !this.getRegister(registerId)) throw Object.assign(new Error('告警点位不存在'), { statusCode: 400 })
    if (!(ALARM_OPERATORS as readonly string[]).includes(operator) || typeof threshold !== 'number' || !Number.isFinite(threshold)) throw Object.assign(new Error('告警比较条件或阈值无效'), { statusCode: 400 })
    if (message !== null && (typeof message !== 'string' || message.length > 200)) throw Object.assign(new Error('告警提示最多 200 字'), { statusCode: 400 })
  }
  updateRule(id: number, fields: { registerId: number; operator: string; threshold: number; message: string | null }): RuleRecord {
    if (!this.listRules().some(r => r.id === id)) throw Object.assign(new Error('告警规则不存在'), { statusCode: 404 })
    this.validateRule(fields.registerId, fields.operator, fields.threshold, fields.message)
    this.db.prepare('UPDATE alarm_rules SET register_id = ?, operator = ?, threshold = ?, message = ? WHERE id = ?').run(fields.registerId, fields.operator, fields.threshold, fields.message, id)
    this.notify('rule', id)
    return this.listRules().find(r => r.id === id)!
  }
  deleteRule(id: number): void {
    this.db.prepare('DELETE FROM alarm_rules WHERE id = ?').run(id)
    this.notify('rule', id)
  }

  updateRuleSettings(id: number, request: unknown) { return this.mutateRuleSettings(id, request, false) }
  deleteRuleSettings(id: number, request: unknown) { return this.mutateRuleSettings(id, request, true) }
  private alarmPointContext(registerId: number): AlarmContext {
    const point = this.getRegister(registerId), group = point && this.getGroup(point.groupId), device = point && this.getObject(point.objectId)
    if (!point || !group || !device || group.objectId !== point.objectId) throw Object.assign(new Error('告警点位或来源已不存在/不一致，请重新核对。'), { statusCode: 409 })
    return captureAlarmContext(point, group, device)
  }
  getAlarmEditContext(selection: { ruleId?: number; registerId?: number }) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection) || Object.keys(selection).some(key => !['ruleId', 'registerId'].includes(key))) return invalidAlarmEdit()
    const { ruleId, registerId } = selection
    if ((ruleId === undefined) === (registerId === undefined) || !Number.isSafeInteger(ruleId ?? registerId) || (ruleId ?? registerId)! < 1) return invalidAlarmEdit()
    if (this.restoring) throw Object.assign(new Error('配置正在批量更新，请稍后重读。'), { statusCode: 409 })
    this.db.exec('BEGIN')
    try {
      const expected = ruleId === undefined ? undefined : this.listRules().find(row => row.id === ruleId)
      if (ruleId !== undefined && !expected) throw Object.assign(new Error('告警规则不存在。'), { statusCode: 404 })
      const expectedContext = this.alarmPointContext(expected?.registerId ?? registerId!)
      this.db.exec('COMMIT'); return { ...(expected ? { expected: Object.freeze({ ...expected }) } : {}), expectedContext }
    } catch (error) { try { this.db.exec('ROLLBACK') } catch (rollback) { throw new AggregateError([error, rollback], '告警快照读取结束失败。') }; throw error }
  }
  createRuleSettings(request: unknown) {
    const raw = request as any
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.fields || typeof raw.fields !== 'object' || Array.isArray(raw.fields) || Object.keys(raw).some(key => !['fields', 'expectedContext'].includes(key)) || Object.keys(raw.fields).some(key => !['registerId', 'operator', 'threshold', 'message'].includes(key))) return invalidAlarmEdit()
    const expectedContext = parseAlarmContext(raw.expectedContext), fields = raw.fields
    parseAlarmEdit({ expected: { id: 1, ...fields }, changes: { operator: fields.operator, threshold: fields.threshold, message: fields.message } })
    if (fields.registerId !== expectedContext.point.id) return invalidAlarmEdit()
    if (this.restoring) throw Object.assign(new Error('配置正在批量更新，请稍后核对。'), { statusCode: 409 })
    let rule: RuleRecord
    this.db.exec('BEGIN IMMEDIATE'); this.restoring = true
    try {
      if (!alarmContextMatches(this.alarmPointContext(fields.registerId), expectedContext)) throw Object.assign(new Error('告警点位或来源已变化，本次未新增。请保留草稿并重新核对。'), { statusCode: 409 })
      rule = this.createRule(fields.registerId, fields.operator, fields.threshold, fields.message)
      if (!alarmRuleMatches(rule, { id: rule.id, ...fields }) || !alarmContextMatches(this.alarmPointContext(fields.registerId), expectedContext)) throw new Error('新增告警读回不一致，事务已中止。')
      this.db.exec('COMMIT')
    } catch (error) { try { this.db.exec('ROLLBACK') } catch (rollback) { throw new AggregateError([error, rollback], '新增告警回滚失败，结果待核实。') }; throw error }
    finally { this.restoring = false }
    const warnings: string[] = []
    try { this.notify('rule', rule.id) } catch { warnings.push('告警已新增，但通知失败，请读回核对，勿重复新增。') }
    return { rule, warnings, protection: 'rule-and-context' as const }
  }
  /** Compare and write under one lock. Legacy CRUD remains compatible for older clients. */
  private mutateRuleSettings(id: number, request: unknown, deleting: boolean): { rule: RuleRecord | null; deletedRuleId: number | null; warnings: string[]; protection?: 'rule-and-context' } {
    const { expected, changes, expectedContext } = parseAlarmEdit(request, deleting)
    if (!Number.isSafeInteger(id) || id < 1 || expected.id !== id) return invalidAlarmEdit()
    if (this.restoring) throw Object.assign(new Error('配置正在批量更新，请稍后重新核对告警。'), { statusCode: 409 })
    let rule: RuleRecord | null = null
    this.db.exec('BEGIN IMMEDIATE'); this.restoring = true
    try {
      const before = this.listRules().find(row => row.id === id)
      if (!before) throw Object.assign(new Error('告警规则已不存在，本次未修改。'), { statusCode: 404 })
      if (!alarmRuleMatches(before, expected)) throw Object.assign(new Error('告警规则已被修改，本次未保存或删除。请保留草稿，重新读取并核对后再编辑。'), { statusCode: 409 })
      if (expectedContext && !alarmContextMatches(this.alarmPointContext(before.registerId), expectedContext)) throw Object.assign(new Error('告警点位定义或来源已变化，本次未保存或删除。请保留草稿，关闭并刷新后重新编辑。'), { statusCode: 409 })
      if (deleting) this.deleteRule(id)
      else rule = this.updateRule(id, { ...before, ...changes })
      const after = this.listRules().find(row => row.id === id)
      if (deleting ? after !== undefined : !after || !alarmRuleMatches(after, { ...before, ...changes })) throw new Error('告警操作读回不一致，事务已中止。')
      if (!deleting) rule = after!
      if (expectedContext && !alarmContextMatches(this.alarmPointContext(before.registerId), expectedContext)) throw new Error('告警点位或来源读回不一致，事务已中止。')
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (rollback) { throw new AggregateError([error, rollback], '告警操作回滚失败，结果待核实，勿自动重试。') }
      throw error
    } finally { this.restoring = false }
    const warnings: string[] = []
    try { this.notify('rule', id) } catch { warnings.push('告警操作已保存，但变更通知失败；请重新读取核对，勿重复操作。') }
    return { rule, deletedRuleId: deleting ? id : null, warnings, ...(expectedContext ? { protection: 'rule-and-context' as const } : {}) }
  }

  log(level: string, source: string, message: string): void {
    const res = this.db.prepare('INSERT INTO logs (ts, level, source, message) VALUES (?, ?, ?, ?)').run(new Date().toISOString(), level, source, message)
    // 长期运行防日志表无限膨胀：每 100 条清一次，只保留最近 10000 条
    const id = Number((res as any).lastInsertRowid)
    if (id % 100 === 0) this.db.prepare('DELETE FROM logs WHERE id < ?').run(id - 10000)
  }
  listLogs(limit = 100): LogRecord[] { return this.db.prepare('SELECT id, ts, level, source, message FROM logs ORDER BY id DESC LIMIT ?').all(limit) as unknown as LogRecord[] }
  clearLogs(): void { this.db.prepare('DELETE FROM logs').run() }

  private logCleanupRevision(throughId: number, count: number) { return 'v1:' + createHash('sha256').update(JSON.stringify([this.logCleanupScope, throughId, count])).digest('hex') }
  private assertLogCleanupIds() {
    const sql = (this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'logs'").get() as any)?.sql
    if (typeof sql !== 'string' || !/\bid\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i.test(sql)) throw Object.assign(new Error('日志表递增ID契约尚未核实，本次未清理。'), { statusCode: 409 })
  }
  previewLogCleanup(): LogCleanupPreview {
    if (this.logCleanupBlocked) throw new Error('上次日志清理结果未确认，需要人工排查。')
    this.assertLogCleanupIds()
    const row = this.db.prepare('SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS throughId FROM logs').get() as any
    const throughId = Number(row.throughId), count = Number(row.count)
    return parseLogCleanupPreview({ version: 1, throughId, count, revision: this.logCleanupRevision(throughId, count) })
  }
  /** Append-only log IDs: delete only the reviewed prefix, preserving subsequent records. */
  cleanupReviewedLogs(request: unknown): LogCleanupResult {
    const expected = parseLogCleanupRequest(request)
    if (this.restoring || this.logCleanupBlocked || expected.revision !== this.logCleanupRevision(expected.throughId, expected.count)) throw Object.assign(new Error('日志来源或清理条件已变化，本次未清理；请重新预览。'), { statusCode: 409 })
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.assertLogCleanupIds()
      const current = Number((this.db.prepare('SELECT COUNT(*) AS count FROM logs WHERE id <= ?').get(expected.throughId) as any).count)
      if (!Number.isSafeInteger(current) || current < 0 || current > expected.count) throw Object.assign(new Error('预览范围内日志已变化，本次未清理；请重新预览。'), { statusCode: 409 })
      const deleted = Number(this.db.prepare('DELETE FROM logs WHERE id <= ?').run(expected.throughId).changes)
      const remaining = Number((this.db.prepare('SELECT COUNT(*) AS count FROM logs').get() as any).count)
      const oldRemaining = Number((this.db.prepare('SELECT COUNT(*) AS count FROM logs WHERE id <= ?').get(expected.throughId) as any).count)
      if (deleted !== current || oldRemaining !== 0 || !Number.isSafeInteger(remaining) || remaining < 0) throw new Error('日志清理读回不一致')
      this.db.exec('COMMIT')
      return Object.freeze({ ok: true, throughId: expected.throughId, revision: expected.revision, deleted, alreadyRemoved: expected.count - deleted, remaining })
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (rollback) { this.logCleanupScope = randomUUID(); this.logCleanupBlocked = true; throw new AggregateError([error, rollback], '日志清理回滚失败，结果待核实，勿自动重试。') }
      throw error
    }
  }

  listFirmwares(): FirmwareRecord[] { return this.db.prepare('SELECT id, name, version, size, crc32, file_path AS filePath, created_at AS createdAt FROM firmwares ORDER BY id DESC').all() as unknown as FirmwareRecord[] }
  getFirmware(id: number): FirmwareRecord | undefined { return this.db.prepare('SELECT id, name, version, size, crc32, file_path AS filePath, created_at AS createdAt FROM firmwares WHERE id = ?').get(id) as unknown as FirmwareRecord | undefined }
  createFirmware(name: string, version: string | null, size: number, crc32: number, filePath: string | null): FirmwareRecord {
    const res = this.db.prepare('INSERT INTO firmwares (name, version, size, crc32, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(name, version, size, crc32 >>> 0, filePath, new Date().toISOString())
    return this.getFirmware(Number(res.lastInsertRowid))!
  }
  setFirmwarePath(id: number, filePath: string): void { this.db.prepare('UPDATE firmwares SET file_path = ? WHERE id = ?').run(filePath, id) }
  deleteFirmware(id: number): void { this.db.prepare('DELETE FROM firmwares WHERE id = ?').run(id) }

  exportBackup(): ConfigBackup {
    const devices = this.listObjects()
    return { format: 'probestation-config', version: 1, createdAt: new Date().toISOString(), devices,
      groups: devices.flatMap(d => this.listGroups(d.id)), registers: devices.flatMap(d => this.listRegistersByObject(d.id)), rules: this.listRules() }
  }

  previewBackup(value: unknown) {
    const b = parseConfigBackup(value)
    // Run the exact import path against an isolated database, including device/rule validation.
    const scratch = new ConfigStore({ dbPath: ':memory:' })
    try { scratch.restoreBackup(b) } finally { scratch.db.close() }
    const names = new Set(this.listObjects().map(d => d.name))
    return { devices: b.devices.map(d => ({ name: d.name, mode: d.mode, transport: d.transport, endpoint: d.transport === 'rtu' ? d.serialPath : `${d.ip}:${d.port}`, sameName: names.has(d.name) })),
      counts: { devices: b.devices.length, groups: b.groups.length, registers: b.registers.length, rules: b.rules.length } }
  }

  /** Additive atomic restore; new IDs isolate existing history and every imported device starts paused. */
  restoreBackup(value: unknown) {
    const b = parseConfigBackup(value), devices = new Map<number, number>(), groups = new Map<number, number>(), registers = new Map<number, number>()
    this.db.exec('BEGIN IMMEDIATE')
    this.restoring = true
    try {
      for (const d of b.devices) {
        const next = this.createObject(d.name, d.ip, d.port, d.mode, d)
        this.updateObject(next.id, { isActive: 0 })
        devices.set(d.id, next.id)
      }
      for (const g of b.groups) {
        const next = this.createGroup(devices.get(g.objectId)!, g.name, g.functionCode, g.startAddress, g.quantity, g.mode, g.slaveId)
        this.updateGroup(next.id, { isActive: g.isActive }); groups.set(g.id, next.id)
      }
      for (const r of b.registers) {
        const next = this.createRegister(groups.get(r.groupId)!, devices.get(r.objectId)!, r.alias, r.functionCode, r.startAddress, r.dataType, r)
        registers.set(r.id, next.id)
      }
      for (const r of b.rules) this.createRule(registers.get(r.registerId)!, r.operator, r.threshold, r.message)
      this.db.exec('COMMIT')
    } catch (e) { this.db.exec('ROLLBACK'); throw e }
    finally { this.restoring = false }
    const warnings: string[] = []
    try { this.notify('backup') }
    catch { warnings.push('配置已恢复，但变更通知未完成。请刷新设备列表并核对新增的暂停设备，不要重复恢复。') }
    return { deviceIds: [...devices.values()], devices: devices.size, groups: groups.size, registers: registers.size, rules: b.rules.length, warnings }
  }

  /** 元数据计数（供数据统计展示）。 */
  metadataStats(): Record<string, number> {
    const count = (table: string): number => Number((this.db.prepare('SELECT COUNT(*) AS c FROM ' + table).get() as any)?.c ?? 0)
    return {
      devices: count('monitor_objects'),
      groups: count('register_groups'),
      registers: count('registers'),
      rules: count('alarm_rules'),
      firmwares: count('firmwares'),
      logs: count('logs'),
    }
  }

  private update(table: string, id: number, fields: Record<string, unknown>, mapping: Record<string, string>): void {
    const cols: string[] = []
    const vals: SQLInputValue[] = []
    for (const [key, col] of Object.entries(mapping)) {
      const value = fields[key]
      if (value !== undefined) {
        if (value !== null && !['string', 'number', 'bigint'].includes(typeof value)) throw Object.assign(new Error('配置字段必须为文本或数值：' + key), { statusCode: 400 })
        cols.push(`${col} = ?`); vals.push(value as SQLInputValue)
      }
    }
    if (cols.length === 0) return
    if (table === 'monitor_objects' && fields.pollIntervalMs !== undefined) this.recordingIntervals.changed(id)
    if (table === 'monitor_objects') this.recordingIntervals.sourceChanged(id, fields)
    vals.push(id)
    this.db.prepare(`UPDATE ${table} SET ${cols.join(', ')} WHERE id = ?`).run(...vals)
  }
}

export function apply(ctx: Context, config: Config): void {
  const store = new ConfigStore(config, (scope, id) => ctx.emit('config/changed', { scope, id }))
  registerResourceCleanup(ctx, [], () => store.close())
  ctx.provide('config', store)
}
