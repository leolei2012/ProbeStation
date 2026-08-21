import { boot } from './_bootstrap.ts'

const { ctx } = await boot({ api: {} })

// seed metadata
const cfg = ctx.get('config', false)
const obj = cfg.createObject('雪融机', '192.168.90.32', 8899)
const group = cfg.createGroup(obj.id, 'Holding Registers', 3, 0, 5)
const reg = cfg.createRegister(group.id, obj.id, '电源开关', 3, 0)

// write one sample (simulating a poll result)
const store = ctx.get('store', false)
store.write([
  { objectId: obj.id, area: 'holding-register', address: reg.startAddress, timestamp: new Date().toISOString(), rawValue: 1234, quality: 'good' },
])
await store.flush()

// exercise REST via Fastify inject (no port binding)
const app = ctx.get('api', false)
for (const url of [
  '/health',
  '/api/monitor_objects',
  `/api/monitor_objects/${obj.id}/groups`,
  `/api/groups/${group.id}/registers`,
  `/api/monitor_objects/${obj.id}/latest`,
  `/api/monitor_objects/${obj.id}/diagnostics`,
  `/api/monitor_objects/${obj.id}/frames?limit=20`,
  `/api/data/query?object_id=${obj.id}&area=holding-register&address=${reg.startAddress}&start=2000-01-01T00:00:00Z&end=2100-01-01T00:00:00Z`,
]) {
  const res = await app.inject({ method: 'GET', url })
  console.log(`GET ${url}  -> ${res.statusCode}  ${res.body}`)
}
const clearRes = await app.inject({ method: 'POST', url: `/api/monitor_objects/${obj.id}/frames/clear` })
if (clearRes.statusCode !== 200 || clearRes.json().ok !== true) throw new Error('diagnostics clear endpoint failed: ' + clearRes.body)
const missingArea = await app.inject({ method: 'GET', url: `/api/data/query?object_id=${obj.id}&address=0&start=2000-01-01T00:00:00Z&end=2100-01-01T00:00:00Z` })
if (missingArea.statusCode !== 400) throw new Error('area must be required: ' + missingArea.body)
console.log('API TEST OK')
process.exit(0)
