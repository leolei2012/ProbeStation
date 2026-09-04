import type { Context } from 'cordis'
import z from 'schemastery'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import compress from '@fastify/compress'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { areaForFunction, baseType, encodeRegister, functionCodeForArea, registerWidth, smartParseCsv, smartParseTable, type ModbusArea } from '@probebench/core'
import ExcelJS from 'exceljs'

/** 把 exceljs 单元格转成字符串（处理公式/数字/文本）。 */
function xlsxCellText(cell: any): string {
  const v = cell?.value
  if (v == null) return ''
  if (typeof v === 'object' && !(v instanceof Date)) return String(v.result ?? v.text ?? '')
  return String(v)
}

/** 读 XLSX 第一个工作表 → 二维字符串数组。 */
async function readXlsxRows(buffer: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as any)
  const ws = wb.worksheets[0]
  if (!ws) return []
  const rows: string[][] = []
  ws.eachRow((row: any) => {
    const cells: string[] = []
    row.eachCell({ includeEmpty: true }, (cell: any, colNumber: number) => {
      while (cells.length < colNumber - 1) cells.push('')
      cells.push(xlsxCellText(cell))
    })
    rows.push(cells)
  })
  return rows
}

export const name = 'api'
export const inject = ['config', 'store', 'poller', 'sink', 'importer', 'ota']

export interface Config { host: string; port: number; staticDir?: string; dataDir?: string }
export const Config: z<Config> = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().default(8080),
  staticDir: z.string(),
  dataDir: z.string().default('data'),
})

/** REST + WebSocket API over Fastify, mirroring the legacy Monitor endpoints. */
export function apply(ctx: Context, config: Config): void {
  const app: FastifyInstance = Fastify()
  const cfg = (ctx as any).config
  const store = (ctx as any).store
  const poller = (ctx as any).poller
  const sink = (ctx as any).sink
  const importer = (ctx as any).importer
  const ota = (ctx as any).ota
  const dataDir = config.dataDir ?? 'data'

  const sockets = new Set<any>()
  const lastSeen = new Map<any, number>()
  const removeSocket = (socket: any): void => {
    sockets.delete(socket)
    lastSeen.delete(socket)
  }
  const safeSend = (socket: any, message: string): boolean => {
    if (socket.readyState !== 1) { removeSocket(socket); return false }
    try { socket.send(message); return true } catch { removeSocket(socket); try { socket.terminate() } catch { /* ignore */ }; return false }
  }
  const broadcast = (message: string): void => { for (const socket of [...sockets]) safeSend(socket, message) }
  const socketSweep = setInterval(() => {
    const cutoff = Date.now() - 60_000
    for (const socket of [...sockets]) {
      if ((lastSeen.get(socket) ?? 0) >= cutoff && socket.readyState === 1) continue
      removeSocket(socket)
      try { socket.terminate() } catch { /* ignore */ }
    }
  }, 15_000)
  if (typeof socketSweep.unref === 'function') socketSweep.unref()

  // 压缩 + 所有路由 + WebSocket + 静态托管，都放进同一个异步 register：
  // compress 必须「await 注册完成后」再定义路由，onRoute 钩子才会对后续路由生效。
  void app.register(async (fastify: any) => {
    await fastify.register(compress, { global: true }) // gzip/brotli 压缩响应（静态资源 + API）

    fastify.get('/health', async () => ({ status: 'ok', version: '0.1.0' }))

    // ── 固件上传（OTA，PRD 07）──────────────────────────────
    fastify.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req: any, body: any, done: any) => done(null, body))
    fastify.addContentTypeParser('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', { parseAs: 'buffer' }, (_req: any, body: any, done: any) => done(null, body))
    fastify.get('/api/firmwares', async () => ota.listFirmwares())
    fastify.delete('/api/firmwares/:id', async (req: any) => ota.deleteFirmware(Number((req.params as any).id)))
    fastify.post('/api/firmware/upload', async (req: any, reply: any) => {
      const name = String((req.query as any)?.name ?? 'firmware')
      const version = String((req.query as any)?.version ?? '')
      const content = req.body as Buffer
      if (!Buffer.isBuffer(content) || content.length === 0) return reply.code(400).send({ error: 'empty firmware body' })
      return ota.uploadFirmware(name, version, content)
    })
    fastify.get('/api/ota/status', async (req: any) => ota.getStatus(Number((req.query as any).device_id)))
    fastify.post('/api/ota/upgrade', async (req: any) => ota.startUpgrade((req.body as any).device_id, (req.body as any).firmware_id, (req.body as any).chunk_size))
    fastify.post('/api/ota/abort', async (req: any) => ota.abort((req.body as any).device_id))

    // ── Objects ─────────────────────────────────────────────
    fastify.get('/api/monitor_objects', async () => {
      const objects = cfg.listObjects()
      const states = new Map((poller.listConnectionStates?.() ?? []).map((s: any) => [s.objectId, s.connected]))
      return objects.map((o: any) => ({ ...o, connected: states.get(o.id) ?? false }))
    })
    fastify.post('/api/monitor_objects', async (req: any) => {
      const b = req.body as any
      return cfg.createObject(b.name, b.ip, b.port, b.mode ?? 'master', {
        transport: b.transport, serialPath: b.serialPath, baudRate: b.baudRate,
        parity: b.parity, stopBits: b.stopBits, dataBits: b.dataBits, flowControl: b.flowControl,
        slaveId: b.slaveId, pollIntervalMs: b.pollIntervalMs, timeoutMs: b.timeoutMs, dataRetainSeconds: b.dataRetainSeconds,
      })
    })
    fastify.put('/api/monitor_objects/:id', async (req: any) => {
      const id = Number((req.params as any).id)
      const updated = cfg.updateObject(id, req.body as any)
      await poller.reconnectDevice(id) // 编辑 ip/port 后立即用新地址重连
      return updated
    })
    fastify.delete('/api/monitor_objects/:id', async (req: any) => { cfg.deleteObject(Number((req.params as any).id)); return { ok: true } })
    fastify.post('/api/monitor_objects/:id/toggle', async (req: any) => cfg.toggleObject(Number((req.params as any).id)))

    // ── Modbus diagnostics ─────────────────────────────────
    fastify.get('/api/monitor_objects/:id/diagnostics', async (req: any) =>
      poller.getDeviceDiagnostics(Number((req.params as any).id)))
    fastify.get('/api/monitor_objects/:id/frames', async (req: any) => {
      const raw = Number((req.query as any)?.limit ?? 200)
      const limit = Number.isFinite(raw) ? Math.max(0, Math.min(2000, Math.trunc(raw))) : 200
      return poller.getDeviceFrames(Number((req.params as any).id), limit)
    })
    fastify.post('/api/monitor_objects/:id/frames/clear', async (req: any) => {
      poller.clearDeviceDiagnostics(Number((req.params as any).id))
      return { ok: true }
    })

    // ── Groups ──────────────────────────────────────────────
    fastify.get('/api/monitor_objects/:id/groups', async (req: any) => cfg.listGroups(Number((req.params as any).id)))
    fastify.post('/api/monitor_objects/:id/groups', async (req: any) => {
      const oid = Number((req.params as any).id)
      const b = req.body as any
      const g = cfg.createGroup(oid, b.name, b.functionCode ?? 3, b.startAddress ?? 0, b.quantity ?? 1, b.mode ?? 'read', b.slaveId ?? 1)
      // 按数量自动生成寄存器（每地址一个，默认 int16、无别名）
      for (let i = 0; i < g.quantity; i++) cfg.createRegister(g.id, g.objectId, null, g.functionCode, g.startAddress + i, 'int16')
      return g
    })
    fastify.put('/api/groups/:id', async (req: any) => cfg.updateGroup(Number((req.params as any).id), req.body as any))
    fastify.delete('/api/groups/:id', async (req: any) => { cfg.deleteGroup(Number((req.params as any).id)); return { ok: true } })
    fastify.post('/api/groups/:id/toggle-pause', async (req: any) => cfg.toggleGroup(Number((req.params as any).id)))

    // ── Registers ───────────────────────────────────────────
    fastify.get('/api/groups/:gid/registers', async (req: any) => cfg.listRegisters(Number((req.params as any).gid)))
    fastify.post('/api/groups/:gid/registers', async (req: any) => {
      const gid = Number((req.params as any).gid)
      const g = cfg.getGroup(gid)
      const b = req.body as any
      return cfg.createRegister(gid, g.objectId, b.alias ?? null, b.functionCode ?? 3, b.startAddress, b.dataType ?? 'int16')
    })
    fastify.put('/api/registers/:id', async (req: any) => {
      const id = Number((req.params as any).id)
      const b = req.body as any
      const reg = cfg.getRegister(id)
      if (reg && typeof b.dataType === 'string') {
        const grp = cfg.getGroup(reg.groupId)
        if (grp && reg.startAddress + registerWidth(b.dataType) > grp.startAddress + grp.quantity) {
          return { code: 400, error: 'dataType spans beyond the group poll range' }
        }
      }
      return cfg.updateRegister(id, b)
    })
    fastify.delete('/api/registers/:id', async (req: any) => { cfg.deleteRegister(Number((req.params as any).id)); return { ok: true } })

    // ── 点表导入（语义批量更新） ────────────────────────────
    fastify.post('/api/monitor_objects/:id/points/import', async (req: any) => {
      const id = Number((req.params as any).id)
      const body = req.body as any
      let points: any[]
      let parseReport: any = null
      if (Array.isArray(body)) {
        points = body
      } else if (typeof body?.csv === 'string') {
        const r = smartParseCsv(body.csv)
        parseReport = r.report
        points = r.points
      } else if (typeof body?.xlsx === 'string') {
        const rows = await readXlsxRows(Buffer.from(body.xlsx, 'base64'))
        const r = smartParseTable(rows)
        parseReport = r.report
        points = r.points
      } else {
        return { code: 400, error: 'expect a JSON array, { csv }, or { xlsx }' }
      }
      const normalized = points.map((p: any) => ({
        functionCode: functionCodeForArea(p.area as ModbusArea),
        address: p.address,
        alias: p.alias ?? null,
        dataType: p.data_type ?? p.dataType ?? 'int16',
        unit: p.unit ?? null,
        factor: p.factor,
        offset: p.offset,
        enumMap: p.enum ?? p.enumMap ?? null,
      }))
      const result = cfg.importPoints(id, normalized)
      return parseReport ? { ...result, parse: parseReport } : result
    })

    // ── 点表 xlsx（分组=sheet）导出 / 导入 ──────────────────
    fastify.get('/api/monitor_objects/:id/points/book', async (req: any, reply: any) => {
      const id = Number((req.params as any).id)
      const { buffer, filename } = await sink.exportPointSheet(id)
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      reply.header('Content-Disposition', 'attachment; filename=' + encodeURIComponent(filename))
      return buffer
    })
    fastify.post('/api/monitor_objects/:id/points/book', async (req: any, reply: any) => {
      const id = Number((req.params as any).id)
      if (!Buffer.isBuffer(req.body)) return reply.code(400).send({ error: 'expected xlsx binary body' })
      const res = await sink.importPointBook(id, req.body, true)
      return res
    })

    // ── Write ───────────────────────────────────────────────
    fastify.post('/api/registers/:id/write', async (req: any) => {
      const id = Number((req.params as any).id)
      const reg = cfg.getRegister(id)
      if (!reg) return { code: 404, error: 'register not found' }
      const b = req.body as any
      const base = baseType(reg.dataType ?? 'int16')
      const is64 = base.endsWith('64') && base !== 'float64'
      const value = is64 ? BigInt(String(b.value)) : Number(b.value)
      const words = encodeRegister(reg.dataType ?? 'int16', value)
      const requested = b.method === 'single' ? 'single' : 'multiple'
      const method = words.length > 1 ? 'multiple' : requested
      const grp = cfg.getGroup(reg.groupId)
      const area = areaForFunction(reg.functionCode)
      await poller.write(reg.objectId, reg.startAddress, words, method, grp?.slaveId ?? 1, area)
      cfg.log('INFO', 'api', 'write register ' + id + ' = ' + String(value) + ' (' + reg.dataType + ', ' + words.length + ' word(s))')
      return { register_id: id, value: String(value), dataType: reg.dataType, method, words }
    })

    // ── Import ─────────────────────────────────────────────
    fastify.post('/api/monitor_objects/:id/import', async (req: any) => {
      const id = Number((req.params as any).id)
      const b = req.body as any
      const content = Buffer.from(b.content ?? '', 'base64')
      return importer.import(id, b.filename ?? 'import.mbp', content)
    })

    // ── Logs ───────────────────────────────────────────────
    fastify.get('/api/logs', async (req: any) => cfg.listLogs(Number((req.query as any).limit ?? 100)))
    fastify.post('/api/logs/clear', async () => { cfg.clearLogs(); return { ok: true } })

    // ── Alarm rules ────────────────────────────────────────
    fastify.get('/api/rules', async () => cfg.listRules())
    fastify.post('/api/rules', async (req: any) => {
      const b = req.body as any
      return cfg.createRule(b.registerId, b.operator ?? '>', b.threshold ?? 0, b.message ?? null)
    })
    fastify.delete('/api/rules/:id', async (req: any) => { cfg.deleteRule(Number((req.params as any).id)); return { ok: true } })

    // ── Retention ───────────────────────────────────────────
    fastify.get('/api/retention', async () => ({ retention_seconds: store.getRetentionSeconds() }))
    fastify.post('/api/retention', async (req: any) => {
      const seconds = Number((req.body as any).retention_seconds)
      if (!Number.isInteger(seconds) || seconds < 0) return { code: 400, error: 'retention_seconds must be a non-negative integer' }
      store.setRetentionSeconds(seconds)
      return { ok: true, retention_seconds: store.getRetentionSeconds() }
    })

    // ── Data stats ─────────────────────────────────────────
    const fileSize = (p: string): number | null => { try { return existsSync(p) ? statSync(p).size : null } catch { return null } }
    fastify.get('/api/stats', async () => {
      const history = await store.stats()
      const objects = cfg.listObjects()
      const nameById = new Map(objects.map((o: any) => [o.id, o.name]))
      const enriched = {
        ...history,
        byDevice: history.byDevice.map((d: any) => ({ ...d, name: nameById.get(d.objectId) ?? ('#' + d.objectId) })),
      }
      const dataRoot = resolve(dataDir)
      return {
        history: enriched,
        metadata: cfg.metadataStats(),
        retention: { retention_seconds: store.getRetentionSeconds() },
        files: {
          config_db: fileSize(resolve(dataRoot, 'config.db')),
          poll_duckdb: fileSize(resolve(dataRoot, 'poll.duckdb')),
          poll_duckdb_wal: fileSize(resolve(dataRoot, 'poll.duckdb.wal')),
        },
        workspace: dataRoot,
      }
    })

    // ── Export ─────────────────────────────────────────────
    const parseIds = (v: unknown): number[] | undefined => {
      if (v == null || v === '') return undefined
      return String(v).split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0)
    }
    fastify.get('/api/export/csv', async (req: any, reply: any) => {
      const q = req.query as any
      const tz = Number(q.tz ?? 0)
      const csv = await sink.exportCsv(Number(q.object_id), String(q.start), String(q.end), parseIds(q.register_ids), Number.isFinite(tz) ? tz : 0)
      reply.header('Content-Type', 'text/csv')
      reply.header('Content-Disposition', 'attachment; filename=export.csv')
      return csv
    })
    fastify.get('/api/export/xlsx', async (req: any, reply: any) => {
      const q = req.query as any
      const tz = Number(q.tz ?? 0)
      const buf = await sink.exportXlsx(Number(q.object_id), String(q.start), String(q.end), parseIds(q.register_ids), Number.isFinite(tz) ? tz : 0)
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      reply.header('Content-Disposition', 'attachment; filename=export.xlsx')
      return buf
    })

    // ── Data ────────────────────────────────────────────────
    fastify.get('/api/monitor_objects/:id/latest', async (req: any) => store.getLatestByObjectAll(Number((req.params as any).id)))
    fastify.get('/api/monitor_objects/:id/stats', async (req: any) => store.statsByObject(Number((req.params as any).id)))
    fastify.get('/api/data/query', async (req: any, reply: any) => {
      const q = req.query as any
      const area = String(q.area ?? '')
      if (!['coil', 'discrete-input', 'holding-register', 'input-register'].includes(area)) return reply.code(400).send({ error: 'area is required' })
      const limit = Number(q.limit ?? 0)
      return store.query(Number(q.object_id), Number(q.address), String(q.start), String(q.end), area, limit > 0 ? limit : undefined)
    })
    fastify.get('/api/data/object', async (req: any) => {
      const q = req.query as any
      const limit = Number(q.limit ?? 0)
      return store.queryObject(Number(q.object_id), String(q.start), String(q.end), limit > 0 ? limit : undefined)
    })
    // 分页版：按时间戳分页，返回 { points, total, page, pageSize, hasMore }
    fastify.get('/api/data/object/page', async (req: any) => {
      const q = req.query as any
      const page = Number(q.page ?? 0)
      const pageSize = Number(q.page_size ?? 200)
      return store.queryObjectPage(Number(q.object_id), String(q.start), String(q.end), Number.isFinite(page) ? page : 0, Number.isFinite(pageSize) ? pageSize : 200)
    })
    // 曲线版：整个时间范围降采样成 max_points 个时间桶（每桶每地址取最新值）
    fastify.get('/api/data/object/curve', async (req: any) => {
      const q = req.query as any
      const mp = Number(q.max_points ?? 1000)
      return store.queryObjectCurve(Number(q.object_id), String(q.start), String(q.end), Number.isFinite(mp) ? mp : 1000)
    })

    // ── WebSocket ───────────────────────────────────────────
    await fastify.register(websocket)
    fastify.get('/ws', { websocket: true }, (socket: any) => {
      sockets.add(socket)
      lastSeen.set(socket, Date.now())
      socket.on('message', (raw: any) => {
        lastSeen.set(socket, Date.now())
        try {
          const msg = JSON.parse(String(raw))
          if (msg?.type === 'ping') safeSend(socket, JSON.stringify({ type: 'pong', timestamp: msg.timestamp ?? Date.now() }))
        } catch { /* 忽略非法客户端消息，保持连接 */ }
      })
      socket.on('close', () => removeSocket(socket))
      socket.on('error', () => { removeSocket(socket); try { socket.terminate() } catch { /* ignore */ } })
      safeSend(socket, JSON.stringify({ type: 'latest', data: store.getLatest() }))
      safeSend(socket, JSON.stringify({ type: 'device/status', states: poller.listConnectionStates?.() ?? [] }))
      safeSend(socket, JSON.stringify({ type: 'group-errors', errors: poller.listGroupErrors?.() ?? [] }))
    })

    fastify.addHook('onClose', async () => {
      clearInterval(socketSweep)
      for (const socket of [...sockets]) { removeSocket(socket); try { socket.terminate() } catch { /* ignore */ } }
    })

    // ── 前端静态托管 ────────────────────────────────────────
    if (config.staticDir && existsSync(config.staticDir)) {
      await fastify.register(fastifyStatic, { root: resolve(config.staticDir) })
      ctx.logger('api').info(`serving frontend from ${config.staticDir}`)
    }
  })

  // ── 事件中继（同步注册，供 WS 广播） ──────────────────────
  ctx.on('poller/result', ({ objectId, points }: any) => {
    const msg = JSON.stringify({ type: 'poller/result', objectId, points })
    broadcast(msg)
  })
  ctx.on('rule/trigger', (payload: any) => {
    const msg = JSON.stringify({ type: 'rule/trigger', ...payload })
    broadcast(msg)
  })
  ctx.on('poller/group-error', (payload: any) => {
    const msg = JSON.stringify({ type: 'group-error', ...payload })
    broadcast(msg)
  })
  ctx.on('poller/group-ok', (payload: any) => {
    const msg = JSON.stringify({ type: 'group-ok', ...payload })
    broadcast(msg)
  })
  ctx.on('config/changed', (payload: any) => {
    const msg = JSON.stringify({ type: 'config/changed', ...payload })
    broadcast(msg)
  })
  ctx.on('device/status', (payload: any) => {
    const msg = JSON.stringify({ type: 'device/status', ...payload })
    broadcast(msg)
  })

  ctx.provide('api', app)
  ctx.logger('api').info(`REST+WS API registered (host=${config.host}, port=${config.port})`)
}
