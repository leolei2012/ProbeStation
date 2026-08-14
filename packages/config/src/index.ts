import type { Context } from 'cordis'
import z from 'schemastery'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Cordis plugin name. */
export const name = 'config'

export interface Config {
  dbPath: string
}

export const Config: z<Config> = z.object({
  dbPath: z.string(),
})

export interface DeviceRecord {
  id: number
  name: string
  ip: string
  port: number
  mode: string
  isActive: number
}

export interface GroupRecord {
  id: number
  objectId: number
  name: string
  functionCode: number
  startAddress: number
  quantity: number
  mode: string
  isActive: number
}

export interface RegisterRecord {
  id: number
  groupId: number
  objectId: number
  alias: string | null
  functionCode: number
  startAddress: number
  quantity: number
  dataType: string
}

/** Device/register metadata store backed by node:sqlite (synchronous). */
export class ConfigStore {
  private readonly db: DatabaseSync

  constructor(config: Config) {
    if (config.dbPath !== ':memory:') {
      mkdirSync(dirname(config.dbPath), { recursive: true })
    }
    this.db = new DatabaseSync(config.dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitor_objects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        ip TEXT NOT NULL,
        port INTEGER DEFAULT 502,
        mode TEXT DEFAULT 'master',
        is_active INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS register_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        object_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        function_code INTEGER DEFAULT 3,
        start_address INTEGER DEFAULT 0,
        quantity INTEGER DEFAULT 1,
        mode TEXT DEFAULT 'read',
        is_active INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS registers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        object_id INTEGER NOT NULL,
        alias TEXT,
        function_code INTEGER NOT NULL,
        start_address INTEGER NOT NULL,
        quantity INTEGER DEFAULT 1,
        data_type TEXT DEFAULT 'int16'
      );
    `)
  }

  listObjects(): DeviceRecord[] {
    return this.db.prepare(
      'SELECT id, name, ip, port, mode, is_active AS isActive FROM monitor_objects ORDER BY id',
    ).all() as unknown as DeviceRecord[]
  }

  listGroups(objectId: number): GroupRecord[] {
    return this.db.prepare(
      'SELECT id, object_id AS objectId, name, function_code AS functionCode, start_address AS startAddress, quantity, mode, is_active AS isActive FROM register_groups WHERE object_id = ? ORDER BY id',
    ).all(objectId) as unknown as GroupRecord[]
  }

  listRegisters(groupId: number): RegisterRecord[] {
    return this.db.prepare(
      'SELECT id, group_id AS groupId, object_id AS objectId, alias, function_code AS functionCode, start_address AS startAddress, quantity, data_type AS dataType FROM registers WHERE group_id = ? ORDER BY start_address',
    ).all(groupId) as unknown as RegisterRecord[]
  }

  listRegistersByObject(objectId: number): RegisterRecord[] {
    return this.db.prepare(
      'SELECT id, group_id AS groupId, object_id AS objectId, alias, function_code AS functionCode, start_address AS startAddress, quantity, data_type AS dataType FROM registers WHERE object_id = ? ORDER BY start_address',
    ).all(objectId) as unknown as RegisterRecord[]
  }

  createObject(name: string, ip: string, port: number, mode = 'master'): DeviceRecord {
    const res = this.db.prepare('INSERT INTO monitor_objects (name, ip, port, mode) VALUES (?, ?, ?, ?)').run(name, ip, port, mode)
    return { id: Number(res.lastInsertRowid), name, ip, port, mode, isActive: 1 }
  }

  createGroup(objectId: number, name: string, functionCode: number, startAddress: number, quantity: number, mode = 'read'): GroupRecord {
    const res = this.db.prepare('INSERT INTO register_groups (object_id, name, function_code, start_address, quantity, mode) VALUES (?, ?, ?, ?, ?, ?)').run(objectId, name, functionCode, startAddress, quantity, mode)
    return { id: Number(res.lastInsertRowid), objectId, name, functionCode, startAddress, quantity, mode, isActive: 1 }
  }

  createRegister(groupId: number, objectId: number, alias: string | null, functionCode: number, startAddress: number, dataType = 'int16'): RegisterRecord {
    const res = this.db.prepare('INSERT INTO registers (group_id, object_id, alias, function_code, start_address, data_type) VALUES (?, ?, ?, ?, ?, ?)').run(groupId, objectId, alias, functionCode, startAddress, dataType)
    return { id: Number(res.lastInsertRowid), groupId, objectId, alias, functionCode, startAddress, quantity: 1, dataType }
  }
}

/** Provide `ctx.config` (metadata store) to consumers. */
export function apply(ctx: Context, config: Config): void {
  ctx.provide('config', new ConfigStore(config))
}
