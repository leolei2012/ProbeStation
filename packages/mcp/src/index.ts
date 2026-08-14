import type { Context } from 'cordis'
import z from 'schemastery'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z as zz } from 'zod'
import { encodeRegister, registerWidth } from '@probebench/core'

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

  server.registerTool('create_group', {
    title: 'Create group', description: '新建寄存器分组（名称/从站ID/功能码/起始地址/数量/扫描间隔）',
    inputSchema: { device_id: zz.number(), name: zz.string(), function_code: zz.number().optional(), start_address: zz.number(), quantity: zz.number(), slave_id: zz.number().optional(), poll_interval_ms: zz.number().optional() },
  }, async (args) => {
    if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
    const g = cfg.createGroup(args.device_id, args.name, args.function_code ?? 3, args.start_address, args.quantity, 'read', args.slave_id ?? 1, args.poll_interval_ms ?? 1000)
    for (let i = 0; i < g.quantity; i++) cfg.createRegister(g.id, g.objectId, null, g.functionCode, g.startAddress + i, 'int16')
    cfg.log('INFO', 'mcp', 'create group ' + g.id + ' "' + g.name + '"')
    return { content: [{ type: 'text', text: JSON.stringify(g) }] }
  })

  server.registerTool('update_group', {
    title: 'Update group', description: '更改分组（名称/从站ID/功能码/起始地址/数量/扫描间隔/启停）',
    inputSchema: { group_id: zz.number(), name: zz.string().optional(), slave_id: zz.number().optional(), function_code: zz.number().optional(), start_address: zz.number().optional(), quantity: zz.number().optional(), poll_interval_ms: zz.number().optional(), is_active: zz.number().optional() },
  }, async (args) => {
    if (!cfg.getGroup(args.group_id)) return { content: [{ type: 'text', text: 'group not found' }], isError: true }
    const fields: Record<string, unknown> = {}
    if (args.name !== undefined) fields.name = args.name
    if (args.slave_id !== undefined) fields.slaveId = args.slave_id
    if (args.function_code !== undefined) fields.functionCode = args.function_code
    if (args.start_address !== undefined) fields.startAddress = args.start_address
    if (args.quantity !== undefined) fields.quantity = args.quantity
    if (args.poll_interval_ms !== undefined) fields.pollIntervalMs = args.poll_interval_ms
    if (args.is_active !== undefined) fields.isActive = args.is_active
    const updated = cfg.updateGroup(args.group_id, fields)
    cfg.log('INFO', 'mcp', 'update group ' + args.group_id)
    return { content: [{ type: 'text', text: JSON.stringify(updated) }] }
  })

  server.registerTool('create_register', {
    title: 'Create register', description: '新增寄存器（别名/功能码/起始地址/类型）',
    inputSchema: { group_id: zz.number(), alias: zz.string().optional(), function_code: zz.number().optional(), start_address: zz.number(), data_type: zz.string().optional() },
  }, async (args) => {
    const g = cfg.getGroup(args.group_id)
    if (!g) return { content: [{ type: 'text', text: 'group not found' }], isError: true }
    const dt = args.data_type ?? 'int16'
    if (args.start_address + registerWidth(dt) > g.startAddress + g.quantity) return { content: [{ type: 'text', text: 'dataType spans beyond group poll range' }], isError: true }
    const r = cfg.createRegister(args.group_id, g.objectId, args.alias ?? null, args.function_code ?? 3, args.start_address, dt)
    cfg.log('INFO', 'mcp', 'create register ' + r.id)
    return { content: [{ type: 'text', text: JSON.stringify(r) }] }
  })

  server.registerTool('update_register', {
    title: 'Update register', description: '更改寄存器（别名/类型）',
    inputSchema: { register_id: zz.number(), alias: zz.string().optional(), data_type: zz.string().optional() },
  }, async (args) => {
    const r = cfg.getRegister(args.register_id)
    if (!r) return { content: [{ type: 'text', text: 'register not found' }], isError: true }
    const fields: Record<string, unknown> = {}
    if (args.alias !== undefined) fields.alias = args.alias
    if (args.data_type !== undefined) {
      const grp = cfg.getGroup(r.groupId)
      if (grp && r.startAddress + registerWidth(args.data_type) > grp.startAddress + grp.quantity) return { content: [{ type: 'text', text: 'dataType spans beyond group poll range' }], isError: true }
      fields.dataType = args.data_type
    }
    const updated = cfg.updateRegister(args.register_id, fields)
    cfg.log('INFO', 'mcp', 'update register ' + args.register_id)
    return { content: [{ type: 'text', text: JSON.stringify(updated) }] }
  })

  server.registerTool('delete_register', {
    title: 'Delete register', description: '删除寄存器',
    inputSchema: { register_id: zz.number() },
  }, async (args) => {
    if (!cfg.getRegister(args.register_id)) return { content: [{ type: 'text', text: 'register not found' }], isError: true }
    cfg.deleteRegister(args.register_id)
    cfg.log('INFO', 'mcp', 'delete register ' + args.register_id)
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, register_id: args.register_id }) }] }
  })

  server.registerTool('delete_group', {
    title: 'Delete group', description: '删除分组（连同其寄存器）',
    inputSchema: { group_id: zz.number() },
  }, async (args) => {
    if (!cfg.getGroup(args.group_id)) return { content: [{ type: 'text', text: 'group not found' }], isError: true }
    cfg.deleteGroup(args.group_id)
    cfg.log('INFO', 'mcp', 'delete group ' + args.group_id)
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, group_id: args.group_id }) }] }
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
