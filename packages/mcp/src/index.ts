import type { Context } from 'cordis'
import z from 'schemastery'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z as zz } from 'zod'
import { decodeRawByAddr, encodeRegister, registerWidth } from '@probebench/core'

export const name = 'mcp'
export const inject = ['config', 'store', 'poller', 'ota']

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
  const ota = (ctx as any).ota

  // 每个会话一个独立 McpServer：Protocol 只能连一个 transport，多会话/多连接必须各自实例。
  function registerTools(server: McpServer): void {
    server.registerTool('list_devices', {
      title: 'List devices', description: '列出所有监控设备（id、名称、IP、端口、启停状态）', inputSchema: {},
    }, async () => ({ content: [{ type: 'text', text: JSON.stringify(cfg.listObjects()) }] }))

    server.registerTool('list_registers', {
      title: 'List registers', description: '列出某设备的寄存器定义（id、别名、地址、类型）',
      inputSchema: { device_id: zz.number() },
    }, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(cfg.listRegistersByObject(args.device_id)) }] }))

    server.registerTool('set_device_active', {
      title: 'Connect/disconnect device', description: '连接或断开设备（active=true 连接并打开串口/开始轮询；active=false 断开并关闭串口/停止轮询）。状态会通过 config/changed 事件同步到 Web UI',
      inputSchema: { device_id: zz.number(), active: zz.boolean() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      const updated = cfg.updateObject(args.device_id, { isActive: args.active ? 1 : 0 })
      cfg.log('INFO', 'mcp', (args.active ? 'connect' : 'disconnect') + ' device ' + args.device_id)
      return { content: [{ type: 'text', text: JSON.stringify(updated) }] }
    })

    server.registerTool('set_poll_interval', {
      title: 'Set poll interval', description: '设设备采样周期（毫秒，≥1 整数）。该设备所有组统一用这个周期；实际最快受 Modbus 通信往返限制，1ms 只是下限（=「尽可能快」）',
      inputSchema: { device_id: zz.number(), poll_interval_ms: zz.number() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      if (!Number.isInteger(args.poll_interval_ms) || args.poll_interval_ms < 1) {
        return { content: [{ type: 'text', text: 'poll_interval_ms must be an integer >= 1' }], isError: true }
      }
      cfg.updateObject(args.device_id, { pollIntervalMs: args.poll_interval_ms })
      cfg.log('INFO', 'mcp', 'set poll interval ' + args.poll_interval_ms + 'ms for device ' + args.device_id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, device_id: args.device_id, poll_interval_ms: args.poll_interval_ms }) }] }
    })

    server.registerTool('read_register', {
      title: 'Read register', description: '读某设备单个寄存器的实时值',
      inputSchema: { device_id: zz.number(), register_id: zz.number() },
    }, async (args) => {
      const reg = cfg.getRegister(args.register_id)
      if (!reg || reg.objectId !== args.device_id) return { content: [{ type: 'text', text: 'register not found' }], isError: true }
      const latest = store.getLatestByObject(args.device_id)
      const rawByAddr: Record<number, number> = {}
      for (const k of Object.keys(latest)) rawByAddr[Number(k)] = latest[Number(k)].rawValue
      const v = decodeRawByAddr([reg], rawByAddr).get(reg.id) ?? null
      const lv = latest[reg.startAddress]
      return { content: [{ type: 'text', text: JSON.stringify({ register_id: reg.id, address: reg.startAddress, value: typeof v === 'bigint' ? String(v) : v, timestamp: lv?.timestamp ?? null, quality: lv?.quality ?? null }) }] }
    })

    server.registerTool('get_device_snapshot', {
      title: 'Get device snapshot', description: '读某设备全部寄存器的实时值快照（含别名、地址、类型、时间戳、质量）',
      inputSchema: { device_id: zz.number() },
    }, async (args) => {
      const regs = cfg.listRegistersByObject(args.device_id)
      const latest = store.getLatestByObject(args.device_id)
      const rawByAddr: Record<number, number> = {}
      for (const k of Object.keys(latest)) rawByAddr[Number(k)] = latest[Number(k)].rawValue
      const decoded = decodeRawByAddr(regs, rawByAddr)
      const out = regs.map((r) => {
        const v = decoded.get(r.id) ?? null
        const lv = latest[r.startAddress]
        return {
          register_id: r.id,
          alias: r.alias,
          address: r.startAddress,
          data_type: r.dataType,
          value: typeof v === 'bigint' ? String(v) : v,
          timestamp: lv?.timestamp ?? null,
          quality: lv?.quality ?? null,
        }
      })
      return { content: [{ type: 'text', text: JSON.stringify(out) }] }
    })

    server.registerTool('query_history', {
      title: 'Query history', description: '查某寄存器的时间范围历史时序',
      inputSchema: { device_id: zz.number(), register_id: zz.number(), start: zz.string(), end: zz.string() },
    }, async (args) => {
      const reg = cfg.getRegister(args.register_id)
      if (!reg) return { content: [{ type: 'text', text: 'register not found' }], isError: true }
      const points = await store.queryObject(args.device_id, args.start, args.end)
      const rawByTs = new Map<string, Record<number, number>>()
      const qualByTs = new Map<string, string>()
      for (const p of points) {
        if (!rawByTs.has(p.ts)) rawByTs.set(p.ts, {})
        rawByTs.get(p.ts)![p.address] = p.rawValue
        if (p.address === reg.startAddress) qualByTs.set(p.ts, p.quality)
      }
      const out: Array<{ ts: string; value: string | number | null; quality: string | null }> = []
      for (const [ts, rawByAddr] of rawByTs) {
        const v = decodeRawByAddr([reg], rawByAddr).get(reg.id) ?? null
        out.push({ ts, value: typeof v === 'bigint' ? String(v) : v, quality: qualByTs.get(ts) ?? null })
      }
      return { content: [{ type: 'text', text: JSON.stringify(out) }] }
    })

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

    server.registerTool('get_device_health', {
      title: 'Get device health', description: '查某设备的连接状态、轮询是否在跑、最近采样时间',
      inputSchema: { device_id: zz.number() },
    }, async (args) => {
      const obj = cfg.getObject(args.device_id)
      if (!obj) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      const latest = store.getLatestByObject(args.device_id)
      const ts = Object.keys(latest).map((k) => latest[Number(k)].timestamp ?? '').filter(Boolean).sort().pop() ?? null
      return { content: [{ type: 'text', text: JSON.stringify({
        device_id: obj.id,
        name: obj.name,
        ip: obj.ip,
        port: obj.port,
        mode: obj.mode,
        is_active: obj.isActive,
        connected: poller.isDeviceConnected(args.device_id),
        polling: poller.isRunning(),
        poll_interval_ms: obj.pollIntervalMs,
        data_retain_seconds: obj.dataRetainSeconds,
        last_sample_time: ts,
        register_count: cfg.listRegistersByObject(args.device_id).length,
      }) }] }
    })

    server.registerTool('set_data_retention', {
      title: 'Set data retention', description: '设历史数据保留时长（秒，0=永久）。缺省 device_id 设全局，否则设该设备覆盖（覆盖优先于全局）',
      inputSchema: { retention_seconds: zz.number(), device_id: zz.number().optional() },
    }, async (args) => {
      if (!Number.isInteger(args.retention_seconds) || args.retention_seconds < 0) {
        return { content: [{ type: 'text', text: 'retention_seconds must be a non-negative integer' }], isError: true }
      }
      if (args.device_id != null) {
        if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
        cfg.updateObject(args.device_id, { dataRetainSeconds: args.retention_seconds })
      } else {
        store.setRetentionSeconds(args.retention_seconds)
      }
      cfg.log('INFO', 'mcp', 'set data retention ' + args.retention_seconds + 's' + (args.device_id != null ? ' for device ' + args.device_id : ' (global)'))
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
    })

    server.registerTool('get_data_retention', {
      title: 'Get data retention', description: '查当前生效的保留时长（秒，0=永久）。缺省 device_id 返回全局，否则返回该设备生效值（设备覆盖优先）',
      inputSchema: { device_id: zz.number().optional() },
    }, async (args) => {
      if (args.device_id != null) {
        const obj = cfg.getObject(args.device_id)
        if (!obj) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
        const v = obj.dataRetainSeconds != null ? obj.dataRetainSeconds : store.getRetentionSeconds()
        return { content: [{ type: 'text', text: JSON.stringify({ retention_seconds: v }) }] }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ retention_seconds: store.getRetentionSeconds() }) }] }
    })

    server.registerTool('list_alarm_rules', {
      title: 'List alarm rules', description: '查看已配置的告警规则（可按设备过滤）',
      inputSchema: { device_id: zz.number().optional() },
    }, async (args) => {
      let rules = cfg.listRules()
      if (args.device_id != null) {
        rules = rules.filter((r) => {
          const reg = cfg.getRegister(r.registerId)
          return reg != null && reg.objectId === args.device_id
        })
      }
      return { content: [{ type: 'text', text: JSON.stringify(rules) }] }
    })

    // ── OTA 固件升级（PRD 07）─────────────────────
    server.registerTool('upload_firmware', {
      title: 'Upload firmware', description: '上传固件（base64，建议 <1MB；大文件走 HTTP POST /api/firmware/upload 原始二进制）',
      inputSchema: { name: zz.string(), version: zz.string().optional(), content_base64: zz.string() },
    }, async (args) => {
      const content = Buffer.from(args.content_base64, 'base64')
      const r = ota.uploadFirmware(args.name, args.version ?? '', content)
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    })

    server.registerTool('list_firmwares', {
      title: 'List firmwares', description: '查已上传的固件列表',
      inputSchema: {},
    }, async () => ({ content: [{ type: 'text', text: JSON.stringify(ota.listFirmwares()) }] }))

    server.registerTool('ota_upgrade', {
      title: 'OTA upgrade', description: '发起固件升级（异步，立即返回 task_id；升级失败可能导致设备不可用）',
      inputSchema: { device_id: zz.number(), firmware_id: zz.number(), chunk_size: zz.number().optional() },
    }, async (args) => {
      const r = ota.startUpgrade(args.device_id, args.firmware_id, args.chunk_size)
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    })

    server.registerTool('ota_status', {
      title: 'OTA status', description: '查升级进度（发起后用 ota_status 轮询）',
      inputSchema: { device_id: zz.number() },
    }, async (args) => {
      const s = ota.getStatus(args.device_id) as any
      return { content: [{ type: 'text', text: JSON.stringify({ state: s.state, current_block: s.currentBlock ?? 0, total_blocks: s.totalBlocks ?? 0, percent: s.percent ?? 0, ...(s.error ? { error: s.error } : {}) }) }] }
    })

    server.registerTool('ota_abort', {
      title: 'OTA abort', description: '中止升级（可选）',
      inputSchema: { device_id: zz.number() },
    }, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(ota.abort(args.device_id)) }] }))
  }

  function createServer(): McpServer {
    const server = new McpServer({ name: 'probestation', version: '0.1.0' })
    registerTools(server)
    return server
  }

  // 每个会话一个 transport（有状态模式）：客户端断开后会话被清理，新连接可正常重新 initialize，不再「already initialized」卡死。
  const transports = new Map<string, StreamableHTTPServerTransport>()

  const httpServer = http.createServer((req, res) => {
    const handle = (parsed?: unknown) => {
      const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? undefined
      let transport: StreamableHTTPServerTransport | undefined = sessionId ? transports.get(sessionId) : undefined

      if (!transport) {
        const isInit = Array.isArray(parsed) ? parsed.some(isInitializeRequest) : isInitializeRequest(parsed)
        if (!isInit) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session ID provided' }, id: null }))
          return
        }
        const srv = createServer()
        const t = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => { transports.set(sid, t) },
        })
        t.onclose = () => { const sid = t.sessionId; if (sid) transports.delete(sid) }
        void srv.connect(t)
        transport = t
      }

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

  ctx.provide('mcp', { createServer })
}
