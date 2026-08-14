import type { Context } from 'cordis'
import z from 'schemastery'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z as zz } from 'zod'

export const name = 'mcp'
export const inject = ['config', 'store', 'poller']

export interface Config { host: string; port: number }
export const Config: z<Config> = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().default(8081),
})

/** MCP 服务器：把 ProbeStation 能力暴露成 MCP 工具（streamable-http，独立端口）。 */
export function apply(ctx: Context, config: Config): void {
  const cfg = (ctx as any).config
  const store = (ctx as any).store
  const poller = (ctx as any).poller

  const server = new McpServer({ name: 'probestation', version: '0.1.0' })

  server.registerTool('list_devices', {
    title: 'List devices', description: '列出所有监控设备（id、名称、IP、端口、启停状态）', inputSchema: {},
  }, async () => ({ content: [{ type: 'text', text: JSON.stringify(cfg.listObjects()) }] }))

  server.registerTool('list_registers', {
    title: 'List registers', description: '列出某设备的寄存器定义（id、别名、地址、类型）',
    inputSchema: { device_id: zz.number() },
  }, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(cfg.listRegistersByObject(args.device_id)) }] }))

  server.registerTool('read_register', {
    title: 'Read register', description: '读某设备单个寄存器的实时值',
    inputSchema: { device_id: zz.number(), register_id: zz.number() },
  }, async (args) => {
    const reg = cfg.getRegister(args.register_id)
    if (!reg || reg.objectId !== args.device_id) return { content: [{ type: 'text', text: 'register not found' }], isError: true }
    const v = store.getLatest()[args.register_id] ?? null
    return { content: [{ type: 'text', text: JSON.stringify(v) }] }
  })

  server.registerTool('read_all', {
    title: 'Read all registers', description: '读某设备全部寄存器的实时值快照',
    inputSchema: { device_id: zz.number() },
  }, async (args) => {
    const regs = cfg.listRegistersByObject(args.device_id)
    const latest = store.getLatest()
    const out: Record<number, unknown> = {}
    for (const r of regs) out[r.id] = latest[r.id] ?? null
    return { content: [{ type: 'text', text: JSON.stringify(out) }] }
  })

  server.registerTool('query_history', {
    title: 'Query history', description: '查某寄存器的时间范围历史时序',
    inputSchema: { device_id: zz.number(), register_id: zz.number(), start: zz.string(), end: zz.string() },
  }, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await store.query(args.device_id, args.register_id, args.start, args.end)) }] }))

  server.registerTool('write_register', {
    title: 'Write register', description: '写某设备单个寄存器（FC16，控制真机，危险操作）',
    inputSchema: { device_id: zz.number(), register_id: zz.number(), value: zz.number() },
  }, async (args) => {
    const reg = cfg.getRegister(args.register_id)
    if (!reg || reg.objectId !== args.device_id) return { content: [{ type: 'text', text: 'register not found' }], isError: true }
    const words = encodeRegister(reg.dataType ?? 'int16', args.value)
    await poller.write(reg.objectId, reg.startAddress, words, 'multiple')
    cfg.log('INFO', 'mcp', 'write register ' + args.register_id + ' = ' + args.value)
    return { content: [{ type: 'text', text: JSON.stringify({ register_id: args.register_id, value: args.value }) }] }
  })

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
  void server.connect(transport)

  const httpServer = http.createServer((req, res) => {
    const handle = (parsed?: unknown) => {
      void transport.handleRequest(req, res, parsed).catch((e: any) => {
        console.error('MCP handleRequest error:', e?.message ?? e, '| stack:', e?.stack?.split('\n')[1] ?? '')
        if (!res.headersSent) { res.statusCode = 500; res.end() }
      })
    }
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        let parsed: unknown
        try { parsed = body ? JSON.parse(body) : undefined } catch { parsed = undefined }
        handle(parsed)
      })
    } else {
      handle()
    }
  })
  httpServer.listen(config.port, config.host, () => {
    ctx.logger('mcp').info('MCP server on http://' + config.host + ':' + config.port + '/mcp')
  })

  ctx.provide('mcp', server)
}
