import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

async function connectOnce(tag: string) {
  try {
    const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8081/mcp'))
    const client = new Client({ name: 'probe-' + tag, version: '1.0' })
    await client.connect(transport)
    const tools = await client.listTools()
    console.log(`[${tag}] 连接成功, tools=${tools.tools.length}`)
    await client.close()
    return true
  } catch (e: any) {
    console.log(`[${tag}] 失败: ${e.message.slice(0, 120)}`)
    return false
  }
}

await connectOnce('A')
await new Promise((r) => setTimeout(r, 500))
await connectOnce('B')
await new Promise((r) => setTimeout(r, 500))
await connectOnce('C')
process.exit(0)
