import net from 'node:net'
import { ModbusTCPServer } from 'jsmodbus'
import { Context } from 'cordis'
import * as configPlugin from '../packages/config/src/index.ts'
import * as modbusPlugin from '../packages/modbus/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'

// 1. local slave with pre-filled holding registers (100, 101, 102, ...)
const netServer = new net.Server()
const REG_COUNT = 5000
const holding = Buffer.alloc(REG_COUNT * 2)
for (let i = 0; i < REG_COUNT; i++) holding.writeUInt16BE(100 + i, i * 2)
const coils = Buffer.alloc(1024); coils[0] = 0x0d
const discrete = Buffer.alloc(1024); discrete[0] = 0x06
const slave = new ModbusTCPServer(netServer, {
  holding,
  coils,
  discrete,
  input: Buffer.alloc(1024),
})
await new Promise<void>((resolve) => netServer.listen(8502, '127.0.0.1', resolve))
console.log('slave listening on 127.0.0.1:8502')

// 2. boot cordis app
const ctx = new Context()
await ctx.plugin(configPlugin, { dbPath: ':memory:' })
await ctx.plugin(modbusPlugin, { defaultTimeoutMs: 2000, defaultUnitId: 1 })
await ctx.plugin(storePlugin, { dbPath: ':memory:', flushIntervalMs: 5000, flushBatchSize: 100 })
await ctx.plugin(pollerPlugin, { pollIntervalMs: 1000 })

// 3. poll one device (two groups)
await ctx.get('poller', false).pollOnce({
  id: 9, host: '127.0.0.1', port: 8502,
  groups: [
    { id: 1, functionCode: 3, startAddress: 0, quantity: 5 },
    { id: 2, functionCode: 3, startAddress: 4096, quantity: 3 },
    { id: 3, functionCode: 1, startAddress: 0, quantity: 5 },
    { id: 4, functionCode: 2, startAddress: 0, quantity: 4 },
  ],
})

// 4. verify hot tier + cold tier
const latest = ctx.get('store', false).getLatest()
console.log('latest:', JSON.stringify(latest))
if (latest['9:coil:0']?.rawValue !== 1 || latest['9:coil:1']?.rawValue !== 0 || latest['9:discrete-input:1']?.rawValue !== 1) throw new Error('FC01/02 TCP polling or area isolation failed')
if (latest['9:coil:5'] != null || latest['9:discrete-input:4'] != null) throw new Error('FC01/02 response was not trimmed to requested quantity')
if (latest['9:holding-register:0']?.rawValue !== 100 || latest['9:0'] != null) throw new Error('canonical area key model failed')
const rows0 = await ctx.get('store', false).query(9, 0, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z', 'holding-register')
console.log('query addr0:', JSON.stringify(rows0))
const rows4096 = await ctx.get('store', false).query(9, 4096, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z', 'holding-register')
console.log('query addr4096:', JSON.stringify(rows4096))
console.log('LOOP TEST OK')

netServer.close()
process.exit(0)
