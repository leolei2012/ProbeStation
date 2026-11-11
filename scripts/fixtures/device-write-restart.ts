// Lightweight fresh-process probe; never imports app bootstrap, databases or drivers.
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { registerRegisterWrite } from '../../packages/api/src/register-write.ts'
const app = Fastify(), forbidden = () => { throw Error('blocked route touched a dependency') }
registerRegisterWrite(app, { getRegister: forbidden, getGroup: forbidden, log: forbidden }, { write: forbidden })
try { const result = await app.inject({ method: 'POST', url: '/api/registers/1/write', payload: { value: 42 } }); assert.equal(result.statusCode,503); assert.equal(result.json().code,'DEVICE_WRITE_BLOCKED') } finally { await app.close() }
console.log('fresh process closed')
