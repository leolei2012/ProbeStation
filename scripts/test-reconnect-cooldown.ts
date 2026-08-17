import { Context } from 'cordis'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'

// ============================================================
// 回归：连接失败后的冷却，在「断开→重连」时应被清除，立即重试。
// 症状：串口连接失败后，用户手动断开再连接，不应再等冷却期（否则表现为「要再点一次连接才刷新」）。
// ============================================================

function fakeModbus() {
  let connectCalls = 0
  const driver = {
    connect: async () => { connectCalls++; throw new Error('connect ECONNREFUSED') },
    disconnect: async () => {},
    isConnected: () => true,
    readHoldingRegisters: async (): Promise<number[]> => [1, 2, 3],
    readInputRegisters: async (): Promise<number[]> => [1, 2, 3],
    writeRegister: async () => {},
    writeRegisters: async () => {},
    getRawSocket: async () => { throw new Error('n/a') },
  }
  return { plugin: { name: 'fake-modbus', apply(ctx: any) { ctx.provide('modbus', { createDriver: () => driver }) } }, getConnectCalls: () => connectCalls }
}

const fm = fakeModbus()
const ctx = new Context()
await ctx.plugin(configPlugin, { dbPath: ':memory:' })
await ctx.plugin(fm.plugin)
await ctx.plugin(storePlugin, { dbPath: ':memory:', retentionCheckMs: 0 })
await ctx.plugin(pollerPlugin, { pollIntervalMs: 50, connectRetryMs: 1000, watchdogTimeoutMs: 200 })

const cfg = ctx.get('config', false)
const obj = cfg.createObject('dev', '127.0.0.1', 9999, 'master', { pollIntervalMs: 50 })
cfg.createGroup(obj.id, 'g', 3, 0, 1, 'read', 1, 50)

const poller = ctx.get('poller', false)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
poller.startAll()
await sleep(150)
const c1 = fm.getConnectCalls()
if (c1 < 1) throw new Error('first connect should have failed at least once, got ' + c1)

// 断开（清冷却）→ 重连（应立即重试，不等 1s 冷却）
cfg.updateObject(obj.id, { isActive: 0 })
await sleep(100)
cfg.updateObject(obj.id, { isActive: 1 })
await sleep(200)
const c2 = fm.getConnectCalls()
if (c2 < 2) throw new Error('cooldown not cleared on reconnect; connect calls = ' + c2 + ' (expected >= 2)')

poller.stopAll()
console.log('COOLDOWN CLEAR ON RECONNECT OK: connect calls ' + c1 + ' -> ' + c2)
process.exit(0)
