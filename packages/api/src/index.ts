import type { Context } from 'cordis'
import z from 'schemastery'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export const name = 'api'
export const inject = ['config', 'store', 'poller']

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

  app.get('/health', async () => ({ status: 'ok', version: '0.1.0' }))

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
    return cfg.createGroup(oid, b.name, b.functionCode ?? 3, b.startAddress ?? 0, b.quantity ?? 1, b.mode ?? 'read')
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
    const method = b.method === 'single' ? 'single' : 'multiple'
    await poller.write(reg.objectId, reg.startAddress, value, method)
    return { register_id: id, value, method }
  })

  // ── Data ────────────────────────────────────────────────
  app.get('/api/monitor_objects/:id/latest', async () => store.getLatest())
  app.get('/api/data/query', async (req) => {
    const q = req.query as any
    return store.query(Number(q.object_id), Number(q.register_id), String(q.start), String(q.end))
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

  // ── 前端静态托管 ────────────────────────────────────────
  if (config.staticDir && existsSync(config.staticDir)) {
    void app.register(fastifyStatic, { root: resolve(config.staticDir) })
    ctx.logger('api').info(`serving frontend from ${config.staticDir}`)
  }

  ctx.provide('api', app)
  ctx.logger('api').info(`REST+WS API registered (host=${config.host}, port=${config.port})`)
}
