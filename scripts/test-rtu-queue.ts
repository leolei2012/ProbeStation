import { Context } from 'cordis'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'

// ============================================================
// 回归：慢串口设备不应让轮询队列无限堆积（否则数据越来越旧、软件像「卡住」）。
// 验证：stopAll 后不应还有大量排队轮询继续读（busy 跳过机制保证队列最多 1 个在途）。
// ============================================================

let readCount = 0
function fakeModbus() {
  const driver = {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    readHoldingRegisters: async (): Promise<number[]> => { readCount++; await new Promise((r) => setTimeout(r, 250)); return [1, 2, 3] },
    readInputRegisters: async (): Promise<number[]> => [1, 2, 3],
    writeRegister: async () => {},
    writeRegisters: async () => {},
    getRawSocket: async () => { throw new Error('n/a') },
  }
  return { plugin: { name: 'fake-modbus', apply(ctx: any) { ctx.provide('modbus', { createDriver: () => driver }) } } }
}

const fm = fakeModbus()
const ctx = new Context()
await ctx.plugin(configPlugin, { dbPath: ':memory:' })
await ctx.plugin(fm.plugin)
await ctx.plugin(storePlugin, { dbPath: ':memory:', retentionCheckMs: 0 })
await ctx.plugin(pollerPlugin, { pollIntervalMs: 50, connectRetryMs: 500, watchdogTimeoutMs: 5000 })

const cfg = ctx.get('config', false)
const obj = cfg.createObject('slow-rtu', '127.0.0.1', 502, 'master', { transport: 'rtu', serialPath: 'COM_SLOW', pollIntervalMs: 50 })
cfg.createGroup(obj.id, 'g', 3, 0, 2, 'read', 1, 50)

const poller = ctx.get('poller', false)
poller.startAll()
await new Promise((r) => setTimeout(r, 1000))
const atStop = readCount
poller.stopAll()
await new Promise((r) => setTimeout(r, 1000))
const afterStop = readCount

// 读 250ms，1s 内约 4 次；stopAll 后若还有排队轮询，会继续读。busy 跳过机制应让 afterStop ≈ atStop。
if (afterStop > atStop + 2) throw new Error('queue built up: atStop=' + atStop + ', afterStop=' + afterStop)
if (atStop < 2) throw new Error('too few reads before stop: ' + atStop)

console.log('RTU QUEUE BOUNDED OK: reads atStop=' + atStop + ', afterStop=' + afterStop + ' (no backlog)')
process.exit(0)
