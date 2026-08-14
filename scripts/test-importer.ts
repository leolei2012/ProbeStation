import { Context } from 'cordis'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as modbusPlugin from '../packages/modbus/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'
import * as sinkPlugin from '../packages/sink/src/index.ts'
import * as rulePlugin from '../packages/rule/src/index.ts'
import * as importerPlugin from '../packages/importer/src/index.ts'
import * as apiPlugin from '../packages/api/src/index.ts'

const ctx = new Context()
await ctx.plugin(configPlugin, { dbPath: ':memory:' })
await ctx.plugin(storePlugin, { dbPath: ':memory:' })
await ctx.plugin(modbusPlugin, {})
await ctx.plugin(pollerPlugin, {})
await ctx.plugin(sinkPlugin)
await ctx.plugin(rulePlugin)
await ctx.plugin(importerPlugin)
await ctx.plugin(apiPlugin, { host: '127.0.0.1', port: 8080 })

const cfg = ctx.get('config', false)
const obj = cfg.createObject('导入测试', '127.0.0.1', 8502)
const app = ctx.get('api', false)

// 1. MBP XML
const xml = '<?xml version="1.0"?>\n<ModbusPoll><ScanRate>1000</ScanRate><Data><Function>03</Function><Address>0</Address><Quantity>3</Quantity><CellData><Cell idx="0"><Name>电源开关</Name></Cell><Cell idx="1"><Name>工作模式</Name></Cell><Cell idx="2"><Name>制冷档位</Name></Cell></CellData></Data></ModbusPoll>'
let res = await app.inject({ method: 'POST', url: `/api/monitor_objects/${obj.id}/import`, payload: { filename: 't.mbp', content: Buffer.from(xml).toString('base64') } })
console.log('import mbp-xml:', res.statusCode, res.body)

// 2. MBP INI
const ini = '[Window1]\nFunction=03\nAddress=40001\nQuantity=2\nAlias=温度\nData Type=int16\n'
res = await app.inject({ method: 'POST', url: `/api/monitor_objects/${obj.id}/import`, payload: { filename: 't.mbp', content: Buffer.from(ini).toString('base64') } })
console.log('import mbp-ini:', res.statusCode, res.body)

// 3. MBS binary (minimal header, fallback names)
const mbs = Buffer.alloc(120)
mbs.writeUInt32LE(3, 12)
mbs.writeUInt32LE(2, 16)
mbs.writeUInt32LE(1, 20)
res = await app.inject({ method: 'POST', url: `/api/monitor_objects/${obj.id}/import`, payload: { filename: 't.mbs', content: mbs.toString('base64') } })
console.log('import mbs:', res.statusCode, res.body)

console.log('registers:', JSON.stringify(cfg.listRegistersByObject(obj.id).map(r => ({ alias: r.alias, addr: r.startAddress }))))
console.log('IMPORTER TEST OK')
