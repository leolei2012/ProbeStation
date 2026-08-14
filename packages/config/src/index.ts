import type { Context } from 'cordis'
import z from 'schemastery'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'config'

export interface Config { dbPath: string }
export const Config: z<Config> = z.object({ dbPath: z.string() })

export interface DeviceRecord { id: number; name: string; ip: string; port: number; mode: string; isActive: number }
export interface GroupRecord { id: number; objectId: number; name: string; slaveId: number; functionCode: number; startAddress: number; quantity: number; pollIntervalMs: number; mode: string; isActive: number }
export interface RegisterRecord { id: number; groupId: number; objectId: number; alias: string | null; functionCode: number; startAddress: number; quantity: number; dataType: string }
export interface RuleRecord { id: number; registerId: number; operator: string; threshold: number; message: string | null }
export interface LogRecord { id: number; ts: string; level: string; source: string | null; message: string | null }

const OBJECT_SELECT = 'SELECT id, name, ip, port, mode, is_active AS isActive FROM monitor_objects'
const GROUP_SELECT = 'SELECT id, object_id AS objectId, name, slave_id AS slaveId, function_code AS functionCode, start_address AS startAddress, quantity, poll_interval_ms AS pollIntervalMs, mode, is_active AS isActive FROM register_groups'
const REGISTER_SELECT = 'SELECT id, group_id AS groupId, object_id AS objectId, alias, function_code AS functionCode, start_address AS startAddress, quantity, data_type AS dataType FROM registers'

const OBJECT_MAP: Record<string, string> = { name: 'name', ip: 'ip', port: 'port', mode: 'mode', isActive: 'is_active' }
const GROUP_MAP: Record<string, string> = { name: 'name', slaveId: 'slave_id', functionCode: 'function_code', startAddress: 'start_address', quantity: 'quantity', pollIntervalMs: 'poll_interval_ms', mode: 'mode', isActive: 'is_active' }
const REGISTER_MAP: Record<string, string> = { alias: 'alias', functionCode: 'function_code', startAddress: 'start_address', dataType: 'data_type' }

export class ConfigStore {
  private readonly db: DatabaseSync

  constructor(config: Config) {
    if (config.dbPath !== ':memory:') mkdirSync(dirname(config.dbPath), { recursive: true })
    this.db = new DatabaseSync(config.dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_objects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, ip TEXT NOT NULL, port INTEGER DEFAULT 502,
        mode TEXT DEFAULT 'master', is_active INTEGER DEFAULT 1
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
        quantity INTEGER DEFAULT 1, data_type TEXT DEFAULT 'int16'
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
    `)
  }

  listObjects(): DeviceRecord[] { return this.db.prepare(OBJECT_SELECT + ' ORDER BY id').all() as unknown as DeviceRecord[] }
  getObject(id: number): DeviceRecord | undefined { return this.db.prepare(OBJECT_SELECT + ' WHERE id = ?').get(id) as unknown as DeviceRecord | undefined }
  createObject(name: string, ip: string, port: number, mode = 'master'): DeviceRecord {
    const res = this.db.prepare('INSERT INTO monitor_objects (name, ip, port, mode) VALUES (?, ?, ?, ?)').run(name, ip, port, mode)
    return this.getObject(Number(res.lastInsertRowid))!
  }
  updateObject(id: number, fields: Record<string, unknown>): DeviceRecord | undefined { this.update('monitor_objects', id, fields, OBJECT_MAP); return this.getObject(id) }
  deleteObject(id: number): void {
    this.db.prepare('DELETE FROM registers WHERE object_id = ?').run(id)
    this.db.prepare('DELETE FROM register_groups WHERE object_id = ?').run(id)
    this.db.prepare('DELETE FROM monitor_objects WHERE id = ?').run(id)
  }
  toggleObject(id: number): DeviceRecord | undefined { this.db.prepare('UPDATE monitor_objects SET is_active = 1 - is_active WHERE id = ?').run(id); return this.getObject(id) }

  listGroups(objectId: number): GroupRecord[] { return this.db.prepare(GROUP_SELECT + ' WHERE object_id = ? ORDER BY id').all(objectId) as unknown as GroupRecord[] }
  getGroup(id: number): GroupRecord | undefined { return this.db.prepare(GROUP_SELECT + ' WHERE id = ?').get(id) as unknown as GroupRecord | undefined }
  createGroup(objectId: number, name: string, functionCode: number, startAddress: number, quantity: number, mode = 'read', slaveId = 1, pollIntervalMs = 1000): GroupRecord {
    const res = this.db.prepare('INSERT INTO register_groups (object_id, name, slave_id, function_code, start_address, quantity, poll_interval_ms, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(objectId, name, slaveId, functionCode, startAddress, quantity, pollIntervalMs, mode)
    return this.getGroup(Number(res.lastInsertRowid))!
  }
  updateGroup(id: number, fields: Record<string, unknown>): GroupRecord | undefined { this.update('register_groups', id, fields, GROUP_MAP); return this.getGroup(id) }
  deleteGroup(id: number): void {
    this.db.prepare('DELETE FROM registers WHERE group_id = ?').run(id)
    this.db.prepare('DELETE FROM register_groups WHERE id = ?').run(id)
  }
  toggleGroup(id: number): GroupRecord | undefined { this.db.prepare('UPDATE register_groups SET is_active = 1 - is_active WHERE id = ?').run(id); return this.getGroup(id) }

  listRegisters(groupId: number): RegisterRecord[] { return this.db.prepare(REGISTER_SELECT + ' WHERE group_id = ? ORDER BY start_address').all(groupId) as unknown as RegisterRecord[] }
  listRegistersByObject(objectId: number): RegisterRecord[] { return this.db.prepare(REGISTER_SELECT + ' WHERE object_id = ? ORDER BY start_address').all(objectId) as unknown as RegisterRecord[] }
  getRegister(id: number): RegisterRecord | undefined { return this.db.prepare(REGISTER_SELECT + ' WHERE id = ?').get(id) as unknown as RegisterRecord | undefined }
  createRegister(groupId: number, objectId: number, alias: string | null, functionCode: number, startAddress: number, dataType = 'int16'): RegisterRecord {
    const res = this.db.prepare('INSERT INTO registers (group_id, object_id, alias, function_code, start_address, data_type) VALUES (?, ?, ?, ?, ?, ?)').run(groupId, objectId, alias, functionCode, startAddress, dataType)
    return this.getRegister(Number(res.lastInsertRowid))!
  }
  updateRegister(id: number, fields: Record<string, unknown>): RegisterRecord | undefined { this.update('registers', id, fields, REGISTER_MAP); return this.getRegister(id) }
  deleteRegister(id: number): void { this.db.prepare('DELETE FROM registers WHERE id = ?').run(id) }

  listRules(): RuleRecord[] { return this.db.prepare('SELECT id, register_id AS registerId, operator, threshold, message FROM alarm_rules ORDER BY id').all() as unknown as RuleRecord[] }
  createRule(registerId: number, operator: string, threshold: number, message: string | null): RuleRecord {
    const res = this.db.prepare('INSERT INTO alarm_rules (register_id, operator, threshold, message) VALUES (?, ?, ?, ?)').run(registerId, operator, threshold, message)
    return this.db.prepare('SELECT id, register_id AS registerId, operator, threshold, message FROM alarm_rules WHERE id = ?').get(Number(res.lastInsertRowid)) as unknown as RuleRecord
  }
  deleteRule(id: number): void { this.db.prepare('DELETE FROM alarm_rules WHERE id = ?').run(id) }

  log(level: string, source: string, message: string): void { this.db.prepare('INSERT INTO logs (ts, level, source, message) VALUES (?, ?, ?, ?)').run(new Date().toISOString(), level, source, message) }
  listLogs(limit = 100): LogRecord[] { return this.db.prepare('SELECT id, ts, level, source, message FROM logs ORDER BY id DESC LIMIT ?').all(limit) as unknown as LogRecord[] }
  clearLogs(): void { this.db.prepare('DELETE FROM logs').run() }

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

export function apply(ctx: Context, config: Config): void { ctx.provide('config', new ConfigStore(config)) }
