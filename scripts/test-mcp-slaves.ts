import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import * as mcpPlugin from '../packages/mcp/src/index.ts'
import { boot } from './_bootstrap.ts'

async function freePort() {
  const server = net.createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as net.AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
const { ctx } = await boot({ slave: await freePort() })
await ctx.plugin(mcpPlugin, { host: '127.0.0.1', port: 0 })
const server = (ctx.get('mcp', false) as any).createServer()
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
const client = new Client({ name: 'slave-regression', version: '1' })
await server.connect(serverTransport)
await client.connect(clientTransport)
async function call(name: string, args: any) {
  const result: any = await client.callTool({ name, arguments: args })
  assert(!result.isError, JSON.stringify(result))
  return JSON.parse(result.content[0].text)
}
try {
  const device = await call('create_device', { name: 'MCP slave', mode: 'slave', ip: '127.0.0.1', port: await freePort(), slave_id: 9 })
  assert.equal(device.mode, 'slave')
  const group = await call('create_group', { device_id: device.id, name: 'Input', function_code: 4, start_address: 0, quantity: 1 })
  assert.equal(group.slaveId, 9)
  await call('write_register', { device_id: device.id, area: 'input-register', address: 0, value: 123 })
  const reading = await call('read_register', { device_id: device.id, area: 'input-register', address: 0 })
  assert.equal(reading.value, 123)
  const health = await call('get_device_health', { device_id: device.id })
  assert.equal(health.connected, true)
  assert.equal(health.polling, false)
  assert.equal(health.poll_interval_ms, null)
  assert.equal(health.slave_service.connections, 0)
  assert.equal(health.slave_service.running, true)
  const scan: any = await client.callTool({ name: 'set_poll_interval', arguments: { device_id: device.id, poll_interval_ms: 1 } })
  assert.equal(scan.isError, true)
  await call('set_device_active', { device_id: device.id, active: false })
  assert.equal((await call('get_device_health', { device_id: device.id })).connected, false)
  await call('set_device_active', { device_id: device.id, active: true })
  assert.equal((await call('read_register', { device_id: device.id, area: 'input-register', address: 0 })).value, 123)
  await call('update_device', { device_id: device.id, mode: 'master', transport: 'tcp' })
  assert.equal((ctx.get('deviceSlaves', false) as any).connected(device.id), false)
  const forbidden: any = await client.callTool({ name: 'write_register', arguments: { device_id: device.id, area: 'input-register', address: 0, value: 321 } })
  assert.equal(forbidden.isError, true)
  await call('update_device', { device_id: device.id, mode: 'slave' })
  assert.equal((ctx.get('deviceSlaves', false) as any).connected(device.id), true)
  await call('delete_device', { device_id: device.id })
  assert.equal((ctx.get('deviceSlaves', false) as any).connected(device.id), false)
  console.log('MCP SLAVES OK: role selection, unit ID, local input writes, listener health, lifecycle and master restrictions')
} finally {
  await client.close()
  await server.close()
  await (ctx.get('deviceSlaves', false) as any).stop()
  await (ctx.get('slave', false) as any).stop()
}
process.exit(0)
