import { Context } from 'cordis'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as modbusPlugin from '../packages/modbus/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'
import * as sinkPlugin from '../packages/sink/src/index.ts'
import * as importerPlugin from '../packages/importer/src/index.ts'
import * as apiPlugin from '../packages/api/src/index.ts'

const ctx = new Context()
await ctx.plugin(configPlugin, { dbPath: ':memory:' })
await ctx.plugin(storePlugin, { dbPath: ':memory:', flushIntervalMs: 5000, flushBatchSize: 100 })
await ctx.plugin(modbusPlugin, { defaultTimeoutMs: 2000, defaultUnitId: 1 })
await ctx.plugin(pollerPlugin, { pollIntervalMs: 1000 })
await ctx.plugin(sinkPlugin)
await ctx.plugin(importerPlugin)
await ctx.plugin(apiPlugin, { host: '0.0.0.0', port: 8080 })

// seed metadata
const cfg = ctx.get('config', false)
const obj = cfg.createObject('雪融机', '192.168.90.32', 8899)
const group = cfg.createGroup(obj.id, 'Holding Registers', 3, 0, 5)
const reg = cfg.createRegister(group.id, obj.id, '电源开关', 3, 0)

// write one sample (simulating a poll result)
const store = ctx.get('store', false)
store.write([
  { objectId: obj.id, registerId: reg.id, timestamp: new Date().toISOString(), rawValue: 1234, quality: 'good' },
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
  `/api/data/query?object_id=${obj.id}&register_id=${reg.id}&start=2000-01-01T00:00:00Z&end=2100-01-01T00:00:00Z`,
]) {
  const res = await app.inject({ method: 'GET', url })
  console.log(`GET ${url}  -> ${res.statusCode}  ${res.body}`)
}
console.log('API TEST OK')
process.exit(0)
