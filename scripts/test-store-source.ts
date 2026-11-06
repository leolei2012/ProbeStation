import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DuckDBInstance } from '@duckdb/node-api'
import { DuckDBStore } from '../packages/store/src/index.ts'
import { ensurePollDataSchema } from '../packages/store/src/schema.ts'
import { sourceKey, sourceSample, withRegisterSources } from '../packages/core/src/sample-source.ts'

const dir = mkdtempSync(join(tmpdir(), 'probestation-source-')), start = '2026-11-06T00:00:00Z', end = '2026-11-06T00:00:02Z'
const config = (dbPath: string) => ({ dbPath, flushIntervalMs: 0, flushBatchSize: 10000, retentionSeconds: 0, retentionCheckMs: 0 })
const point = (slaveId?: number | null, rawValue = 5) => ({ objectId: 1, area: 'holding-register' as const, address: 0, timestamp: start, rawValue, quality: 'good', batchId: 'response-' + slaveId, slaveId })
async function close(s: DuckDBStore) { await (s as any).mutations; const conn = await (s as any).ready.catch(() => null); conn?.closeSync(); (s as any).instance?.closeSync() }
const path = join(dir, 'roundtrip.duckdb')
let store = new DuckDBStore(config(path))
try {
  store.write([point(1), point(2, 100)])
  const hot = JSON.parse(JSON.stringify(store.getLatest()))
  assert.equal(sourceSample(hot, 1, 'holding-register', 0, 1)?.rawValue, 5)
  assert.equal(sourceSample(hot, 1, 'holding-register', 0, 2)?.rawValue, 100)
  assert.equal(hot['1:holding-register:0'], undefined, 'ambiguous legacy key must not represent the last slave')
  assert.equal(store.getLatestByObjectAll(1)['holding-register:0'], undefined)
  store.write([point(null, 200)])
  assert.equal(store.getLatest()[sourceKey(1, 'holding-register', 0, null)].rawValue, 200)
  const count = store.getPersistenceStatus().pendingRows
  for (const slaveId of [-1, 256, 1.5, '1']) assert.throws(() => store.write([point(slaveId as any)]), /slaveId/)
  assert.equal(store.getPersistenceStatus().pendingRows, count)
  await store.flush()
} finally { await close(store) }
store = new DuckDBStore(config(path))
try {
  const project = (rows: any[]) => JSON.parse(JSON.stringify(rows)).map((r: any) => [r.slaveId, r.rawValue]).sort((a: any, b: any) => a[1] - b[1])
  const expected = [[1, 5], [2, 100], [null, 200]]
  assert.deepEqual(project(await store.query(1, 0, start, end, 'holding-register')), expected)
  assert.deepEqual(project(await store.queryWithOffset(1, 0, start, end, 'holding-register', 100)), expected)
  assert.deepEqual(project(await store.queryObject(1, start, end)), expected)
  assert.deepEqual(project((await store.queryObjectPage(1, start, end)).points), expected)
  await store.reopen(path)
  assert.deepEqual(project(await store.queryObject(1, start, end)), expected)
} finally { await close(store) }

for (const variant of ['register_id', 'missing-area', 'batch-only', 'source']) {
  const db = await DuckDBInstance.create(join(dir, variant + '.duckdb')), conn = await db.connect()
  try {
    const addr = variant === 'register_id' ? 'register_id' : 'address'
    await conn.run(`CREATE TABLE poll_data (object_id INTEGER, ${addr} INTEGER, ts TIMESTAMP, raw_value DOUBLE, quality VARCHAR${variant === 'batch-only' || variant === 'source' ? ', area VARCHAR, batch_id VARCHAR' : ''}${variant === 'source' ? ', slave_id INTEGER' : ''})`)
    await conn.run(`INSERT INTO poll_data (object_id, ${addr}, ts, raw_value, quality) VALUES (1,0,TIMESTAMP '2026-11-06',7,'good')`)
    await ensurePollDataSchema(conn); await ensurePollDataSchema(conn)
    assert.equal((await conn.runAndReadAll('SELECT slave_id FROM poll_data')).getRowObjects()[0].slave_id, null, 'old rows retain unknown source')
    const col = (await conn.runAndReadAll("PRAGMA table_info('poll_data')")).getRowObjects().find(c => c.name === 'slave_id')!
    assert.equal(col.type, 'INTEGER'); assert.equal(col.notnull, false); assert.equal(col.dflt_value, null)
  } finally { conn.closeSync(); db.closeSync() }
}
for (const type of ['VARCHAR', 'INTEGER NOT NULL', 'INTEGER DEFAULT 1']) {
  const db = await DuckDBInstance.create(':memory:'), conn = await db.connect()
  try {
    await conn.run(`CREATE TABLE poll_data (object_id INTEGER, register_id INTEGER, ts TIMESTAMP, raw_value DOUBLE, quality VARCHAR, slave_id ${type})`)
    await assert.rejects(ensurePollDataSchema(conn), /slave_id/)
    assert.ok((await conn.runAndReadAll("PRAGMA table_info('poll_data')")).getRowObjects().some(c => c.name === 'register_id'), 'migration rollback preserves the old schema')
  } finally { conn.closeSync(); db.closeSync() }
}
const db = await DuckDBInstance.create(':memory:'), conn = await db.connect()
try {
  await conn.run('CREATE TABLE poll_data (object_id INTEGER, register_id INTEGER, ts TIMESTAMP, raw_value DOUBLE, quality VARCHAR)')
  const run = conn.run.bind(conn)
  conn.run = (async (sql: string, ...args: any[]) => { if (sql.includes('ADD COLUMN slave_id')) throw new Error('injected source migration failure'); return (run as any)(sql, ...args) }) as any
  await assert.rejects(ensurePollDataSchema(conn), /injected/)
  conn.run = run
  assert.ok(!(await conn.runAndReadAll("PRAGMA table_info('poll_data')")).getRowObjects().some(c => c.name === 'batch_id'))
} finally { conn.closeSync(); db.closeSync() }
console.log('STORE SOURCE OK: source-scoped hot keys, ambiguous legacy removal, raw/JSON/reopen identity, old NULL migration and schema failure rollback')
