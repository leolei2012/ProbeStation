import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { ConfigStore } from '../packages/config/src/index.ts'
import { withRegisterSources } from '../packages/core/src/sample-source.ts'

let changes = 0
const cfg = new ConfigStore({ dbPath: ':memory:' }, () => { changes++ })
const create = (store: ConfigStore) => {
  const device = store.createObject('synthetic', 'mock.invalid', 1502, 'master', { slaveId: 9, pollIntervalMs: 777, timeoutMs: 4321 })
  const first = store.createGroup(device.id, 'first', 3, 0, 8, 'read', 1), second = store.createGroup(device.id, 'second', 4, 0, 8, 'read', 2)
  store.createGroup(device.id, 'empty', 3, 20, 1, 'read', 3)
  const point = store.createRegister(first.id, device.id, 'same alias', 3, 0, 'uint64-LE')
  store.updateRegister(point.id, { factor: 0, offset: -2, unit: 'unit', enumJson: '{"9007199254740993":"precise"}', decimalPlaces: null })
  ;(store as any).db.prepare('UPDATE registers SET quantity = 2 WHERE id = ?').run(point.id)
  store.createRegister(second.id, device.id, 'same alias', 4, 0, 'uint32')
  return { device, first, point }
}
try {
  const { device, first, point } = create(cfg)
  const unrelated = cfg.createObject('unrelated', 'other.mock.invalid', 502), unrelatedGroup = cfg.createGroup(unrelated.id, 'other', 3, 0, 1)
  cfg.createRegister(unrelatedGroup.id, unrelated.id, 'must not appear', 3, 0, 'uint16')
  const before = changes, snapshot = cfg.getHistoryExportConfiguration(device.id)
  assert.equal(snapshot.version, 1); assert.equal(typeof snapshot.configurationScope, 'string'); assert(snapshot.configurationScope.length > 0)
  assert.deepEqual(snapshot.device, { ...cfg.getObject(device.id)! }); assert.deepEqual(snapshot.groups, cfg.listGroups(device.id).map(row => ({ ...row }))); assert.deepEqual(snapshot.registers, cfg.listRegistersByObject(device.id).map(row => ({ ...row }))); assert.equal(changes, before)
  assert(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.device) && Object.isFrozen(snapshot.groups) && Object.isFrozen(snapshot.registers)); assert(snapshot.groups.every(Object.isFrozen) && snapshot.registers.every(Object.isFrozen))
  assert.equal(snapshot.registers[0].quantity, 2); assert.equal(snapshot.registers[0].factor, 0); assert.equal(snapshot.registers[0].enumJson, '{"9007199254740993":"precise"}'); assert.equal(snapshot.registers[0].decimalPlaces, null)
  assert.deepEqual(withRegisterSources([...snapshot.registers], [...snapshot.groups], snapshot.device).map(row => row.slaveId), [1, 2])
  const frozen = JSON.stringify(snapshot)
  cfg.updateObject(device.id, { ip: 'changed.mock.invalid' }); cfg.updateGroup(first.id, { slaveId: 4 }); cfg.updateRegister(point.id, { alias: 'after', dataType: 'uint32' })
  assert.equal(JSON.stringify(snapshot), frozen); const fresh = cfg.getHistoryExportConfiguration(device.id)
  assert.equal(fresh.configurationScope, snapshot.configurationScope, 'scope identifies the open configuration lifetime, not each mutation'); assert.equal(fresh.device.ip, 'changed.mock.invalid'); assert.equal(fresh.registers[0].alias, 'after')
  for (const id of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) assert.throws(() => cfg.getHistoryExportConfiguration(id as number), error => (error as any).statusCode === 400)
  assert.throws(() => cfg.getHistoryExportConfiguration(999), error => (error as any).statusCode === 404); assert.equal(cfg.getHistoryExportConfiguration(device.id).device.id, device.id, 'missing device rolls back')
  ;(cfg as any).restoring = true; assert.throws(() => cfg.getHistoryExportConfiguration(device.id), error => (error as any).statusCode === 409); (cfg as any).restoring = false
  const db = (cfg as any).db, prepare = db.prepare.bind(db), exec = db.exec.bind(db)
  exec('BEGIN'); assert.throws(() => cfg.getHistoryExportConfiguration(device.id)); exec('ROLLBACK')
  assert.equal(cfg.getHistoryExportConfiguration(device.id).configurationScope, fresh.configurationScope, 'a failed BEGIN must not roll back a caller-owned transaction')
  db.prepare = (sql: string) => { if (sql.includes('FROM registers')) throw new Error('mock read failure'); return prepare(sql) }
  assert.throws(() => cfg.getHistoryExportConfiguration(device.id), /mock read failure/); db.prepare = prepare
  assert.equal(cfg.getHistoryExportConfiguration(device.id).configurationScope, fresh.configurationScope)
  db.exec = (sql: string) => { if (sql === 'COMMIT') throw new Error('mock commit failure'); return exec(sql) }
  assert.throws(() => cfg.getHistoryExportConfiguration(device.id), /mock commit failure/); db.exec = exec
  assert.equal(cfg.getHistoryExportConfiguration(device.id).configurationScope, fresh.configurationScope, 'successful rollback permits another independent read')
  db.prepare = () => { throw new Error('mock read failure') }; db.exec = (sql: string) => { if (sql === 'ROLLBACK') throw new Error('mock rollback failure'); return exec(sql) }
  assert.throws(() => cfg.getHistoryExportConfiguration(device.id), AggregateError); db.prepare = prepare; db.exec = exec
  assert.throws(() => cfg.getHistoryExportConfiguration(device.id), error => (error as any).statusCode === 409, 'uncertain rollback blocks new snapshots')
  cfg.reopen(':memory:'); const recreated = create(cfg), reopened = cfg.getHistoryExportConfiguration(recreated.device.id)
  assert.notEqual(reopened.configurationScope, snapshot.configurationScope); assert.equal(reopened.device.id, snapshot.device.id)
  const large = cfg.createGroup(recreated.device.id, 'large', 3, 100, 10000)
  const insert = (cfg as any).db.prepare('INSERT INTO registers (group_id, object_id, alias, function_code, start_address, data_type) VALUES (?, ?, ?, ?, ?, ?)')
  ;(cfg as any).db.exec('BEGIN')
  try { for (let i = 0; i < 10000; i++) insert.run(large.id, recreated.device.id, 'tail-' + i, 3, 100 + i, 'uint16'); (cfg as any).db.exec('COMMIT') } catch (error) { (cfg as any).db.exec('ROLLBACK'); throw error }
  const all = cfg.getHistoryExportConfiguration(recreated.device.id); assert.equal(all.registers.length, 10002); assert.equal(all.registers.at(-1)!.alias, 'tail-9999'); assert(Object.isFrozen(all.registers.at(-1)!))
} finally { (cfg as any).db.close() }

// Real concurrent writer commits during the reader's transaction, only in new temporary WAL databases.
const parent = resolve(tmpdir()), scratch = mkdtempSync(join(parent, 'probe-export-snapshot-'))
let reader: ConfigStore | undefined, writer: ConfigStore | undefined
try {
  const path = join(scratch, 'configuration.db'); reader = new ConfigStore({ dbPath: path }); (reader as any).db.exec('PRAGMA journal_mode=WAL')
  const { device, first, point } = create(reader); writer = new ConfigStore({ dbPath: path })
  const old = reader.getHistoryExportConfiguration(device.id), db = (reader as any).db, prepare = db.prepare.bind(db); let committed = false
  db.prepare = (sql: string) => {
    if (!committed && sql.includes('FROM register_groups')) {
      committed = true; writer!.updateObject(device.id, { ip: 'writer.mock.invalid' }); writer!.updateGroup(first.id, { slaveId: 8 }); writer!.updateRegister(point.id, { alias: 'writer' })
    }
    return prepare(sql)
  }
  const during = reader.getHistoryExportConfiguration(device.id); db.prepare = prepare
  assert(committed); assert.deepEqual(during, old, 'device, groups and points all belong to the first SQLite read snapshot, not a mixed graph')
  const next = reader.getHistoryExportConfiguration(device.id)
  assert.equal(next.device.ip, 'writer.mock.invalid'); assert.equal(next.groups[0].slaveId, 8); assert.equal(next.registers[0].alias, 'writer'); assert.equal(next.configurationScope, old.configurationScope)
  assert.notEqual(writer.getHistoryExportConfiguration(device.id).configurationScope, next.configurationScope, 'another ConfigStore lifetime is distinct even on the same file')
} finally {
  if (reader) (reader as any).db.close(); if (writer) (writer as any).db.close()
  assert.equal(dirname(resolve(scratch)), parent); assert(basename(scratch).startsWith('probe-export-snapshot-')); rmSync(scratch, { recursive: true, force: true })
}
console.log('EXPORT CONFIG SNAPSHOT OK: immutable scoped whole-device graph/10000-point tail, empty groups/overlapping source IDs, exact metadata and no notifications, scope lifetime not revision, invalid/missing/busy/nested/read/commit/rollback recovery, and real temporary WAL concurrent writer coherence; no API/store/history/driver/model or real user data')
