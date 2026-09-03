import type { Context } from 'cordis'
import z from 'schemastery'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z as zz } from 'zod'
import { areaForFunction, decodeRawByAddr, encodeRegister, functionCodeForArea, invertSemantic, parseEnum, registerWidth, resolveSemantic, smartParseCsv, type ModbusArea } from '@probebench/core'
import { Recorder } from './recorder.ts'

/** 把 RegisterRecord 映射成语义寄存器（factor/offset/unit/enum）。 */
function semanticOf(r: any) {
  return {
    dataType: r.dataType ?? 'int16',
    factor: typeof r.factor === 'number' ? r.factor : 1,
    offset: typeof r.offset === 'number' ? r.offset : 0,
    unit: r.unit ?? null,
    enumMap: parseEnum(r.enumJson),
  }
}

export const name = 'mcp'
export const inject = ['config', 'store', 'poller', 'ota', 'sink']

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
  const sink = (ctx as any).sink
  const recorder = new Recorder(ctx as any, cfg)

  /** 按设备、数据区和协议地址定位点，四数据区地址空间相互独立。 */
  const findRegisterByAddress = (deviceId: number, area: ModbusArea, address: number) =>
    cfg.listRegistersByObject(deviceId).find((r: any) => r.startAddress === address && areaForFunction(r.functionCode) === area)

  // 每个会话一个独立 McpServer：Protocol 只能连一个 transport，多会话/多连接必须各自实例。
  function registerTools(server: McpServer): void {
    server.registerTool('list_devices', {
      title: 'List devices', description: '列出所有监控设备（id、名称、IP、端口、启停状态）', inputSchema: {},
    }, async () => ({ content: [{ type: 'text', text: JSON.stringify(cfg.listObjects()) }] }))

    server.registerTool('create_device', {
      title: 'Create device', description: '新增一台监控设备（连接参数：TCP 填 ip/port，RTU 填 serial_path 及串口参数；slave 从站号、扫描间隔可选）。创建后该设备接入轮询（可在其下再 create_group/create_register 建点位）',
      inputSchema: {
        name: zz.string(),
        transport: zz.enum(['tcp', 'rtu']).optional(),
        ip: zz.string().optional(),
        port: zz.number().optional(),
        serial_path: zz.string().optional(),
        baud_rate: zz.number().optional(),
        parity: zz.string().optional(),
        stop_bits: zz.number().optional(),
        data_bits: zz.number().optional(),
        flow_control: zz.string().optional(),
        slave_id: zz.number().optional(),
        poll_interval_ms: zz.number().optional(),
        timeout_ms: zz.number().optional(),
        data_retain_seconds: zz.number().optional().nullable(),
      },
    }, async (args) => {
      const transport = args.transport ?? 'tcp'
      const name = String(args.name ?? '').trim()
      if (!name) return { content: [{ type: 'text', text: 'device name required' }], isError: true }
      // 连接参数基本校验（与 Web/API 新建一致）
      if (cfg.listObjects().some((o: any) => o.name === name)) return { content: [{ type: 'text', text: 'device name already exists: ' + name }], isError: true }
      const conn: any = {
        transport,
        slaveId: args.slave_id ?? 1,
        pollIntervalMs: args.poll_interval_ms ?? 1000,
        timeoutMs: args.timeout_ms ?? 3000,
        dataRetainSeconds: args.data_retain_seconds ?? null,
      }
      let ip = ''
      let port = 502
      if (transport === 'rtu') {
        if (!args.serial_path) return { content: [{ type: 'text', text: 'rtu device requires serial_path' }], isError: true }
        conn.serialPath = args.serial_path
        conn.baudRate = args.baud_rate ?? 9600
        conn.parity = args.parity ?? 'even'
        conn.stopBits = args.stop_bits ?? 1
        conn.dataBits = args.data_bits ?? 8
        conn.flowControl = args.flow_control ?? 'none'
      } else {
        if (!args.ip) return { content: [{ type: 'text', text: 'tcp device requires ip' }], isError: true }
        ip = args.ip
        port = args.port ?? 8899
      }
      const obj = cfg.createObject(name, ip, port, 'master', conn)
      cfg.log('INFO', 'mcp', 'create device ' + obj.id + ' ' + name)
      // createObject 已 emit config/changed，poller 若在跑会自动 refreshSchedule 纳入该设备
      return { content: [{ type: 'text', text: JSON.stringify(obj) }] }
    })

    server.registerTool('update_device', {
      title: 'Update device', description: '改设备连接/超时等字段（name/ip/port/serial_path/baud_rate/parity/slave_id/poll_interval_ms/timeout_ms…）；改完会重连该设备',
      inputSchema: {
        device_id: zz.number(),
        name: zz.string().optional(),
        ip: zz.string().optional(),
        port: zz.number().optional(),
        serial_path: zz.string().optional(),
        baud_rate: zz.number().optional(),
        parity: zz.string().optional(),
        stop_bits: zz.number().optional(),
        data_bits: zz.number().optional(),
        flow_control: zz.string().optional(),
        slave_id: zz.number().optional(),
        poll_interval_ms: zz.number().optional(),
        timeout_ms: zz.number().optional(),
      },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      const fields: Record<string, unknown> = {}
      const snake2camel: Record<string, string> = {
        name: 'name', ip: 'ip', port: 'port', transport: 'transport',
        serial_path: 'serialPath', baud_rate: 'baudRate', parity: 'parity', stop_bits: 'stopBits',
        data_bits: 'dataBits', flow_control: 'flowControl', slave_id: 'slaveId',
        poll_interval_ms: 'pollIntervalMs', timeout_ms: 'timeoutMs',
      }
      for (const [k, v] of Object.entries(args)) {
        if (k === 'device_id' || v === undefined) continue
        const mapped = snake2camel[k]
        if (mapped) fields[mapped] = v
      }
      const updated = cfg.updateObject(args.device_id, fields)
      try { await poller.reconnectDevice(args.device_id) } catch { /* 忽略 */ }
      cfg.log('INFO', 'mcp', 'update device ' + args.device_id)
      return { content: [{ type: 'text', text: JSON.stringify(updated) }] }
    })

    server.registerTool('get_raw_frames', {
      title: 'Get raw frames', description: '查设备串口/TCP 的原始 TX/RX 报文（最近 limit 帧，默认 200，上限 2000）：含时间/方向/slave/FC/hex',
      inputSchema: { device_id: zz.number(), limit: zz.number().optional() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      const limit = args.limit != null ? Math.max(0, Math.min(2000, Math.trunc(args.limit))) : 200
      const frames = poller.getDeviceFrames?.(args.device_id, limit) ?? []
      return { content: [{ type: 'text', text: JSON.stringify(frames) }] }
    })

    server.registerTool('clear_raw_frames', {
      title: 'Clear raw frames', description: '清空设备的原始报文诊断缓冲（TX/RX 帧与统计）',
      inputSchema: { device_id: zz.number() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      poller.clearDeviceDiagnostics?.(args.device_id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, device_id: args.device_id }) }] }
    })

    server.registerTool('get_device_stats', {
      title: 'Get device stats', description: '查单设备的历史采样统计：总行数 / 时间跨度 / 按数据区行数 / 保留时长',
      inputSchema: { device_id: zz.number() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      const s = await store.statsByObject(args.device_id)
      return { content: [{ type: 'text', text: JSON.stringify(s) }] }
    })

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
      title: 'Set poll interval', description: '设设备扫描间隔（毫秒，≥1 整数）。该设备所有分组按 round-robin 轮流轮询，每个分组约每「间隔 × 分组数」刷新一次；1ms 只是下限（=「尽可能快」）',
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

    server.registerTool('set_group_active', {
      title: 'Pause/resume group', description: '暂停或启用一个分组（active=true 开始轮询；active=false 暂停轮询）。状态同步到 Web UI',
      inputSchema: { group_id: zz.number(), active: zz.boolean() },
    }, async (args) => {
      if (!cfg.getGroup(args.group_id)) return { content: [{ type: 'text', text: 'group not found' }], isError: true }
      const updated = cfg.updateGroup(args.group_id, { isActive: args.active ? 1 : 0 })
      cfg.log('INFO', 'mcp', (args.active ? 'resume' : 'pause') + ' group ' + args.group_id)
      return { content: [{ type: 'text', text: JSON.stringify(updated) }] }
    })

    server.registerTool('read_register', {
      title: 'Read register', description: '按 Modbus 地址读某设备单个寄存器的实时值（address 即寄存器起始地址，无需数据库 id）',
      inputSchema: { device_id: zz.number(), area: zz.enum(['coil', 'discrete-input', 'holding-register', 'input-register']), address: zz.number() },
    }, async (args) => {
      const reg = findRegisterByAddress(args.device_id, args.area, args.address)
      if (!reg) return { content: [{ type: 'text', text: 'register not found at address ' + args.address }], isError: true }
      const latest = store.getLatestByObject(args.device_id, args.area)
      const rawByAddr: Record<number, number> = {}
      for (const k of Object.keys(latest)) rawByAddr[Number(k)] = latest[Number(k)].rawValue
      const decoded = decodeRawByAddr([reg], rawByAddr).get(reg.id) ?? null
      const lv = latest[reg.startAddress]
      // 语义翻译：enum 命中给 label，否则 ×factor+offset 给物理值
      let value: number | string | null = decoded === null ? null : (typeof decoded === 'bigint' ? String(decoded) : decoded)
      let unit: string | null = null
      let label: string | null = null
      if (decoded != null && typeof decoded !== 'bigint') {
        const s = resolveSemantic(semanticOf(reg), decoded)
        value = s.value; unit = s.unit; label = s.label
      }
      return { content: [{ type: 'text', text: JSON.stringify({ register_id: reg.id, area: args.area, address: reg.startAddress, alias: reg.alias, value, unit, label, timestamp: lv?.timestamp ?? null, quality: lv?.quality ?? null }) }] }
    })

    server.registerTool('get_device_snapshot', {
      title: 'Get device snapshot', description: '读某设备全部寄存器的实时值快照（含别名、地址、类型、时间戳、质量）',
      inputSchema: { device_id: zz.number() },
    }, async (args) => {
      const regs = cfg.listRegistersByObject(args.device_id)
      const latestAll = store.getLatestByObjectAll(args.device_id)
      const decoded = new Map<number, number | bigint>()
      for (const area of ['coil', 'discrete-input', 'holding-register', 'input-register'] as ModbusArea[]) {
        const subset = regs.filter((r: any) => areaForFunction(r.functionCode) === area)
        const rawByAddr: Record<number, number> = {}
        for (const [key, value] of Object.entries(latestAll) as Array<[string, any]>) if (key.startsWith(area + ':')) rawByAddr[Number(key.slice(area.length + 1))] = value.rawValue
        for (const [id, value] of decodeRawByAddr(subset, rawByAddr)) decoded.set(id, value)
      }
      const out = regs.map((r) => {
        const v = decoded.get(r.id) ?? null
        const area = areaForFunction(r.functionCode)
        const lv = latestAll[area + ':' + r.startAddress]
        let value: number | string | null = v === null ? null : (typeof v === 'bigint' ? String(v) : v)
        let unit: string | null = null
        let label: string | null = null
        if (v != null && typeof v !== 'bigint') {
          const s = resolveSemantic(semanticOf(r), v)
          value = s.value; unit = s.unit; label = s.label
        }
        return {
          register_id: r.id,
          alias: r.alias,
          address: r.startAddress,
          area,
          data_type: r.dataType,
          value,
          unit,
          label,
          timestamp: lv?.timestamp ?? null,
          quality: lv?.quality ?? null,
        }
      })
      return { content: [{ type: 'text', text: JSON.stringify(out) }] }
    })

    server.registerTool('query_history', {
      title: 'Query history', description: '查某寄存器的时间范围历史时序（按 area+address 定位，含语义翻译）',
      inputSchema: { device_id: zz.number(), area: zz.enum(['coil', 'discrete-input', 'holding-register', 'input-register']), address: zz.number(), start: zz.string(), end: zz.string() },
    }, async (args) => {
      const reg = findRegisterByAddress(args.device_id, args.area, args.address)
      if (!reg) return { content: [{ type: 'text', text: 'register not found at address ' + args.address }], isError: true }
      const points = await store.queryObject(args.device_id, args.start, args.end)
      const rawByTs = new Map<string, Record<number, number>>()
      const qualByTs = new Map<string, string>()
      for (const p of points) {
        if (p.area !== args.area) continue
        if (!rawByTs.has(p.ts)) rawByTs.set(p.ts, {})
        rawByTs.get(p.ts)![p.address] = p.rawValue
        if (p.address === reg.startAddress) qualByTs.set(p.ts, p.quality)
      }
      const out: Array<{ ts: string; value: number | string | null; unit: string | null; label: string | null; quality: string | null }> = []
      for (const [ts, rawByAddr] of rawByTs) {
        const v = decodeRawByAddr([reg], rawByAddr).get(reg.id) ?? null
        let value: number | string | null = v === null ? null : (typeof v === 'bigint' ? String(v) : v)
        let unit: string | null = null
        let label: string | null = null
        if (v != null && typeof v !== 'bigint') {
          const s = resolveSemantic(semanticOf(reg), v)
          value = s.value; unit = s.unit; label = s.label
        }
        out.push({ ts, value, unit, label, quality: qualByTs.get(ts) ?? null })
      }
      return { content: [{ type: 'text', text: JSON.stringify(out) }] }
    })

    server.registerTool('write_register', {
      title: 'Write register', description: '按 Modbus 地址写某设备寄存器（holding-register 用 FC06/FC16，coil 用 FC05/FC15；控制真机，危险操作）',
      inputSchema: { device_id: zz.number(), address: zz.number(), value: zz.number(), area: zz.enum(['coil', 'discrete-input', 'holding-register', 'input-register']).optional(), method: zz.enum(['single', 'multiple']).optional() },
    }, async (args) => {
      const area = (args.area ?? 'holding-register') as 'holding-register' | 'coil' | 'discrete-input' | 'input-register'
      if (area !== 'holding-register' && area !== 'coil') return { content: [{ type: 'text', text: 'only holding-register and coil are writable' }], isError: true }
      const reg = findRegisterByAddress(args.device_id, area, args.address)
      if (!reg) return { content: [{ type: 'text', text: 'register not found at address ' + args.address }], isError: true }
      // 物理值 → 逆变换（÷factor、−offset）→ 寄存器值 → 编码
      const raw = invertSemantic(semanticOf(reg), args.value)
      const words = encodeRegister(reg.dataType ?? 'int16', raw)
      const method = words.length > 1 ? 'multiple' : (args.method ?? 'multiple')
      const grp = cfg.getGroup(reg.groupId)
      await poller.write(reg.objectId, reg.startAddress, words, method, grp?.slaveId ?? 1, area)
      cfg.log('INFO', 'mcp', 'write ' + area + ' addr ' + args.address + ' = ' + args.value)
      return { content: [{ type: 'text', text: JSON.stringify({ register_id: reg.id, address: reg.startAddress, area, value: args.value, method }) }] }
    })

    server.registerTool('create_group', {
      title: 'Create group', description: '新建寄存器分组（名称/从站ID/功能码/起始地址/数量）',
      inputSchema: { device_id: zz.number(), name: zz.string(), function_code: zz.number().optional(), start_address: zz.number(), quantity: zz.number(), slave_id: zz.number().optional() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      const g = cfg.createGroup(args.device_id, args.name, args.function_code ?? 3, args.start_address, args.quantity, 'read', args.slave_id ?? 1)
      for (let i = 0; i < g.quantity; i++) cfg.createRegister(g.id, g.objectId, null, g.functionCode, g.startAddress + i, 'int16')
      cfg.log('INFO', 'mcp', 'create group ' + g.id + ' "' + g.name + '"')
      return { content: [{ type: 'text', text: JSON.stringify(g) }] }
    })

    server.registerTool('update_group', {
      title: 'Update group', description: '更改分组（名称/从站ID/功能码/起始地址/数量/启停）',
      inputSchema: { group_id: zz.number(), name: zz.string().optional(), slave_id: zz.number().optional(), function_code: zz.number().optional(), start_address: zz.number().optional(), quantity: zz.number().optional(), is_active: zz.number().optional() },
    }, async (args) => {
      if (!cfg.getGroup(args.group_id)) return { content: [{ type: 'text', text: 'group not found' }], isError: true }
      const fields: Record<string, unknown> = {}
      if (args.name !== undefined) fields.name = args.name
      if (args.slave_id !== undefined) fields.slaveId = args.slave_id
      if (args.function_code !== undefined) fields.functionCode = args.function_code
      if (args.start_address !== undefined) fields.startAddress = args.start_address
      if (args.quantity !== undefined) fields.quantity = args.quantity
      if (args.is_active !== undefined) fields.isActive = args.is_active
      const updated = cfg.updateGroup(args.group_id, fields)
      cfg.log('INFO', 'mcp', 'update group ' + args.group_id)
      return { content: [{ type: 'text', text: JSON.stringify(updated) }] }
    })

    server.registerTool('import_points', {
      title: 'Import points', description: '批量导入/更新寄存器语义，按 area+address 匹配已有寄存器。支持 JSON 点数组（points）或智能 CSV（csv：自动识别表头列、0x/40001 地址、类型/存储区）',
      inputSchema: { device_id: zz.number(), points: zz.array(zz.object({
        area: zz.enum(['coil', 'discrete-input', 'holding-register', 'input-register']),
        address: zz.number(),
        alias: zz.string().optional(),
        data_type: zz.string().optional(),
        unit: zz.string().optional(),
        factor: zz.number().optional(),
        offset: zz.number().optional(),
        enum: zz.record(zz.string()).optional(),
      })).optional(), csv: zz.string().optional() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      let rows: any[]
      let parseReport: any = null
      if (typeof args.csv === 'string') {
        const r = smartParseCsv(args.csv)
        rows = r.points
        parseReport = r.report
      } else if (Array.isArray(args.points)) {
        rows = args.points
      } else {
        return { content: [{ type: 'text', text: 'provide points (JSON array) or csv' }], isError: true }
      }
      const points = rows.map((p: any) => ({
        functionCode: functionCodeForArea(p.area),
        address: p.address,
        alias: p.alias ?? null,
        dataType: p.data_type ?? p.dataType,
        unit: p.unit ?? null,
        factor: p.factor,
        offset: p.offset,
        enumMap: p.enum ?? p.enumMap ?? null,
      }))
      const report = cfg.importPoints(args.device_id, points)
      cfg.log('INFO', 'mcp', 'import points device ' + args.device_id + ' => ' + JSON.stringify(report))
      return { content: [{ type: 'text', text: JSON.stringify(report) }] }
    })

    server.registerTool('export_points_xlsx', {
      title: 'Export point sheet (xlsx)', description: '把一台设备的点位点表导成 xlsx（每个寄存器分组单独一个 sheet），返回 base64 内容（"一个分组一个 sheet，便于查看/交接/回导"）',
      inputSchema: { device_id: zz.number() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      const { buffer, filename } = await sink.exportPointSheet(args.device_id)
      return { content: [{ type: 'text', text: JSON.stringify({ filename, b64: buffer.toString('base64'), bytes: buffer.length }) }] }
    })
    server.registerTool('import_points_xlsx', {
      title: 'Import point sheet (xlsx)', description: '把 export_points_xlsx 导出的、或手工整理成相同布局（每分组一个 sheet）的 xlsx 点表导回到设备：会重建该设备的全部分组/寄存器（同一位点全量覆盖）。传 content_b64',
      inputSchema: { device_id: zz.number(), content_b64: zz.string() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      const buf = Buffer.from(args.content_b64, 'base64')
      const res = await sink.importPointBook(args.device_id, buf, true)
      cfg.log('INFO', 'mcp', 'import points xlsx device ' + args.device_id + ' => ' + JSON.stringify(res))
      return { content: [{ type: 'text', text: JSON.stringify(res) }] }
    })

    server.registerTool('create_register', {
      title: 'Create register', description: '新增寄存器（别名/功能码/起始地址/类型/单位/缩放/枚举）',
      inputSchema: { group_id: zz.number(), alias: zz.string().optional(), function_code: zz.number().optional(), start_address: zz.number(), data_type: zz.string().optional(), unit: zz.string().optional(), factor: zz.number().optional(), offset: zz.number().optional(), enum: zz.record(zz.string()).optional() },
    }, async (args) => {
      const g = cfg.getGroup(args.group_id)
      if (!g) return { content: [{ type: 'text', text: 'group not found' }], isError: true }
      const dt = args.data_type ?? 'int16'
      if (args.start_address + registerWidth(dt) > g.startAddress + g.quantity) return { content: [{ type: 'text', text: 'dataType spans beyond group poll range' }], isError: true }
      const r = cfg.createRegister(args.group_id, g.objectId, args.alias ?? null, args.function_code ?? 3, args.start_address, dt, {
        unit: args.unit ?? null,
        factor: args.factor ?? 1,
        offset: args.offset ?? 0,
        enumJson: args.enum ? JSON.stringify(args.enum) : null,
      })
      cfg.log('INFO', 'mcp', 'create register ' + r.id)
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    })

    server.registerTool('update_register', {
      title: 'Update register', description: '更改寄存器（别名/类型/单位/缩放/枚举）',
      inputSchema: { register_id: zz.number(), alias: zz.string().optional(), data_type: zz.string().optional(), unit: zz.string().optional(), factor: zz.number().optional(), offset: zz.number().optional(), enum: zz.record(zz.string()).optional() },
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
      if (args.unit !== undefined) fields.unit = args.unit
      if (args.factor !== undefined) fields.factor = args.factor
      if (args.offset !== undefined) fields.offset = args.offset
      if (args.enum !== undefined) fields.enumJson = JSON.stringify(args.enum)
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
      const latest = store.getLatestByObjectAll(args.device_id)
      const ts = Object.values(latest).map((value: any) => value.timestamp ?? '').filter(Boolean).sort().pop() ?? null
      return { content: [{ type: 'text', text: JSON.stringify({
        device_id: obj.id,
        name: obj.name,
        ip: obj.ip,
        port: obj.port,
        mode: obj.mode,
        is_active: obj.isActive,
        connected: poller.isDeviceConnected(args.device_id),
        polling: obj.isActive === 1 && !poller.isPaused(args.device_id),
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

    // ── 连续采样 + 触发记录 ─────────────────────────
    server.registerTool('start_recording', {
      title: 'Start recording', description: '连续采样：以 interval_ms 间隔录 duration_ms 毫秒，事后 get_recording 回放（期间临时把设备扫描间隔调到 interval_ms，结束后恢复）。addresses 为 {area, address} 数组，缺省=全部',
      inputSchema: { device_id: zz.number(), interval_ms: zz.number(), duration_ms: zz.number(), addresses: zz.array(zz.object({ area: zz.enum(['coil', 'discrete-input', 'holding-register', 'input-register']), address: zz.number() })).optional() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      if (!Number.isInteger(args.interval_ms) || args.interval_ms < 1) return { content: [{ type: 'text', text: 'interval_ms must be an integer >= 1' }], isError: true }
      if (!Number.isInteger(args.duration_ms) || args.duration_ms < 1) return { content: [{ type: 'text', text: 'duration_ms must be a positive integer' }], isError: true }
      const id = recorder.startRecording(args.device_id, args.interval_ms, args.duration_ms, args.addresses)
      cfg.log('INFO', 'mcp', 'start recording ' + id + ' (device ' + args.device_id + ', ' + args.interval_ms + 'ms x ' + args.duration_ms + 'ms)')
      return { content: [{ type: 'text', text: JSON.stringify({ recording_id: id }) }] }
    })

    server.registerTool('start_trigger_recording', {
      title: 'Start trigger recording', description: '触发记录：trigger_area + trigger_address 满足 operator/阈值时，缓存触发前 before_ms + 触发后 after_ms 的采样。operator 支持 > < >= <= == != changed；addresses 为 {area, address} 数组，缺省=全部',
      inputSchema: { device_id: zz.number(), interval_ms: zz.number(), trigger_area: zz.enum(['coil', 'discrete-input', 'holding-register', 'input-register']), trigger_address: zz.number(), operator: zz.string(), threshold: zz.number().optional(), before_ms: zz.number(), after_ms: zz.number(), addresses: zz.array(zz.object({ area: zz.enum(['coil', 'discrete-input', 'holding-register', 'input-register']), address: zz.number() })).optional() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      if (!Number.isInteger(args.interval_ms) || args.interval_ms < 1) return { content: [{ type: 'text', text: 'interval_ms must be an integer >= 1' }], isError: true }
      const id = recorder.startTriggerRecording(args.device_id, args.interval_ms, args.trigger_area, args.trigger_address, args.operator, args.threshold ?? 0, args.before_ms ?? 0, args.after_ms ?? 0, args.addresses)
      cfg.log('INFO', 'mcp', 'start trigger recording ' + id + ' (device ' + args.device_id + ', trigger addr ' + args.trigger_address + ' ' + args.operator + ' ' + (args.threshold ?? 0) + ')')
      return { content: [{ type: 'text', text: JSON.stringify({ recording_id: id }) }] }
    })

    server.registerTool('get_recording', {
      title: 'Get recording', description: '取某次录制的完整采样序列（samples 为原始 16 位字，消费端按类型解码）',
      inputSchema: { recording_id: zz.string() },
    }, async (args) => {
      const rec = recorder.getRecording(args.recording_id)
      if (!rec) return { content: [{ type: 'text', text: 'recording not found' }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify(rec) }] }
    })

    server.registerTool('list_recordings', {
      title: 'List recordings', description: '列出录制会话（不含 samples，用 get_recording 取详情）',
      inputSchema: {},
    }, async () => ({ content: [{ type: 'text', text: JSON.stringify(recorder.listRecordings()) }] }))

    server.registerTool('stop_recording', {
      title: 'Stop recording', description: '提前结束录制（触发记录可用它取消）',
      inputSchema: { recording_id: zz.string() },
    }, async (args) => {
      const ok = recorder.stopRecording(args.recording_id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok, recording_id: args.recording_id }) }] }
    })

    server.registerTool('delete_recording', {
      title: 'Delete recording', description: '删除一段录制（释放内存；录制中会先结束）',
      inputSchema: { recording_id: zz.string() },
    }, async (args) => {
      const ok = recorder.deleteRecording(args.recording_id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok, recording_id: args.recording_id }) }] }
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
