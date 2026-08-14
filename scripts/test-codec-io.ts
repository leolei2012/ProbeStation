import { boot } from './_bootstrap.ts'
import { encodeRegister } from '../packages/core/src/codec.ts'

const { ctx } = await boot({ api: {}, slave: 18502 })
const cfg = ctx.get('config', false)
const slave = ctx.get('slave', false)
const app = ctx.get('api', false)

const obj = cfg.createObject('模拟器', '127.0.0.1', 18502)
const g = cfg.createGroup(obj.id, 'Holding', 3, 0, 6)

const r32 = cfg.createRegister(g.id, obj.id, 'i32', 3, 0, 'int32')
let res = await app.inject({ method: 'POST', url: '/api/registers/' + r32.id + '/write', payload: { value: 305419896, method: 'multiple' } })
const w32 = encodeRegister('int32', 305419896)
console.log('int32 write:', res.statusCode, '| slave[0,1] =', slave.getRegister(0), slave.getRegister(1), '| expect', w32.join(','))

const r64 = cfg.createRegister(g.id, obj.id, 'f64', 3, 2, 'float64')
res = await app.inject({ method: 'POST', url: '/api/registers/' + r64.id + '/write', payload: { value: 3.14159265358979, method: 'multiple' } })
const w64 = encodeRegister('float64', 3.14159265358979)
console.log('float64 write:', res.statusCode, '| slave[2..5] =', slave.getRegister(2), slave.getRegister(3), slave.getRegister(4), slave.getRegister(5), '| expect', w64.join(','))

const rBad = cfg.createRegister(g.id, obj.id, 'bad', 3, 4, 'int16')
res = await app.inject({ method: 'PUT', url: '/api/registers/' + rBad.id, payload: { dataType: 'float64' } })
const rejectOk = JSON.parse(res.body).code === 400
console.log('reject float64@4 (expect code 400):', res.statusCode, res.body)

const ok = slave.getRegister(0) === w32[0] && slave.getRegister(1) === w32[1] && slave.getRegister(2) === w64[0] && slave.getRegister(3) === w64[1] && slave.getRegister(4) === w64[2] && slave.getRegister(5) === w64[3] && rejectOk
console.log(ok ? 'MULTI-WIDTH WRITE OK' : 'MISMATCH')
process.exit(ok ? 0 : 1)
