import { DuckDBStore } from '../packages/store/src/index.ts'

const store = new DuckDBStore({ dbPath: ':memory:', flushIntervalMs: 5000, flushBatchSize: 2 })

const now = new Date().toISOString()
store.write([
  { objectId: 9, area: 'holding-register', address: 470, timestamp: now, rawValue: 1234, quality: 'good' },
  { objectId: 9, area: 'holding-register', address: 471, timestamp: now, rawValue: -15, quality: 'good' },
])
console.log('latest:', JSON.stringify(store.getLatest()))

await store.flush()

const rows = await store.query(9, 470, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z', 'holding-register')
console.log('query 470:', JSON.stringify(rows))

// 多设备同地址不冲突：objectId 不同则热层键不同
store.write([
  { objectId: 1, area: 'holding-register', address: 0, timestamp: now, rawValue: 100, quality: 'good' },
  { objectId: 2, area: 'holding-register', address: 0, timestamp: now, rawValue: 200, quality: 'good' },
])
console.log('getLatestByObject(1)[0] =', store.getLatestByObject(1, 'holding-register')[0]?.rawValue, '(expect 100)')
console.log('getLatestByObject(2)[0] =', store.getLatestByObject(2, 'holding-register')[0]?.rawValue, '(expect 200)')
const keys = Object.keys(store.getLatest()).filter(k => /:holding-register:0$/.test(k))
console.log('复合键数量(地址0) =', keys.length, '(expect 2)')

// 同设备四数据区同地址不冲突；旧 getLatestByObject 仍只返回 holding-register。
store.write([
  { objectId: 1, area: 'coil', address: 0, timestamp: now, rawValue: 1, quality: 'good' },
  { objectId: 1, area: 'discrete-input', address: 0, timestamp: now, rawValue: 0, quality: 'good' },
  { objectId: 1, area: 'input-register', address: 0, timestamp: now, rawValue: 300, quality: 'good' },
])
await store.flush()
const all = store.getLatestByObjectAll(1)
const coilRows = await store.query(1, 0, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z', 'coil')
const holdingRows = await store.query(1, 0, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z', 'holding-register')
const isolated = all['coil:0']?.rawValue === 1 && all['discrete-input:0']?.rawValue === 0 && all['input-register:0']?.rawValue === 300 && all['holding-register:0']?.rawValue === 100 && coilRows[0]?.rawValue === 1 && holdingRows[0]?.rawValue === 100
const ok = store.getLatestByObject(1, 'holding-register')[0]?.rawValue === 100 && store.getLatestByObject(2, 'holding-register')[0]?.rawValue === 200 && keys.length === 2 && isolated
console.log(ok ? 'STORE TEST OK' : 'STORE TEST FAIL')
process.exit(ok ? 0 : 1)
