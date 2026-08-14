import { Context } from 'cordis'
import ConsoleExporter from '@cordisjs/plugin-logger-console'
import * as configPlugin from '@probebench/config'
import * as storePlugin from '@probebench/store'
import * as modbusPlugin from '@probebench/modbus'
import * as pollerPlugin from '@probebench/poller'
import * as apiPlugin from '@probebench/api'
import * as sinkPlugin from '@probebench/sink'
import * as slavePlugin from '@probebench/slave'

const ctx = new Context()
await ctx.plugin(ConsoleExporter)
await ctx.plugin(configPlugin, { dbPath: 'data/config.db' })
await ctx.plugin(storePlugin, { dbPath: 'data/poll.duckdb', flushIntervalMs: 2000, flushBatchSize: 500 })
await ctx.plugin(modbusPlugin, { defaultTimeoutMs: 3000, defaultUnitId: 1 })
await ctx.plugin(apiPlugin, { host: '0.0.0.0', port: 8080, staticDir: 'apps/web/dist' })
await ctx.plugin(sinkPlugin)
await ctx.plugin(slavePlugin, { port: 8502, holdingSize: 5000 })
await ctx.plugin(pollerPlugin, { pollIntervalMs: 1000 })

// seed demo devices if config empty
const cfg = ctx.get('config', false)
if (cfg.listObjects().length === 0) seedDemo(ctx, cfg)

// local simulator: drive the slave with live values
const slave = ctx.get('slave', false)
slave.setRegister(1, 250) // 温度
slave.setRegister(2, 800) // 转速
let counter = 0
setInterval(() => slave.setRegister(0, (counter++) % 1000), 1000)

// start polling + listen
ctx.get('poller', false).startAll()
const app = ctx.get('api', false)
await app.listen({ host: '0.0.0.0', port: 8080 })
console.log('ProbeStation running at http://localhost:8080')

function seedDemo(ctx: any, cfg: any): void {
  // 真实设备（可能不可达）
  const obj = cfg.createObject('雪融机', '192.168.90.32', 8899)
  const g = cfg.createGroup(obj.id, 'Holding Registers', 3, 0, 47)
  for (const [alias, addr] of [['电源开关', 0], ['工作模式', 1], ['制冷档位', 3], ['原料当前温度', 7], ['电机电流', 8]] as Array<[string, number]>) {
    cfg.createRegister(g.id, obj.id, alias, 3, addr)
  }

  // 本地模拟器（127.0.0.1:8502，由 slave 插件服务）
  const sim = cfg.createObject('本地模拟器', '127.0.0.1', 8502)
  const sg = cfg.createGroup(sim.id, 'Holding Registers', 3, 0, 3)
  for (const [alias, addr] of [['计数器', 0], ['温度', 1], ['转速', 2]] as Array<[string, number]>) {
    cfg.createRegister(sg.id, sim.id, alias, 3, addr)
  }

  ctx.logger('cli').info('seeded demo devices (雪融机 + 本地模拟器)')
}
