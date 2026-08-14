import { boot } from './_bootstrap.ts'

const { ctx } = await boot({ api: {} })

const cfg = ctx.get('config', false)
const obj = cfg.createObject('模拟器', '127.0.0.1', 8502)
const g = cfg.createGroup(obj.id, 'Holding', 3, 0, 2)
const r1 = cfg.createRegister(g.id, obj.id, '温度', 3, 0)
const r2 = cfg.createRegister(g.id, obj.id, '转速', 3, 1)

const store = ctx.get('store', false)
const t1 = '2026-08-14T10:00:00Z'
const t2 = '2026-08-14T10:00:01Z'
store.write([
  { objectId: obj.id, registerId: r1.id, timestamp: t1, rawValue: 100, quality: 'good' },
  { objectId: obj.id, registerId: r2.id, timestamp: t1, rawValue: 800, quality: 'good' },
  { objectId: obj.id, registerId: r1.id, timestamp: t2, rawValue: 101, quality: 'good' },
  { objectId: obj.id, registerId: r2.id, timestamp: t2, rawValue: 801, quality: 'good' },
])
await store.flush()

const app = ctx.get('api', false)
const res = await app.inject({ method: 'GET', url: `/api/export/csv?object_id=${obj.id}&start=2000-01-01T00:00:00Z&end=2100-01-01T00:00:00Z` })
console.log('CSV', res.statusCode, '\n' + res.body)

const resX = await app.inject({ method: 'GET', url: `/api/export/xlsx?object_id=${obj.id}&start=2000-01-01T00:00:00Z&end=2100-01-01T00:00:00Z` })
console.log('XLSX', resX.statusCode, 'bytes:', (resX.rawPayload as Buffer).length)

console.log('SINK TEST OK')
process.exit(0)
