import { boot } from './_bootstrap.ts'

const { ctx } = await boot({ api: {}, slave: 18502 })

const cfg = ctx.get('config', false)
const obj = cfg.createObject('模拟器', '127.0.0.1', 18502)
const g = cfg.createGroup(obj.id, 'Holding', 3, 0, 3)
const reg = cfg.createRegister(g.id, obj.id, '计数器', 3, 0)

const slave = ctx.get('slave', false)
slave.setRegister(0, 100)
console.log('slave initial addr0 =', slave.getRegister(0))

const app = ctx.get('api', false)

// write via FC16 (multiple)
let res = await app.inject({ method: 'POST', url: `/api/registers/${reg.id}/write`, payload: { value: 42, method: 'multiple' } })
console.log('write multiple:', res.statusCode, res.body, '| slave addr0 =', slave.getRegister(0))

// write via FC06 (single)
res = await app.inject({ method: 'POST', url: `/api/registers/${reg.id}/write`, payload: { value: 7, method: 'single' } })
console.log('write single:  ', res.statusCode, res.body, '| slave addr0 =', slave.getRegister(0))

// update register alias + dataType (inline editing in Live table)
res = await app.inject({ method: 'PUT', url: `/api/registers/${reg.id}`, payload: { alias: '新别名', dataType: 'uint16' } })
console.log('update register:', res.statusCode, res.body)

// CRUD
res = await app.inject({ method: 'POST', url: '/api/monitor_objects', payload: { name: '设备B', ip: '1.2.3.4', port: 502 } })
const objB = JSON.parse(res.body)
console.log('create object:', res.statusCode, res.body)
res = await app.inject({ method: 'PUT', url: `/api/monitor_objects/${objB.id}`, payload: { name: '设备B改', isActive: 0 } })
console.log('update object:', res.statusCode, res.body)
res = await app.inject({ method: 'POST', url: `/api/monitor_objects/${objB.id}/toggle` })
console.log('toggle object:', res.statusCode, res.body)
res = await app.inject({ method: 'DELETE', url: `/api/monitor_objects/${objB.id}` })
console.log('delete object:', res.statusCode, res.body)

console.log('CRUD+WRITE TEST OK')
slave.stop()
process.exit(0)
