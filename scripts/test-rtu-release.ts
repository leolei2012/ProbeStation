import { Context } from 'cordis'
import { SerialDriver } from '../packages/modbus/src/index.ts'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'

// ============================================================
// 串口释放回归（对照 feedback 第 9、10 节）
// 1) SerialDriver.disconnect() 真正 await close()
// 2) RTU 引用计数：最后一台启用设备停用/删除后释放串口
// ============================================================

// ── Part 1：disconnect() 等待 close 完成 ────────────────────
let lastPort: AsyncClosePort | null = null
class AsyncClosePort {
  public closed = false
  constructor(_opts: any, cb: any) { lastPort = this; process.nextTick(() => cb(null)) }
  close(cb?: () => void) { setTimeout(() => { this.closed = true; cb?.() }, 40) } // 模拟异步 close
  on() {}
}

{
  const driver = new SerialDriver({ defaultTimeoutMs: 1000, defaultUnitId: 1 }, AsyncClosePort)
  await driver.connect({ serialPath: 'COM_TEST', baudRate: 9600, parity: 'none', stopBits: 1, dataBits: 8, flowControl: 'none' })
  if (!driver.isConnected()) throw new Error('connect failed')
  await driver.disconnect()
  if (driver.isConnected()) throw new Error('isConnected should be false after disconnect')
  if (!lastPort || !lastPort.closed) throw new Error('disconnect() did NOT await close (closed=' + (lastPort?.closed) + ')')
  console.log('1) disconnect() awaited close OK')
}

// ── Part 2：RTU 引用计数释放 ────────────────────────────────
function fakeModbus() {
  let connectCalls = 0
  let disconnectCalls = 0
  const driver = {
    connect: async () => { connectCalls++ },
    disconnect: async () => { disconnectCalls++ },
    isConnected: () => true,
    readHoldingRegisters: async (): Promise<number[]> => [1, 2, 3],
    readInputRegisters: async (): Promise<number[]> => [1, 2, 3],
    writeRegister: async () => {},
    writeRegisters: async () => {},
    getRawSocket: async () => { throw new Error('n/a') },
  }
  const plugin = { name: 'fake-modbus', apply(ctx: any) { ctx.provide('modbus', { createDriver: () => driver }) } }
  return { plugin, getConnectCalls: () => connectCalls, getDisconnectCalls: () => disconnectCalls }
}

{
  const fm = fakeModbus()
  const ctx = new Context()
  await ctx.plugin(configPlugin, { dbPath: ':memory:' })
  await ctx.plugin(fm.plugin)
  await ctx.plugin(storePlugin, { dbPath: ':memory:', flushIntervalMs: 5000, flushBatchSize: 100 })
  await ctx.plugin(pollerPlugin, { pollIntervalMs: 50 })

  const cfg = ctx.get('config', false)
  const a = cfg.createObject('RTU-A', '127.0.0.1', 502, 'master', { transport: 'rtu', serialPath: 'COM_SHARED' })
  const b = cfg.createObject('RTU-B', '127.0.0.1', 502, 'master', { transport: 'rtu', serialPath: 'COM_SHARED' })
  cfg.createGroup(a.id, 'ga', 3, 0, 2, 'read', 1, 50)
  cfg.createGroup(b.id, 'gb', 3, 0, 2, 'read', 1, 50)

  const poller = ctx.get('poller', false)
  poller.startAll()
  await new Promise((r) => setTimeout(r, 250)) // 让两台都连上（共享一个 driver，connect 只调一次）
  if (fm.getConnectCalls() < 1) throw new Error('RTU driver did not connect')

  // 停用 A：还有 B 在用，串口不应释放
  cfg.updateObject(a.id, { isActive: 0 })
  await new Promise((r) => setTimeout(r, 250))
  const afterA = fm.getDisconnectCalls()
  if (afterA !== 0) throw new Error('RTU port released while B still active (disconnect=' + afterA + ')')

  // 停用 B：最后一台也停了 → 应释放
  cfg.updateObject(b.id, { isActive: 0 })
  await new Promise((r) => setTimeout(r, 250))
  if (fm.getDisconnectCalls() < 1) throw new Error('RTU port NOT released after last device deactivated')

  poller.stopAll()
  console.log('2) RTU reference-counting release OK (disconnect calls = ' + fm.getDisconnectCalls() + ')')
}

console.log('RTU RELEASE TEST OK')
process.exit(0)
