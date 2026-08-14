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
await ctx.plugin(storePlugin, { dbPath: ':memory:' })
await ctx.plugin(modbusPlugin, {})
await ctx.plugin(pollerPlugin, {})
await ctx.plugin(sinkPlugin)
await ctx.plugin(importerPlugin)
await ctx.plugin(apiPlugin, { host: '127.0.0.1', port: 8080 })

const app = ctx.get('api', false)
let res = await app.inject({ method: 'POST', url: '/api/monitor_objects', payload: { name: '测试', ip: '1.2.3.4', port: 502 } })
const obj = JSON.parse(res.body)

res = await app.inject({ method: 'POST', url: '/api/monitor_objects/' + obj.id + '/groups', payload: { name: '组A', slaveId: 2, functionCode: 3, startAddress: 4096, quantity: 5, pollIntervalMs: 5000 } })
console.log('create group:', res.statusCode, res.body)
const g = JSON.parse(res.body)

res = await app.inject({ method: 'GET', url: '/api/monitor_objects/' + obj.id + '/groups' })
console.log('list groups:', res.statusCode, res.body)

res = await app.inject({ method: 'PUT', url: '/api/groups/' + g.id, payload: { pollIntervalMs: 2000, slaveId: 3 } })
console.log('update group:', res.statusCode, res.body)

res = await app.inject({ method: 'POST', url: '/api/groups/' + g.id + '/toggle-pause' })
console.log('toggle group:', res.statusCode, res.body)

console.log('GROUPS TEST OK')
