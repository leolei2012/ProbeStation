import net from 'node:net'
import { ModbusTCPServer } from 'jsmodbus'
import { Context } from 'cordis'
import * as configPlugin from '../packages/config/src/index.ts'
import * as modbusPlugin from '../packages/modbus/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'

// local slave with 5000 holding registers (100 + i)
const netServer = new net.Server()
const REG_COUNT = 5000
const holding = Buffer.alloc(REG_COUNT * 2)
for (let i = 0; i < REG_COUNT; i++) holding.writeUInt16BE(100 + i, i * 2)
const slave = new ModbusTCPServer(netServer, { holding, coils: Buffer.alloc(1024), discrete: Buffer.alloc(1024), input: Buffer.alloc(1024) })
await new Promise<void>((resolve) => netServer.listen(8503, '127.0.0.1', resolve))

const ctx = new Context()
await ctx.plugin(configPlugin, { dbPath: ':memory:' })
await ctx.plugin(modbusPlugin, { defaultTimeoutMs: 1500, defaultUnitId: 1 })
await ctx.plugin(storePlugin, { dbPath: ':memory:', flushIntervalMs: 5000, flushBatchSize: 100 })
await ctx.plugin(pollerPlugin, { pollIntervalMs: 300 })

const cfg = ctx.get('config', false)
const a = cfg.createObject('good', '127.0.0.1', 8503)
cfg.createGroup(a.id, 'ok-group', 3, 0, 5, 'read', 1, 300)
const b = cfg.createObject('illegal', '127.0.0.1', 8503)
cfg.createGroup(b.id, 'bad-addr', 3, 4900, 200, 'read', 1, 300)
const c = cfg.createObject('unreachable', '127.0.0.1', 9999)
cfg.createGroup(c.id, 'conn-fail', 3, 0, 3, 'read', 1, 300)

const events: string[] = []
ctx.on('poller/group-error', (p: any) => events.push('ERR#' + p.groupId + '#' + p.error))
ctx.on('poller/group-ok', (p: any) => events.push('OK#' + p.groupId))
ctx.on('poller/result', (p: any) => events.push('RESULT#' + p.objectId + '#' + p.points.length))

const poller = ctx.get('poller', false)
poller.startAll()
await new Promise((r) => setTimeout(r, 1800))
poller.stopAll()
netServer.close()

console.log('EVENTS:')
for (const e of events) console.log('  ' + e)
console.log('GROUP FAULT TEST DONE')
process.exit(0)

