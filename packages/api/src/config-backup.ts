import type { FastifyInstance } from 'fastify'

export function registerConfigBackup(app: FastifyInstance, cfg: any) {
  const options = { bodyLimit: 64 * 1024 * 1024, preHandler: async (req: any, reply: any) => {
    const origin = req.headers.origin
    if (req.headers['x-probestation-config'] !== '1' || origin && new URL(origin).host !== req.headers.host) return reply.code(403).send({ error: '请从软件设置页面恢复配置' })
  } }
  app.get('/api/config/backup', async (_req, reply) => {
    reply.header('Content-Disposition', 'attachment; filename="probestation-config.json"')
    reply.type('application/json; charset=utf-8')
    return JSON.stringify(cfg.exportBackup(), null, 2)
  })
  app.post('/api/config/backup/preview', options, async req => cfg.previewBackup(req.body))
  app.post('/api/config/backup/restore', options, async req => cfg.restoreBackup(req.body))
}
