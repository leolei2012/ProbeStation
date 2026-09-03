import { Context } from 'cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as modbusPlugin from '../packages/modbus/src/index.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'
import * as otaPlugin from '../packages/ota/src/index.ts'
import * as mcpPlugin from '../packages/mcp/src/index.ts'

// 自包含复现：同一 MCP 服务器进程内连续连接/断开三次（对应规格报告 P0 会话卡死 bug）
const ctx = new Context()
await ctx.plugin(configPlugin, { dbPath: ':memory:' })
await ctx.plugin(storePlugin, { dbPath: ':memory:' })
await ctx.plugin(modbusPlugin, {})
await ctx.plugin(pollerPlugin, {})
await ctx.plugin(otaPlugin)
await ctx.plugin(mcpPlugin, { host: '127.0.0.1', port: 18082 })

await new Promise((r) => setTimeout(r, 300))

async function connectOnce(tag: string): Promise<number> {
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:18082/mcp'))
  const client = new Client({ name: 'probe-' + tag, version: '1.0' })
  await client.connect(transport)
  const tools = await client.listTools()
  console.log(`[${tag}] 连接成功, tools=${tools.tools.length}`)
  await client.close()
  return tools.tools.length
}

const a = await connectOnce('A')
await new Promise((r) => setTimeout(r, 300))
const b = await connectOnce('B')
await new Promise((r) => setTimeout(r, 300))
const c = await connectOnce('C')

if (a === 0 || a !== b || b !== c) throw new Error('tool count mismatch: ' + [a, b, c].join(','))
console.log('MCP RECONNECT TEST OK')
process.exit(0)
