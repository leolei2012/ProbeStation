import { Context } from 'cordis'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'

// ============================================================
// poller 兜底回归：连接失败冷却 + 长时间无进展看门狗
// 用假 modbus 驱动模拟「读卡死（无结果无错误）」与「连接失败」两种场景。
// ============================================================

function fakeModbus(opts: { connectFail?: boolean; readHang?: boolean }) {
  let connectCalls = 0
  const driver = {
    connect: async () => {
      connectCalls++
      if (opts.connectFail) throw new Error('connect ECONNREFUSED')
    },
    disconnect: () => {},
    isConnected: () => true,
    readHoldingRegisters: async (): Promise<number[]> => {
      if (opts.readHang) return new Promise(() => {}) // 永不 resolve —— 模拟静默卡死
      return [1, 2, 3]
    },
    readInputRegisters: async (): Promise<number[]> => [1, 2, 3],
    writeRegister: async () => {},
    writeRegisters: async () => {},
    getRawSocket: async () => { throw new Error('n/a') },
  }
  const plugin = {
    name: 'fake-modbus',
    apply(ctx: any) { ctx.provide('modbus', { createDriver: () => driver }) },
  }
  return { plugin, getConnectCalls: () => connectCalls }
}

async function bootStack(fm: ReturnType<typeof fakeModbus>, pollerCfg: Record<string, number>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(configPlugin, { dbPath: ':memory:' })
  await ctx.plugin(fm.plugin)
  await ctx.plugin(storePlugin, { dbPath: ':memory:', flushIntervalMs: 5000, flushBatchSize: 100 })
  await ctx.plugin(pollerPlugin, pollerCfg)
  return ctx
}

// 1) 看门狗：读卡死（无结果无错误）的设备，超时后主动报「No response (watchdog)」
{
  const fm = fakeModbus({ readHang: true })
  const ctx = await bootStack(fm, { pollIntervalMs: 50, connectRetryMs: 100, watchdogTimeoutMs: 200 })
  const cfg = ctx.get('config', false)
  const obj = cfg.createObject('hung', '127.0.0.1', 9999, 'master', { pollIntervalMs: 50 })
  cfg.createGroup(obj.id, 'g', 3, 0, 3, 'read', 1, 50)

  const errors: string[] = []
  ctx.on('poller/group-error', (p: any) => errors.push(p.error))

  const poller = ctx.get('poller', false)
  poller.startAll()
  // 阈值 = max(200, 3*50+1000) = 1150ms，等 1800ms 留余量
  await new Promise((r) => setTimeout(r, 1800))
  poller.stopAll()

  if (!errors.includes('No response (watchdog)')) {
    throw new Error('watchdog did not fire; errors=' + JSON.stringify(errors))
  }
  console.log('1) watchdog OK: group-error = ' + JSON.stringify(errors))
}

// 2) 连接失败冷却：坏地址不每轮重建连接（poll 50ms / 重试 300ms → ~3 次而非 ~14 次）
{
  const fm = fakeModbus({ connectFail: true })
  const ctx = await bootStack(fm, { pollIntervalMs: 50, connectRetryMs: 300, watchdogTimeoutMs: 200 })
  const cfg = ctx.get('config', false)
  const obj = cfg.createObject('bad', '127.0.0.1', 9999, 'master', { pollIntervalMs: 50 })
  cfg.createGroup(obj.id, 'g', 3, 0, 3, 'read', 1, 50)

  const poller = ctx.get('poller', false)
  poller.startAll()
  await new Promise((r) => setTimeout(r, 700))
  poller.stopAll()

  const calls = fm.getConnectCalls()
  if (calls < 2 || calls > 6) {
    throw new Error('unexpected connect retries (expected ~3 with 300ms cooldown, got ' + calls + ')')
  }
  console.log('2) cooldown OK: connect attempts over 700ms = ' + calls + ' (poll 50ms / retry 300ms)')
}

console.log('POLLER WATCHDOG TEST OK')
process.exit(0)
