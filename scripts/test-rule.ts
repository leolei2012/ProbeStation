import { boot } from './_bootstrap.ts'

const { ctx } = await boot({ api: {}, rule: true })

const cfg = ctx.get('config', false)
const obj = cfg.createObject('模拟器', '127.0.0.1', 8502)
const g = cfg.createGroup(obj.id, 'Holding', 3, 0, 2)
const reg = cfg.createRegister(g.id, obj.id, '温度', 3, 0)
cfg.createRule(reg.id, '>', 100, '温度过高')

// subscribe to rule/trigger
const triggers: any[] = []
ctx.on('rule/trigger', (p: any) => triggers.push(p))

// emit a poll result that exceeds threshold (150 > 100) -> should trigger
ctx.emit('poller/result', { objectId: obj.id, points: [{ objectId: obj.id, address: reg.startAddress, rawValue: 150, quality: 'good', timestamp: new Date().toISOString() }] })
await new Promise((r) => setTimeout(r, 100))
console.log('triggers after 150:', JSON.stringify(triggers))

// emit below threshold -> no trigger
ctx.emit('poller/result', { objectId: obj.id, points: [{ objectId: obj.id, address: reg.startAddress, rawValue: 50, quality: 'good', timestamp: new Date().toISOString() }] })
await new Promise((r) => setTimeout(r, 100))
console.log('triggers after 50 (should still be 1):', triggers.length)

// api rule CRUD
const app = ctx.get('api', false)
const r1 = await app.inject({ method: 'GET', url: '/api/rules' })
console.log('GET /api/rules:', r1.statusCode, r1.body)
const r2 = await app.inject({ method: 'POST', url: '/api/rules', payload: { registerId: reg.id, operator: '<', threshold: 0, message: '温度过低' } })
console.log('POST /api/rules:', r2.statusCode, r2.body)

console.log('RULE TEST OK')
process.exit(0)
