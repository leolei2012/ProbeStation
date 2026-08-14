import { Context } from 'cordis'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as modbusPlugin from '../packages/modbus/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'
import * as sinkPlugin from '../packages/sink/src/index.ts'
import * as rulePlugin from '../packages/rule/src/index.ts'
import * as apiPlugin from '../packages/api/src/index.ts'

const ctx = new Context()
await ctx.plugin(configPlugin, { dbPath: ':memory:' })
await ctx.plugin(storePlugin, { dbPath: ':memory:' })
await ctx.plugin(modbusPlugin, {})
await ctx.plugin(pollerPlugin, {})
await ctx.plugin(sinkPlugin)
await ctx.plugin(rulePlugin)
await ctx.plugin(apiPlugin, { host: '127.0.0.1', port: 8080 })

const cfg = ctx.get('config', false)
const obj = cfg.createObject('模拟器', '127.0.0.1', 8502)
const g = cfg.createGroup(obj.id, 'Holding', 3, 0, 2)
const reg = cfg.createRegister(g.id, obj.id, '温度', 3, 0)
cfg.createRule(reg.id, '>', 100, '温度过高')

ctx.emit('poller/result', { objectId: obj.id, points: [{ objectId: obj.id, registerId: reg.id, rawValue: 150, quality: 'good', timestamp: new Date().toISOString() }] })
await new Promise((r) => setTimeout(r, 100))

const app = ctx.get('api', false)
const res = await app.inject({ method: 'GET', url: '/api/logs' })
console.log('GET /api/logs:', res.statusCode, res.body)

console.log('LOGS TEST OK')
