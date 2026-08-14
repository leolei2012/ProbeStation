import { boot } from './_bootstrap.ts'

const { ctx } = await boot({ api: {} })
const app = ctx.get('api', false)
const cfg = ctx.get('config', false)

let res = await app.inject({ method: 'POST', url: '/api/monitor_objects', payload: { name: '测试', ip: '1.2.3.4', port: 502 } })
const obj = JSON.parse(res.body)
res = await app.inject({ method: 'POST', url: '/api/monitor_objects/' + obj.id + '/groups', payload: { name: '组A', startAddress: 4096, quantity: 10 } })
const g = JSON.parse(res.body)
console.log('create group:', res.statusCode, 'id=' + g.id)

const regs = cfg.listRegisters(g.id)
console.log('registers count:', regs.length, '(expect 10)')
console.log('first/last addr:', regs[0]?.startAddress, regs[regs.length - 1]?.startAddress, '(expect 4096 4105)')

const ok = regs.length === 10 && regs[0]?.startAddress === 4096 && regs[9]?.startAddress === 4105
console.log(ok ? 'GROUP CREATE OK' : 'MISMATCH')
process.exit(ok ? 0 : 1)
