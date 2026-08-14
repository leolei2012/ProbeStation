import { boot } from './_bootstrap.ts'
import { encodeRegister } from '../packages/core/src/codec.ts'

const { ctx } = await boot({ api: {}, slave: 18502 })
const cfg = ctx.get('config', false)
const slave = ctx.get('slave', false)
const app = ctx.get('api', false)

const obj = cfg.createObject('模拟器', '127.0.0.1', 18502)
const g = cfg.createGroup(obj.id, 'Holding', 3, 0, 3)
const reg = cfg.createRegister(g.id, obj.id, 'float', 3, 0, 'float32')

const res = await app.inject({ method: 'POST', url: '/api/registers/' + reg.id + '/write', payload: { value: 3.14, method: 'multiple' } })
console.log('write float32 3.14:', res.statusCode, res.body)
const words = encodeRegister('float32', 3.14)
console.log('expected words:', words, '| slave addr0 =', slave.getRegister(0), '| addr1 =', slave.getRegister(1))
const ok = slave.getRegister(0) === words[0] && slave.getRegister(1) === words[1]
console.log(ok ? 'FLOAT32 WRITE OK' : 'MISMATCH')
process.exit(ok ? 0 : 1)
