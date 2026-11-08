import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import Schema from 'schemastery'
import { ConfigStore } from '../packages/config/src/index.ts'
import { parseConfigBackup } from '../packages/config/src/backup.ts'
import { Config as StoreConfig, DuckDBStore } from '../packages/store/src/index.ts'

// All files are created here. No CLI, device plugin, existing database or external input.
const dir = mkdtempSync(join(tmpdir(), 'probestation-backup-retention-'))
const now = Date.parse('2026-11-08T12:00:00Z'), savedNow = Date.now
const start = '2020-01-01T00:00:00Z', end = '2027-01-01T00:00:00Z'
const errors: unknown[] = []; let passed = 0
Date.now = () => now
async function check(name: string, action: () => Promise<void>) {
  try { await action(); passed++; console.log('BACKUP RETENTION OK:', name) }
  catch (error) { errors.push(error); console.error('BACKUP RETENTION FAILED:', name, error) }
}
function settings(dbPath: string, retentionSeconds = 0): StoreConfig {
  return { dbPath, retentionSeconds, flushIntervalMs: 0, flushBatchSize: 1000, retentionCheckMs: 0 }
}
async function settled(store: DuckDBStore) { await (store as any).ready; await Promise.resolve(); await (store as any).mutations }
async function withDb(path: string, action: (conn: DuckDBConnection) => Promise<void>) {
  const db = await DuckDBInstance.create(path), conn = await db.connect()
  try { await action(conn) } finally { conn.closeSync(); db.closeSync() }
}
const graph = (cfg: ConfigStore) => { const { createdAt, ...data } = cfg.exportBackup(); return JSON.stringify(data) }
async function legacyHistory(path: string, objectId = 1) {
  await withDb(path, async conn => {
    await conn.run('CREATE TABLE poll_data (object_id INTEGER, register_id INTEGER, ts TIMESTAMP, raw_value DOUBLE, quality VARCHAR)')
    for (const [age, value] of [[2592001, 1], [2592000, 2], [2591999, 3]]) {
      await conn.run("INSERT INTO poll_data VALUES (?, 0, CAST(? AS TIMESTAMP), ?, 'good')", [objectId, new Date(now - age * 1000).toISOString(), value])
    }
  })
}
try {
  await check('valid restored retention above Date range does not abort cleanup or skip other devices/global policy', async () => {
    const source = new ConfigStore({ dbPath: ':memory:' }), cfg = new ConfigStore({ dbPath: ':memory:' })
    const reported: Error[] = []; let store: DuckDBStore | undefined
    try {
      cfg.createObject('existing global policy', 'mock.invalid', 502)
      for (const seconds of [60, Number.MAX_SAFE_INTEGER, 0, null]) source.createObject('synthetic restored ' + seconds, 'mock.invalid', 502, 'master', { dataRetainSeconds: seconds })
      const backup = parseConfigBackup(JSON.parse(JSON.stringify(source.exportBackup())))
      const restored = cfg.restoreBackup(backup)
      assert(restored.deviceIds.every(id => cfg.getObject(id)!.isActive === 0))
      assert.deepEqual(restored.deviceIds.map(id => cfg.getObject(id)!.dataRetainSeconds), [60, Number.MAX_SAFE_INTEGER, 0, null])
      const path = join(dir, 'long-retention.duckdb')
      await withDb(path, async conn => {
        await conn.run('CREATE TABLE poll_data (object_id INTEGER, address INTEGER, ts TIMESTAMP, raw_value DOUBLE, quality VARCHAR)')
        for (const id of [1, ...restored.deviceIds]) {
          await conn.run("INSERT INTO poll_data VALUES (?, 0, TIMESTAMP '2026-01-01', 99, 'good')", [id])
        }
      })
      store = new DuckDBStore(settings(path, 120), cfg, error => reported.push(error))
      await settled(store)
      await store.cleanup() // Public retry must also succeed; constructor reports via onError.
      assert.deepEqual(reported, [])
      assert.equal((await store.queryObject(1, start, end)).length, 0, 'global cleanup must not be skipped after a long device override')
      for (const [i, expected] of [0, 1, 1, 0].entries()) assert.equal((await store.queryObject(restored.deviceIds[i], start, end)).length, expected)
    } finally { await store?.close(); await cfg.close(); await source.close() }
  })

  await check('huge global duration preserves finite history and positive infinity; negative infinity still expires', async () => {
    const path = join(dir, 'huge-global.duckdb')
    await withDb(path, async conn => {
      await conn.run('CREATE TABLE poll_data (object_id INTEGER, address INTEGER, ts TIMESTAMP, raw_value DOUBLE, quality VARCHAR)')
      await conn.run("INSERT INTO poll_data VALUES (1, 0, TIMESTAMP '2026-01-01', 1, 'good'), (1, 0, TIMESTAMP '-infinity', 2, 'good'), (1, 0, TIMESTAMP 'infinity', 3, 'good')")
    })
    const store = new DuckDBStore(settings(path, Number.MAX_SAFE_INTEGER), undefined, () => {})
    try {
      await settled(store); await store.cleanup()
      store.setRetentionSeconds(Number.MAX_VALUE); await (store as any).mutations; await store.cleanup()
      assert.equal(store.getRetentionSeconds(), Number.MAX_VALUE, 'native timestamp bounds must not rewrite the configured duration')
    } finally { await store.close() }
    await withDb(path, async conn => assert.deepEqual((await conn.runAndReadAll('SELECT raw_value FROM poll_data ORDER BY raw_value')).getRowObjects().map(row => row.raw_value), [1, 3]))
  })

  await check('cutoff outside Date range still compares exact native microseconds without a double rounding boundary', async () => {
    const path = join(dir, 'native-range.duckdb'), seconds = now / 1000 + 8640000000001
    const cutoff = BigInt(now) * 1000n - BigInt(seconds) * 1000000n
    assert(Number.isNaN(new Date(now - seconds * 1000).getTime()))
    await withDb(path, async conn => {
      await conn.run('CREATE TABLE poll_data (object_id INTEGER, address INTEGER, ts TIMESTAMP, raw_value DOUBLE, quality VARCHAR)')
      for (const [i, delta] of [-1n, 0n, 1n].entries()) await conn.run("INSERT INTO poll_data VALUES (1, 0, make_timestamp(CAST(? AS BIGINT)), ?, 'good')", [(cutoff + delta).toString(), i + 1])
    })
    const store = new DuckDBStore(settings(path, seconds), undefined, () => {})
    try { await settled(store); await store.cleanup() } finally { await store.close() }
    await withDb(path, async conn => assert.deepEqual((await conn.runAndReadAll('SELECT raw_value FROM poll_data ORDER BY raw_value')).getRowObjects().map(row => row.raw_value), [2, 3]))
  })

  await check('JSON restore failure/rollback does not change retention, history or trigger cleanup; explicit later restore remaps IDs', async () => {
    const source = new ConfigStore({ dbPath: ':memory:' }), cfg = new ConfigStore({ dbPath: ':memory:' })
    const path = join(dir, 'failed-restore.duckdb'), store = new DuckDBStore(settings(path), cfg)
    try {
      const original = cfg.createObject('existing permanent', 'mock.invalid', 502, 'master', { dataRetainSeconds: 0 })
      const d = source.createObject('restored short', 'mock.invalid', 502, 'master', { dataRetainSeconds: 1 })
      const g = source.createGroup(d.id, 'group', 3, 0, 1), r = source.createRegister(g.id, d.id, 'point', 3, 0)
      source.createRule(r.id, '>', 1, 'synthetic')
      await settled(store)
      store.write([{ objectId: original.id, area: 'holding-register', address: 0, timestamp: '2026-01-01T00:00:00Z', rawValue: 8, quality: 'good' }]); await store.flush()
      const before = graph(cfg), rows = await store.queryObject(original.id, start, end), cleanup = store.cleanup.bind(store)
      let cleanups = 0; store.cleanup = async () => { cleanups++; await cleanup() }
      const backup = JSON.parse(JSON.stringify(source.exportBackup())), bad = structuredClone(backup); bad.rules[0].message = 'x'.repeat(201)
      assert.throws(() => cfg.restoreBackup(bad))
      assert.equal(graph(cfg), before); assert.deepEqual(await store.queryObject(original.id, start, end), rows); assert.equal(cleanups, 0)
      const db = (cfg as any).db, exec = db.exec.bind(db), failure = new Error('synthetic restore commit failure')
      db.exec = (sql: string) => { if (sql === 'COMMIT') throw failure; return exec(sql) }
      try { assert.throws(() => cfg.restoreBackup(backup), error => error === failure) } finally { db.exec = exec }
      assert.equal(graph(cfg), before); assert.deepEqual(await store.queryObject(original.id, start, end), rows)
      const restored = cfg.restoreBackup(backup)
      assert.notEqual(restored.deviceIds[0], original.id); assert.equal(cfg.getObject(original.id)!.dataRetainSeconds, 0)
      assert.equal(cfg.getObject(restored.deviceIds[0])!.isActive, 0)
      assert.equal((await store.queryObject(restored.deviceIds[0], start, end)).length, 0, 'configuration backup contains no history')
      await store.cleanup(); assert.deepEqual(await store.queryObject(original.id, start, end), rows)
    } finally { await store.close(); await cfg.close(); await source.close() }
  })

  await check('closed paired backup recovery restores deleted rows, but JSON/global runtime setting alone does not', async () => {
    const configPath = join(dir, 'recover-config.db'), historyPath = join(dir, 'recover-poll.duckdb')
    let cfg = new ConfigStore({ dbPath: configPath })
    cfg.createObject('synthetic inherit', 'mock.invalid', 502); const backup = cfg.exportBackup(); await cfg.close()
    await legacyHistory(historyPath)
    copyFileSync(configPath, configPath + '.before'); copyFileSync(historyPath, historyPath + '.before')
    cfg = new ConfigStore({ dbPath: configPath })
    let store = new DuckDBStore(settings(historyPath, 2592000), cfg)
    try {
      await settled(store); assert.deepEqual((await store.queryObject(1, start, end)).map(row => row.rawValue), [2, 3])
      store.setRetentionSeconds(0); await (store as any).mutations
      const restored = cfg.restoreBackup(backup)
      assert.equal((await store.queryObject(restored.deviceIds[0], start, end)).length, 0)
      assert.deepEqual((await store.queryObject(1, start, end)).map(row => row.rawValue), [2, 3], 'JSON restore and longer retention cannot resurrect deleted samples')
      assert.equal(Object.hasOwn(backup, 'retentionSeconds'), false)
    } finally { await store.close(); await cfg.close() }
    // Both files are owned, synthetic and fully closed; no live-copy claim.
    copyFileSync(configPath + '.before', configPath); copyFileSync(historyPath + '.before', historyPath)
    cfg = new ConfigStore({ dbPath: configPath }); store = new DuckDBStore(settings(historyPath), cfg)
    try { await settled(store); assert.deepEqual((await store.queryObject(1, start, end)).map(row => row.rawValue), [1, 2, 3]) }
    finally { await store.close(); await cfg.close() }
    cfg = new ConfigStore({ dbPath: configPath })
    const defaults: StoreConfig = Schema.resolve({ dbPath: historyPath, flushIntervalMs: 0, retentionCheckMs: 0 }, StoreConfig, {})[0]
    store = new DuckDBStore(defaults, cfg)
    try { await settled(store); assert.equal(store.getRetentionSeconds(), 2592000); assert.deepEqual((await store.queryObject(1, start, end)).map(row => row.rawValue), [2, 3]) }
    finally { await store.close(); await cfg.close() }
  })

  await check('native microsecond cutoff is strict; global permanent does not override an explicit paused device policy', async () => {
    const cfg = new ConfigStore({ dbPath: ':memory:' }), path = join(dir, 'precise.duckdb')
    const device = cfg.createObject('paused short policy', 'mock.invalid', 502, 'master', { dataRetainSeconds: 60 })
    cfg.updateObject(device.id, { isActive: 0 })
    await withDb(path, async conn => {
      await conn.run('CREATE TABLE poll_data (object_id INTEGER, address INTEGER, ts TIMESTAMP, raw_value DOUBLE, quality VARCHAR)')
      await conn.run("INSERT INTO poll_data VALUES (1, 0, TIMESTAMP '2026-11-08 11:59:00' - INTERVAL '1 microsecond', 1, 'good'), (1, 0, TIMESTAMP '2026-11-08 11:59:00', 2, 'good'), (1, 0, TIMESTAMP '2026-11-08 11:59:00' + INTERVAL '1 microsecond', 3, 'good')")
    })
    const store = new DuckDBStore(settings(path), cfg)
    try { await settled(store); assert.deepEqual((await store.queryObject(1, start, end)).map(row => row.rawValue), [2, 3]) }
    finally { await store.close(); await cfg.close() }
  })
} finally {
  Date.now = savedNow
  const inside = relative(realpathSync(tmpdir()), realpathSync(dir))
  assert(inside && inside.startsWith('probestation-backup-retention-') && !inside.startsWith('..') && !inside.includes(':'))
  rmSync(dir, { recursive: true, force: true })
}
if (errors.length) throw new AggregateError(errors, `${errors.length} backup/retention cases failed; ${passed} passed`)
console.log(`BACKUP RETENTION TEST OK: ${passed} synthetic cases, no real data/devices/application startup`)
