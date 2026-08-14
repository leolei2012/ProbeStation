import type { Context } from 'cordis'
import z from 'schemastery'
import Fastify, { type FastifyInstance } from 'fastify'

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

/** REST API over Fastify, mirroring the legacy Monitor endpoints. */
export function apply(ctx: Context, config: Config): void {
  const app: FastifyInstance = Fastify()
  const cfg = (ctx as any).config
  const store = (ctx as any).store

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

  ctx.provide('api', app)
  ctx.logger('api').info(`REST API registered (host=${config.host}, port=${config.port})`)
}
