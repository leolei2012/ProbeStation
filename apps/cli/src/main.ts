import { Context } from 'cordis'
import ConsoleExporter from '@cordisjs/plugin-logger-console'
import * as configPlugin from '@probebench/config'
import * as storePlugin from '@probebench/store'
import * as modbusPlugin from '@probebench/modbus'
import * as pollerPlugin from '@probebench/poller'
import * as apiPlugin from '@probebench/api'

const ctx = new Context()
await ctx.plugin(ConsoleExporter)
await ctx.plugin(configPlugin, { dbPath: 'data/config.db' })
await ctx.plugin(storePlugin, { dbPath: 'data/poll.duckdb', flushIntervalMs: 2000, flushBatchSize: 500 })
await ctx.plugin(modbusPlugin, { defaultTimeoutMs: 3000, defaultUnitId: 1 })
await ctx.plugin(apiPlugin, { host: '0.0.0.0', port: 8080, staticDir: 'apps/web/dist' })
await ctx.plugin(pollerPlugin, { pollIntervalMs: 1000 })

// seed demo device if config is empty
const cfg = ctx.get('config', false)
if (cfg.listObjects().length === 0) seedDemo(cfg)

// start continuous polling + listen
ctx.get('poller', false).startAll()
const app = ctx.get('api', false)
await app.listen({ host: '0.0.0.0', port: 8080 })
console.log('ProbeStation running at http://localhost:8080')

function seedDemo(cfg: any): void {
  const obj = cfg.createObject('雪融机', '192.168.90.32', 8899)
  const g = cfg.createGroup(obj.id, 'Holding Registers', 3, 0, 47)
  const regs: Array<[string, number]> = [
    ['电源开关', 0], ['工作模式', 1], ['制冷档位', 3], ['原料当前温度', 7], ['电机电流', 8],
  ]
  for (const [alias, addr] of regs) cfg.createRegister(g.id, obj.id, alias, 3, addr)
  ctx.logger('cli').info('seeded demo device 雪融机')
}
