import { Context } from 'cordis'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ConsoleExporter from '@cordisjs/plugin-logger-console'
import * as configPlugin from '@probebench/config'
import * as storePlugin from '@probebench/store'
import * as modbusPlugin from '@probebench/modbus'
import * as pollerPlugin from '@probebench/poller'
import * as apiPlugin from '@probebench/api'
import * as sinkPlugin from '@probebench/sink'
import * as rulePlugin from '@probebench/rule'
import * as importerPlugin from '@probebench/importer'
import * as mcpPlugin from '@probebench/mcp'
import * as slavePlugin from '@probebench/slave'
import * as workspacePlugin from '@probebench/workspace'
import * as otaPlugin from '@probebench/ota'

const ctx = new Context()
const wsDir = workspacePlugin.resolveInitialWorkspace('data')
// 前端静态目录用源码位置解析成绝对路径，避免 cwd 不同（npm run dev 时 cwd=apps/cli）导致 404
const staticDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist')
await ctx.plugin(ConsoleExporter)
await ctx.plugin(configPlugin, { dbPath: join(wsDir, 'config.db') })
await ctx.plugin(storePlugin, { dbPath: join(wsDir, 'poll.duckdb'), flushIntervalMs: 2000, flushBatchSize: 500 })
await ctx.plugin(modbusPlugin, { defaultTimeoutMs: 3000, defaultUnitId: 1 })
await ctx.plugin(apiPlugin, { host: '0.0.0.0', port: 8080, staticDir })
await ctx.plugin(sinkPlugin)
await ctx.plugin(rulePlugin)
await ctx.plugin(importerPlugin)
await ctx.plugin(otaPlugin)
await ctx.plugin(mcpPlugin)
await ctx.plugin(slavePlugin, { port: 8502, holdingSize: 5000 })
await ctx.plugin(pollerPlugin, { pollIntervalMs: 1000 })
await ctx.plugin(workspacePlugin, { defaultWorkspace: 'data' })

// seed demo devices if config empty
const cfg = ctx.get('config', false)
if (cfg.listObjects().length === 0) seedDemo(ctx, cfg)

// local simulator: drive the slave with live values
const slave = ctx.get('slave', false)
slave.setRegister(1, 250) // 温度
slave.setRegister(2, 800) // 转速
slave.setRegister(4096, 220) // 电压（0x1000）
slave.setRegister(4097, 5) // 电流
slave.setRegister(4098, 1100) // 功率
let counter = 0
setInterval(() => slave.setRegister(0, (counter++) % 1000), 1000)

// start polling + listen
ctx.get('poller', false).startAll()
const app = ctx.get('api', false)
await app.listen({ host: '0.0.0.0', port: 8080 })
console.log('ProbeStation running at http://localhost:8080')

function seedDemo(ctx: any, cfg: any): void {
  // 测试从站（真实 Modbus slave，192.168.90.176:8899，unit id=1，0x0000 起 10 寄存器）
  const obj = cfg.createObject('测试从站', '192.168.90.176', 8899)
  const g = cfg.createGroup(obj.id, 'Holding Registers', 3, 0, 10)
  for (let i = 0; i < 10; i++) cfg.createRegister(g.id, obj.id, '寄存器' + i, 3, i)
  // 第二段：0x1000 起 10 个数据（斜坡下降）
  const g2 = cfg.createGroup(obj.id, '第二段 0x1000', 3, 4096, 10)
  for (let i = 0; i < 10; i++) cfg.createRegister(g2.id, obj.id, '段2寄存器' + i, 3, 4096 + i)

  // 本地模拟器（127.0.0.1:8502，由 slave 插件服务）
  const sim = cfg.createObject('本地模拟器', '127.0.0.1', 8502)
  const sg = cfg.createGroup(sim.id, '运行状态', 3, 0, 3)
  for (const [alias, addr] of [['计数器', 0], ['温度', 1], ['转速', 2]] as Array<[string, number]>) {
    cfg.createRegister(sg.id, sim.id, alias, 3, addr)
  }
  // 第二个非连续分组（0x1000）
  const sg2 = cfg.createGroup(sim.id, '电气参数', 3, 4096, 3)
  for (const [alias, addr] of [['电压', 0], ['电流', 1], ['功率', 2]] as Array<[string, number]>) {
    cfg.createRegister(sg2.id, sim.id, alias, 3, 4096 + addr)
  }

  ctx.logger('cli').info('seeded demo devices (测试从站 + 本地模拟器)')
}
