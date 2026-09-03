import { Context } from 'cordis'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'

// ============================================================
// poller 大分组自动分批读回归（<125/单请求 → 自动拆 ≤max）
// ============================================================

function assert(cond: unknown, msg: string): void { if (!cond) { console.error('ASSERT FAIL: ' + msg); process.exit(1) } }

const calls: Array<{ a: number; c: number }> = []
const driver: any = {
  connect: async () => {},
  disconnect: () => {},
  isConnected: () => true,
  readHoldingRegisters: async (address: number, count: number, _slaveId: number): Promise<number[]> => {
    calls.push({ a: address, c: count })
    const out: number[] = []
    for (let i = 0; i < count; i++) out.push(address + i)
    return out
  },
  writeRegister: async () => {},
  writeRegisters: async () => {},
  getRawSocket: async () => { throw new Error('n/a') },
}
const plugin = { name: 'fake-modbus', apply(ctx: any) { ctx.provide('modbus', { createDriver: () => driver }) } }

const ctx = new Context()
await ctx.plugin(configPlugin, { dbPath: ':memory:' })
await ctx.plugin(plugin)
await ctx.plugin(storePlugin, { dbPath: ':memory:', flushIntervalMs: 50000, flushBatchSize: 100000 })
await ctx.plugin(pollerPlugin, {}) // defaults fine
const cfg = ctx.get('config', false)
const obj = cfg.createObject('big', '127.0.0.1', 502, 'master', {})
// 组：FC03 从 1000 起 quantity 300（>125）
cfg.createGroup(obj.id, 'big', 3, 1000, 300)

const poller = ctx.get('poller', false)
await poller.pollOnce({ id: obj.id, host: '127.0.0.1', port: 502, groups: cfg.listGroups(obj.id) })

assert(calls.length === 3, 'expected 3 reads for 300 holding regs, got ' + calls.length)
assert(calls.every((c) => c.c <= 125), 'each read count <=125: ' + JSON.stringify(calls))
assert(calls[0].a === 1000 && calls[1].a === 1125 && calls[2].a === 1250, 'contiguous starts: ' + JSON.stringify(calls.map((c) => c.a)))
assert(calls[2].c === 50, 'last chunk 50: ' + JSON.stringify(calls))
console.log('chunked calls:', JSON.stringify(calls))
console.log('POLL READ CHUNK OK (300 holding → 3× ≤125 sequential reads)')
process.exit(0)
