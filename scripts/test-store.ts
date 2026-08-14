import { DuckDBStore } from '../packages/store/src/index.ts'

const store = new DuckDBStore({ dbPath: ':memory:', flushIntervalMs: 5000, flushBatchSize: 2 })

const now = new Date().toISOString()
store.write([
  { objectId: 9, registerId: 470, timestamp: now, rawValue: 1234, quality: 'good' },
  { objectId: 9, registerId: 471, timestamp: now, rawValue: -15, quality: 'good' },
])
console.log('latest:', JSON.stringify(store.getLatest()))

await store.flush()

const rows = await store.query(9, 470, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')
console.log('query 470:', JSON.stringify(rows))
console.log('STORE TEST OK')
