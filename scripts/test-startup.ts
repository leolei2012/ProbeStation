import assert from 'node:assert/strict'
import net from 'node:net'
import { assertPortsAvailable } from '../apps/cli/src/startup'
import { ModbusSlave } from '../packages/slave/src/index'
const owner = net.createServer()
await new Promise<void>(resolve => owner.listen(0, '0.0.0.0', resolve))
const port = (owner.address() as net.AddressInfo).port
try {
  await assert.rejects(assertPortsAvailable([port]), /已被占用/)
  const slave = new ModbusSlave({ port, holdingSize: 10 })
  await assert.rejects(slave.start(), { code: 'EADDRINUSE' })
} finally { await new Promise<void>(resolve => owner.close(() => resolve())) }
await assertPortsAvailable([port])
console.log('STARTUP TEST OK: occupied port, simulator error rejection, released port')
