import type { Context } from 'cordis'
import z from 'schemastery'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'config'

export interface Config { dbPath: string }
export const Config: z<Config> = z.object({ dbPath: z.string() })

export interface DeviceRecord { id: number; name: string; ip: string; port: number; mode: string; isActive: number; transport: string; serialPath: string | null; baudRate: number; parity: string; stopBits: number; dataBits: number; flowControl: string; slaveId: number; pollIntervalMs: number; dataRetainSeconds: number | null }
export interface GroupRecord { id: number; objectId: number; name: string; slaveId: number; functionCode: number; startAddress: number; quantity: number; pollIntervalMs: number; mode: string; isActive: number }
export interface RegisterRecord { id: number; groupId: number; objectId: number; alias: string | null; functionCode: number; startAddress: number; quantity: number; dataType: string; unit: string | null; factor: number; offset: number; enumJson: string | null }
export interface RuleRecord { id: number; registerId: number; operator: string; threshold: number; message: string | null }
export interface LogRecord { id: number; ts: string; level: string; source: string | null; message: string | null }
export interface FirmwareRecord { id: number; name: string; version: string | null; size: number; crc32: number; filePath: string | null; createdAt: string | null }

const OBJECT_SELECT = 'SELECT id, name, ip, port, mode, is_active AS isActive, transport, serial_path AS serialPath, baud_rate AS baudRate, parity, stop_bits AS stopBits, data_bits AS dataBits, flow_control AS flowControl, slave_id AS slaveId, poll_interval_ms AS pollIntervalMs, data_retain_seconds AS dataRetainSeconds FROM monitor_objects'
const GROUP_SELECT = 'SELECT id, object_id AS objectId, name, slave_id AS slaveId, function_code AS functionCode, start_address AS startAddress, quantity, poll_interval_ms AS pollIntervalMs, mode, is_active AS isActive FROM register_groups'
const REGISTER_SELECT = 'SELECT id, group_id AS groupId, object_id AS objectId, alias, function_code AS functionCode, start_address AS startAddress, quantity, data_type AS dataType, unit, factor, offset, enum_json AS enumJson FROM registers'

const OBJECT_MAP: Record<string, string> = { name: 'name', ip: 'ip', port: 'port', mode: 'mode', isActive: 'is_active', transport: 'transport', serialPath: 'serial_path', baudRate: 'baud_rate', parity: 'parity', stopBits: 'stop_bits', dataBits: 'data_bits', flowControl: 'flow_control', slaveId: 'slave_id', pollIntervalMs: 'poll_interval_ms', dataRetainSeconds: 'data_retain_seconds' }
const GROUP_MAP: Record<string, string> = { name: 'name', slaveId: 'slave_id', functionCode: 'function_code', startAddress: 'start_address', quantity: 'quantity', pollIntervalMs: 'poll_interval_ms', mode: 'mode', isActive: 'is_active' }
const REGISTER_MAP: Record<string, string> = { alias: 'alias', functionCode: 'function_code', startAddress: 'start_address', dataType: 'data_type', unit: 'unit', factor: 'factor', offset: 'offset', enumJson: 'enum_json' }

export class ConfigStore {
  private db: DatabaseSync
  private dbPath: string

  constructor(config: Config, private readonly onChange?: (scope: string, id?: number) => void) {
    this.dbPath = config.dbPath
    this.db = this.open(config.dbPath)
  }

  /** 元数据变更后回调（供上层广播 config/changed，让前端/MCP 状态同步）。 */
  private notify(scope: string, id?: number): void {
    this.onChange?.(scope, id)
  }

  /** 打开（或重开）一个库文件并确保 schema 存在。 */
  private open(dbPath: string): DatabaseSync {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    const db = new DatabaseSync(dbPath)
    db.exec(this.schema())
    this.migrate(db)
    return db
  }

  /** 旧库补列（幂等，列已存在则忽略）。 */
  private migrate(db: DatabaseSync): void {
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
      ['data_retain_seconds', 'INTEGER'],
    ]
    for (const [col, ddl] of cols) {
      try { db.exec(`ALTER TABLE monitor_objects ADD COLUMN ${col} ${ddl}`) } catch { /* 列已存在 */ }
    }
    // registers 语义列（幂等）
    const regCols: Array<[string, string]> = [
      ['unit', 'TEXT'],
      ['factor', 'REAL DEFAULT 1'],
      ['offset', 'REAL DEFAULT 0'],
      ['enum_json', 'TEXT'],
    ]
    for (const [col, ddl] of regCols) {
      try { db.exec(`ALTER TABLE registers ADD COLUMN ${col} ${ddl}`) } catch { /* 列已存在 */ }
    }
  }

  /** 切换工作区：关闭旧库、打开新库（幂等，CREATE TABLE IF NOT EXISTS）。 */
  reopen(dbPath: string): void {
    this.db.close()
    this.dbPath = dbPath
    this.db = this.open(dbPath)
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
        poll_interval_ms INTEGER DEFAULT 1000, data_retain_seconds INTEGER
      );
      CREATE TABLE IF NOT EXISTS register_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_id INTEGER NOT NULL, name TEXT NOT NULL, slave_id INTEGER DEFAULT 1,
        function_code INTEGER DEFAULT 3, start_address INTEGER DEFAULT 0, quantity INTEGER DEFAULT 1,
        poll_interval_ms INTEGER DEFAULT 1000, mode TEXT DEFAULT 'read', is_active INTEGER DEFAULT 1
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
  createObject(name: string, ip: string, port: number, mode = 'master', extra?: Partial<Pick<DeviceRecord, 'transport' | 'serialPath' | 'baudRate' | 'parity' | 'stopBits' | 'dataBits' | 'flowControl' | 'slaveId' | 'pollIntervalMs' | 'dataRetainSeconds'>>): DeviceRecord {
    const transport = extra?.transport ?? 'tcp'
    const serialPath = extra?.serialPath ?? null
    const baudRate = extra?.baudRate ?? 9600
    const parity = extra?.parity ?? 'even'
    const stopBits = extra?.stopBits ?? 1
    const dataBits = extra?.dataBits ?? 8
    const flowControl = extra?.flowControl ?? 'none'
    const slaveId = extra?.slaveId ?? 1
    const pollIntervalMs = extra?.pollIntervalMs ?? 1000
    const dataRetainSeconds = extra?.dataRetainSeconds ?? null
    const res = this.db.prepare('INSERT INTO monitor_objects (name, ip, port, mode, transport, serial_path, baud_rate, parity, stop_bits, data_bits, flow_control, slave_id, poll_interval_ms, data_retain_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(name, ip, port, mode, transport, serialPath, baudRate, parity, stopBits, dataBits, flowControl, slaveId, pollIntervalMs, dataRetainSeconds)
    const id = Number(res.lastInsertRowid)
    this.notify('object', id)
    return this.getObject(id)!
  }
  updateObject(id: number, fields: Record<string, unknown>): DeviceRecord | undefined {
    this.update('monitor_objects', id, fields, OBJECT_MAP)
    this.notify('object', id)
    return this.getObject(id)
  }
  deleteObject(id: number): void {
    this.db.prepare('DELETE FROM registers WHERE object_id = ?').run(id)
    this.db.prepare('DELETE FROM register_groups WHERE object_id = ?').run(id)
    this.db.prepare('DELETE FROM monitor_objects WHERE id = ?').run(id)
    this.notify('object', id)
  }
  toggleObject(id: number): DeviceRecord | undefined {
    this.db.prepare('UPDATE monitor_objects SET is_active = 1 - is_active WHERE id = ?').run(id)
    this.notify('object', id)
    return this.getObject(id)
  }

  listGroups(objectId: number): GroupRecord[] { return this.db.prepare(GROUP_SELECT + ' WHERE object_id = ? ORDER BY id').all(objectId) as unknown as GroupRecord[] }
  getGroup(id: number): GroupRecord | undefined { return this.db.prepare(GROUP_SELECT + ' WHERE id = ?').get(id) as unknown as GroupRecord | undefined }
  createGroup(objectId: number, name: string, functionCode: number, startAddress: number, quantity: number, mode = 'read', slaveId = 1, pollIntervalMs = 1000): GroupRecord {
    const res = this.db.prepare('INSERT INTO register_groups (object_id, name, slave_id, function_code, start_address, quantity, poll_interval_ms, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(objectId, name, slaveId, functionCode, startAddress, quantity, pollIntervalMs, mode)
    const id = Number(res.lastInsertRowid)
    this.notify('group', id)
    return this.getGroup(id)!
  }
  updateGroup(id: number, fields: Record<string, unknown>): GroupRecord | undefined {
    this.update('register_groups', id, fields, GROUP_MAP)
    this.notify('group', id)
    return this.getGroup(id)
  }
  deleteGroup(id: number): void {
    this.db.prepare('DELETE FROM registers WHERE group_id = ?').run(id)
    this.db.prepare('DELETE FROM register_groups WHERE id = ?').run(id)
    this.notify('group', id)
  }
  toggleGroup(id: number): GroupRecord | undefined {
    this.db.prepare('UPDATE register_groups SET is_active = 1 - is_active WHERE id = ?').run(id)
    this.notify('group', id)
    return this.getGroup(id)
  }

  listRegisters(groupId: number): RegisterRecord[] { return this.db.prepare(REGISTER_SELECT + ' WHERE group_id = ? ORDER BY start_address').all(groupId) as unknown as RegisterRecord[] }
  listRegistersByObject(objectId: number): RegisterRecord[] { return this.db.prepare(REGISTER_SELECT + ' WHERE object_id = ? ORDER BY start_address').all(objectId) as unknown as RegisterRecord[] }
  getRegister(id: number): RegisterRecord | undefined { return this.db.prepare(REGISTER_SELECT + ' WHERE id = ?').get(id) as unknown as RegisterRecord | undefined }

  /** 点表导入：按 (functionCode, address) 匹配已有寄存器并更新语义（alias/dataType/unit/factor/offset/enum）。 */
  importPoints(objectId: number, points: Array<{ functionCode: number; address: number; alias?: string | null; dataType?: string; unit?: string | null; factor?: number; offset?: number; enumMap?: Record<string, string> | null }>): { updated: number; skipped: number; errors: string[] } {
    const regs = this.listRegistersByObject(objectId)
    let updated = 0
    let skipped = 0
    const errors: string[] = []
    for (const p of points) {
      const reg = regs.find((r) => r.functionCode === p.functionCode && r.startAddress === p.address)
      if (!reg) { skipped++; errors.push('address ' + p.address + ' (fc=' + p.functionCode + ') not found'); continue }
      const fields: Record<string, unknown> = {}
      if (p.alias != null) fields.alias = p.alias
      if (p.dataType != null) fields.dataType = p.dataType
      if (p.unit !== undefined) fields.unit = p.unit
      if (p.factor !== undefined) fields.factor = p.factor
      if (p.offset !== undefined) fields.offset = p.offset
      if (p.enumMap !== undefined) fields.enumJson = p.enumMap ? JSON.stringify(p.enumMap) : null
      if (Object.keys(fields).length === 0) { skipped++; continue }
      this.updateRegister(reg.id, fields)
      updated++
    }
    return { updated, skipped, errors }
  }
  createRegister(groupId: number, objectId: number, alias: string | null, functionCode: number, startAddress: number, dataType = 'int16', extra?: Partial<Pick<RegisterRecord, 'unit' | 'factor' | 'offset' | 'enumJson'>>): RegisterRecord {
    const unit = extra?.unit ?? null
    const factor = extra?.factor ?? 1
    const offset = extra?.offset ?? 0
    const enumJson = extra?.enumJson ?? null
    const res = this.db.prepare('INSERT INTO registers (group_id, object_id, alias, function_code, start_address, data_type, unit, factor, offset, enum_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(groupId, objectId, alias, functionCode, startAddress, dataType, unit, factor, offset, enumJson)
    const id = Number(res.lastInsertRowid)
    this.notify('register', id)
    return this.getRegister(id)!
  }
  updateRegister(id: number, fields: Record<string, unknown>): RegisterRecord | undefined {
    this.update('registers', id, fields, REGISTER_MAP)
    this.notify('register', id)
    return this.getRegister(id)
  }
  deleteRegister(id: number): void {
    this.db.prepare('DELETE FROM registers WHERE id = ?').run(id)
    this.notify('register', id)
  }

  listRules(): RuleRecord[] { return this.db.prepare('SELECT id, register_id AS registerId, operator, threshold, message FROM alarm_rules ORDER BY id').all() as unknown as RuleRecord[] }
  createRule(registerId: number, operator: string, threshold: number, message: string | null): RuleRecord {
    const res = this.db.prepare('INSERT INTO alarm_rules (register_id, operator, threshold, message) VALUES (?, ?, ?, ?)').run(registerId, operator, threshold, message)
    const id = Number(res.lastInsertRowid)
    this.notify('rule', id)
    return this.db.prepare('SELECT id, register_id AS registerId, operator, threshold, message FROM alarm_rules WHERE id = ?').get(id) as unknown as RuleRecord
  }
  deleteRule(id: number): void {
    this.db.prepare('DELETE FROM alarm_rules WHERE id = ?').run(id)
    this.notify('rule', id)
  }

  log(level: string, source: string, message: string): void {
    const res = this.db.prepare('INSERT INTO logs (ts, level, source, message) VALUES (?, ?, ?, ?)').run(new Date().toISOString(), level, source, message)
    // 长期运行防日志表无限膨胀：每 100 条清一次，只保留最近 10000 条
    const id = Number((res as any).lastInsertRowid)
    if (id % 100 === 0) this.db.prepare('DELETE FROM logs WHERE id < ?').run(id - 10000)
  }
  listLogs(limit = 100): LogRecord[] { return this.db.prepare('SELECT id, ts, level, source, message FROM logs ORDER BY id DESC LIMIT ?').all(limit) as unknown as LogRecord[] }
  clearLogs(): void { this.db.prepare('DELETE FROM logs').run() }

  listFirmwares(): FirmwareRecord[] { return this.db.prepare('SELECT id, name, version, size, crc32, file_path AS filePath, created_at AS createdAt FROM firmwares ORDER BY id DESC').all() as unknown as FirmwareRecord[] }
  getFirmware(id: number): FirmwareRecord | undefined { return this.db.prepare('SELECT id, name, version, size, crc32, file_path AS filePath, created_at AS createdAt FROM firmwares WHERE id = ?').get(id) as unknown as FirmwareRecord | undefined }
  createFirmware(name: string, version: string | null, size: number, crc32: number, filePath: string | null): FirmwareRecord {
    const res = this.db.prepare('INSERT INTO firmwares (name, version, size, crc32, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(name, version, size, crc32 >>> 0, filePath, new Date().toISOString())
    return this.getFirmware(Number(res.lastInsertRowid))!
  }
  setFirmwarePath(id: number, filePath: string): void { this.db.prepare('UPDATE firmwares SET file_path = ? WHERE id = ?').run(filePath, id) }
  deleteFirmware(id: number): void { this.db.prepare('DELETE FROM firmwares WHERE id = ?').run(id) }

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
    const vals: unknown[] = []
    for (const [key, col] of Object.entries(mapping)) {
      if (fields[key] !== undefined) { cols.push(`${col} = ?`); vals.push(fields[key]) }
    }
    if (cols.length === 0) return
    vals.push(id)
    this.db.prepare(`UPDATE ${table} SET ${cols.join(', ')} WHERE id = ?`).run(...vals)
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.provide('config', new ConfigStore(config, (scope, id) => ctx.emit('config/changed', { scope, id })))
}
