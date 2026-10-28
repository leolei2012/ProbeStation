import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { DuckDBStore, type PollPoint } from '../packages/store/src/index.ts'
import { ensurePollDataSchema } from '../packages/store/src/schema.ts'

// Only synthetic data in a newly created temporary directory; never bootstrap the app.
const dir = mkdtempSync(join(tmpdir(), 'probestation-store-batch-'))
const config = (dbPath: string) => ({ dbPath, flushIntervalMs: 0, flushBatchSize: 10000, retentionSeconds: 0, retentionCheckMs: 0 })
const start = '2026-01-01T00:00:00Z', end = '2026-01-02T00:00:00Z'
const point = (batchId?: string | null, rawValue = 123): PollPoint => ({ objectId: 1, area: 'holding-register', address: 0, timestamp: start, rawValue, quality: 'good', batchId })
async function close(store: DuckDBStore) {
  await (store as any).mutations
  const conn = await (store as any).ready.catch(() => null)
  conn?.closeSync(); (store as any).instance?.closeSync()
}
async function withDb(path: string, action: (conn: DuckDBConnection) => Promise<void>) {
  const db = await DuckDBInstance.create(path), conn = await db.connect()
  try { await action(conn) } finally { conn.closeSync(); db.closeSync() }
}
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value))

for (const variant of ['register_id', 'missing-area', 'current', 'migrated', 'new']) {
  const path = join(dir, variant + '.duckdb')
  if (variant !== 'new') await withDb(path, async conn => {
    const address = variant === 'register_id' ? 'register_id' : 'address'
    const area = ['current', 'migrated'].includes(variant) ? ", area VARCHAR DEFAULT 'holding-register'" : ''
    await conn.run(`CREATE TABLE poll_data (object_id INTEGER, ${address} INTEGER, ts TIMESTAMP, raw_value DOUBLE, quality VARCHAR${area}${variant === 'migrated' ? ', batch_id VARCHAR' : ''})`)
    await conn.run(`INSERT INTO poll_data (object_id, ${address}, ts, raw_value, quality) VALUES (1, 0, CAST(? AS TIMESTAMP), 123, 'good')`, [start])
    if (variant === 'migrated') await conn.run("UPDATE poll_data SET batch_id = 'existing-response'")
    if (variant === 'current') await conn.run("UPDATE poll_data SET area = 'input-register'")
  })
  const store = new DuckDBStore(config(path))
  try {
    for (let opening = 0; opening < 3; opening++) {
      if (opening) await store.reopen(path)
      const rows = await store.query(1, 0, start, end, variant === 'current' ? 'input-register' : 'holding-register')
      assert.equal(rows.length, variant === 'new' ? 0 : 1)
      if (rows.length) {
        assert.equal(rows[0].rawValue, 123); assert.equal(rows[0].quality, 'good')
        assert.equal(Date.parse(rows[0].ts), Date.parse(start))
        assert.equal(rows[0].batchId, variant === 'migrated' ? 'existing-response' : null)
      }
      const conn = await (store as any).ready as DuckDBConnection
      const cols = (await conn.runAndReadAll("PRAGMA table_info('poll_data')")).getRowObjects()
      const batch = cols.find(c => c.name === 'batch_id')!
      assert.equal(batch.type, 'VARCHAR'); assert.equal(batch.notnull, false); assert.equal(batch.dflt_value, null)
      assert.ok(cols.some(c => c.name === 'address')); assert.ok(!cols.some(c => c.name === 'register_id'))
    }
  } finally { await close(store) }
}

// Same timestamp, distinct responses; quotes/Unicode are bound, never interpolated.
const path = join(dir, 'roundtrip.duckdb')
const ids = ['response-A', 'response-B', "响应'); DROP TABLE poll_data; --", '', null, undefined]
let store = new DuckDBStore(config(path))
try {
  store.write(ids.map((id, i) => ({ ...point(id, i), quality: "good's quality" })))
  await store.flush()
} finally { await close(store) }
store = new DuckDBStore(config(path))
try {
  const expected = ids.map((id, i) => ({ rawValue: i, batchId: id ?? null, quality: "good's quality" }))
  const project = (rows: Array<{ rawValue: number; batchId: string | null; quality: string }>) => json(rows).map(({ rawValue, batchId, quality }) => ({ rawValue, batchId, quality })).sort((a, b) => a.rawValue - b.rawValue)
  assert.deepEqual(project(await store.query(1, 0, start, end, 'holding-register')), expected)
  const offsetRows = await store.queryWithOffset(1, 0, start, end, 'holding-register', 100)
  assert.deepEqual(project(offsetRows), expected)
  assert.ok(offsetRows.every(r => r.timestampMs === Date.parse(start)))
  assert.equal((await store.queryWithOffset(1, 0, start, end, 'holding-register', 2, 4)).length, 2)
  assert.deepEqual(project(await store.queryObject(1, start, end)), expected)
  const page = await store.queryObjectPage(1, start, end, 0, 1)
  assert.deepEqual(project(page.points), expected)
  assert.equal(page.total, 1); assert.equal(page.hasMore, false)
  assert.equal((await store.queryObjectPage(1, start, end, 1, 1)).points.length, 0)
} finally { await close(store) }

for (const batch of ['INTEGER', 'VARCHAR NOT NULL', "VARCHAR DEFAULT 'invented'"]) {
  const path = join(dir, `invalid-${batch.split(' ')[0]}-${batch.length}.duckdb`)
  await withDb(path, async conn => {
    await conn.run(`CREATE TABLE poll_data (object_id INTEGER, register_id INTEGER, ts TIMESTAMP, raw_value DOUBLE, quality VARCHAR, batch_id ${batch})`)
    await conn.run(`INSERT INTO poll_data VALUES (1, 0, CAST(? AS TIMESTAMP), 123, 'good', ?)`, [start, batch === 'INTEGER' ? 7 : 'original'])
  })
  const errors: Error[] = []
  const failed = new DuckDBStore(config(path), undefined, e => errors.push(e))
  failed.write([point('pending-before-init')])
  await assert.rejects(failed.flush(), /batch_id/)
  assert.equal(failed.getPersistenceStatus().pendingRows, 1)
  assert.match(failed.getPersistenceStatus().error!, /batch_id/)
  assert.throws(() => failed.write([point('blocked')]), /batch_id/)
  await assert.rejects(failed.query(1, 0, start, end, 'holding-register'), /batch_id/)
  assert.ok(errors.length > 0)
  await withDb(path, async conn => {
    const cols = (await conn.runAndReadAll("PRAGMA table_info('poll_data')")).getRowObjects()
    assert.ok(cols.some(c => c.name === 'register_id')); assert.ok(!cols.some(c => c.name === 'area'))
    assert.deepEqual((await conn.runAndReadAll('SELECT raw_value FROM poll_data')).getRowObjects().map(r => r.raw_value), [123])
  })
}

await withDb(join(dir, 'ddl-failure.duckdb'), async conn => {
  await conn.run('CREATE TABLE poll_data (object_id INTEGER, register_id INTEGER, ts TIMESTAMP, raw_value DOUBLE, quality VARCHAR)')
  await conn.run("INSERT INTO poll_data VALUES (1, 0, TIMESTAMP '2026-01-01', 123, 'good')")
  const run = conn.run.bind(conn)
  conn.run = (async (sql, ...args: any[]) => {
    if (sql.includes('ADD COLUMN batch_id')) throw new Error('injected migration write failure')
    return (run as any)(sql, ...args)
  }) as typeof conn.run
  await assert.rejects(ensurePollDataSchema(conn), /injected migration write failure/)
  conn.run = run
  const cols = (await conn.runAndReadAll("PRAGMA table_info('poll_data')")).getRowObjects()
  assert.ok(cols.some(c => c.name === 'register_id')); assert.ok(!cols.some(c => c.name === 'area'))
  await ensurePollDataSchema(conn); await ensurePollDataSchema(conn)
  assert.equal(Number((await conn.runAndReadAll('SELECT COUNT(*) AS c FROM poll_data')).getRowObjects()[0].c), 1)
})

// A later chunk failure rolls back the whole flush, retaining new arrivals too.
store = new DuckDBStore(config(join(dir, 'write-failure.duckdb')))
try {
  const conn = await (store as any).ready as DuckDBConnection
  await (store as any).mutations
  const instance = (store as any).instance as DuckDBInstance
  const connect = instance.connect.bind(instance)
  let inserts = 0
  instance.connect = async () => {
    const writer = await connect(), run = writer.run.bind(writer)
    writer.run = (async (sql, ...args: any[]) => {
      if (sql.startsWith('INSERT INTO poll_data') && ++inserts === 2) {
        // Independent readers cannot see the uncommitted first chunk.
        assert.equal(Number((await conn.runAndReadAll('SELECT COUNT(*) AS c FROM poll_data')).getRowObjects()[0].c), 0)
        if (!(store as any).switching) store.write([point('arrived-during-flush', 501)])
        else assert.throws(() => store.write([point('blocked-switch')]), /reopening/)
        throw new Error('injected second chunk failure')
      }
      return (run as any)(sql, ...args)
    }) as typeof writer.run
    return writer
  }
  store.write(Array.from({ length: 501 }, (_, i) => point('retry-' + i, i)))
  await assert.rejects(store.flush(), /injected second chunk failure/)
  assert.equal(store.getPersistenceStatus().pendingRows, 502)
  assert.match(store.getPersistenceStatus().error!, /injected/)
  assert.equal((await store.queryObject(1, start, end)).length, 0)
  inserts = 0
  await assert.rejects(store.reopen(join(dir, 'must-not-switch.duckdb')), /injected/)
  assert.equal((store as any).dbPath, join(dir, 'write-failure.duckdb'))
  instance.connect = connect
  const pending = store.getPersistenceStatus().pendingRows
  await Promise.all([store.flush(), store.flush()])
  assert.deepEqual(store.getPersistenceStatus(), { pendingRows: 0, error: null })
  assert.equal((await store.queryObject(1, start, end)).length, pending)
  await store.reopen(join(dir, 'write-failure.duckdb'))
  assert.equal((await store.queryObject(1, start, end)).length, pending)
} finally { await close(store) }

const errors: Error[] = []
store = new DuckDBStore({ ...config(join(dir, 'auto-failure.duckdb')), flushBatchSize: 1 }, undefined, e => errors.push(e))
try {
  const conn = await (store as any).ready as DuckDBConnection
  await (store as any).mutations
  const instance = (store as any).instance as DuckDBInstance
  const connect = instance.connect.bind(instance)
  instance.connect = async () => {
    const writer = await connect(), run = writer.run.bind(writer)
    writer.run = (async (sql, ...args: any[]) => {
      if (sql.startsWith('INSERT INTO poll_data')) throw new Error('injected auto flush failure')
      return (run as any)(sql, ...args)
    }) as typeof writer.run
    return writer
  }
  store.write([point('auto-retry')])
  await (store as any).mutations
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(errors.length, 1); assert.equal(store.getPersistenceStatus().pendingRows, 1)
  instance.connect = connect
  await store.flush()
  assert.equal((await store.query(1, 0, start, end, 'holding-register'))[0].batchId, 'auto-retry')
} finally { await close(store) }

// Initialization failure must also reject flush with no queued points.
const emptyFailure = new DuckDBStore(config(join(dir, 'invalid-INTEGER-7.duckdb')), undefined, () => {})
await assert.rejects(emptyFailure.flush(), /batch_id/)
assert.equal(emptyFailure.getPersistenceStatus().pendingRows, 0)
console.log('STORE BATCH TEST OK: migrations, reopen, JSON/raw queries, rollback and retry (temporary databases only)')
