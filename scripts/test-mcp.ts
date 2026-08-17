import { Context } from 'cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as modbusPlugin from '../packages/modbus/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'
import * as workspacePlugin from '../packages/workspace/src/index.ts'
import * as otaPlugin from '../packages/ota/src/index.ts'
import * as mcpPlugin from '../packages/mcp/src/index.ts'

const ctx = new Context()
await ctx.plugin(configPlugin, { dbPath: ':memory:' })
await ctx.plugin(storePlugin, { dbPath: ':memory:' })
await ctx.plugin(modbusPlugin, {})
await ctx.plugin(pollerPlugin, {})
await ctx.plugin(workspacePlugin, { defaultWorkspace: 'test-ws-mcp', registryPath: 'test-ws-mcp/registry.json' })
await ctx.plugin(otaPlugin)
await ctx.plugin(mcpPlugin, { host: '127.0.0.1', port: 18081 })

const cfg = ctx.get('config', false)
const obj = cfg.createObject('测试从站', '192.168.90.176', 8899)
const g = cfg.createGroup(obj.id, 'Holding', 3, 0, 10)
const reg0 = cfg.createRegister(g.id, obj.id, '寄存器0', 3, 0)
cfg.createRegister(g.id, obj.id, '寄存器1', 3, 1)

const store = ctx.get('store', false)
store.write([{ objectId: obj.id, address: reg0.startAddress, timestamp: new Date().toISOString(), rawValue: 5555, quality: 'good' }])
await store.flush()

await new Promise(r => setTimeout(r, 500))

const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18081/mcp'))
const client = new Client({ name: 'test', version: '1.0' })
await client.connect(transport)
console.log('MCP connected')

const tools = await client.listTools()
console.log('tools:', JSON.stringify(tools.tools.map(t => t.name)))

const r1 = await client.callTool({ name: 'list_devices', arguments: {} })
console.log('list_devices:', JSON.stringify(r1.content))

const r2 = await client.callTool({ name: 'read_register', arguments: { device_id: obj.id, address: reg0.startAddress } })
console.log('read_register (by address):', JSON.stringify(r2.content))

// CRUD tools
const g2 = await client.callTool({ name: 'create_group', arguments: { device_id: obj.id, name: '测试组', start_address: 20, quantity: 5 } })
console.log('create_group:', JSON.stringify(g2.content))
const g2id = JSON.parse((g2.content[0] as any).text).id

const r3 = await client.callTool({ name: 'create_register', arguments: { group_id: g2id, alias: '新寄存器', start_address: 20, data_type: 'uint16' } })
console.log('create_register:', JSON.stringify(r3.content))
const r3id = JSON.parse((r3.content[0] as any).text).id

const r4 = await client.callTool({ name: 'update_register', arguments: { register_id: r3id, alias: '改别名', data_type: 'float16' } })
console.log('update_register:', JSON.stringify(r4.content))

const r5 = await client.callTool({ name: 'update_group', arguments: { group_id: g2id, quantity: 10 } })
console.log('update_group:', JSON.stringify(r5.content))

const r6 = await client.callTool({ name: 'delete_register', arguments: { register_id: r3id } })
console.log('delete_register:', JSON.stringify(r6.content))

const r7 = await client.callTool({ name: 'delete_group', arguments: { group_id: g2id } })
console.log('delete_group:', JSON.stringify(r7.content))

// P0: read_register 应返回 address + quality
const rr = JSON.parse((r2.content[0] as any).text)
if (rr.address !== reg0.startAddress) throw new Error('read_register address mismatch: ' + JSON.stringify(rr))
if (rr.quality !== 'good') throw new Error('read_register quality mismatch: ' + JSON.stringify(rr))
if (rr.value !== 5555) throw new Error('read_register value mismatch: ' + JSON.stringify(rr))
console.log('read_register enriched:', JSON.stringify(rr))

// P1: get_device_snapshot（含别名/地址/类型/时间戳/质量）
const snap = await client.callTool({ name: 'get_device_snapshot', arguments: { device_id: obj.id } })
const snapArr = JSON.parse((snap.content[0] as any).text)
if (!Array.isArray(snapArr) || snapArr.length !== 2) throw new Error('snapshot length mismatch: ' + JSON.stringify(snapArr))
const s0 = snapArr.find((x: any) => x.register_id === reg0.id)
if (!s0 || s0.address !== reg0.startAddress || s0.quality !== 'good' || s0.value !== 5555 || !s0.timestamp) throw new Error('snapshot reg0 mismatch: ' + JSON.stringify(s0))
console.log('get_device_snapshot:', JSON.stringify(snapArr))

// P1: get_device_health
const health = await client.callTool({ name: 'get_device_health', arguments: { device_id: obj.id } })
const h = JSON.parse((health.content[0] as any).text)
if (typeof h.connected !== 'boolean' || typeof h.polling !== 'boolean' || !h.last_sample_time || h.register_count !== 2) throw new Error('health mismatch: ' + JSON.stringify(h))
console.log('get_device_health:', JSON.stringify(h))

// P1: list_alarm_rules（含 device_id 过滤）
const rulesAll = await client.callTool({ name: 'list_alarm_rules', arguments: {} })
const rulesArr = JSON.parse((rulesAll.content[0] as any).text)
if (!Array.isArray(rulesArr)) throw new Error('list_alarm_rules not array')
const rulesFiltered = await client.callTool({ name: 'list_alarm_rules', arguments: { device_id: obj.id } })
if (!Array.isArray(JSON.parse((rulesFiltered.content[0] as any).text))) throw new Error('list_alarm_rules filtered not array')
console.log('list_alarm_rules:', JSON.stringify(rulesAll.content))

// P1: query_history 应返回 quality
const hist = await client.callTool({ name: 'query_history', arguments: { device_id: obj.id, register_id: reg0.id, start: '2000-01-01T00:00:00Z', end: '2100-01-01T00:00:00Z' } })
const histArr = JSON.parse((hist.content[0] as any).text)
if (!Array.isArray(histArr) || histArr.length === 0) throw new Error('query_history empty: ' + JSON.stringify(histArr))
if (histArr[0].quality !== 'good' || histArr[0].value !== 5555) throw new Error('query_history quality mismatch: ' + JSON.stringify(histArr[0]))
console.log('query_history:', JSON.stringify(histArr))

await client.close()
console.log('MCP TEST OK')
process.exit(0)
