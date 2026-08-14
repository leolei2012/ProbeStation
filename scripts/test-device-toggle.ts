import { boot } from './_bootstrap.ts'

const { ctx } = await boot({ slave: 18502 })
const cfg = ctx.get('config', false)
const slave = ctx.get('slave', false)
const poller = ctx.get('poller', false)
const store = ctx.get('store', false)

const obj = cfg.createObject('模拟器', '127.0.0.1', 18502)
const g = cfg.createGroup(obj.id, 'g', 3, 0, 1)
const reg = cfg.createRegister(g.id, obj.id, 'r', 3, 0)

slave.setRegister(0, 100)
poller.startAll()
await new Promise(r => setTimeout(r, 800))
console.log('latest after start:', store.getLatest()[reg.id]?.rawValue)

cfg.toggleObject(obj.id)  // isActive 1 -> 0（断开）
slave.setRegister(0, 999)
await new Promise(r => setTimeout(r, 1500))
const v = store.getLatest()[reg.id]?.rawValue
console.log('latest after disconnect:', v, '(expect 100，不应更新为 999)')
poller.stopAll()
const ok = v === 100
console.log(ok ? 'DEVICE TOGGLE OK' : 'MISMATCH')
process.exit(ok ? 0 : 1)
