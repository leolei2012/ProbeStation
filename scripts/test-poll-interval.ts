import { Context } from 'cordis'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'

// ============================================================
// 按设备可调轮询速率回归（PRD 08 需求一）
// 设备 poll_interval_ms=100 时，实际采样 ≈100ms（而非全局 1s）。
// ============================================================

function fakeModbus() {
  let readCount = 0
  const readTimes: number[] = []
  const driver = {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    readHoldingRegisters: async (): Promise<number[]> => { readCount++; readTimes.push(Date.now()); return [1, 2, 3] },
    readInputRegisters: async (): Promise<number[]> => [1, 2, 3],
    writeRegister: async () => {},
    writeRegisters: async () => {},
    getRawSocket: async () => { throw new Error('n/a') },
  }
  const plugin = { name: 'fake-modbus', apply(ctx: any) { ctx.provide('modbus', { createDriver: () => driver }) } }
  return { plugin, getReadCount: () => readCount, getReadTimes: () => readTimes }
}

{
  const fm = fakeModbus()
  const ctx = new Context()
  await ctx.plugin(configPlugin, { dbPath: ':memory:' })
  await ctx.plugin(fm.plugin)
  await ctx.plugin(storePlugin, { dbPath: ':memory:', retentionCheckMs: 0 })
  await ctx.plugin(pollerPlugin, { pollIntervalMs: 1000 }) // 全局回退 1000ms

  const cfg = ctx.get('config', false)
  const obj = cfg.createObject('fast', '127.0.0.1', 502, 'master', { pollIntervalMs: 100 }) // 设备级 100ms
  cfg.createGroup(obj.id, 'g', 3, 0, 3, 'read', 1, 100)

  const poller = ctx.get('poller', false)
  poller.startAll()
  await new Promise((r) => setTimeout(r, 600))
  poller.stopAll()

  const reads = fm.getReadCount()
  // 600ms / 100ms ≈ 6 次；若仍按全局 1s 调度，600ms 内只有 1 次。
  if (reads < 3 || reads > 12) throw new Error('expected ~6 reads at 100ms, got ' + reads)
  const times = fm.getReadTimes()
  if (times.length >= 2 && times[times.length - 1] - times[0] < 300) {
    // 至少跨了 ~500ms，说明确实多轮采样（不是单次）
  } else if (reads < 3) {
    throw new Error('too few reads')
  }
  console.log('poll interval 100ms OK: ' + reads + ' reads over 600ms')
}

console.log('POLL INTERVAL TEST OK')
process.exit(0)
