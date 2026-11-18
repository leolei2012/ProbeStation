import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import Schema from 'schemastery'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { ConfigStore } from '../packages/config/src/index.ts'
import { Config as StoreConfig, DuckDBStore } from '../packages/store/src/index.ts'

// Synthetic schemas checked against 3d8cdbe (first config store) and 9827971
// (group slave/interval fields). Never import the CLI or accept an existing DB path.
const dir = mkdtempSync(join(tmpdir(), 'probestation-upgrade-'))
const failures: unknown[] = []
let passed = 0
const start = '2026-01-01T00:00:00Z', end = '2026-01-02T00:00:00Z', future = '2027-01-01T00:00:00Z'
async function check(name: string, action: () => Promise<void>) {
  try { await action(); passed++; console.log('UPGRADE OK:', name) }
  catch (error) { failures.push(error); console.error('UPGRADE FAILED:', name, error) }
}
function legacyConfig(path: string, groupFields = false) {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE monitor_objects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        ip TEXT NOT NULL, port INTEGER DEFAULT 502, mode TEXT DEFAULT 'master', is_active INTEGER DEFAULT 1);
      CREATE TABLE register_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, object_id INTEGER NOT NULL,
        name TEXT NOT NULL, ${groupFields ? 'slave_id INTEGER DEFAULT 1, poll_interval_ms INTEGER DEFAULT 1000,' : ''}
        function_code INTEGER DEFAULT 3, start_address INTEGER DEFAULT 0, quantity INTEGER DEFAULT 1,
        mode TEXT DEFAULT 'read', is_active INTEGER DEFAULT 1);
      CREATE TABLE registers (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL,
        object_id INTEGER NOT NULL, alias TEXT, function_code INTEGER NOT NULL, start_address INTEGER NOT NULL,
        quantity INTEGER DEFAULT 1, data_type TEXT DEFAULT 'int16');
      INSERT INTO monitor_objects VALUES (11, 'synthetic legacy', 'mock.invalid', 1502, 'master', 0);
      INSERT INTO register_groups (id, object_id, name, start_address, quantity) VALUES (21, 11, 'legacy group', 8, 4);
      INSERT INTO registers VALUES (31, 21, 11, 'legacy point', 3, 8, 4, 'uint32');
    `)
    if (groupFields) db.exec('UPDATE register_groups SET slave_id = 7, poll_interval_ms = 4321')
  } finally { db.close() }
}
function snapshot(path: string) {
  const db = new DatabaseSync(path)
  try {
    const schema = db.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all()
    return JSON.stringify({
      schema,
      rows: schema.filter(row => String(row.sql).startsWith('CREATE TABLE') && !String(row.name).startsWith('sqlite_'))
        .map(row => {
          const table = '"' + String(row.name).replaceAll('"', '""') + '"'
          const columns = db.prepare(`PRAGMA table_info(${table})`).all()
          const primary = columns.filter(column => Number(column.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk))
          const order = (primary.length ? primary : columns).map(column => '"' + String(column.name).replaceAll('"', '""') + '"').join(',')
          return [row.name, db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()]
        }),
    })
  } finally { db.close() }
}
async function configFault(path: string, fail: (sql: string) => unknown) {
  const exec = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close
  let store: ConfigStore | undefined, caught: unknown, closed = 0
  DatabaseSync.prototype.exec = function (sql) {
    const error = fail(sql)
    if (error) throw error
    return exec.call(this, sql)
  }
  DatabaseSync.prototype.close = function () { closed++; return close.call(this) }
  try { store = new ConfigStore({ dbPath: path }) } catch (error) { caught = error }
  finally { DatabaseSync.prototype.exec = exec; DatabaseSync.prototype.close = close }
  if (store) await store.close()
  return { caught, closed }
}

try {
  await check('earliest config: missing group slave field, repeated full close/open, defaults and original IDs', async () => {
    const path = join(dir, 'first-config.db'); legacyConfig(path)
    let expected: string | undefined
    for (let opening = 0; opening < 3; opening++) {
      const cfg = new ConfigStore({ dbPath: path })
      try {
        const device = cfg.getObject(11)!, group = cfg.listGroups(11)[0], point = cfg.listRegisters(21)[0]
        assert.equal(device.name, 'synthetic legacy'); assert.equal(device.port, 1502); assert.equal(device.isActive, 0)
        assert.equal(device.pollIntervalMs, 1000); assert.equal(device.dataRetainSeconds, null)
        assert.equal(device.transport, 'tcp'); assert.equal(device.baudRate, 9600)
        assert.equal(group.id, 21); assert.equal(group.slaveId, 1)
        assert.equal(point.id, 31); assert.equal(point.quantity, 4); assert.equal(point.dataType, 'uint32')
        assert.equal(point.factor, 1); assert.equal(point.offset, 0); assert.equal(point.decimalPlaces, null)
        assert.equal(cfg.exportBackup().registers[0].alias, 'legacy point')
      } finally { await cfg.close() }
      const current = snapshot(path)
      if (expected) assert.equal(current, expected, 'repeated startup does not rewrite schema or original rows')
      expected = current
    }
  })

  for (const step of ['ADD COLUMN baud_rate', 'ADD COLUMN decimal_places', 'DROP COLUMN poll_interval_ms', 'COMMIT']) {
    await check('config migration rollback on ' + step, async () => {
      const path = join(dir, 'failure-' + step.split(' ').at(-1) + '.db'); legacyConfig(path, true)
      const before = snapshot(path), original = new Error('synthetic migration failure: ' + step)
      const result = await configFault(path, sql => sql.includes(step) && original)
      assert.equal(result.caught, original, 'migration failure must reach the caller with its original identity')
      assert.equal(result.closed, 1, 'failed initialization closes its SQLite handle')
      assert.equal(snapshot(path), before, 'all DDL and data roll back, including tables created during open')
      const recovered = new ConfigStore({ dbPath: path })
      try { assert.equal(recovered.getGroup(21)!.slaveId, 7); assert.equal(recovered.listRegisters(21).length, 1) }
      finally { await recovered.close() }
    })
  }
  await check('config rollback failure retains both errors and closes connection; retry remains possible', async () => {
    const path = join(dir, 'rollback-error.db'); legacyConfig(path, true)
    const before = snapshot(path), original = new Error('synthetic DDL failure'), rollback = new Error('synthetic rollback failure')
    const result = await configFault(path, sql => sql.includes('ADD COLUMN baud_rate') ? original : sql === 'ROLLBACK' ? rollback : null)
    assert(result.caught instanceof AggregateError)
    assert.deepEqual(result.caught.errors, [original, rollback]); assert.equal(result.closed, 1)
    assert.equal(snapshot(path), before, 'native close rolls back the still-open transaction in this controlled case')
    const cfg = new ConfigStore({ dbPath: path }); await cfg.close()
  })
  await check('config BEGIN failure does not attempt rollback or mutate the old database', async () => {
    const path = join(dir, 'begin-error.db'); legacyConfig(path)
    const before = snapshot(path), original = new Error('synthetic begin failure'); let rollbacks = 0
    const result = await configFault(path, sql => {
      if (sql === 'ROLLBACK') rollbacks++
      return sql === 'BEGIN IMMEDIATE' ? original : null
    })
    assert.equal(result.caught, original); assert.equal(rollbacks, 0); assert.equal(snapshot(path), before)
  })
  await check('actual SQLite writer contention fails closed without rolling back another connection', async () => {
    const path = join(dir, 'locked.db'); legacyConfig(path)
    const before = snapshot(path), owner = new DatabaseSync(path)
    try {
      owner.exec('BEGIN IMMEDIATE'); owner.prepare('UPDATE monitor_objects SET name = ?').run('outer pending')
      assert.throws(() => new ConfigStore({ dbPath: path }), /locked/)
      assert.equal(owner.prepare('SELECT name FROM monitor_objects').get()!.name, 'outer pending')
      owner.exec('ROLLBACK'); assert.equal(snapshot(path), before)
    } finally { owner.close() }
    const retry = new ConfigStore({ dbPath: path }); await retry.close()
  })
  await check('actual unsupported legacy DROP dependency aborts the entire config upgrade', async () => {
    const path = join(dir, 'drop-index.db'); legacyConfig(path, true)
    const db = new DatabaseSync(path)
    try { db.exec('CREATE INDEX synthetic_interval_dependency ON register_groups(poll_interval_ms)') }
    finally { db.close() }
    const before = snapshot(path)
    assert.throws(() => new ConfigStore({ dbPath: path }), /synthetic_interval_dependency/)
    assert.equal(snapshot(path), before, 'do not silently discard an unknown dependency or leave earlier ALTERs committed')
  })
  await check('existing current configuration values survive startup; no ALTER on subsequent startup', async () => {
    const path = join(dir, 'current.db')
    const cfg = new ConfigStore({ dbPath: path })
    const device = cfg.createObject('synthetic RTU metadata only', 'mock.invalid', 502, 'master', { transport: 'rtu', serialPath: 'SYNTHETIC-NOT-OPENED', baudRate: 19200, parity: 'odd', slaveId: 9, dataRetainSeconds: 0 })
    const group = cfg.createGroup(device.id, 'group', 4, 8, 4, 'read', 9)
    const point = cfg.createRegister(group.id, device.id, 'zero factor', 4, 8, 'uint32')
    cfg.updateRegister(point.id, { factor: 0, offset: -2, decimalPlaces: 3 })
    cfg.createRule(point.id, '>', 5, 'synthetic alarm'); await cfg.close()
    const before = snapshot(path), alters: string[] = [], exec = DatabaseSync.prototype.exec
    DatabaseSync.prototype.exec = function (sql) { if (/^ALTER TABLE/.test(sql)) alters.push(sql); return exec.call(this, sql) }
    let reopened: ConfigStore | undefined
    try { reopened = new ConfigStore({ dbPath: path }); assert.equal(reopened.getRegister(point.id)!.factor, 0); assert.equal(reopened.listRules().length, 1) }
    finally { DatabaseSync.prototype.exec = exec; await reopened?.close() }
    assert.deepEqual(alters, []); assert.equal(snapshot(path), before)
  })

  // Fully closed, synthetic paired files only; copying a live pair is NOT tested or recommended.
  await check('synthetic pre-upgrade backup restore, history identity preservation and old-reader compatibility limits', async () => {
    const configPath = join(dir, 'pair-config.db'), historyPath = join(dir, 'pair-poll.duckdb')
    legacyConfig(configPath, true)
    await withHistory(historyPath, async conn => {
      await conn.run('CREATE TABLE poll_data (object_id INTEGER, register_id INTEGER, ts TIMESTAMP, raw_value DOUBLE, quality VARCHAR)')
      await conn.run("INSERT INTO poll_data VALUES (11, 8, TIMESTAMP '2026-01-01', 1, 'good'), (11, 9, TIMESTAMP '2026-01-01', 0, 'good')")
    })
    const configBefore = snapshot(configPath)
    copyFileSync(configPath, configPath + '.before'); copyFileSync(historyPath, historyPath + '.before')
    for (let opening = 0; opening < 3; opening++) {
      const cfg = new ConfigStore({ dbPath: configPath }), store = new DuckDBStore(storeConfig(historyPath), cfg)
      try {
        await startupCleanupSettled(store)
        const rows = await store.queryObject(11, start, end)
        assert.equal(rows.filter(row => row.batchId === null && row.slaveId === null).length, 2)
        assert.equal(rows[0].rawValue, 1); assert.equal(rows[1].rawValue, 0)
        const curve = (await store.queryRegisterCurve(11, start, end, [{ id: 31, functionCode: 3, startAddress: 8, dataType: 'uint32', slaveId: 7 }])).series[0]
        assert.equal(curve.samples[0][1], 65536); assert.equal(curve.integrity.unverified, 1); assert.equal(curve.integrity.verified, opening ? 1 : 0)
        if (!opening) {
          store.write([8, 9].map(address => ({ objectId: 11, area: 'holding-register' as const, address, timestamp: '2026-01-01T00:00:01Z', rawValue: 1, quality: 'good', batchId: 'synthetic-response', slaveId: 7 })))
          await store.flush()
        }
        const all = await store.queryObject(11, start, end)
        assert.equal(all.length, 4)
        assert.deepEqual((await store.queryObjectPage(11, start, end)).points, all)
        assert.equal((await store.query(11, 8, start, end, 'holding-register')).length, 2)
        assert.equal((await store.queryWithOffset(11, 8, start, end, 'holding-register', 10)).length, 2)
        assert.equal(JSON.parse(JSON.stringify(all))[2].batchId, 'synthetic-response')
      } finally { await store.close(); await cfg.close() }
    }
    // Explicit old SELECTs, not old application startup (which could open devices).
    const old = new DatabaseSync(configPath)
    try {
      assert.equal(old.prepare('SELECT name FROM monitor_objects WHERE id=11').get()!.name, 'synthetic legacy')
      assert.throws(() => old.prepare('SELECT poll_interval_ms FROM register_groups').all(), /no such column/)
    } finally { old.close() }
    await withHistory(historyPath, async conn => {
      assert.equal((await conn.runAndReadAll('SELECT address, raw_value FROM poll_data')).getRowObjects().length, 4)
      await assert.rejects(conn.run('SELECT register_id FROM poll_data'), /register_id/)
    })
    copyFileSync(configPath + '.before', configPath); copyFileSync(historyPath + '.before', historyPath)
    assert.equal(snapshot(configPath), configBefore)
    await withHistory(historyPath, async conn => {
      assert.equal((await conn.runAndReadAll('SELECT register_id, raw_value FROM poll_data')).getRowObjects().length, 2)
    })
    const cfg = new ConfigStore({ dbPath: configPath }), store = new DuckDBStore(storeConfig(historyPath), cfg)
    try { assert.equal((await store.queryObject(11, start, end)).length, 2) }
    finally { await store.close(); await cfg.close() }
  })

  await check('failed history migration skips startup cleanup, preserves queued samples and releases native file locks', async () => {
    const path = join(dir, 'history-failure.duckdb')
    await withHistory(path, async conn => {
      await conn.run('CREATE TABLE poll_data (object_id INTEGER, register_id INTEGER, ts TIMESTAMP, raw_value DOUBLE, quality VARCHAR, batch_id INTEGER)')
      await conn.run("INSERT INTO poll_data VALUES (11, 8, TIMESTAMP '2020-01-01', 123, 'good', 7)")
    })
    const errors: Error[] = []
    const store = new DuckDBStore(defaultStoreConfig(path), undefined, error => errors.push(error))
    const pending = { objectId: 11, area: 'holding-register' as const, address: 8, timestamp: start, rawValue: 5, quality: 'good', batchId: 'pending', slaveId: 7 }
    store.write([pending])
    try {
      await assert.rejects(store.flush(), /batch_id/)
      await assert.rejects(store.queryObject(11, start, end), /batch_id/)
      const status = store.getSamplePersistenceStatus(); assert(status.available)
      assert.equal(status.phase, 'blocked'); assert.equal(status.failure, 'initialization-failed')
      assert.deepEqual(store.getPendingPoints(), [pending])
    } finally {
      const closing = store.close(); assert.equal(store.close(), closing)
      await assert.rejects(closing, /batch_id/)
    }
    assert.deepEqual(store.getPendingPoints(), [pending]); assert(errors.length > 0)
    await withHistory(path, async conn => {
      const columns = (await conn.runAndReadAll("PRAGMA table_info('poll_data')")).getRowObjects()
      assert(columns.some(row => row.name === 'register_id')); assert(!columns.some(row => row.name === 'area'))
      assert(!columns.some(row => row.name === 'slave_id'))
      const rows = (await conn.runAndReadAll('SELECT * FROM poll_data')).getRowObjects()
      assert.equal(rows.length, 1); assert.equal(rows[0].raw_value, 123); assert.equal(rows[0].batch_id, 7)
    })
  })

  await check('startup retention: default 30 days, exact cutoff, permanent/device overrides, repeat startup and zero preservation', async () => {
    const path = join(dir, 'retention.duckdb'), now = Date.parse('2026-11-08T12:00:00Z')
    const cfg = new ConfigStore({ dbPath: ':memory:' })
    cfg.createObject('global', 'mock.invalid', 502)
    cfg.createObject('forever', 'mock.invalid', 502, 'master', { dataRetainSeconds: 0 })
    cfg.createObject('one hour', 'mock.invalid', 502, 'master', { dataRetainSeconds: 3600 })
    await withHistory(path, async conn => {
      await conn.run('CREATE TABLE poll_data (object_id INTEGER, address INTEGER, ts TIMESTAMP, raw_value DOUBLE, quality VARCHAR)')
      for (const [objectId, ages] of [[1, [2592001, 2592000, 2591999]], [2, [2592001]], [3, [3601, 3600]]] as const) {
        for (const age of ages) await conn.run("INSERT INTO poll_data VALUES (?, 0, CAST(? AS TIMESTAMP), ?, 'good')", [objectId, new Date(now - age * 1000).toISOString(), age])
      }
    })
    const savedNow = Date.now; Date.now = () => now
    try {
      const keep = new DuckDBStore(storeConfig(path))
      try { await startupCleanupSettled(keep); assert.equal((await keep.queryObject(1, start, future)).length, 3) }
      finally { await keep.close() }
      for (let opening = 0; opening < 2; opening++) {
        // Actual schema defaults, with only timers disabled. retentionCheckMs=0 still cleans at startup.
        const defaults = defaultStoreConfig(path)
        assert.equal(defaults.retentionSeconds, 2592000)
        const store = new DuckDBStore(defaults, cfg)
        try {
          await startupCleanupSettled(store)
          assert.deepEqual((await store.queryObject(1, start, future)).map(row => row.rawValue), [2592000, 2591999])
          assert.equal((await store.queryObject(2, start, future)).length, 1)
          assert.deepEqual((await store.queryObject(3, start, future)).map(row => row.rawValue), [3600])
          assert((await store.queryObject(1, start, future)).every(row => row.batchId === null && row.slaveId === null))
        } finally { await store.close() }
      }
    } finally { Date.now = savedNow; await cfg.close() }
  })
} finally {
  const inside = relative(realpathSync(tmpdir()), realpathSync(dir))
  assert(inside && !inside.startsWith('..') && !inside.includes(':') && inside.startsWith('probestation-upgrade-'))
  rmSync(dir, { recursive: true, force: true })
}
if (failures.length) throw new AggregateError(failures, `${failures.length} synthetic database upgrade cases failed; ${passed} passed`)
console.log(`DATABASE UPGRADE TEST OK: ${passed} cases, synthetic files only, real main/signals unchanged`)

function storeConfig(dbPath: string) { return { dbPath, flushIntervalMs: 0, flushBatchSize: 10000, retentionSeconds: 0, retentionCheckMs: 0 } }
function defaultStoreConfig(dbPath: string): StoreConfig {
  return Schema.resolve({ dbPath, flushIntervalMs: 0, retentionCheckMs: 0 }, StoreConfig, {})[0]
}
async function withHistory(path: string, action: (conn: DuckDBConnection) => Promise<void>) {
  const db = await DuckDBInstance.create(path), conn = await db.connect()
  try { await action(conn) } finally { conn.closeSync(); db.closeSync() }
}
async function startupCleanupSettled(store: DuckDBStore) {
  await (store as any).ready
  // The constructor schedules cleanup from ready.then; yield to that reaction, then drain its mutation.
  await Promise.resolve(); await (store as any).mutations
}
