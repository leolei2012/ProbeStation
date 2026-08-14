import { Context } from 'cordis'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as modbusPlugin from '../packages/modbus/src/index.ts'
import * as slavePlugin from '../packages/slave/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'
import * as apiPlugin from '../packages/api/src/index.ts'

const ctx = new Context()
await ctx.plugin(configPlugin, { dbPath: ':memory:' })
await ctx.plugin(storePlugin, { dbPath: ':memory:' })
await ctx.plugin(modbusPlugin, { defaultTimeoutMs: 2000, defaultUnitId: 1 })
await ctx.plugin(slavePlugin, { port: 18502 })
await ctx.plugin(pollerPlugin, { pollIntervalMs: 1000 })
await ctx.plugin(apiPlugin, { host: '127.0.0.1', port: 8080 })
await new Promise((r) => setTimeout(r, 300))

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
