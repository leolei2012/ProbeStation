import { boot } from './_bootstrap.ts'
import { decodeRawByAddr, formatNumber } from '../packages/core/src/codec.ts'

const { ctx } = await boot({ slave: 18502, api: {} })
const cfg = ctx.get('config', false)
const slave = ctx.get('slave', false)
const poller = ctx.get('poller', false)
const store = ctx.get('store', false)

// 地址0=int32（覆盖地址1），地址1仍有寄存器行（被覆盖），地址2=int16
const obj = cfg.createObject('模拟器', '127.0.0.1', 18502)
const g = cfg.createGroup(obj.id, 'g', 3, 0, 3)
const r0 = cfg.createRegister(g.id, obj.id, 'big32', 3, 0, 'int32')
const r1 = cfg.createRegister(g.id, obj.id, 'covered', 3, 1, 'int16')
const r2 = cfg.createRegister(g.id, obj.id, 'small', 3, 2, 'int16')

slave.setRegister(0, 0x1234)
slave.setRegister(1, 0x5678)
slave.setRegister(2, 10)

poller.startAll()
await new Promise((r) => setTimeout(r, 800))
await store.flush()

const app = ctx.get('api', false)
const res = await app.inject({ method: 'GET', url: `/api/data/object?object_id=${obj.id}&start=2000-01-01T00:00:00Z&end=2100-01-01T00:00:00Z` })
const pts: Array<{ ts: string; address: number; rawValue: number }> = JSON.parse(res.body)
console.log('历史接口返回 (address -> rawValue):')
for (const p of pts) console.log('  addr', p.address, '=', p.rawValue)

const rawByTs = new Map<string, Record<number, number>>()
for (const p of pts) { if (!rawByTs.has(p.ts)) rawByTs.set(p.ts, {}); rawByTs.get(p.ts)![p.address] = p.rawValue }
const rawByAddr = rawByTs.values().next().value as Record<number, number>
const decoded = decodeRawByAddr([r0, r1, r2], rawByAddr)
console.log('big32 解码 =', formatNumber(decoded.get(r0.id) ?? ''), '(expect 305419896)')
console.log('covered 解码 =', decoded.get(r1.id), '(expect null，被覆盖)')
console.log('small 解码 =', decoded.get(r2.id), '(expect 10)')

poller.stopAll()
const ok = formatNumber(decoded.get(r0.id) ?? '') === '305419896' && decoded.get(r1.id) === null && decoded.get(r2.id) === 10
console.log(ok ? 'MULTIWORD HIST OK' : 'MULTIWORD HIST FAIL')
process.exit(ok ? 0 : 1)
