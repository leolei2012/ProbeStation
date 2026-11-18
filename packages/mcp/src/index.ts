import { normalizeSemanticPoint } from '../../core/src/semantic-import.ts'
import { diagnoseDevicePoints } from '../../core/src/point-diagnostics.ts'
import { selectSourceRegister } from '../../core/src/register-selection.ts'
import { sourceSample, withRegisterSources } from '../../core/src/sample-source.ts'
import { decodeHistoricalSample, decodeLatestSample } from '../../core/src/history-integrity.ts'
import type { Context } from 'cordis'
import z from 'schemastery'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { z as zz } from 'zod'
import { areaForFunction, parseEnum, registerWidth, resolveSemantic, smartParseCsv, type ModbusArea } from '@probebench/core'
import { Recorder, MAX_RECORDING_PAGE_SIZE } from './recorder.ts'
import { registerConfigEditTools } from './config-edit.ts'
import { configEditRegistrar } from './config-edit-registry.ts'
import { toolRegistrar } from './tool-registrar.ts'
import { mcpWriteRegister } from './register-write.ts'
import type { AlarmRule } from '../../core/src/alarm.ts'
import { registerAlarmTools } from './alarm-settings.ts'
import { registerResourceCleanup, throwCleanupErrors } from '../../core/src/resource-close.ts'

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
  port: z.number().default(9091),
})

/** MCP 服务器：把 ProbeStation 能力暴露成 MCP 工具（streamable-http，独立端口）。 */
export function apply(ctx: Context, config: Config): void {
  const cfg = (ctx as any).config
  const store = (ctx as any).store
  const poller = (ctx as any).poller
  const ota = (ctx as any).ota
  const sink = (ctx as any).sink
  const recorder = new Recorder(ctx as any, cfg)
  let closing = false
  const active = new Set<Promise<unknown>>()
  const track = <T,>(action: () => T | Promise<T>): Promise<T> => {
    if (closing) return Promise.reject(new Error('MCP is closing or closed'))
    const task = Promise.resolve().then(() => { if (closing) throw new Error('MCP is closing or closed'); return action() })
    active.add(task); void task.then(() => active.delete(task), () => active.delete(task)); return task
  }
  const logCompleted = (message: string): void => {
    try { cfg.log('INFO', 'mcp', message) }
    catch {
      try { ctx.logger('mcp').warn('操作调用已完成，但操作日志结果待核实；勿因日志故障重复操作。') } catch { /* Diagnostics cannot change a completed operation. */ }
    }
  }
  const syncCommittedDevice = async (): Promise<void> => {
    try { await ctx.get('deviceSlaves', false)?.sync() }
    catch (error) { throw new Error('配置操作已提交，但从站运行时同步未完成；请核对当前配置和运行状态，勿重复操作。', { cause: error }) }
  }
  const timeRange = (start: string, end: string) => {
    if (!/(Z|[+-]\d{2}:\d{2})$/i.test(start) || !/(Z|[+-]\d{2}:\d{2})$/i.test(end)) throw new Error('时间必须为带时区的 ISO 字符串')
    const from = new Date(start), to = new Date(end)
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) throw new Error('时间范围无效')
    return { start: from.toISOString(), end: to.toISOString() }
  }

  const sourceRegisters = (id: number) => withRegisterSources<any>(cfg.listRegistersByObject(id), cfg.listGroups(id), cfg.getObject(id))
  const findSourceRegister = (id: number, area: ModbusArea, address: number, slaveId?: number, registerId?: number) =>
    selectSourceRegister(sourceRegisters(id), { area, address, slaveId, registerId })

  // 每个会话一个独立 McpServer：Protocol 只能连一个 transport，多会话/多连接必须各自实例。
  function registerTools(server: McpServer): void {
    const tools = toolRegistrar(server)
    registerConfigEditTools(configEditRegistrar(server), cfg, { reconnect: id => poller.reconnectDevice(id), syncSlaves: async () => ctx.get('deviceSlaves', false)?.sync() })
    tools.registerTool('list_devices', {
      title: 'List devices', description: '列出所有设备的 id、名称、mode（master/slave）、连接参数和启停状态；实时连接/监听状态用 get_device_health 查询。', inputSchema: {},
    }, async () => ({ content: [{ type: 'text', text: JSON.stringify(cfg.listObjects()) }] }))

    tools.registerTool('create_device', {
      title: 'Create device', description: '新增 TCP/RTU 设备。mode=master（默认）主动轮询；mode=slave 监听外部主站，TCP ip/port 是本机监听地址/端口，RTU 使用独占串口，slave_id 是从站号。扫描间隔与读写超时只用于主站。',
      inputSchema: {
        name: zz.string(),
        mode: zz.enum(['master', 'slave']).optional(),
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
      const obj = cfg.createObject(name, ip, port, args.mode ?? 'master', conn)
      await syncCommittedDevice()
      logCompleted('create device ' + obj.id + ' ' + name)
      // createObject 已 emit config/changed，poller 若在跑会自动 refreshSchedule 纳入该设备
      return { content: [{ type: 'text', text: JSON.stringify(obj) }] }
    })

    tools.registerTool('delete_device', {
      title: 'Delete device', description: '删除指定设备及其分组、点位、告警，停止连接/从站监听；保留历史数据，可用 delete_history 单独清理。不可撤销。',
      annotations: { destructiveHint: true }, inputSchema: { device_id: zz.number().int().positive() },
    }, async args => {
      if (!cfg.getObject(args.device_id)) throw new Error('设备不存在')
      cfg.deleteObject(args.device_id)
      await syncCommittedDevice()
      logCompleted('delete device ' + args.device_id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, device_id: args.device_id, history_preserved: true }) }] }
    })

    tools.registerTool('get_raw_frames', {
      title: 'Get raw frames', description: '查主站串口/TCP 原始 TX/RX 报文（最近 limit 帧，默认 200，上限 2000）：含时间/方向/slave/FC/hex。从站尚无报文缓冲，使用 get_device_health 的 slave_service 查询监听状态。',
      inputSchema: { device_id: zz.number(), limit: zz.number().optional() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      const limit = args.limit != null ? Math.max(0, Math.min(2000, Math.trunc(args.limit))) : 200
      const frames = poller.getDeviceFrames?.(args.device_id, limit) ?? []
      return { content: [{ type: 'text', text: JSON.stringify(frames) }] }
    })

    tools.registerTool('clear_raw_frames', {
      title: 'Clear raw frames', description: '清空设备的原始报文诊断缓冲（TX/RX 帧与统计）',
      inputSchema: { device_id: zz.number() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      poller.clearDeviceDiagnostics?.(args.device_id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, device_id: args.device_id }) }] }
    })

    tools.registerTool('get_device_stats', {
      title: 'Get device stats', description: '查单设备的历史采样统计：总行数 / 时间跨度 / 按数据区行数 / 保留时长',
      inputSchema: { device_id: zz.number() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      const s = await store.statsByObject(args.device_id)
      return { content: [{ type: 'text', text: JSON.stringify(s) }] }
    })

    tools.registerTool('list_registers', {
      title: 'List registers', description: '列出某设备的寄存器定义（id、别名、地址、类型）',
      inputSchema: { device_id: zz.number() },
    }, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(cfg.listRegistersByObject(args.device_id)) }] }))

    tools.registerTool('diagnose_points', {
      title: 'Diagnose point table', description: '只读离线检查当前点表结构：dtype宽度/分组/地址边界、引用错误、重复定义、重叠组和语义导入歧义。区分错误和警告，覆盖占位行兼容；不改配置、不连接/轮询硬件，不代表设备在线或测试通过。',
      inputSchema: { device_id: zz.number().int().min(1).max(Number.MAX_SAFE_INTEGER) },
    }, async (args) => {
      try { return { content: [{ type: 'text', text: JSON.stringify(diagnoseDevicePoints(cfg, args.device_id)) }] } }
      catch (error: any) { return { content: [{ type: 'text', text: error.statusCode === 400 || error.statusCode === 404 ? error.message : '点表诊断失败' }], isError: true } }
    })

    tools.registerTool('set_device_active', {
      title: 'Start/stop device', description: '主站：active=true 连接并轮询，false 停止；从站：true 启动监听，false 停止监听。停止再启动从站保留本次程序运行期间的内存值。',
      inputSchema: { device_id: zz.number(), active: zz.boolean() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      const updated = cfg.updateObject(args.device_id, { isActive: args.active ? 1 : 0 })
      await syncCommittedDevice()
      logCompleted((args.active ? 'connect' : 'disconnect') + ' device ' + args.device_id)
      return { content: [{ type: 'text', text: JSON.stringify(updated) }] }
    })

    tools.registerTool('set_poll_interval', {
      title: 'Set poll interval', description: '设设备扫描间隔（毫秒，≥1 整数）。该设备所有分组按 round-robin 轮流轮询，每个分组约每「间隔 × 分组数」刷新一次；1ms 只是下限（=「尽可能快」）',
      inputSchema: { device_id: zz.number(), poll_interval_ms: zz.number() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      if (cfg.getObject(args.device_id).mode === 'slave') return { content: [{ type: 'text', text: '从站等待主站读写，没有扫描间隔' }], isError: true }
      if (!Number.isInteger(args.poll_interval_ms) || args.poll_interval_ms < 1) {
        return { content: [{ type: 'text', text: 'poll_interval_ms must be an integer >= 1' }], isError: true }
      }
      cfg.updateObject(args.device_id, { pollIntervalMs: args.poll_interval_ms })
      logCompleted('set poll interval ' + args.poll_interval_ms + 'ms for device ' + args.device_id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, device_id: args.device_id, poll_interval_ms: args.poll_interval_ms }) }] }
    })

    tools.registerTool('set_group_active', {
      title: 'Pause/resume group', description: '暂停或启用一个分组（active=true 开始轮询；active=false 暂停轮询）。状态同步到 Web UI',
      inputSchema: { group_id: zz.number(), active: zz.boolean() },
    }, async (args) => {
      if (!cfg.getGroup(args.group_id)) return { content: [{ type: 'text', text: 'group not found' }], isError: true }
      const updated = cfg.updateGroup(args.group_id, { isActive: args.active ? 1 : 0 })
      logCompleted((args.active ? 'resume' : 'pause') + ' group ' + args.group_id)
      return { content: [{ type: 'text', text: JSON.stringify(updated) }] }
    })

    tools.registerTool('read_register', {
      title: 'Read register', description: '按设备/area/协议地址读取缓存，不主动请求硬件。可选 slave_id 或 register_id 精确选点；两者同时给出必须一致。省略时仅唯一匹配可读，歧义返回 candidates；同从站重复定义需 register_id。',
      inputSchema: { device_id: zz.number(), area: zz.enum(['coil', 'discrete-input', 'holding-register', 'input-register']), address: zz.number(), slave_id: zz.number().int().min(0).max(255).optional(), register_id: zz.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional() },
    }, async (args) => {
      const selection = findSourceRegister(args.device_id, args.area, args.address, args.slave_id, args.register_id)
      if ('error' in selection) return { content: [{ type: 'text', text: JSON.stringify(selection) }], isError: true }
      const reg = selection.register
      const latest = store.getLatestByObject(args.device_id, args.area, reg.slaveId)
      const assessment = decodeLatestSample(reg, Array.from({ length: registerWidth(reg.dataType) }, (_, i) => ({ ...latest[reg.startAddress + i], address: reg.startAddress + i })))
      const decoded = assessment.automaticEligible ? assessment.value : null
      const lv = latest[reg.startAddress]
      // 语义翻译：enum 命中给 label，否则 ×factor+offset 给物理值
      let value: number | string | null = decoded === null ? null : (typeof decoded === 'bigint' ? String(decoded) : decoded)
      let unit: string | null = null
      let label: string | null = null
      if (decoded != null && typeof decoded !== 'bigint') {
        const s = resolveSemantic(semanticOf(reg), decoded)
        value = s.value; unit = s.unit; label = s.label
      }
      return { content: [{ type: 'text', text: JSON.stringify({ register_id: reg.id, area: args.area, address: reg.startAddress, alias: reg.alias, slave_id: reg.slaveId ?? null, verification: assessment.verification, automatic_eligible: assessment.automaticEligible, value, unit, label, timestamp: lv?.timestamp ?? null, quality: lv?.quality ?? null }) }] }
    })

    tools.registerTool('get_device_snapshot', {
      title: 'Get device snapshot', description: '读某设备全部寄存器的实时值快照（含别名、地址、类型、时间戳、质量）',
      inputSchema: { device_id: zz.number() },
    }, async (args) => {
      const regs = sourceRegisters(args.device_id)
      const latestAll = store.getLatestByObjectAll(args.device_id)
      const decoded = new Map<number, number | bigint>()
      const assessments = new Map<number, ReturnType<typeof decodeLatestSample>>()
      for (const r of regs) {
        const area = areaForFunction(r.functionCode)
        const words = Array.from({ length: registerWidth(r.dataType) }, (_, i) => ({ ...sourceSample<any>(latestAll, '', area, r.startAddress + i, r.slaveId), address: r.startAddress + i }))
        const result = decodeLatestSample(r, words)
        assessments.set(r.id, result)
        if (result.automaticEligible) decoded.set(r.id, result.value!)
      }
      const out = regs.map((r) => {
        const v = decoded.get(r.id) ?? null
        const area = areaForFunction(r.functionCode)
        const lv = sourceSample<any>(latestAll, '', area, r.startAddress, r.slaveId)
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
          slave_id: r.slaveId ?? null,
          verification: assessments.get(r.id)?.verification ?? 'unknown',
          automatic_eligible: assessments.get(r.id)?.automaticEligible ?? false,
          value,
          unit,
          label,
          timestamp: lv?.timestamp ?? null,
          quality: lv?.quality ?? null,
        }
      })
      return { content: [{ type: 'text', text: JSON.stringify(out) }] }
    })

    tools.registerTool('query_history', {
      title: 'Query history', description: '按设备/area/协议地址查原始历史，可选 slave_id/register_id 精确选点，冲突不回退，歧义返回 candidates。返回原始16位字及仅已验证的单字语义 value；多字仍不自动合并。limit 默认2000/上限200000，offset 分页，NULL来源不补齐。',
      inputSchema: { device_id: zz.number(), area: zz.enum(['coil', 'discrete-input', 'holding-register', 'input-register']), address: zz.number(), slave_id: zz.number().int().min(0).max(255).optional(), register_id: zz.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(), start: zz.string(), end: zz.string(), limit: zz.number().optional(), offset: zz.number().optional() },
    }, async (args) => {
      const selection = findSourceRegister(args.device_id, args.area, args.address, args.slave_id, args.register_id)
      if ('error' in selection) return { content: [{ type: 'text', text: JSON.stringify(selection) }], isError: true }
      const reg = selection.register
      const limit = args.limit != null ? Math.max(1, Math.min(200000, Math.trunc(args.limit))) : 2000
      const offset = args.offset != null ? Math.max(0, Math.trunc(args.offset)) : 0
      // 单地址精确查询（走 (object_id, ts) 索引 + area/address 过滤），并支持 offset 分页，超大范围也能翻页取全。
      const points = await store.queryWithOffset(args.device_id, args.address, args.start, args.end, args.area, limit, offset, reg.slaveId)
      const sem = semanticOf(reg)
      const width = registerWidth(reg.dataType ?? 'int16')
      const out = points.map((p: { ts: string; rawValue: number; quality: string; batchId?: string | null; slaveId?: number | null }) => {
        // 单字类型直接解码；多字类型（width>1）需相邻地址，此处只返回起始地址的原始字，由消费端按 register_width 组合
        let decoded: number | bigint | null = null
        const assessment = decodeHistoricalSample(reg, [{ ...p, address: reg.startAddress }])
        if (width === 1 && assessment.automaticEligible) decoded = assessment.value
        let value: number | string | null = decoded === null ? null : (typeof decoded === 'bigint' ? String(decoded) : decoded)
        let unit: string | null = null
        let label: string | null = null
        if (decoded != null && typeof decoded !== 'bigint') {
          const s = resolveSemantic(sem, decoded)
          value = s.value; unit = s.unit; label = s.label
        }
        return { ts: p.ts, raw_value: p.rawValue, value, unit, label, quality: p.quality, batch_id: p.batchId ?? null, slave_id: p.slaveId ?? null, verification: assessment.verification, automatic_eligible: assessment.automaticEligible, compatibility_value: assessment.verification === 'unverified' ? String(assessment.value) : null, data_type: reg.dataType ?? 'int16', register_width: width, factor: sem.factor, offset: sem.offset }
      })
      return { content: [{ type: 'text', text: JSON.stringify({ register_id: reg.id, slave_id: reg.slaveId ?? null, group_id: reg.groupId ?? null, alias: reg.alias, area: args.area, address: reg.startAddress, register_width: width, count: points.length, offset, warning: 'Unverified compatibility values are view-only; never automatic PASS/FAIL evidence. Multiword values are unavailable in this raw-word endpoint.', points: out }) }] }
    })

    tools.registerTool('write_register', {
      title: 'Write register', boundDeviceWrite: true,
      description: '来源绑定写入主站保持寄存器（TCP/RTU）：method single=FC06、multiple=FC16（默认），多字类型仅FC16。value_mode默认physical，反算factor/offset；raw直接写原始值。整数/hex16/64位可传字符串。slave_id/register_id精确选点，歧义返回候选且不发送。建议为每条指令传唯一UUID request_id；重用只返回原回执，不重发。检查state：acknowledged仅协议确认，unknown须现场核实，不能盲目重发。用get_register_write_result查询结果。',
      inputSchema: { device_id: zz.number().int().positive(), address: zz.number().int().min(0).max(65535), value: zz.union([zz.number(), zz.string()]),
        area: zz.enum(['coil', 'discrete-input', 'holding-register', 'input-register']).optional(), method: zz.enum(['single', 'multiple']).optional(),
        slave_id: zz.number().int().min(1).max(247).optional(), register_id: zz.number().int().positive().optional(),
        value_mode: zz.enum(['physical', 'raw']).optional(), request_id: zz.string().uuid().optional() },
    }, async (args) => {
      try {
        const result = await mcpWriteRegister(cfg, poller, args) as { error?: string; state?: string }
        return { content: [{ type: 'text', text: JSON.stringify(result) }], ...((result.error || result.state === 'not-sent' || result.state === 'unknown') ? { isError: true } : {}) }
      } catch (error: any) {
        let pending
        if (error.code === 'REGISTER_WRITE_BLOCKED') try { pending = cfg.listPendingRegisterWrites(args.device_id) } catch { /* Preserve original refusal if metadata is unavailable. */ }
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error.message, code: error.code, status: error.statusCode, pending }) }] }
      }
    })

    tools.registerTool('get_register_write_result', {
      title: 'Get register write result', description: '按写入回执id或request_id查询原操作，不发送指令。prepared过期自动记为not-sent；unknown请现场核实，不应自动重发。',
      annotations: { readOnlyHint: true }, inputSchema: { operation_id: zz.string().uuid() },
    }, async args => {
      try { return { content: [{ type: 'text', text: JSON.stringify(cfg.getRegisterWrite(args.operation_id.toLowerCase())) }] } }
      catch (error: any) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error.message, status: error.statusCode }) }] } }
    })

    tools.registerTool('list_pending_register_writes', {
      title: 'List pending register writes', description: '查询设备当前物理通道上的sending/unknown写入，包含同串口其他设备/点位的旧操作、固定来源、值和错误；重启后仍可发现。不发指令，不解除阻塞。',
      annotations: { readOnlyHint: true }, inputSchema: { device_id: zz.number().int().positive() },
    }, async args => {
      try { return { content: [{ type: 'text', text: JSON.stringify(cfg.listPendingRegisterWrites(args.device_id)) }] } }
      catch (error: any) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error.message, status: error.statusCode }) }] } }
    })
    tools.registerTool('review_register_write_result', {
      title: 'Review unknown register write', description: '只在用户明确确认已核实该旧指令对应的设备状态后调用。将unknown记为reviewed-unknown解除阻塞，不发送/重发旧指令，不写入新值。禁止把当前读数、超时或重启自动当成人工核实；sending或仍在执行的操作拒绝解除。先list_pending_register_writes核对原设备、从站、地址和值。',
      inputSchema: { device_id: zz.number().int().positive(), operation_id: zz.string().uuid(), confirmed_on_site: zz.literal(true) },
    }, async args => {
      try {
        const id = args.operation_id.toLowerCase(), pending = cfg.listPendingRegisterWrites(args.device_id)
        if (!pending.operations.some((row: { id: string }) => row.id === id)) throw Object.assign(new Error('原操作不在该设备当前通道的未完成列表中，请重新查询。'), { statusCode: 409 })
        if (poller.isBoundRegisterWriteRunning?.(id)) throw Object.assign(new Error('原写入仍在执行，不能解除。'), { statusCode: 409 })
        return { content: [{ type: 'text', text: JSON.stringify(cfg.reviewUnknownRegisterWrite(id)) }] }
      } catch (error: any) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error.message, status: error.statusCode }) }] } }
    })

    tools.registerTool('export_history', {
      title: 'Export history', description: '导出设备指定时间范围的历史，格式 CSV/XLSX，返回文件名和 base64；可选择 register_ids（必须属于设备），tz_offset_min 是展示时区相对 UTC 的分钟数，例如中国 +480。时间必须带时区。',
      annotations: { readOnlyHint: true },
      inputSchema: { device_id: zz.number().int().positive(), start: zz.string(), end: zz.string(), format: zz.enum(['csv', 'xlsx']).optional(), register_ids: zz.array(zz.number().int().positive()).min(1).optional(), tz_offset_min: zz.number().int().min(-840).max(840).optional() },
    }, async args => {
      if (!cfg.getObject(args.device_id)) throw new Error('设备不存在')
      const range = timeRange(args.start, args.end), format = args.format ?? 'csv'
      if (args.register_ids?.some(id => cfg.getRegister(id)?.objectId !== args.device_id)) throw new Error('点位不存在或不属于该设备')
      await store.flush()
      const buffer = format === 'csv' ? Buffer.from(await sink.exportCsv(args.device_id, range.start, range.end, args.register_ids, args.tz_offset_min ?? 0), 'utf8') : await sink.exportXlsx(args.device_id, range.start, range.end, args.register_ids, args.tz_offset_min ?? 0)
      return { content: [{ type: 'text', text: JSON.stringify({ filename: `device-${args.device_id}-history.${format}`, mime: format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: buffer.length, b64: buffer.toString('base64'), ...range }) }] }
    })
    tools.registerTool('delete_history', {
      title: 'Delete history', description: '按设备 ID 和带时区起止时间（包含两端）删除历史。dry_run 默认 true，只预览行数；false 实际删除。可清理已删除设备的遗留历史。保留配置和实时缓存，运行中的设备仍会产生新数据。',
      annotations: { destructiveHint: true },
      inputSchema: { device_id: zz.number().int().positive(), start: zz.string(), end: zz.string(), dry_run: zz.boolean().optional() },
    }, async args => {
      const range = timeRange(args.start, args.end)
      const result = await store.deleteHistory(args.device_id, range.start, range.end, args.dry_run ?? true)
      if (!result.dryRun) logCompleted(`delete history device ${args.device_id}: ${range.start} - ${range.end}, ${result.affectedRows} rows`)
      return { content: [{ type: 'text', text: JSON.stringify({ device_id: args.device_id, ...range, dry_run: result.dryRun, affected_rows: result.affectedRows }) }] }
    })

    tools.registerTool('create_group', {
      title: 'Create group', description: '新建寄存器分组（名称/从站ID/功能码/起始地址/数量）',
      inputSchema: { device_id: zz.number(), name: zz.string(), function_code: zz.number().optional(), start_address: zz.number(), quantity: zz.number(), slave_id: zz.number().optional() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      const device = cfg.getObject(args.device_id)
      const g = cfg.createGroup(args.device_id, args.name, args.function_code ?? 3, args.start_address, args.quantity, 'read', device.mode === 'slave' ? device.slaveId : args.slave_id ?? 1)
      for (let i = 0; i < g.quantity; i++) cfg.createRegister(g.id, g.objectId, null, g.functionCode, g.startAddress + i, 'int16')
      logCompleted('create group ' + g.id + ' "' + g.name + '"')
      return { content: [{ type: 'text', text: JSON.stringify(g) }] }
    })

    tools.registerTool('import_points', {
      title: 'Import points', description: '更新已有点位语义，支持JSON或CSV。可选slave_id/register_id精确选点，歧义跳过并返回候选，不任选来源；省略字段/CSV缺列不重置原配置。unit/enum显式null可清除。有效行原子提交，检查updated/skipped/errors/details/warnings。',
      inputSchema: { device_id: zz.number(), points: zz.array(zz.object({
        area: zz.enum(['coil', 'discrete-input', 'holding-register', 'input-register']),
        address: zz.number(),
        slave_id: zz.number().int().min(0).max(255).optional(),
        register_id: zz.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
        alias: zz.string().optional(),
        data_type: zz.string().optional(),
        unit: zz.string().nullable().optional(),
        factor: zz.number().optional(),
        offset: zz.number().optional(),
        enum: zz.record(zz.string()).nullable().optional(),
      })).optional(), csv: zz.string().optional() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      let rows: any[]
      let parseReport: any = null
      if (typeof args.csv === 'string') {
        const r = smartParseCsv(args.csv, { partial: true })
        rows = r.points
        parseReport = r.report
      } else if (Array.isArray(args.points)) {
        rows = args.points
      } else {
        return { content: [{ type: 'text', text: 'provide points (JSON array) or csv' }], isError: true }
      }
      const points = rows.map(normalizeSemanticPoint)
      const result = cfg.importPoints(args.device_id, points)
      const report = parseReport ? { ...result, parse: parseReport } : result
      try { cfg.log('INFO', 'mcp', 'import points device ' + args.device_id + ' => ' + JSON.stringify(report)) }
      catch { report.warnings.push('点表导入已处理，但日志写入失败；请核对返回结果，勿自动重复导入。') }
      return { content: [{ type: 'text', text: JSON.stringify(report) }] }
    })

    tools.registerTool('export_points_xlsx', {
      title: 'Export point sheet (xlsx)', description: '导出v2点位表：设备信息、分组页、告警页，返回base64。页签唯一，点位L/告警H为文件内标识（非数据库ID），支持同页同地址多定义各自告警；告警阈值仍为解码原始值。',
      inputSchema: { device_id: zz.number() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      const { buffer, filename } = await sink.exportPointSheet(args.device_id)
      return { content: [{ type: 'text', text: JSON.stringify({ filename, b64: buffer.toString('base64'), bytes: buffer.length }) }] }
    })
    tools.registerTool('import_points_xlsx', {
      title: 'Import point sheet (xlsx)', description: '导入v2点位表（须含告警页，无告警保留表头），事务覆盖设备组/点位/告警。L/H文件内点位标识需一致，重复/冲突/失效拒绝；旧无标识时只接受唯一匹配，不猜告警归属。错误保留原配置。传content_b64，检查errors/warnings；警告可能表示已提交，不要自动重试。',
      inputSchema: { device_id: zz.number(), content_b64: zz.string() },
    }, async (args) => {
      if (!cfg.getObject(args.device_id)) return { content: [{ type: 'text', text: 'device not found' }], isError: true }
      const buf = Buffer.from(args.content_b64, 'base64')
      const res = await sink.importPointBook(args.device_id, buf, true)
      try { cfg.log('INFO', 'mcp', 'import points xlsx device ' + args.device_id + ' => ' + JSON.stringify(res)) }
      catch { res.warnings.push('点位表导入已处理，但MCP日志写入失败；请核对返回结果，勿自动重复导入。') }
      return { content: [{ type: 'text', text: JSON.stringify(res) }] }
    })

    tools.registerTool('create_register', {
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
      logCompleted('create register ' + r.id)
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    })

    tools.registerTool('delete_register', {
      title: 'Delete register', description: '删除寄存器',
      inputSchema: { register_id: zz.number() },
    }, async (args) => {
      if (!cfg.getRegister(args.register_id)) return { content: [{ type: 'text', text: 'register not found' }], isError: true }
      cfg.deleteRegister(args.register_id)
      logCompleted('delete register ' + args.register_id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, register_id: args.register_id }) }] }
    })

    tools.registerTool('delete_group', {
      title: 'Delete group', description: '删除分组（连同其寄存器）',
      inputSchema: { group_id: zz.number() },
    }, async (args) => {
      if (!cfg.getGroup(args.group_id)) return { content: [{ type: 'text', text: 'group not found' }], isError: true }
      cfg.deleteGroup(args.group_id)
      logCompleted('delete group ' + args.group_id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, group_id: args.group_id }) }] }
    })

    tools.registerTool('get_device_health', {
      title: 'Get device health', description: '查看设备角色及健康状态。主站 connected 表示连接；从站 connected 表示监听已启动，slave_service 含请求/连接数和服务错误，没有客户端连接不代表故障。从站 polling=false。',
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
        polling: obj.mode !== 'slave' && obj.isActive === 1 && !poller.isPaused(args.device_id),
        poll_interval_ms: obj.mode === 'slave' ? null : obj.pollIntervalMs,
        ...(obj.mode === 'slave' ? { slave_service: ctx.get('deviceSlaves', false)?.status(obj.id) ?? null } : {}),
        data_retain_seconds: obj.dataRetainSeconds,
        last_sample_time: ts,
        register_count: cfg.listRegistersByObject(args.device_id).length,
      }) }] }
    })

    tools.registerTool('set_data_retention', {
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
      logCompleted('set data retention ' + args.retention_seconds + 's' + (args.device_id != null ? ' for device ' + args.device_id : ' (global)'))
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
    })

    tools.registerTool('get_data_retention', {
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

    tools.registerTool('list_alarm_rules', {
      title: 'List alarm rules', description: '查看已配置的告警规则（可按设备过滤）',
      inputSchema: { device_id: zz.number().optional() },
    }, async (args) => {
      let rules: AlarmRule[] = cfg.listRules()
      if (args.device_id != null) {
        rules = rules.filter((r) => {
          const reg = cfg.getRegister(r.registerId)
          return reg != null && reg.objectId === args.device_id
        })
      }
      return { content: [{ type: 'text', text: JSON.stringify(rules) }] }
    })

    registerAlarmTools(configEditRegistrar(server), cfg)

    tools.registerTool('ask_ai', {
      title: 'Ask configured AI', description: '向软件设置中保存的 AI 提问，复用提供商认证；可指定 provider/model/effort，并附 context 或 device_id（全部点位配置与缓存快照）。单次咨询，无工具执行、不修改配置，不加入界面聊天。会消耗提供商 API 额度。回答是模型建议，不能当作已验证的设备事实。',
      inputSchema: { question: zz.string().min(1), context: zz.string().min(1).optional(), device_id: zz.number().int().positive().optional(), provider: zz.string().optional(), model: zz.string().optional(), effort: zz.enum(['default', 'off', 'max', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional() },
    }, async args => {
      const api = ctx.get('api', false)
      if (!api) throw new Error('AI 服务未启动，请启用 REST/AI 服务并配置模型')
      const { device_id, ...input } = args
      const response = await api.inject({ method: 'POST', url: '/api/ai/ask', headers: { 'x-probestation-ai': '1' }, payload: { ...input, ...(device_id === undefined ? {} : { deviceId: device_id }) } })
      const result = response.json()
      if (response.statusCode >= 400) throw new Error(result.message ?? result.error ?? 'AI 提问失败')
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    })

    // ── 连续采样 + 触发记录 ─────────────────────────
    const sourceId = zz.number().int().min(0).max(255).optional()
    const recordingAddresses = zz.array(zz.object({ area: zz.enum(['coil', 'discrete-input', 'holding-register', 'input-register']), address: zz.number().int().min(0).max(65535), slave_id: sourceId })).optional()
    const addressSelection = (addresses: Array<{ area: string; address: number; slave_id?: number }> | undefined) => addresses?.map(a => ({ area: a.area, address: a.address, slaveId: a.slave_id }))
    const recordingResult = (id: string) => {
      const rec = recorder.getRecording(id)!
      return { content: [{ type: 'text' as const, text: JSON.stringify({ recording_id: id, slave_id: rec.slaveId, addresses: rec.addresses, trigger: rec.trigger, warnings: [...rec.warnings], status: rec.status, completion_reason: rec.completionReason, quota_truncated: rec.quotaTruncated, sample_storage: recorder.getSampleStorageStatus() }) }] }
    }
    const recordingLog = (id: string, message: string) => { if (recorder.getRecording(id)?.status !== 'recording') return; try { cfg.log('INFO', 'mcp', message) } catch { recorder.getRecording(id)!.warnings.push('录制已开始，但操作日志写入失败；勿重复开始。') } }
    const recordingError = (error: unknown) => ({ content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'invalid recording request' }], isError: true })
    tools.registerTool('start_recording', {
      title: 'Start recording', description: '连续录制原始16位字；每段默认最多200000样本、全局保留500000样本，容量不足提前结束并报告quota_truncated/completion_reason及当前事件丢弃数；删除已结束录制可释放容量。连接来源条件改变/无法核实时提前结束并保留数据，不自动归还周期。临时改变设备扫描间隔，最后会话结束时仅在写入身份/配置未变化才原子恢复；否则保留当前值并返回intervalRestore/warnings。slave_id 为默认录制来源，addresses[].slave_id 可覆盖；无地址/来源筛选时保留所有来源。省略地址来源仅在配置唯一时接受，歧义需显式选择。回放保留 slaveId/batchId，缺来源不补全。',
      inputSchema: { device_id: zz.number(), interval_ms: zz.number(), duration_ms: zz.number(), slave_id: sourceId, addresses: recordingAddresses },
    }, async (args) => {
      try {
        const id = recorder.startRecording(args.device_id, args.interval_ms, args.duration_ms, addressSelection(args.addresses), args.slave_id)
        recordingLog(id, 'start recording ' + id + ' (device ' + args.device_id + ', ' + args.interval_ms + 'ms x ' + args.duration_ms + 'ms)')
        return recordingResult(id)
      } catch (error) { return recordingError(error) }
    })

    tools.registerTool('start_trigger_recording', {
      title: 'Start trigger recording', description: '按原始16位字触发（不合并dtype/不换算物理值）；每段默认200000、全局保留500000样本上限，容量不足提前结束并明确标记部分记录。缓存 before_ms/after_ms。trigger_slave_id 选择触发从站，缺省继承 slave_id 或唯一配置；歧义拒绝。slave_id/addresses[].slave_id 仅筛选录制数据，独立于触发选择。来源不明、坏质量、重复候选、无效/倒序时间不能触发。连接来源条件改变/无法核实时提前结束并保留数据，不自动归还周期。会临时改变设备扫描间隔。',
      inputSchema: { device_id: zz.number(), interval_ms: zz.number(), trigger_area: zz.enum(['coil', 'discrete-input', 'holding-register', 'input-register']), trigger_address: zz.number(), trigger_slave_id: sourceId, slave_id: sourceId, operator: zz.string(), threshold: zz.number().optional(), before_ms: zz.number(), after_ms: zz.number(), addresses: recordingAddresses },
    }, async (args) => {
      try {
        const id = recorder.startTriggerRecording(args.device_id, args.interval_ms, args.trigger_area, args.trigger_address, args.operator, args.threshold ?? 0, args.before_ms, args.after_ms, addressSelection(args.addresses), args.slave_id, args.trigger_slave_id)
        recordingLog(id, 'start trigger recording ' + id + ' (device ' + args.device_id + ', source ' + recorder.getRecording(id)!.trigger!.slaveId + ', trigger addr ' + args.trigger_address + ' ' + args.operator + ' ' + (args.threshold ?? 0) + ')')
        return recordingResult(id)
      } catch (error) { return recordingError(error) }
    })

    tools.registerTool('get_recording', {
      title: 'Get recording', description: '旧兼容全量读取，仍返回全部保留样本；大段/新调用优先get_recording_page分页，活动进度用list_recordings。取录制保留的原始16位字、slaveId/batchId 与触发证据 triggeredBy。检查completionReason/quotaTruncated/discardedSamples；done不是请求时长或触发窗口完整的证明。多字消费需自行验证同来源/area/采样时间/完整批次及质量；sourceVerified 仅表示来源元数据存在，不能当自动 PASS/FAIL。NULL 来源不推断。',
      inputSchema: { recording_id: zz.string() },
    }, async (args) => {
      const rec = recorder.getRecording(args.recording_id)
      if (!rec) return { content: [{ type: 'text', text: 'recording not found' }], isError: true }
      return { content: [{ type: 'text', text: JSON.stringify(rec) }] }
    })

    tools.registerTool('get_recording_page', {
      title: 'Read a completed recording page', description: '只读分页已结束录制，默认200、最多1000个保留原始样本。从offset=0开始，续页必须携带原snapshot_id并使用nextOffset；当前配置活动录制拒绝，不为分页停止；配置重开沿用旧会话终结规则。hasMore=false仅表示当前页之后无保留样本，不证明此前页已读或录制完整；须检查recording.completionReason/quotaTruncated及来源/批次质量；snapshotId用于分页身份，采样批次仍取各样本batchId。configurationScopeCurrent仅表示打开配置scope；不证明点表/连接未编辑，为false时属于此前配置。删除/淘汰返回错误，不降级全量读取、不重录。',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { recording_id: zz.string().min(1), offset: zz.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), limit: zz.number().int().min(1).max(MAX_RECORDING_PAGE_SIZE).optional(), snapshot_id: zz.string().uuid().optional() },
    }, async args => {
      try { return { content: [{ type: 'text', text: JSON.stringify(recorder.getRecordingPage(args.recording_id, args.offset, args.limit, args.snapshot_id)) }] } }
      catch (error: any) {
        const known = [400, 404, 409, 428].includes(error?.statusCode)
        return { content: [{ type: 'text', text: JSON.stringify({ status: known ? error.statusCode : 500, code: known ? error.code : 'RECORDING_PAGE_READ_FAILED', error: known ? error.message : '录制分页读取失败，请核对后重读。' }) }], isError: true }
      }
    })

    tools.registerTool('get_recording_interval_status', { title: 'Review recording intervals', description: '只读当前设备间隔、活动录制及本进程最近保留的未恢复/待核对记录；删除/淘汰样本仍保留核对记录。current是本次配置读取，不代表硬件实测频率；不恢复间隔。核对后通过现有设备编辑有条件修改，禁止盲目写回原值。', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { device_id: zz.number().int().positive().max(Number.MAX_SAFE_INTEGER) } }, async args => {
      try { return { content: [{ type: 'text', text: JSON.stringify(recorder.getRecordingIntervalStatus(args.device_id)) }] } } catch { return { content: [{ type: 'text', text: '录制间隔状态未核实，请重新读取。' }], isError: true } }
    })

    tools.registerTool('list_recordings', {
      title: 'List recordings', description: '列出录制会话和完成原因（不含samples）；大段已结束结果优先get_recording_page分页，旧get_recording保持全量。',
      inputSchema: {},
    }, async () => ({ content: [{ type: 'text', text: JSON.stringify(recorder.listRecordings()) }] }))

    tools.registerTool('stop_recording', {
      title: 'Stop recording', description: '提前结束录制；只在原间隔写入身份有效时恢复，冲突保留当前值。返回interval_restore/warnings；ok只表示找到会话，不证明已恢复。',
      inputSchema: { recording_id: zz.string() },
    }, async (args) => {
      const ok = recorder.stopRecording(args.recording_id), rec = recorder.getRecording(args.recording_id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok, recording_id: args.recording_id, interval_restore: rec?.intervalRestore ?? null, warnings: rec?.warnings ?? [], completion_reason: rec?.completionReason ?? null, quota_truncated: rec?.quotaTruncated ?? false, discarded_samples: rec?.discardedSamples ?? 0 }) }] }
    })

    tools.registerTool('delete_recording', {
      title: 'Delete recording', description: '删除一段录制（释放内存；录制中会先结束）',
      inputSchema: { recording_id: zz.string() },
    }, async (args) => {
      const rec = recorder.getRecording(args.recording_id), ok = recorder.deleteRecording(args.recording_id)
      return { content: [{ type: 'text', text: JSON.stringify({ ok, recording_id: args.recording_id, interval_restore: rec?.intervalRestore ?? null, warnings: rec?.warnings ?? [], completion_reason: rec?.completionReason ?? null, quota_truncated: rec?.quotaTruncated ?? false, discarded_samples: rec?.discardedSamples ?? 0 }) }] }
    })

    // ── OTA 固件升级（PRD 07）─────────────────────
    tools.registerTool('upload_firmware', {
      title: 'Upload firmware', description: '上传固件（base64，建议 <1MB；大文件走 HTTP POST /api/firmware/upload 原始二进制）',
      inputSchema: { name: zz.string(), version: zz.string().optional(), content_base64: zz.string() },
    }, async (args) => {
      const content = Buffer.from(args.content_base64, 'base64')
      const r = ota.uploadFirmware(args.name, args.version ?? '', content)
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    })

    tools.registerTool('list_firmwares', {
      title: 'List firmwares', description: '查已上传的固件列表',
      inputSchema: {},
    }, async () => ({ content: [{ type: 'text', text: JSON.stringify(ota.listFirmwares()) }] }))

    tools.registerTool('ota_upgrade', {
      title: 'OTA upgrade', description: '发起固件升级（异步，立即返回 task_id；升级失败可能导致设备不可用）',
      inputSchema: { device_id: zz.number(), firmware_id: zz.number(), chunk_size: zz.number().optional() },
    }, async (args) => {
      const r = ota.startUpgrade(args.device_id, args.firmware_id, args.chunk_size)
      return { content: [{ type: 'text', text: JSON.stringify(r) }] }
    })

    tools.registerTool('ota_status', {
      title: 'OTA status', description: '查升级进度（发起后用 ota_status 轮询）',
      inputSchema: { device_id: zz.number() },
    }, async (args) => {
      const s = ota.getStatus(args.device_id) as any
      return { content: [{ type: 'text', text: JSON.stringify({ state: s.state, current_block: s.currentBlock ?? 0, total_blocks: s.totalBlocks ?? 0, percent: s.percent ?? 0, ...(s.error ? { error: s.error } : {}) }) }] }
    })

    tools.registerTool('ota_abort', {
      title: 'OTA abort', description: '中止升级（可选）',
      inputSchema: { device_id: zz.number() },
    }, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(ota.abort(args.device_id)) }] }))
  }

  function createServer(): McpServer {
    if (closing) throw new Error('MCP is closing or closed')
    const server = new McpServer({ name: 'probestation', version: '0.1.0' })
    const register = server.registerTool.bind(server)
    server.registerTool = ((...args: any[]) => {
      const callback = args[args.length - 1]
      args[args.length - 1] = (...input: any[]) => track(() => callback(...input))
      return (register as any)(...args)
    }) as typeof server.registerTool
    registerTools(server)
    return server
  }

  // 每个会话一个 transport（有状态模式）：客户端断开后会话被清理，新连接可正常重新 initialize，不再「already initialized」卡死。
  const transports = new Map<string, StreamableHTTPServerTransport>()
  // Ownership begins before initialization supplies a session ID.
  const ownedTransports = new Set<StreamableHTTPServerTransport>()
  const transportCloseTasks = new WeakMap<StreamableHTTPServerTransport, Promise<void>>()
  const transportCloseErrors: unknown[] = []
  const closeTransport = (transport: StreamableHTTPServerTransport): Promise<void> => {
    let task = transportCloseTasks.get(transport)
    if (!task) {
      task = Promise.resolve().then(() => transport.close())
      transportCloseTasks.set(transport, task)
      void task.catch(error => { transportCloseErrors.push(error) })
    }
    return task
  }

  const httpServer = http.createServer((req, res) => {
    if (closing) { res.statusCode = 503; res.end(); return }
    const handle = (parsed?: unknown) => {
      if (closing) { res.statusCode = 503; res.end(); return }
      let createdTransport: StreamableHTTPServerTransport | undefined
      void track(async () => {
        let failed = false
        try {
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
              onsessioninitialized: sid => { transports.set(sid, t) },
            })
            createdTransport = t; ownedTransports.add(t)
            t.onclose = () => { ownedTransports.delete(t); const sid = t.sessionId; if (sid) transports.delete(sid) }
            await srv.connect(t)
            if (req.aborted || res.destroyed) return
            if (closing) { res.statusCode = 503; res.end(); return }
            transport = t
          }
          await transport.handleRequest(req, res, parsed)
        } catch (error) {
          failed = true
          const errors = [error]
          if (createdTransport) { try { await closeTransport(createdTransport) } catch (closeError) { errors.push(closeError) } }
          throwCleanupErrors(errors, 'MCP initialization/request failed')
        } finally {
          // SDK validation can reject initialization without assigning a session.
          if (!failed && createdTransport && !createdTransport.sessionId) await closeTransport(createdTransport)
        }
      }).catch((e: any) => {
        console.error('MCP handleRequest error:', e?.message ?? e, '| stack:', e?.stack?.split('\n')[1] ?? '')
        if (!res.headersSent) { res.statusCode = closing ? 503 : 500; res.end() }
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
  const starting = new Promise<void>((resolve, reject) => {
    httpServer.on('error', error => { reject(error); ctx.logger('mcp').error(error) })
    httpServer.once('listening', resolve)
  })
  void starting.catch(() => {}) // Failure remains observable to cleanup; the error listener also reports it.
  registerResourceCleanup(ctx, [cfg, store, poller, ota], async () => {
    closing = true
    const errors: unknown[] = []
    try { await recorder.close() } catch (error) { errors.push(error) }
    try { await starting } catch (error) { errors.push(error) }
    for (const transport of ownedTransports) { try { await closeTransport(transport) } catch (error) { errors.push(error) } }
    transports.clear(); ownedTransports.clear()
    try {
      if (httpServer.listening) await new Promise<void>((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()))
    } catch (error) { errors.push(error) }
    const results = await Promise.allSettled([...active])
    errors.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
    errors.push(...transportCloseErrors)
    throwCleanupErrors(errors, 'MCP shutdown failed')
  })
  try {
    httpServer.listen(config.port, config.host, () => { ctx.logger('mcp').info('MCP server on http://' + config.host + ':' + config.port + '/mcp') })
  } catch (error) { httpServer.emit('error', error) }

  ctx.provide('mcp', { createServer, getRecordingIntervalStatus: (deviceId: number) => recorder.getRecordingIntervalStatus(deviceId) })
}
