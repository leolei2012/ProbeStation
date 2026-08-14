import type { Context } from 'cordis'
import z from 'schemastery'
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'

export const name = 'api'
export const inject = ['config', 'store']

export interface Config {
  host: string
  port: number
}

export const Config: z<Config> = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.number().default(8080),
})

/** REST + WebSocket API over Fastify, mirroring the legacy Monitor endpoints. */
export function apply(ctx: Context, config: Config): void {
  const app: FastifyInstance = Fastify()
  const cfg = (ctx as any).config
  const store = (ctx as any).store

  // ── REST ────────────────────────────────────────────────
  app.get('/health', async () => ({ status: 'ok', version: '0.1.0' }))

  app.get('/api/monitor_objects', async () => cfg.listObjects())

  app.get('/api/monitor_objects/:id/groups', async (req) => {
    const id = Number((req.params as any).id)
    return cfg.listGroups(id)
  })

  app.get('/api/groups/:gid/registers', async (req) => {
    const gid = Number((req.params as any).gid)
    return cfg.listRegisters(gid)
  })

  app.get('/api/monitor_objects/:id/latest', async () => store.getLatest())

  app.get('/api/data/query', async (req) => {
    const q = req.query as any
    return store.query(Number(q.object_id), Number(q.register_id), String(q.start), String(q.end))
  })

  // ── WebSocket（async 插件封装，加载阶段 await websocket）──
  const sockets = new Set<any>()
  void app.register(async (fastify: any) => {
    await fastify.register(websocket)
    fastify.get('/ws', { websocket: true }, (socket: any) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      // 连接即推送最新快照
      socket.send(JSON.stringify({ type: 'latest', data: store.getLatest() }))
    })
  })

  // 轮询结果实时广播到所有 ws 客户端（Cordis 事件全局分发）
  ctx.on('poller/result', ({ objectId, points }: any) => {
    const msg = JSON.stringify({ type: 'poller/result', objectId, points })
    for (const s of sockets) s.send(msg)
  })

  ctx.provide('api', app)
  ctx.logger('api').info(`REST+WS API registered (host=${config.host}, port=${config.port})`)
}
