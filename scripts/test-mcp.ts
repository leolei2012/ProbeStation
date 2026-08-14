import { Context } from 'cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as modbusPlugin from '../packages/modbus/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'
import * as mcpPlugin from '../packages/mcp/src/index.ts'

const ctx = new Context()
await ctx.plugin(configPlugin, { dbPath: ':memory:' })
await ctx.plugin(storePlugin, { dbPath: ':memory:' })
await ctx.plugin(modbusPlugin, {})
await ctx.plugin(pollerPlugin, {})
await ctx.plugin(mcpPlugin, { host: '127.0.0.1', port: 18081 })

const cfg = ctx.get('config', false)
const obj = cfg.createObject('测试从站', '192.168.90.176', 8899)
const g = cfg.createGroup(obj.id, 'Holding', 3, 0, 10)
const reg0 = cfg.createRegister(g.id, obj.id, '寄存器0', 3, 0)
cfg.createRegister(g.id, obj.id, '寄存器1', 3, 1)

const store = ctx.get('store', false)
store.write([{ objectId: obj.id, registerId: reg0.id, timestamp: new Date().toISOString(), rawValue: 5555, quality: 'good' }])

await new Promise(r => setTimeout(r, 500))

const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18081/mcp'))
const client = new Client({ name: 'test', version: '1.0' })
await client.connect(transport)
console.log('MCP connected')

const tools = await client.listTools()
console.log('tools:', JSON.stringify(tools.tools.map(t => t.name)))

const r1 = await client.callTool({ name: 'list_devices', arguments: {} })
console.log('list_devices:', JSON.stringify(r1.content))

const r2 = await client.callTool({ name: 'read_register', arguments: { device_id: obj.id, register_id: reg0.id } })
console.log('read_register:', JSON.stringify(r2.content))

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

await client.close()
console.log('MCP TEST OK')
process.exit(0)
