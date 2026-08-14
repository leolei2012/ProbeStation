import type { Context } from 'cordis'
import z from 'schemastery'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { encodeRegister } from '@probebench/core'

export const name = 'api'
export const inject = ['config', 'store', 'poller', 'sink', 'importer', 'workspace']

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

  app.get('/health', async () => ({ status: 'ok', version: '0.1.0' }))

  // ── Workspace ───────────────────────────────────────────
  app.get('/api/workspace', async () => workspace.list())
  app.get('/api/workspace/browse', async (req) => workspace.browse(String((req.query as any).path ?? '')))
  app.post('/api/workspace/switch', async (req) => {
    const b = req.body as any
    await workspace.switchTo(b.path)
    return workspace.list()
  })

  // ── Objects ─────────────────────────────────────────────
  app.get('/api/monitor_objects', async () => cfg.listObjects())
  app.post('/api/monitor_objects', async (req) => {
    const b = req.body as any
    return cfg.createObject(b.name, b.ip, b.port, b.mode ?? 'master')
  })
  app.put('/api/monitor_objects/:id', async (req) => {
    return cfg.updateObject(Number((req.params as any).id), req.body as any)
  })
  app.delete('/api/monitor_objects/:id', async (req) => { cfg.deleteObject(Number((req.params as any).id)); return { ok: true } })
  app.post('/api/monitor_objects/:id/toggle', async (req) => cfg.toggleObject(Number((req.params as any).id)))

  // ── Groups ──────────────────────────────────────────────
  app.get('/api/monitor_objects/:id/groups', async (req) => cfg.listGroups(Number((req.params as any).id)))
  app.post('/api/monitor_objects/:id/groups', async (req) => {
    const oid = Number((req.params as any).id)
    const b = req.body as any
    return cfg.createGroup(oid, b.name, b.functionCode ?? 3, b.startAddress ?? 0, b.quantity ?? 1, b.mode ?? 'read', b.slaveId ?? 1, b.pollIntervalMs ?? 1000)
  })
  app.put('/api/groups/:id', async (req) => cfg.updateGroup(Number((req.params as any).id), req.body as any))
  app.delete('/api/groups/:id', async (req) => { cfg.deleteGroup(Number((req.params as any).id)); return { ok: true } })
  app.post('/api/groups/:id/toggle-pause', async (req) => cfg.toggleGroup(Number((req.params as any).id)))

  // ── Registers ───────────────────────────────────────────
  app.get('/api/groups/:gid/registers', async (req) => cfg.listRegisters(Number((req.params as any).gid)))
  app.post('/api/groups/:gid/registers', async (req) => {
    const gid = Number((req.params as any).gid)
    const g = cfg.getGroup(gid)
    const b = req.body as any
    return cfg.createRegister(gid, g.objectId, b.alias ?? null, b.functionCode ?? 3, b.startAddress, b.dataType ?? 'int16')
  })
  app.put('/api/registers/:id', async (req) => cfg.updateRegister(Number((req.params as any).id), req.body as any))
  app.delete('/api/registers/:id', async (req) => { cfg.deleteRegister(Number((req.params as any).id)); return { ok: true } })

  // ── Write ───────────────────────────────────────────────
  app.post('/api/registers/:id/write', async (req) => {
    const id = Number((req.params as any).id)
    const reg = cfg.getRegister(id)
    if (!reg) return { code: 404, error: 'register not found' }
    const b = req.body as any
    const value = Number(b.value)
    const words = encodeRegister(reg.dataType ?? 'int16', value)
    const requested = b.method === 'single' ? 'single' : 'multiple'
    const method = words.length > 1 ? 'multiple' : requested
    const grp = cfg.getGroup(reg.groupId)
    await poller.write(reg.objectId, reg.startAddress, words, method, grp?.slaveId ?? 1)
    cfg.log('INFO', 'api', 'write register ' + id + ' = ' + value + ' (' + reg.dataType + ', ' + words.length + ' word(s))')
    return { register_id: id, value, dataType: reg.dataType, method, words }
  })

  // ── Import ─────────────────────────────────────────────
  app.post('/api/monitor_objects/:id/import', async (req) => {
    const id = Number((req.params as any).id)
    const b = req.body as any
    const content = Buffer.from(b.content ?? '', 'base64')
    return importer.import(id, b.filename ?? 'import.mbp', content)
  })

  // ── Logs ───────────────────────────────────────────────
  app.get('/api/logs', async (req) => cfg.listLogs(Number((req.query as any).limit ?? 100)))
  app.post('/api/logs/clear', async () => { cfg.clearLogs(); return { ok: true } })

  // ── Alarm rules ────────────────────────────────────────
  app.get('/api/rules', async () => cfg.listRules())
  app.post('/api/rules', async (req) => {
    const b = req.body as any
    return cfg.createRule(b.registerId, b.operator ?? '>', b.threshold ?? 0, b.message ?? null)
  })
  app.delete('/api/rules/:id', async (req) => { cfg.deleteRule(Number((req.params as any).id)); return { ok: true } })

  // ── Export ─────────────────────────────────────────────
  app.get('/api/export/csv', async (req, reply) => {
    const q = req.query as any
    const csv = await sink.exportCsv(Number(q.object_id), String(q.start), String(q.end))
    reply.header('Content-Type', 'text/csv')
    reply.header('Content-Disposition', 'attachment; filename=export.csv')
    return csv
  })
  app.get('/api/export/xlsx', async (req, reply) => {
    const q = req.query as any
    const buf = await sink.exportXlsx(Number(q.object_id), String(q.start), String(q.end))
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    reply.header('Content-Disposition', 'attachment; filename=export.xlsx')
    return buf
  })

  // ── Data ────────────────────────────────────────────────
  app.get('/api/monitor_objects/:id/latest', async () => store.getLatest())
  app.get('/api/data/query', async (req) => {
    const q = req.query as any
    return store.query(Number(q.object_id), Number(q.register_id), String(q.start), String(q.end))
  })
  app.get('/api/data/object', async (req) => {
    const q = req.query as any
    return store.queryObject(Number(q.object_id), String(q.start), String(q.end))
  })

  // ── WebSocket ───────────────────────────────────────────
  const sockets = new Set<any>()
  void app.register(async (fastify: any) => {
    await fastify.register(websocket)
    fastify.get('/ws', { websocket: true }, (socket: any) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.send(JSON.stringify({ type: 'latest', data: store.getLatest() }))
    })
  })
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

  // ── 前端静态托管 ────────────────────────────────────────
  if (config.staticDir && existsSync(config.staticDir)) {
    void app.register(fastifyStatic, { root: resolve(config.staticDir) })
    ctx.logger('api').info(`serving frontend from ${config.staticDir}`)
  }

  ctx.provide('api', app)
  ctx.logger('api').info(`REST+WS API registered (host=${config.host}, port=${config.port})`)
}
