import type { Context } from 'cordis'
import z from 'schemastery'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import compress from '@fastify/compress'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { baseType, encodeRegister, registerWidth } from '@probebench/core'

export const name = 'api'
export const inject = ['config', 'store', 'poller', 'sink', 'importer', 'workspace', 'ota']

export interface Config { host: string; port: number; staticDir?: string }
export const Config: z<Config> = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().default(8080),
  staticDir: z.string(),
})

/** REST + WebSocket API over Fastify, mirroring the legacy Monitor endpoints. */
export function apply(ctx: Context, config: Config): void {
  const app: FastifyInstance = Fastify()
  const cfg = (ctx as any).config
  const store = (ctx as any).store
  const poller = (ctx as any).poller
  const sink = (ctx as any).sink
  const importer = (ctx as any).importer
  const workspace = (ctx as any).workspace
  const ota = (ctx as any).ota

  const sockets = new Set<any>()

  // 压缩 + 所有路由 + WebSocket + 静态托管，都放进同一个异步 register：
  // compress 必须「await 注册完成后」再定义路由，onRoute 钩子才会对后续路由生效。
  void app.register(async (fastify: any) => {
    await fastify.register(compress, { global: true }) // gzip/brotli 压缩响应（静态资源 + API）

    fastify.get('/health', async () => ({ status: 'ok', version: '0.1.0' }))

    // ── 固件上传（OTA，PRD 07）──────────────────────────────
    fastify.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req: any, body: any, done: any) => done(null, body))
    fastify.get('/api/firmwares', async () => ota.listFirmwares())
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

    // ── Workspace ───────────────────────────────────────────
    fastify.get('/api/workspace', async () => workspace.list())
    fastify.get('/api/workspace/browse', async (req: any) => workspace.browse(String((req.query as any).path ?? '')))
    fastify.post('/api/workspace/switch', async (req: any) => {
      const b = req.body as any
      await workspace.switchTo(b.path)
      return workspace.list()
    })

    // ── Objects ─────────────────────────────────────────────
    fastify.get('/api/monitor_objects', async () => cfg.listObjects())
    fastify.post('/api/monitor_objects', async (req: any) => {
      const b = req.body as any
      return cfg.createObject(b.name, b.ip, b.port, b.mode ?? 'master', {
        transport: b.transport, serialPath: b.serialPath, baudRate: b.baudRate,
        parity: b.parity, stopBits: b.stopBits, dataBits: b.dataBits, flowControl: b.flowControl,
        slaveId: b.slaveId, pollIntervalMs: b.pollIntervalMs, dataRetainSeconds: b.dataRetainSeconds,
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

    // ── Groups ──────────────────────────────────────────────
    fastify.get('/api/monitor_objects/:id/groups', async (req: any) => cfg.listGroups(Number((req.params as any).id)))
    fastify.post('/api/monitor_objects/:id/groups', async (req: any) => {
      const oid = Number((req.params as any).id)
      const b = req.body as any
      const g = cfg.createGroup(oid, b.name, b.functionCode ?? 3, b.startAddress ?? 0, b.quantity ?? 1, b.mode ?? 'read', b.slaveId ?? 1, b.pollIntervalMs ?? 1000)
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
      await poller.write(reg.objectId, reg.startAddress, words, method, grp?.slaveId ?? 1)
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

    // ── Export ─────────────────────────────────────────────
    const parseIds = (v: unknown): number[] | undefined => {
      if (v == null || v === '') return undefined
      return String(v).split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0)
    }
    fastify.get('/api/export/csv', async (req: any, reply: any) => {
      const q = req.query as any
      const csv = await sink.exportCsv(Number(q.object_id), String(q.start), String(q.end), parseIds(q.register_ids))
      reply.header('Content-Type', 'text/csv')
      reply.header('Content-Disposition', 'attachment; filename=export.csv')
      return csv
    })
    fastify.get('/api/export/xlsx', async (req: any, reply: any) => {
      const q = req.query as any
      const buf = await sink.exportXlsx(Number(q.object_id), String(q.start), String(q.end), parseIds(q.register_ids))
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      reply.header('Content-Disposition', 'attachment; filename=export.xlsx')
      return buf
    })

    // ── Data ────────────────────────────────────────────────
    fastify.get('/api/monitor_objects/:id/latest', async (req: any) => store.getLatestByObject(Number((req.params as any).id)))
    fastify.get('/api/data/query', async (req: any) => {
      const q = req.query as any
      return store.query(Number(q.object_id), Number(q.address), String(q.start), String(q.end))
    })
    fastify.get('/api/data/object', async (req: any) => {
      const q = req.query as any
      return store.queryObject(Number(q.object_id), String(q.start), String(q.end))
    })

    // ── WebSocket ───────────────────────────────────────────
    await fastify.register(websocket)
    fastify.get('/ws', { websocket: true }, (socket: any) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.send(JSON.stringify({ type: 'latest', data: store.getLatest() }))
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
    for (const s of sockets) s.send(msg)
  })
  ctx.on('rule/trigger', (payload: any) => {
    const msg = JSON.stringify({ type: 'rule/trigger', ...payload })
    for (const s of sockets) s.send(msg)
  })
  ctx.on('poller/group-error', (payload: any) => {
    const msg = JSON.stringify({ type: 'group-error', ...payload })
    for (const s of sockets) s.send(msg)
  })
  ctx.on('poller/group-ok', (payload: any) => {
    const msg = JSON.stringify({ type: 'group-ok', ...payload })
    for (const s of sockets) s.send(msg)
  })
  ctx.on('workspace/changed', (payload: any) => {
    const msg = JSON.stringify({ type: 'workspace/changed', ...payload })
    for (const s of sockets) s.send(msg)
  })
  ctx.on('config/changed', (payload: any) => {
    const msg = JSON.stringify({ type: 'config/changed', ...payload })
    for (const s of sockets) s.send(msg)
  })

  ctx.provide('api', app)
  ctx.logger('api').info(`REST+WS API registered (host=${config.host}, port=${config.port})`)
}
