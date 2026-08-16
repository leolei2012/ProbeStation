import { DuckDBStore } from '../packages/store/src/index.ts'

const store = new DuckDBStore({ dbPath: ':memory:', flushIntervalMs: 5000, flushBatchSize: 2 })

const now = new Date().toISOString()
store.write([
  { objectId: 9, address: 470, timestamp: now, rawValue: 1234, quality: 'good' },
  { objectId: 9, address: 471, timestamp: now, rawValue: -15, quality: 'good' },
])
console.log('latest:', JSON.stringify(store.getLatest()))

await store.flush()

const rows = await store.query(9, 470, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')
console.log('query 470:', JSON.stringify(rows))

// 多设备同地址不冲突：objectId 不同则热层键不同
store.write([
  { objectId: 1, address: 0, timestamp: now, rawValue: 100, quality: 'good' },
  { objectId: 2, address: 0, timestamp: now, rawValue: 200, quality: 'good' },
])
console.log('getLatestByObject(1)[0] =', store.getLatestByObject(1)[0]?.rawValue, '(expect 100)')
console.log('getLatestByObject(2)[0] =', store.getLatestByObject(2)[0]?.rawValue, '(expect 200)')
const keys = Object.keys(store.getLatest()).filter(k => k.endsWith(':0'))
console.log('复合键数量(地址0) =', keys.length, '(expect 2)')

const ok = store.getLatestByObject(1)[0]?.rawValue === 100 && store.getLatestByObject(2)[0]?.rawValue === 200 && keys.length === 2
console.log(ok ? 'STORE TEST OK' : 'STORE TEST FAIL')
process.exit(ok ? 0 : 1)
