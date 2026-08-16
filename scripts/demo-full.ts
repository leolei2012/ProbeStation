import net from 'node:net'
import { ModbusTCPServer } from 'jsmodbus'
import { boot } from './_bootstrap.ts'

// 1. local jsmodbus slave (holding = 100, 101, 102, ...)
const netServer = new net.Server()
const holding = Buffer.alloc(5000 * 2)
for (let i = 0; i < 5000; i++) holding.writeUInt16BE(100 + i, i * 2)
const slave = new ModbusTCPServer(netServer, { holding, coils: Buffer.alloc(1024), discrete: Buffer.alloc(1024), input: Buffer.alloc(1024) })
await new Promise<void>((r) => netServer.listen(8502, '127.0.0.1', r))

// 2. boot full cordis app
const { ctx } = await boot({ api: {} })

// 3. seed metadata
const cfg = ctx.get('config', false)
const obj = cfg.createObject('雪融机', '127.0.0.1', 8502)
const group = cfg.createGroup(obj.id, 'Holding Registers', 3, 0, 5)

// 4. poll the device 3 times (real jsmodbus read → store)
const poller = ctx.get('poller', false)
const device = { id: obj.id, host: '127.0.0.1', port: 8502, groups: [{ id: group.id, functionCode: 3, startAddress: 0, quantity: 5 }] }
for (let i = 0; i < 3; i++) {
  await poller.pollOnce(device)
  await new Promise((r) => setTimeout(r, 200))
}

// 5. verify via API inject
const app = ctx.get('api', false)
for (const url of [
  '/api/monitor_objects',
  '/api/monitor_objects/1/latest',
  '/api/data/query?object_id=1&address=0&start=2000-01-01T00:00:00Z&end=2100-01-01T00:00:00Z',
]) {
  const res = await app.inject({ method: 'GET', url })
  console.log(`GET ${url}`)
  console.log('  ->', res.statusCode, res.body)
}
console.log('DEMO FULL STACK OK')
netServer.close()
process.exit(0)
