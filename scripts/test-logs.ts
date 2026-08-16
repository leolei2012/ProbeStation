import { boot } from './_bootstrap.ts'

const { ctx } = await boot({ api: {}, rule: true })

const cfg = ctx.get('config', false)
const obj = cfg.createObject('模拟器', '127.0.0.1', 8502)
const g = cfg.createGroup(obj.id, 'Holding', 3, 0, 2)
const reg = cfg.createRegister(g.id, obj.id, '温度', 3, 0)
cfg.createRule(reg.id, '>', 100, '温度过高')

ctx.emit('poller/result', { objectId: obj.id, points: [{ objectId: obj.id, address: reg.startAddress, rawValue: 150, quality: 'good', timestamp: new Date().toISOString() }] })
await new Promise((r) => setTimeout(r, 100))

const app = ctx.get('api', false)
const res = await app.inject({ method: 'GET', url: '/api/logs' })
console.log('GET /api/logs:', res.statusCode, res.body)

console.log('LOGS TEST OK')
process.exit(0)
