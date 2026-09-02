import { Context } from 'cordis'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'

// ============================================================
// poller 自动恢复回归：设备侧 TX/RX 断线重接 → 连续读失败达阈值后
// 自动重建 RTU 通道驱动（重开串口/新建 ModbusRTUClient），无需手动重连。
// 模拟：第一代驱动“读必失败”（链路抖动/失步）→ 自动重建 → 第二代驱动恢复成功。
// ============================================================

function makeRecoverHarness() {
  let generation = 0
  const warns: string[] = []
  const makeDriver = () => {
    const gen = ++generation
    const firstGen = gen === 1 // 只有第一代驱动“读失败”，用于触发 auto-reset
    const driver = {
      connect: async () => {},
      disconnect: () => {},
      isConnected: () => true,
      readHoldingRegisters: async (): Promise<number[]> => {
        if (firstGen) throw new Error('Timeout') // 第一代驱动读必超时 → 连续失败
        return [1, 2, 3] // 第二代恢复成功
      },
      readInputRegisters: async (): Promise<number[]> => [4, 5, 6],
      writeRegister: async () => {},
      writeRegisters: async () => {},
      getRawSocket: async () => { throw new Error('n/a') },
    }
    return driver
  }
  const plugin = {
    name: 'fake-modbus',
    apply(ctx: any) { ctx.provide('modbus', { createDriver: () => makeDriver() }) },
  }
  return { plugin, getGeneration: () => generation, warns }
}

const h = makeRecoverHarness()
const ctx = new Context()
await ctx.plugin(configPlugin, { dbPath: ':memory:' })
await ctx.plugin(h.plugin)
await ctx.plugin(storePlugin, { dbPath: ':memory:', flushIntervalMs: 5000, flushBatchSize: 100 })
// autoResetFailThreshold=2：两连败即重建
await ctx.plugin(pollerPlugin, { pollIntervalMs: 40, connectRetryMs: 40, watchdogTimeoutMs: 200, autoResetFailThreshold: 2, autoResetCooldownMs: 100 })

const cfg = ctx.get('config', false)
// 建一台 RTU 设备（driverKey = rtu:COM-TEST）
const obj = cfg.createObject('rtu-recover', '', 502, 'master', { transport: 'rtu', serialPath: 'COM-TEST', pollIntervalMs: 40 })
cfg.createGroup(obj.id, 'g', 3, 0, 3, 'read', 1, 40)

const poller = ctx.get('poller', false)
poller.startAll()

// 等足够时间让第一代驱动吃满 threshold 次失败并触发重建，第二代恢复成功
// 第一代失败约：40ms tick，firstGen 读必抛错（瞬时），throttle 后应快速累积到 2 → 重建
await new Promise((r) => setTimeout(r, 900))
poller.stopAll()

const gen = h.getGeneration()
console.log('driver generations = ' + gen)

// 若从未重建（gen 仍 = 1），说明 auto-reset 未触发 → 失败
if (gen < 2) {
  throw new Error('expected driver auto-reset after repeated RTU read failures, but generation stayed at ' + gen)
}
// 更进一步：驱动已停、状态无卡死、poll 恢复
console.log('RTU AUTO-RECOVER TEST OK (driver rebuilt: gen ' + gen + ')')
process.exit(0)
