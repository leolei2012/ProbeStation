import { boot } from './_bootstrap.ts'

const { ctx } = await boot({ api: {} })

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
process.exit(0)
